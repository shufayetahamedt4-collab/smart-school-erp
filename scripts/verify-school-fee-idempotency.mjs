/**
 * verify-school-fee-idempotency.mjs — pilot P2.
 *
 * The bug this locks down (reproduced live before the fix): `confirmPayment`
 * read the fee, computed the new paidAmount in JS and wrote the ABSOLUTE value
 * back, so two simultaneous ৳500 payments against a ৳1000 fee both read 0, both
 * wrote 500, and the school ended up with two payment rows, two receipts, a
 * ledger of ৳1000 — and a fee that still read ৳500/PARTIAL. A sequential retry of
 * the same ৳500 simply appended a second payment and a second receipt.
 *
 * What is checked:
 *
 *   A. OFFLINE PINS on the four files this stage may touch
 *        db.ts     — `schoolPaymentIds` is DETERMINISTIC (sha1 of tenant|fee|key,
 *                    no clock, no randomness) and derives BOTH ids
 *        ledger.ts — `confirmPayment` decides inside `$guardedUpdate("fee", …)`,
 *                    increments rather than writes an absolute value, pre-reads
 *                    the deterministic ledger id for a replay, refuses (never
 *                    clamps) a keyed over-payment, and still CLAMPS keylessly
 *        route     — validates the optional key by name and skips the courtesy
 *                    due pre-check for a keyed attempt (so a replay can reach
 *                    the record it must answer from)
 *        page      — the Collect button is disabled in flight, and ONE key is
 *                    minted per attempt and REUSED on a retry
 *      plus: the exports this stage must NOT change are pinned by text
 *      (`postToLedger`, `paymentKeyFrom`, `confirmCollegePayment`).
 *
 *   B. LIVE CONCURRENCY against the emulator + a running app — the exact
 *      reproduction, on a fresh ৳1000 fee each time:
 *        (a) two different keys, simultaneous ৳500+৳500 → ৳1000/PAID, 2 rows
 *        (b) ONE key, simultaneous → one row, one receipt
 *        (c) ONE key, sequential retry → the ORIGINAL receipt, `replay: true`
 *        (c2) ONE key, retry after the fee settled → still 200 (not "already
 *             fully paid"), because the route defers a keyed attempt
 *        (d) two different keys, simultaneous ৳600+৳600 vs ৳1000 → exactly one
 *        (e) full amount, ONE key, simultaneous → one row
 *        (f) keyless: the historical clamp, and the lost update is gone
 *
 * Usage:
 *   node scripts/verify-school-fee-idempotency.mjs --offline     # no emulator needed
 *   SMOKE_PORT=3000 node scripts/verify-school-fee-idempotency.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

loadEnv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
let fail = 0;
const check = (id, label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  [${id}] ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};

/** Strip comments so a pin cannot be satisfied by prose. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * The body of a named function, by brace matching.
 *
 * The opening brace is the first `{` that is NOT the start of a return-type
 * annotation (`): { a: string } {`), so a typed helper is not mistaken for its
 * own signature.
 */
function body(text, nameRe) {
  const m = nameRe.exec(text);
  if (!m) return "";
  let open = -1;
  for (let j = m.index + m[0].length - 1; j < text.length; j++) {
    if (text[j] === "{") {
      const before = text.slice(Math.max(0, j - 60), j);
      // NB: a return-type annotation may itself contain `;` (`: { a: string; b: string }`),
      // so the scan may not stop at a semicolon.
      if (/:\s*$/.test(before)) continue; // this `{` starts a `): { … }` return-type annotation
      open = j;
      break;
    }
  }
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return "";
}

/* =========================================================== A. OFFLINE PINS */

console.log("\n=== A. offline pins ===\n");

const dbSrc = strip(read("src/lib/db.ts"));
const ledgerSrc = strip(read("src/lib/ledger.ts"));
const routeSrc = strip(read("src/app/api/fees/[id]/pay/route.ts"));
const pageSrc = strip(read("src/app/dashboard/fees/page.tsx"));

// --- db.ts: the id helper is deterministic and derives both ids --------------
const idHelper = body(dbSrc, /export function schoolPaymentIds\s*\(/);
check("off-1", "db.ts exports schoolPaymentIds", /export function schoolPaymentIds/.test(dbSrc));
check("off-2", "schoolPaymentIds derives the ids from sha1 (deterministic)", /sha1\(/.test(idHelper), idHelper ? "sha1 found" : "no body");
check(
  "off-3",
  "schoolPaymentIds has NO clock and NO randomness (mutation v)",
  idHelper.length > 0 && !/Math\.random/.test(idHelper) && !/Date\.now/.test(idHelper),
  idHelper.replace(/\s+/g, " ").slice(0, 120)
);
check("off-4", "schoolPaymentIds keys on the tenant AND the fee", /\bschoolId\b/.test(idHelper) && /\bfeeId\b/.test(idHelper));
check("off-5", "schoolPaymentIds returns both a paymentId and a ledgerId", /paymentId/.test(idHelper) && /ledgerId/.test(idHelper));

// --- ledger.ts: the guarded, incrementing decision --------------------------
const confirm = body(ledgerSrc, /export async function confirmPayment\s*\(/);
check("off-6", "confirmPayment has a body", confirm.length > 100);
check(
  "off-7",
  "the fee is decided inside a guarded transaction (mutation ii)",
  /prisma\.\$guardedUpdate\(\s*"\s*fee\s*"\s*,/.test(confirm),
  "no $guardedUpdate(\"fee\", …) found"
);
check(
  "off-8",
  "the old blind absolute write is gone (mutation ii)",
  !/tx\.fee\.update\(/.test(confirm) && !/prisma\.fee\.update\(/.test(confirm),
  "still writes the fee through update()"
);
check(
  "off-9",
  "the KEYED write is an increment of the CURRENT stored paidAmount",
  /const newPaid = currentPaid \+ amount;/.test(confirm),
  "no `const newPaid = currentPaid + amount;` in the keyed branch"
);
check(
  "off-32",
  "no absolute write computed from the PRE-READ fee (mutation ii)",
  !/money\(fee\.paidAmount\)\s*\+\s*amount/.test(confirm),
  "the pre-read fee.paidAmount is still used to compute the write"
);
check(
  "off-10",
  "the remaining due is re-checked INSIDE the transaction (mutation iii)",
  /currentBilled\s*-\s*currentPaid/.test(confirm) && /amount\s*>\s*due/.test(confirm),
  "no in-transaction due check"
);
check(
  "off-11",
  "a keyed over-payment is REFUSED with the route's own text",
  /This fee is already fully paid\./.test(confirm) && /still due on this fee\./.test(confirm)
);
check(
  "off-12",
  "the keyless path still CLAMPS to the billed amount",
  /Math\.min\(\s*currentBilled\s*,\s*currentPaid\s*\+\s*amount\s*\)/.test(confirm),
  "keyless clamp missing"
);
check(
  "off-13",
  "a replay is answered from the deterministic ledger id (mutation i)",
  /prisma\.ledgerEntry\.findUnique\(\s*\{\s*where:\s*\{\s*id:\s*ids\.ledgerId/.test(confirm),
  "no ledger pre-read by ids.ledgerId"
);
check("off-14", "confirmPayment derives its ids with schoolPaymentIds", /schoolPaymentIds\(/.test(confirm));
check("off-15", "confirmPayment reuses the existing paymentKeyFrom helper", /paymentKeyFrom\(/.test(confirm));
check("off-16", "the keyed replay sets a visible replay flag", /replay:\s*true/.test(confirm));

// --- ledger.ts: the exports this stage must NOT change ----------------------
const postToLedgerBody = body(ledgerSrc, /export async function postToLedger\s*\(/);
check(
  "off-17",
  "postToLedger is untouched (still a plain ledgerEntry.create)",
  /return prisma\.ledgerEntry\.create\(/.test(postToLedgerBody) && !/\bid\b\s*:/.test(postToLedgerBody),
  "postToLedger changed"
);
check(
  "off-18",
  "confirmCollegePayment still exists untouched",
  /export async function confirmCollegePayment\s*\(/.test(ledgerSrc) && /collegePaymentLedgerId\(/.test(ledgerSrc)
);
check(
  "off-19",
  "collegeReceiptNo and refAlreadyProcessed still exist untouched",
  /export function collegeReceiptNo\s*\(/.test(ledgerSrc) && /export async function refAlreadyProcessed\s*\(/.test(ledgerSrc)
);
check(
  "off-20",
  "paymentKeyFrom is still the 7e-pre helper (trims, never throws)",
  /export function paymentKeyFrom\s*\(/.test(ledgerSrc) && /trimmed\.slice\(0,\s*120\)/.test(ledgerSrc)
);

// --- the route --------------------------------------------------------------
check(
  "off-21",
  "the route validates the key by name (OFF-21)",
  /idempotencyKey must be between 8 and 120 characters\./.test(routeSrc)
);
check(
  "off-22",
  "the route accepts the key from the body OR the x-idempotency-key header",
  /body\?\.idempotencyKey/.test(routeSrc) && /x-idempotency-key/.test(routeSrc)
);
check(
  "off-23",
  "the courtesy due pre-check is SKIPPED for a keyed attempt (OFF-23)",
  /if\s*\(\s*!idempotencyKey\s*\)\s*\{/.test(routeSrc)
);
check("off-24", "the route passes idempotencyKey through to confirmPayment", /idempotencyKey,/.test(routeSrc));

// --- the Collect dialog -----------------------------------------------------
const payFn = body(strip(read("src/app/dashboard/fees/page.tsx")), /const pay = async \(\) =>/);
check("off-25", "the Collect submit handler exists", payFn.length > 100);
check(
  "off-26",
  "one key per ATTEMPT, reused on a retry (OFF-26)",
  /payKey\.current\s*\|\|\s*\(payKey\.current\s*=\s*newPaymentKey\(\)\)/.test(payFn) &&
    !/newPaymentKey\(\)/.test(payFn.replace(/payKey\.current\s*\|\|\s*\(payKey\.current\s*=\s*newPaymentKey\(\)\)/, "")),
  "the key is minted per request, not per attempt"
);
check(
  "off-27",
  "the button is disabled while the request is in flight (mutation iv)",
  /payBusy/.test(pageSrc) && /disabled=\{payBusy \|\|/.test(pageSrc),
  "no in-flight disable"
);
check(
  "off-28",
  "a second click while in flight is ignored outright",
  /if\s*\(\s*payBusy\s*\)\s*return;/.test(payFn)
);
check("off-29", "server refusals are shown verbatim", /setError\(e\.message\)/.test(payFn));
check("off-30", "the key is cleared only after a success", /payKey\.current\s*=\s*""/.test(payFn));

// --- the design note --------------------------------------------------------
check(
  "off-31",
  "docs/PAYMENTS-DESIGN.md records the future-webhook path",
  (() => {
    try {
      const doc = read("docs/PAYMENTS-DESIGN.md");
      return /webhook/i.test(doc) && /idempotency/i.test(doc);
    } catch {
      return false;
    }
  })()
);

console.log(`\noffline: ${pass} pass / ${fail} fail`);

/* ============================================================= B. LIVE HALF */

const OFFLINE_ONLY = process.argv.includes("--offline");
if (OFFLINE_ONLY) {
  console.log("\nlive half: SKIP (--offline)");
} else {
  requireEmulator();
  await liveHalf();
}

async function liveHalf() {
  const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
  const ORIGIN = process.env.SMOKE_ORIGIN || `http://127.0.0.1:${PORT}`;
  const LOCAL = !process.env.SMOKE_ORIGIN;
  const host = (h) => (LOCAL ? { Host: h } : {});
  const SCHOOL = `school.localhost:${PORT}`;
  const ADMIN = { id: "principal@sunrise.edu", pw: "School@123" };
  const stamp = `P2-${Date.now().toString(36)}`;

  async function req(pathname, { cookie, ...init } = {}) {
    const res = await fetch(`${ORIGIN}${pathname}`, {
      ...init,
      headers: {
        ...host(SCHOOL),
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      /* html */
    }
    return { status: res.status, data: body?.data ?? null, error: body?.error ?? null, setCookie: res.headers.get("set-cookie") || "" };
  }

  const login = async () => {
    const r = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: ADMIN.id, password: ADMIN.pw }) });
    if (r.status !== 200) throw new Error(`login ${ADMIN.id}: HTTP ${r.status} ${r.error || ""}`);
    const cookie = r.setCookie.split(";")[0];
    if (!cookie) throw new Error("login: no session cookie");
    return cookie;
  };

  const money = (v) => (typeof v === "number" ? v : Number(String(v ?? "0").replace(/[^\d.-]/g, "")) || 0);
  const newKey = () => `p2k_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;

  console.log(`\n=== B. live concurrency (${ORIGIN}) ===\n`);
  const admin = await login();

  const students = await req("/api/students", { cookie: admin });
  const studentId = (students.data || [])[0]?.id;
  if (!studentId) throw new Error("no student in the demo school — run scripts/seed.mjs first");

  /** Create a fresh fee and return its row. */
  async function makeFee(amount, label) {
    const title = `${label} ${stamp}`;
    const r = await req("/api/fees", { method: "POST", cookie: admin, body: JSON.stringify({ studentId, title, amount, feeType: "OTHER" }) });
    if (r.status !== 201 || !r.data?.id) throw new Error(`POST /api/fees: HTTP ${r.status} ${r.error || ""}`);
    return { id: r.data.id, title, amount };
  }

  const pay = (feeId, { amount, method = "CASH", key, header } = {}) =>
    req(`/api/fees/${feeId}/pay`, {
      method: "POST",
      cookie: admin,
      headers: header ? { "x-idempotency-key": header } : {},
      body: JSON.stringify({ amount, method, ...(key ? { idempotencyKey: key } : {}) }),
    });

  async function readFee(feeId) {
    const r = await req("/api/fees", { cookie: admin });
    const row = (r.data?.fees || []).find((f) => f.id === feeId);
    if (!row) throw new Error(`fee ${feeId} not visible after the write`);
    return row;
  }

  async function ledgerFor(feeId) {
    const r = await req("/api/ledger?take=300", { cookie: admin });
    const entries = Array.isArray(r.data) ? r.data : r.data?.ledger || [];
    const mine = entries.filter((e) => e.kind === "PAYMENT" && e.feeId === feeId);
    return { count: mine.length, sum: mine.reduce((a, e) => a + money(e.amount), 0) };
  }

  const created = [];

  try {
    /* ---- (a) two DIFFERENT keys, simultaneous, together exactly the due ---- */
    const fa = await makeFee(1000, "p2a");
    created.push(fa.id);
    const [a1, a2] = await Promise.all([pay(fa.id, { amount: 500, key: newKey() }), pay(fa.id, { amount: 500, key: newKey() })]);
    const faRow = await readFee(fa.id);
    const faLed = await ledgerFor(fa.id);
    check("a-1", "(a) both different-key ৳500 payments accepted", a1.status === 200 && a2.status === 200, `HTTP ${a1.status}/${a2.status}`);
    check("a-2", "(a) fee paidAmount is ৳1000 — the lost update is gone", money(faRow.paidAmount) === 1000, `paid ${faRow.paidAmount}`);
    check("a-3", "(a) fee status is PAID", faRow.status === "PAID", String(faRow.status));
    check("a-4", "(a) exactly two payment rows", faRow.payments.length === 2, `${faRow.payments.length} rows`);
    check("a-5", "(a) the ledger records ৳1000 across two entries", faLed.count === 2 && faLed.sum === 1000, `${faLed.count} entries / ${faLed.sum}`);
    check("a-6", "(a) the two receipts are distinct", a1.data?.receiptNo && a1.data.receiptNo !== a2.data?.receiptNo, `${a1.data?.receiptNo} vs ${a2.data?.receiptNo}`);

    /* ---- (b) ONE key, simultaneous ---------------------------------------- */
    const fb = await makeFee(1000, "p2b");
    created.push(fb.id);
    const keyB = newKey();
    const [b1, b2] = await Promise.all([pay(fb.id, { amount: 500, key: keyB }), pay(fb.id, { amount: 500, key: keyB })]);
    const fbRow = await readFee(fb.id);
    const fbLed = await ledgerFor(fb.id);
    check("b-1", "(b) both same-key taps answered 200", b1.status === 200 && b2.status === 200, `HTTP ${b1.status}/${b2.status}`);
    check("b-2", "(b) ONE payment row", fbRow.payments.length === 1, `${fbRow.payments.length} rows`);
    check("b-3", "(b) fee paidAmount is ৳500, never ৳1000", money(fbRow.paidAmount) === 500, `paid ${fbRow.paidAmount}`);
    check("b-4", "(b) ONE ledger entry of ৳500", fbLed.count === 1 && fbLed.sum === 500, `${fbLed.count} entries / ${fbLed.sum}`);
    check("b-5", "(b) both answers carry the SAME original receipt", b1.data?.receiptNo === b2.data?.receiptNo, `${b1.data?.receiptNo} vs ${b2.data?.receiptNo}`);
    check("b-6", "(b) at least one answer is flagged as a replay", b1.data?.replay === true || b2.data?.replay === true, `replay ${b1.data?.replay}/${b2.data?.replay}`);

    /* ---- (c) ONE key, sequential retry ----------------------------------- */
    const fc = await makeFee(1000, "p2c");
    created.push(fc.id);
    const keyC = newKey();
    const c1 = await pay(fc.id, { amount: 500, key: keyC });
    const c2 = await pay(fc.id, { amount: 500, key: keyC });
    const fcRow = await readFee(fc.id);
    const fcLed = await ledgerFor(fc.id);
    check("c-1", "(c) the sequential retry is answered 200", c2.status === 200, `HTTP ${c2.status}`);
    check("c-2", "(c) the retry returns the ORIGINAL receipt", c2.data?.receiptNo === c1.data?.receiptNo, `${c2.data?.receiptNo} vs ${c1.data?.receiptNo}`);
    check("c-3", "(c) the retry is flagged replay", c2.data?.replay === true, String(c2.data?.replay));
    check("c-4", "(c) still ONE payment row and ONE ledger entry", fcRow.payments.length === 1 && fcLed.count === 1, `${fcRow.payments.length} rows / ${fcLed.count} entries`);
    check("c-5", "(c) the fee is NOT paid twice", money(fcRow.paidAmount) === 500, `paid ${fcRow.paidAmount}`);

    /* ---- (c2) a retry AFTER the fee settled is still answered ------------ */
    const fc2 = await makeFee(1000, "p2c2");
    created.push(fc2.id);
    const keyC2 = newKey();
    const c21 = await pay(fc2.id, { amount: 1000, key: keyC2 });
    const c22 = await pay(fc2.id, { amount: 1000, key: keyC2 });
    check("c2-1", "(c2) a full payment is accepted", c21.status === 200, `HTTP ${c21.status}`);
    check("c2-2", "(c2) the retry after settling is 200, not 400 'already fully paid'", c22.status === 200, `HTTP ${c22.status} ${c22.error || ""}`);
    check("c2-3", "(c2) the retry replays the original receipt", c22.data?.receiptNo === c21.data?.receiptNo, `${c22.data?.receiptNo} vs ${c21.data?.receiptNo}`);

    /* ---- (d) two different keys, together MORE than the due -------------- */
    const fd = await makeFee(1000, "p2d");
    created.push(fd.id);
    const [d1, d2] = await Promise.all([pay(fd.id, { amount: 600, key: newKey() }), pay(fd.id, { amount: 600, key: newKey() })]);
    const fdRow = await readFee(fd.id);
    const fdLed = await ledgerFor(fd.id);
    const dOk = [d1, d2].filter((r) => r.status === 200);
    const dBad = [d1, d2].filter((r) => r.status !== 200);
    check("d-1", "(d) exactly ONE ৳600 succeeds", dOk.length === 1 && dBad.length === 1, `200×${dOk.length} / non-200×${dBad.length}`);
    check("d-2", "(d) the loser is refused by name", /still due on this fee/.test(String(dBad[0]?.error || "")), String(dBad[0]?.error || ""));
    check("d-3", "(d) the fee never collects more than ৳1000", money(fdRow.paidAmount) === 600, `paid ${fdRow.paidAmount}`);
    check("d-4", "(d) ONE payment row and ৳600 in the ledger", fdRow.payments.length === 1 && fdLed.count === 1 && fdLed.sum === 600, `${fdRow.payments.length} rows / ${fdLed.sum}`);

    /* ---- (e) full amount, ONE key, simultaneous -------------------------- */
    const fe = await makeFee(1000, "p2e");
    created.push(fe.id);
    const keyE = newKey();
    const [e1, e2] = await Promise.all([pay(fe.id, { amount: 1000, key: keyE }), pay(fe.id, { amount: 1000, key: keyE })]);
    const feRow = await readFee(fe.id);
    const feLed = await ledgerFor(fe.id);
    check("e-1", "(e) the full-amount pair leaves ONE payment row", feRow.payments.length === 1, `${feRow.payments.length} rows`);
    check("e-2", "(e) the fee is exactly ৳1000/PAID", money(feRow.paidAmount) === 1000 && feRow.status === "PAID", `${feRow.paidAmount}/${feRow.status}`);
    check("e-3", "(e) the ledger holds ONE entry of ৳1000", feLed.count === 1 && feLed.sum === 1000, `${feLed.count} / ${feLed.sum}`);
    check("e-4", "(e) both answers share one receipt", e1.data?.receiptNo === e2.data?.receiptNo, `${e1.data?.receiptNo} vs ${e2.data?.receiptNo}`);

    /* ---- (f) keyless ----------------------------------------------------- */
    const ff = await makeFee(1000, "p2f");
    created.push(ff.id);
    const f1 = await pay(ff.id, { amount: 500 });
    const ffRow = await readFee(ff.id);
    check("f-1", "(f) a keyless payment is still accepted", f1.status === 200, `HTTP ${f1.status}`);
    check("f-2", "(f) a keyless payment increments the fee to ৳500", money(ffRow.paidAmount) === 500, `paid ${ffRow.paidAmount}`);
    check("f-3", "(f) a keyless response carries no replay flag", f1.data?.replay === undefined, String(f1.data?.replay));

    const fg = await makeFee(1000, "p2g");
    created.push(fg.id);
    await Promise.all([pay(fg.id, { amount: 500 }), pay(fg.id, { amount: 500 })]);
    const fgRow = await readFee(fg.id);
    const fgLed = await ledgerFor(fg.id);
    check("f-4", "(f) keyless simultaneous ৳500+৳500 no longer LOSE an update — fee is ৳1000/PAID", money(fgRow.paidAmount) === 1000 && fgRow.status === "PAID", `${fgRow.paidAmount}/${fgRow.status}`);
    check("f-5", "(f) keyless rows are unchanged in shape (two payment rows, ৳1000 in the ledger)", fgRow.payments.length === 2 && fgLed.sum === 1000, `${fgRow.payments.length} rows / ${fgLed.sum}`);

    /* ---- key validation + the header form ------------------------------- */
    const fh = await makeFee(1000, "p2h");
    created.push(fh.id);
    const short = await pay(fh.id, { amount: 500, key: "short" });
    check("v-1", "an unusable key is refused (400) by name", short.status === 400 && /idempotencyKey must be between 8 and 120 characters\./.test(String(short.error || "")), `HTTP ${short.status} ${short.error || ""}`);
    const hKey = newKey();
    const h1 = await pay(fh.id, { amount: 500, header: hKey });
    const h2 = await pay(fh.id, { amount: 500, header: hKey });
    check("v-2", "the key is honoured from the x-idempotency-key header too", h1.status === 200 && h2.status === 200 && h1.data?.receiptNo === h2.data?.receiptNo, `${h1.status}/${h2.status}`);
    const fhRow = await readFee(fh.id);
    check("v-3", "the header form still records ONE payment", fhRow.payments.length === 1, `${fhRow.payments.length} rows`);

    /* ---- the fee with no payment at all is untouched --------------------- */
    const fi = await makeFee(1000, "p2i");
    created.push(fi.id);
    const fiRow = await readFee(fi.id);
    check("v-4", "a fee with no payment still reads ৳0/UNPAID", money(fiRow.paidAmount) === 0 && fiRow.status === "UNPAID", `${fiRow.paidAmount}/${fiRow.status}`);

    console.log(`\nlive: ${pass} pass / ${fail} fail`);
  } finally {
    /* teardown through firebase-admin: the emulator is disposable, but a
       verifier that leaves money rows behind would poison a later read. */
    try {
      const { initializeApp } = await import("firebase-admin/app");
      const { getFirestore } = await import("firebase-admin/firestore");
      const app = initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID }, "p2-teardown");
      const db = getFirestore(app);
      const del = async (col, field, value) => {
        const snap = await db.collection(col).where(field, "==", value).get();
        if (snap.empty) return 0;
        const batch = db.batch();
        snap.forEach((d) => batch.delete(d.ref));
        await batch.commit();
        return snap.size;
      };
      for (const feeId of created) {
        await del("payments", "feeId", feeId);
        await del("ledger", "feeId", feeId);
        await del("installments", "feeId", feeId);
        await db.collection("fees").doc(feeId).delete().catch(() => null);
      }
      console.log(`\n[teardown] removed ${created.length} throwaway fee(s) and their rows`);
    } catch (e) {
      console.log(`\n[teardown] skipped — ${String(e?.message || e)}`);
    }
  }
}

console.log(`\nRESULT: ${pass}/${pass + fail} checks passed\n`);
process.exit(fail === 0 ? 0 : 1);
