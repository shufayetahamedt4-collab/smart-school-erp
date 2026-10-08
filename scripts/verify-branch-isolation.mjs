/**
 * verify-branch-isolation.mjs — Phase 4 import isolation under a REAL BRANCH_ADMIN.
 *
 * Creates two branches and a branch admin scoped to the first, then verifies:
 *   • the branch admin can import into its OWN branch;
 *   • it can read its own batch + credentials;
 *   • it cannot import into another branch (the branch is forced, not chosen);
 *   • it cannot read another branch's batch or credentials (404);
 *   • the credentials endpoint never leaks a cross-branch slip.
 *
 * Creates its own branch admin, branches, students and guardians; removes them
 * afterwards. Nothing pre-existing is touched.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-branch-isolation.mjs
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

loadEnv();
requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
/** Fixture id prefix (isolation-fixture.mjs) — the college tenant used below. */
const P = "zziso-";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

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

const HOSTS = { school: `school.localhost:${PORT}` };

async function req(host, path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Host: host, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* html / file */ }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null, setCookie: res.headers.get("set-cookie") || "", text };
}
async function login(host, identifier, password) {
  const r = await req(host, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
  if (r.status !== 200) throw new Error(`login ${identifier}: HTTP ${r.status} ${r.error || ""}`);
  return r.setCookie.split(";")[0];
}

const HEADERS = ["Name", "Admission No", "Roll", "Registration No", "Class", "Section", "Name (Bangla)", "Date of Birth", "Gender", "Blood Group", "Birth Certificate No", "Address", "Previous School", "Previous School Class", "Guardian Name", "Guardian Phone", "Guardian Email", "Guardian Relation", "Photo URL"];
const row = (o = {}) => [o.name ?? "", o.admissionNo ?? "", o.roll ?? "", o.registrationNo ?? "", o.class ?? "", o.section ?? "", o.nameBn ?? "", o.dob ?? "", o.gender ?? "", o.bloodGroup ?? "", o.birthCertificateNo ?? "", o.address ?? "", o.previousSchoolName ?? "", o.previousSchoolClass ?? "", o.guardianName ?? "", o.guardianPhone ?? "", o.guardianEmail ?? "", o.guardianRelation ?? "", o.photoUrl ?? ""];
const numbered = (rows, start = 2) => rows.map((cells, i) => ({ rowNumber: start + i, cells }));
const post = (host, path, body, cookie) => req(host, path, { cookie, method: "POST", body: JSON.stringify(body) });
const patch = (host, path, body, cookie) => req(host, path, { cookie, method: "PATCH", body: JSON.stringify(body) });

const admin = await login(HOSTS.school, "principal@sunrise.edu", "School@123");

/* ------------------------------------------------------------------- set-up */
console.log(`\n=== set-up (${BASE})`);
const me = await req(HOSTS.school, "/api/auth/me", { cookie: admin });
const schoolId = me.data?.school?.id || me.data?.schoolId;
check("the school admin is signed in", !!schoolId, String(schoolId));

const classes = (await req(HOSTS.school, "/api/classes", { cookie: admin })).data || [];
const class1 = classes.find((c) => c.name === "Class 1") || classes[0];
check("there is a class to import into", !!class1, class1?.name);

const stamp = Date.now();
const createdAdmissionNos = [];
const guardianEmails = [];
const branchIds = [];
let branchAdminEmail = null;
let sessionId = null;
let displacedCurrent = null;
let ownBatchId = null;
let otherBatchId = null;

if (class1) {
  const existing = await req(HOSTS.school, "/api/academic-sessions", { cookie: admin });
  displacedCurrent = (existing.data || []).find((s) => s.isCurrent)?.id || null;
  const sres = await post(HOSTS.school, "/api/academic-sessions", { name: `Branch Iso ${stamp}`, isCurrent: true }, admin);
  sessionId = sres.data?.id || null;
}

console.log("\n### two branches + a branch admin scoped to the first");
let branchA = null;
let branchB = null;
{
  const a = await post(HOSTS.school, "/api/branches", { name: `Iso Branch A ${stamp}` }, admin);
  const b = await post(HOSTS.school, "/api/branches", { name: `Iso Branch B ${stamp}` }, admin);
  branchA = a.data;
  branchB = b.data;
  if (branchA?.id) branchIds.push(branchA.id);
  if (branchB?.id) branchIds.push(branchB.id);
  check("both branches were created", !!branchA?.id && !!branchB?.id, `${branchA?.id} / ${branchB?.id}`);

  branchAdminEmail = `iso-branch-admin-${stamp}@demo.com`;
  const staff = await post(HOSTS.school, "/api/staff", { name: `Iso Branch Admin ${stamp}`, email: branchAdminEmail, password: "Branch@123", role: "BRANCH_ADMIN", scope: "BRANCH", branchId: branchA?.id }, admin);
  check("a BRANCH_ADMIN was created for branch A", staff.status === 201 && staff.data?.branchId === branchA?.id, `HTTP ${staff.status} ${staff.error || ""}`);
}

const branchAdmin = branchAdminEmail ? await login(HOSTS.school, branchAdminEmail, "Branch@123") : "";
check("the branch admin signs in", !!branchAdmin);

/* ------------------------------------------------ own-branch import succeeds */
console.log("\n### the branch admin imports into its OWN branch");
const admOwn = `ISO-OWN-${stamp}`;
const emailOwn = `iso-own-${stamp}@demo.com`;
createdAdmissionNos.push(admOwn);
guardianEmails.push(emailOwn);
{
  const rows = [row({ name: `Iso Own ${stamp}`, admissionNo: admOwn, class: class1?.name, guardianName: `Iso Own G ${stamp}`, guardianEmail: emailOwn })];
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "iso-own.csv", headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: 1, final: true }, branchAdmin);
  ownBatchId = cm.data?.batchId || null;
  check("the branch admin can commit into its own branch", cm.status === 200 && cm.data?.totals?.created === 1, `HTTP ${cm.status} ${cm.error || ""}`);
  const s = (await db.collection("students").where("admissionNo", "==", admOwn).get()).docs.map((d) => d.data())[0];
  check("the imported student landed in the branch admin's branch", s?.branchId === branchA?.id, `${s?.branchId} vs ${branchA?.id}`);

  const ownCred = await req(HOSTS.school, `/api/import/students/${ownBatchId}/credentials`, { cookie: branchAdmin });
  const ownList = ownCred.data?.credentials || [];
  check("the branch admin can read its own credential slips", ownCred.status === 200 && ownList.some((c) => c.admissionNo === admOwn), `HTTP ${ownCred.status}`);

  const ownDetail = await req(HOSTS.school, `/api/import/students/${ownBatchId}`, { cookie: branchAdmin });
  check("the branch admin can read its own batch detail", ownDetail.status === 200 && ownDetail.data?.batch?.id === ownBatchId, `HTTP ${ownDetail.status}`);
}

/* ------------------------------------- another branch's batch (school admin) */
console.log("\n### a batch owned by ANOTHER branch");
const admOther = `ISO-OTHER-${stamp}`;
const emailOther = `iso-other-${stamp}@demo.com`;
createdAdmissionNos.push(admOther);
guardianEmails.push(emailOther);
{
  const rows = [row({ name: `Iso Other ${stamp}`, admissionNo: admOther, class: class1?.name, guardianName: `Iso Other G ${stamp}`, guardianEmail: emailOther })];
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "iso-other.csv", branchId: branchB?.id, headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: 1, final: true }, admin);
  otherBatchId = cm.data?.batchId || null;
  check("the school admin can import into branch B", cm.status === 200 && cm.data?.totals?.created === 1, `HTTP ${cm.status} ${cm.error || ""}`);

  const detail = await req(HOSTS.school, `/api/import/students/${otherBatchId}`, { cookie: branchAdmin });
  check("the branch admin CANNOT read branch B's batch (404)", detail.status === 404, `HTTP ${detail.status}`);
  const cred = await req(HOSTS.school, `/api/import/students/${otherBatchId}/credentials`, { cookie: branchAdmin });
  check("the branch admin CANNOT read branch B's credentials (404)", cred.status === 404, `HTTP ${cred.status}`);
  const undo = await post(HOSTS.school, `/api/import/students/${otherBatchId}/undo`, {}, branchAdmin);
  check("the branch admin CANNOT undo branch B's import (404)", undo.status === 404, `HTTP ${undo.status}`);
}

/* ------------------------------------- branch admin cannot CHOOSE another branch */
console.log("\n### the branch admin cannot import into another branch");
const admForced = `ISO-FORCED-${stamp}`;
createdAdmissionNos.push(admForced);
{
  const rows = [row({ name: `Iso Forced ${stamp}`, admissionNo: admForced, class: class1?.name })];
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "iso-forced.csv", branchId: branchB?.id, headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: 1, final: true }, branchAdmin);
  // The branch admin's branch is FORCED by resolveBranchId, so the student lands
  // in branch A even though branch B was requested — never in the other branch.
  const s = (await db.collection("students").where("admissionNo", "==", admForced).get()).docs.map((d) => d.data())[0];
  check("a branch admin's import is forced into its own branch", s?.branchId === branchA?.id, `${s?.branchId} vs ${branchA?.id}`);
  check("the requested other branch was not used", s?.branchId !== branchB?.id, String(s?.branchId));
  if (cm.data?.batchId) {
    const b = (await db.collection("importBatches").doc(cm.data.batchId).get()).data();
    check("the batch is recorded under the branch admin's own branch", b?.branchId === branchA?.id, `${b?.branchId} vs ${branchA?.id}`);
  }
}

/* ------------------------------------------- no cross-branch slip in credentials */
console.log("\n### no cross-branch leakage in the credential list");
{
  const cred = await req(HOSTS.school, `/api/import/students/${ownBatchId}/credentials`, { cookie: branchAdmin });
  const list = cred.data?.credentials || [];
  check("the branch admin's slips never include another branch's student", !list.some((c) => c.admissionNo === admOther), JSON.stringify(list.map((c) => c.admissionNo)));
  check("the branch admin's slips include only its own student", list.length === 1 && list[0]?.admissionNo === admOwn, JSON.stringify(list.map((c) => c.admissionNo)));
}

/* ------------------------------------- college route branch isolation (2h) */
// Runs against the COLLEGE tenant created by isolation-fixture.mjs (two branches,
// a branch-bound department/program per branch, plus one branch-less department).
// A BRANCH-scoped admin must see and touch ONLY its own branch's rows.
console.log("\n### college departments/programs — branch admin confinement");
{
  const TRACK = new URL(".qa-fixtures.json", import.meta.url);
  if (!existsSync(TRACK)) {
    check("the isolation fixture is present (scripts/.qa-fixtures.json)", false, "run: node scripts/isolation-fixture.mjs create");
  } else {
    const creds = (JSON.parse(readFileSync(TRACK, "utf8")).creds) || {};
    const collegeAdmin = await login(HOSTS.school, "zz-iso-college-admin@test.local", creds.collegeAdmin);
    const collegeBranchAdmin = await login(HOSTS.school, "zz-iso-college-br-admin@test.local", creds.collegeBranchAdmin);

    const deptA = `${P}col-dept-a`;
    const deptB = `${P}col-dept-b`;
    const deptNone = `${P}col-dept-none`;
    const progA = `${P}col-prog-a`;
    const progB = `${P}col-prog-b`;

    // 1. A branch admin sees only its own branch's rows (not branch B's, not the
    //    branch-less department, which no BRANCH scope may reach).
    const bDepts = (await req(HOSTS.school, "/api/departments", { cookie: collegeBranchAdmin })).data || [];
    check(
      "branch admin sees ONLY its own branch's departments",
      bDepts.length === 1 && bDepts[0].id === deptA,
      JSON.stringify(bDepts.map((d) => d.id))
    );
    const bProgs = (await req(HOSTS.school, "/api/programs", { cookie: collegeBranchAdmin })).data || [];
    check(
      "branch admin sees ONLY its own branch's programs",
      bProgs.length === 1 && bProgs[0].id === progA,
      JSON.stringify(bProgs.map((p) => p.id))
    );

    // 2. Another branch's row cannot be edited or deleted.
    const patchDeptB = await patch(HOSTS.school, `/api/departments/${deptB}`, { name: "nope" }, collegeBranchAdmin);
    check("branch admin CANNOT PATCH another branch's department (403)", patchDeptB.status === 403, `HTTP ${patchDeptB.status}`);
    const delDeptB = await req(HOSTS.school, `/api/departments/${deptB}`, { cookie: collegeBranchAdmin, method: "DELETE" });
    check("branch admin CANNOT DELETE another branch's department (403)", delDeptB.status === 403, `HTTP ${delDeptB.status}`);
    const patchProgB = await patch(HOSTS.school, `/api/programs/${progB}`, { name: "nope" }, collegeBranchAdmin);
    check("branch admin CANNOT PATCH another branch's program (403)", patchProgB.status === 403, `HTTP ${patchProgB.status}`);
    const delProgB = await req(HOSTS.school, `/api/programs/${progB}`, { cookie: collegeBranchAdmin, method: "DELETE" });
    check("branch admin CANNOT DELETE another branch's program (403)", delProgB.status === 403, `HTTP ${delProgB.status}`);

    // 3. A foreign (another-tenant) id behaves as NOT FOUND — never a 403 oracle
    //    that would confirm the row exists in some other tenant.
    const foreignDept = `${P}both-dept`; // belongs to the BOTH tenant, not the college
    const crossDept = await patch(HOSTS.school, `/api/departments/${foreignDept}`, { name: "nope" }, collegeAdmin);
    check("a foreign tenant's department id is NOT FOUND (404)", crossDept.status === 404, `HTTP ${crossDept.status}`);
    const crossProg = await patch(HOSTS.school, `/api/programs/${foreignDept}`, { name: "nope" }, collegeAdmin);
    check("a foreign tenant's program id is NOT FOUND (404)", crossProg.status === 404, `HTTP ${crossProg.status}`);

    // 4. The decided edge: a branch-scoped admin cannot move a program OUT of its
    //    branch by pointing it at a branch-less department; a SCHOOL-scoped admin can.
    const moveByBranch = await patch(HOSTS.school, `/api/programs/${progA}`, { departmentId: deptNone }, collegeBranchAdmin);
    check(
      "a BRANCH-scoped admin CANNOT move a program into a branch-less department (403)",
      moveByBranch.status === 403,
      `HTTP ${moveByBranch.status}`
    );
    const moveBySchool = await patch(HOSTS.school, `/api/programs/${progA}`, { departmentId: deptNone }, collegeAdmin);
    const movedRow = (await db.collection("programs").doc(progA).get()).data();
    check(
      "a SCHOOL_ADMIN CAN move a program into a branch-less department (200, branchId null)",
      moveBySchool.status === 200 && movedRow?.departmentId === deptNone && movedRow?.branchId === null,
      `HTTP ${moveBySchool.status} dept=${movedRow?.departmentId} branch=${movedRow?.branchId}`
    );
    // Restore the fixture row exactly as created, so the run is repeatable.
    const restored = await patch(HOSTS.school, `/api/programs/${progA}`, { departmentId: deptA }, collegeAdmin);
    check(
      "the moved program is restored to its original department",
      restored.status === 200 && restored.data?.branchId === `${P}col-br-a`,
      `HTTP ${restored.status}`
    );

    // 5. Courses (Phase 3e) — the same confinement as departments/programs, and
    //    the branch-less row only a SCHOOL-scoped session may reach.
    const courseA = `${P}col-course-a`;
    const courseB = `${P}col-course-b`;
    const courseNone = `${P}col-course-none`;
    const mapB = `${P}col-map-b`;
    const foreignCourse = `${P}both-course`; // BOTH tenant — a real foreign course id
    const foreignMap = `${P}both-map`; // BOTH tenant — a real foreign mapping id

    const bCourses = (await req(HOSTS.school, "/api/courses", { cookie: collegeBranchAdmin })).data || [];
    check(
      "branch admin sees ONLY its own branch's courses",
      bCourses.length === 1 && bCourses[0].id === courseA,
      JSON.stringify(bCourses.map((c) => c.id))
    );

    const patchCourseB = await patch(HOSTS.school, `/api/courses/${courseB}`, { title: "nope" }, collegeBranchAdmin);
    check("branch admin CANNOT PATCH another branch's course (403)", patchCourseB.status === 403, `HTTP ${patchCourseB.status}`);
    const delCourseB = await req(HOSTS.school, `/api/courses/${courseB}`, { cookie: collegeBranchAdmin, method: "DELETE" });
    check("branch admin CANNOT DELETE another branch's course (403)", delCourseB.status === 403, `HTTP ${delCourseB.status}`);

    // The branch-less course: a BRANCH scope must not reach it; a SCHOOL scope may.
    const patchNoneByBranch = await patch(HOSTS.school, `/api/courses/${courseNone}`, { title: "nope" }, collegeBranchAdmin);
    check("a BRANCH-scoped admin CANNOT touch the branch-less course (403)", patchNoneByBranch.status === 403, `HTTP ${patchNoneByBranch.status}`);
    const patchNoneBySchool = await patch(HOSTS.school, `/api/courses/${courseNone}`, { creditHours: 3 }, collegeAdmin);
    check("a SCHOOL_ADMIN CAN touch the branch-less course (200)", patchNoneBySchool.status === 200, `HTTP ${patchNoneBySchool.status}`);
    // Restore it exactly as created (creditHours was null) so the run is repeatable.
    const restoreNone = await patch(HOSTS.school, `/api/courses/${courseNone}`, { creditHours: null }, collegeAdmin);
    check(
      "the branch-less course is restored (creditHours null)",
      restoreNone.status === 200 && restoreNone.data?.creditHours === null,
      `HTTP ${restoreNone.status} creditHours=${restoreNone.data?.creditHours}`
    );

    // A mapping follows the PROGRAM's branch: a branch admin cannot map into, or
    // remove a mapping from, another branch's program.
    const mapByBranch = await post(HOSTS.school, `/api/programs/${progB}/courses`, { courseId: courseB, termNumber: 2 }, collegeBranchAdmin);
    check("a BRANCH-scoped admin CANNOT map into another branch's program (403)", mapByBranch.status === 403, `HTTP ${mapByBranch.status}`);
    const unmapByBranch = await req(HOSTS.school, `/api/programs/${progB}/courses?mappingId=${mapB}`, { cookie: collegeBranchAdmin, method: "DELETE" });
    check("a BRANCH-scoped admin CANNOT remove another branch's mapping (403)", unmapByBranch.status === 403, `HTTP ${unmapByBranch.status}`);

    // 6. A foreign-tenant id is NOT FOUND — never a 403 oracle that confirms it.
    const foreignCoursePatch = await patch(HOSTS.school, `/api/courses/${foreignCourse}`, { title: "nope" }, collegeAdmin);
    check("a foreign tenant's course id is NOT FOUND (404)", foreignCoursePatch.status === 404, `HTTP ${foreignCoursePatch.status}`);
    const foreignCourseRow = (await db.collection("courses").doc(foreignCourse).get()).data();
    check(
      "the foreign course row is unchanged",
      foreignCourseRow?.schoolId === `${P}both` && foreignCourseRow?.title === "ZZ Iso Both Course",
      `${foreignCourseRow?.schoolId} / ${foreignCourseRow?.title}`
    );
    const foreignMapDelete = await req(HOSTS.school, `/api/programs/${progA}/courses?mappingId=${foreignMap}`, { cookie: collegeAdmin, method: "DELETE" });
    check("a foreign tenant's mapping id is NOT FOUND (404)", foreignMapDelete.status === 404, `HTTP ${foreignMapDelete.status}`);
    const foreignMapRow = (await db.collection("programCourses").doc(foreignMap).get()).data();
    check("the foreign mapping row is unchanged", foreignMapRow?.schoolId === `${P}both`, String(foreignMapRow?.schoolId));

    // 7. A FOREIGN courseId in a mapping POST is the SAME 400 as a NON-EXISTENT
    //    one (never a 404 that would confirm the row exists in another tenant).
    const foreignCourseMap = await post(HOSTS.school, `/api/programs/${progA}/courses`, { courseId: foreignCourse, termNumber: 2 }, collegeAdmin);
    const ghostCourseMap = await post(HOSTS.school, `/api/programs/${progA}/courses`, { courseId: `${P}no-such-course`, termNumber: 2 }, collegeAdmin);
    check("a foreign courseId in a mapping POST is refused with 400", foreignCourseMap.status === 400, `HTTP ${foreignCourseMap.status}`);
    check(
      "…byte-identical to a NON-EXISTENT courseId (no oracle)",
      foreignCourseMap.status === ghostCourseMap.status && JSON.stringify(foreignCourseMap) === JSON.stringify(ghostCourseMap),
      `foreign=${JSON.stringify(foreignCourseMap)} ghost=${JSON.stringify(ghostCourseMap)}`
    );
    const missingCourseMap = await post(HOSTS.school, `/api/programs/${progA}/courses`, { termNumber: 2 }, collegeAdmin);
    check("a MISSING courseId is also refused with 400 (same status)", missingCourseMap.status === 400, `HTTP ${missingCourseMap.status}`);
  }
}

/* --------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
const wantedAdm = new Set(createdAdmissionNos);
const studentDocs = (await db.collection("students").get()).docs.filter((d) => wantedAdm.has(d.data().admissionNo));
await Promise.all(
  studentDocs.map(async (doc) => {
    for (const c of ["fees", "payments"]) {
      const s = await db.collection(c).where("studentId", "==", doc.id).get();
      await Promise.all(s.docs.map((x) => x.ref.delete()));
    }
    await doc.ref.delete();
  })
);
for (const email of guardianEmails) {
  const snap = await db.collection("users").where("email", "==", email).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}
for (const bid of [ownBatchId, otherBatchId].filter(Boolean)) {
  const rowsSnap = await db.collection("importBatchRows").where("batchId", "==", bid).get();
  await Promise.all(rowsSnap.docs.map((d) => d.ref.delete()));
  await db.collection("importBatches").doc(bid).delete();
}
// stray batches created by the forced-branch commit
const strayBatches = (await db.collection("importBatches").where("fileName", "==", "iso-forced.csv").get()).docs;
await Promise.all(strayBatches.map(async (d) => {
  const rowsSnap = await db.collection("importBatchRows").where("batchId", "==", d.id).get();
  await Promise.all(rowsSnap.docs.map((x) => x.ref.delete()));
  await d.ref.delete();
}));
if (branchAdminEmail) {
  const snap = await db.collection("users").where("email", "==", branchAdminEmail).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}
for (const bid of branchIds) await db.collection("branches").doc(bid).delete();
if (sessionId) await db.collection("academicSessions").doc(sessionId).delete();
if (schoolId) {
  const pointer = db.collection("settings").doc(`set_school.${schoolId}.current_session`);
  if (displacedCurrent) await pointer.set({ key: `school.${schoolId}.current_session`, value: displacedCurrent }, { merge: true });
  else await pointer.delete();
}

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : "✅ PASS — a BRANCH_ADMIN imports only into its own branch and cannot read or undo another branch's import or credentials."}`);
process.exit(failures ? 1 : 0);
