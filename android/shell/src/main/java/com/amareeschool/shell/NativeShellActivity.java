package com.amareeschool.shell;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.window.OnBackInvokedDispatcher;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.SslErrorHandler;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.ProgressBar;
import android.widget.Toast;

/**
 * The shared native shell behind every Amar E School app.
 *
 * It wraps one of the web apps in a fullscreen WebView so staff and guardians
 * get a real app instead of a home-screen shortcut: a proper icon and name, no
 * browser chrome, uploads from the gallery/camera, camera access for QR
 * scanning, and App Links so a printed QR opens the app directly.
 *
 * The web app is the product; this shell must stay thin. Anything the software
 * can do in the web app belongs there, not here. Subclasses supply only the
 * three deployment facts that actually differ between apps.
 */
public abstract class NativeShellActivity extends Activity {

  private static final int REQ_FILE = 1001;
  private static final int REQ_CAMERA_PERMISSION = 1002;

  /** The web app this shell loads, e.g. {@code https://teacher.example.com}. */
  protected abstract String origin();

  /**
   * Appended to the WebView user agent so the web app knows it is already
   * running inside the app. Must match the check in the web app's install logic
   * (src/components/InstallApp.tsx) — one suffix per app.
   */
  protected abstract String uaSuffix();

  /** Brand colour as a hex string without '#', used on the offline screen. */
  protected abstract String accentHex();

  /** Heading shown when the app cannot reach the school. */
  protected String errorTitle() {
    return "Can't reach the school right now";
  }

  private WebView webView;
  private ProgressBar progressBar;
  private ValueCallback<Uri[]> fileCallback;
  private PermissionRequest pendingPermissionRequest;

  @SuppressLint("SetJavaScriptEnabled")
  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    if (origin() == null || origin().trim().isEmpty()) {
      throw new IllegalStateException("NativeShellActivity requires an origin()");
    }

    FrameLayout root = new FrameLayout(this);
    webView = new WebView(this);
    progressBar = new ProgressBar(this, null, android.R.attr.progressBarStyleHorizontal);
    progressBar.setMax(100);

    root.addView(webView, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    root.addView(progressBar, new FrameLayout.LayoutParams(
        ViewGroup.LayoutParams.MATCH_PARENT, 6));
    setContentView(root);

    // targetSdk 35 means the window is edge-to-edge: pad it ourselves so the
    // content never draws under the status bar or the keyboard.
    root.setOnApplyWindowInsetsListener((v, insets) -> {
      int top;
      int bottom;
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
        android.graphics.Insets bars =
            insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
        top = bars.top;
        bottom = bars.bottom;
      } else {
        top = insets.getSystemWindowInsetTop();
        bottom = insets.getSystemWindowInsetBottom();
      }
      v.setPadding(0, top, 0, bottom);
      return insets;
    });

    WebSettings s = webView.getSettings();
    s.setJavaScriptEnabled(true);
    s.setDomStorageEnabled(true);
    s.setDatabaseEnabled(true);
    s.setAllowFileAccess(false);
    s.setAllowContentAccess(true);
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
    s.setLoadWithOverviewMode(false);
    s.setUseWideViewPort(false);
    s.setBuiltInZoomControls(false);
    s.setSupportMultipleWindows(false);
    // Lets the web app know it is already inside the app, so it never asks the
    // user to "install the app" from within the app.
    s.setUserAgentString(s.getUserAgentString() + " " + uaSuffix());

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
      CookieManager.getInstance().setAcceptThirdPartyCookies(webView, false);
    }

    webView.setWebViewClient(new WebViewClient() {
      @Override
      public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        return handleUrl(request.getUrl());
      }

      @Override
      public void onPageFinished(WebView view, String url) {
        progressBar.setVisibility(View.GONE);
        // Install the back-navigation hook as soon as each document is ready.
        installNavHook();
      }

      @Override
      public void onReceivedSslError(WebView view, SslErrorHandler handler, android.net.http.SslError error) {
        // Never proceed through a broken certificate — this is a trust boundary.
        handler.cancel();
        showError("Secure connection failed. Please check your internet and try again.");
      }
    });

    webView.setWebChromeClient(new WebChromeClient() {
      @Override
      public void onProgressChanged(WebView view, int newProgress) {
        progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        progressBar.setProgress(newProgress);
      }

      /** File uploads: homework attachments, leave applications, photos. */
      @Override
      public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                       FileChooserParams params) {
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        fileCallback = callback;
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        if (params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
          intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }
        try {
          startActivityForResult(Intent.createChooser(intent, "Select file"), REQ_FILE);
          return true;
        } catch (ActivityNotFoundException e) {
          fileCallback = null;
          return false;
        }
      }

      /** Camera/microphone for in-page use (QR scanning, photo capture). */
      @Override
      public void onPermissionRequest(PermissionRequest request) {
        boolean wantsCamera = false;
        for (String r : request.getResources()) {
          if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(r)) wantsCamera = true;
        }
        if (wantsCamera && checkSelfPermission(android.Manifest.permission.CAMERA)
            != PackageManager.PERMISSION_GRANTED) {
          pendingPermissionRequest = request;
          requestPermissions(new String[]{android.Manifest.permission.CAMERA}, REQ_CAMERA_PERMISSION);
          return;
        }
        request.grant(request.getResources());
      }
    });

    // Debug builds only: let `chrome://inspect` / the DevTools protocol attach
    // to the WebView, so local development can see and test the app's screens.
    // Read from the app's own manifest flags — a library module's BuildConfig
    // describes the library, not the app it is packaged into.
    if (isDebuggable()) WebView.setWebContentsDebuggingEnabled(true);

    registerBackHandling();

    if (savedInstanceState != null) {
      webView.restoreState(savedInstanceState);
    } else {
      webView.loadUrl(startUrl(getIntent()));
    }
  }

  private boolean isDebuggable() {
    return (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
  }

  /**
   * Make the hardware/gesture Back button walk the WebView's history.
   *
   * There are two delivery paths and a modern app must handle both:
   *
   *  - API 33+ with predictive back — which is ON BY DEFAULT for apps targeting
   *    SDK 35 — routes Back through the framework's back dispatcher and
   *    <b>never calls {@link #onKeyDown}</b>. Registered here.
   *  - Older releases (and anything that opts out) still deliver KEYCODE_BACK to
   *    {@link #onKeyDown}. Handled below.
   *
   * Without this the Back button silently does nothing until the history is
   * exhausted, at which point it closes the app — so a user pressing Back one
   * screen deep is thrown out of the app instead of going back a page.
   */
  private void registerBackHandling() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return;
    getOnBackInvokedDispatcher().registerOnBackInvokedCallback(
        OnBackInvokedDispatcher.PRIORITY_DEFAULT,
        () -> {
          log("back via OnBackInvokedCallback");
          goBackOrFinish();
        });
  }

  /**
   * Count the page's own (same-document) history entries.
   *
   * The web apps are single-page apps: every in-app link — the sidebar, a card,
   * a row — is a {@code history.pushState} route change, not a document load.
   * {@link WebView#canGoBack()} does NOT count those, so it answers "false" one
   * screen deep and Back would close the app instead of going back a page. This
   * hook keeps our own depth counter instead, exposed as
   * {@code window.__amarShell.depth}. Idempotent: safe to inject repeatedly.
   */
  private static final String NAV_HOOK_JS =
      "(function(){if(window.__amarShellHook)return;window.__amarShellHook=1;"
      + "window.__amarShell={depth:0};var p=history.pushState;"
      + "history.pushState=function(){var r=p.apply(this,arguments);"
      + "window.__amarShell.depth++;return r;};"
      + "window.addEventListener('popstate',function(){"
      + "if(window.__amarShell.depth>0)window.__amarShell.depth--;});})();";

  private void installNavHook() {
    webView.evaluateJavascript(NAV_HOOK_JS, null);
  }

  /**
   * Back should walk the app's own history, and only leave the app at its root.
   *
   *  - a real document navigation in the WebView's list → {@link WebView#goBack}
   *  - a single-page route change → {@code history.back()} in the page
   *  - otherwise → close the activity, which is what Android users expect
   */
  private void goBackOrFinish() {
    if (webView.canGoBack()) {
      webView.goBack();
      return;
    }
    webView.evaluateJavascript(
        "(function(){var s=window.__amarShell;return (s&&s.depth>0)?'back':'exit';})()",
        value -> {
          boolean pageCanGoBack = value != null && value.contains("back");
          log("back: canGoBack=" + webView.canGoBack() + " spaDepth=" + value + " hit=" + pageCanGoBack);
          if (pageCanGoBack) {
            webView.evaluateJavascript("history.back()", null);
          } else {
            finish();
          }
        });
  }

  /** Debug-build diagnostics only; silent in release. */
  private void log(String message) {
    if (isDebuggable()) android.util.Log.d("AmarESchoolShell", message);
  }

  /** A deep link (a printed QR) wins over the default entry point. */
  private String startUrl(Intent intent) {
    if (intent != null && intent.getData() != null && isTrusted(intent.getData())) {
      return intent.getData().toString();
    }
    return origin();
  }

  /** Only our own origin stays in the app; anything else opens in the browser. */
  private boolean isTrusted(Uri uri) {
    Uri base = Uri.parse(origin());
    // The scheme must match the origin's own scheme: https in production, http
    // only in a local dev build pointed at a plain-HTTP dev server. A release
    // build (-PteacherOrigin=https://…) therefore stays https-only.
    return uri != null
        && base.getScheme() != null
        && base.getScheme().equals(uri.getScheme())
        && uri.getHost() != null
        && uri.getHost().equalsIgnoreCase(base.getHost());
  }

  private boolean handleUrl(Uri uri) {
    if (isTrusted(uri)) return false;
    // Payment gateways, Play Store, mailto:, tel:, WhatsApp… all leave the app.
    try {
      startActivity(new Intent(Intent.ACTION_VIEW, uri));
    } catch (ActivityNotFoundException e) {
      Toast.makeText(this, "No app can open that link", Toast.LENGTH_SHORT).show();
    }
    return true;
  }

  private void showError(String message) {
    String html = "<!doctype html><meta name='viewport' content='width=device-width,initial-scale=1'>"
        + "<body style='font-family:system-ui;padding:28px;text-align:center;color:#0f172a'>"
        + "<h2 style='margin:0 0 8px'>" + errorTitle() + "</h2>"
        + "<p style='color:#64748b;font-size:15px'>" + message + "</p>"
        + "<button onclick='location.reload()' style='margin-top:16px;padding:12px 20px;border:0;"
        + "border-radius:12px;background:#" + accentHex() + ";color:#fff;font-weight:700'>Try again</button>"
        + "</body>";
    webView.loadDataWithBaseURL(origin(), html, "text/html", "utf-8", null);
  }

  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
    // singleTask: a link tapped while the app is open navigates in place.
    if (intent.getData() != null && isTrusted(intent.getData())) {
      webView.loadUrl(intent.getData().toString());
    }
  }

  /** Legacy Back path: what actually fires on most current devices. */
  @Override
  public boolean onKeyDown(int keyCode, KeyEvent event) {
    if (keyCode == KeyEvent.KEYCODE_BACK) {
      goBackOrFinish();
      return true;
    }
    return super.onKeyDown(keyCode, event);
  }

  @Override
  protected void onSaveInstanceState(Bundle outState) {
    super.onSaveInstanceState(outState);
    webView.saveState(outState);
  }

  @Override
  protected void onActivityResult(int requestCode, int resultCode, Intent data) {
    if (requestCode == REQ_FILE) {
      if (fileCallback == null) return;
      Uri[] results = null;
      if (resultCode == RESULT_OK && data != null) {
        if (data.getClipData() != null) {
          int count = data.getClipData().getItemCount();
          results = new Uri[count];
          for (int i = 0; i < count; i++) {
            results[i] = data.getClipData().getItemAt(i).getUri();
          }
        } else if (data.getData() != null) {
          results = new Uri[]{data.getData()};
        }
      }
      fileCallback.onReceiveValue(results);
      fileCallback = null;
      return;
    }
    super.onActivityResult(requestCode, resultCode, data);
  }

  @Override
  public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
    if (requestCode == REQ_CAMERA_PERMISSION && pendingPermissionRequest != null) {
      boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
      if (granted) {
        pendingPermissionRequest.grant(pendingPermissionRequest.getResources());
      } else {
        pendingPermissionRequest.deny();
      }
      pendingPermissionRequest = null;
      return;
    }
    super.onRequestPermissionsResult(requestCode, permissions, grantResults);
  }
}
