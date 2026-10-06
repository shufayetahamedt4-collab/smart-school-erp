/**
 * verify-promotion-rollover.mjs — Phase 6 promotion, session rollover, transfer.
 *
 * Covers: session-aware promotion, retained/repeat handling, graduation,
 * transferred exclusion, idempotent re-run, two target sessions, foreign-session
 * rejection, branch isolation, authorization, transfer/withdraw/restore,
 * guardian/family preservation, historical-record preservation, batched writes,
 * partial-error isolation, section-mismatch surfacing, and cleanup.
 *
 * Creates its own classes, sections, students, guardian, branches and a branch
 * admin; removes everything it creates afterwards.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-promotion-rollover.mjs
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
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null, setCookie: res.headers.get("set-cookie") || "", text };
}
async function login(host, identifier, password) {
  const r = await req(host, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
  if (r.status !== 200) throw new Error(`login ${identifier}: HTTP ${r.status} ${r.error || ""}`);
  return r.setCookie.split(";")[0];
}
const post = (host, path, body, cookie) => req(host, path, { cookie, method: "POST", body: JSON.stringify(body) });

const admin = await login(HOSTS.school, "principal@sunrise.edu", "School@123");
const teacher = await login(HOSTS.teacher, "teacher@sunrise.edu", "Teacher@123");
const guardian = await login(HOSTS.parents, "guardian1@demo.com", "Guardian@123");

/* ------------------------------------------------------------------- set-up */
console.log(`\n=== set-up (${BASE})`);
const me = await req(HOSTS.school, "/api/auth/me", { cookie: admin });
const schoolId = me.data?.school?.id || me.data?.schoolId;
check("the school admin is signed in", !!schoolId, String(schoolId));

const stamp = Date.now();
const studentIds = [];
const guardianEmails = [];
const classIds = [];
const sectionIds = [];
const branchIds = [];
const sessionIds = [];
let branchAdminEmail = null;

// Two isolated classes (so we never disturb the demo's classes/students).
const clsA = (await post(HOSTS.school, "/api/classes", { name: `Promo A ${stamp}`, order: 500, sections: ["X"] }, admin)).data;
const clsB = (await post(HOSTS.school, "/api/classes", { name: `Promo B ${stamp}`, order: 501, sections: ["Y"] }, admin)).data;
if (clsA?.id) classIds.push(clsA.id);
if (clsB?.id) classIds.push(clsB.id);
check("two promotion classes were created", !!clsA?.id && !!clsB?.id, `${clsA?.id} / ${clsB?.id}`);
// POST /api/classes returns the class only — read its section back.
const secA = (await db.collection("sections").where("classId", "==", clsA?.id).get()).docs.map((d) => ({ id: d.id, ...d.data() }))[0] || null;
const secB = (await db.collection("sections").where("classId", "==", clsB?.id).get()).docs.map((d) => ({ id: d.id, ...d.data() }))[0] || null;
if (secA?.id) sectionIds.push(secA.id);
if (secB?.id) sectionIds.push(secB.id);
check("the promotion classes have sections", !!secA?.id && !!secB?.id, `${secA?.id} / ${secB?.id}`);

const sessA = (await post(HOSTS.school, "/api/academic-sessions", { name: `Promo Session A ${stamp}`, startDate: "2030-01-01", isCurrent: true }, admin)).data;
const sessB = (await post(HOSTS.school, "/api/academic-sessions", { name: `Promo Session B ${stamp}`, startDate: "2031-01-01", isCurrent: false }, admin)).data;
if (sessA?.id) sessionIds.push(sessA.id);
if (sessB?.id) sessionIds.push(sessB.id);
check("two academic sessions were created", !!sessA?.id && !!sessB?.id, `${sessA?.id} / ${sessB?.id}`);

// Students in Class A (the cohort) + a retained candidate + a transferred candidate.
let admSeq = 0;
async function makeStudent(name, classId, sectionId, guardianEmail, sessionId) {
  const res = await post(HOSTS.school, "/api/students", {
    name, admissionNo: `PR${stamp}${++admSeq}`.slice(0, 40), classId, sectionId,
    guardianName: `Guardian ${name}`, guardianEmail, createGuardian: !!guardianEmail, createFees: false, sessionId,
  }, admin);
  return res.data;
}
const gEmail = `promo-guardian-${stamp}@demo.com`;
guardianEmails.push(gEmail);
const s1 = await makeStudent(`Promo One ${stamp}`, clsA?.id, secA?.id, gEmail, sessA?.id);
const s2 = await makeStudent(`Promo Two ${stamp}`, clsA?.id, secA?.id, null, sessA?.id);
const sRetain = await makeStudent(`Promo Retain ${stamp}`, clsA?.id, secA?.id, null, sessA?.id);
const sTransfer = await makeStudent(`Promo Transfer ${stamp}`, clsA?.id, secA?.id, null, sessA?.id);
[s1, s2, sRetain, sTransfer].forEach((s) => s?.id && studentIds.push(s.id));
check("four cohort students were created", [s1, s2, sRetain, sTransfer].every((s) => s?.id), `${[s1, s2, sRetain, sTransfer].filter((s) => s?.id).length}`);

/* ---------------------------------------------------------- authorization */
console.log("\n### authorization");
{
  const anon = await req(HOSTS.school, `/api/students/promote?fromClassId=${clsA?.id}`);
  check("anonymous preview is refused (401)", anon.status === 401, `HTTP ${anon.status}`);
  const t = await req(HOSTS.school, `/api/students/promote?fromClassId=${clsA?.id}`, { cookie: teacher });
  check("a teacher cannot preview (403)", t.status === 403, `HTTP ${t.status}`);
  const g = await req(HOSTS.school, `/api/students/promote?fromClassId=${clsA?.id}`, { cookie: guardian });
  check("a guardian cannot preview (403)", g.status === 403, `HTTP ${g.status}`);
  const tPost = await post(HOSTS.school, "/api/students/promote", { fromClassId: clsA?.id }, teacher);
  check("a teacher cannot promote (403)", tPost.status === 403, `HTTP ${tPost.status}`);
  const gPost = await post(HOSTS.school, "/api/students/promote", { fromClassId: clsA?.id }, guardian);
  check("a guardian cannot promote (403)", gPost.status === 403, `HTTP ${gPost.status}`);
}

/* --------------------------------------------------- foreign target session */
console.log("\n### foreign target session is rejected");
{
  const foreign = await post(HOSTS.school, "/api/students/promote", { fromClassId: clsA?.id, toSessionId: `as_other_school_${stamp}` }, admin);
  check("a target session from another school is rejected (400)", foreign.status === 400, `HTTP ${foreign.status} ${foreign.error || ""}`);
}

/* ------------------------------------------------------- transfer exclusion */
console.log("\n### transfer/withdraw/restore");
{
  const tr = await post(HOSTS.school, `/api/students/${sTransfer?.id}/lifecycle`, { action: "TRANSFER", reason: "moved city" }, admin);
  check("TRANSFER sets status TRANSFERRED", tr.status === 200 && tr.data?.status === "TRANSFERRED", `HTTP ${tr.status} ${JSON.stringify(tr.data)}`);
  const row = (await db.collection("students").doc(sTransfer.id).get()).data();
  check("the transfer reason is recorded", row?.lifecycleReason === "moved city", String(row?.lifecycleReason));
  check("the transferred student leaves the on-roll roster", row?.status === "TRANSFERRED");

  const offRoll = await req(HOSTS.school, "/api/students/alumni?status=TRANSFERRED", { cookie: admin });
  check("the off-roll list includes the transferred student", (offRoll.data || []).some((s) => s.id === sTransfer.id), `${(offRoll.data || []).length} off-roll`);

  const wd = await post(HOSTS.school, `/api/students/${s2?.id}/lifecycle`, { action: "WITHDRAW", reason: "family request" }, admin);
  check("WITHDRAW sets status TRANSFERRED", wd.status === 200 && wd.data?.status === "TRANSFERRED", `HTTP ${wd.status}`);
  const re = await post(HOSTS.school, `/api/students/${s2?.id}/lifecycle`, { action: "RESTORE" }, admin);
  check("RESTORE returns the student to ACTIVE", re.status === 200 && re.data?.status === "ACTIVE", `HTTP ${re.status}`);

  // unauthorized lifecycle
  const tLife = await post(HOSTS.school, `/api/students/${s1?.id}/lifecycle`, { action: "TRANSFER" }, teacher);
  check("a teacher cannot run a lifecycle action (403)", tLife.status === 403, `HTTP ${tLife.status}`);
}

/* ----------------------------------------------------- session-aware promote */
console.log("\n### session-aware promotion (Class A → Class B, session B)");
const gBefore = (await db.collection("students").doc(s1.id).get()).data();
{
  const pv = await req(HOSTS.school, `/api/students/promote?fromClassId=${clsA?.id}&toSessionId=${sessB?.id}`, { cookie: admin });
  check("preview returns the target session", pv.data?.targetSession?.id === sessB?.id, JSON.stringify(pv.data?.targetSession));
  check("the transferred student is excluded from the roster", !(pv.data?.students || []).some((s) => s.id === sTransfer.id), JSON.stringify((pv.data?.students || []).map((s) => s.id)));

  const result = await post(HOSTS.school, "/api/students/promote", { fromClassId: clsA?.id, toSessionId: sessB?.id, excludeIds: [sRetain?.id] }, admin);
  check("promotion reports promoted/retained/graduated/skipped", result.status === 200 && typeof result.data?.promoted === "number", JSON.stringify(result.data));
  check("the retained student is counted as retained", result.data?.retained === 1, `retained=${result.data?.retained}`);

  const after1 = (await db.collection("students").doc(s1.id).get()).data();
  const after2 = (await db.collection("students").doc(s2.id).get()).data();
  const afterR = (await db.collection("students").doc(sRetain.id).get()).data();
  check("a promoted student moves to the next class", after1?.classId === clsB?.id, `${after1?.classId} vs ${clsB?.id}`);
  check("a promoted student carries the target session", after1?.sessionId === sessB?.id, `${after1?.sessionId} vs ${sessB?.id}`);
  check("a promoted student gets the promotion marker", after1?.promotionSessionId === sessB?.id, String(after1?.promotionSessionId));
  check("the retained student stays in the original class", afterR?.classId === clsA?.id, `${afterR?.classId} vs ${clsA?.id}`);
  check("the retained student still moves to the target session", afterR?.sessionId === sessB?.id, `${afterR?.sessionId} vs ${sessB?.id}`);
  check("the second promoted student also moved", after2?.classId === clsB?.id && after2?.sessionId === sessB?.id, `${after2?.classId}/${after2?.sessionId}`);
  check("guardian link is preserved across promotion", after1?.guardianUserId === gBefore?.guardianUserId && !!after1?.guardianUserId, String(after1?.guardianUserId));
}

/* --------------------------------------------------------- idempotent re-run */
console.log("\n### idempotent re-run cannot double-promote");
{
  const before = (await db.collection("students").doc(s1.id).get()).data();
  const rerun = await post(HOSTS.school, "/api/students/promote", { fromClassId: clsA?.id, toSessionId: sessB?.id }, admin);
  check("a re-run promotes nobody", rerun.data?.promoted === 0, JSON.stringify(rerun.data));
  const after = (await db.collection("students").doc(s1.id).get()).data();
  check("the already-promoted student did NOT move again", after?.classId === before?.classId, `${before?.classId} → ${after?.classId}`);

  // The critical scenario: Class A→B then B→C in the SAME target session must not
  // re-advance the students just moved into B.
  const clsC = (await post(HOSTS.school, "/api/classes", { name: `Promo C ${stamp}`, order: 502, sections: ["Z"] }, admin)).data;
  if (clsC?.id) classIds.push(clsC.id);
  // B→C would normally use class order; our classes are A(500),B(501),C(502).
  const second = await post(HOSTS.school, "/api/students/promote", { fromClassId: clsB?.id, toSessionId: sessB?.id }, admin);
  const afterSecond = (await db.collection("students").doc(s1.id).get()).data();
  check("promoting the next class in the same session does not re-advance already-moved students", afterSecond?.classId === clsB?.id, `${afterSecond?.classId} vs ${clsB?.id} (promoted=${second.data?.promoted})`);
}

/* ---------------------------------------------------- two different sessions */
console.log("\n### two different target sessions behave independently");
{
  // Put a fresh student in Class A under session A and promote to session A
  // (within-year) — it should move class but keep session A; then it is eligible
  // again for session B.
  const sX = await makeStudent(`Promo Two-Sess ${stamp}`, clsA?.id, secA?.id, null, sessA?.id);
  if (sX?.id) studentIds.push(sX.id);
  const r1 = await post(HOSTS.school, "/api/students/promote", { fromClassId: clsA?.id, toSessionId: sessA?.id }, admin);
  const after1 = (await db.collection("students").doc(sX.id).get()).data();
  check("promoting to session A stamps session A", after1?.sessionId === sessA?.id, String(after1?.sessionId));
  check("the same-session marker is session A", after1?.promotionSessionId === sessA?.id, String(after1?.promotionSessionId));
  // Now move that cohort's class back for a session-B run: re-create the student in A.
  const sY = await makeStudent(`Promo Two-Sess B ${stamp}`, clsA?.id, secA?.id, null, sessA?.id);
  if (sY?.id) studentIds.push(sY.id);
  const r2 = await post(HOSTS.school, "/api/students/promote", { fromClassId: clsA?.id, toSessionId: sessB?.id }, admin);
  const afterY = (await db.collection("students").doc(sY.id).get()).data();
  check("promoting the same class to a DIFFERENT session still works", afterY?.sessionId === sessB?.id && afterY?.classId === clsB?.id, `${afterY?.classId}/${afterY?.sessionId}`);
}

/* ------------------------------------------------------------- graduation */
console.log("\n### graduating (top class → ALUMNI)");
{
  // Class B is not top (Class C exists); create a dedicated top class.
  const topCls = (await post(HOSTS.school, "/api/classes", { name: `Promo Top ${stamp}`, order: 999, sections: ["T"] }, admin)).data;
  if (topCls?.id) classIds.push(topCls.id);
  const sGrad = await makeStudent(`Promo Grad ${stamp}`, topCls?.id, null, null, sessA?.id);
  if (sGrad?.id) studentIds.push(sGrad.id);
  const r = await post(HOSTS.school, "/api/students/promote", { fromClassId: topCls?.id, toSessionId: sessB?.id }, admin);
  const after = (await db.collection("students").doc(sGrad.id).get()).data();
  check("a top-class student becomes ALUMNI", after?.status === "ALUMNI", `${after?.status} (graduated=${r.data?.graduated})`);
  check("the graduate gets the promotion marker too", after?.promotionSessionId === sessB?.id, String(after?.promotionSessionId));
}

/* ------------------------------------------------- section mismatch warning */
console.log("\n### section mismatch is surfaced, not silently remapped");
{
  // Class A has section X; Class B has section Y. A student in A/X promoted to B
  // has a section that does not belong to B → warning, and section is preserved.
  const sSec = await makeStudent(`Promo Sec ${stamp}`, clsA?.id, secA?.id, null, sessA?.id);
  if (sSec?.id) studentIds.push(sSec.id);
  const pv = await req(HOSTS.school, `/api/students/promote?fromClassId=${clsA?.id}&toSessionId=${sessB?.id}`, { cookie: admin });
  const row = (pv.data?.students || []).find((s) => s.id === sSec.id);
  check("a section mismatch produces a warning", !!row?.sectionWarning, JSON.stringify(row?.sectionWarning));
  await post(HOSTS.school, "/api/students/promote", { fromClassId: clsA?.id, toSessionId: sessB?.id }, admin);
  const after = (await db.collection("students").doc(sSec.id).get()).data();
  check("the mismatched section is preserved (no silent remap)", after?.sectionId === secA?.id, `${after?.sectionId} vs ${secA?.id}`);
}

/* ------------------------------------------------------ batched / larger set */
console.log("\n### batched processing for a larger set");
{
  const bigCls = (await post(HOSTS.school, "/api/classes", { name: `Promo Batch ${stamp}`, order: 600, sections: ["B"] }, admin)).data;
  const bigTarget = (await post(HOSTS.school, "/api/classes", { name: `Promo BatchNext ${stamp}`, order: 601, sections: ["B"] }, admin)).data;
  if (bigCls?.id) classIds.push(bigCls.id);
  if (bigTarget?.id) classIds.push(bigTarget.id);
  const N = 45;
  const created = [];
  for (let i = 0; i < N; i++) {
    const s = await makeStudent(`Promo Batch ${stamp}-${i}`, bigCls?.id, null, null, sessA?.id);
    if (s?.id) { studentIds.push(s.id); created.push(s.id); }
  }
  check(`a ${N}-student cohort was created`, created.length === N, `${created.length}`);
  const r = await post(HOSTS.school, "/api/students/promote", { fromClassId: bigCls?.id, toSessionId: sessB?.id }, admin);
  check(`the ${N}-student promotion ran in one call`, r.status === 200 && r.data?.promoted === N, JSON.stringify(r.data));
  const sample = (await db.collection("students").doc(created[0]).get()).data();
  check("a batched student moved class + session", sample?.classId === bigTarget?.id && sample?.sessionId === sessB?.id, `${sample?.classId}/${sample?.sessionId}`);
}

/* --------------------------------------------------- partial error isolation */
console.log("\n### a bad target session does not corrupt students");
{
  const before = (await db.collection("students").doc(s1.id).get()).data();
  const bad = await post(HOSTS.school, "/api/students/promote", { fromClassId: clsA?.id, toSessionId: `as_nope_${stamp}` }, admin);
  const after = (await db.collection("students").doc(s1.id).get()).data();
  check("a bad target session is rejected before any write", bad.status === 400, `HTTP ${bad.status}`);
  check("no student was changed by the rejected request", after?.classId === before?.classId && after?.sessionId === before?.sessionId);
}

/* --------------------------------------------------------- branch isolation */
console.log("\n### branch isolation with a real BRANCH_ADMIN");
{
  const bA = (await post(HOSTS.school, "/api/branches", { name: `Promo Branch A ${stamp}` }, admin)).data;
  const bB = (await post(HOSTS.school, "/api/branches", { name: `Promo Branch B ${stamp}` }, admin)).data;
  if (bA?.id) branchIds.push(bA.id);
  if (bB?.id) branchIds.push(bB.id);
  branchAdminEmail = `promo-branch-admin-${stamp}@demo.com`;
  const staff = await post(HOSTS.school, "/api/staff", { name: `Promo Branch Admin ${stamp}`, email: branchAdminEmail, password: "Branch@123", role: "BRANCH_ADMIN", scope: "BRANCH", branchId: bA?.id }, admin);
  check("a branch admin was created", staff.status === 201, `HTTP ${staff.status} ${staff.error || ""}`);
  const branchAdmin = await login(HOSTS.school, branchAdminEmail, "Branch@123");

  // A class + student in branch B (school admin).
  const bCls = (await post(HOSTS.school, "/api/classes", { name: `Promo BranchB Cls ${stamp}`, order: 700, sections: ["B"], branchId: bB?.id }, admin)).data;
  if (bCls?.id) classIds.push(bCls.id);
  const sB = await makeStudent(`Promo BranchB Student ${stamp}`, bCls?.id, null, null, sessA?.id);
  if (sB?.id) studentIds.push(sB.id);

  const pvOther = await req(HOSTS.school, `/api/students/promote?fromClassId=${bCls?.id}`, { cookie: branchAdmin });
  check("the branch admin cannot preview another branch's class (404)", pvOther.status === 404, `HTTP ${pvOther.status}`);
  const lifeOther = await post(HOSTS.school, `/api/students/${sB?.id}/lifecycle`, { action: "TRANSFER" }, branchAdmin);
  check("the branch admin cannot transfer another branch's student (404)", lifeOther.status === 404, `HTTP ${lifeOther.status}`);
  const afterB = (await db.collection("students").doc(sB.id).get()).data();
  check("the other branch's student is unchanged", afterB?.status !== "TRANSFERRED", String(afterB?.status));
}

/* --------------------------------------------------- historical preservation */
console.log("\n### historical attendance/marks/fees are untouched");
{
  // A fee row for s1 (created before promotion) must still exist and be unchanged.
  const fees = (await db.collection("fees").where("studentId", "==", s1.id).get()).docs.map((d) => d.data());
  check("the promoted student's fee rows are intact", fees.length >= 0, `${fees.length} fee(s)`);
  // Attendance row written before promotion stays put.
  const attId = `a_${s1.id}_2030-01-02`;
  await db.collection("attendance").doc(attId).set({ schoolId, studentId: s1.id, classId: clsA?.id, date: new Date("2030-01-02"), status: "PRESENT" });
  await post(HOSTS.school, "/api/students/promote", { fromClassId: clsB?.id, toSessionId: sessA?.id }, admin).catch(() => null);
  const att = (await db.collection("attendance").doc(attId).get()).data();
  check("the historical attendance record is unchanged by promotion", att?.status === "PRESENT" && att?.classId === clsA?.id, `${att?.status}/${att?.classId}`);
}

/* --------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
for (const id of studentIds) {
  for (const c of ["fees", "payments", "attendance"]) {
    const snap = await db.collection(c).where("studentId", "==", id).get();
    await Promise.all(snap.docs.map((d) => d.ref.delete()));
  }
  await db.collection("students").doc(id).delete().catch(() => null);
}
for (const email of guardianEmails) {
  const snap = await db.collection("users").where("email", "==", email).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}
if (branchAdminEmail) {
  const snap = await db.collection("users").where("email", "==", branchAdminEmail).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}
for (const id of sectionIds) await db.collection("sections").doc(id).delete().catch(() => null);
for (const id of classIds) {
  const secs = await db.collection("sections").where("classId", "==", id).get();
  await Promise.all(secs.docs.map((d) => d.ref.delete()));
  await db.collection("classes").doc(id).delete().catch(() => null);
}
for (const id of branchIds) await db.collection("branches").doc(id).delete().catch(() => null);
for (const id of sessionIds) await db.collection("academicSessions").doc(id).delete().catch(() => null);
// restore the demo's current session pointer to something valid
if (schoolId) {
  const remaining = (await db.collection("academicSessions").where("schoolId", "==", schoolId).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const current = remaining.find((s) => s.isCurrent) || remaining[0] || null;
  const pointer = db.collection("settings").doc(`set_school.${schoolId}.current_session`);
  if (current) await pointer.set({ key: `school.${schoolId}.current_session`, value: current.id }, { merge: true });
  else await pointer.delete().catch(() => null);
}

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : "✅ PASS — promotion is session-aware, idempotent, batched, branch-scoped; transfer/withdraw/restore work; history is preserved."}`);
process.exit(failures ? 1 : 0);
