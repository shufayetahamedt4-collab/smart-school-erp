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
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { requireEmulator } from "./lib/guard.mjs";

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

/** Read back the fields a promotion may change. */
const readStudent = async (id) => (await db.collection("students").doc(id).get()).data() || {};
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
}

console.log(
  failures
    ? `\n❌ ${failures} college-promotion API failure(s) (of ${checks} checks)`
    : `\n✅ COLLEGE PROMOTION API OK — preview/apply, strict cohort, branch + tenant confinement, SCHOOL 403 with no write, idempotent re-run, ALUMNI graduation (${checks} checks)`
);
process.exit(failures ? 1 : 0);
