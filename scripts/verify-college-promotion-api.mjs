#!/usr/bin/env node
/**
 * verify-college-promotion-api.mjs — Phase 5b: the college promotion ladder API.
 *
 * Runs over HTTP against the COLLEGE fixture tenant (scripts/isolation-fixture.mjs)
 * and proves the API half of the per-program ladder (docs/COLLEGE-DECISIONS.md
 * §15/§16):
 *
 *   • preview shape — the cohort at one (programme, term) position, each row's
 *     action, the tallies, the classId warning (D4) and the info-only pending
 *     count (D6, term-filtered);
 *   • the cohort is STRICT (D3): only the exact (programId, termNumber); an
 *     ALUMNI/TRANSFERRED student is never included (the school ladder's
 *     ON_ROLL_STUDENT rule, reused); a student of another term or another tenant
 *     never appears;
 *   • branch confinement: a branch-A admin's cohort excludes a branch-B student of
 *     the same programme and cannot even reach a branch-B programme (403), while
 *     the school-scope admin reaches both;
 *   • validation: missing/zero/past-the-end/non-numeric term and a missing or
 *     FOREIGN programme id are all 400 (the foreign id byte-identical to a ghost,
 *     so it is never a 404 oracle);
 *   • auth: anonymous 401, a wrong role 403, and a SCHOOL tenant 403 with zero rows
 *     written; a REFUSED apply writes nothing at all — proved twice, by a
 *     per-student term/status snapshot AND by a tenant document count
 *     (`auditLogs` excluding LOGIN), so a stray create or destroy shows up;
 *   • the programme shrink guard (Phase 5b-3): a PATCH that LOWERS a programme's
 *     derived term count answers 409 while any ON-ROLL student sits beyond the new
 *     last term (and writes nothing), and 200 otherwise; ALUMNI/TRANSFERRED never
 *     block, growing is unaffected, and the foreign/branch rules are unchanged;
 *   • apply: an advance moves exactly the cohort one term; a RE-RUN is a no-op
 *     (structural idempotency — no marker, D2); registrations are untouched (D7);
 *     the last term graduates to ALUMNI (D5), applied by a REGISTRAR (the Phase 5
 *     permission ruling) with no destination term, and a re-run is a no-op;
 *   • cleanup: every `zzcp-` row this verifier wrote is gone, and so are the audit
 *     rows its own programme creates produced.
 *
 * The ladder's own tenant/branch isolation checks live HERE and not in
 * verify-tenant-isolation.mjs / verify-branch-isolation.mjs (D11), so those
 * established counts stay identical.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-college-promotion-api.mjs
 * Needs the isolation fixture:  node scripts/isolation-fixture.mjs create
 *
 * Creates and cleans up ALL of its own rows (an ACCOUNTANT user, three throwaway
 * programmes and eight students). It never edits a fixture row.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync, writeFileSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bcrypt from "bcryptjs";
import { requireEmulator } from "./lib/guard.mjs";

import { installHostFetch } from "./lib/hostfetch.mjs";

// Integration 5a — a `Host:` header on fetch is a fetch-spec forbidden name and
// was silently dropped, so every host-scoped request below reached the hub.
// Those requests now go through node:http, which delivers the header for real.
// This changes request DELIVERY only: no assertion, expectation or fixture moved.
installHostFetch();

requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const HOST = `school.localhost:${PORT}`;
/** Fixture id prefix (isolation-fixture.mjs). */
const P = "zziso-";
/** Our own id prefix for every row this verifier creates. */
const M = "zzcp-";

const TRACK = new URL(".qa-fixtures.json", import.meta.url);
if (!existsSync(TRACK)) {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(1);
}
const CRED = JSON.parse(readFileSync(TRACK, "utf8")).creds || {};
if (!CRED.collegeAdmin || !CRED.collegeBranchAdmin || !CRED.collegeRegistrar || !CRED.admin) {
  console.error("❌ Track file lacks college credentials — re-run: node scripts/isolation-fixture.mjs clean && create");
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

/**
 * The fault-injection seam the ladder POST reads
 * (`src/app/api/college-promotion/ladder/route.ts`, `ladderFault`).
 *
 * A deterministic mid-run failure is otherwise unreachable over HTTP — every write the
 * ladder makes is a valid single-field update — so the failure is forced from a FILE in
 * the OS temp directory that names the programme and the term. It is inert in production
 * (`NODE_ENV === "production"` short-circuits) and can never be triggered by a request.
 * This verifier plants it for one call and removes it immediately.
 */
const FAULT_FILE = join(tmpdir(), "smart-school-qa-ladder-fault.json");
const injectFault = (programId, term, message = `qa-injected ladder fault (${M})`) =>
  writeFileSync(FAULT_FILE, JSON.stringify({ programId, term, message }));
const clearFault = () => rmSync(FAULT_FILE, { force: true });

/* ------------------------------------------------------------ fixture ids */
const COLLEGE = `${P}college`;
const BOTH = `${P}both`;
const DEPT_A = `${P}col-dept-a`;
const BRANCH_A = `${P}col-br-a`;
const BRANCH_B = `${P}col-br-b`;
/** A real programme id belonging to ANOTHER tenant — must behave as not-found. */
const FOREIGN_PROG = `${P}both-prog`;

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
const preview = (programId, fromTermNumber, cookie) =>
  req(`/api/college-promotion?programId=${encodeURIComponent(programId)}&fromTermNumber=${fromTermNumber}`, { cookie });
const apply = (programId, fromTermNumber, cookie) => post("/api/college-promotion", { programId, fromTermNumber }, cookie);
const patch = (path, body, cookie) => req(path, { cookie, method: "PATCH", body: JSON.stringify(body) });

const collegeAdmin = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
const collegeBranchAdmin = await login("zz-iso-college-br-admin@test.local", CRED.collegeBranchAdmin);
const collegeRegistrar = await login("zz-iso-college-registrar@test.local", CRED.collegeRegistrar);
const schoolAdmin = await login("zz-iso-admin@test.local", CRED.admin);

const stamp = Date.now();

/* -------------------------------------------- our own tracked rows + helpers */
const created = { programs: [], students: [], registrations: [], users: [], programIdsForAudit: [] };

/** Create a throwaway programme through the real API (branch is explicit). */
async function makeProgram(tag, durationYears, branchId) {
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

/**
 * A student row written RAW — the same shape the students route writes, with an
 * explicit branchId so branch confinement is deterministic (the route derives the
 * branch, which is not what this verifier is testing).
 */
async function makeStudent(tag, { programId, termNumber, branchId, status = "ACTIVE", classId = null, schoolId = COLLEGE }) {
  const id = `${M}stu-${tag}-${stamp}`;
  await db.collection("students").doc(id).set({
    id, schoolId, branchId, name: `${M}Student ${tag} ${stamp}`,
    admissionNo: `${M}ADM-${tag}-${stamp}`, programId, termNumber,
    status, ...(classId ? { classId } : {}), active: true, createdAt: new Date().toISOString(),
  });
  created.students.push(id);
  return id;
}

async function makeRegistration(tag, { studentId, programId, termNumber, status = "PENDING", branchId = BRANCH_A, schoolId = COLLEGE }) {
  const id = `${M}reg-${tag}-${stamp}`;
  await db.collection("courseRegistrations").doc(id).set({
    id, schoolId, branchId, studentId, courseId: `${M}course-${tag}`, programId, termNumber,
    status, requestedById: null, decidedById: null, decidedAt: null, createdAt: new Date().toISOString(),
  });
  created.registrations.push(id);
  return id;
}

/**
 * Create `count` raw cohort students in batched writes, tracked for cleanup.
 *
 * Used to prove a ladder whose single STEP needs MORE THAN ONE ≤400-op slice: with
 * 405 students at one term the step cannot go out in a single batch, and the run must
 * still complete with every student moved exactly one step.
 */
async function makeCohort(tag, count, { programId, termNumber, branchId = BRANCH_A }) {
  const ids = [];
  for (let i = 0; i < count; i++) ids.push(`${M}${tag}-${String(i).padStart(3, "0")}-${stamp}`);
  for (let at = 0; at < ids.length; at += 400) {
    const batch = db.batch();
    for (const id of ids.slice(at, at + 400)) {
      batch.set(db.collection("students").doc(id), {
        id, schoolId: COLLEGE, branchId, name: `${M}Student ${tag} ${id}`,
        admissionNo: `${M}ADM-${id}`, programId, termNumber, status: "ACTIVE", active: true,
        createdAt: new Date().toISOString(),
      });
    }
    await batch.commit();
  }
  created.students.push(...ids);
  return ids;
}

/** Read back the fields a promotion may change. */
const readStudent = async (id) => (await db.collection("students").doc(id).get()).data() || {};
/** Read back a programme row (the shrink guard's PATCH changes `durationYears`). */
const readProgram = async (id) => (await db.collection("programs").doc(id).get()).data() || {};
/** A term+status snapshot of our students, for the "writes nothing" checks. */
async function snapshot() {
  const out = {};
  for (const id of created.students) {
    const d = await readStudent(id);
    out[id] = `${d.termNumber}|${d.status}`;
  }
  return out;
}
const sameSnapshot = (a, b) => created.students.every((id) => a[id] === b[id]);

/**
 * Document counts for the refusal checks, scoped to THIS tenant.
 *
 * The field snapshot above proves no tracked student's term/status changed; these
 * counts prove the independent property that the request created or destroyed NO
 * document at all. `auditLogs` excludes `action: "LOGIN"` because the verifier's
 * own five sign-ins write those rows — they are not the request under test —
 * while every other row of the tenant is counted, including this verifier's own
 * programmes/students/registrations (present in BOTH counts, so they cancel).
 *
 * The two counts must bracket the refused request alone: nothing else may write
 * between them.
 */
async function tenantDocCounts() {
  const counts = {};
  for (const col of ["students", "programs", "courseRegistrations"]) {
    counts[col] = (await db.collection(col).where("schoolId", "==", COLLEGE).get()).size;
  }
  const audits = await db.collection("auditLogs").where("schoolId", "==", COLLEGE).get();
  counts["auditLogs(not LOGIN)"] = audits.docs.filter((d) => d.data().action !== "LOGIN").length;
  return counts;
}
const sameCounts = (a, b) => Object.keys(a).every((k) => a[k] === b[k]);

/* ------------------------------------------------------------------- set-up */
console.log(`\n=== set-up (${BASE})`);

// A wrong-role session INSIDE the college tenant (a SCHOOL-tenant 403 would be the
// gate, not the permission check). ACCOUNTANT holds no `registration` action.
const acctEmail = `${M}accountant-${stamp}@test.local`;
const acctUserId = `u_${createHash("sha1").update(acctEmail.toLowerCase()).digest("hex")}`;
await db.collection("users").doc(acctUserId).set({
  name: `${M}Accountant ${stamp}`, email: acctEmail, role: "ACCOUNTANT",
  schoolId: COLLEGE, scope: null, branchId: null, active: true,
  passwordHash: bcrypt.hashSync("zzcp-Pass-12345", 10),
});
created.users.push(acctUserId);
const accountant = await login(acctEmail, "zzcp-Pass-12345");

// PROG2: 2 YEARLY terms (advance 1 → 2). PROG3: 3 terms (graduate at 3).
// PROG_B: an otherwise-identical programme in BRANCH B, for the 403 confinement probe.
const PROG2 = await makeProgram("2", 2, BRANCH_A);
const PROG3 = await makeProgram("3", 3, BRANCH_A);
const PROG_B = await makeProgram("B", 2, BRANCH_B);
check("the three throwaway programmes were created (201)", !!PROG2 && !!PROG3 && !!PROG_B, `${PROG2} / ${PROG3} / ${PROG_B}`);

const S1 = await makeStudent("s1", { programId: PROG2, termNumber: 1, branchId: BRANCH_A });
const S2 = await makeStudent("s2", { programId: PROG2, termNumber: 1, branchId: BRANCH_A, classId: `${M}class-${stamp}` });
const S3 = await makeStudent("s3", { programId: PROG2, termNumber: 1, branchId: BRANCH_B }); // same programme, OTHER branch
const ALUMNI = await makeStudent("alumni", { programId: PROG2, termNumber: 1, branchId: BRANCH_A, status: "ALUMNI" });
const TRANSFERRED = await makeStudent("transferred", { programId: PROG2, termNumber: 1, branchId: BRANCH_A, status: "TRANSFERRED" });
const OTHER_TERM = await makeStudent("term2", { programId: PROG2, termNumber: 2, branchId: BRANCH_A });
const GRAD = await makeStudent("grad", { programId: PROG3, termNumber: 3, branchId: BRANCH_A });
const BOTH_STU = await makeStudent("both", { programId: FOREIGN_PROG, termNumber: 1, branchId: null, schoolId: BOTH });
check("the eight raw cohort students were written", created.students.length === 8, `${created.students.length} row(s)`);

// D6 — two PENDING registrations for S1 (term 1 and term 2) prove the count is
// TERM-filtered, plus one for another cohort member.
const REG_S1_T1 = await makeRegistration("s1t1", { studentId: S1, programId: PROG2, termNumber: 1 });
const REG_S1_T2 = await makeRegistration("s1t2", { studentId: S1, programId: PROG2, termNumber: 2 });
const REG_S2_T1 = await makeRegistration("s2t1", { studentId: S2, programId: PROG2, termNumber: 1 });

/* ------------------------------------------------------------- preview shape */
console.log("\n### preview — the cohort, its actions and the informational fields");
let ov = await preview(PROG2, 1, collegeAdmin);
{
  check("GET preview → 200", ov.status === 200, `HTTP ${ov.status} ${ov.error || ""}`);
  check(
    "…names the programme and the position, with the programme's derived term count",
    ov.data?.program?.id === PROG2 && ov.data?.fromTermNumber === 1 && ov.data?.termCount === 2,
    `program=${ov.data?.program?.id} from=${ov.data?.fromTermNumber} termCount=${ov.data?.termCount}`
  );
  check("…is not a graduating run (term 1 of 2)", ov.data?.graduating === false, `graduating=${ov.data?.graduating}`);

  const ids = (ov.data?.rows || []).map((r) => r.studentId).sort();
  check(
    "…lists exactly the strict cohort (programId AND termNumber), school-scope sees all three",
    ids.length === 3 && ids.includes(S1) && ids.includes(S2) && ids.includes(S3),
    `count=${ov.data?.count} ids=${JSON.stringify(ids)}`
  );
  check(
    "…every row is an advance to term 2, none graduating, all with the position's termNumber",
    (ov.data?.rows || []).every((r) => r.action === "advance" && r.toTermNumber === 2 && r.graduating === false && r.fromTermNumber === 1),
    JSON.stringify((ov.data?.rows || []).map((r) => [r.action, r.toTermNumber, r.graduating]))
  );
  // `pendingRegistrations` is the SUM of the per-row counts, and S1 and S2 each
  // hold exactly one PENDING row AT THIS TERM (S1 also holds one at term 2, which
  // the term filter must leave out) — so the total is 2, not 3.
  check(
    "…the tallies agree with the rows",
    ov.data?.counts?.advance === 3 && ov.data?.counts?.graduate === 0 && ov.data?.counts?.classIdWarnings === 1 &&
      ov.data?.counts?.pendingRegistrations === 2,
    JSON.stringify(ov.data?.counts)
  );

  const rowS2 = (ov.data?.rows || []).find((r) => r.studentId === S2);
  const rowS1 = (ov.data?.rows || []).find((r) => r.studentId === S1);
  check("…D4: the student that ALSO holds a classId is flagged, the other is not", rowS2?.classIdWarning === true && rowS1?.classIdWarning === false, `s2=${rowS2?.classIdWarning} s1=${rowS1?.classIdWarning}`);
  check(
    "…D6: the pending count is INFO ONLY (both rows still 'advance') and TERM-filtered (S1 counts 1 of its 2 rows)",
    rowS1?.pendingRegistrationCount === 1 && rowS2?.pendingRegistrationCount === 1,
    `s1=${rowS1?.pendingRegistrationCount} s2=${rowS2?.pendingRegistrationCount}`
  );
}

/* ---------------------------------------------- strict cohort / exclusion / tenant */
console.log("\n### the cohort is strict — exclusions and tenant isolation");
{
  const ids = (ov.data?.rows || []).map((r) => r.studentId);
  check("…ALUMNI and TRANSFERRED students are never in the cohort (ON_ROLL_STUDENT)", !ids.includes(ALUMNI) && !ids.includes(TRANSFERRED), `ids=${JSON.stringify(ids)}`);
  check("…a student of the same programme at ANOTHER term is not in the cohort (D3)", !ids.includes(OTHER_TERM), `ids=${JSON.stringify(ids)}`);
  check("…and no row belongs to another tenant (the BOTH tenant's student stays out)", !ids.includes(BOTH_STU), `ids=${JSON.stringify(ids)}`);

  // The permission ruling: a REGISTRAR holds `registration` as full, so it may READ.
  const reg = await preview(PROG2, 1, collegeRegistrar);
  check("…a REGISTRAR may read the preview (200, full cohort)", reg.status === 200 && reg.data?.count === 3, `HTTP ${reg.status} count=${reg.data?.count}`);
}

/* ------------------------------------------------------------ branch confinement */
console.log("\n### branch confinement — a branch-A admin is confined to branch A");
{
  const b = await preview(PROG2, 1, collegeBranchAdmin);
  const ids = (b.data?.rows || []).map((r) => r.studentId);
  check(
    "…its cohort excludes the SAME programme's branch-B student",
    b.status === 200 && b.data?.count === 2 && ids.includes(S1) && ids.includes(S2) && !ids.includes(S3),
    `HTTP ${b.status} count=${b.data?.count} ids=${JSON.stringify(ids)}`
  );
  const foreignProg = await preview(PROG_B, 1, collegeBranchAdmin);
  check("…and it cannot reach a programme that belongs to another branch (403)", foreignProg.status === 403, `HTTP ${foreignProg.status} ${foreignProg.error || ""}`);
}

/* -------------------------------------------------------- validation (no writes) */
console.log("\n### validation — every bad position is a 400, never an oracle");
{
  const before = await snapshot();
  const noProg = await preview("", 1, collegeAdmin);
  check("a missing programme id is 400", noProg.status === 400, `HTTP ${noProg.status} ${noProg.error || ""}`);
  const noTerm = await preview(PROG2, "", collegeAdmin);
  check("a missing term is 400", noTerm.status === 400, `HTTP ${noTerm.status} ${noTerm.error || ""}`);
  const zero = await preview(PROG2, 0, collegeAdmin);
  check("term 0 is 400", zero.status === 400, `HTTP ${zero.status} ${zero.error || ""}`);
  const past = await preview(PROG2, 3, collegeAdmin);
  check("a term past the programme's end is 400", past.status === 400, `HTTP ${past.status} ${past.error || ""}`);
  const text = await preview(PROG2, "two", collegeAdmin);
  check("a non-numeric term is 400", text.status === 400, `HTTP ${text.status} ${text.error || ""}`);

  const foreign = await preview(FOREIGN_PROG, 1, collegeAdmin);
  const ghost = await preview(`${M}no-such-prog`, 1, collegeAdmin);
  check(
    "a FOREIGN tenant's programme id is 400, byte-identical to a non-existent one (no 404 oracle)",
    foreign.status === 400 && ghost.status === 400 && foreign.error === ghost.error,
    `foreign=${JSON.stringify(foreign.error)} ghost=${JSON.stringify(ghost.error)}`
  );

  const docsBefore = await tenantDocCounts();
  const refusedApply = await apply(FOREIGN_PROG, 1, collegeAdmin);
  const docsAfter = await tenantDocCounts();
  const after = await snapshot();
  check(
    "a REFUSED apply (400) writes NOTHING — every term/status is unchanged",
    refusedApply.status === 400 && sameSnapshot(before, after),
    `HTTP ${refusedApply.status} unchanged=${sameSnapshot(before, after)}`
  );
  check(
    "…and creates or destroys NO document in the tenant (students/programmes/registrations/audit excl. LOGIN)",
    sameCounts(docsBefore, docsAfter),
    `before=${JSON.stringify(docsBefore)} after=${JSON.stringify(docsAfter)}`
  );
}

/* ------------------------------------------------------------------------ auth */
console.log("\n### auth — anonymous 401, wrong role 403");
{
  const anonGet = await req("/api/college-promotion?programId=x&fromTermNumber=1");
  check("an anonymous preview is 401", anonGet.status === 401, `HTTP ${anonGet.status}`);
  const anonPost = await post("/api/college-promotion", { programId: PROG2, fromTermNumber: 1 });
  check("an anonymous apply is 401", anonPost.status === 401, `HTTP ${anonPost.status}`);
  const acctGet = await preview(PROG2, 1, accountant);
  check("a wrong role (ACCOUNTANT) preview is 403", acctGet.status === 403, `HTTP ${acctGet.status} ${acctGet.error || ""}`);
  const acctPost = await apply(PROG2, 1, accountant);
  check("a wrong role (ACCOUNTANT) apply is 403", acctPost.status === 403, `HTTP ${acctPost.status} ${acctPost.error || ""}`);
}

/* ----------------------------------------------------------------- SCHOOL tenant */
console.log("\n### a SCHOOL tenant is refused with zero rows written");
{
  const before = await snapshot();
  const sGet = await preview(PROG2, 1, schoolAdmin);
  check("a SCHOOL tenant's preview is 403 with ZERO data", sGet.status === 403 && sGet.data === null, `HTTP ${sGet.status} data=${JSON.stringify(sGet.data)}`);
  const docsBefore = await tenantDocCounts();
  const sPost = await apply(PROG2, 1, schoolAdmin);
  const docsAfter = await tenantDocCounts();
  const after = await snapshot();
  check(
    "a SCHOOL tenant's apply is 403 and writes ZERO rows",
    sPost.status === 403 && sameSnapshot(before, after),
    `HTTP ${sPost.status} unchanged=${sameSnapshot(before, after)}`
  );
  check(
    "…and creates or destroys NO document in the college tenant (audit excl. LOGIN)",
    sameCounts(docsBefore, docsAfter),
    `before=${JSON.stringify(docsBefore)} after=${JSON.stringify(docsAfter)}`
  );
}

/* --------------------------------------------------------------------- advance */
console.log("\n### advance — exactly the cohort moves, one term up");
{
  // The branch-A admin applies first: it must move its own two and leave branch B alone.
  const bApply = await apply(PROG2, 1, collegeBranchAdmin);
  const s1 = await readStudent(S1);
  const s2 = await readStudent(S2);
  const s3 = await readStudent(S3);
  check("a branch-A admin's apply promotes exactly its own branch's cohort (2)", bApply.status === 200 && bApply.data?.promoted === 2 && bApply.data?.graduated === 0 && bApply.data?.failed === 0, `HTTP ${bApply.status} ${JSON.stringify(bApply.data)}`);
  check("…and both of its students are now at term 2", s1.termNumber === 2 && s2.termNumber === 2, `s1=${s1.termNumber} s2=${s2.termNumber}`);
  check("…while the SAME programme's branch-B student is untouched (branch confinement)", s3.termNumber === 1, `s3=${s3.termNumber}`);

  const sApply = await apply(PROG2, 1, collegeAdmin);
  const s3after = await readStudent(S3);
  check(
    "the school-scope admin's apply promotes the remaining branch-B row (1) and reports the destination",
    sApply.status === 200 && sApply.data?.promoted === 1 && sApply.data?.toTermNumber === 2 && sApply.data?.graduating === false,
    `HTTP ${sApply.status} ${JSON.stringify(sApply.data)}`
  );
  check("…and that student is now at term 2 too", s3after.termNumber === 2, `s3=${s3after.termNumber}`);

  // A student at another term, an ALUMNI and a TRANSFERRED student were never selected.
  const other = await readStudent(OTHER_TERM);
  const alumni = await readStudent(ALUMNI);
  check(
    "students outside the cohort are untouched (other term 2, ALUMNI, TRANSFERRED)",
    other.termNumber === 2 && alumni.status === "ALUMNI" && (await readStudent(TRANSFERRED)).status === "TRANSFERRED",
    `otherTerm=${other.termNumber} alumni=${alumni.status}`
  );
}

/* ------------------------------------------------------------ re-run is a no-op */
console.log("\n### re-run is a no-op — idempotent with NO marker field (D2)");
{
  const again = await apply(PROG2, 1, collegeAdmin);
  check(
    "a second apply of the same position promotes nobody",
    again.status === 200 && again.data?.promoted === 0 && again.data?.graduated === 0,
    `HTTP ${again.status} ${JSON.stringify(again.data)}`
  );
  const after = await preview(PROG2, 1, collegeAdmin);
  check("…and the preview for that position is now empty", after.status === 200 && after.data?.count === 0 && after.data?.counts?.advance === 0, `count=${after.data?.count}`);
  const s1 = await readStudent(S1);
  check("…so nobody was double-advanced (still term 2, not 3)", s1.termNumber === 2, `s1=${s1.termNumber}`);
}

/* ---------------------------------------------------- registrations untouched (D7) */
console.log("\n### registrations are untouched (D7)");
{
  const r1 = (await db.collection("courseRegistrations").doc(REG_S1_T1).get()).data() || {};
  const r2 = (await db.collection("courseRegistrations").doc(REG_S1_T2).get()).data() || {};
  const r3 = (await db.collection("courseRegistrations").doc(REG_S2_T1).get()).data() || {};
  check(
    "every registration keeps its own programme/term/status across the promotion",
    r1.termNumber === 1 && r1.status === "PENDING" && r1.programId === PROG2 &&
      r2.termNumber === 2 && r2.status === "PENDING" &&
      r3.termNumber === 1 && r3.status === "PENDING",
    `t1=${r1.status}/${r1.termNumber} t2=${r2.status}/${r2.termNumber}`
  );
}

/* ---------------------------------------------------------- graduation (last term) */
console.log("\n### the last term graduates to ALUMNI, applied by a REGISTRAR (D5)");
{
  const regPrev = await preview(PROG3, 3, collegeRegistrar);
  const row = (regPrev.data?.rows || [])[0];
  check(
    "a REGISTRAR's preview of the final term is a graduating run with no destination term",
    regPrev.status === 200 && regPrev.data?.graduating === true && regPrev.data?.count === 1 &&
      row?.action === "graduate" && row?.toTermNumber === null && row?.graduating === true,
    `HTTP ${regPrev.status} graduating=${regPrev.data?.graduating} row=${JSON.stringify(row)}`
  );
  check("…and the ALUMNI/TRANSFERRED students of that programme are still excluded", regPrev.data?.count === 1, `count=${regPrev.data?.count}`);

  const regApply = await apply(PROG3, 3, collegeRegistrar);
  check(
    "the REGISTRAR's apply graduates exactly one with no destination term",
    regApply.status === 200 && regApply.data?.graduated === 1 && regApply.data?.promoted === 0 &&
      regApply.data?.graduating === true && regApply.data?.toTermNumber === null,
    `HTTP ${regApply.status} ${JSON.stringify(regApply.data)}`
  );
  const grad = await readStudent(GRAD);
  check("…the graduating student's status is ALUMNI (the existing terminal value)", grad.status === "ALUMNI", `status=${grad.status}`);
  check("…and its termNumber is NOT silently changed", grad.termNumber === 3, `termNumber=${grad.termNumber}`);

  const after = await preview(PROG3, 3, collegeRegistrar);
  check("…a re-run selects nobody (ALUMNI is off-roll)", after.status === 200 && after.data?.count === 0, `count=${after.data?.count}`);
  const reApply = await apply(PROG3, 3, collegeRegistrar);
  check("…and a re-apply graduates nobody", reApply.status === 200 && reApply.data?.graduated === 0, `HTTP ${reApply.status} ${JSON.stringify(reApply.data)}`);
}

/* ------------------------------------------- programme shrink guard (Phase 5b-3) */
console.log("\n### the programme shrink guard — an on-roll student may not be stranded");
{
  // Four YEARLY programmes: three of 3 terms (to shrink) and one of 2 terms (to grow).
  const SH = await makeProgram("sh", 3, BRANCH_A);
  const NONE = await makeProgram("none", 3, BRANCH_A);
  const ALUM = await makeProgram("alum", 3, BRANCH_A);
  const GROW = await makeProgram("grow", 2, BRANCH_A);
  check("the four shrink-guard programmes were created (201)", !!SH && !!NONE && !!ALUM && !!GROW, `${SH} / ${NONE} / ${ALUM} / ${GROW}`);

  // SH: an ON-ROLL student at term 3 (past a 3→2 shrink). ALUM: an ALUMNI and a
  // TRANSFERRED student also at term 3 — only the ON-ROLL one may block.
  await makeStudent("sh3", { programId: SH, termNumber: 3, branchId: BRANCH_A });
  await makeStudent("none1", { programId: NONE, termNumber: 1, branchId: BRANCH_A });
  await makeStudent("alum3", { programId: ALUM, termNumber: 3, branchId: BRANCH_A, status: "ALUMNI" });
  await makeStudent("tr3", { programId: ALUM, termNumber: 3, branchId: BRANCH_A, status: "TRANSFERRED" });
  await makeStudent("grow2", { programId: GROW, termNumber: 2, branchId: BRANCH_A });

  // A 3 → 2 shrink with an on-roll student at term 3 is refused, and writes nothing.
  const docsBefore = await tenantDocCounts();
  const refused = await patch(`/api/programs/${SH}`, { durationYears: 2 }, collegeAdmin);
  const docsAfter = await tenantDocCounts();
  check("a shrink that would strand an on-roll student is refused with 409", refused.status === 409, `HTTP ${refused.status} ${refused.error || ""}`);
  check("…the error names the new last term and how many students are beyond it", /Year 2/.test(refused.error || "") && /1 on-roll/.test(refused.error || ""), `${refused.error}`);
  check("…and the programme is unchanged (still 3 years)", (await readProgram(SH)).durationYears === 3, `duration=${(await readProgram(SH)).durationYears}`);
  check("…and nothing at all was written (no document, no audit row)", sameCounts(docsBefore, docsAfter), `before=${JSON.stringify(docsBefore)} after=${JSON.stringify(docsAfter)}`);

  // Nobody beyond the new end → the shrink is allowed and persists.
  const noneRes = await patch(`/api/programs/${NONE}`, { durationYears: 2 }, collegeAdmin);
  check("a shrink with nobody beyond the new end is allowed (200, term count 2)", noneRes.status === 200 && noneRes.data?.termCount === 2, `HTTP ${noneRes.status} ${JSON.stringify(noneRes.data)}`);
  check("…and it persisted (the programme is now 2 years)", (await readProgram(NONE)).durationYears === 2, `duration=${(await readProgram(NONE)).durationYears}`);

  // Only ALUMNI/TRANSFERRED sit beyond → they never block (ON_ROLL_STUDENT).
  const alumRes = await patch(`/api/programs/${ALUM}`, { durationYears: 2 }, collegeAdmin);
  check("a shrink is allowed when only ALUMNI/TRANSFERRED students sit beyond", alumRes.status === 200 && alumRes.data?.termCount === 2, `HTTP ${alumRes.status} ${JSON.stringify(alumRes.data)}`);
  check("…and it persisted", (await readProgram(ALUM)).durationYears === 2, `duration=${(await readProgram(ALUM)).durationYears}`);

  // Growing can never strand anybody → unaffected.
  const growRes = await patch(`/api/programs/${GROW}`, { durationYears: 4 }, collegeAdmin);
  check("growing the programme is unaffected (200, term count 4)", growRes.status === 200 && growRes.data?.termCount === 4, `HTTP ${growRes.status} ${JSON.stringify(growRes.data)}`);

  // The guard changes nothing about the existing confinement rules.
  const foreignPatch = await patch(`/api/programs/${FOREIGN_PROG}`, { durationYears: 1 }, collegeAdmin);
  check("a FOREIGN tenant programme is still not-found on PATCH (no oracle)", foreignPatch.status === 404, `HTTP ${foreignPatch.status} ${foreignPatch.error || ""}`);
  const branchPatch = await patch(`/api/programs/${PROG_B}`, { durationYears: 1 }, collegeBranchAdmin);
  check("a branch-A admin still cannot PATCH a branch-B programme (403)", branchPatch.status === 403, `HTTP ${branchPatch.status} ${branchPatch.error || ""}`);
}

/* ---------------------------------------------- whole-programme ladder (Phase 5d) */
console.log("\n### the whole-programme ladder — every cohort moves exactly one step");
{
  // A fresh 3-term programme. Term 1 holds an on-roll student in branch A AND one
  // in branch B (the branch probe); term 2 holds an on-roll student (flagged with a
  // classId) plus a TRANSFERRED one; term 3 holds an on-roll student plus an ALUMNI
  // one. A student of ANOTHER programme sits at term 2 as well.
  const LAD = await makeProgram("lad", 3, BRANCH_A);
  const OTHERP = await makeProgram("ladother", 3, BRANCH_A);
  check("the two ladder programmes were created (201)", !!LAD && !!OTHERP, `${LAD} / ${OTHERP}`);

  const l1 = await makeStudent("lad1", { programId: LAD, termNumber: 1, branchId: BRANCH_A });
  const lB = await makeStudent("ladb", { programId: LAD, termNumber: 1, branchId: BRANCH_B });
  const l2 = await makeStudent("lad2", { programId: LAD, termNumber: 2, branchId: BRANCH_A, classId: `${M}class-lad-${stamp}` });
  const lTrans = await makeStudent("ladtrans", { programId: LAD, termNumber: 2, branchId: BRANCH_A, status: "TRANSFERRED" });
  const l3 = await makeStudent("lad3", { programId: LAD, termNumber: 3, branchId: BRANCH_A });
  const lAlum = await makeStudent("ladalum", { programId: LAD, termNumber: 3, branchId: BRANCH_A, status: "ALUMNI" });
  const lOther = await makeStudent("ladother1", { programId: OTHERP, termNumber: 2, branchId: BRANCH_A });
  const REG_L1 = await makeRegistration("ladt1", { studentId: l1, programId: LAD, termNumber: 1 });
  check(
    "the seven ladder students and their registration were written",
    [l1, lB, l2, lTrans, l3, lAlum, lOther].every(Boolean) && !!REG_L1,
    `${created.students.length} student row(s) tracked in total`
  );

  const lar = (id, cookie) => req(`/api/college-promotion/ladder?programId=${encodeURIComponent(id)}`, { cookie });
  const ladderPost = (body, cookie) => post("/api/college-promotion/ladder", body, cookie);

  /* -------- the plan -------- */
  const plan = await lar(LAD, collegeAdmin);
  check("GET the ladder plan → 200", plan.status === 200, `HTTP ${plan.status} ${plan.error || ""}`);
  const steps = plan.data?.steps || [];
  check(
    "…one step per term, ASCENDING, each naming its destination (1→2, 2→3, 3→graduation)",
    plan.data?.termCount === 3 && steps.length === 3 &&
      steps[0].fromTermNumber === 1 && steps[0].toTermNumber === 2 && steps[0].graduating === false &&
      steps[1].fromTermNumber === 2 && steps[1].toTermNumber === 3 && steps[1].graduating === false &&
      steps[2].fromTermNumber === 3 && steps[2].toTermNumber === null && steps[2].graduating === true,
    JSON.stringify(steps.map((s) => [s.fromTermNumber, s.toTermNumber, s.graduating]))
  );
  const stepIds = (i) => (steps[i]?.rows || []).map((r) => r.studentId);
  check(
    "…each step's cohort is strict and ON_ROLL-only (ALUMNI/TRANSFERRED/other-programme excluded)",
    steps[0].count === 2 && stepIds(0).includes(l1) && stepIds(0).includes(lB) &&
      steps[1].count === 1 && stepIds(1)[0] === l2 &&
      steps[2].count === 1 && stepIds(2)[0] === l3 &&
      !JSON.stringify(steps).includes(lAlum) && !JSON.stringify(steps).includes(lTrans) && !JSON.stringify(steps).includes(lOther),
    JSON.stringify(steps.map((s) => [s.count, (s.rows || []).map((r) => r.studentId)]))
  );
  check(
    "…the plan's totals sum the steps (4 students, 3 advance / 1 graduate, the D4 warning and the term-filtered D6 pending count)",
    plan.data?.count === 4 && plan.data?.counts?.advance === 3 && plan.data?.counts?.graduate === 1 &&
      plan.data?.counts?.classIdWarnings === 1 && plan.data?.counts?.pendingRegistrations === 1,
    `count=${plan.data?.count} ${JSON.stringify(plan.data?.counts)}`
  );

  /* -------- guards on the new surface -------- */
  const branchPlan = await lar(LAD, collegeBranchAdmin);
  check(
    "…a branch-A admin's plan excludes the same programme's branch-B student",
    branchPlan.status === 200 && branchPlan.data?.count === 3 && !JSON.stringify(branchPlan.data?.steps || []).includes(lB),
    `HTTP ${branchPlan.status} count=${branchPlan.data?.count}`
  );
  const branchProg = await lar(PROG_B, collegeBranchAdmin);
  check("…and it cannot ladder a branch-B programme at all (403)", branchProg.status === 403, `HTTP ${branchProg.status} ${branchProg.error || ""}`);
  const anon = await lar(LAD, undefined);
  check("…anonymous GET is 401", anon.status === 401, `HTTP ${anon.status}`);
  const wrongRole = await lar(LAD, accountant);
  check("…an ACCOUNTANT is 403 (no `registration` action, and there is no accountant bypass)", wrongRole.status === 403, `HTTP ${wrongRole.status}`);
  const schoolPlan = await lar(LAD, schoolAdmin);
  check("…a SCHOOL tenant is 403 — the college gate, not the permission", schoolPlan.status === 403, `HTTP ${schoolPlan.status}`);
  const noId = await req("/api/college-promotion/ladder", { cookie: collegeAdmin });
  check("…a missing programId is 400", noId.status === 400, `HTTP ${noId.status} ${noId.error || ""}`);
  const foreignGet = await lar(FOREIGN_PROG, collegeAdmin);
  check("…a FOREIGN programme id is the same 400, never a 404 oracle", foreignGet.status === 400, `HTTP ${foreignGet.status} ${foreignGet.error || ""}`);

  /* -------- the run: the ordering proof -------- */
  const run = await ladderPost({ programId: LAD }, collegeAdmin);
  check("POST the whole ladder → 200", run.status === 200, `HTTP ${run.status} ${run.error || ""}`);
  check(
    "…and reports 3 advanced / 1 graduated / 0 failed across 3 steps",
    run.data?.promoted === 3 && run.data?.graduated === 1 && run.data?.failed === 0 && (run.data?.steps || []).length === 3,
    JSON.stringify(run.data)
  );
  const r1 = await readStudent(l1), rB = await readStudent(lB), r2 = await readStudent(l2), r3 = await readStudent(l3);
  check(
    "…EVERY cohort moved exactly ONE step (1→2, 1→2, 2→3, 3→ALUMNI) — the DESCENDING order, proved",
    r1.termNumber === 2 && rB.termNumber === 2 && r2.termNumber === 3 && r3.status === "ALUMNI",
    `l1=${r1.termNumber} lB=${rB.termNumber} l2=${r2.termNumber} l3=${r3.status}`
  );
  check(
    "…ALUMNI and TRANSFERRED students were never moved (ON_ROLL_STUDENT, reused verbatim)",
    (await readStudent(lAlum)).status === "ALUMNI" && (await readStudent(lAlum)).termNumber === 3 &&
      (await readStudent(lTrans)).status === "TRANSFERRED" && (await readStudent(lTrans)).termNumber === 2,
    `alum=${(await readStudent(lAlum)).status} trans=${(await readStudent(lTrans)).status}`
  );
  const regDoc = (await db.collection("courseRegistrations").doc(REG_L1).get()).data() || {};
  check("…registrations are untouched (D7 — still PENDING at term 1)", regDoc.status === "PENDING" && regDoc.termNumber === 1, `${regDoc.status}@${regDoc.termNumber}`);

  // D-5d2-5 — the SUCCESS audit row now carries the per-step breakdown, so a run is
  // reconstructable server-side and not only from the response body.
  const okAudit = (await db.collection("auditLogs").where("entityId", "==", LAD).get()).docs
    .map((d) => d.data())
    .find((a) => a.action === "COLLEGE_PROMOTION" && a.details?.scope === "PROGRAMME_LADDER");
  check(
    "…the run wrote ONE audit row carrying status OK and the per-step breakdown (terms 1,2,3)",
    okAudit?.details?.status === "OK" &&
      Array.isArray(okAudit?.details?.steps) &&
      okAudit.details.steps.length === 3 &&
      okAudit.details.steps.map((s) => s.fromTermNumber).join(",") === "1,2,3" &&
      okAudit.details.steps[2].graduated === 1,
    `status=${okAudit?.details?.status} steps=${JSON.stringify(okAudit?.details?.steps || null)}`
  );

  const after1 = await lar(LAD, collegeAdmin);
  const s1 = after1.data?.steps || [];
  check(
    "…the plan now reflects the new state (term 1 empty, term 2 the two movers, term 3 the term-2 one)",
    after1.data?.count === 3 &&
      s1[0]?.count === 0 && s1[1]?.count === 2 && s1[2]?.count === 1 &&
      (s1[1]?.rows || []).map((r) => r.studentId).sort().join(",") === [l1, lB].sort().join(",") &&
      s1[2]?.rows?.[0]?.studentId === l2,
    `count=${after1.data?.count} steps=${JSON.stringify(s1.map((x) => x.count))}`
  );

  // A ladder run is NOT a per-position no-op: it advances one step, so running it
  // again is a legitimate SECOND advance — and each student still moves exactly one.
  const run2 = await ladderPost({ programId: LAD }, collegeAdmin);
  const r1b = await readStudent(l1), rBb = await readStudent(lB), r2b = await readStudent(l2);
  check(
    "…a second run advances each ACTIVE student one more step (1s and 2 → 3, the term-3 one graduates)",
    run2.status === 200 && run2.data?.promoted === 2 && run2.data?.graduated === 1 &&
      r1b.termNumber === 3 && rBb.termNumber === 3 && r2b.status === "ALUMNI",
    `HTTP ${run2.status} ${JSON.stringify(run2.data)} | l1=${r1b.termNumber} l2=${r2b.status}`
  );
  check(
    "…and the TRANSFERRED student is STILL untouched after two runs",
    (await readStudent(lTrans)).termNumber === 2 && (await readStudent(lTrans)).status === "TRANSFERRED",
    `trans=${(await readStudent(lTrans)).termNumber}/${(await readStudent(lTrans)).status}`
  );

  // Each refusal is bracketed by its OWN before/after snapshot, so a stray write
  // by either one is visible even though the ladder has already moved rows twice.
  const beforeSchool = await snapshot();
  const schoolRun = await ladderPost({ programId: OTHERP }, schoolAdmin);
  check(
    "a SCHOOL tenant's ladder run is 403 and writes nothing",
    schoolRun.status === 403 && sameSnapshot(beforeSchool, await snapshot()),
    `HTTP ${schoolRun.status}`
  );
  const beforeForeign = await snapshot();
  const foreignRun = await ladderPost({ programId: FOREIGN_PROG }, collegeAdmin);
  check(
    "a FOREIGN programme's ladder run is the same 400, with no write",
    foreignRun.status === 400 && sameSnapshot(beforeForeign, await snapshot()),
    `HTTP ${foreignRun.status} ${foreignRun.error || ""}`
  );
}

/* ------------------------------------------- the ladder FAILS SAFELY (Phase 5d-2) */
console.log("\n### the ladder fails safely — a partial run reports + audits, and finishing never double-advances");
{
  const lar = (id, cookie) => req(`/api/college-promotion/ladder?programId=${encodeURIComponent(id)}`, { cookie });
  const ladderPost = (body, cookie) => post("/api/college-promotion/ladder", body, cookie);

  // A fresh 3-term programme. The run walks DESCENDING, so term 3 COMPLETES, term 2
  // FAILS (injected, before it writes) and term 1 is never ATTEMPTED — the report
  // must name all three.
  const FAILLAD = await makeProgram("faillad", 3, BRANCH_A);
  check("the fail-safe programme was created (201)", !!FAILLAD, `${FAILLAD}`);

  const f3 = await makeStudent("fail3", { programId: FAILLAD, termNumber: 3, branchId: BRANCH_A });
  const f2 = await makeStudent("fail2", { programId: FAILLAD, termNumber: 2, branchId: BRANCH_A });
  const f1 = await makeStudent("fail1", { programId: FAILLAD, termNumber: 1, branchId: BRANCH_A });

  injectFault(FAILLAD, 2);
  const partial = await ladderPost({ programId: FAILLAD }, collegeAdmin);
  clearFault();

  check("an injected mid-run failure answers HTTP 500 — not a crash, and not a 2xx", partial.status === 500, `HTTP ${partial.status}`);
  check(
    "…with the structured report: status PARTIAL and the COMPLETED step (term 3, 1 graduated)",
    partial.data?.status === "PARTIAL" &&
      (partial.data?.completed || []).length === 1 &&
      partial.data.completed[0].fromTermNumber === 3 &&
      partial.data.completed[0].graduated === 1,
    `status=${partial.data?.status} completed=${JSON.stringify(partial.data?.completed || null)}`
  );
  check(
    "…the FAILED step is named (term 2) and the terms never ATTEMPTED are listed (term 1) — plus the finish order",
    partial.data?.failedStep?.fromTermNumber === 2 &&
      Array.isArray(partial.data?.remainingTerms) && partial.data.remainingTerms.join(",") === "1" &&
      (partial.data?.finishTerms || []).join(",") === "2,1",
    `failed=${JSON.stringify(partial.data?.failedStep || null)} remaining=${JSON.stringify(partial.data?.remainingTerms)} finish=${JSON.stringify(partial.data?.finishTerms)}`
  );
  check(
    "…the error text names the applied term, the failed term and the remaining term, and points at the single-position route",
    /term 3/.test(partial.error || "") && /term 2/.test(partial.error || "") && /term 1/.test(partial.error || "") &&
      /college-promotion/.test(partial.error || "") && /descending/.test(partial.error || ""),
    `${partial.error}`
  );
  check(
    "…the COMPLETED step really landed while the failed step and the untouched term wrote nothing",
    (await readStudent(f3)).status === "ALUMNI" &&
      (await readStudent(f2)).termNumber === 2 && (await readStudent(f2)).status === "ACTIVE" &&
      (await readStudent(f1)).termNumber === 1 && (await readStudent(f1)).status === "ACTIVE",
    `f3=${(await readStudent(f3)).status} f2=${(await readStudent(f2)).termNumber}/${(await readStudent(f2)).status} f1=${(await readStudent(f1)).termNumber}`
  );

  const partialAudit = (await db.collection("auditLogs").where("entityId", "==", FAILLAD).get()).docs
    .map((d) => d.data())
    .find((a) => a.action === "COLLEGE_PROMOTION" && a.details?.scope === "PROGRAMME_LADDER");
  check(
    "…and the FAILURE is audited (PROGRAMME_LADDER, status PARTIAL, the completed step and the remaining term recorded)",
    partialAudit?.details?.status === "PARTIAL" &&
      (partialAudit?.details?.completed || []).length === 1 &&
      partialAudit.details.completed[0].fromTermNumber === 3 &&
      (partialAudit?.details?.remainingTerms || []).join(",") === "1",
    `audit=${JSON.stringify(partialAudit?.details || null)}`
  );

  // Finish with the SINGLE-POSITION route, DESCENDING — the failed term, then the
  // not-attempted one. This must complete the ladder with every student moved EXACTLY
  // once: nobody is advanced a second time (re-running the LADDER would do that).
  const finish2 = await apply(FAILLAD, 2, collegeAdmin);
  const finish1 = await apply(FAILLAD, 1, collegeAdmin);
  check(
    "the remaining terms finish cleanly with the single-position apply (term 2, then term 1)",
    finish2.status === 200 && finish2.data?.promoted === 1 && finish1.status === 200 && finish1.data?.promoted === 1,
    `term2=${finish2.status}/${finish2.data?.promoted} term1=${finish1.status}/${finish1.data?.promoted}`
  );
  check(
    "…and EVERY student advanced EXACTLY once (f1→2, f2→3, f3 graduated once — NO double-advance)",
    (await readStudent(f1)).termNumber === 2 && (await readStudent(f1)).status === "ACTIVE" &&
      (await readStudent(f2)).termNumber === 3 && (await readStudent(f2)).status === "ACTIVE" &&
      (await readStudent(f3)).status === "ALUMNI" && (await readStudent(f3)).termNumber === 3,
    `f1=${(await readStudent(f1)).termNumber}/${(await readStudent(f1)).status} f2=${(await readStudent(f2)).termNumber}/${(await readStudent(f2)).status} f3=${(await readStudent(f3)).status}`
  );
  // Finishing the remaining terms with the single-position route completes the SAME
  // single step, so every student now sits one term further: the plan is NOT empty.
  // That is precisely why re-running the LADDER is forbidden — it would move the two
  // students it already moved a SECOND time (the very double-advance the message warns
  // about). Asserted positively: the plan names exactly those two students.
  const donePlan = await lar(FAILLAD, collegeAdmin);
  const doneIds = (donePlan.data?.steps || []).flatMap((s) => (s.rows || []).map((r) => r.studentId));
  check(
    "…the finished programme sits one step further for everyone, and the ladder's plan NAMES those two students (so a ladder re-run would double-advance them)",
    donePlan.status === 200 && donePlan.data?.count === 2 && doneIds.length === 2 &&
      doneIds.includes(f1) && doneIds.includes(f2),
    `count=${donePlan.data?.count} ids=${JSON.stringify(doneIds)}`
  );
}

/* --------------------------- the ladder at a size that needs MORE THAN ONE slice */
console.log("\n### a ladder bigger than one ≤400-op batch still completes (no cap, no refusal)");
{
  const ladderPost = (body, cookie) => post("/api/college-promotion/ladder", body, cookie);
  const BIGLAD = await makeProgram("biglad", 2, BRANCH_A);
  check("the large 2-term programme was created (201)", !!BIGLAD, `${BIGLAD}`);

  // 405 students at term 1 — one more than PROMOTION_BATCH, so that step MUST span two
  // slices — plus one at term 2 (the graduating step).
  const many = await makeCohort("big", 405, { programId: BIGLAD, termNumber: 1 });
  const big2 = await makeStudent("big2", { programId: BIGLAD, termNumber: 2, branchId: BRANCH_A });
  check("…with 405 students at term 1 and 1 at term 2", many.length === 405 && !!big2, `405 + ${big2 ? 1 : 0}`);

  const bigRun = await ladderPost({ programId: BIGLAD }, collegeAdmin);
  check(
    "the run completes across more than one slice (405 advanced / 1 graduated / 0 failed)",
    bigRun.status === 200 && bigRun.data?.promoted === 405 && bigRun.data?.graduated === 1 && bigRun.data?.failed === 0,
    `HTTP ${bigRun.status} p=${bigRun.data?.promoted} g=${bigRun.data?.graduated} f=${bigRun.data?.failed}`
  );
  const bigRows = (await db.collection("students").where("programId", "==", BIGLAD).get()).docs.map((d) => d.data());
  const onRollAt2 = bigRows.filter((s) => s.termNumber === 2 && s.status === "ACTIVE").length;
  const alumni = bigRows.filter((s) => s.status === "ALUMNI").length;
  check(
    "…and every one of the 405 moved exactly one step (all ON-ROLL at term 2, only term-2's original graduates)",
    bigRows.length === 406 && onRollAt2 === 405 && alumni === 1,
    `rows=${bigRows.length} onRoll@2=${onRollAt2} alumni=${alumni}`
  );
}

/* -------------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
{
  for (const id of created.registrations) await db.collection("courseRegistrations").doc(id).delete().catch(() => null);
  for (const id of created.students) await db.collection("students").doc(id).delete().catch(() => null);
  for (const id of created.programs) await db.collection("programs").doc(id).delete().catch(() => null);
  for (const id of created.users) await db.collection("users").doc(id).delete().catch(() => null);
  // The audit rows the app wrote for OUR programmes (PROGRAM_CREATE and the apply's
  // COLLEGE_PROMOTION both carry the programme id as entityId).
  for (const pid of created.programIdsForAudit) {
    const snaps = await db.collection("auditLogs").where("entityId", "==", pid).get();
    for (const d of snaps.docs) await d.ref.delete().catch(() => null);
  }

  clearFault(); // the injected-fault file must never outlive this verifier

  const leftovers = [];
  for (const col of ["students", "programs", "courseRegistrations", "users"]) {
    const snap = await db.collection(col).where("__name__", ">=", M).where("__name__", "<=", M + "\uf8ff").get();
    if (snap.size) leftovers.push(`${col}:${snap.size}`);
  }
  let auditLeft = 0;
  for (const pid of created.programIdsForAudit) {
    auditLeft += (await db.collection("auditLogs").where("entityId", "==", pid).get()).size;
  }
  check(
    "every zzcp- row this verifier created is gone (students/programmes/registrations/users/audit)",
    leftovers.length === 0 && auditLeft === 0,
    `${leftovers.join(", ") || "no rows"} | audit=${auditLeft}`
  );
  check(
    "…and the injected-fault file is gone (no test seam is left behind)",
    !existsSync(FAULT_FILE),
    FAULT_FILE
  );
}

console.log(
  failures
    ? `\n❌ ${failures} college-promotion API failure(s) (of ${checks} checks)`
    : `\n✅ COLLEGE PROMOTION API OK — preview/apply, strict cohort, branch + tenant confinement, SCHOOL 403 with no write, idempotent re-run, ALUMNI graduation, programme shrink guard, whole-programme ladder (${checks} checks)`
);
process.exit(failures ? 1 : 0);
