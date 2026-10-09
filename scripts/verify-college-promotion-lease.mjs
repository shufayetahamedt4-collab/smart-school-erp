#!/usr/bin/env node
/**
 * Phase 6-pre 2 — the whole-programme ladder's LEASE, proved over HTTP
 * (docs/COLLEGE-DECISIONS.md §21).
 *
 * Phase 5d-2 recorded, as a KNOWN LIMITATION (D-5d2-7), that two ladder runs on the
 * same programme could double-advance a cohort: `src/lib/db.ts` had no create-only
 * and no preconditioned write, so nothing could claim a programme for the duration of
 * a run. 6-pre 2 adds exactly that primitive (`prisma.$claim`, a real Firestore
 * transaction) and the ladder now claims a per-`(school, programme)` row before it
 * reads its first cohort and releases it in a `finally`.
 *
 * This script runs over HTTP against the COLLEGE fixture tenant
 * (`scripts/isolation-fixture.mjs`) and proves:
 *
 *   • a run TAKES the lease and RELEASES it — the row exists afterwards, its
 *     `expiresAtMs` is cleared and its `status` says `OK`, so the NEXT run is
 *     allowed (the run-after-run semantics `verify-college-promotion-api.mjs` pins
 *     are UNCHANGED);
 *   • a HELD lease (a live, unexpired row) makes the next run a **409 with ZERO
 *     writes**, proved twice: a per-student term/status snapshot AND a tenant
 *     document count bracketing the refused request;
 *   • an EXPIRED lease is TAKEN OVER, not honoured — so a crashed run cannot wedge a
 *     programme — and the takeover reuses the SAME row (the lease is per-programme);
 *   • the lease is PER PROGRAMME: while one programme's lease is held, another
 *     programme's run in the same school still returns 200;
 *   • an authorization refusal (403) takes NO lease — the claim happens after every
 *     authorization step;
 *   • a FORCED mid-run failure (the §20 fault seam) still answers the structured 500
 *     and still RELEASES the lease, recording `PARTIAL` + the remaining terms; the
 *     documented recovery (`POST /api/college-promotion`, descending) still works and
 *     still moves every student exactly once;
 *   • two TRULY CONCURRENT runs (both fired without awaiting) give exactly ONE 200
 *     and ONE 409, and every student advanced EXACTLY once;
 *   • after a PARTIAL run the ladder is REFUSED (409, zero writes) with the
 *     outstanding terms named, an unauthorized caller still gets 403, another
 *     programme is unaffected, and finishing those terms with the single-position
 *     route strikes them off and UNBLOCKS the ladder — with every student advanced
 *     exactly once (Phase 6-pre 3);
 *   • a run LONGER than its own lease window is kept alive by the RENEWAL (the
 *     heartbeat before every step and every ≤400-op slice) and a rival fired while it
 *     renews is refused 409 — so the TTL covers one slice, not a whole run
 *     (Phase 6-pre 4);
 *   • a run that LOSES its lease mid-flight aborts with the structured 500 and writes
 *     nothing further (no double-advance), and its STALE finalise does NOT clear the
 *     successor's live lease (Phase 6-pre 4);
 *   • an UNREADABLE run state fails CLOSED — 503, no lease, no cohort read, ZERO
 *     writes — while "no row at all" is still simply "not blocked" (Phase 6-pre 4);
 *   • a failure on the FIRST step records EVERY term as outstanding (and names the
 *     term it really stopped at), so the work list can never silently drop the top
 *     term (Phase 6-pre 4);
 *   • an OUTSTANDING term whose cohort is EMPTY can still be finished: the
 *     single-position apply strikes it off and moves nobody, so the wedge is closed
 *     (Phase 6-pre 5);
 *   • the audited ABANDON hatch: 403 for an unauthorized caller, 400 without a long
 *     enough reason, 409 on an OK or LIVE run, 200 on PARTIAL — moving nobody, writing
 *     exactly one audit row, and leaving a row that does NOT block the ladder
 *     (Phase 6-pre 5);
 *   • a programme SHRINK reconciles the work list to the new term count (and the
 *     remaining empty terms then finish it), and a programme DELETE removes the run row
 *     (Phase 6-pre 5);
 *   • cleanup leaves no `zzls-` row and no `promotionRuns` row for its programmes.
 *
 * Phase 6-pre 4 uses the SAME temp-file seam as the §20 fault injection, extended with
 * lease timing/failure switches (`leaseTtlMs`, `noRenew`, `stepDelayMs`,
 * `stealAfterSlice`, `failBlockRead`). It is gated exactly like the fault seam (a
 * production build ignores it, and the values come from a file in the OS temp directory
 * — never from a request), and the file is removed by this script.
 *
 * The ladder's tenant/branch isolation checks deliberately stay in
 * `verify-college-promotion-api.mjs` (D11), so those established counts are
 * untouched.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-college-promotion-lease.mjs
 * Needs the isolation fixture:  node scripts/isolation-fixture.mjs create
 *
 * Creates and cleans up ALL of its own rows (an ACCOUNTANT user, five throwaway
 * programmes and their students). It never edits a fixture row, and it never runs
 * the ladder on a fixture programme.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { requireEmulator } from "./lib/guard.mjs";

requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const HOST = `school.localhost:${PORT}`;
/** Fixture id prefix (isolation-fixture.mjs). */
const P = "zziso-";
/** Our own id prefix for every row this verifier creates. */
const M = "zzls-";

const TRACK = new URL(".qa-fixtures.json", import.meta.url);
if (!existsSync(TRACK)) {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(1);
}
const CRED = JSON.parse(readFileSync(TRACK, "utf8")).creds || {};
if (!CRED.collegeAdmin) {
  console.error("❌ Track file lacks college credentials — re-run: node scripts/isolation-fixture.mjs clean && create");
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();
const RUNS = db.collection("promotionRuns");

/**
 * The §20 fault seam: a file in the OS temp directory naming a programme and a term.
 * Inert in production and unreachable from a request, so it is the only way to force
 * a deterministic mid-run failure.
 */
const FAULT_FILE = join(tmpdir(), "smart-school-qa-ladder-fault.json");
const injectFault = (programId, term, message = `qa-injected lease fault (${M})`) =>
  writeFileSync(FAULT_FILE, JSON.stringify({ programId, term, message }));
/**
 * The Phase 6-pre 4 switches, written into the SAME seam file and gated the same way:
 * `leaseTtlMs` (a short lease window), `stepDelayMs` (a slow step, so a run can outlive
 * its window while still renewing), `stealAfterSlice` (plant a foreign live lease after
 * the Nth slice), `failBlockRead` (make the run state unreadable). One writer, so the
 * file always holds exactly the switches the check below intends.
 */
const writeSeam = (spec) => writeFileSync(FAULT_FILE, JSON.stringify(spec));
const clearFault = () => rmSync(FAULT_FILE, { force: true });

/* ------------------------------------------------------------ fixture ids */
const COLLEGE = `${P}college`;
const DEPT_A = `${P}col-dept-a`;
const BRANCH_A = `${P}col-br-a`;
/** The OTHER branch — the one the fixture's BRANCH_ADMIN is NOT scoped to (6-pre 5). */
const BRANCH_B = `${P}col-br-b`;

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/* ------------------------------------------------------------------ HTTP */
async function req(path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Host: HOST, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null };
}
async function login(identifier, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { Host: HOST, "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
    signal: AbortSignal.timeout(60000),
  });
  if (res.status !== 200) throw new Error(`login ${identifier}: HTTP ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
const post = (path, body, cookie) => req(path, { cookie, method: "POST", body: JSON.stringify(body) });
/** Run the whole-programme ladder for one programme. */
const ladderPost = (programId, cookie) => post("/api/college-promotion/ladder", { programId }, cookie);

const collegeAdmin = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
/** The fixture's BRANCH_ADMIN, scoped to BRANCH_A — used to prove BRANCH confinement. */
const collegeBranchAdmin = await login("zz-iso-college-br-admin@test.local", CRED.collegeBranchAdmin);

const stamp = Date.now();

/* ------------------------------------------------- tracked rows + helpers */
const created = { programs: [], students: [], users: [], programIdsForAudit: [] };

async function makeProgram(tag, durationYears, branchId = BRANCH_A) {
  const r = await post("/api/programs", {
    name: `${M}Program ${tag} ${stamp}`, code: `${M}P-${tag}-${stamp}`,
    departmentId: DEPT_A, degreeLevel: "HSC", durationYears, termSystem: "YEARLY", branchId,
  }, collegeAdmin);
  if (r.data?.id) {
    created.programs.push(r.data.id);
    created.programIdsForAudit.push(r.data.id);
  }
  return r.data?.id || null;
}

/** A student row written RAW — the shape the students route writes (as in 5b/5d). */
async function makeStudent(tag, { programId, termNumber, status = "ACTIVE" }) {
  const id = `${M}stu-${tag}-${stamp}`;
  await db.collection("students").doc(id).set({
    id, schoolId: COLLEGE, branchId: BRANCH_A, name: `${M}Student ${tag} ${stamp}`,
    admissionNo: `${M}ADM-${tag}-${stamp}`, programId, termNumber,
    status, active: true, createdAt: new Date().toISOString(),
  });
  created.students.push(id);
  return id;
}

const readStudent = async (id) => (await db.collection("students").doc(id).get()).data() || {};

/** A term+status fingerprint of every student this verifier created. */
async function snapshot(ids) {
  const out = {};
  for (const id of ids) {
    const d = await readStudent(id);
    out[id] = `${d.termNumber}|${d.status}`;
  }
  return out;
}
const sameSnapshot = (a, b, ids) => ids.every((id) => a[id] === b[id]);

/** Document counts scoped to THIS tenant — the "wrote NOTHING" proof. */
async function tenantDocCounts() {
  const counts = {};
  for (const col of ["students", "programs", "promotionRuns"]) {
    counts[col] = (await db.collection(col).where("schoolId", "==", COLLEGE).get()).size;
  }
  const audits = await db.collection("auditLogs").where("schoolId", "==", COLLEGE).get();
  counts["auditLogs(not LOGIN)"] = audits.docs.filter((d) => d.data().action !== "LOGIN").length;
  return counts;
}
const sameCounts = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

/** FINISH one position with the single-position route (idempotent, D2/D3). */
const applyTerm = (programId, termNumber, cookie = collegeAdmin) =>
  post("/api/college-promotion", { programId, fromTermNumber: termNumber }, cookie);

/** The ladder's own audit rows for a programme (for the ABANDON proof). */
async function auditsFor(programId) {
  const snap = await db.collection("auditLogs").where("entityId", "==", programId).get();
  return snap.docs.map((d) => d.data()).filter((r) => r.action === "COLLEGE_PROMOTION");
}

/**
 * ABANDON a programme's unfinished run (Phase 6-pre 5) — the same route as the run,
 * with `abandonRun: true`. Kept as a helper so every case reads identically.
 */
const abandonRun = (programId, body, cookie = collegeAdmin) =>
  post("/api/college-promotion/ladder", { programId, abandonRun: true, ...body }, cookie);

/** The programme's ONE lease row, or null when it has never run. */
async function runRow(programId) {
  const snap = await RUNS.where("programId", "==", programId).get();
  if (!snap.size) return null;
  const d = snap.docs[0];
  return { id: d.id, ...d.data() };
}
/** Plant a lease state on the row directly (simulating a run that holds, or held). */
async function setExpiry(programId, expiresAtMs) {
  const row = await runRow(programId);
  if (!row) throw new Error(`no promotionRuns row for ${programId}`);
  await RUNS.doc(row.id).update({ expiresAtMs });
  return row.id;
}

/* ------------------------------------------------------------------- set-up */
console.log(`\n=== set-up (${BASE})`);

const PROG_OK = await makeProgram("ok", 2);       // a straight run + release
const PROG_HELD = await makeProgram("held", 2);   // a HELD lease refuses the next run
const PROG_OTHER = await makeProgram("other", 2); // per-programme scope, while HELD is held
const PROG_GUARD = await makeProgram("guard", 2); // a 403 must not take a lease
const PROG_FAIL = await makeProgram("fail", 3);   // the forced-failure release
check("five throwaway programmes were created (201)", !!PROG_OK && !!PROG_HELD && !!PROG_OTHER && !!PROG_GUARD && !!PROG_FAIL, `${PROG_OK} / ${PROG_HELD} / ${PROG_OTHER} / ${PROG_GUARD} / ${PROG_FAIL}`);

// 2-term programmes: one advance (1 → 2) and one graduation (2 → ALUMNI).
const K1 = await makeStudent("ok-1", { programId: PROG_OK, termNumber: 1 });
const K2 = await makeStudent("ok-2", { programId: PROG_OK, termNumber: 2 });
const H1 = await makeStudent("held-1", { programId: PROG_HELD, termNumber: 1 });
const H2 = await makeStudent("held-2", { programId: PROG_HELD, termNumber: 2 });
const O1 = await makeStudent("other-1", { programId: PROG_OTHER, termNumber: 1 });
const O2 = await makeStudent("other-2", { programId: PROG_OTHER, termNumber: 2 });
const G1 = await makeStudent("guard-1", { programId: PROG_GUARD, termNumber: 1 });
const F1 = await makeStudent("fail-1", { programId: PROG_FAIL, termNumber: 1 });
const F2 = await makeStudent("fail-2", { programId: PROG_FAIL, termNumber: 2 });
const F3 = await makeStudent("fail-3", { programId: PROG_FAIL, termNumber: 3 });
check("ten cohort students were written", created.students.length === 10, `${created.students.length} row(s)`);
check("…and NO programme has a lease row before any run (the row is created BY a run)", !(await runRow(PROG_OK)) && !(await runRow(PROG_FAIL)));

/* ------------------------------------------------------------------ section 1 */
console.log("\n### a run takes the lease, then releases it (so the NEXT run is allowed)");
{
  const run = await ladderPost(PROG_OK, collegeAdmin);
  check("POST the whole ladder → 200", run.status === 200, `HTTP ${run.status} ${run.error || ""}`);
  check(
    "…and the cohorts moved as before: one advanced to term 2, one graduated",
    (await readStudent(K1)).termNumber === 2 && (await readStudent(K2)).status === "ALUMNI",
    `k1=${(await readStudent(K1)).termNumber} k2=${(await readStudent(K2)).status}`
  );

  const row = await runRow(PROG_OK);
  check("…the run LEFT a lease row for the programme", !!row, row ? `id=${row.id}` : "none");
  check(
    "…carrying the identity the claim recorded (schoolId, programme, owner, acquiredAt)",
    row?.schoolId === COLLEGE && row?.programId === PROG_OK && "ownerId" in row && !!row?.acquiredAt,
    `school=${row?.schoolId} program=${row?.programId} owner=${row?.ownerId} acquiredAt=${row?.acquiredAt}`
  );
  check(
    "…and the lease is RELEASED: expiresAtMs cleared and the status says OK",
    row?.expiresAtMs === 0 && row?.status === "OK" && !!row?.finishedAt,
    `expiresAtMs=${row?.expiresAtMs} status=${row?.status} finishedAt=${row?.finishedAt}`
  );
  check(
    "…with the per-step breakdown recorded on the row (terms 1 and 2)",
    Array.isArray(row?.completed) &&
      row.completed.map((s) => s.fromTermNumber).sort().join(",") === "1,2" &&
      row.completed.length === 2,
    JSON.stringify(row?.completed?.map((s) => s.fromTermNumber) || null)
  );

  const again = await ladderPost(PROG_OK, collegeAdmin);
  check(
    "…so a SECOND run immediately after is still allowed (200) — the run-after-run semantics are unchanged",
    again.status === 200,
    `HTTP ${again.status} ${again.error || ""}`
  );
  check(
    "…and it advanced each surviving student one more step (the run is not a no-op)",
    (await readStudent(K1)).status === "ALUMNI",
    `k1=${(await readStudent(K1)).status}`
  );
}

/* ------------------------------------------------------------------ section 2 */
console.log("\n### a HELD lease refuses the next run with ZERO writes");
{
  // Give the programme a lease row the way a real run does: run it once. That run
  // releases the row, so the next step can plant a LIVE lease on it — exactly the
  // state a second, in-flight run would leave behind.
  const warm = await ladderPost(PROG_HELD, collegeAdmin);
  check(
    "the programme ran once, creating its lease row (and releasing it)",
    warm.status === 200 && !!(await runRow(PROG_HELD)) && (await runRow(PROG_HELD))?.expiresAtMs === 0,
    `HTTP ${warm.status} expiresAtMs=${(await runRow(PROG_HELD))?.expiresAtMs}`
  );

  const heldUntil = Date.now() + 60_000;
  await setExpiry(PROG_HELD, heldUntil);

  const beforeStudents = await snapshot([H1, H2]);
  const beforeCounts = await tenantDocCounts();

  const refused = await ladderPost(PROG_HELD, collegeAdmin);
  check("POST while the lease is held → 409 (not 500, not 200)", refused.status === 409, `HTTP ${refused.status} ${refused.error || ""}`);
  check(
    "…with the in-progress message and an IN_PROGRESS status",
    /another run is in progress/i.test(String(refused.error || "")) && refused.data?.status === "IN_PROGRESS",
    `${JSON.stringify(refused.error)} / ${JSON.stringify(refused.data)}`
  );
  check(
    "…and NO student moved (every term/status is byte-identical)",
    sameSnapshot(beforeStudents, await snapshot([H1, H2]), [H1, H2]),
    JSON.stringify(await snapshot([H1, H2]))
  );
  check(
    "…and the refused run created or destroyed NO document in the tenant",
    sameCounts(beforeCounts, await tenantDocCounts()),
    `${JSON.stringify(beforeCounts)}`
  );
  const row = await runRow(PROG_HELD);
  check(
    "…and the held row itself was NOT overwritten (still the holder's expiry)",
    row?.expiresAtMs === heldUntil,
    `expiresAtMs=${row?.expiresAtMs} expected=${heldUntil}`
  );

  // Per-programme scope: the held lease is A's, and it must not block B.
  const other = await ladderPost(PROG_OTHER, collegeAdmin);
  check(
    "the lease is PER PROGRAMME: another programme in the same school still runs (200)",
    other.status === 200 && (await readStudent(O1)).termNumber === 2 && (await readStudent(O2)).status === "ALUMNI",
    `HTTP ${other.status} o1=${(await readStudent(O1)).termNumber} o2=${(await readStudent(O2)).status}`
  );
}

/* ------------------------------------------------------------------ section 3 */
console.log("\n### an EXPIRED lease is TAKEN OVER (a crashed run cannot wedge a programme)");
{
  const rowIdBefore = await setExpiry(PROG_HELD, Date.now() - 1_000);

  const taken = await ladderPost(PROG_HELD, collegeAdmin);
  check("POST with an EXPIRED lease → 200 (taken over, not refused)", taken.status === 200, `HTTP ${taken.status} ${taken.error || ""}`);
  check(
    "…and the run really happened: the last student reached ALUMNI (so the ladder ran)",
    (await readStudent(H1)).status === "ALUMNI",
    `h1=${(await readStudent(H1)).termNumber}/${(await readStudent(H1)).status} h2=${(await readStudent(H2)).status}`
  );
  const row = await runRow(PROG_HELD);
  check(
    "…and the takeover reused the SAME row (one lease per programme, not a new row per run)",
    row?.id === rowIdBefore,
    `id=${row?.id} expected=${rowIdBefore}`
  );
  check("…and that row is released again after the takeover", row?.expiresAtMs === 0 && row?.status === "OK", `expiresAtMs=${row?.expiresAtMs} status=${row?.status}`);
}

/** The unauthorized caller section 4 creates, reused by section 7 (403 IS NOT a block). */
let acctCookie = null;

/* ------------------------------------------------------------------ section 4 */
console.log("\n### an authorization refusal takes NO lease (the claim is after every guard)");
{
  const acctEmail = `${M}accountant-${stamp}@test.local`;
  const acctUserId = `u_${createHash("sha1").update(acctEmail.toLowerCase()).digest("hex")}`;
  await db.collection("users").doc(acctUserId).set({
    name: `${M}Accountant ${stamp}`, email: acctEmail, role: "ACCOUNTANT",
    schoolId: COLLEGE, scope: null, branchId: null, active: true,
    passwordHash: bcrypt.hashSync("zzls-Pass-12345", 10),
  });
  created.users.push(acctUserId);
  const accountant = await login(acctEmail, "zzls-Pass-12345");
  acctCookie = accountant;

  const forbidden = await ladderPost(PROG_GUARD, accountant);
  check("an ACCOUNTANT (no `registration` action) is refused 403", forbidden.status === 403, `HTTP ${forbidden.status}`);
  check(
    "…and the 403 created NO lease row for that programme",
    !(await runRow(PROG_GUARD)),
    "no promotionRuns row"
  );
  check(
    "…and the programme's own cohort is untouched by the refusal",
    (await readStudent(G1)).termNumber === 1,
    `g1=${(await readStudent(G1)).termNumber}`
  );
}

/* ------------------------------------------------------------------ section 5 */
console.log("\n### a FORCED mid-run failure releases the lease and records PARTIAL");
{
  injectFault(PROG_FAIL, 2); // fail the descending walk at term 2
  const failed = await ladderPost(PROG_FAIL, collegeAdmin);
  check(
    "the injected mid-run failure still answers the STRUCTURED 500 (status PARTIAL)",
    failed.status === 500 && failed.data?.status === "PARTIAL",
    `HTTP ${failed.status} ${JSON.stringify(failed.data?.status)}`
  );
  const row = await runRow(PROG_FAIL);
  check(
    "…and the run's row records the failure: PARTIAL, finished, with the terms still to finish",
    row?.status === "PARTIAL" && !!row?.finishedAt && Array.isArray(row?.remainingTerms) && row.remainingTerms.length > 0,
    `status=${row?.status} remaining=${JSON.stringify(row?.remainingTerms)}`
  );
  check(
    "…and the lease was RELEASED anyway (expiresAtMs cleared), so the failure did not wedge the programme",
    row?.expiresAtMs === 0,
    `expiresAtMs=${row?.expiresAtMs}`
  );

  check(
    "…and the row's remainingTerms agree with the response's own list",
    JSON.stringify([...(row?.remainingTerms || [])].sort((a, b) => a - b)) ===
      JSON.stringify([...(failed.data?.remainingTerms || [])].sort((a, b) => a - b)),
    `row=${JSON.stringify(row?.remainingTerms)} response=${JSON.stringify(failed.data?.remainingTerms)}`
  );

  clearFault();
  // The documented recovery (D-5d2-6): re-apply the FAILED term and then the
  // not-attempted ones with the SINGLE-POSITION route, DESCENDING. It is
  // deliberately NOT leased — leasing it would break exactly this recovery — so
  // 6-pre 2 must leave it working, and must not let it double-advance anybody.
  const finishTerms = Array.isArray(failed.data?.finishTerms) ? [...failed.data.finishTerms].sort((a, b) => b - a) : [];
  let recoveryStatus = 0;
  for (const term of finishTerms) {
    const r = await post("/api/college-promotion", { programId: PROG_FAIL, fromTermNumber: term }, collegeAdmin);
    recoveryStatus = r.status;
  }
  const f1 = await readStudent(F1);
  const f2 = await readStudent(F2);
  const f3 = await readStudent(F3);
  check(
    "the recovery (`POST /api/college-promotion`, descending) still completes the ladder",
    recoveryStatus === 200 && f1.termNumber === 2 && f2.termNumber === 3 && f3.status === "ALUMNI",
    `HTTP ${recoveryStatus} finishTerms=${JSON.stringify(finishTerms)} f1=${f1.termNumber}/${f1.status} f2=${f2.termNumber}/${f2.status} f3=${f3.status}`
  );
  check(
    "…and every student advanced EXACTLY once (no double-advance through the recovery)",
    f1.termNumber === 2 && f2.termNumber === 3 && f3.status === "ALUMNI",
    "one step each: 1→2, 2→3, 3→ALUMNI"
  );
  const after = await ladderPost(PROG_FAIL, collegeAdmin);
  check("…and a fresh run after the failure is allowed (the lease did not survive it)", after.status === 200, `HTTP ${after.status} ${after.error || ""}`);
}

/* ------------------------------------------------------------------ section 6 */
console.log("\n### two TRULY CONCURRENT runs: exactly one 200, one 409, and ONE advance");
{
  const PROG_RACE = await makeProgram("race", 2);
  check("a sixth programme was created for the race", !!PROG_RACE, PROG_RACE || "none");
  const R1 = await makeStudent("race-1", { programId: PROG_RACE, termNumber: 1 });
  const R2 = await makeStudent("race-2", { programId: PROG_RACE, termNumber: 2 });

  // Fire BOTH without awaiting in between: the requests overlap on the server, so
  // their claims overlap too. The lease is what decides the winner.
  const [a, b] = await Promise.all([ladderPost(PROG_RACE, collegeAdmin), ladderPost(PROG_RACE, collegeAdmin)]);
  const codes = [a.status, b.status].sort((x, y) => x - y);
  check(
    "two concurrent runs → exactly ONE 200 and ONE 409",
    codes[0] === 200 && codes[1] === 409,
    `statuses = ${JSON.stringify([a.status, b.status])}`
  );

  const r1 = await readStudent(R1);
  const r2 = await readStudent(R2);
  check(
    "…and every student advanced EXACTLY one step (1 → 2, 2 → ALUMNI — never 1 → ALUMNI)",
    r1.termNumber === 2 && r2.status === "ALUMNI",
    `r1=${r1.termNumber}/${r1.status} r2=${r2.termNumber}/${r2.status}`
  );
  const row = await runRow(PROG_RACE);
  check(
    "…and the winner's row ends RELEASED, so the programme is usable again",
    row?.expiresAtMs === 0 && row?.status === "OK",
    `expiresAtMs=${row?.expiresAtMs} status=${row?.status}`
  );
  const afterRace = await ladderPost(PROG_RACE, collegeAdmin);
  check("…and a later run is allowed (200)", afterRace.status === 200, `HTTP ${afterRace.status} ${afterRace.error || ""}`);
}

/* ------------------------------------------------------------------ section 7 */
console.log("\n### a PARTIAL run BLOCKS the ladder until the outstanding terms are applied");
{
  // A fresh 3-term programme: term 3 completes, term 2 FAILS (injected, before it
  // writes) and term 1 is never attempted — so the run owes terms 2 and 1.
  const PROG_BLOCK = await makeProgram("block", 3);
  check("a third programme was created for the blocked-run proof", !!PROG_BLOCK, PROG_BLOCK || "none");
  const B1 = await makeStudent("block-1", { programId: PROG_BLOCK, termNumber: 1 });
  const B2 = await makeStudent("block-2", { programId: PROG_BLOCK, termNumber: 2 });
  const B3 = await makeStudent("block-3", { programId: PROG_BLOCK, termNumber: 3 });

  injectFault(PROG_BLOCK, 2);
  const partial = await ladderPost(PROG_BLOCK, collegeAdmin);
  clearFault();
  check(
    "the injected failure is still the structured 500, with the work list to finish",
    partial.status === 500 && partial.data?.status === "PARTIAL" && (partial.data?.finishTerms || []).join(",") === "2,1",
    `HTTP ${partial.status} status=${partial.data?.status} finish=${JSON.stringify(partial.data?.finishTerms || null)}`
  );
  const blockRow = await runRow(PROG_BLOCK);
  check(
    "…and the ROW records that work list — the single source the refusal is decided from",
    blockRow?.status === "PARTIAL" && (blockRow?.finishTerms || []).join(",") === "2,1" && blockRow?.expiresAtMs === 0,
    `status=${blockRow?.status} finish=${JSON.stringify(blockRow?.finishTerms || null)}`
  );

  const plan = await req(`/api/college-promotion/ladder?programId=${encodeURIComponent(PROG_BLOCK)}`, { cookie: collegeAdmin });
  check(
    "the GET plan is unchanged AND exposes the block (additive `runBlock`)",
    plan.status === 200 &&
      (plan.data?.steps || []).length === 3 &&
      plan.data?.runBlock?.blocked === true &&
      (plan.data?.runBlock?.finishTerms || []).join(",") === "2,1" &&
      plan.data?.runBlock?.stoppedAtTermNumber === 2,
    `HTTP ${plan.status} steps=${(plan.data?.steps || []).length} runBlock=${JSON.stringify(plan.data?.runBlock || null)}`
  );

  const beforeStudents = await snapshot([B1, B2, B3]);
  const beforeCounts = await tenantDocCounts();
  const refused = await ladderPost(PROG_BLOCK, collegeAdmin);
  check("a ladder RE-RUN after a partial run is 409 (not 200, not 500)", refused.status === 409, `HTTP ${refused.status} ${refused.error || ""}`);
  check(
    "…naming the outstanding terms DESCENDING and the route that finishes them (no re-run)",
    /term 2/.test(String(refused.error || "")) &&
      /term 1/.test(String(refused.error || "")) &&
      /descending/.test(String(refused.error || "")) &&
      /college-promotion/.test(String(refused.error || "")) &&
      refused.data?.stoppedAtTermNumber === 2 &&
      (refused.data?.finishTerms || []).join(",") === "2,1",
    `${JSON.stringify(refused.error)} / ${JSON.stringify(refused.data || null)}`
  );
  check(
    "…and NOTHING moved and NOTHING was created or destroyed (zero writes)",
    sameSnapshot(beforeStudents, await snapshot([B1, B2, B3]), [B1, B2, B3]) && sameCounts(beforeCounts, await tenantDocCounts()),
    `${JSON.stringify(beforeCounts)}`
  );
  const stillBlocked = await runRow(PROG_BLOCK);
  check(
    "…and the refused run left the row EXACTLY as the failed run wrote it",
    stillBlocked?.status === "PARTIAL" && (stillBlocked?.finishTerms || []).join(",") === "2,1",
    `status=${stillBlocked?.status} finish=${JSON.stringify(stillBlocked?.finishTerms || null)}`
  );

  // PER PROGRAMME: another programme of the same school is not blocked by it.
  const okPlan = await req(`/api/college-promotion/ladder?programId=${encodeURIComponent(PROG_OK)}`, { cookie: collegeAdmin });
  check(
    "the block is PER PROGRAMME: a programme whose last run completed is not blocked",
    okPlan.status === 200 && okPlan.data?.runBlock?.blocked === false,
    `HTTP ${okPlan.status} runBlock=${JSON.stringify(okPlan.data?.runBlock || null)}`
  );
  // AUTHORIZATION FIRST: an unauthorized caller must not learn the block exists.
  const forbidden = await ladderPost(PROG_BLOCK, acctCookie);
  check(
    "…and an UNauthorized caller gets 403, not the 409 that would reveal the programme's state",
    forbidden.status === 403,
    `HTTP ${forbidden.status} ${forbidden.error || ""}`
  );

  // The DOCUMENTED way out: the single-position route, DESCENDING. Each apply
  // strikes its own term off the work list, and the LAST one unblocks the ladder.
  const applyTerm = (term) => post("/api/college-promotion", { programId: PROG_BLOCK, fromTermNumber: term }, collegeAdmin);
  const t2 = await applyTerm(2);
  const midRow = await runRow(PROG_BLOCK);
  check(
    "applying the FAILED term strikes it off the work list (2,1 → 1) and leaves the block standing",
    t2.status === 200 && (midRow?.finishTerms || []).join(",") === "1" && midRow?.status === "PARTIAL",
    `HTTP ${t2.status} finish=${JSON.stringify(midRow?.finishTerms || null)} status=${midRow?.status}`
  );
  const t1 = await applyTerm(1);
  const doneRow = await runRow(PROG_BLOCK);
  check(
    "applying the LAST outstanding term UNBLOCKS it (empty work list, status OK, resolved by the single-position route)",
    t1.status === 200 &&
      (doneRow?.finishTerms || []).length === 0 &&
      doneRow?.status === "OK" &&
      doneRow?.resolvedBy === "SINGLE_POSITION",
    `HTTP ${t1.status} status=${doneRow?.status} finish=${JSON.stringify(doneRow?.finishTerms || null)} by=${doneRow?.resolvedBy}`
  );
  check(
    "…and every student advanced EXACTLY once through the recovery (1→2, 2→3, 3→ALUMNI)",
    (await readStudent(B1)).termNumber === 2 &&
      (await readStudent(B2)).termNumber === 3 &&
      (await readStudent(B3)).status === "ALUMNI",
    `b1=${(await readStudent(B1)).termNumber} b2=${(await readStudent(B2)).termNumber} b3=${(await readStudent(B3)).status}`
  );
  const afterPlan = await req(`/api/college-promotion/ladder?programId=${encodeURIComponent(PROG_BLOCK)}`, { cookie: collegeAdmin });
  const afterRun = await ladderPost(PROG_BLOCK, collegeAdmin);
  check(
    "…and the plan reports NOT blocked, so a ladder run is allowed again (200) — lifted by FINISHING, not by waiting",
    afterPlan.data?.runBlock?.blocked === false && afterRun.status === 200,
    `blocked=${afterPlan.data?.runBlock?.blocked} HTTP ${afterRun.status}`
  );
}

/* ------------------------------------------------------------------ section 8 */
console.log("\n### a run LONGER than its lease window is kept alive by the RENEWAL (6-pre 4)");
{
  const PROG_SLOW = await makeProgram("slow", 3);
  check("a programme was created for the long-run proof", !!PROG_SLOW, PROG_SLOW || "none");
  const S1 = await makeStudent("slow-1", { programId: PROG_SLOW, termNumber: 1 });
  const S2 = await makeStudent("slow-2", { programId: PROG_SLOW, termNumber: 2 });
  const S3 = await makeStudent("slow-3", { programId: PROG_SLOW, termNumber: 3 });

  // A ~1.2 s run under an 800 ms lease window: it MUST renew before each of its three
  // steps or the rival below would be able to take it over. The window covers the
  // per-step delay (400 ms) plus the cohort read with room to spare — which is exactly
  // the claim this phase makes: the TTL only has to cover ONE short interval, never a
  // whole run.
  writeSeam({ leaseTtlMs: 800, stepDelayMs: 400 });

  const started = Date.now();
  const slow = ladderPost(PROG_SLOW, collegeAdmin); // NOT awaited: the rival fires mid-run
  await new Promise((r) => setTimeout(r, 250));
  const rival = await ladderPost(PROG_SLOW, collegeAdmin);
  const result = await slow;
  const elapsed = Date.now() - started;
  clearFault();

  check(
    "the run really outlived its own lease window (~1.2 s of work under an 800 ms lease)",
    elapsed > 900,
    `${elapsed} ms elapsed`
  );
  check(
    "…and a rival fired while it was renewing is refused 409 (the lease is LIVE, not expired)",
    rival.status === 409,
    `HTTP ${rival.status} ${rival.error || ""}`
  );
  check(
    "…and the long run itself finished 200 — the RENEWAL, not a long TTL, kept it alive",
    result.status === 200,
    `HTTP ${result.status} ${result.error || ""}`
  );
  const row = await runRow(PROG_SLOW);
  check(
    "…and the row was renewed then released (expiresAtMs cleared, status OK)",
    row?.expiresAtMs === 0 && row?.status === "OK",
    `expiresAtMs=${row?.expiresAtMs} status=${row?.status}`
  );
  check(
    "…and every student advanced exactly ONE step (the rival advanced nobody)",
    (await readStudent(S1)).termNumber === 2 &&
      (await readStudent(S2)).termNumber === 3 &&
      (await readStudent(S3)).status === "ALUMNI",
    `s1=${(await readStudent(S1)).termNumber} s2=${(await readStudent(S2)).termNumber} s3=${(await readStudent(S3)).status}`
  );
}

/* ------------------------------------------------------------------ section 9 */
console.log("\n### a run that LOSES its lease aborts with no further writes, and its stale finalise keeps hands off (6-pre 4)");
{
  const PROG_STEAL = await makeProgram("steal", 3);
  check("a programme was created for the takeover proof", !!PROG_STEAL, PROG_STEAL || "none");
  const X1 = await makeStudent("steal-1", { programId: PROG_STEAL, termNumber: 1 });
  const X2 = await makeStudent("steal-2", { programId: PROG_STEAL, termNumber: 2 });
  const X3 = await makeStudent("steal-3", { programId: PROG_STEAL, termNumber: 3 });

  // After the FIRST committed slice (term 3's graduation — the descending walk starts
  // there) a FOREIGN, live lease is planted on the row: exactly the state a successor's
  // takeover leaves. Everything after that point must stop writing.
  writeSeam({ stealAfterSlice: 1 });
  const aborted = await ladderPost(PROG_STEAL, collegeAdmin);
  clearFault();
  const row = await runRow(PROG_STEAL);

  check(
    "the run stops with the STRUCTURED 500, status PARTIAL (the first slice had landed)",
    aborted.status === 500 && aborted.data?.status === "PARTIAL",
    `HTTP ${aborted.status} status=${JSON.stringify(aborted.data?.status || null)}`
  );
  check(
    "…and the reason says the lease was taken over (not a generic error)",
    /taken over/i.test(String(aborted.data?.reason || "")),
    JSON.stringify(aborted.data?.reason || null)
  );
  check(
    "…and the report names the landed step and the untouched ones (completed [3], finish [2,1])",
    (aborted.data?.completed || []).map((s) => s.fromTermNumber).join(",") === "3" &&
      (aborted.data?.finishTerms || []).join(",") === "2,1",
    `completed=${JSON.stringify((aborted.data?.completed || []).map((s) => s.fromTermNumber))} finish=${JSON.stringify(aborted.data?.finishTerms || null)}`
  );
  check(
    "…and NO further student moved: term 3 graduated, but terms 2 and 1 never advanced (no double-advance)",
    (await readStudent(X3)).status === "ALUMNI" &&
      (await readStudent(X2)).termNumber === 2 &&
      (await readStudent(X1)).termNumber === 1,
    `x1=${(await readStudent(X1)).termNumber} x2=${(await readStudent(X2)).termNumber} x3=${(await readStudent(X3)).status}`
  );
  check(
    "…and the STALE finalise did NOT clear the successor's lease (still the foreign holder's, still LIVE)",
    row?.ownerId === `${PROG_STEAL}~qa-successor` &&
      Number(row?.expiresAtMs) > Date.now() &&
      row?.status === "IN_PROGRESS",
    `owner=${row?.ownerId} expiresAtMs=${row?.expiresAtMs} status=${row?.status}`
  );
}

/* ----------------------------------------------------------------- section 10 */
console.log("\n### an UNREADABLE run state fails CLOSED: 503 and ZERO writes (6-pre 4)");
{
  const PROG_UNREAD = await makeProgram("unread", 2);
  check("a programme was created for the fail-closed proof", !!PROG_UNREAD, PROG_UNREAD || "none");
  const U1 = await makeStudent("unread-1", { programId: PROG_UNREAD, termNumber: 1 });
  const U2 = await makeStudent("unread-2", { programId: PROG_UNREAD, termNumber: 2 });
  check("…and it has NO run state row yet (so any row afterwards would be a new write)", !(await runRow(PROG_UNREAD)));

  writeSeam({ failBlockRead: true });
  const before = await tenantDocCounts();
  const refused = await ladderPost(PROG_UNREAD, collegeAdmin);
  const after = await tenantDocCounts();
  clearFault();

  check(
    "POST while the run state cannot be read → 503 (not 200, not 500, not 409)",
    refused.status === 503,
    `HTTP ${refused.status} ${refused.error || ""}`
  );
  check(
    "…with a message that says the read failed and nothing was written",
    /could not be read/i.test(String(refused.error || "")) && /nothing was written/i.test(String(refused.error || "")),
    JSON.stringify(refused.error || null)
  );
  check(
    "…and it took NO lease and wrote NOTHING anywhere in the tenant",
    sameCounts(before, after) && !(await runRow(PROG_UNREAD)),
    `${JSON.stringify(after)}`
  );
  check(
    "…and the cohort did not move",
    (await readStudent(U1)).termNumber === 1 && (await readStudent(U2)).status === "ACTIVE",
    `u1=${(await readStudent(U1)).termNumber} u2=${(await readStudent(U2)).status}`
  );

  // "no row = no block": with the read healthy again the SAME programme runs — the
  // fail-closed path must not have left anything behind that blocks it.
  const ok = await ladderPost(PROG_UNREAD, collegeAdmin);
  check(
    "…and once the read is healthy again the same programme runs normally (200, cohort advanced)",
    ok.status === 200 && (await readStudent(U1)).termNumber === 2 && (await readStudent(U2)).status === "ALUMNI",
    `HTTP ${ok.status} u1=${(await readStudent(U1)).termNumber} u2=${(await readStudent(U2)).status}`
  );
}

/* ----------------------------------------------------------------- section 11 */
console.log("\n### a failure on the FIRST step still records EVERY term as outstanding (6-pre 4)");
{
  const PROG_FIRST = await makeProgram("first", 3);
  check("a programme was created for the first-step proof", !!PROG_FIRST, PROG_FIRST || "none");
  const Y1 = await makeStudent("first-1", { programId: PROG_FIRST, termNumber: 1 });
  const Y2 = await makeStudent("first-2", { programId: PROG_FIRST, termNumber: 2 });
  const Y3 = await makeStudent("first-3", { programId: PROG_FIRST, termNumber: 3 });

  // The descending walk ATTEMPTS term 3 first, so this fault lands before ANY write:
  // nothing has been attempted except the term that failed, and the work list must
  // therefore cover every term — the top one included.
  injectFault(PROG_FIRST, 3);
  const failed = await ladderPost(PROG_FIRST, collegeAdmin);
  clearFault();
  const row = await runRow(PROG_FIRST);

  check(
    "the first-step failure is the structured 500 with status FAILED (no slice landed)",
    failed.status === 500 && failed.data?.status === "FAILED",
    `HTTP ${failed.status} status=${JSON.stringify(failed.data?.status || null)}`
  );
  check(
    "…and the work list covers EVERY term DESCENDING (3,2,1) — nothing was attempted, so nothing may be dropped",
    (failed.data?.finishTerms || []).join(",") === "3,2,1",
    JSON.stringify(failed.data?.finishTerms || null)
  );
  check(
    "…and the report names the term it DID stop at (term 3), never a term it never attempted",
    /stopped at term 3/.test(String(failed.error || "")) && /descending: term 3, then term 2, then term 1/.test(String(failed.error || "")),
    JSON.stringify(failed.error || null)
  );
  check(
    "…and no student moved at all",
    (await readStudent(Y1)).termNumber === 1 &&
      (await readStudent(Y2)).termNumber === 2 &&
      (await readStudent(Y3)).termNumber === 3 &&
      (await readStudent(Y3)).status === "ACTIVE",
    `y1=${(await readStudent(Y1)).termNumber} y2=${(await readStudent(Y2)).termNumber} y3=${(await readStudent(Y3)).termNumber}/${(await readStudent(Y3)).status}`
  );
  check(
    "…and the row records the same full work list, so the ladder is blocked until all three are applied",
    row?.status === "FAILED" && (row?.finishTerms || []).join(",") === "3,2,1" && row?.expiresAtMs === 0,
    `status=${row?.status} finish=${JSON.stringify(row?.finishTerms || null)} expiresAtMs=${row?.expiresAtMs}`
  );
}

/* ----------------------------------------------------------------- section 12 */
console.log("\n### an OUTSTANDING term with an EMPTY cohort can be finished by the single-position apply (6-pre 5)");
{
  const PROG_EMPTY = await makeProgram("empty", 3);
  check("a programme was created for the empty-term proof", !!PROG_EMPTY, PROG_EMPTY || "none");

  // No students at all: the descending walk fails at its FIRST step, so the whole
  // ladder is owed (3,2,1) — including terms whose cohort is empty. That is the wedge:
  // nobody can be moved, and until now nothing could strike those terms off.
  injectFault(PROG_EMPTY, 3);
  const failed = await ladderPost(PROG_EMPTY, collegeAdmin);
  clearFault();
  const row0 = await runRow(PROG_EMPTY);
  check(
    "an empty programme's failed run owes the WHOLE ladder (3,2,1) and the ladder is refused (409)",
    failed.status === 500 &&
      (row0?.finishTerms || []).join(",") === "3,2,1" &&
      (await ladderPost(PROG_EMPTY, collegeAdmin)).status === 409,
    `HTTP ${failed.status} finish=${JSON.stringify(row0?.finishTerms || null)}`
  );

  const t3 = await applyTerm(PROG_EMPTY, 3);
  const row1 = await runRow(PROG_EMPTY);
  check(
    "applying an EMPTY outstanding term is 200, promotes NOBODY, and strikes that term off (3,2,1 → 2,1)",
    t3.status === 200 &&
      t3.data?.promoted === 0 &&
      t3.data?.graduated === 0 &&
      (row1?.finishTerms || []).join(",") === "2,1",
    `HTTP ${t3.status} promoted=${t3.data?.promoted} graduated=${t3.data?.graduated} finish=${JSON.stringify(row1?.finishTerms || null)}`
  );

  await applyTerm(PROG_EMPTY, 2);
  await applyTerm(PROG_EMPTY, 1);
  const row2 = await runRow(PROG_EMPTY);
  check(
    "…and finishing the rest empties the work list and lifts the block (OK), so the ladder is usable again",
    (row2?.finishTerms || []).length === 0 && row2?.status === "OK" && (await ladderPost(PROG_EMPTY, collegeAdmin)).status === 200,
    `status=${row2?.status} finish=${JSON.stringify(row2?.finishTerms || null)}`
  );
}

/* ----------------------------------------------------------------- section 13 */
console.log("\n### the audited ABANDON hatch — same guards, one audit row, no student moved (6-pre 5)");
{
  const PROG_ABANDON = await makeProgram("abandon", 3);
  check("a programme was created for the abandon proof", !!PROG_ABANDON, PROG_ABANDON || "none");
  const A1 = await makeStudent("abandon-1", { programId: PROG_ABANDON, termNumber: 1 });
  const A2 = await makeStudent("abandon-2", { programId: PROG_ABANDON, termNumber: 2 });
  const A3 = await makeStudent("abandon-3", { programId: PROG_ABANDON, termNumber: 3 });

  injectFault(PROG_ABANDON, 2); // term 3 graduates, term 2 fails, term 1 is never attempted
  const partial = await ladderPost(PROG_ABANDON, collegeAdmin);
  clearFault();
  check(
    "a PARTIAL run to abandon was produced (work list 2,1)",
    partial.status === 500 && partial.data?.status === "PARTIAL" && (partial.data?.finishTerms || []).join(",") === "2,1",
    `HTTP ${partial.status} status=${partial.data?.status} finish=${JSON.stringify(partial.data?.finishTerms || null)}`
  );

  const REASON = "QA: this work list can never be finished by the routes";
  check(
    "an ACCOUNTANT is refused 403 — the same guard order as the run, so a 403 learns nothing",
    (await abandonRun(PROG_ABANDON, { reason: REASON }, acctCookie)).status === 403
  );
  const noReason = await abandonRun(PROG_ABANDON, {});
  check("a MISSING reason is 400", noReason.status === 400, `HTTP ${noReason.status} ${noReason.error || ""}`);
  const shortReason = await abandonRun(PROG_ABANDON, { reason: "too short" });
  check(
    "a TOO-SHORT reason is 400 (the reason is required to be a real record)",
    shortReason.status === 400,
    `HTTP ${shortReason.status} ${shortReason.error || ""}`
  );
  const okRow = await abandonRun(PROG_OK, { reason: REASON });
  check("a COMPLETED (OK) run cannot be abandoned → 409", okRow.status === 409, `HTTP ${okRow.status} ${okRow.error || ""}`);

  // A LIVE lease belongs to a run that is still working: refused, never raced.
  const heldRow = await runRow(PROG_HELD);
  await RUNS.doc(heldRow.id).update({ status: "IN_PROGRESS", expiresAtMs: Date.now() + 60_000 });
  const liveRow = await abandonRun(PROG_HELD, { reason: REASON });
  check("a LIVE (IN_PROGRESS) run cannot be abandoned → 409", liveRow.status === 409, `HTTP ${liveRow.status} ${liveRow.error || ""}`);

  const beforeStudents = await snapshot([A1, A2, A3]);
  const beforeAudits = (await auditsFor(PROG_ABANDON)).length;
  const beforeCounts = await tenantDocCounts();
  const done = await abandonRun(PROG_ABANDON, { reason: REASON });
  const row = await runRow(PROG_ABANDON);
  const audits = await auditsFor(PROG_ABANDON);
  check(
    "abandoning the PARTIAL run → 200, reporting ABANDONED and the work list it kept",
    done.status === 200 && done.data?.abandoned === true && done.data?.status === "ABANDONED" && (done.data?.finishTerms || []).join(",") === "2,1",
    `HTTP ${done.status} ${JSON.stringify(done.data || null)}`
  );
  check(
    "…and the row records who/when/why and KEEPS the work list as the record",
    row?.status === "ABANDONED" &&
      !!row?.resolvedAt &&
      row?.resolvedBy === "ABANDONED" &&
      row?.reason === REASON &&
      (row?.finishTerms || []).join(",") === "2,1" &&
      !!row?.failureReason,
    `status=${row?.status} by=${row?.resolvedBy} reason=${JSON.stringify(row?.reason || null)} finish=${JSON.stringify(row?.finishTerms || null)} failureReason=${!!row?.failureReason}`
  );
  const afterCounts = await tenantDocCounts();
  check(
    "…and NO student moved (every term/status is byte-identical), and the run row is the ONLY document written besides its ONE audit",
    sameSnapshot(beforeStudents, await snapshot([A1, A2, A3]), [A1, A2, A3]) &&
      afterCounts.students === beforeCounts.students &&
      afterCounts.programs === beforeCounts.programs &&
      afterCounts.promotionRuns === beforeCounts.promotionRuns &&
      afterCounts["auditLogs(not LOGIN)"] === beforeCounts["auditLogs(not LOGIN)"] + 1,
    JSON.stringify(afterCounts)
  );
  // `audit()` stores the caller's object under `details` (src/lib/auth.ts).
  const abandoned = audits.filter((a) => a.details?.reason === REASON);
  check(
    "…and exactly ONE audit row was added, carrying the reason and the outstanding terms",
    audits.length === beforeAudits + 1 &&
      abandoned.length === 1 &&
      (abandoned[0]?.details?.outstandingTerms || []).join(",") === "2,1" &&
      abandoned[0]?.details?.action === "ABANDONED",
    `${beforeAudits} → ${audits.length}, reason matches=${abandoned.length}, terms=${JSON.stringify(abandoned[0]?.details?.outstandingTerms || null)}`
  );
  const plan = await req(`/api/college-promotion/ladder?programId=${encodeURIComponent(PROG_ABANDON)}`, { cookie: collegeAdmin });
  check(
    "…and an ABANDONED row is NOT a block: the plan says not blocked and the ladder runs again (200)",
    plan.data?.runBlock?.blocked === false && (await ladderPost(PROG_ABANDON, collegeAdmin)).status === 200,
    `blocked=${plan.data?.runBlock?.blocked} HTTP ${(await ladderPost(PROG_ABANDON, collegeAdmin)).status}`
  );
  const foreign = await abandonRun("zzls-no-such-programme", { reason: REASON });
  check(
    "…and the hatch is TENANT-scoped: an unknown/foreign programme id is the run's own 400, never a 404",
    foreign.status === 400,
    `HTTP ${foreign.status} ${foreign.error || ""}`
  );

  // BRANCH scoping, and the sharpest form of it: a branch-A admin against a branch-B
  // programme whose run is COMPLETED. A missing branch check would answer 409 ("only an
  // unfinished run"), so a 403 proves the BRANCH check ran first, like the run's own.
  const PROG_B_BRANCH = await makeProgram("branchb", 2, BRANCH_B);
  const B1 = await makeStudent("branchb-1", { programId: PROG_B_BRANCH, termNumber: 1, branchId: BRANCH_B });
  const ranBranchB = await ladderPost(PROG_B_BRANCH, collegeAdmin);
  const branchRefusal = await abandonRun(PROG_B_BRANCH, { reason: REASON }, collegeBranchAdmin);
  const branchRowAfter = await runRow(PROG_B_BRANCH);
  check(
    "…and the hatch is BRANCH-scoped: a branch-A admin cannot abandon a branch-B programme (403, NOT the 409 its finished run would give)",
    ranBranchB.status === 200 && branchRefusal.status === 403,
    `run HTTP ${ranBranchB.status} abandon HTTP ${branchRefusal.status} ${branchRefusal.error || ""}`
  );
  check(
    "…and that refusal left the branch-B row exactly as the completed run wrote it",
    branchRowAfter?.status === "OK" && branchRowAfter?.resolvedBy === undefined,
    `status=${branchRowAfter?.status} by=${branchRowAfter?.resolvedBy} b1=${(await readStudent(B1)).termNumber}`
  );
}

/* ----------------------------------------------------------------- section 14 */
console.log("\n### a programme SHRINK reconciles the work list, and a DELETE removes the run row (6-pre 5)");
{
  const PROG_SHRINK = await makeProgram("shrink", 3); // no students, so the shrink guard cannot fire
  check("a programme was created for the shrink proof", !!PROG_SHRINK, PROG_SHRINK || "none");
  injectFault(PROG_SHRINK, 3);
  const failed = await ladderPost(PROG_SHRINK, collegeAdmin);
  clearFault();
  const owed = (await runRow(PROG_SHRINK))?.finishTerms || [];
  check("a failed run on the empty programme owes the whole ladder (3,2,1)", owed.join(",") === "3,2,1", JSON.stringify(owed));

  const patched = await req(`/api/programs/${PROG_SHRINK}`, {
    cookie: collegeAdmin,
    method: "PATCH",
    body: JSON.stringify({ durationYears: 2 }),
  });
  const row1 = await runRow(PROG_SHRINK);
  check(
    "shrinking the programme to 2 terms is 200 and FILTERS term 3 out of the work list (3,2,1 → 2,1)",
    patched.status === 200 && (row1?.finishTerms || []).join(",") === "2,1" && row1?.status === "FAILED",
    `HTTP ${patched.status} finish=${JSON.stringify(row1?.finishTerms || null)} status=${row1?.status}`
  );
  check(
    "…and the reconciled block still refuses the ladder (2,1 outstanding)",
    (await ladderPost(PROG_SHRINK, collegeAdmin)).status === 409
  );

  await applyTerm(PROG_SHRINK, 2);
  await applyTerm(PROG_SHRINK, 1);
  const row2 = await runRow(PROG_SHRINK);
  check(
    "…and the remaining EMPTY terms finish it (empty list, OK), so the ladder runs again (200)",
    (row2?.finishTerms || []).length === 0 && row2?.status === "OK" && (await ladderPost(PROG_SHRINK, collegeAdmin)).status === 200,
    `status=${row2?.status} finish=${JSON.stringify(row2?.finishTerms || null)}`
  );

  const PROG_DEL = await makeProgram("del", 2);
  check("a second programme was created for the delete proof", !!PROG_DEL, PROG_DEL || "none");
  const ran = await ladderPost(PROG_DEL, collegeAdmin);
  check("it ran once, so a lease row exists (and is not reachable by any prefix scan)", ran.status === 200 && !!(await runRow(PROG_DEL)), `HTTP ${ran.status}`);
  const deleted = await req(`/api/programs/${PROG_DEL}`, { cookie: collegeAdmin, method: "DELETE" });
  check(
    "deleting the programme is 200 and REMOVES its run row (no orphan by hash)",
    deleted.status === 200 && !(await runRow(PROG_DEL)),
    `HTTP ${deleted.status} row=${(await runRow(PROG_DEL)) ? "present" : "gone"}`
  );
}

/* -------------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
{
  clearFault();
  // The lease rows are keyed by a hash, so they are NOT found by the zzls- prefix
  // scan: they must be deleted by programme id.
  for (const pid of created.programs) {
    const row = await runRow(pid);
    if (row) await RUNS.doc(row.id).delete().catch(() => null);
  }
  for (const id of created.students) await db.collection("students").doc(id).delete().catch(() => null);
  for (const id of created.programs) await db.collection("programs").doc(id).delete().catch(() => null);
  for (const id of created.users) await db.collection("users").doc(id).delete().catch(() => null);
  for (const pid of created.programIdsForAudit) {
    const snaps = await db.collection("auditLogs").where("entityId", "==", pid).get();
    for (const d of snaps.docs) await d.ref.delete().catch(() => null);
  }

  // BOTH prefixes: this verifier's own (`zzls-`) and the block/lease probes' (`zzcp-`),
  // so a leftover from any run of this script is caught, not just the latest prefix.
  const leftovers = [];
  for (const col of ["students", "programs", "users"]) {
    for (const prefix of [M, "zzcp-"]) {
      const snap = await db
        .collection(col)
        .where("__name__", ">=", prefix)
        .where("__name__", "<=", prefix + "\uf8ff")
        .get();
      if (snap.size) leftovers.push(`${col}(${prefix}):${snap.size}`);
    }
  }
  let rowsLeft = 0;
  for (const pid of created.programs) if (await runRow(pid)) rowsLeft += 1;
  check(
    "every zzls- row this verifier created is gone (students/programmes/users)",
    leftovers.length === 0,
    leftovers.join(", ") || "no rows"
  );
  check("…and no promotionRuns row is left behind for any programme it leased", rowsLeft === 0, `${rowsLeft} row(s)`);
  check("…and the injected-fault file is gone", !existsSync(FAULT_FILE), FAULT_FILE);
}

console.log(
  failures
    ? `\n❌ ${failures} college-promotion LEASE failure(s) (of ${checks} checks)`
    : `\n✅ COLLEGE PROMOTION LEASE OK — one run at a time per programme, renewed by the heartbeat, released on success and on failure, taken over only when genuinely expired, fail-closed when unreadable, and no double-advance under concurrency (${checks} checks)`
);
process.exit(failures ? 1 : 0);
