import { NextResponse } from "next/server";

/**
 * Digital Asset Links — `/.well-known/assetlinks.json`.
 *
 * Android fetches this to decide whether links to this host may open a native
 * app instead of a browser (and, for a Trusted Web Activity, whether the URL bar
 * may be hidden). Without it, a printed link or QR always opens the browser.
 *
 * There is one entry per native app. Both are served from the same deployment —
 * the web product is one backend behind several apps, and so is this list:
 *
 *   ANDROID_APP_PACKAGE         + ANDROID_CERT_SHA256         → Parents App
 *   ANDROID_TEACHER_APP_PACKAGE + ANDROID_TEACHER_CERT_SHA256 → Teacher App
 *
 * Fingerprints are deployment facts, not code. Comma-separate several when a
 * build is signed by more than one key (upload key + Play App Signing). Use the
 * PLAY APP SIGNING SHA-256 once published — NOT the upload key.
 *
 * Get a fingerprint with:
 *   keytool -list -v -keystore <keystore> -alias <alias>
 */
export const dynamic = "force-static";

/** One Android app that claims links on this host. */
interface AndroidApp {
  packageName: string;
  fingerprints: string[];
}

function app(packageEnv: string | undefined, certEnv: string | undefined, fallbackPackage: string): AndroidApp {
  return {
    packageName: packageEnv || fallbackPackage,
    fingerprints: (certEnv || "")
      .split(",")
      .map((f) => f.trim().toUpperCase())
      .filter(Boolean),
  };
}

export function GET() {
  const apps: AndroidApp[] = [
    app(process.env.ANDROID_APP_PACKAGE, process.env.ANDROID_CERT_SHA256, "com.amareeschool.parents"),
    app(process.env.ANDROID_TEACHER_APP_PACKAGE, process.env.ANDROID_TEACHER_CERT_SHA256, "com.amareeschool.teachers"),
  ];

  const body = apps.map((a) => ({
    relation: ["delegate_permission/common.handle_all_urls"],
    target: {
      namespace: "android_app",
      package_name: a.packageName,
      sha256_cert_fingerprints: a.fingerprints,
    },
  }));

  return NextResponse.json(body, {
    headers: {
      "Content-Type": "application/json",
      // Android fetches this without cookies; it is public by design.
      "Cache-Control": "public, max-age=300",
    },
  });
}
