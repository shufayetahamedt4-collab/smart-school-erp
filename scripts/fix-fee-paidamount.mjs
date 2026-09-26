/**
 * fix-fee-paidamount.mjs — repair fee rows whose paidAmount is missing / null / NaN.
 *
 * How they got that way: the payment flow computed
 * `Math.min(Number(fee.amount), Number(fee.paidAmount) + paid)`, and
 * `Number(undefined)` is NaN. Firestore stores NaN as a perfectly valid double,
 * so the row kept a NaN `paidAmount` (which JSON turns into `null` on the way out
 * of the API). Every total that summed such a row with `Number()` became NaN and
 * printed ৳0 — the fees page, the dashboard, the branch monitor, student debt.
 *
 * The app no longer reads or writes money that way (see lib/utils money() and
 * lib/ledger confirmPayment). This script cleans up the values already stored.
 *
 * The repair value is the sum of the fee's own payments when it has any — that is
 * the truth the ledger already recorded — otherwise 0. `status` is recomputed to
 * match, so a repaired row is consistent instead of merely non-NaN.
 *
 * Read-only unless you ask: pass --apply to write.
 *
 * Usage:
 *   node scripts/fix-fee-paidamount.mjs                    # report only
 *   node scripts/fix-fee-paidamount.mjs --apply            # repair every school
 *   node scripts/fix-fee-paidamount.mjs --school <schoolId> [--apply]
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const APPLY = process.argv.includes("--apply");
const schoolArg = (() => {
  const i = process.argv.indexOf("--school");
  return i > -1 ? process.argv[i + 1] : null;
})();

function unescapeKey(k) {
  const BS = String.fromCharCode(92);
  return k.includes(BS + "n") ? k.split(BS + "n").join("\n") : k;
}

if (!getApps().length) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: unescapeKey(process.env.FIREBASE_PRIVATE_KEY || ""),
    }),
  });
}
const db = getFirestore();

const finite = (v) => typeof v === "number" && Number.isFinite(v);
const isBroken = (v) => !finite(v); // missing key, null, NaN, string, Infinity
const label = (v) => (v === undefined ? "missing" : v !== v ? "NaN" : JSON.stringify(v));

console.log(`\n=== fee paidAmount audit (${APPLY ? "APPLY" : "dry run"})${schoolArg ? ` · school ${schoolArg}` : ""} ===\n`);

let feesQ = db.collection("fees");
if (schoolArg) feesQ = feesQ.where("schoolId", "==", schoolArg);
const feesSnap = await feesQ.get();
console.log(`fees scanned: ${feesSnap.size}`);

// Payments are school-scoped in this schema; index them once per feeId.
const paymentsSnap = await db.collection("payments").get();
const paidByFee = new Map();
for (const p of paymentsSnap.docs) {
  const d = p.data();
  if (!d.feeId) continue;
  paidByFee.set(d.feeId, (paidByFee.get(d.feeId) || 0) + (finite(d.amount) ? d.amount : 0));
}

const broken = [];
for (const doc of feesSnap.docs) {
  const f = doc.data();
  if (!isBroken(f.paidAmount)) continue;
  broken.push({ ref: doc.ref, id: doc.id, schoolId: f.schoolId, title: f.title, amount: f.amount, stored: f.paidAmount, status: f.status });
}

// A row can also be "wrong but not broken": amount missing, which breaks every
// total the same way.
const brokenAmount = [];
for (const doc of feesSnap.docs) {
  const f = doc.data();
  if (finite(f.amount)) continue;
  brokenAmount.push({ id: doc.id, schoolId: f.schoolId, title: f.title, stored: f.amount });
}

console.log(`\npaidAmount not a finite number: ${broken.length}`);
console.log(`amount      not a finite number: ${brokenAmount.length}`);
if (!broken.length && !brokenAmount.length) {
  console.log("\nNothing to repair — every fee row is already a finite number.\n");
  process.exit(0);
}

const bySchool = {};
for (const b of broken) bySchool[b.schoolId || "(none)"] = (bySchool[b.schoolId || "(none)"] || 0) + 1;
for (const [school, n] of Object.entries(bySchool)) console.log(`  ${school}: ${n}`);

console.log("\nsample (the ones that zeroed the totals):");
for (const b of broken.slice(0, 8)) {
  const fromPayments = paidByFee.get(b.id) || 0;
  console.log(`  ${b.id}  ${String(b.title).padEnd(24)} amount ${JSON.stringify(b.amount)}  stored ${label(b.stored)}  → ${fromPayments} (payments)  status ${b.status}`);
}

const plan = broken.map((b) => {
  const paid = paidByFee.get(b.id) || 0;
  const amount = finite(b.amount) ? b.amount : 0;
  const status = paid >= amount && amount > 0 ? "PAID" : paid > 0 ? "PARTIAL" : "UNPAID";
  return { ...b, newPaid: paid, newStatus: status };
});

if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply to fix ${plan.length} row(s).\n`);
  process.exit(0);
}

let wrote = 0;
for (const p of plan) {
  await p.ref.update({ paidAmount: p.newPaid, status: p.newStatus });
  wrote++;
}
let amountFixed = 0;
for (const b of brokenAmount) {
  await db.collection("fees").doc(b.id).update({ amount: 0 });
  amountFixed++;
}
console.log(`\nRepaired ${wrote} paidAmount row(s) and ${amountFixed} amount row(s).\n`);
process.exit(0);
