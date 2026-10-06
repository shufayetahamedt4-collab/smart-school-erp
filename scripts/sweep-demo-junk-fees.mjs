/**
 * sweep-demo-junk-fees.mjs — remove the demo tenant's known junk fee rows and
 * take their FEE ledger entries with them, so billed totals stay consistent.
 *
 * What the junk is and how it got there:
 *
 *   1. "maggie — 2026-09" — a test fee category ("maggie", ONE_TIME, per-class
 *      amounts 100–600) that was generated for the demo school's whole roster.
 *      It is not a real fee head; nothing else in the tenant references it.
 *   2. "Yearly Study Tour 2026 — 2026-09" — the study-tour category is YEARLY
 *      ("one charge for the 2026 trip") and was already billed under period
 *      `2026`. A second generation run billed every pupil AGAIN under period
 *      `2026-09`, doubling the family's dues. The `2026` rows are the
 *      canonical copy — one of them carries the demo guardian's real ৳1000
 *      payment — so the `2026-09` copies are the ones removed.
 *
 * Safety rails, in order:
 *   • only rows matching the exact criteria below are selected, and every one
 *     of them is printed before anything is written;
 *   • a row that carries any payment (paidAmount > 0), or is referenced by a
 *     payment / payment intent / installment, is REFUSED — money never
 *     disappears because a script said so;
 *   • a row whose ledger trail includes anything other than the original FEE
 *     entry is REFUSED the same way;
 *   • read-only unless --apply, and every deletion is read back to confirm.
 *
 * Usage:
 *   node scripts/sweep-demo-junk-fees.mjs                     # report only
 *   node scripts/sweep-demo-junk-fees.mjs --apply             # sweep the demo school
 *   node scripts/sweep-demo-junk-fees.mjs --school <id> [--apply]
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

loadEnv();
requireEmulator();

const APPLY = process.argv.includes("--apply");
const schoolArg = (() => {
  const i = process.argv.indexOf("--school");
  return i > -1 ? process.argv[i + 1] : null;
})();

function unescapeKey(k) {
  const BS = String.fromCharCode(92);
  return k.includes(BS + "n") ? k.split(BS + "n").join("\n") : k;
}

// Inside the emulator (FIRESTORE_EMULATOR_HOST — the guard above guarantees it is
// loopback) the emulator needs no credentials, so never build a cert() from
// possibly absent ones: initialise with the project id alone, exactly as
// scripts/seed.mjs does. Outside it, the credentials are used as before.
const emulatorMode = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

if (!getApps().length) {
  if (emulatorMode) {
    initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
  } else {
    initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID,
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: unescapeKey(process.env.FIREBASE_PRIVATE_KEY || ""),
      }),
    });
  }
}
const db = getFirestore();

/* ------------------------------------------------------------- the criteria */
// The junk is identified by what it IS, not by a fuzzy title match.
const MAGGIE_CATEGORY_ID = "r_d4c7dec37a3752df"; // test category "maggie"
const MAGGIE_TITLE_PREFIX = "maggie"; // belt and braces: any row titled maggie …
const TOUR_CATEGORY_ID = "r_303ded5113a8c75c"; // "Yearly Study Tour 2026" (YEARLY)
const TOUR_CANONICAL_PERIOD = "2026"; // keep — the canonical yearly bill
const TOUR_DUP_PERIOD = "2026-09"; // the accidental second billing

const finite = (v) => typeof v === "number" && Number.isFinite(v);

console.log(`\n=== demo junk-fee sweep (${APPLY ? "APPLY" : "dry run"})${schoolArg ? ` · school ${schoolArg}` : ""} ===\n`);

/* --------------------------------------------------------------- the tenant */
let SCHOOL = schoolArg;
if (!SCHOOL) {
  // The demo school — same resolution the verify harnesses use.
  const admin = await db.collection("users").where("email", "==", "principal@sunrise.edu").limit(1).get();
  if (admin.empty) {
    console.error("No demo admin principal@sunrise.edu — pass --school <id> to target a school explicitly.");
    process.exit(1);
  }
  SCHOOL = admin.docs[0].data().schoolId;
}
console.log(`school ${SCHOOL}\n`);

/* ------------------------------------------------------------------- select */
const feeSnap = await db.collection("fees").where("schoolId", "==", SCHOOL).get();
const junk = [];
for (const doc of feeSnap.docs) {
  const f = doc.data();
  const title = String(f.title || "");
  const period = String(f.period ?? "");
  const isMaggie = f.categoryId === MAGGIE_CATEGORY_ID || title.toLowerCase().startsWith(MAGGIE_TITLE_PREFIX);
  const isDupTour = f.categoryId === TOUR_CATEGORY_ID && period === TOUR_DUP_PERIOD;
  if (isMaggie || isDupTour) {
    junk.push({ ref: doc.ref, id: doc.id, title, period, amount: finite(f.amount) ? f.amount : 0, paid: finite(f.paidAmount) ? f.paidAmount : 0, why: isMaggie ? "maggie test category" : "yearly tour billed twice" });
  }
}
console.log(`fees scanned: ${feeSnap.size} · junk rows selected: ${junk.length}`);
for (const j of junk) {
  console.log(`  ${j.id}  ${j.title.padEnd(40)} amount ${String(j.amount).padStart(6)}  paid ${j.paid}  (${j.why})`);
}
if (!junk.length) {
  console.log("\nNothing to sweep — the junk rows are already gone.\n");
  process.exit(0);
}

/* -------------------------------------------------------- the safety rails */
const junkIds = new Set(junk.map((j) => j.id));
const refused = [];

for (const j of junk) {
  if (j.paid > 0) refused.push({ ...j, reason: `carries a payment of ${j.paid}` });
}

const trails = [["payments", "payment"], ["paymentIntents", "payment intent"], ["installments", "installment"]];
const attached = new Map(); // feeId -> [descriptions]
for (const [col, label] of trails) {
  const snap = await db.collection(col).where("schoolId", "==", SCHOOL).get();
  for (const d of snap.docs) {
    const feeId = d.data().feeId;
    if (feeId && junkIds.has(feeId)) {
      if (!attached.has(feeId)) attached.set(feeId, []);
      attached.get(feeId).push(`${label} ${d.id}`);
    }
  }
}
for (const j of junk) {
  if (attached.has(j.id)) refused.push({ ...j, reason: `referenced by ${attached.get(j.id).join(", ")}` });
}

// The only ledger rows a never-paid junk fee may have is its original FEE entry.
const ledgerSnap = await db.collection("ledger").where("schoolId", "==", SCHOOL).get();
const ledgerByFee = new Map();
for (const d of ledgerSnap.docs) {
  const x = d.data();
  if (x.feeId && junkIds.has(x.feeId)) {
    if (!ledgerByFee.has(x.feeId)) ledgerByFee.set(x.feeId, []);
    ledgerByFee.get(x.feeId).push({ id: d.id, kind: x.kind, amount: finite(x.amount) ? x.amount : 0 });
  }
}
for (const j of junk) {
  const rows = ledgerByFee.get(j.id) || [];
  for (const l of rows) {
    if (l.kind !== "FEE") refused.push({ ...j, reason: `ledger row ${l.id} is kind ${l.kind} (${l.amount}) — not the original billing` });
  }
}

if (refused.length) {
  console.log(`\nREFUSED ${refused.length} row(s) — these carry money or history and are NOT touched:`);
  for (const r of refused) console.log(`  ${r.id}  ${r.title} — ${r.reason}`);
  const ok = junk.filter((j) => !refused.some((r) => r.id === j.id));
  if (!ok.length) {
    console.log("\nNothing safe to remove. Aborting.\n");
    process.exit(1);
  }
  console.log(`\nContinuing with the remaining ${ok.length} row(s)…`);
  junk.length = 0;
  junk.push(...ok);
}

/* ------------------------------------------------------------------ the plan */
const before = { billed: 0, paid: 0 };
for (const d of feeSnap.docs) {
  const f = d.data();
  before.billed += finite(f.amount) ? f.amount : 0;
  before.paid += finite(f.paidAmount) ? f.paidAmount : 0;
}
const sweepBilled = junk.reduce((s, j) => s + j.amount, 0);
const ledgerRefs = junk.flatMap((j) => (ledgerByFee.get(j.id) || []).map((l) => l.id));
console.log(`\nplan: remove ${junk.length} fee row(s) (billed ৳${sweepBilled}, all unpaid) and ${ledgerRefs.length} FEE ledger entr(ies)`);
console.log(`totals before: billed ৳${before.billed} · paid ৳${before.paid} · due ৳${before.billed - before.paid}`);

if (!APPLY) {
  console.log(`\nDry run — nothing written. Re-run with --apply to sweep ${junk.length} row(s) and ${ledgerRefs.length} ledger entr(ies).\n`);
  process.exit(0);
}

/* -------------------------------------------------------------------- apply */
let removedLedger = 0;
for (const id of ledgerRefs) {
  await db.collection("ledger").doc(id).delete();
  removedLedger++;
}
let removedFees = 0;
for (const j of junk) {
  await j.ref.delete();
  removedFees++;
}

// Read every deleted doc back — a sweep that silently missed is worse than none.
const stillThere = [];
for (const j of junk) if ((await j.ref.get()).exists) stillThere.push(`fees/${j.id}`);
for (const id of ledgerRefs) if ((await db.collection("ledger").doc(id).get()).exists) stillThere.push(`ledger/${id}`);
if (stillThere.length) {
  console.error(`\nFAILED — these docs survived deletion: ${stillThere.join(", ")}\n`);
  process.exit(1);
}

// Confirm the books still add up after the sweep.
const afterSnap = await db.collection("fees").where("schoolId", "==", SCHOOL).get();
const after = { billed: 0, paid: 0, rows: afterSnap.size };
for (const d of afterSnap.docs) {
  const f = d.data();
  after.billed += finite(f.amount) ? f.amount : 0;
  after.paid += finite(f.paidAmount) ? f.paidAmount : 0;
}
console.log(`\nRemoved ${removedFees} fee row(s) and ${removedLedger} ledger entr(ies) — every deletion read back clean.`);
console.log(`totals after:  billed ৳${after.billed} · paid ৳${after.paid} · due ৳${after.billed - after.paid} · ${after.rows} rows`);
console.log(`delta:         billed −৳${before.billed - after.billed} · due −৳${before.billed - after.billed} · paid ±৳${before.paid - after.paid}`);
console.log(`\nSwept. The remaining books: paid + due === billed ✓\n`);
process.exit(0);
