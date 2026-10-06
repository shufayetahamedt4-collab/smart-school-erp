/**
 * verify-enroll-paths.mjs — Phase 1 shared enroll kernel regression.
 *
 * Proves, end to end against a running server, that the three student-creation
 * paths still behave as they did and that each now carries the current academic
 * session:
 *   A. POST /api/students                         → student + default fees, no guardian when none asked
 *   B. POST /api/admissions/intake                → student + guardian + family/fees
 *   C. POST /api/admissions?action=enroll         → lib/admission.ts payAdmissionFeeAndEnroll
 * plus isolation checks (teacher/guardian cannot create) and that a session set
 * current is what every path reads.
 *
 * Creates its own records and deletes them (and the pointer it set) afterwards.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-enroll-paths.mjs
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

function unescapeKey(k) {
  const BS = String.fromCharCode(92);
  return k.includes(BS + "n") ? k.split(BS + "n").join("\n") : k;
}
if (!getApps().length) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: unescapeKey(process.env.FIREBASE_PRIVATE_KEY || ""),
    }),
  });
}
const db = getFirestore();

const HOSTS = { school: `school.localhost:${PORT}`, parents: `parents.localhost:${PORT}`, teacher: `teacher.localhost:${PORT}` };

async function req(host, path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Host: host, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null, setCookie: res.headers.get("set-cookie") || "" };
}

async function login(host, identifier, password) {
  const r = await req(host, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
  if (r.status !== 200) throw new Error(`login ${identifier}: HTTP ${r.status} ${r.error || ""}`);
  return r.setCookie.split(";")[0];
}

const admin = await login(HOSTS.school, "principal@sunrise.edu", "School@123");
const teacher = await login(HOSTS.teacher, "teacher@sunrise.edu", "Teacher@123");
const guardian = await login(HOSTS.parents, "guardian1@demo.com", "Guardian@123");

const created = { students: [], users: [], admissions: [], sessions: [] };
let displacedCurrent = null;

async function delByField(collection, field, value) {
  const snap = await db.collection(collection).where(field, "==", value).get();
  for (const doc of snap.docs) await doc.ref.delete();
}
async function delDoc(collection, id) {
  const ref = db.collection(collection).doc(id);
  const row = await ref.get();
  if (row.exists) await ref.delete();
}

/* ------------------------------------------------------------------- run */
console.log(`\n=== set-up (${BASE})`);
const me = await req(HOSTS.school, "/api/auth/me", { cookie: admin });
const schoolId = me.data?.school?.id || me.data?.schoolId;
check("the demo school admin is signed in", !!schoolId, String(schoolId));

const classes = (await req(HOSTS.school, "/api/classes", { cookie: admin })).data || [];
const class1 = classes.find((c) => c.name === "Class 1") || classes[0];
check("there is a class to admit into", !!class1, class1?.name);

// Make a known current session so the "correct sessionId" assertion is meaningful.
const existing = await req(HOSTS.school, "/api/academic-sessions", { cookie: admin });
displacedCurrent = (existing.data || []).find((s) => s.isCurrent)?.id || null;
const stamp = Date.now();
const sessionRes = await req(HOSTS.school, "/api/academic-sessions", {
  cookie: admin,
  method: "POST",
  body: JSON.stringify({ name: `Verify Enroll Session ${stamp}`, isCurrent: true }),
});
const sessionId = sessionRes.data?.id;
if (sessionId) created.sessions.push(sessionId);
check("a current session is available for the run", !!sessionId, String(sessionId));

console.log("\n### isolation");
const teacherPost = await req(HOSTS.school, "/api/students", { cookie: teacher, method: "POST", body: JSON.stringify({ name: "X" }) });
check("a teacher cannot POST /api/students", teacherPost.status === 403, `HTTP ${teacherPost.status}`);
const guardianIntake = await req(HOSTS.school, "/api/admissions/intake", { cookie: guardian, method: "POST", body: JSON.stringify({ student: { name: "X" } }) });
check("a guardian cannot intake", guardianIntake.status === 403 || guardianIntake.status === 404, `HTTP ${guardianIntake.status}`);

console.log("\n### A. POST /api/students");
const aName = `Verify A ${stamp}`;
const a = await req(HOSTS.school, "/api/students", {
  cookie: admin,
  method: "POST",
  body: JSON.stringify({ name: aName, classId: class1?.id, admissionNo: `VER-A-${stamp}` }),
});
check("A: the student is created", a.status === 201 && !!a.data?.id, `HTTP ${a.status} ${a.error || ""}`);
if (a.data?.id) created.students.push(a.data.id);
check("A: the student carries the current session", a.data?.sessionId === sessionId, String(a.data?.sessionId));
const aFees = (await req(HOSTS.school, `/api/students?q=${encodeURIComponent(aName)}`, { cookie: admin })).data || [];
const aRow = aFees.find((s) => s.id === a.data?.id);
check("A: the default admission + monthly fees were raised", (aRow?.fees || []).length === 2, `${(aRow?.fees || []).length} fee(s)`);
check("A: no guardian login was created (none was asked for)", !aRow?.guardianUserId, String(aRow?.guardianUserId));

console.log("\n### B. POST /api/admissions/intake");
const bName = `Verify B ${stamp}`;
const b = await req(HOSTS.school, "/api/admissions/intake", {
  cookie: admin,
  method: "POST",
  body: JSON.stringify({
    student: { name: bName, classId: class1?.id },
    guardian: { name: "Verify B Guardian", phone: `0179${String(stamp).slice(-7)}`, email: `verify-b-${stamp}@demo.com`, createLogin: true, password: "Verify@123" },
    fees: { admissionFee: 5000, monthlyFee: 1500, createMonthly: true },
    payment: { collect: false },
    kit: {},
  }),
});
check("B: the desk intake succeeds", b.status === 201 && !!b.data?.studentId, `HTTP ${b.status} ${b.error || ""}`);
if (b.data?.studentId) created.students.push(b.data.studentId);
if (b.data?.admissionId) created.admissions.push(b.data.admissionId);
const bStudent = b.data?.studentId ? (await req(HOSTS.school, `/api/students/${b.data.studentId}`, { cookie: admin })).data : null;
check("B: the student carries the current session", bStudent?.sessionId === sessionId, String(bStudent?.sessionId));
check("B: the guardian login was created and linked", !!b.data?.guardian?.linked, JSON.stringify(b.data?.guardian || {}));
if (bStudent?.guardianUserId) created.users.push(bStudent.guardianUserId);

console.log("\n### C. POST /api/admissions?action=enroll (lib/admission.ts)");
const cAdmissionId = `verify_enroll_${stamp}`;
await db.collection("admissions").doc(cAdmissionId).set({
  schoolId,
  classId: class1?.id || null,
  sectionId: null,
  fullName: `Verify C ${stamp}`,
  status: "SEAT_CONFIRMED",
  admissionNo: `VER-C-${stamp}`,
  payableAmount: 4500,
  guardianName: "Verify C Guardian",
  guardianPhone: `0189${String(stamp).slice(-7)}`,
  guardianEmail: `verify-c-${stamp}@demo.com`,
  branchId: null,
});
created.admissions.push(cAdmissionId);
const c = await req(HOSTS.school, "/api/admissions?action=enroll", {
  cookie: admin,
  method: "POST",
  body: JSON.stringify({ admissionId: cAdmissionId, method: "CASH" }),
});
check("C: enrollment succeeds", c.status === 200 && !!c.data?.studentId, `HTTP ${c.status} ${c.error || ""}`);
if (c.data?.studentId) created.students.push(c.data.studentId);
const cStudent = c.data?.studentId ? (await req(HOSTS.school, `/api/students/${c.data.studentId}`, { cookie: admin })).data : null;
check("C: the student carries the current session", cStudent?.sessionId === sessionId, String(cStudent?.sessionId));
check("C: a guardian login was created and linked", !!cStudent?.guardianUserId, String(cStudent?.guardianUserId));
if (cStudent?.guardianUserId) created.users.push(cStudent.guardianUserId);
const cAdmission = (await db.collection("admissions").doc(cAdmissionId).get()).data() || {};
check("C: the admission is marked ENROLLED", cAdmission.status === "ENROLLED" && !!cAdmission.convertedStudentId, cAdmission.status);

/* --------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
for (const id of created.students) {
  await delByField("fees", "studentId", id);
  await delByField("payments", "studentId", id);
  await delByField("ledger", "studentId", id);
  await delDoc("students", id);
}
for (const id of created.admissions) await delDoc("admissions", id);
for (const id of created.users) await delDoc("users", id);
for (const id of created.sessions) await delDoc("academicSessions", id);
const pointer = db.collection("settings").doc(`set_school.${schoolId}.current_session`);
if (displacedCurrent) await pointer.set({ key: `school.${schoolId}.current_session`, value: displacedCurrent }, { merge: true });
else await pointer.delete();

// Best-effort verification that the run left nothing behind.
const leftStudents = await Promise.all(created.students.map(async (id) => (await db.collection("students").doc(id).get()).exists));
check("every student this run created is gone", leftStudents.every((x) => !x), `${created.students.length} student(s)`);

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : "✅ PASS — all three creation paths work and carry the current session."}`);
process.exit(failures ? 1 : 0);
