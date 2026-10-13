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
 * Phase 7e ADDS the college half of the same rule, on the ONLY tenant that owns
 * both halves at once (the fixture's BOTH tenant, seeded by
 * `scripts/isolation-fixture.mjs` with 17,000 of school money and 45,000 of
 * college money): college dues are finite, they are the COLLEGE's own figures,
 * and neither half's money appears in the other's read. The five school checks
 * above are untouched — every 7e assertion is an addition, so the recorded
 * school baseline (`15` checks, the count the 7b/7c record cites) is still the
 * count this script prints for the demo tenant.
 *
 * The college half SKIPS, loudly and without a pass, when the fixture is absent
 * — a hosted run (`SMOKE_ORIGIN=…`) has no fixture tenant to read, and reporting
 * an unrun check as green is exactly what this file must not do.
 *
 * Read-only: it never writes a fee, a payment or a ledger entry.
 *
 * Usage:
 *   SMOKE_PORT=3123 node scripts/verify-fees-totals.mjs
 *   SMOKE_ORIGIN=https://smart-school-erp-1--amar-e-school.asia-southeast1.hosted.app \
 *     node scripts/verify-fees-totals.mjs
 */
import { readFileSync } from "node:fs";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

import { installHostFetch } from "./lib/hostfetch.mjs";

// Integration 5a — a `Host:` header on fetch is a fetch-spec forbidden name and
// was silently dropped, so every host-scoped request below reached the hub.
// Those requests now go through node:http, which delivers the header for real.
// This changes request DELIVERY only: no assertion, expectation or fixture moved.
installHostFetch();

loadEnv();
requireEmulator();

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

/* --------------------------------------------------- 7. the college half (7e) */
// The SAME money rule, in the other mode. The BOTH tenant is the only one that
// holds both halves at once, so it is the only tenant where "the school's money
// is not the college's" is a READABLE claim: the fixture gives it 17,000 of
// school money (12,000 + 5,000) and 45,000 of college money, and the two share
// no value.
let fixture = null;
try {
  fixture = JSON.parse(readFileSync(new URL(".qa-fixtures.json", import.meta.url), "utf8"));
} catch {
  fixture = null;
}
const bothAdmin = fixture?.creds?.bothAdmin
  ? await login(host(HOSTS.school), { id: "zz-iso-both-admin@test.local", pw: fixture.creds.bothAdmin })
  : null;
const COLLEGE_HALF_WHY =
  "the college half of the money rule (9 checks, on a BOTH tenant with both halves populated) needs scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create";
if (!bothAdmin) {
  // A LOCAL run must have the fixture. Printing a SKIP and then ALL GREEN would report
  // 9 checks that never ran as if they had passed — the one thing this file refuses to do.
  // A hosted run (SMOKE_ORIGIN) has no fixture tenant by construction, so it keeps the
  // loud skip and its exit code is unchanged.
  if (LOCAL) {
    check(COLLEGE_HALF_WHY, false, "a local run must create the fixture first");
  } else {
    console.log(`  SKIP  ${COLLEGE_HALF_WHY} (a hosted run has no fixture tenant — nothing to skip locally)`);
  }
} else {
  const SCHOOL = { billed: 17000, paid: 8000, due: 9000 };
  const COLLEGE = { billed: 45000, paid: 15000, due: 30000 };
  const minor = (v) => Math.round(Number(v || 0) * 100);

  const bothFees = await req(host(HOSTS.school), "/api/fees", { cookie: bothAdmin });
  const bothRows = bothFees.data?.fees || [];
  check("GET /api/fees as a BOTH tenant's admin", bothFees.status === 200 && bothRows.length > 0, `HTTP ${bothFees.status} ${bothRows.length} rows`);
  const bothBilled = round(bothRows.reduce((a, f) => a + Number(f.amount || 0), 0));
  const bothPaid = round(bothRows.reduce((a, f) => a + Number(f.paidAmount || 0), 0));
  check(
    "the BOTH tenant's school half totals its OWN money (17,000 billed / 8,000 paid / 9,000 due)",
    minor(bothBilled) === minor(SCHOOL.billed) && minor(bothPaid) === minor(SCHOOL.paid) && minor(bothBilled - bothPaid) === minor(SCHOOL.due),
    `${bothBilled} / ${bothPaid} / ${round(bothBilled - bothPaid)}`
  );
  const bothJson = JSON.stringify(bothFees.data);
  check(
    "…and NO college row, id or amount is in it (a college charge must never move a school total)",
    !/\bcf_/.test(bothJson) && !bothJson.includes("collegeFee") && !bothJson.includes(String(COLLEGE.billed)) && !bothJson.includes(String(COLLEGE.due)),
    `payload=${bothJson.length}B`
  );

  const bothStats = await req(host(HOSTS.school), "/api/stats", { cookie: bothAdmin });
  const bothStatsFees = bothStats.data?.fees || {};
  check(
    "…and /api/stats' fee payload is that same school-only money",
    bothStats.status === 200 && isMoney(bothStatsFees.totalFees) && isMoney(bothStatsFees.paidFees) &&
      minor(bothStatsFees.totalFees) === minor(SCHOOL.billed) && minor(bothStatsFees.paidFees) === minor(SCHOOL.paid),
    `HTTP ${bothStats.status} ${JSON.stringify(bothStatsFees)}`
  );

  const dues = await req(host(HOSTS.school), "/api/college-fees/dues", { cookie: bothAdmin });
  const totals = dues.data?.totals || {};
  check("GET /api/college-fees/dues as the same BOTH tenant's admin", dues.status === 200 && !!dues.data, `HTTP ${dues.status} ${dues.error || ""}`);
  check(
    "college money is finite too (billed / paid / due, never NaN or null)",
    isMoney(totals.billed) && isMoney(totals.paid) && isMoney(totals.due) && isMoney(totals.gross),
    JSON.stringify(totals)
  );
  // The fixture's seeded charge is the ANCHOR (45,000 / 15,000 / 30,000): it must
  // be on the read, and the read's totals must be exactly its own rows — so this
  // stays exact about WHICH money it is looking at without pinning a total that a
  // college write elsewhere in the same database may legitimately have raised.
  const seededCharge = (totals.rows || []).find((r) => r.id === "zziso-both-charge-1");
  check(
    "college dues contain the fixture's own charge (45,000 / 15,000 / 30,000 due) — the college half is non-empty",
    !!seededCharge && minor(seededCharge.amount) === minor(COLLEGE.billed) && minor(seededCharge.paid) === minor(COLLEGE.paid) && minor(seededCharge.due) === minor(COLLEGE.due),
    JSON.stringify(seededCharge || null)
  );
  check(
    "…and the totals are exactly those rows (paid + due === billed, no school money folded in)",
    minor((totals.rows || []).reduce((a, r) => a + Number(r.amount || 0), 0)) === minor(totals.billed) &&
      minor(totals.paid + totals.due) === minor(totals.billed) &&
      (totals.rows || []).every((r) => !String(r.id).startsWith("zziso-both-fee-")),
    `billed=${totals.billed} paid+due=${round(totals.paid + totals.due)}`
  );
  // The whole payload, not just the money: a leaked SCHOOL fee row shows up as its
  // id or its own title, and neither can be confused with a college figure.
  const duesJson = JSON.stringify(dues.data);
  check(
    "…and NO school fee row, id or title is in the college read (the other direction of the same rule)",
    !duesJson.includes("zziso-both-fee-") && !duesJson.includes("ZZ Iso Both School") &&
      !duesJson.includes(String(SCHOOL.billed)) && !duesJson.includes(String(SCHOOL.due)),
    `payload=${duesJson.length}B`
  );
}

console.log(failures === 0 ? "\nALL GREEN\n" : `\n${failures} CHECK(S) FAILED\n`);
process.exit(failures === 0 ? 0 : 1);
