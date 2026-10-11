#!/usr/bin/env node
/**
 * verify-college-fees-api.mjs — Phase 7c: the college FEE API over HTTP.
 *
 * Runs against the COLLEGE fixture tenant (scripts/isolation-fixture.mjs) and
 * proves the whole 7c contract of `docs/COLLEGE-DECISIONS.md` §24.7:
 *
 *   • the role matrix (D-7-18): admin-level + ACCOUNTANT write, REGISTRAR reads
 *     only, and TEACHER / GUARDIAN / STUDENT are refused in BOTH directions even
 *     though the school's own `feePayment` module would admit them;
 *   • the 403/400/404 matrix: a SCHOOL tenant is gated with zero data, a foreign
 *     tenant's student/charge is NOT FOUND, a wrong-BRANCH caller is refused, and
 *     every refusal is bracketed by a DOCUMENT COUNT so "it wrote nothing" is
 *     counted rather than assumed (§17 Q2);
 *   • unit/basis validation lands in 7a and is REFUSED at the API: `PER_CREDIT`
 *     by name, an unknown unit and an unknown basis by name, and a term the
 *     programme does not have;
 *   • the duplicate `(programId, termNumber, headId)` is a VISIBLE 409;
 *   • generation is IDEMPOTENT: a commit writes the derived rows, a re-run writes
 *     none, and a late change (an approved registration, or a new structure row)
 *     TOPS UP only what is missing;
 *   • money is never typed: a charge is only ever derived, a payment is an integer
 *     number of MINOR UNITS, and an over-payment is refused by name;
 *   • TWO SIMULTANEOUS PAYMENTS that together exceed the balance cannot both
 *     succeed (the D-7-12 transaction);
 *   • awards follow the school's propose/approve flow: a proposer may not approve
 *     their own award, an ACCOUNTANT may not approve at all, a decided award is a
 *     409, an approved award reduces only NEW charges, and the money it waives
 *     reaches the SHARED ledger as a DISCOUNT entry;
 *   • every college payment appends ONE `PAYMENT` ledger entry with `feeId: null`
 *     and `meta.collegeFeeId`, and uses the college's own `CRCP-…` receipt sequence;
 *   • the tenant's college fee config is ONE row (a save can never create a second);
 *   • and NO college fee row appears in any school fee read (`/api/fees`, `/api/stats`).
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-college-fees-api.mjs
 * Needs: node scripts/isolation-fixture.mjs create
 *
 * The script RESETS the COLLEGE tenant's college fee rows before it runs so it
 * leaves no residue, and the fixture is shared with the isolation harnesses, whose
 * counts must stay exactly as they are.
 *
 * **RUN IT ONCE PER APP START.** The reset deletes rows through firebase-admin,
 * which reaches Firestore directly and cannot invalidate the APP's in-process read
 * cache (`src/lib/db.ts`, ~30 s + grace). A second run inside the same app process
 * can therefore still see a row the first run deleted. That is the ordinary
 * harness rule — an emulator wipe restarts the app — and the two things a stale
 * read could poison are neutralised anyway: the percentage award names the head it
 * discounts, so an award left by an earlier run can never match a later run's head,
 * and every probe that needs a known registration brings its OWN (per-run student
 * on program B) rather than trusting the fixture's row.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { requireEmulator } from "./lib/guard.mjs";
import { installHostFetch } from "./lib/hostfetch.mjs";

installHostFetch();
requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const APP_HOST = `127.0.0.1:${PORT}`;
const HOST = `school.localhost:${PORT}`;

/** Fixture id prefix (isolation-fixture.mjs). */
const P = "zziso-";
const C1 = `${P}college`;
const PROG_A = `${P}col-prog-a`;
const PROG_B = `${P}col-prog-b`;
const STU_A = `${P}col-stu-a`;
const STU_B = `${P}col-stu-b`;
const REG_A = `${P}col-reg-a`;
const COURSE_A = `${P}col-course-a`;
const BRANCH_A = `${P}col-br-a`;
const BRANCH_B = `${P}col-br-b`;

const TRACK = new URL(".qa-fixtures.json", import.meta.url);
if (!existsSync(TRACK)) {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(1);
}
const CRED = JSON.parse(readFileSync(TRACK, "utf8")).creds || {};
for (const key of ["collegeAdmin", "collegeBranchAdmin", "collegeRegistrar", "collegeAccountant", "bothAdmin", "admin", "teacher"]) {
  if (!CRED[key]) {
    console.error(`❌ Track file lacks ${key} — re-run: node scripts/isolation-fixture.mjs clean && create`);
    process.exit(1);
  }
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const countOf = (n) => n;
const COLLEGE_COLS = ["collegeFeeHeads", "collegeFeeStructures", "collegeFees", "collegeFeeConfigs", "collegeDiscounts"];

async function req(path, { cookie, host = HOST, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Host: host, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, body, data: body?.data ?? null, error: body?.error ?? null };
}
async function login(identifier, password, host = HOST) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
    signal: AbortSignal.timeout(60000),
  });
  if (res.status !== 200) throw new Error(`login ${identifier}: HTTP ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
const post = (path, body, cookie, opts = {}) => req(path, { cookie, method: "POST", body: JSON.stringify(body), ...opts });
const patch = (path, body, cookie, opts = {}) => req(path, { cookie, method: "PATCH", body: JSON.stringify(body), ...opts });
const del = (path, cookie, opts = {}) => req(path, { cookie, method: "DELETE", ...opts });

/* --------------------------------------------------------------- reset */

/** How many `collegeFees` rows this tenant holds — every bracket's basis. */
async function chargeCount(schoolId = C1) {
  const snap = await db.collection("collegeFees").where("schoolId", "==", schoolId).get();
  return countOf(snap.size);
}
/** The whole college fee spine for one tenant — the reset's and the bracket's basis. */
async function spineCount(schoolId = C1) {
  let n = 0;
  for (const col of COLLEGE_COLS) {
    const snap = await db.collection(col).where("schoolId", "==", schoolId).get();
    n += snap.size;
  }
  return n;
}
async function bracket(label, before, schoolId = C1) {
  const after = await spineCount(schoolId);
  check(`${label} — writes NOTHING (college fee spine ${before} → ${after})`, before === after, `delta=${after - before}`);
}

/**
 * Delete this tenant's college fee rows, plus the ledger entries this verifier's
 * payments left behind (`meta.collegeFeeId` is the tag D-7-12 gives them). A
 * verifier must run from a clean state, and the fixture is shared: nothing here
 * touches a school collection.
 */
async function resetCollegeFees(schoolId) {
  for (const col of COLLEGE_COLS) {
    const snap = await db.collection(col).where("schoolId", "==", schoolId).get();
    for (const d of snap.docs) await d.ref.delete();
  }
  // The verifier's own ledger residue: a PAYMENT entry carries `meta.collegeFeeId`
  // and a DISCOUNT entry `meta.collegeDiscountId` (D-7-12/D-7-13 tag them so they
  // can be told apart — and so they can be cleaned up here).
  const ledger = await db.collection("ledger").where("schoolId", "==", schoolId).get();
  for (const d of ledger.docs) {
    const meta = d.data()?.meta;
    if (meta && (typeof meta.collegeFeeId === "string" || typeof meta.collegeDiscountId === "string")) {
      await d.ref.delete();
    }
  }
}

/**
 * Put the fixture's registration back to PENDING. The COURSE-unit half of the
 * generation test APPROVES it, and the fixture is shared and only created once, so
 * a repeat run must undo that itself — the verifier has to be re-runnable from the
 * same fixture without a wipe.
 */
async function resetRegistration() {
  await db.collection("courseRegistrations").doc(REG_A).set(
    { status: "PENDING", decidedById: null, decidedAt: null, requestedById: `${P}user-col-admin` },
    { merge: true }
  );
}

/**
 * Forget this verifier's own COURSE-unit probe leftovers from an earlier run.
 *
 * The probe's registration is created THROUGH the API (so its id is random and the
 * shim invalidates the app's cache), and an APPROVED registration can never be
 * withdrawn — so the cleanup is by STUDENT: the probe's own students are
 * prefix-tagged, and any non-fixture registration hanging off the fixture student
 * on program B is this verifier's own residue. Without this a re-run would count
 * last run's approvals as "approved registrations" and bill for them.
 */
async function resetCourseProbe() {
  const regs = await db.collection("courseRegistrations").where("schoolId", "==", C1).get();
  for (const d of regs.docs) {
    const sid = String(d.data()?.studentId || "");
    const fixture = d.id === REG_A || d.id === `${P}col-reg-b`;
    if (sid.startsWith(`${P}feeprobe-stu-`) || (!fixture && sid === STU_B)) await d.ref.delete();
  }
  const students = await db.collection("students").where("schoolId", "==", C1).get();
  for (const d of students.docs) {
    if (d.id.startsWith(`${P}feeprobe-stu-`)) await d.ref.delete();
  }
}

console.log(`\n=== Phase 7c college fees API (${BASE})`);

const collegeAdmin = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
const collegeBranchAdmin = await login("zz-iso-college-br-admin@test.local", CRED.collegeBranchAdmin);
const collegeRegistrar = await login("zz-iso-college-registrar@test.local", CRED.collegeRegistrar);
const collegeAccountant = await login("zz-iso-college-accountant@test.local", CRED.collegeAccountant);
const bothAdmin = await login("zz-iso-both-admin@test.local", CRED.bothAdmin);
const schoolAdmin = await login("zz-iso-admin@test.local", CRED.admin);

console.log("\n### set-up — a clean college fee spine, and the school-fee baseline");
await resetCollegeFees(C1);
await resetCollegeFees(`${P}both`);
await resetRegistration();
await resetCourseProbe();
check("the COLLEGE tenant's college fee spine starts empty (5 collections)", (await spineCount(C1)) === 0, `rows=${await spineCount(C1)}`);
check(
  "…and the fixture's course registration is back to PENDING (the verifier is re-runnable)",
  (await db.collection("courseRegistrations").doc(REG_A).get()).data()?.status === "PENDING",
  "registration reset"
);

// The school-invisibility baseline: a college fee row must never move these.
const feesBefore = await req("/api/fees", { cookie: collegeAdmin });
const statsBefore = await req("/api/stats", { cookie: collegeAdmin });
const feeBaseline = JSON.stringify(feesBefore.data);
const statsFeeBaseline = JSON.stringify(statsBefore.body?.data?.fees ?? statsBefore.body?.fees ?? null);
check(
  "a school fee read baseline was captured (the list and /api/stats' fee payload)",
  feesBefore.status === 200 && statsBefore.status === 200,
  `fees=${feesBefore.status} stats=${statsBefore.status}`
);

/* ---------------------------------------------------------------- heads */

console.log("\n### the fee heads (D-7-2/D-7-5): admin + ACCOUNTANT write, validation is 7a's");
let headA = null;
let headB = null;
{
  const created = await post("/api/college-fees/heads", { name: "ZZ Tuition", bucket: "TUITION", frequency: "TERM", note: "per term" }, collegeAdmin);
  headA = created.data?.id || null;
  check(
    "POST /api/college-fees/heads creates a head (201) with the school's own shape",
    created.status === 201 && !!headA && created.data?.bucket === "TUITION" && created.data?.frequency === "TERM" && created.data?.active !== false,
    `HTTP ${created.status} ${JSON.stringify(created.error)}`
  );

  const list = await req("/api/college-fees/heads", { cookie: collegeAdmin });
  check(
    "GET lists it back, sorted, with no class pricing",
    list.status === 200 && (list.data || []).some((h) => h.id === headA) && list.data?.[0]?.amounts === undefined,
    `HTTP ${list.status} rows=${(list.data || []).length}`
  );

  const junky = await post("/api/college-fees/heads", { name: "ZZ Junk", bucket: "nope", frequency: "nope", dueDay: 99 }, collegeAdmin);
  headB = junky.data?.id || null;
  check(
    "a junk bucket/frequency falls back (OTHER/MONTHLY) and dueDay clamps to 28 — never a throw",
    junky.status === 201 && junky.data?.bucket === "OTHER" && junky.data?.frequency === "MONTHLY" && junky.data?.dueDay === 28,
    `HTTP ${junky.status} ${JSON.stringify([junky.data?.bucket, junky.data?.frequency, junky.data?.dueDay])}`
  );

  const named = await post("/api/college-fees/heads", { bucket: "TUITION" }, collegeAdmin);
  check("a head with no name is refused (400) and says what to fix", named.status === 400 && /name/i.test(named.error || ""), `HTTP ${named.status} ${JSON.stringify(named.error)}`);

  const renamed = await patch("/api/college-fees/heads", { id: headB, name: "ZZ Junk Renamed", dueDay: 5 }, collegeAdmin);
  check(
    "PATCH merges onto the stored row (the bucket survives, the patch is applied)",
    renamed.status === 200 && renamed.data?.name === "ZZ Junk Renamed" && renamed.data?.dueDay === 5 && renamed.data?.bucket === "OTHER",
    `HTTP ${renamed.status} ${JSON.stringify(renamed.data && { n: renamed.data.name, b: renamed.data.bucket, d: renamed.data.dueDay })}`
  );

  const byAccountant = await post("/api/college-fees/heads", { name: "ZZ Library Fine", bucket: "LIBRARY_FINE", frequency: "ONE_TIME" }, collegeAccountant);
  check(
    "an ACCOUNTANT may WRITE a head (the one staff role the allow-list admits, D-7-18)",
    byAccountant.status === 201 && !!byAccountant.data?.id,
    `HTTP ${byAccountant.status} ${JSON.stringify(byAccountant.error)}`
  );
  if (byAccountant.data?.id) await del(`/api/college-fees/heads?id=${encodeURIComponent(byAccountant.data.id)}`, collegeAdmin);

  const byRegistrar = await post("/api/college-fees/heads", { name: "ZZ Registrar Head" }, collegeRegistrar);
  check(
    "a REGISTRAR may NOT write a head (403 — v1 access is read-only for the registrar)",
    byRegistrar.status === 403,
    `HTTP ${byRegistrar.status}`
  );
  const regRead = await req("/api/college-fees/heads", { cookie: collegeRegistrar });
  check("…but may READ the heads (200) — the positive control", regRead.status === 200, `HTTP ${regRead.status}`);
}

/* ------------------------------------------- structure + unit/basis rules */

console.log("\n### the structure (D-7-6…D-7-8): one row per (programme, term, head), and the unit/basis rules are 7a's");
let rowA = null;
{
  const created = await post(
    "/api/college-fees/structure",
    { programId: PROG_A, termNumber: 1, headId: headA, amount: 1000, note: "term fee" },
    collegeAdmin
  );
  rowA = created.data?.id || null;
  check(
    "POST creates a structure row (201) with unit STUDENT and basis FLAT by default",
    created.status === 201 && !!rowA && created.data?.unit === "STUDENT" && created.data?.basis === "FLAT" && created.data?.amount === 1000,
    `HTTP ${created.status} ${JSON.stringify(created.error)}`
  );

  // The owner's binding answer: PER_CREDIT and an unknown unit/basis are REFUSED,
  // by 7a's own validation (no second copy of the rules).
  const perCredit = await post("/api/college-fees/structure", { programId: PROG_A, termNumber: 1, headId: headB, amount: 500, basis: "PER_CREDIT" }, collegeAdmin);
  check(
    "a PER_CREDIT row is refused (400) with 7a's pinned reason",
    perCredit.status === 400 && /per-credit-hour pricing is not in v1/i.test(perCredit.error || ""),
    `HTTP ${perCredit.status} ${JSON.stringify(perCredit.error)}`
  );
  const junkUnit = await post("/api/college-fees/structure", { programId: PROG_A, termNumber: 1, headId: headB, amount: 500, unit: "PER_HOUR" }, collegeAdmin);
  check(
    "an UNKNOWN unit is refused (400), naming the allowed values",
    junkUnit.status === 400 && /STUDENT or COURSE/.test(junkUnit.error || ""),
    `HTTP ${junkUnit.status} ${JSON.stringify(junkUnit.error)}`
  );
  const junkBasis = await post("/api/college-fees/structure", { programId: PROG_A, termNumber: 1, headId: headB, amount: 500, basis: "CREDIT" }, collegeAdmin);
  check(
    "an UNKNOWN basis is refused (400), naming the allowed values",
    junkBasis.status === 400 && /FLAT or PER_CREDIT/.test(junkBasis.error || ""),
    `HTTP ${junkBasis.status} ${JSON.stringify(junkBasis.error)}`
  );
  const badTerm = await post("/api/college-fees/structure", { programId: PROG_A, termNumber: 3, headId: headB, amount: 500 }, collegeAdmin);
  check(
    "a term the programme does not have is refused (400) — programme A has two terms",
    badTerm.status === 400 && /term/i.test(badTerm.error || ""),
    `HTTP ${badTerm.status} ${JSON.stringify(badTerm.error)}`
  );
  const dup = await post("/api/college-fees/structure", { programId: PROG_A, termNumber: 1, headId: headA, amount: 999 }, collegeAdmin);
  check(
    "the duplicate (programme, term, head) is a VISIBLE 409 — never a silent overwrite",
    dup.status === 409 && /already priced/i.test(dup.error || ""),
    `HTTP ${dup.status} ${JSON.stringify(dup.error)}`
  );
  const stillOne = (await db.collection("collegeFeeStructures").where("schoolId", "==", C1).get()).docs
    .map((d) => d.data())
    .filter((r) => r.programId === PROG_A && r.headId === headA);
  check(
    "…and the stored amount is NOT overwritten (1000, not 999)",
    stillOne.length === 1 && stillOne[0].amount === 1000,
    `rows=${stillOne.length} amount=${stillOne[0]?.amount}`
  );

  const read = await req(`/api/college-fees/structure?programId=${encodeURIComponent(PROG_A)}&termNumber=1`, { cookie: collegeAdmin });
  check(
    "GET returns the rows with both totals (SUM of rows, and the cadence-adjusted bill)",
    read.status === 200 && read.data?.rowCount === 1 && read.data?.rowsTotal === 1000 && read.data?.billTotal === 1000 && Array.isArray(read.data?.heads),
    `HTTP ${read.status} rowsTotal=${read.data?.rowsTotal} billTotal=${read.data?.billTotal}`
  );
}

/* -------------------------------------------------------------- generate */

console.log("\n### generation (D-7-10): dryRun writes nothing, a commit is idempotent, and a late change tops up");
{
  const before = await spineCount();
  const dry = await post("/api/college-fees/generate", { programId: PROG_A, termNumber: 1, dryRun: true }, collegeAdmin);
  check(
    "a dryRun previews the exact rows (1 student × 1 row) and writes NOTHING",
    dry.status === 200 && dry.data?.dryRun === true && dry.data?.totals?.newRows === 1 && dry.data?.written === 0,
    `HTTP ${dry.status} rows=${dry.data?.totals?.newRows} written=${dry.data?.written}`
  );
  await bracket("the dry run", before);

  const commit = await post("/api/college-fees/generate", { programId: PROG_A, termNumber: 1 }, collegeAdmin);
  check(
    "the commit writes the derived row for the one student on roll in term 1",
    commit.status === 200 && commit.data?.written === 1 && commit.data?.totals?.amount === 1000,
    `HTTP ${commit.status} written=${commit.data?.written} amount=${commit.data?.totals?.amount}`
  );
  const after = await spineCount();
  check("…and exactly ONE document was written", after === before + 1, `${before} → ${after}`);

  const stored = (await db.collection("collegeFees").where("schoolId", "==", C1).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const derived = stored.find((c) => c.studentId === STU_A && c.headId === headA);
  const expectedId = `cf_${STU_A}_${headA}_1_1`;
  check(
    "…whose id is 7a's deterministic cf_ id, and whose paidAmount is written EXPLICITLY as 0",
    !!derived && derived.id === expectedId && derived.paidAmount === 0 && derived.status === "UNPAID" && typeof derived.amount === "number",
    `id=${derived?.id} paid=${JSON.stringify(derived?.paidAmount)} status=${derived?.status}`
  );

  const rerun = await post("/api/college-fees/generate", { programId: PROG_A, termNumber: 1 }, collegeAdmin);
  check(
    "a re-run creates NO duplicates (written 0, the existing row counted, not touched)",
    rerun.status === 200 && rerun.data?.written === 0 && rerun.data?.totals?.existingRows === 1 && rerun.data?.totals?.newRows === 0,
    `HTTP ${rerun.status} written=${rerun.data?.written} existing=${rerun.data?.totals?.existingRows}`
  );
  await bracket("the idempotent re-run", after);

  // A COURSE-unit head bills once per APPROVED registration — nothing while the
  // registration is still PENDING (D-7-6's dated note).
  //
  // The probe brings its OWN registration, on program B and under fresh per-run
  // ids: the fixture's registration is one the APP may have cached from an earlier
  // run of another verifier, and a raw reset cannot reach another process's cache.
  // Fresh ids have no cache entry to go stale, so this half is deterministic on a
  // re-run against the same fixture — which is the harness rule.
  const runId = Date.now().toString(36);
  const probeStudent = `${P}feeprobe-stu-${runId}`;
  await db.collection("students").doc(probeStudent).set({
    id: probeStudent, schoolId: C1, branchId: BRANCH_B, name: "ZZ Fee Probe Student",
    admissionNo: `ZZFP-${runId}`, programId: PROG_B, termNumber: 1, active: true, createdAt: new Date(),
  });
  const probeReg = await post("/api/course-registrations", { studentId: probeStudent, courseId: `${P}col-course-b` }, collegeAdmin);
  const probeRegId = probeReg.data?.id || null;
  check(
    "a fresh PENDING registration exists for the COURSE-unit probe (201)",
    probeReg.status === 201 && !!probeRegId && probeReg.data?.status === "PENDING",
    `HTTP ${probeReg.status} ${JSON.stringify(probeReg.error)}`
  );

  const courseHead = await post("/api/college-fees/heads", { name: "ZZ Lab", bucket: "OTHER", frequency: "TERM" }, collegeAdmin);
  const courseHeadId = courseHead.data?.id;
  const courseRow = await post(
    "/api/college-fees/structure",
    { programId: PROG_B, termNumber: 1, headId: courseHeadId, amount: 200, unit: "COURSE", required: false },
    collegeAdmin
  );
  check(
    "a COURSE-unit row can be created (201) — the unit is stored, never priced",
    courseRow.status === 201 && courseRow.data?.unit === "COURSE",
    `HTTP ${courseRow.status} ${JSON.stringify(courseRow.error)}`
  );
  const courseGen = { programId: PROG_B, termNumber: 1, includeOptional: true, headIds: [courseHeadId] };
  const noReg = await post("/api/college-fees/generate", courseGen, collegeAdmin);
  check(
    "with NO approved registration, the COURSE head bills nothing and says so",
    noReg.status === 200 &&
      noReg.data?.totals?.newRows === 0 &&
      (noReg.data?.students || []).every((s) => s.newCharges.length === 0) &&
      (noReg.data?.students || []).some((s) => (s.refused || []).some((r) => /no approved course registration/i.test(r.reason || ""))),
    `HTTP ${noReg.status} new=${noReg.data?.totals?.newRows} refused=${JSON.stringify((noReg.data?.students || []).map((s) => s.refused))}`
  );

  // …and approving the registration TOPS UP exactly that one charge.
  const approved = await patch(`/api/course-registrations/${probeRegId}`, { status: "APPROVED" }, collegeAdmin);
  check("the probe registration is approved (200)", approved.status === 200 && approved.data?.status === "APPROVED", `HTTP ${approved.status} ${JSON.stringify(approved.error)}`);
  const topUp = await post("/api/college-fees/generate", courseGen, collegeAdmin);
  const topUpRow = (topUp.data?.students || []).find((s) => s.studentId === probeStudent)?.newCharges?.[0];
  check(
    "a late approval tops up exactly ONE new course charge — the earlier rows are untouched",
    topUp.status === 200 && topUp.data?.written === 1 && topUp.data?.totals?.newRows === 1 && topUpRow?.amount === 200 && topUpRow?.unit === "COURSE",
    `HTTP ${topUp.status} written=${topUp.data?.written} amount=${topUp.data?.totals?.amount} row=${JSON.stringify(topUpRow && { a: topUpRow.amount, u: topUpRow.unit })}`
  );
}

/* --------------------------------------------------------------- payments */

console.log("\n### payments (D-7-12): integer minor units, over-payment refused, the ledger entry tagged");
let tuitionCharge = null;
{
  await resetCollegeFees(C1);
  headA = null;
  // Rebuild a minimal, known spine: one head, one row, one generated charge.
  const h = await post("/api/college-fees/heads", { name: "ZZ Tuition", bucket: "TUITION", frequency: "TERM" }, collegeAdmin);
  headA = h.data?.id;
  await post("/api/college-fees/structure", { programId: PROG_A, termNumber: 1, headId: headA, amount: 1000 }, collegeAdmin);
  const gen = await post("/api/college-fees/generate", { programId: PROG_A, termNumber: 1 }, collegeAdmin);
  tuitionCharge = gen.data?.students?.[0]?.newCharges?.[0]?.id || null;
  check("a fresh spine generated exactly one 1000 charge to pay", gen.status === 200 && !!tuitionCharge, `charge=${tuitionCharge}`);

  const badAmounts = [0, -5, 1.5, "abc", undefined];
  let all400 = true;
  for (const bad of badAmounts) {
    const r = await post("/api/college-fees/payments", { chargeId: tuitionCharge, amountMinor: bad, method: "CASH" }, collegeAdmin);
    if (r.status !== 400) all400 = false;
  }
  check("amountMinor must be a positive WHOLE number of minor units — 0, negative, fractional, junk and missing are all 400", all400);

  const badMethod = await post("/api/college-fees/payments", { chargeId: tuitionCharge, amountMinor: 100, method: "BITCOIN" }, collegeAdmin);
  check("an unknown payment method is refused (400) naming the allowed ones", badMethod.status === 400 && /CASH/.test(badMethod.error || ""), `HTTP ${badMethod.status}`);

  const partial = await post("/api/college-fees/payments", { chargeId: tuitionCharge, amountMinor: 40000, method: "CASH" }, collegeAdmin);
  check(
    "a partial payment of 400.00 is accepted (201) and leaves the charge PARTIAL",
    partial.status === 201 && partial.data?.paidAmount === 400 && partial.data?.due === 600 && partial.data?.status === "PARTIAL",
    `HTTP ${partial.status} ${JSON.stringify(partial.data && { paid: partial.data.paidAmount, due: partial.data.due, st: partial.data.status })}`
  );
  check(
    "…and its receipt comes from the college's own CRCP- sequence (never the school's RCP-)",
    typeof partial.data?.receiptNo === "string" && partial.data.receiptNo.startsWith("CRCP-"),
    `receipt=${partial.data?.receiptNo}`
  );

  const over = await post("/api/college-fees/payments", { chargeId: tuitionCharge, amountMinor: 70000, method: "CASH" }, collegeAdmin);
  check(
    "an OVER-payment is refused (409) by name — never clamped into a credit",
    over.status === 409 && /exceeds the outstanding/i.test(over.error || ""),
    `HTTP ${over.status} ${JSON.stringify(over.error)}`
  );

  const settle = await post("/api/college-fees/payments", { chargeId: tuitionCharge, amountMinor: 60000, method: "BANK", refNo: "ZZCF-SETTLE" }, collegeAdmin);
  check(
    "paying the exact remainder settles the charge (201, PAID, due 0)",
    settle.status === 201 && settle.data?.status === "PAID" && settle.data?.due === 0,
    `HTTP ${settle.status} due=${settle.data?.due} status=${settle.data?.status}`
  );

  const entries = (await db.collection("ledger").where("schoolId", "==", C1).get()).docs
    .map((d) => d.data())
    .filter((e) => e.kind === "PAYMENT" && e.meta && e.meta.collegeFeeId);
  check(
    "every college payment appended ONE shared-ledger PAYMENT entry, feeId null and meta.collegeFeeId set",
    entries.length === 2 && entries.every((e) => !e.feeId && e.meta.collegeFeeId === tuitionCharge && e.status === "CONFIRMED" && Number.isFinite(e.amount)),
    `entries=${entries.length} ${JSON.stringify(entries.map((e) => e.amount))}`
  );
  check(
    "…and the ledger entries live in the ONE ledger the school reads (no college money collection)",
    entries.length > 0 && entries.every((e) => e.schoolId === C1),
    `n=${entries.length}`
  );
}

/* ------------------------------------------------------- the CONCURRENCY proof */

console.log("\n### two simultaneous payments that together exceed the balance (the D-7-12 transaction)");
{
  const h = await post("/api/college-fees/heads", { name: "ZZ Concurrency", bucket: "OTHER", frequency: "TERM" }, collegeAdmin);
  await post("/api/college-fees/structure", { programId: PROG_A, termNumber: 1, headId: h.data?.id, amount: 1000, required: false }, collegeAdmin);
  const gen = await post("/api/college-fees/generate", { programId: PROG_A, termNumber: 1, includeOptional: true, headIds: [h.data?.id] }, collegeAdmin);
  const chargeId = gen.data?.students?.[0]?.newCharges?.[0]?.id || null;
  check("a second, unpaid 1000 charge exists for the race", !!chargeId, `charge=${chargeId}`);

  // 600 + 600 > 1000: only one may land.
  const [a, b] = await Promise.all([
    post("/api/college-fees/payments", { chargeId, amountMinor: 60000, method: "CASH" }, collegeAdmin),
    post("/api/college-fees/payments", { chargeId, amountMinor: 60000, method: "CASH" }, collegeAdmin),
  ]);
  const okCount = [a, b].filter((r) => r.status === 201).length;
  const refused = [a, b].filter((r) => r.status === 409).length;
  check(
    "exactly ONE of the two 600.00 payments against a 1000.00 charge succeeds (the other is a 409)",
    okCount === 1 && refused === 1,
    `statuses=${JSON.stringify([a.status, b.status])} errors=${JSON.stringify([a.error, b.error])}`
  );
  const after = await db.collection("collegeFees").doc(chargeId).get();
  const paid = after.data()?.paidAmount;
  check(
    "…and the stored paidAmount is exactly 600.00 — never the double payment, never over the billed amount",
    paid === 600,
    `paidAmount=${JSON.stringify(paid)}`
  );
}

/* ------------------------------------------------------------------ dues */

console.log("\n### dues (D-7-14): finite, derived, and never negative");
{
  const dues = await req(`/api/college-fees/dues?studentId=${encodeURIComponent(STU_A)}&programId=${encodeURIComponent(PROG_A)}`, { cookie: collegeAdmin });
  const s = dues.data?.summary;
  check(
    "a student's dues summary is finite, the rows carry a derived status, and due === billed − paid",
    dues.status === 200 && s && Number.isFinite(s.billed) && Number.isFinite(s.paid) && Number.isFinite(s.due) &&
      s.due === Math.max(0, s.billed - s.paid) && (dues.data?.rows || []).every((r) => ["UNPAID", "PARTIAL", "PAID"].includes(r.status)),
    `HTTP ${dues.status} billed=${s?.billed} paid=${s?.paid} due=${s?.due} status=${s?.status}`
  );
  const ghost = await req(`/api/college-fees/dues?studentId=${encodeURIComponent(P + "no-such-student")}`, { cookie: collegeAdmin });
  check("a ghost student is a 404 (never a 403 oracle)", ghost.status === 404, `HTTP ${ghost.status}`);

  const term = await req(`/api/college-fees/dues?programId=${encodeURIComponent(PROG_A)}&termNumber=1`, { cookie: collegeAdmin });
  check(
    "the programme/term dues read lists one row per student with the same arithmetic",
    term.status === 200 && Array.isArray(term.data?.students) && term.data.students.length === 1 && term.data.students[0].studentId === STU_A &&
      Number.isFinite(term.data?.totals?.due),
    `HTTP ${term.status} students=${term.data?.students?.length} due=${term.data?.totals?.due}`
  );
}

/* -------------------------------------------------------------- discounts */

console.log("\n### awards (D-7-13): propose/approve, no self-approval, an accountant may not approve");
let awardId = null;
{
  await resetCollegeFees(C1);
  const h = await post("/api/college-fees/heads", { name: "ZZ Tuition", bucket: "TUITION", frequency: "TERM" }, collegeAdmin);
  headA = h.data?.id;
  await post("/api/college-fees/structure", { programId: PROG_A, termNumber: 1, headId: headA, amount: 1000 }, collegeAdmin);
  const genA = await post("/api/college-fees/generate", { programId: PROG_A, termNumber: 1 }, collegeAdmin);
  // The branch probe later needs a real BRANCH-A charge id to prove the positive control.
  tuitionCharge = genA.data?.students?.[0]?.newCharges?.find((c) => c.headId === headA)?.id || tuitionCharge;

  // The head the award will discount is created BEFORE the award, because the award
  // names it (see the header note on re-runs: an award from an earlier run names a
  // head that no longer exists, so it can never reach a later run's charges).
  const h2 = await post("/api/college-fees/heads", { name: "ZZ Exam", bucket: "EXAM", frequency: "TERM" }, collegeAdmin);
  await post("/api/college-fees/structure", { programId: PROG_A, termNumber: 1, headId: h2.data?.id, amount: 400 }, collegeAdmin);

  // The ACCOUNTANT proposes (the §24.1 "accountant proposes" half).
  // The award names the HEAD it discounts (as well as the programme and term), so
  // it only ever reaches rows raised against that head — which is also what makes a
  // re-run safe: an award an earlier run left behind names a head that no longer
  // exists, so it can never silently halve this run's charges.
  const proposed = await post(
    "/api/college-fees/discounts",
    { kind: "PERCENT", percent: 50, headIds: [h2.data?.id], programId: PROG_A, termNumber: 1, note: "ZZ half fee" },
    collegeAccountant
  );
  awardId = proposed.data?.id || null;
  check(
    "an ACCOUNTANT may PROPOSE an award (201, PROPOSED, proposedBy recorded)",
    proposed.status === 201 && !!awardId && proposed.data?.status === "PROPOSED" && !!proposed.data?.proposedBy && !proposed.data?.approvedBy,
    `HTTP ${proposed.status} ${JSON.stringify(proposed.error)}`
  );

  const selfApprove = await patch("/api/college-fees/discounts", { id: awardId, state: "APPROVED" }, collegeAccountant);
  check(
    "…but may NOT approve it (403 — only an admin-level role decides)",
    selfApprove.status === 403,
    `HTTP ${selfApprove.status} ${JSON.stringify(selfApprove.error)}`
  );

  // The admin proposes a second award and may not approve their OWN proposal.
  const ownProposal = await post("/api/college-fees/discounts", { kind: "FIXED", amountPerHead: 100, headIds: [headA], programId: PROG_A, termNumber: 1 }, collegeAdmin);
  const ownId = ownProposal.data?.id;
  const ownApprove = await patch("/api/college-fees/discounts", { id: ownId, state: "APPROVED" }, collegeAdmin);
  check(
    "no one may approve their OWN proposal (403 — the four-eyes rule of the school's flow)",
    ownApprove.status === 403 && /never by the person who proposed/i.test(ownApprove.error || ""),
    `HTTP ${ownApprove.status} ${JSON.stringify(ownApprove.error)}`
  );

  const approved = await patch("/api/college-fees/discounts", { id: awardId, state: "APPROVED" }, collegeAdmin);
  check(
    "a DIFFERENT admin approves it (200, APPROVED, approvedBy recorded)",
    approved.status === 200 && approved.data?.status === "APPROVED" && !!approved.data?.approvedBy,
    `HTTP ${approved.status} ${JSON.stringify(approved.error)}`
  );

  const redecide = await patch("/api/college-fees/discounts", { id: awardId, state: "REJECTED" }, collegeAdmin);
  check("re-deciding a decided award is a VISIBLE 409", redecide.status === 409, `HTTP ${redecide.status} ${JSON.stringify(redecide.error)}`);

  const foreignHead = await post("/api/college-fees/discounts", { kind: "FIXED", amountPerHead: 100, headIds: [`${P}no-such-head`] }, collegeAdmin);
  check("a FIXED award naming a head that is not this tenant's is refused (400)", foreignHead.status === 400, `HTTP ${foreignHead.status}`);

  const badPercent = await post("/api/college-fees/discounts", { kind: "PERCENT", percent: 150 }, collegeAdmin);
  check("a percentage outside 1..100 is refused (400)", badPercent.status === 400, `HTTP ${badPercent.status}`);

  // The award reduces only what is raised AFTER it takes effect: the head created
  // above now bills at half, and the waived money reaches the shared ledger.
  const gen = await post("/api/college-fees/generate", { programId: PROG_A, termNumber: 1 }, collegeAdmin);
  const newRow = gen.data?.students?.[0]?.newCharges?.find((c) => c.headId === h2.data?.id);
  check(
    "an APPROVED 50% award halves only the NEW charge (400 → 200, discount 200 recorded)",
    gen.status === 200 && newRow?.grossAmount === 400 && newRow?.discount === 200 && newRow?.amount === 200,
    `HTTP ${gen.status} ${JSON.stringify(newRow && { gross: newRow.grossAmount, discount: newRow.discount, amount: newRow.amount })}`
  );

  const discountEntries = (await db.collection("ledger").where("schoolId", "==", C1).get()).docs
    .map((d) => d.data())
    .filter((e) => e.kind === "DISCOUNT" && e.meta && e.meta.collegeDiscountId);
  check(
    "the waived money reached the SHARED ledger as a DISCOUNT entry (the ledger and the statement agree)",
    discountEntries.length === 1 && discountEntries[0].amount === 200 && discountEntries[0].meta.collegeDiscountId === awardId,
    `entries=${discountEntries.length} ${JSON.stringify(discountEntries.map((e) => e.amount))}`
  );

  const list = await req("/api/college-fees/discounts", { cookie: collegeAdmin });
  check(
    "GET lists the awards (the decided one and the admin's own proposal)",
    list.status === 200 && (list.data || []).some((a) => a.id === awardId && a.status === "APPROVED"),
    `HTTP ${list.status} rows=${(list.data || []).length}`
  );
}

/* ------------------------------------------------------------------ config */

console.log("\n### the college's own config (D-7-3): ONE row per tenant, never feeSetting");
{
  const before = await req("/api/college-fees/config", { cookie: collegeAdmin });
  check(
    "GET returns the shipped defaults (an empty channel list, BDT) when nothing is stored",
    before.status === 200 && Array.isArray(before.data?.channels) && before.data?.currency === "BDT",
    `HTTP ${before.status} currency=${before.data?.currency}`
  );
  const saved = await patch(
    "/api/college-fees/config",
    { channels: [{ kind: "CASH", label: "Accounts office", methods: ["CASH"] }], paymentNote: "Pay at the college counter.", currency: "BDT" },
    collegeAdmin
  );
  check(
    "PATCH saves the channels and the note (200)",
    saved.status === 200 && saved.data?.channels?.length === 1 && saved.data?.paymentNote === "Pay at the college counter.",
    `HTTP ${saved.status} ${JSON.stringify(saved.error)}`
  );
  const rows = await db.collection("collegeFeeConfigs").where("schoolId", "==", C1).get();
  check("…and exactly ONE config row exists for the tenant (a deterministic id)", rows.size === 1, `rows=${rows.size}`);
  const after = await req("/api/college-fees/config", { cookie: collegeAdmin });
  check("GET reflects the saved config", after.status === 200 && after.data?.channels?.length === 1, `HTTP ${after.status}`);
}

/* --------------------------------------------------- the refusal matrix */

console.log("\n### the 403/400/404 matrix and the role probe, everything bracketed by a document count");
{
  const before = await spineCount();

  // A SCHOOL tenant is GATED on every route — 403 with zero data.
  const schoolCases = [
    ["GET", "/api/college-fees/heads"],
    ["GET", "/api/college-fees/structure"],
    ["GET", "/api/college-fees/charges"],
    ["GET", "/api/college-fees/dues"],
    ["GET", "/api/college-fees/discounts"],
    ["GET", "/api/college-fees/config"],
  ];
  let schoolAll = true;
  for (const [, path] of schoolCases) {
    const r = await req(path, { cookie: schoolAdmin });
    if (r.status !== 403 || r.data !== null) schoolAll = false;
  }
  check("a SCHOOL tenant is refused (403, zero data) on all six college fee reads", schoolAll);
  const schoolWrites = [
    await post("/api/college-fees/heads", { name: "ZZ School Head" }, schoolAdmin),
    await post("/api/college-fees/structure", { programId: PROG_A, termNumber: 1, headId: headA, amount: 1 }, schoolAdmin),
    await post("/api/college-fees/generate", { programId: PROG_A, termNumber: 1 }, schoolAdmin),
    await post("/api/college-fees/payments", { chargeId: "cf_x", amountMinor: 1, method: "CASH" }, schoolAdmin),
    await post("/api/college-fees/discounts", { kind: "PERCENT", percent: 10 }, schoolAdmin),
    await patch("/api/college-fees/config", { currency: "USD" }, schoolAdmin),
  ];
  check("…and on all six college fee writes", schoolWrites.every((r) => r.status === 403), `statuses=${JSON.stringify(schoolWrites.map((r) => r.status))}`);
  await bracket("every SCHOOL-tenant refusal", before);

  // Unauthenticated.
  const anon = await req("/api/college-fees/heads");
  check("an unauthenticated read is 401 (not 403, not 200)", anon.status === 401, `HTTP ${anon.status}`);

  // A foreign tenant's student/charge is NOT FOUND — never a 403 oracle.
  const foreignDues = await req(`/api/college-fees/dues?studentId=${encodeURIComponent(STU_A)}`, { cookie: bothAdmin });
  const ghostDues = await req(`/api/college-fees/dues?studentId=${encodeURIComponent(P + "no-such-student")}`, { cookie: bothAdmin });
  check(
    "a foreign tenant sees another tenant's student as the SAME 404 as a ghost (no oracle)",
    foreignDues.status === 404 && ghostDues.status === 404 && JSON.stringify(foreignDues.body) === JSON.stringify(ghostDues.body),
    `foreign=${foreignDues.status} ghost=${ghostDues.status}`
  );
  const foreignCharge = await post("/api/college-fees/payments", { chargeId: `cf_${STU_A}_${headA}_1_1`, amountMinor: 100, method: "CASH" }, bothAdmin);
  check("…and another tenant's charge is NOT FOUND (404) on a payment", foreignCharge.status === 404, `HTTP ${foreignCharge.status}`);
  const foreignPatch = await patch("/api/college-fees/structure", { id: `${P}no-such-row`, amount: 1 }, collegeAdmin);
  check("a ghost structure row is a 404", foreignPatch.status === 404, `HTTP ${foreignPatch.status}`);

  // Branch confinement. The fixture's BRANCH_ADMIN is confined to branch A, so
  // branch B is the foreign branch: the probe needs a branch-B spine that exists
  // for real (created BEFORE the bracket, so the denials below change no count).
  const bHead = await post("/api/college-fees/heads", { name: "ZZ Branch B Head", branchId: BRANCH_B, frequency: "TERM" }, collegeAdmin);
  const bRow = await post(
    "/api/college-fees/structure",
    { programId: PROG_B, termNumber: 1, headId: bHead.data?.id, amount: 300 },
    collegeAdmin
  );
  const bGen = await post("/api/college-fees/generate", { programId: PROG_B, termNumber: 1 }, collegeAdmin);
  const bChargeId = bGen.data?.students?.[0]?.newCharges?.[0]?.id || null;
  check(
    "the college admin can price and bill BRANCH B (the branch probe's real setup)",
    bHead.status === 201 && bHead.data?.branchId === BRANCH_B && bRow.status === 201 && bGen.status === 200 && !!bChargeId,
    `head=${bHead.status} row=${bRow.status} gen=${bGen.status} charge=${bChargeId}`
  );

  const branchBefore = await spineCount();

  const bHeads = await req("/api/college-fees/heads", { cookie: collegeBranchAdmin });
  const bHeadsRows = bHeads.data || [];
  check(
    "a BRANCH-scoped admin's head list holds its own branch's head and NO other branch's",
    bHeads.status === 200 && bHeadsRows.some((h) => h.id === headA) && !bHeadsRows.some((h) => h.id === bHead.data?.id),
    `HTTP ${bHeads.status} rows=${bHeadsRows.length} hasOwn=${bHeadsRows.some((h) => h.id === headA)}`
  );
  const ownStructure = await req(`/api/college-fees/structure?programId=${encodeURIComponent(PROG_A)}&termNumber=1`, { cookie: collegeBranchAdmin });
  check("…and CAN read its own branch's programme (200 — the positive control)", ownStructure.status === 200, `HTTP ${ownStructure.status}`);
  const foreignStructure = await req(`/api/college-fees/structure?programId=${encodeURIComponent(PROG_B)}&termNumber=1`, { cookie: collegeBranchAdmin });
  check("…but is refused (403) on another branch's programme", foreignStructure.status === 403, `HTTP ${foreignStructure.status}`);
  const foreignRow = await patch("/api/college-fees/structure", { id: bRow.data?.id, amount: 1 }, collegeBranchAdmin);
  check("…and cannot edit another branch's structure row (403)", foreignRow.status === 403, `HTTP ${foreignRow.status}`);
  const foreignHead = await del(`/api/college-fees/heads?id=${encodeURIComponent(bHead.data?.id)}`, collegeBranchAdmin);
  check("…and cannot delete another branch's head (403)", foreignHead.status === 403, `HTTP ${foreignHead.status}`);
  const foreignPay = await post("/api/college-fees/payments", { chargeId: bChargeId, amountMinor: 100, method: "CASH" }, collegeBranchAdmin);
  check("…and cannot pay another branch's charge (403)", foreignPay.status === 403, `HTTP ${foreignPay.status} ${JSON.stringify(foreignPay.error)}`);
  const foreignDuesForBranch = await req(`/api/college-fees/dues?studentId=${encodeURIComponent(STU_B)}`, { cookie: collegeBranchAdmin });
  check("…and cannot read another branch's student dues (403)", foreignDuesForBranch.status === 403, `HTTP ${foreignDuesForBranch.status}`);
  const ownPay = await post("/api/college-fees/payments", { chargeId: tuitionCharge, amountMinor: 100, method: "CASH" }, collegeBranchAdmin);
  check("…but CAN pay its own branch's charge (201 — the positive control)", ownPay.status === 201, `HTTP ${ownPay.status} ${JSON.stringify(ownPay.error)}`);
  await bracket("every cross-branch refusal", branchBefore);

  // The role probe: TEACHER, GUARDIAN and STUDENT are refused BOTH ways, on their
  // own portals. The probe users are written raw under the app's deterministic id.
  // The bracket is taken HERE, after the branch probe's legitimate setup, so it
  // measures the probes and nothing else.
  const probeBefore = await spineCount();
  const PW = "Probe@12345";
  const sha1 = (s) => createHash("sha1").update(s).digest("hex");
  const runId = Date.now().toString(36);
  const probeUsers = ["TEACHER", "GUARDIAN", "STUDENT"].map((role) => {
    const email = `zziso-feeprobe-${role.toLowerCase()}+${runId}@test.local`;
    return { role, email, id: `u_${sha1(email)}` };
  });
  for (const u of probeUsers) {
    await db.collection("users").doc(u.id).set({
      id: u.id, email: u.email, name: `ZZ Fee Probe ${u.role}`, role: u.role,
      schoolId: C1, active: true, passwordHash: bcrypt.hashSync(PW, 4), createdAt: new Date(),
    });
  }
  await db.collection("students").doc(STU_A).set({ userId: probeUsers[2].id, guardianUserId: probeUsers[1].id }, { merge: true });

  const sessions = {};
  for (const u of probeUsers) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { Host: APP_HOST, "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: u.email, password: PW }),
      signal: AbortSignal.timeout(60000),
    });
    sessions[u.role] = (res.headers.get("set-cookie") || "").split(";")[0];
    if (res.status !== 200) check(`the probe ${u.role} can sign in`, false, `HTTP ${res.status}`);
  }

  // EVERY handler of the segment is probed, not a sample of four: a denied role
  // must get a 403 from all EIGHT routes, reads and writes alike. The bodies are
  // deliberately invalid (a ghost id, a missing field), so a handler that wrongly
  // ADMITS a teacher is still caught by its 400/404 — and nothing is written.
  const HANDLERS = [
    ["GET", "/api/college-fees/config"],
    ["PATCH", "/api/college-fees/config", {}],
    ["GET", "/api/college-fees/heads"],
    ["POST", "/api/college-fees/heads", {}],
    ["PATCH", "/api/college-fees/heads", { id: `${P}no-such-head`, name: "x" }],
    ["DELETE", "/api/college-fees/heads?id=" + encodeURIComponent(`${P}no-such-head`)],
    ["GET", "/api/college-fees/structure"],
    ["POST", "/api/college-fees/structure", {}],
    ["PATCH", "/api/college-fees/structure", { id: `${P}no-such-row`, amount: 1 }],
    ["DELETE", "/api/college-fees/structure?id=" + encodeURIComponent(`${P}no-such-row`)],
    ["POST", "/api/college-fees/generate", { programId: PROG_A, termNumber: 1 }],
    ["GET", "/api/college-fees/charges"],
    ["GET", `/api/college-fees/dues?studentId=${encodeURIComponent(STU_A)}`],
    ["POST", "/api/college-fees/payments", { chargeId: `cf_${STU_A}_${headA}_1_1`, amountMinor: 100, method: "CASH" }],
    ["GET", "/api/college-fees/discounts"],
    ["POST", "/api/college-fees/discounts", {}],
    ["PATCH", "/api/college-fees/discounts", { id: `${P}no-such-award`, state: "APPROVED" }],
  ];
  let matrix = true;
  for (const u of probeUsers) {
    const cookie = sessions[u.role];
    const leaked = [];
    for (const [method, path, body] of HANDLERS) {
      const r = await req(path, { cookie, host: APP_HOST, method, body: body === undefined ? undefined : JSON.stringify(body) });
      if (r.status !== 403 || r.data !== null) leaked.push(`${method} ${path.split("?")[0]}=${r.status}`);
    }
    check(
      `a ${u.role} is refused (403, zero data) by ALL ${HANDLERS.length} college-fee handlers — every route, every method`,
      leaked.length === 0,
      leaked.length ? `reached: ${leaked.slice(0, 4).join(", ")}` : `0/${HANDLERS.length} reached`
    );
    if (leaked.length) matrix = false;
  }
  check("…so no teacher/guardian/student can read or write any college money (the stop-and-report condition holds)", matrix);
  await bracket("every denied-role probe", probeBefore);
}

/* --------------------------------------------- school-fee invisibility */

console.log("\n### no college fee row appears in a school fee read (Q3, the 7c half)");
{
  const feesAfter = await req("/api/fees", { cookie: collegeAdmin });
  const statsAfter = await req("/api/stats", { cookie: collegeAdmin });
  const statsFeeAfter = JSON.stringify(statsAfter.body?.data?.fees ?? statsAfter.body?.fees ?? null);
  check(
    "the school fee list is byte-identical with the college spine populated",
    feesAfter.status === 200 && JSON.stringify(feesAfter.data) === feeBaseline,
    `HTTP ${feesAfter.status} equal=${JSON.stringify(feesAfter.data) === feeBaseline}`
  );
  check(
    "/api/stats' fee payload is byte-identical too",
    statsAfter.status === 200 && statsFeeAfter === statsFeeBaseline,
    `HTTP ${statsAfter.status} equal=${statsFeeAfter === statsFeeBaseline}`
  );
  const rawFees = JSON.stringify(feesAfter.body);
  check(
    "…and neither a college charge id (cf_…) nor a college fee head appears anywhere in that read",
    !/cf_|collegeFee/.test(rawFees),
    `bytes=${rawFees.length}`
  );
  const heads = await db.collection("collegeFeeHeads").where("schoolId", "==", C1).get();
  const schoolCats = await db.collection("feeCategories").get();
  check(
    "the college heads live in their OWN collection — no school `feeCategories` row was written",
    heads.size > 0 && !schoolCats.docs.some((d) => (d.data()?.name || "").startsWith("ZZ ")),
    `collegeHeads=${heads.size} schoolCats=${schoolCats.size}`
  );
}

/* -------------------------------------------------------------------- end */

console.log("");
console.log(`RESULT: ${checks - failures}/${checks} checks passed`);
if (failures) {
  console.log(`❌ COLLEGE FEES API FAILED — ${failures} of ${checks} check(s) failed.`);
  process.exit(1);
}
console.log(
  `✅ COLLEGE FEES API OK — ${checks} check(s): the eight /api/college-fees routes are gated (requireCollege → the D-7-18 allow-list → writeGuard), ` +
    `the test/reports show PER_CREDIT + an unknown unit/basis refused by 7a's own validation, the (programme, term, head) duplicate is a visible 409, ` +
    `generation is idempotent and tops up, a payment is integer minor units with over-payment refused and two racing payments cannot both land, ` +
    `awards follow propose/approve with no self-approval and post their waived money to the shared ledger, and no college row leaks into a school fee read.`
);
