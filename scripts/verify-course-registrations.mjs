#!/usr/bin/env node
/**
 * verify-course-registrations.mjs — Phase 4b: the course-registration API + guards.
 *
 * Runs over HTTP against the COLLEGE fixture tenant (scripts/isolation-fixture.mjs)
 * and proves the registration half of plan-Phase 4:
 *
 *   • create derives programId + termNumber from the student and the mapping;
 *     a termNumber that disagrees is 400, a foreign/missing id is the SAME 400;
 *   • the course must be mapped to the STUDENT's programme;
 *   • a SCHOOL tenant is 403 with no write; a wrong role is 403;
 *   • duplicate (studentId, courseId, termNumber) is 409 among PENDING/APPROVED
 *     only — a REJECTED row never blocks a re-registration;
 *   • decide (PENDING → APPROVED/REJECTED) then terminal: re-decide 409, delete 409;
 *   • only PENDING can be withdrawn; delete of a decided row is 409;
 *   • branch confinement: a branch-A admin cannot read/decide/withdraw a branch-B row;
 *   • a mapping or a course cannot be deleted under a PENDING/APPROVED registration;
 *   • a dangling course (deleted after its REJECTED row) renders as unavailable, no crash.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-course-registrations.mjs
 * Needs the isolation fixture:  node scripts/isolation-fixture.mjs create
 *
 * Creates and cleans up ALL of its own rows (a college ACCOUNTANT user, temp
 * students/programmes/courses/mappings and every registration); it never edits
 * the fixture and leaves no `zzcr-` docs behind.
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
/** Our own id prefix for rows this verifier creates. */
const M = "zzcr-";

const TRACK = new URL(".qa-fixtures.json", import.meta.url);
if (!existsSync(TRACK)) {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(1);
}
const CRED = JSON.parse(readFileSync(TRACK, "utf8")).creds || {};
if (!CRED.collegeAdmin || !CRED.collegeBranchAdmin || !CRED.admin) {
  console.error("❌ Track file lacks college credentials — re-run: node scripts/isolation-fixture.mjs clean && create");
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

const COLLEGE = `${P}college`;
const DEPT_A = `${P}col-dept-a`;
const PROG_A = `${P}col-prog-a`;
const PROG_B = `${P}col-prog-b`;
const COURSE_A = `${P}col-course-a`;
const COURSE_B = `${P}col-course-b`;
const MAP_A = `${P}col-map-a`;
const BRANCH_A = `${P}col-br-a`;
const BRANCH_B = `${P}col-br-b`;
const FOREIGN_STUDENT = `${P}student`; // the SCHOOL tenant's student
const FOREIGN_COURSE = `${P}both-course`; // the BOTH tenant's course

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

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
const get = (path, cookie) => req(path, { cookie });
const post = (path, body, cookie) => req(path, { cookie, method: "POST", body: JSON.stringify(body) });
const patch = (path, body, cookie) => req(path, { cookie, method: "PATCH", body: JSON.stringify(body) });
const del = (path, cookie) => req(path, { cookie, method: "DELETE" });

const collegeAdmin = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
const collegeBranchAdmin = await login("zz-iso-college-br-admin@test.local", CRED.collegeBranchAdmin);
const schoolAdmin = await login("zz-iso-admin@test.local", CRED.admin);

const stamp = Date.now();

/* ------------------------------------------------------------- tracking + cleanup */
const created = { registrations: [], students: [], programs: [], courses: [], mappings: [], users: [] };
const acctEmail = `${M}accountant-${stamp}@test.local`;
// An email has a DETERMINISTIC user id (`u_<sha1(email)>`, src/lib/db.ts), which
// is the read the login route uses for an email sign-in — so write the doc under
// that exact id or the sign-in misses it.
const acctUserId = `u_${createHash("sha1").update(acctEmail.toLowerCase()).digest("hex")}`;
{
  const password = "zzcr-Pass-12345";
  await db.collection("users").doc(acctUserId).set({
    name: `ZZCR Accountant ${stamp}`, email: acctEmail, role: "ACCOUNTANT",
    schoolId: COLLEGE, scope: null, branchId: null, active: true,
    passwordHash: bcrypt.hashSync(password, 10),
  });
  created.users.push(acctUserId);
}
const accountant = await login(acctEmail, "zzcr-Pass-12345");

/** Create a college student enrolled into `programId` (0 → none). Returns { id, admissionNo }. */
async function makeStudent(tag, programId, cookie = collegeAdmin) {
  const admissionNo = `${M}${tag}-${stamp}`;
  const r = await post("/api/students", {
    name: `ZZCR ${tag} ${stamp}`, admissionNo, createFees: false, createGuardian: false,
    ...(programId ? { programId, termNumber: 1 } : {}),
  }, cookie);
  if (r.data?.id) created.students.push(r.data.id);
  return { status: r.status, id: r.data?.id || null, admissionNo, data: r.data };
}
async function makeProgram(tag) {
  const r = await post("/api/programs", {
    name: `ZZCR Program ${tag} ${stamp}`, code: `${M}P-${tag}-${stamp}`,
    departmentId: DEPT_A, degreeLevel: "HSC", durationYears: 2,
  }, collegeAdmin);
  if (r.data?.id) created.programs.push(r.data.id);
  return r.data?.id || null;
}
async function makeCourse(tag) {
  const r = await post("/api/courses", {
    code: `${M}C-${tag}-${stamp}`, title: `ZZCR Course ${tag} ${stamp}`, departmentId: DEPT_A, type: "THEORY",
  }, collegeAdmin);
  if (r.data?.id) created.courses.push(r.data.id);
  return r.data?.id || null;
}
async function makeMapping(programId, courseId, termNumber = 1) {
  const r = await post(`/api/programs/${programId}/courses`, { courseId, termNumber, requirement: "REQUIRED" }, collegeAdmin);
  if (r.data?.id) created.mappings.push({ programId, mappingId: r.data.id });
  return r.data?.id || null;
}
async function makeRegistration(studentId, courseId, cookie = collegeAdmin, extra = {}) {
  const r = await post("/api/course-registrations", { studentId, courseId, ...extra }, cookie);
  if (r.data?.id) created.registrations.push(r.data.id);
  return r;
}

const termOf = async (mappingId) => {
  const d = await db.collection("programCourses").doc(mappingId).get();
  return Number(d.data()?.termNumber);
};

const mapTerm = await termOf(MAP_A);

/* ------------------------------------------------------ create: derive + validate */
console.log("\n### create — the server derives programme + term, and validates");
const stuA = await makeStudent("STU-A", PROG_A);
check("a COLLEGE student is enrolled into programme A (201)", stuA.status === 201 && !!stuA.id, `HTTP ${stuA.status} ${stuA.data?.error || ""}`);

let regA = null;
{
  const r = await makeRegistration(stuA.id, COURSE_A);
  regA = r.data?.id || null;
  check(
    "a registration is created (201) with PENDING, the student's programme and the mapping's term",
    r.status === 201 && r.data?.status === "PENDING" && r.data?.programId === PROG_A && r.data?.termNumber === mapTerm && r.data?.branchId === BRANCH_A,
    `HTTP ${r.status} status=${r.data?.status} program=${r.data?.programId} term=${r.data?.termNumber} branch=${r.data?.branchId}`
  );
  check("…and requestedById is recorded, decidedBy is not yet", !!r.data?.requestedById && r.data?.decidedById == null, `requestedBy=${r.data?.requestedById} decidedBy=${r.data?.decidedById}`);
}
{
  const r = await makeRegistration(stuA.id, COURSE_A, collegeAdmin, { termNumber: mapTerm + 5 });
  check("a termNumber that disagrees with the mapping is 400", r.status === 400, `HTTP ${r.status} ${r.error || ""}`);
}
{
  const plain = await makeStudent("STU-PLAIN", null);
  const r = await makeRegistration(plain.id, COURSE_A);
  check("a student not enrolled in a programme is 400", r.status === 400, `HTTP ${r.status} ${r.error || ""}`);
}
{
  const foreign = await makeRegistration(FOREIGN_STUDENT, COURSE_A);
  const ghost = await makeRegistration(`${M}no-such-student`, COURSE_A);
  check(
    "a foreign studentId is 400, byte-identical to a non-existent one (no oracle)",
    foreign.status === 400 && ghost.status === 400 && foreign.error === ghost.error,
    `foreign=${JSON.stringify(foreign.error)} ghost=${JSON.stringify(ghost.error)}`
  );
}
{
  const foreign = await makeRegistration(stuA.id, FOREIGN_COURSE);
  const ghost = await makeRegistration(stuA.id, `${M}no-such-course`);
  check(
    "a foreign courseId is 400, byte-identical to a non-existent one (no oracle)",
    foreign.status === 400 && ghost.status === 400 && foreign.error === ghost.error,
    `foreign=${JSON.stringify(foreign.error)} ghost=${JSON.stringify(ghost.error)}`
  );
}
{
  const r = await makeRegistration(stuA.id, COURSE_B);
  check("a course not mapped to the student's programme is 400", r.status === 400, `HTTP ${r.status} ${r.error || ""}`);
}
{
  const r = await makeRegistration(stuA.id, COURSE_A);
  check("a duplicate (student, course, term) is 409 among PENDING/APPROVED", r.status === 409, `HTTP ${r.status} ${r.error || ""}`);
}
{
  const before = (await db.collection("courseRegistrations").where("schoolId", "==", `${P}school`).get()).size;
  const r = await makeRegistration(stuA.id, COURSE_A, schoolAdmin);
  const after = (await db.collection("courseRegistrations").where("schoolId", "==", `${P}school`).get()).size;
  check("a SCHOOL tenant is 403 and writes no row", r.status === 403 && before === after, `HTTP ${r.status} rows ${before}→${after}`);
}
{
  const r = await makeRegistration(stuA.id, COURSE_A, accountant);
  check("a wrong role (ACCOUNTANT) is 403", r.status === 403, `HTTP ${r.status} ${r.error || ""}`);
}
{
  const stuB = await makeStudent("STU-B", PROG_B);
  const r = await makeRegistration(stuB.id, COURSE_B, collegeBranchAdmin);
  check("a branch-A admin cannot create a registration in programme B (403)", r.status === 403, `HTTP ${r.status} ${r.error || ""}`);
}

/* ----------------------------------------------------------- decide / withdraw */
console.log("\n### decide and withdraw — PENDING only, decided is terminal");
{
  const r = await patch(`/api/course-registrations/${regA}`, { status: "APPROVED" }, collegeAdmin);
  check("a PENDING row is decided APPROVED (200) with decidedAt/decidedBy", r.status === 200 && r.data?.status === "APPROVED" && !!r.data?.decidedById && !!r.data?.decidedAt, `HTTP ${r.status} status=${r.data?.status}`);
  const again = await patch(`/api/course-registrations/${regA}`, { status: "REJECTED" }, collegeAdmin);
  check("re-deciding a decided row is 409", again.status === 409, `HTTP ${again.status} ${again.error || ""}`);
  const badStatus = await patch(`/api/course-registrations/${regA}`, { status: "PENDING" }, collegeAdmin);
  check("deciding to a non-decision status is 400", badStatus.status === 400, `HTTP ${badStatus.status} ${badStatus.error || ""}`);
  const deld = await del(`/api/course-registrations/${regA}`, collegeAdmin);
  check("deleting an APPROVED row is 409", deld.status === 409, `HTTP ${deld.status} ${deld.error || ""}`);
  const dup = await makeRegistration(stuA.id, COURSE_A);
  check("…and an APPROVED row still blocks a duplicate (409)", dup.status === 409, `HTTP ${dup.status}`);
}
{
  // A second student: REJECTED never blocks a re-registration.
  const stu2 = await makeStudent("STU-2", PROG_A);
  const first = await makeRegistration(stu2.id, COURSE_A);
  const rejected = await patch(`/api/course-registrations/${first.data.id}`, { status: "REJECTED" }, collegeAdmin);
  check("a PENDING row is decided REJECTED (200)", rejected.status === 200 && rejected.data?.status === "REJECTED", `HTTP ${rejected.status}`);
  const retry = await makeRegistration(stu2.id, COURSE_A);
  check("a REJECTED row does NOT block a re-registration (201)", retry.status === 201, `HTTP ${retry.status} ${retry.error || ""}`);
  const deld = await del(`/api/course-registrations/${first.data.id}`, collegeAdmin);
  check("deleting a REJECTED row is 409", deld.status === 409, `HTTP ${deld.status}`);
}
{
  // A third student: PENDING can be withdrawn.
  const stu3 = await makeStudent("STU-3", PROG_A);
  const r = await makeRegistration(stu3.id, COURSE_A);
  const deld = await del(`/api/course-registrations/${r.data.id}`, collegeAdmin);
  check("a PENDING row can be withdrawn (DELETE 200)", deld.status === 200, `HTTP ${deld.status} ${deld.error || ""}`);
  const gone = await get(`/api/course-registrations/${r.data.id}`, collegeAdmin);
  check("…and is then not found (404)", gone.status === 404, `HTTP ${gone.status}`);
}

/* ------------------------------------------------------------- auth / path ids */
console.log("\n### auth, tenant and path-id guards");
{
  const unauth = await get("/api/course-registrations");
  check("an unauthenticated request is 401", unauth.status === 401, `HTTP ${unauth.status}`);
  const sc = await get("/api/course-registrations", schoolAdmin);
  check("a SCHOOL tenant list is 403", sc.status === 403, `HTTP ${sc.status}`);
  const ar = await get("/api/course-registrations", accountant);
  check("a wrong role list is 403", ar.status === 403, `HTTP ${ar.status}`);
  const ghost = await get(`/api/course-registrations/${M}no-such-reg`, collegeAdmin);
  check("a non-existent registration id is 404 (never 403)", ghost.status === 404, `HTTP ${ghost.status}`);
  const ghostPatch = await patch(`/api/course-registrations/${M}no-such-reg`, { status: "APPROVED" }, collegeAdmin);
  const ghostDel = await del(`/api/course-registrations/${M}no-such-reg`, collegeAdmin);
  check("…and PATCH/DELETE on it are 404 too", ghostPatch.status === 404 && ghostDel.status === 404, `PATCH ${ghostPatch.status} DELETE ${ghostDel.status}`);
}

/* ---------------------------------------------------------- branch confinement */
console.log("\n### branch confinement — a branch-A admin cannot touch a branch-B row");
{
  const stuB = await makeStudent("STU-B2", PROG_B);
  const r = await makeRegistration(stuB.id, COURSE_B, collegeAdmin);
  check("a branch-B registration is created by the school-scope admin (201)", r.status === 201 && r.data?.branchId === BRANCH_B, `HTTP ${r.status} branch=${r.data?.branchId}`);
  const regB = r.data.id;
  const g = await get(`/api/course-registrations/${regB}`, collegeBranchAdmin);
  const p = await patch(`/api/course-registrations/${regB}`, { status: "APPROVED" }, collegeBranchAdmin);
  const d = await del(`/api/course-registrations/${regB}`, collegeBranchAdmin);
  check(
    "the branch-A admin is 403 on GET/PATCH/DELETE of the branch-B row",
    g.status === 403 && p.status === 403 && d.status === 403,
    `GET ${g.status} PATCH ${p.status} DELETE ${d.status}`
  );
  const list = await get("/api/course-registrations", collegeBranchAdmin);
  const ids = (list.data || []).map((r) => r.id);
  check("the branch-A admin's list never includes the branch-B row", !ids.includes(regB), `list size ${ids.length}`);
}

/* -------------------------------------------------- mapping / course delete guards */
console.log("\n### a mapping or a course cannot be deleted under a registration");
{
  const tp = await makeProgram("GUARD");
  const tc = await makeCourse("GUARD");
  const tm = await makeMapping(tp, tc, 1);
  const ts = await makeStudent("STU-GUARD", tp);
  const reg = await makeRegistration(ts.id, tc);
  check("the throwaway programme/course/mapping/registration are in place (201)", !!tp && !!tc && !!tm && reg.status === 201, `prog=${!!tp} course=${!!tc} map=${!!tm} reg=${reg.status}`);

  const mapDel = await del(`/api/programs/${tp}/courses?mappingId=${tm}`, collegeAdmin);
  check("the mapping DELETE is blocked while a PENDING registration exists (400)", mapDel.status === 400, `HTTP ${mapDel.status} ${mapDel.error || ""}`);
  const courseDel = await del(`/api/courses/${tc}`, collegeAdmin);
  check("the course DELETE is blocked while a PENDING registration exists (400)", courseDel.status === 400, `HTTP ${courseDel.status} ${courseDel.error || ""}`);

  await del(`/api/course-registrations/${reg.data.id}`, collegeAdmin);
  const mapDel2 = await del(`/api/programs/${tp}/courses?mappingId=${tm}`, collegeAdmin);
  check("after the withdrawal the mapping DELETE succeeds (200)", mapDel2.status === 200, `HTTP ${mapDel2.status} ${mapDel2.error || ""}`);
  const courseDel2 = await del(`/api/courses/${tc}`, collegeAdmin);
  check("…and then the course DELETE succeeds (200)", courseDel2.status === 200, `HTTP ${courseDel2.status} ${courseDel2.error || ""}`);
}

/* ------------------------------------------------------- dangling reference read */
console.log("\n### a dangling course renders as unavailable, never a crash");
{
  const tp = await makeProgram("DANGLE");
  const tc = await makeCourse("DANGLE");
  const tm = await makeMapping(tp, tc, 1);
  const ts = await makeStudent("STU-DANGLE", tp);
  const reg = await makeRegistration(ts.id, tc);
  await patch(`/api/course-registrations/${reg.data.id}`, { status: "REJECTED" }, collegeAdmin);
  const mapDel = await del(`/api/programs/${tp}/courses?mappingId=${tm}`, collegeAdmin);
  const courseDel = await del(`/api/courses/${tc}`, collegeAdmin);
  check("a REJECTED row does not block mapping/course deletion (200/200)", mapDel.status === 200 && courseDel.status === 200, `map ${mapDel.status} course ${courseDel.status}`);
  const one = await get(`/api/course-registrations/${reg.data.id}`, collegeAdmin);
  check(
    "the one-row GET returns the row with the course marked unavailable (200, no crash)",
    one.status === 200 && one.data?.courseAvailable === false && one.data?.courseCode === null,
    `HTTP ${one.status} courseAvailable=${one.data?.courseAvailable} courseCode=${JSON.stringify(one.data?.courseCode)}`
  );
  const li = await get(`/api/course-registrations?studentId=${ts.id}`, collegeAdmin);
  const row = (li.data || []).find((r) => r.id === reg.data.id);
  check("the list GET also returns it, no crash", li.status === 200 && !!row && row.courseAvailable === false, `HTTP ${li.status} found=${!!row} available=${row?.courseAvailable}`);
}

/* --------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
let cleaned = 0;
for (const id of created.registrations) { await db.collection("courseRegistrations").doc(id).delete().catch(() => null); cleaned++; }
for (const id of created.students) {
  for (const col of ["fees", "payments"]) {
    for (const x of (await db.collection(col).where("studentId", "==", id).get()).docs) await x.ref.delete();
  }
  await db.collection("students").doc(id).delete().catch(() => null);
  cleaned++;
}
for (const m of created.mappings) await db.collection("programCourses").doc(m.mappingId).delete().catch(() => null);
for (const id of created.courses) await db.collection("courses").doc(id).delete().catch(() => null);
for (const id of created.programs) await db.collection("programs").doc(id).delete().catch(() => null);
for (const id of created.users) await db.collection("users").doc(id).delete().catch(() => null);

// Proof of a clean sweep: no `zzcr-` row survives in the collections we touched.
const leftovers = [];
for (const col of ["courseRegistrations", "students", "programs", "courses", "programCourses", "users"]) {
  const snap = await db.collection(col).where("__name__", ">=", M).where("__name__", "<=", M + "\uf8ff").get();
  if (snap.size) leftovers.push(`${col}:${snap.size}`);
}
check("every zzcr- row this verifier created is gone", leftovers.length === 0, leftovers.join(", ") || "none");

console.log(
  failures
    ? `\n❌ ${failures} course-registration failure(s)`
    : "\n✅ COURSE REGISTRATIONS OK — create/decide/withdraw, duplicate + terminal rules, SCHOOL 403, branch confinement, mapping/course guards, dangling read"
);
process.exit(failures ? 1 : 0);
