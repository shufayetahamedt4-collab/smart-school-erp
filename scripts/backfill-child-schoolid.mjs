/**
 * backfill-child-schoolid.mjs — one-time idempotent backfill.
 *
 * Child collections (homeworkSubmissions, meetingBookings) historically had
 * docs without a `schoolId` stamp. School-scoped bulk reads (bulk-parallel
 * route rewrites) filter on schoolId, so unstamped docs are invisible to
 * them. This script stamps schoolId derived from the parent doc
 * (homework / meetingSlot). `installments` and `payments` are checked too
 * (both writers already stamp, but this makes the sweep complete).
 *
 * Idempotent: only writes docs where schoolId is missing. Safe to re-run.
 * Usage: node scripts/backfill-child-schoolid.mjs
 */
import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";

// Use the project's service account (same convention as other scripts).
let cred;
try {
  const sa = JSON.parse(readFileSync(new URL("../service-account.json", import.meta.url), "utf8"));
  cred = { credential: null, sa };
} catch {
  cred = { credential: applicationDefault(), sa: null };
}
import { cert } from "firebase-admin/app";
initializeApp(cred.sa ? { credential: cert(cred.sa), projectId: cred.sa.project_id } : { credential: applicationDefault() });
const db = getFirestore();

const JOB = "backfill-child-schoolid";
console.log(`[${JOB}] start`);

/** parentCol + parentField on the child that holds the parent's id. */
const SPECS = [
  { col: "submissions", parentCol: "homeworks", parentField: "homeworkId", label: "homeworkSubmission" },
  { col: "meetingBookings", parentCol: "meetingSlots", parentField: "slotId", label: "meetingBooking" },
  { col: "installments", parentCol: "fees", parentField: "feeId", label: "installment" },
  { col: "payments", parentCol: "fees", parentField: "feeId", label: "payment" },
];

let totalFixed = 0;
for (const spec of SPECS) {
  const snap = await db.collection(spec.col).get();
  const unstamped = snap.docs.filter((d) => !d.data().schoolId);
  if (!unstamped.length) {
    console.log(`  ${spec.label}: 0 unstamped (of ${snap.size})`);
    continue;
  }
  // Batch-fetch parents for the unstamped children only.
  const parentIds = [...new Set(unstamped.map((d) => d.data()[spec.parentField]).filter(Boolean))];
  const parentSchool = new Map();
  await Promise.all(
    parentIds.map(async (pid) => {
      const p = await db.collection(spec.parentCol).doc(pid).get();
      if (p.exists && p.data().schoolId) parentSchool.set(pid, p.data().schoolId);
    })
  );
  let fixed = 0, orphans = 0;
  const writer = db.bulkWriter();
  for (const d of unstamped) {
    const sid = parentSchool.get(d.data()[spec.parentField]);
    if (!sid) { orphans++; continue; }
    writer.update(d.ref, { schoolId: sid });
    fixed++;
  }
  await writer.close();
  totalFixed += fixed;
  console.log(`  ${spec.label}: stamped ${fixed}, skipped(orphans) ${orphans}, of ${snap.size}`);
}

console.log(`[${JOB}] done — ${totalFixed} docs stamped`);
process.exit(0);
