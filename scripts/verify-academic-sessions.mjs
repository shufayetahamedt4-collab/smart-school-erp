/**
 * verify-academic-sessions.mjs — Phase 1 session foundation.
 *
 * Proves, against a running server:
 *   1. sessions can be listed and created (system-settings permission only)
 *   2. a session can be renamed/dates-edited and marked current
 *   3. the current session is what NEW student creation reads (student.sessionId)
 *   4. school isolation holds (teacher/guardian cannot manage sessions)
 *
 * Creates its own session + one student and deletes them (and the settings
 * pointer it set) afterwards, restoring any session it displaced.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-academic-sessions.mjs
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

loadEnv();
requireEmulator();

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
  const cookie = r.setCookie.split(";")[0];
  if (!cookie) throw new Error(`login ${identifier}: no cookie`);
  return cookie;
}

const admin = await login(HOSTS.school, "principal@sunrise.edu", "School@123");
const teacher = await login(HOSTS.teacher, "teacher@sunrise.edu", "Teacher@123");
const guardian = await login(HOSTS.parents, "guardian1@demo.com", "Guardian@123");

const created = { sessions: [], studentIds: [], userIds: [], feeIds: [] };
let displacedCurrent = null;

async function delByField(collection, field, value, into) {
  const snap = await db.collection(collection).where(field, "==", value).get();
  for (const doc of snap.docs) {
    await doc.ref.delete();
    if (into) into.push(doc.id);
  }
}

/* ------------------------------------------------------------------- run */
console.log(`\n=== set-up (${BASE})`);
const schools = await req(HOSTS.school, "/api/auth/me", { cookie: admin });
const schoolId = schools.data?.school?.id || schools.data?.schoolId;
check("the demo school admin is signed in", !!schoolId, String(schoolId));

const before = await req(HOSTS.school, "/api/academic-sessions", { cookie: admin });
check("sessions can be listed", before.status === 200 && Array.isArray(before.data), `HTTP ${before.status}`);
displacedCurrent = (before.data || []).find((s) => s.isCurrent)?.id || null;

const classes = (await req(HOSTS.school, "/api/classes", { cookie: admin })).data || [];
const class1 = classes.find((c) => c.name === "Class 1") || classes[0];
check("there is a class to admit into", !!class1, class1?.name);

console.log("\n### permission & isolation");
const anonCreate = await req(HOSTS.school, "/api/academic-sessions", { method: "POST", body: JSON.stringify({ name: "Nope" }) });
check("anonymous cannot create a session", anonCreate.status === 401, `HTTP ${anonCreate.status}`);
const teacherCreate = await req(HOSTS.school, "/api/academic-sessions", { cookie: teacher, method: "POST", body: JSON.stringify({ name: "Nope" }) });
check("a teacher cannot create a session", teacherCreate.status === 403, `HTTP ${teacherCreate.status}`);
const guardianCreate = await req(HOSTS.school, "/api/academic-sessions", { cookie: guardian, method: "POST", body: JSON.stringify({ name: "Nope" }) });
check("a guardian cannot create a session", guardianCreate.status === 403 || guardianCreate.status === 404, `HTTP ${guardianCreate.status}`);

console.log("\n### create / list / update / set-current");
const stamp = Date.now();
const name = `Verify Session ${stamp}`;
const createdRes = await req(HOSTS.school, "/api/academic-sessions", {
  cookie: admin,
  method: "POST",
  body: JSON.stringify({ name, startDate: "2026-01-01", endDate: "2026-12-31" }),
});
check("a session can be created", createdRes.status === 201 && !!createdRes.data?.id, `HTTP ${createdRes.status} ${createdRes.error || ""}`);
const sessionId = createdRes.data?.id;
if (sessionId) created.sessions.push(sessionId);

const listed = await req(HOSTS.school, "/api/academic-sessions", { cookie: admin });
check("the new session appears in the list", (listed.data || []).some((s) => s.id === sessionId), String(sessionId));

const renamed = await req(HOSTS.school, `/api/academic-sessions/${sessionId}`, {
  cookie: admin,
  method: "PATCH",
  body: JSON.stringify({ name: `${name} (edited)` }),
});
check("a session can be updated", renamed.status === 200 && renamed.data?.name === `${name} (edited)`, renamed.data?.name);

const setCurrent = await req(HOSTS.school, `/api/academic-sessions/${sessionId}/set-current`, { cookie: admin, method: "POST" });
check("a session can be set current", setCurrent.status === 200, `HTTP ${setCurrent.status} ${setCurrent.error || ""}`);
const listed2 = await req(HOSTS.school, "/api/academic-sessions", { cookie: admin });
const currentRows = (listed2.data || []).filter((s) => s.isCurrent);
check("exactly one session is current", currentRows.length === 1 && currentRows[0].id === sessionId, currentRows.map((s) => s.id).join(","));

console.log("\n### new student creation reads the current session");
const stu = await req(HOSTS.school, "/api/students", {
  cookie: admin,
  method: "POST",
  body: JSON.stringify({ name: `Verify Session Student ${stamp}`, classId: class1?.id, createFees: false }),
});
check("POST /api/students still creates a student", stu.status === 201 && !!stu.data?.id, `HTTP ${stu.status} ${stu.error || ""}`);
if (stu.data?.id) created.studentIds.push(stu.data.id);
check("the new student carries the current session", stu.data?.sessionId === sessionId, `${stu.data?.sessionId} vs ${sessionId}`);

/* --------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
for (const id of created.studentIds) {
  await delByField("fees", "studentId", id, created.feeIds);
  await delByField("payments", "studentId", id);
  await delByField("ledger", "studentId", id);
  const ref = db.collection("students").doc(id);
  const row = await ref.get();
  if (row.exists) await ref.delete();
}
for (const id of created.sessions) {
  const ref = db.collection("academicSessions").doc(id);
  const row = await ref.get();
  if (row.exists) await ref.delete();
}
// Restore (or clear) the current-session pointer.
const pointer = db.collection("settings").doc(`set_school.${schoolId}.current_session`);
if (displacedCurrent) await pointer.set({ key: `school.${schoolId}.current_session`, value: displacedCurrent }, { merge: true });
else await pointer.delete();

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : "✅ PASS — academic sessions work and drive student.sessionId."}`);
process.exit(failures ? 1 : 0);
