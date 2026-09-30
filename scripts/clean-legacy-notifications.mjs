/**
 * Remove the notification rows that predate timestamps.
 *
 * The in-app notification writer used to omit `createdAt`, so every row created
 * before that fix rendered a blank "—" in the bell and could not be sorted. Rows
 * also survive from a retired marks workflow (EXAM_MARKS_*, EXAM_RESULT_PUBLISHED)
 * that no longer exists in this codebase, so they look like fabricated demo data
 * in a working bell.
 *
 * This script removes, for one school:
 *   • any notification without a `createdAt`, and
 *   • any notification whose event is one of the retired workflows.
 * Everything it will remove is written to `notifications-backup-<school>.json`
 * in the OS temp directory BEFORE anything is deleted.
 *
 * Dry run (the default) prints what it would delete. `--apply` performs it.
 *
 *   node scripts/clean-legacy-notifications.mjs
 *   node scripts/clean-legacy-notifications.mjs --apply
 *   node scripts/clean-legacy-notifications.mjs --school=s_... --apply
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const APPLY = process.argv.includes("--apply");
const DEMO_SCHOOL = "s_54bf3dc2c4f98fabdf78b7216c0ae888455d009a";
const schoolArg = (process.argv.find((a) => a.startsWith("--school=")) || "").split("=")[1];
const SCHOOL = schoolArg || process.env.SMOKE_SCHOOL_ID || DEMO_SCHOOL;

/** Workflows that no longer exist in the app — their rows can never be re-made. */
const RETIRED_EVENTS = new Set([
  "EXAM_MARKS_REQUESTED",
  "EXAM_MARKS_VERIFIED",
  "EXAM_MARKS_RETURNED",
  "EXAM_MARKS_SUBMITTED",
  "EXAM_RESULT_PUBLISHED",
]);

const BS = String.fromCharCode(92);
const unesc = (k) => (k.includes(BS + "n") ? k.split(BS + "n").join("\n") : k);
if (!getApps().length) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: unesc(process.env.FIREBASE_PRIVATE_KEY || ""),
    }),
  });
}
const db = getFirestore();

const snap = await db.collection("notifications").where("schoolId", "==", SCHOOL).get();
const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

const doomed = rows.filter((r) => !r.createdAt || RETIRED_EVENTS.has(String(r.event)));
const keep = rows.filter((r) => !doomed.includes(r));

console.log(`school            ${SCHOOL}`);
console.log(`total rows        ${rows.length}`);
console.log(`would remove      ${doomed.length}`);
console.log(`would keep        ${keep.length}`);
if (doomed.length) {
  const byEvent = {};
  for (const r of doomed) byEvent[r.event || "(none)"] = (byEvent[r.event || "(none)"] || 0) + 1;
  console.log("by event          ", JSON.stringify(byEvent));
}

if (!doomed.length) {
  console.log("Nothing to do.");
  process.exit(0);
}

const backupPath = path.join(os.tmpdir(), `notifications-backup-${SCHOOL}.json`);
writeFileSync(backupPath, JSON.stringify(doomed, null, 2), "utf8");
console.log(`backup written to  ${backupPath}`);

if (!APPLY) {
  console.log("\nDry run — pass --apply to delete these rows.");
  process.exit(0);
}

// Batched delete: Firestore allows 500 writes per batch.
let removed = 0;
for (let i = 0; i < doomed.length; i += 450) {
  const batch = db.batch();
  for (const r of doomed.slice(i, i + 450)) batch.delete(db.collection("notifications").doc(r.id));
  await batch.commit();
  removed += doomed.slice(i, i + 450).length;
}
console.log(`\nRemoved ${removed} legacy notification(s).`);
