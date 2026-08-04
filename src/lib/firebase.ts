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

/** Default Cloud Storage bucket for uploaded files. */
export function storageBucket(): string {
  return (
    process.env.FIREBASE_STORAGE_BUCKET ||
    `${adminApp().options.projectId || "smart-school-erp"}.appspot.com`
  );
}
