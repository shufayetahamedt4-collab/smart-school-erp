/**
 * verify-fees-totals.mjs — a school with money collected must never see ৳0.
 *
 * The bug this locks down: fee rows written before `paidAmount` was set carry a
 * missing key, a null, or a NaN (the payment ledger used to compute
 * `Math.min(amount, Number(fee.paidAmount) + paid)` on a row with no paidAmount,
 * and NaN is a perfectly storable Firestore double). `Number(undefined)` is NaN,
 * and a single NaN poisons an entire `reduce`, so the fees page, the dashboard,
 * the branch monitor and every student's debt all printed ৳0 while the table
 * right below showed the real amounts.
 *
 * What is checked, against the demo tenant:
 *   1. /api/fees emits every money field as a finite number (no null / missing /
 *      NaN) — the read-boundary normalisation
 *   2. the school-wide totals are finite and equal to the sum of the visible rows
 *   3. the same totals come back from /api/stats, and paid + due === billed
 *   4. the guardian's own fee view totals the same way for their child
 *   5. the ledger's own money math stays finite
 *
 * Read-only: it never writes a fee, a payment or a ledger entry.
 *
 * Usage:
 *   SMOKE_PORT=3123 node scripts/verify-fees-totals.mjs
 *   SMOKE_ORIGIN=https://smart-school-erp-1--amar-e-school.asia-southeast1.hosted.app \
 *     node scripts/verify-fees-totals.mjs
 */
import { loadEnv } from "./load-env.mjs";

loadEnv();

// NB: this shell exports PORT=0, so never read process.env.PORT here.
const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3123";
const ORIGIN = process.env.SMOKE_ORIGIN || `http://127.0.0.1:${PORT}`;
const LOCAL = !process.env.SMOKE_ORIGIN;
// Host headers pick the sector app on a local dev server; a deployed single
// address serves every app, so the header is left off there.
const host = (h) => (LOCAL ? { Host: h } : {});
const HOSTS = { school: `school.localhost:${PORT}`, parents: `parents.localhost:${PORT}` };
const ADMIN = { id: "principal@sunrise.edu", pw: "School@123" };
const GUARDIAN = { id: "guardian1@demo.com", pw: "Guardian@123" };

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/* --------------------------------------------------------------------- http */
async function req(hostHeader, path, { cookie, ...init } = {}) {
  const res = await fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { ...hostHeader, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
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

async function login(hostHeader, { id, pw }) {
  const r = await req(hostHeader, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: id, password: pw }) });
  if (r.status !== 200) throw new Error(`login ${id}: HTTP ${r.status} ${r.error || ""}`);
  const cookie = r.setCookie.split(";")[0];
  if (!cookie) throw new Error(`login ${id}: no session cookie`);
  return cookie;
}

/** A value that is usable in money math: a finite number, not null/undefined/NaN. */
const isMoney = (v) => typeof v === "number" && Number.isFinite(v);
const round = (n) => Math.round(n * 100) / 100;

/* ----------------------------------------------------------------- the run */
console.log(`\n=== fees totals (${ORIGIN}) ===\n`);

const admin = await login(host(HOSTS.school), ADMIN);

const feesRes = await req(host(HOSTS.school), "/api/fees", { cookie: admin });
check("GET /api/fees as school admin", feesRes.status === 200, `HTTP ${feesRes.status}`);
const fees = feesRes.data?.fees || [];
check("fees returned", fees.length > 0, `${fees.length} rows`);

// 1. every money field is a finite number for every row
const badRows = fees.filter((f) => !isMoney(f.amount) || !isMoney(f.paidAmount));
check(
  "every row carries a finite amount and paidAmount",
  badRows.length === 0,
  badRows.length ? `${badRows.length} bad: ${JSON.stringify(badRows[0]?.amount)} / ${JSON.stringify(badRows[0]?.paidAmount)}` : "no null / missing / NaN"
);

// 2. totals over the visible rows are finite and add up
const billed = round(fees.reduce((a, f) => a + f.amount, 0));
const paid = round(fees.reduce((a, f) => a + f.paidAmount, 0));
const due = round(fees.reduce((a, f) => a + (f.amount - f.paidAmount), 0));
check("school totals are finite", isMoney(billed) && isMoney(paid) && isMoney(due), `billed ${billed} · paid ${paid} · due ${due}`);
check("paid + due === billed (row for row)", round(paid + due) === billed, `${paid} + ${due} = ${round(paid + due)} vs ${billed}`);
check("totals are not silently zeroed", billed > 0 && (paid > 0 || due > 0), `billed ${billed} is ${billed > 0 ? ">0" : "0"}`);

// 3. the dashboard's own aggregate agrees with the fee list
const statsRes = await req(host(HOSTS.school), "/api/stats", { cookie: admin });
check("GET /api/stats as school admin", statsRes.status === 200, `HTTP ${statsRes.status}`);
const statsFees = statsRes.data?.fees || {};
check(
  "stats fees are finite numbers",
  isMoney(statsFees.totalFees) && isMoney(statsFees.paidFees) && isMoney(statsFees.dueFees),
  JSON.stringify(statsFees)
);
check("stats billed matches the fee list", round(statsFees.totalFees) === billed, `${statsFees.totalFees} vs ${billed}`);
check("stats collected matches the fee list", round(statsFees.paidFees) === paid, `${statsFees.paidFees} vs ${paid}`);

// 4. a guardian sees finite money math for their own child
const guardian = await login(host(HOSTS.parents), GUARDIAN);
const gFeesRes = await req(host(HOSTS.parents), "/api/fees", { cookie: guardian });
const gFees = gFeesRes.data?.fees || [];
const gBad = gFees.filter((f) => !isMoney(f.amount) || !isMoney(f.paidAmount));
check("guardian fee rows are finite", gBad.length === 0, gBad.length ? `${gBad.length} bad rows` : `${gFees.length} rows clean`);
check(
  "guardian totals are finite",
  gFees.every((f) => Number.isFinite(f.amount - f.paidAmount)),
  `total ${round(gFees.reduce((a, f) => a + f.amount, 0))} · due ${round(gFees.reduce((a, f) => a + (f.amount - f.paidAmount), 0))}`
);

// 5. the ledger that writes payments keeps its math finite too.
// NB: never reach for `data.entries` on a list — an Array's own `.entries` is a
// function, so `data?.entries || data` silently hands back a function and this
// check would pass while testing nothing.
const ledgerRes = await req(host(HOSTS.school), "/api/ledger?take=100", { cookie: admin });
const entries = Array.isArray(ledgerRes.data) ? ledgerRes.data : ledgerRes.data?.ledger || [];
check("ledger returned a list", Array.isArray(entries) && entries.length > 0, `${Array.isArray(entries) ? entries.length : "not a"} entries`);
const ledgerBad = entries.filter((e) => !isMoney(e.amount));
check("ledger amounts are finite", ledgerBad.length === 0, ledgerBad.length ? `${ledgerBad.length} bad: ${JSON.stringify(ledgerBad[0]?.amount)}` : "no null / NaN amounts");

// 6. the page that shows it all is actually served
const page = await fetch(`${ORIGIN}/dashboard/fees`, { headers: { ...host(HOSTS.school), cookie: admin } });
check("GET /dashboard/fees", page.status === 200, `HTTP ${page.status}`);

console.log(failures === 0 ? "\nALL GREEN\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
