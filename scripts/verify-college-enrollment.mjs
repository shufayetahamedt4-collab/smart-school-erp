#!/usr/bin/env node
/**
 * verify-college-enrollment.mjs — Phase 4a: the student's college identity.
 *
 * Runs over HTTP against the COLLEGE fixture tenant (scripts/isolation-fixture.mjs)
 * and proves the enrolment half of plan-Phase 4:
 *
 *   • a COLLEGE tenant can enrol a student into a program + term;
 *   • a term past the program's derived end is refused (400);
 *   • a term with no program is refused (400);
 *   • a foreign tenant's program id is refused (400, never a 404 oracle);
 *   • a SCHOOL tenant that names a program or a term is refused (403) and
 *     writes no row — never silently ignored;
 *   • PATCH follows the same rules, and a plain school rename still writes no
 *     college key;
 *   • DELETE /api/programs/[id] is blocked (400) while a student is enrolled,
 *     and succeeds once none is.
 *   • 4a-2 — PATCH { programId: null } un-enrols: it clears BOTH keys (absent,
 *     not null); { programId: null, termNumber: N } is still 400; a SCHOOL
 *     tenant sending programId null is still 403 with no write.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-college-enrollment.mjs
 * Needs the isolation fixture:  node scripts/isolation-fixture.mjs create
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";
import { requireEmulator } from "./lib/guard.mjs";

requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
/** Fixture id prefix (isolation-fixture.mjs). */
const P = "zziso-";

const TRACK = new URL(".qa-fixtures.json", import.meta.url);
if (!existsSync(TRACK)) {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(1);
}
const CRED = JSON.parse(readFileSync(TRACK, "utf8")).creds || {};
if (!CRED.collegeAdmin || !CRED.admin) {
  console.error("❌ Track file lacks credentials — re-run: node scripts/isolation-fixture.mjs clean && create");
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const HOST = `school.localhost:${PORT}`;
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
const patch = (path, body, cookie) => req(path, { cookie, method: "PATCH", body: JSON.stringify(body) });

const collegeAdmin = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
const schoolAdmin = await login("zz-iso-admin@test.local", CRED.admin);

const stamp = Date.now();
const createdAdm = [];
const createdRegs = [];
let tempProgramId = null;
let tempProgramId2 = null;

/* ------------------------------------------- a COLLEGE tenant can enrol a student */
console.log("\n### enrolment into a program + term");
{
  const adm = `CE-OK-${stamp}`; createdAdm.push(adm);
  const r = await post("/api/students", {
    name: `CE Ok ${stamp}`, admissionNo: adm, createFees: false, createGuardian: false,
    programId: `${P}col-prog-a`, termNumber: 1,
  }, collegeAdmin);
  check(
    "a COLLEGE tenant can enrol a student into a program + term (201)",
    r.status === 201 && r.data?.programId === `${P}col-prog-a` && r.data?.termNumber === 1,
    `HTTP ${r.status} programId=${r.data?.programId} term=${r.data?.termNumber}`
  );
  const okStudentId = r.data?.id || null;

  const admNoProg = `CE-NOPROG-${stamp}`; createdAdm.push(admNoProg);
  const noProg = await post("/api/students", {
    name: `CE NoProg ${stamp}`, admissionNo: admNoProg, createFees: false, createGuardian: false, termNumber: 1,
  }, collegeAdmin);
  check("a term with no program is refused (400)", noProg.status === 400, `HTTP ${noProg.status} ${noProg.error || ""}`);

  const admBad = `CE-BADTERM-${stamp}`; createdAdm.push(admBad);
  const badTerm = await post("/api/students", {
    name: `CE Bad ${stamp}`, admissionNo: admBad, createFees: false, createGuardian: false,
    programId: `${P}col-prog-a`, termNumber: 99,
  }, collegeAdmin);
  check("a term past the program's end is refused (400)", badTerm.status === 400, `HTTP ${badTerm.status} ${badTerm.error || ""}`);

  const admForeign = `CE-FOREIGN-${stamp}`; createdAdm.push(admForeign);
  const foreign = await post("/api/students", {
    name: `CE Foreign ${stamp}`, admissionNo: admForeign, createFees: false, createGuardian: false,
    programId: `${P}both-prog`, termNumber: 1,
  }, collegeAdmin);
  check(
    "a foreign tenant's program id is refused (400, never a 404 oracle)",
    foreign.status === 400,
    `HTTP ${foreign.status} ${foreign.error || ""}`
  );

  if (okStudentId) {
    // A term is meaningful only relative to a program, so PATCHing one names the
    // program too (the same rule POST applies).
    const pOk = await patch(`/api/students/${okStudentId}`, { programId: `${P}col-prog-a`, termNumber: 2 }, collegeAdmin);
    check("PATCH can move the student to another valid term (200)", pOk.status === 200 && pOk.data?.termNumber === 2, `HTTP ${pOk.status} term=${pOk.data?.termNumber}`);
    const pBad = await patch(`/api/students/${okStudentId}`, { programId: `${P}col-prog-a`, termNumber: 99 }, collegeAdmin);
    check("PATCH with a term past the end is refused (400)", pBad.status === 400, `HTTP ${pBad.status} ${pBad.error || ""}`);
    const pTermOnly = await patch(`/api/students/${okStudentId}`, { termNumber: 2 }, collegeAdmin);
    check("PATCH with a term but no program is refused (400)", pTermOnly.status === 400, `HTTP ${pTermOnly.status} ${pTermOnly.error || ""}`);

    // 4a-2 — a term alongside a null program is still a term with no program.
    const pNullTerm = await patch(`/api/students/${okStudentId}`, { programId: null, termNumber: 2 }, collegeAdmin);
    check("PATCH with programId null AND a term is refused (400)", pNullTerm.status === 400, `HTTP ${pNullTerm.status} ${pNullTerm.error || ""}`);

    // 4a-2 — an explicit un-enrol (programId: null) clears BOTH college keys.
    const un = await patch(`/api/students/${okStudentId}`, { programId: null }, collegeAdmin);
    check("PATCH with programId null un-enrols the student (200)", un.status === 200, `HTTP ${un.status} ${un.error || ""}`);
    check(
      "…the response carries neither programId nor termNumber",
      un.data && un.data.programId === undefined && un.data.termNumber === undefined,
      `programId=${JSON.stringify(un.data?.programId)} term=${JSON.stringify(un.data?.termNumber)}`
    );
    const cleared = (await db.collection("students").doc(okStudentId).get()).data() || {};
    check(
      "…and BOTH keys are REMOVED from the document (absent, not written null)",
      !("programId" in cleared) && !("termNumber" in cleared),
      `college keys still present: ${JSON.stringify(Object.keys(cleared).filter((k) => k === "programId" || k === "termNumber"))}`
    );
    const un2 = await patch(`/api/students/${okStudentId}`, { programId: null }, collegeAdmin);
    check("re-clearing an already un-enrolled student is an idempotent no-op (200)", un2.status === 200, `HTTP ${un2.status}`);
  }
}

/* --------------------------------------------------- a SCHOOL tenant is refused */
console.log("\n### a SCHOOL tenant naming a program or a term");
{
  const admS = `CE-SCHOOL-${stamp}`; createdAdm.push(admS);
  const s = await post("/api/students", {
    name: `CE School ${stamp}`, admissionNo: admS, createFees: false, createGuardian: false,
    programId: `${P}col-prog-a`, termNumber: 1,
  }, schoolAdmin);
  check("a SCHOOL tenant sending a programId gets 403 (never ignored)", s.status === 403, `HTTP ${s.status} ${s.error || ""}`);
  const rows = (await db.collection("students").where("admissionNo", "==", admS).get()).docs;
  check("…and no student row was written", rows.length === 0, `${rows.length} row(s)`);

  const admT = `CE-SCHOOLT-${stamp}`; createdAdm.push(admT);
  const t = await post("/api/students", {
    name: `CE SchoolT ${stamp}`, admissionNo: admT, createFees: false, createGuardian: false, termNumber: 1,
  }, schoolAdmin);
  check("a SCHOOL tenant sending only a termNumber also gets 403", t.status === 403, `HTTP ${t.status} ${t.error || ""}`);

  // A plain school student, then PATCH attempts with a college field.
  const admOwn = `CE-SCHOOLOWN-${stamp}`; createdAdm.push(admOwn);
  const own = await post("/api/students", {
    name: `CE Own ${stamp}`, admissionNo: admOwn, createFees: false, createGuardian: false,
  }, schoolAdmin);
  check("a plain school student still enrols with no college field (201)", own.status === 201 && own.data?.programId === undefined, `HTTP ${own.status} programId=${JSON.stringify(own.data?.programId)}`);
  if (own.data?.id) {
    const pProg = await patch(`/api/students/${own.data.id}`, { programId: `${P}col-prog-a` }, schoolAdmin);
    check("a SCHOOL tenant PATCHing a programId gets 403", pProg.status === 403, `HTTP ${pProg.status} ${pProg.error || ""}`);
    const pTerm = await patch(`/api/students/${own.data.id}`, { termNumber: 1 }, schoolAdmin);
    check("a SCHOOL tenant PATCHing a termNumber gets 403", pTerm.status === 403, `HTTP ${pTerm.status} ${pTerm.error || ""}`);
    // 4a-2 — a null programId KEY is still a college key: refused, no write.
    const pNull = await patch(`/api/students/${own.data.id}`, { programId: null }, schoolAdmin);
    check("a SCHOOL tenant PATCHing programId null gets 403 (never ignored)", pNull.status === 403, `HTTP ${pNull.status} ${pNull.error || ""}`);
    const ownDoc = (await db.collection("students").doc(own.data.id).get()).data() || {};
    check(
      "…and the refused null write left no college key behind",
      !("programId" in ownDoc) && !("termNumber" in ownDoc),
      `college keys present: ${JSON.stringify(Object.keys(ownDoc).filter((k) => k === "programId" || k === "termNumber"))}`
    );
    const pName = await patch(`/api/students/${own.data.id}`, { name: `CE Own Renamed ${stamp}` }, schoolAdmin);
    check(
      "a plain school rename still works and writes no college key (200)",
      pName.status === 200 && pName.data?.programId === undefined && pName.data?.termNumber === undefined,
      `HTTP ${pName.status} programId=${JSON.stringify(pName.data?.programId)} term=${JSON.stringify(pName.data?.termNumber)}`
    );
  }
}

/* --------------------------------------------------- the program DELETE guard */
console.log("\n### DELETE is blocked while a student is enrolled");
{
  const prog = await post("/api/programs", {
    name: `CE Temp Program ${stamp}`, code: `ZZ-CE-${stamp}`,
    departmentId: `${P}col-dept-a`, degreeLevel: "HSC", durationYears: 2,
  }, collegeAdmin);
  tempProgramId = prog.data?.id || null;
  check("a throwaway college program was created (201)", prog.status === 201 && !!tempProgramId, `HTTP ${prog.status} ${prog.error || ""}`);

  if (tempProgramId) {
    const adm = `CE-GUARD-${stamp}`; createdAdm.push(adm);
    const g = await post("/api/students", {
      name: `CE Guard ${stamp}`, admissionNo: adm, createFees: false, createGuardian: false,
      programId: tempProgramId, termNumber: 1,
    }, collegeAdmin);
    check("a student was enrolled into the throwaway program (201)", g.status === 201 && g.data?.programId === tempProgramId, `HTTP ${g.status} ${g.error || ""}`);

    const blocked = await req(`/api/programs/${tempProgramId}`, { cookie: collegeAdmin, method: "DELETE" });
    check("DELETE is blocked while a student is enrolled (400)", blocked.status === 400, `HTTP ${blocked.status} ${blocked.error || ""}`);

    if (g.data?.id) {
      const del = await req(`/api/students/${g.data.id}`, { cookie: collegeAdmin, method: "DELETE" });
      if (del.status === 200) createdAdm.splice(createdAdm.indexOf(adm), 1);
    }
    const after = await req(`/api/programs/${tempProgramId}`, { cookie: collegeAdmin, method: "DELETE" });
    check("DELETE succeeds once no student is enrolled (200)", after.status === 200, `HTTP ${after.status} ${after.error || ""}`);
    if (after.status === 200) tempProgramId = null;
  }

  // 4a-2 — DELETE also succeeds after an UN-ENROL that does NOT delete the
  // student, proving the guard keys on enrolment (students.programId), not on
  // the student row existing.
  const prog2 = await post("/api/programs", {
    name: `CE Temp Program2 ${stamp}`, code: `ZZ-CE2-${stamp}`,
    departmentId: `${P}col-dept-a`, degreeLevel: "HSC", durationYears: 2,
  }, collegeAdmin);
  tempProgramId2 = prog2.data?.id || null;
  check("a second throwaway college program was created (201)", prog2.status === 201 && !!tempProgramId2, `HTTP ${prog2.status} ${prog2.error || ""}`);

  if (tempProgramId2) {
    const adm2 = `CE-UNENROL-${stamp}`; createdAdm.push(adm2);
    const g2 = await post("/api/students", {
      name: `CE Unenrol ${stamp}`, admissionNo: adm2, createFees: false, createGuardian: false,
      programId: tempProgramId2, termNumber: 1,
    }, collegeAdmin);
    check("a student was enrolled into the second program (201)", g2.status === 201 && g2.data?.programId === tempProgramId2, `HTTP ${g2.status} ${g2.error || ""}`);

    const blocked2 = await req(`/api/programs/${tempProgramId2}`, { cookie: collegeAdmin, method: "DELETE" });
    check("DELETE is blocked while that student is enrolled (400)", blocked2.status === 400, `HTTP ${blocked2.status} ${blocked2.error || ""}`);

    const unenrol = g2.data?.id ? await patch(`/api/students/${g2.data.id}`, { programId: null }, collegeAdmin) : { status: null };
    check("the student is un-enrolled via programId null (200)", unenrol.status === 200, `HTTP ${unenrol.status}`);

    const after2 = await req(`/api/programs/${tempProgramId2}`, { cookie: collegeAdmin, method: "DELETE" });
    check("DELETE succeeds after the un-enrol WITHOUT deleting the student (200)", after2.status === 200, `HTTP ${after2.status} ${after2.error || ""}`);
    if (after2.status === 200) tempProgramId2 = null;

    if (g2.data?.id) {
      const still = await req(`/api/students/${g2.data.id}`, { cookie: collegeAdmin });
      check("…and the un-enrolled student still exists, with no college key (200)", still.status === 200 && still.data?.programId === undefined, `HTTP ${still.status} programId=${JSON.stringify(still.data?.programId)}`);
    }
  }
}

/* --------------------- 4b: a registration holds the place (un-enrol + move) */
console.log("\n### a registration holds the place — un-enrol and programme change are refused");
{
  // col-course-a is mapped to programme A (col-map-a, term 1), so a student
  // enrolled in programme A can register for it.
  const adm1 = `CE-REG-UNENROL-${stamp}`; createdAdm.push(adm1);
  const a = await post("/api/students", {
    name: `CE Reg Unenrol ${stamp}`, admissionNo: adm1, createFees: false, createGuardian: false,
    programId: `${P}col-prog-a`, termNumber: 1,
  }, collegeAdmin);
  check("a student is enrolled for the un-enrol guard (201)", a.status === 201 && !!a.data?.id, `HTTP ${a.status} ${a.error || ""}`);
  if (a.data?.id) {
    const reg = await post("/api/course-registrations", { studentId: a.data.id, courseId: `${P}col-course-a` }, collegeAdmin);
    check("a PENDING registration is created (201)", reg.status === 201, `HTTP ${reg.status} ${reg.error || ""}`);
    if (reg.data?.id) createdRegs.push(reg.data.id);

    const blocked = await patch(`/api/students/${a.data.id}`, { programId: null }, collegeAdmin);
    check("un-enrol is refused (409) while the registration holds a place", blocked.status === 409, `HTTP ${blocked.status} ${blocked.error || ""}`);

    if (reg.data?.id) {
      const del = await req(`/api/course-registrations/${reg.data.id}`, { cookie: collegeAdmin, method: "DELETE" });
      check("the registration is withdrawn (200)", del.status === 200, `HTTP ${del.status} ${del.error || ""}`);
      if (del.status === 200) createdRegs.splice(createdRegs.indexOf(reg.data.id), 1);
    }
    const ok = await patch(`/api/students/${a.data.id}`, { programId: null }, collegeAdmin);
    check("after the withdrawal the un-enrol succeeds (200)", ok.status === 200, `HTTP ${ok.status} ${ok.error || ""}`);
  }
}
{
  const adm2 = `CE-REG-MOVE-${stamp}`; createdAdm.push(adm2);
  const b = await post("/api/students", {
    name: `CE Reg Move ${stamp}`, admissionNo: adm2, createFees: false, createGuardian: false,
    programId: `${P}col-prog-a`, termNumber: 1,
  }, collegeAdmin);
  check("a student is enrolled for the programme-change guard (201)", b.status === 201 && !!b.data?.id, `HTTP ${b.status} ${b.error || ""}`);
  if (b.data?.id) {
    const reg = await post("/api/course-registrations", { studentId: b.data.id, courseId: `${P}col-course-a` }, collegeAdmin);
    check("a PENDING registration is created (201)", reg.status === 201, `HTTP ${reg.status} ${reg.error || ""}`);
    if (reg.data?.id) createdRegs.push(reg.data.id);

    const blocked = await patch(`/api/students/${b.data.id}`, { programId: `${P}col-prog-b`, termNumber: 1 }, collegeAdmin);
    check("moving to another programme is refused (409) while the registration holds a place", blocked.status === 409, `HTTP ${blocked.status} ${blocked.error || ""}`);

    if (reg.data?.id) {
      const del = await req(`/api/course-registrations/${reg.data.id}`, { cookie: collegeAdmin, method: "DELETE" });
      if (del.status === 200) createdRegs.splice(createdRegs.indexOf(reg.data.id), 1);
    }
    const ok = await patch(`/api/students/${b.data.id}`, { programId: `${P}col-prog-b`, termNumber: 1 }, collegeAdmin);
    check("after the withdrawal the programme change succeeds (200)", ok.status === 200, `HTTP ${ok.status} ${ok.error || ""}`);
  }
}

/* --------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
for (const rid of createdRegs) await db.collection("courseRegistrations").doc(rid).delete().catch(() => null);
for (const adm of createdAdm) {
  const docs = (await db.collection("students").where("admissionNo", "==", adm).get()).docs;
  for (const d of docs) {
    for (const col of ["fees", "payments"]) {
      const s = await db.collection(col).where("studentId", "==", d.id).get();
      for (const x of s.docs) await x.ref.delete();
    }
    await d.ref.delete();
  }
}
if (tempProgramId) await db.collection("programs").doc(tempProgramId).delete();
if (tempProgramId2) await db.collection("programs").doc(tempProgramId2).delete();

console.log(
  failures
    ? `\n❌ ${failures} college-enrolment failure(s)`
    : "\n✅ COLLEGE ENROLMENT OK — program/term validated, SCHOOL refused, program-delete guarded"
);
process.exit(failures ? 1 : 0);
