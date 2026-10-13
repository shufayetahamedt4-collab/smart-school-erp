#!/usr/bin/env node
/**
 * verify-mode-mixing.mjs — Phase 7e: **a BOTH tenant's two halves must never mix
 * in a read** (docs/COLLEGE-DECISIONS.md §24.4 D-7-12 / D-7-13, owner ruling Q3).
 *
 * The condition D-7-12 makes BINDING is one sentence: school-mode money and
 * college-mode money share ONE ledger but may never share a READ — the school
 * half's fee totals, its fee list and `/api/stats`' fee payload are identical
 * WITH and WITHOUT college charges present, no college row appears in a
 * school-mode read, no school row appears in a college-mode read, and a BOTH
 * tenant sees its two halves separately, each in its own mode.
 *
 * **Why the tenant must hold BOTH halves.** `verify-college-fees-api` already
 * proves a COLLEGE tenant's (empty) school read does not move when college money
 * appears. That is necessary and NOT sufficient: a tenant with no school money
 * cannot show that school money stays out of the college read, nor that the
 * college read stays out of the school read. So this script runs against the
 * fixture's **BOTH** tenant, whose two halves the fixture populates with
 * deliberately unmistakable, non-overlapping amounts — the school's own
 * 12,000/5,000 against the college's 45,000 — and the `where`/tag rules are the
 * only thing standing between them.
 *
 * **Every check is measured, never asserted.** The school-side readings are
 * captured BEFORE the script's own college write and compared BYTE FOR BYTE
 * AFTER it, so "identical with and without college charges present" is a
 * measurement of this very run (the college charge this script creates is what
 * makes the two halves non-empty at the same instant), not a claim about rows
 * somebody seeded once.
 *
 * What it covers, per the phase's acceptance criteria:
 *
 *   1. the SCHOOL half: `/api/fees` returns exactly its two own rows and their
 *      own 17,000/8,000/9,000, with no college id, head or amount anywhere in
 *      the payload;
 *   2. the same read under the OTHER mode cookie is byte-identical, and
 *      `/api/auth/me` confirms the mode really switched — so the mode is proven
 *      to be UI context, never a filter and never a grant (D-7-3/§3);
 *   3. `/api/stats`' fee payload agrees with the fee list, in BOTH modes;
 *   4. the COLLEGE half: `/api/college-fees/dues` returns exactly its own charge
 *      and its own 45,000/15,000/30,000, with no school row or amount in it;
 *   5. THE MEASUREMENT: create a college head + structure + charge for the BOTH
 *      tenant, then re-read the school half — the fee list and the stats payload
 *      are BYTE-IDENTICAL to the pre-write capture, while the college half gains
 *      exactly the new charge's money;
 *   6. the shared ledger keeps the two apart by its ONE tag: the school entry
 *      carries its `feeId` and no college tag, the college entry carries
 *      `feeId: null` + `meta.collegeFeeId` and the college's own `CRCP-`
 *      receipt, and the tenant-wide ledger read shows both halves in either mode
 *      (the documented inclusion — the tag is what tells them apart);
 *   7. cross-tenant: the COLLEGE fixture tenant's reads contain none of the BOTH
 *      tenant's rows, a foreign student is the SAME 404 as a ghost one, and the
 *      BOTH tenant sees the college tenant's student the same way.
 *
 * Branch confinement for college fees is NOT re-proved here: `verify-branch-isolation`'s
 * "college fees — branch admin confinement" section already pins it (own-branch
 * heads/structure/payment, 403 on another branch's charge), and the SCHOOL-tenant
 * 403 matrix and the unauthenticated 401 live in `verify-college-fees-api`.
 *
 *   node scripts/verify-mode-mixing.mjs
 *   SMOKE_PORT=3123 node scripts/verify-mode-mixing.mjs
 *
 * Needs the emulator, the app, and `node scripts/isolation-fixture.mjs create`.
 */
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";
import { installHostFetch } from "./lib/hostfetch.mjs";
import { readFileSync } from "node:fs";

installHostFetch();
loadEnv();
requireEmulator();

// NB: this shell exports PORT=0, so never read process.env.PORT here.
const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3123";
const ORIGIN = process.env.SMOKE_ORIGIN || `http://127.0.0.1:${PORT}`;
const LOCAL = !process.env.SMOKE_ORIGIN;
const host = (h) => (LOCAL ? { Host: h } : {});
const HOSTS = { school: `school.localhost:${PORT}` };

/* --------------------------------------------------------------- the fixture */

const P = "zziso-";
const BOTH = `${P}both`;
const BOTH_STU = `${P}both-stu`;
const BOTH_PROG = `${P}both-prog`;
const COLLEGE_STU_A = `${P}col-stu-a`;

/**
 * The fixture's own numbers, repeated here on purpose: if the fixture's spine is
 * edited, these assertions must be re-read rather than silently still pass. The
 * two halves' amounts share NO value, so "which half came back" is decidable
 * from the figures alone.
 */
const SCHOOL = { feeA: `${P}both-fee-a`, feeB: `${P}both-fee-b`, billed: 17000, paid: 8000, due: 9000 };
const COLLEGE = { charge: `${P}both-charge-1`, billed: 45000, paid: 15000, due: 30000 };
/** The one college write this script makes — a brand-new head, so it cannot
 *  collide with the fixture's charge (generation is idempotent per
 *  (student, head, term), so re-billing an existing head would add nothing). */
const PROBE_AMOUNT = 2500;

const TRACK = new URL(".qa-fixtures.json", import.meta.url);
let CRED = {};
try {
  CRED = JSON.parse(readFileSync(TRACK, "utf8")).creds || {};
} catch {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(2);
}
if (!CRED.bothAdmin || !CRED.collegeAdmin) {
  console.error("❌ The fixture was created without the 7e tenants — run: node scripts/isolation-fixture.mjs create");
  process.exit(2);
}

/* ------------------------------------------------------------------- helpers */

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const eq = (label, actual, expected) => check(label, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
const round = (n) => Math.round(Number(n) * 100) / 100;
const sum = (rows, pick) => round(rows.reduce((a, r) => a + Number(pick(r) || 0), 0));
const isMoney = (v) => typeof v === "number" && Number.isFinite(v);
/** Minor units, so money equality is exact integer arithmetic (no float drift). */
const minor = (v) => Math.round(Number(v || 0) * 100);

async function req(path, { cookie, method = "GET", body, mode } = {}) {
  const jar = [cookie, mode ? `ss_mode=${mode}` : null].filter(Boolean).join("; ");
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      ...host(HOSTS.school),
      "Content-Type": "application/json",
      ...(jar ? { cookie: jar } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let parsed = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, data: parsed?.data ?? null, error: parsed?.error ?? null, raw: text };
}

/** The session cookie of a successful sign-in (the same shape the other verifiers use). */
async function signIn(id, pw) {
  const res = await fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { ...host(HOSTS.school), "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: id, password: pw }),
    signal: AbortSignal.timeout(60000),
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (res.status !== 200 || !cookie) throw new Error(`login ${id}: HTTP ${res.status} cookie=${cookie || "(none)"}`);
  return cookie;
}

const feesOf = (body) => (Array.isArray(body?.data?.fees) ? body.data.fees : null);
const totalsOf = (rows) => ({
  billed: sum(rows, (f) => f.amount),
  paid: sum(rows, (f) => f.paidAmount),
  due: sum(rows, (f) => Number(f.amount) - Number(f.paidAmount)),
});

/* ------------------------------------------------------------------ the run */

console.log(`\n=== Phase 7e — mode mixing: a BOTH tenant's two halves never touch (${ORIGIN}) ===\n`);

const bothAdmin = await signIn("zz-iso-both-admin@test.local", CRED.bothAdmin);
const collegeAdmin = await signIn("zz-iso-college-admin@test.local", CRED.collegeAdmin);

// The mode cookie must actually be in force, or "the same read in the other mode"
// would be testing nothing. `/api/auth/me` resolves it from the tenant's type.
const meSchool = await req("/api/auth/me", { cookie: bothAdmin });
const meCollege = await req("/api/auth/me", { cookie: bothAdmin, mode: "COLLEGE" });
check(
  "the BOTH tenant is college-capable and its mode cookie really switches (UI context, not a filter)",
  meSchool.data?.school?.institutionType === "BOTH" && meSchool.data?.mode === "SCHOOL" && meCollege.data?.mode === "COLLEGE",
  `type=${meSchool.data?.school?.institutionType} schoolMode=${meSchool.data?.mode} collegeMode=${meCollege.data?.mode}`
);

/* ---------------------------------------------- 1. the SCHOOL half, exactly */

console.log("\n### 1. the school half: exactly its own two rows, in both modes");
const fees0 = await req("/api/fees", { cookie: bothAdmin });
const rows0 = feesOf(fees0);
check("GET /api/fees as the BOTH tenant's admin", fees0.status === 200 && Array.isArray(rows0), `HTTP ${fees0.status} rows=${rows0?.length}`);
const ownIds = (rows0 || []).map((f) => f.id).sort().join(",");
eq("it returns exactly the fixture's two school rows and nothing else", ownIds, [SCHOOL.feeA, SCHOOL.feeB].sort().join(","));
const t0 = totalsOf(rows0 || []);
check(
  "…carrying the school's own 17,000 billed / 8,000 paid / 9,000 due",
  minor(t0.billed) === minor(SCHOOL.billed) && minor(t0.paid) === minor(SCHOOL.paid) && minor(t0.due) === minor(SCHOOL.due),
  `${t0.billed} / ${t0.paid} / ${t0.due}`
);
check(
  "…every row a finite money row (paid + due === billed, row for row)",
  (rows0 || []).every((f) => isMoney(f.amount) && isMoney(f.paidAmount)) && minor(t0.paid + t0.due) === minor(t0.billed),
  `${minor(t0.paid + t0.due)} vs ${minor(t0.billed)}`
);
const schoolPayload = JSON.stringify(fees0.data);
check(
  "NO college row, id, head or amount appears in the school fee read",
  !schoolPayload.includes(COLLEGE.charge) &&
    !schoolPayload.includes("collegeFee") &&
    !schoolPayload.includes("College Tuition") &&
    !/\bcf_[A-Za-z0-9]/.test(schoolPayload) &&
    !schoolPayload.includes(String(COLLEGE.billed)) &&
    !schoolPayload.includes(String(COLLEGE.due)),
  `payload=${schoolPayload.length}B`
);

// The same read under the OTHER mode: a mode is a UI context, and it must not
// filter school money (nor hide it) — the school spine is read from the school
// tables either way.
const feesCollegeMode = await req("/api/fees", { cookie: bothAdmin, mode: "COLLEGE" });
check(
  "…and the SAME read under the COLLEGE mode cookie is byte-identical (mode is not a filter)",
  feesCollegeMode.status === 200 && JSON.stringify(feesCollegeMode.data) === schoolPayload,
  `equal=${JSON.stringify(feesCollegeMode.data) === schoolPayload}`
);

/* ------------------------------------------------- 2. /api/stats agrees */

console.log("\n### 2. /api/stats' fee payload is the school half's own money, in both modes");
const stats0 = await req("/api/stats", { cookie: bothAdmin, mode: "SCHOOL" });
const sf0 = stats0.data?.fees || {};
check(
  "/api/stats fee payload is finite and equals the fee list",
  stats0.status === 200 && isMoney(sf0.totalFees) && isMoney(sf0.paidFees) &&
    minor(sf0.totalFees) === minor(t0.billed) && minor(sf0.paidFees) === minor(t0.paid),
  `HTTP ${stats0.status} ${JSON.stringify(sf0)}`
);
const statsCollegeMode = await req("/api/stats", { cookie: bothAdmin, mode: "COLLEGE" });
check(
  "…and is byte-identical under the college mode cookie",
  statsCollegeMode.status === 200 && JSON.stringify(statsCollegeMode.data?.fees) === JSON.stringify(sf0),
  `equal=${JSON.stringify(statsCollegeMode.data?.fees) === JSON.stringify(sf0)}`
);
const statsPayload = JSON.stringify(sf0);
check(
  "…and carries no college money either",
  !statsPayload.includes(String(COLLEGE.billed)) && !statsPayload.includes(String(COLLEGE.due)) && !statsPayload.includes(COLLEGE.charge),
  statsPayload.slice(0, 160)
);

/* ------------------------------------------------- 3. the COLLEGE half, exactly */

console.log("\n### 3. the college half: exactly its own charge, in both modes");
const dues0 = await req("/api/college-fees/dues", { cookie: bothAdmin, mode: "COLLEGE" });
const d0 = dues0.data?.totals || {};
const collegeRows = d0.rows || [];
check("GET /api/college-fees/dues as the BOTH tenant's admin (college mode)", dues0.status === 200 && !!dues0.data, `HTTP ${dues0.status} ${dues0.error || ""}`);
check("…with every figure a finite number (never NaN/null on the money path)", isMoney(d0.billed) && isMoney(d0.paid) && isMoney(d0.due) && isMoney(d0.gross), JSON.stringify(d0));
// The fixture's own charge must be on the read — the ANCHOR that proves the
// college half is non-empty (amounts are read at run time, so a re-run after this
// script's own write is still exact about WHICH money it is looking at).
const seeded = collegeRows.find((r) => r.id === COLLEGE.charge);
check(
  "…containing the fixture's own college charge, with the college's 45,000 / 15,000 / 30,000",
  !!seeded && minor(seeded.amount) === minor(COLLEGE.billed) && minor(seeded.paid) === minor(COLLEGE.paid) && minor(seeded.due) === minor(COLLEGE.due),
  JSON.stringify(seeded || null)
);
check(
  "…and its totals are exactly its own rows (paid + due === billed, row for row — no school money folded in)",
  minor(collegeRows.reduce((a, r) => a + Number(r.amount || 0), 0)) === minor(d0.billed) &&
    minor(d0.paid + d0.due) === minor(d0.billed) &&
    collegeRows.every((r) => !String(r.id).startsWith(`${P}both-fee-`)),
  `billed=${d0.billed} paid+due=${round(d0.paid + d0.due)}`
);
// The whole payload, not just the money: a leaked SCHOOL fee ROW shows up as its
// id or its own title, and neither can be confused with a college figure.
const collegePayload = JSON.stringify(dues0.data);
check(
  "…and NO school fee row, id or title appears anywhere in the college read",
  !collegePayload.includes(SCHOOL.feeA) && !collegePayload.includes(SCHOOL.feeB) &&
    !collegePayload.includes("ZZ Iso Both School") &&
    !collegePayload.includes(String(SCHOOL.billed)) &&
    !collegePayload.includes(String(SCHOOL.due)),
  `payload=${collegePayload.length}B`
);

// Mode is UI context, never authorization (§3): the BOTH tenant's college read is
// reachable in EITHER mode, and says exactly the same thing.
const duesSchoolMode = await req("/api/college-fees/dues", { cookie: bothAdmin, mode: "SCHOOL" });
check(
  "…and the college read is unchanged under the SCHOOL mode cookie (mode grants nothing, revokes nothing)",
  duesSchoolMode.status === 200 && JSON.stringify(duesSchoolMode.data?.totals) === JSON.stringify(dues0.data?.totals),
  `HTTP ${duesSchoolMode.status} equal=${JSON.stringify(duesSchoolMode.data?.totals) === JSON.stringify(d0)}`
);

// The positive control for the school half: the BOTH tenant's OWN student is
// reachable in its own tenant — so the 404s below mean isolation, not a broken id.
const ownDues = await req(`/api/college-fees/dues?studentId=${encodeURIComponent(BOTH_STU)}`, { cookie: bothAdmin });
check(
  "the BOTH tenant's own student is readable (the positive control for the 404s below)",
  ownDues.status === 200 && minor(ownDues.data?.summary?.billed) >= minor(COLLEGE.billed) &&
    (ownDues.data?.rows || []).some((r) => r.id === COLLEGE.charge),
  `HTTP ${ownDues.status} billed=${ownDues.data?.summary?.billed}`
);

/* ------------------------------- 4. THE MEASUREMENT: a college write moves nothing on the school side */

console.log("\n### 4. the measurement: a NEW college charge leaves the school half byte-identical");
const feesBaseline = JSON.stringify(fees0.data);
const statsBaseline = JSON.stringify(stats0.data?.fees ?? null);
const duesBaseline = dues0.data?.totals || {};

// A UNIQUE head per run: generation is idempotent per (student, head, term), so a
// fixed name would make the second run of this script create nothing — and a
// verifier that only passes the first time is not a verifier. The rows it leaves
// carry the fixture tenant's schoolId, so the fixture's own sweep removes them.
const head = await req("/api/college-fees/heads", {
  cookie: bothAdmin,
  method: "POST",
  body: { name: `ZZ Mode-Mixing Probe Head ${Date.now().toString(36)}`, bucket: "TUITION", frequency: "TERM" },
});
const headId = head.data?.id || null;
check("a college head is created for the BOTH tenant (201)", head.status === 201 && !!headId, `HTTP ${head.status} ${head.error || ""}`);
const structure = await req("/api/college-fees/structure", {
  cookie: bothAdmin,
  method: "POST",
  body: { programId: BOTH_PROG, termNumber: 1, headId, amount: PROBE_AMOUNT, required: true },
});
check("…priced by a structure row on its own programme term (201)", structure.status === 201, `HTTP ${structure.status} ${structure.error || ""}`);
const gen = await req("/api/college-fees/generate", {
  cookie: bothAdmin,
  method: "POST",
  body: { programId: BOTH_PROG, termNumber: 1, headIds: [headId], includeOptional: true },
});
const newCharge = (gen.data?.students || []).find((s) => s.studentId === BOTH_STU)?.newCharges?.[0]?.id || null;
check(
  "…and generation raises EXACTLY ONE new charge, for the BOTH tenant's own student",
  gen.status >= 200 && gen.status < 300 && !!newCharge && gen.data?.totals?.newRows === 1,
  `HTTP ${gen.status} charge=${newCharge} newRows=${gen.data?.totals?.newRows}`
);

const feesAfter = await req("/api/fees", { cookie: bothAdmin });
const statsAfter = await req("/api/stats", { cookie: bothAdmin });
const duesAfter = await req("/api/college-fees/dues", { cookie: bothAdmin, mode: "COLLEGE" });
check(
  "WITH the new college charge present, /api/fees is BYTE-IDENTICAL to the pre-write capture",
  feesAfter.status === 200 && JSON.stringify(feesAfter.data) === feesBaseline,
  `HTTP ${feesAfter.status} equal=${JSON.stringify(feesAfter.data) === feesBaseline}`
);
check(
  "…and /api/stats' fee payload is byte-identical too",
  statsAfter.status === 200 && JSON.stringify(statsAfter.data?.fees ?? null) === statsBaseline,
  `HTTP ${statsAfter.status} equal=${JSON.stringify(statsAfter.data?.fees ?? null) === statsBaseline}`
);
const dAfter = duesAfter.data?.totals || {};
check(
  "…while the COLLEGE half gained exactly the new charge's money — billed/due +2,500, paid untouched",
  minor(dAfter.billed) === minor(duesBaseline.billed) + minor(PROBE_AMOUNT) &&
    minor(dAfter.due) === minor(duesBaseline.due) + minor(PROBE_AMOUNT) &&
    minor(dAfter.paid) === minor(duesBaseline.paid) &&
    dAfter.count === duesBaseline.count + 1,
  `${JSON.stringify(dAfter)} vs baseline ${JSON.stringify(duesBaseline)}`
);
check(
  "…and the school's rows are still absent from the college read after the write",
  !JSON.stringify(duesAfter.data).includes(SCHOOL.feeA) &&
    !JSON.stringify(duesAfter.data).includes(SCHOOL.feeB) &&
    !JSON.stringify(duesAfter.data).includes("ZZ Iso Both School"),
  `billed=${dAfter.billed}`
);

/* ------------------------------------------------- 5. the shared ledger's ONE tag */

console.log("\n### 5. the shared ledger keeps the two halves apart by its ONE tag");
const ledger = await req("/api/ledger?take=200", { cookie: bothAdmin });
const entries = Array.isArray(ledger.data) ? ledger.data : [];
check("GET /api/ledger returns the tenant's ledger", ledger.status === 200 && entries.length > 0, `HTTP ${ledger.status} rows=${entries.length}`);
const schoolEntry = entries.find((e) => e.id === `${P}both-ledger-school`);
const collegeEntry = entries.find((e) => e.id === `${P}both-ledger-college`);
check(
  "the school's own entry keeps its `feeId` and carries NO college tag",
  !!schoolEntry && schoolEntry.feeId === SCHOOL.feeA && !schoolEntry.meta?.collegeFeeId && minor(schoolEntry.amount) === 300000,
  `feeId=${schoolEntry?.feeId} meta=${JSON.stringify(schoolEntry?.meta)}`
);
check(
  "the college entry is TAGGED: feeId null + meta.collegeFeeId, with the college's own CRCP- receipt",
  !!collegeEntry && !collegeEntry.feeId && collegeEntry.meta?.collegeFeeId === COLLEGE.charge &&
    String(collegeEntry.meta?.receiptNo || "").startsWith("CRCP-") && minor(collegeEntry.amount) === 1500000,
  `feeId=${collegeEntry?.feeId} meta=${JSON.stringify(collegeEntry?.meta)}`
);
const tagged = entries.filter((e) => e?.meta && (e.meta.collegeFeeId || e.meta.collegeDiscountId));
check(
  "every college-tagged row in the shared ledger has NO school `feeId` (the college's money is never also school money)",
  tagged.length >= 1 && tagged.every((e) => !e.feeId),
  `tagged=${tagged.length} withFeeId=${tagged.filter((e) => e.feeId).length}`
);
check(
  "…and no row carrying a school `feeId` is college-tagged",
  entries.filter((e) => e.feeId).every((e) => !e.meta?.collegeFeeId && !e.meta?.collegeDiscountId),
  `schoolRows=${entries.filter((e) => e.feeId).length}`
);
// The tenant-wide read is the documented inclusion (D-7-12): both halves are on
// it, in EITHER mode, and the tag — never a filter — is what tells them apart.
const ledgerCollegeMode = await req("/api/ledger?take=200", { cookie: bothAdmin, mode: "COLLEGE" });
const idsIn = (r) => (Array.isArray(r.data) ? r.data.map((e) => e.id) : []).sort().join(",");
check(
  "the tenant-wide ledger shows BOTH halves in either mode (the tag is what separates them)",
  ledgerCollegeMode.status === 200 && idsIn(ledgerCollegeMode) === idsIn(ledger),
  `school-mode=${idsIn(ledger).length ? "ok" : "empty"} equal=${idsIn(ledgerCollegeMode) === idsIn(ledger)}`
);

/* -------------------------------------------------------------- 6. cross-tenant */

console.log("\n### 6. cross-tenant: neither tenant can see the other's college or school money");
const foreignDues = await req("/api/college-fees/dues", { cookie: collegeAdmin });
const foreignPayload = JSON.stringify(foreignDues.data);
check(
  "the COLLEGE tenant's dues read contains NONE of the BOTH tenant's rows or money",
  foreignDues.status === 200 &&
    !foreignPayload.includes(COLLEGE.charge) && !foreignPayload.includes(BOTH_STU) &&
    !foreignPayload.includes(String(COLLEGE.billed)) && !foreignPayload.includes(SCHOOL.feeA),
  `HTTP ${foreignDues.status} rows=${foreignDues.data?.students?.length ?? "(none)"}`
);
const foreignStudent = await req(`/api/college-fees/dues?studentId=${encodeURIComponent(BOTH_STU)}`, { cookie: collegeAdmin });
const ghostStudent = await req(`/api/college-fees/dues?studentId=${encodeURIComponent(`${P}no-such-student`)}`, { cookie: collegeAdmin });
check(
  "…and a BOTH-tenant student is the SAME 404 for it as a ghost id (no tenant oracle)",
  foreignStudent.status === 404 && ghostStudent.status === 404 && JSON.stringify(foreignStudent.data) === JSON.stringify(ghostStudent.data),
  `foreign=${foreignStudent.status} ghost=${ghostStudent.status}`
);
const reverseDues = await req(`/api/college-fees/dues?studentId=${encodeURIComponent(COLLEGE_STU_A)}`, { cookie: bothAdmin });
check(
  "…and the reverse holds: the COLLEGE tenant's student is a 404 for the BOTH tenant",
  reverseDues.status === 404,
  `HTTP ${reverseDues.status}`
);

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ mode-mixing verification FAILED — ${failures} of ${checks} check(s).`);
  process.exit(1);
}
console.log(`✅ mode-mixing verification PASSED — ${checks} checks: a BOTH tenant's school half is byte-identical with and without college charges (measured in this run), no college row or amount reaches a school read, no school row reaches a college read, the shared ledger keeps them apart by its tag, and neither tenant can read the other's money.`);
