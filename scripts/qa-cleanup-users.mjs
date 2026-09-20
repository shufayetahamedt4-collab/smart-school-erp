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
const db = getFirestore();

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
