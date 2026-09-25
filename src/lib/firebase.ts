import { initializeApp, getApps, cert, type App } from "firebase-admin/app";
import { getFirestore, type Firestore } from "firebase-admin/firestore";

/**
 * Lazy Firebase Admin singleton.
 *
 * Credentials come from env vars (service account fields). On Google Cloud
 * (Firebase App Hosting / Cloud Run) you can omit them and let the runtime
 * use Application Default Credentials instead.
 */
let _app: App | null = null;
let _db: Firestore | null = null;

export function adminApp(): App {
  if (_app) return _app;
  const existing = getApps()[0];
  if (existing) {
    _app = existing;
    return _app;
  }
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;

  _app = initializeApp(
    projectId && clientEmail && privateKey
      ? {
          projectId,
          credential: cert({
            projectId,
            clientEmail,
            privateKey: privateKey.replace(/\\n/g, "\n"),
          }),
        }
      : { projectId: projectId || undefined }
  );
  return _app;
}

export function getDb(): Firestore {
  if (!_db) _db = getFirestore(adminApp());
  return _db;
}

/**
 * Is this process relying on Application Default Credentials? True on Google
 * Cloud (App Hosting / Cloud Run / GAE) and for a local `gcloud auth` setup, and
 * false on a host that has no metadata server — Netlify, Vercel, a plain VM.
 * There, the three FIREBASE_* variables are the only way in.
 */
function adcAvailable(): boolean {
  return Boolean(
    process.env.GOOGLE_APPLICATION_CREDENTIALS ||
      // The local Firestore emulator accepts anything: no key needed at all,
      // which is what makes an offline install (see INSTALL.md) possible.
      process.env.FIRESTORE_EMULATOR_HOST ||
      process.env.K_SERVICE ||
      process.env.FUNCTION_TARGET ||
      process.env.GAE_SERVICE ||
      process.env.GOOGLE_CLOUD_PROJECT
  );
}

/**
 * Why the Admin SDK cannot reach Firestore, or `null` when it looks configured.
 *
 * Written for the deployment that is *missing* its environment: a serverless
 * host with no Application Default Credentials and no service-account vars has
 * no way to authenticate, and every data route then fails at the first read
 * with an opaque 500. Callers use this to say what is actually wrong instead.
 */
export function firebaseConfigProblem(): string | null {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const missing = [
    !projectId && "FIREBASE_PROJECT_ID",
    !clientEmail && "FIREBASE_CLIENT_EMAIL",
    !privateKey && "FIREBASE_PRIVATE_KEY",
  ].filter(Boolean) as string[];

  if (!missing.length || adcAvailable()) return null;
  return (
    `This server has no Firebase credentials: ${missing.join(", ")} ` +
    `${missing.length > 1 ? "are" : "is"} not set, and no Application Default Credentials are available on this host. ` +
    `Set them in the deployment's environment variables (and redeploy), or set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON. ` +
    `GET /api/health reports what this process can see.`
  );
}

/** Default Cloud Storage bucket for uploaded files. */
export function storageBucket(): string {
  return (
    process.env.FIREBASE_STORAGE_BUCKET ||
    `${adminApp().options.projectId || "smart-school-erp"}.appspot.com`
  );
}
