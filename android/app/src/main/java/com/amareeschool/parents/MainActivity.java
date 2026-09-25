package com.amareeschool.parents;

import com.amareeschool.shell.NativeShellActivity;

/**
 * Amar E School — Parents App.
 *
 * All of the shell's behaviour (fullscreen WebView, back handling, uploads,
 * camera, external-link escape, App Links, offline screen) lives in
 * {@link NativeShellActivity}; this class only states what makes the Parents App
 * *this* app. See android/shell/ for the shared implementation.
 */
public class MainActivity extends NativeShellActivity {

  @Override
  protected String origin() {
    return BuildConfig.PARENTS_ORIGIN;
  }

  /**
   * Must match the check in the web app's install logic
   * (src/components/InstallApp.tsx → NATIVE_SHELL_UA).
   */
  @Override
  protected String uaSuffix() {
    return "AmarESchoolParents/1.0";
  }

  @Override
  protected String accentHex() {
    return "0ea5e9";
  }

  @Override
  protected String errorTitle() {
    return "Can't reach the school right now";
  }
}
