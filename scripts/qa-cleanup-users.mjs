/**
 * One-off residue sweep: removes QA users left after the Phase 2/3 QA run
 * (school DELETE doesn't cascade to users). Idempotent.
 *
 * Run:  node --env-file=.env scripts/qa-cleanup-users.mjs
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;
if (!PROJECT_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error("Missing FIREBASE_* credentials — run with --env-file=.env");
  process.exit(1);
}
if (!getApps().length) {
  initializeApp({ projectId: PROJECT_ID, credential: cert({ project_id: PROJECT_ID, client_email: CLIENT_EMAIL, private_key: PRIVATE_KEY.replace(/\\n/g, "\n") }) });
}
// pilot P3 — the database must be NAMED on a live run: FIRESTORE_DATABASE_ID is
// the canonical name, FIRESTORE_DB_ID its alias, and the literal "(default)" is
// refused. The emulator is unchanged (its own "(default)" is the local database),
// and scripts/lib/guard.mjs keeps these sweep scripts emulator-only anyway — the
// refusal is what protects the one path that is NOT emulator-only.
const EMULATOR = String(process.env.FIRESTORE_EMULATOR_HOST || "").trim();
const DATABASE_NAME = String(process.env.FIRESTORE_DATABASE_ID || process.env.FIRESTORE_DB_ID || "").trim();
if (!EMULATOR && (!DATABASE_NAME || DATABASE_NAME === "(default)")) {
  console.error(
    'Refusing to open the "(default)" Firestore database: this sweep DELETES user documents, so it must be pointed at ' +
      'a NAMED database. Set FIRESTORE_DATABASE_ID (or FIRESTORE_DB_ID) — "smart-school-db". The "(default)" fallback ' +
      "was removed (pilot P3); rollback is the hosting console's Rollback button, not an unset variable."
  );
  process.exit(1);
}
const db = getFirestore(undefined, DATABASE_NAME || "(default)");

const snap = await db.collection("users").get();
const batch = db.batch();
let n = 0;
snap.docs.forEach((d) => {
  const email = String(d.data().email || "");
  if (email.endsWith("@qatest.edu") || email.includes(".test.com") || email.endsWith("@test.com")) {
    batch.delete(d.ref);
    n++;
    console.log("deleting user:", email);
  }
});
if (n) await batch.commit();
console.log(`\nDone — ${n} QA user(s) removed.`);
