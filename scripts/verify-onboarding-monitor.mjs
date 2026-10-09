/**
 * verify-onboarding-monitor.mjs — Phase 5 Guardian Onboarding Monitor.
 *
 * Proves the read-only monitor:
 *   status derivation (LINKED · CREDENTIALS_READY · INCOMPLETE · LEGACY),
 *   summary counts, status/class/batch filters, branch isolation,
 *   foreign-batch 404, orphaned accounts after undo, canPrintSlip eligibility,
 *   and role authorization (SCHOOL_ADMIN 200 · BRANCH_ADMIN scoped ·
 *   TEACHER/GUARDIAN 403 · anonymous 401).
 *
 * Creates its own import batch, guardians, branches and a branch admin; removes
 * everything it created afterwards.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-onboarding-monitor.mjs
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

const HEADERS = ["Name", "Admission No", "Roll", "Registration No", "Class", "Section", "Name (Bangla)", "Date of Birth", "Gender", "Blood Group", "Birth Certificate No", "Address", "Previous School", "Previous School Class", "Guardian Name", "Guardian Phone", "Guardian Email", "Guardian Relation", "Photo URL"];
const row = (o = {}) => [o.name ?? "", o.admissionNo ?? "", o.roll ?? "", o.registrationNo ?? "", o.class ?? "", o.section ?? "", o.nameBn ?? "", o.dob ?? "", o.gender ?? "", o.bloodGroup ?? "", o.birthCertificateNo ?? "", o.address ?? "", o.previousSchoolName ?? "", o.previousSchoolClass ?? "", o.guardianName ?? "", o.guardianPhone ?? "", o.guardianEmail ?? "", o.guardianRelation ?? "", o.photoUrl ?? ""];
const numbered = (rows, start = 2) => rows.map((cells, i) => ({ rowNumber: start + i, cells }));
const post = (host, path, body, cookie) => req(host, path, { cookie, method: "POST", body: JSON.stringify(body) });

const admin = await login(HOSTS.school, "principal@sunrise.edu", "School@123");
const teacher = await login(HOSTS.teacher, "teacher@sunrise.edu", "Teacher@123");
const guardian = await login(HOSTS.parents, "guardian1@demo.com", "Guardian@123");

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
let mainBatchId = null;
let orphanBatchId = null;
let branchBatchId = null;
let branchA = null;
let branchB = null;

if (class1) {
  const existing = await req(HOSTS.school, "/api/academic-sessions", { cookie: admin });
  displacedCurrent = (existing.data || []).find((s) => s.isCurrent)?.id || null;
  const sres = await post(HOSTS.school, "/api/academic-sessions", { name: `Onboarding Verify ${stamp}`, isCurrent: true }, admin);
  sessionId = sres.data?.id || null;
}

/* ---------------------------------------------------------- authorization */
console.log("\n### authorization");
{
  const anon = await req(HOSTS.school, "/api/guardian-onboarding");
  check("anonymous is refused (401)", anon.status === 401, `HTTP ${anon.status}`);
  const t = await req(HOSTS.school, "/api/guardian-onboarding", { cookie: teacher });
  check("a teacher is refused (403)", t.status === 403, `HTTP ${t.status}`);
  const g = await req(HOSTS.school, "/api/guardian-onboarding", { cookie: guardian });
  check("a guardian is refused (403)", g.status === 403, `HTTP ${g.status}`);
  const a = await req(HOSTS.school, "/api/guardian-onboarding", { cookie: admin });
  check("a school admin is allowed (200)", a.status === 200 && !!a.data?.summary, `HTTP ${a.status}`);
}

/* ------------------------------------------------------- legacy derivation */
console.log("\n### legacy / missing marker is never INCOMPLETE");
const allStudents = (await req(HOSTS.school, "/api/students", { cookie: admin })).data || [];
const legacyStudent = allStudents.find((s) => !s.guardianOnboarding) || null;
check("there is a markerless (legacy) student to check", !!legacyStudent, legacyStudent?.admissionNo);
{
  const leg = await req(HOSTS.school, "/api/guardian-onboarding?status=LEGACY&limit=500", { cookie: admin });
  const ids = (leg.data?.students || []).map((r) => r.id);
  check("a markerless student is classified LEGACY", !!legacyStudent && ids.includes(legacyStudent.id), `${ids.length} legacy row(s)`);
  check("every LEGACY row truly has no marker", (leg.data?.students || []).every((r) => r.status === "legacy"));
}

/* -------------------------------------------- import three onboarding states */
console.log("\n### the three marked states from one import");
const admReady = `ONB-READY-${stamp}`;
const admLinked = `ONB-LINKED-${stamp}`;
const admIncomplete = `ONB-INCOMPLETE-${stamp}`;
const emailReady = `onb-ready-${stamp}@demo.com`;
createdAdmissionNos.push(admReady, admLinked, admIncomplete);
guardianEmails.push(emailReady);

// an existing guardian account to force a LINKED reuse
const existingGuardian = (await db.collection("users").where("schoolId", "==", schoolId).get()).docs
  .map((d) => ({ id: d.id, ...d.data() }))
  .find((u) => u.role === "GUARDIAN" && u.email) || null;
check("there is an existing guardian for a LINKED row", !!existingGuardian, existingGuardian?.email);

const before = (await req(HOSTS.school, "/api/guardian-onboarding", { cookie: admin })).data?.summary;
{
  const rows = [
    row({ name: `Onb Ready ${stamp}`, admissionNo: admReady, class: class1?.name, guardianName: `Onb Ready G ${stamp}`, guardianEmail: emailReady }),
    row({ name: `Onb Linked ${stamp}`, admissionNo: admLinked, class: class1?.name, guardianName: existingGuardian?.name, guardianEmail: existingGuardian?.email }),
    row({ name: `Onb Incomplete ${stamp}`, admissionNo: admIncomplete, class: class1?.name }),
  ];
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "onboarding.csv", headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: 3, final: true }, admin);
  mainBatchId = cm.data?.batchId || null;
  check("the import created all three students", cm.status === 200 && cm.data?.totals?.created === 3, `HTTP ${cm.status} created=${cm.data?.totals?.created}`);
}

const after = (await req(HOSTS.school, "/api/guardian-onboarding", { cookie: admin })).data?.summary;
{
  check("CREDENTIALS_READY increased by the new-guardian row", after.credentialsReady - before.credentialsReady >= 1, `${before.credentialsReady} → ${after.credentialsReady}`);
  check("LINKED increased by the reused-guardian row", after.linked - before.linked >= 1, `${before.linked} → ${after.linked}`);
  check("INCOMPLETE increased by the no-contact row", after.incomplete - before.incomplete >= 1, `${before.incomplete} → ${after.incomplete}`);
  check("LEGACY is unchanged by the import (markerless only)", after.legacy - before.legacy === 0, `${before.legacy} → ${after.legacy}`);
  check("summary totals add up", after.total === after.credentialsReady + after.linked + after.incomplete + after.legacy, JSON.stringify(after));
}

/* --------------------------------------------------------- batch + filters */
console.log("\n### batch filter + status filter + canPrintSlip");
const statusByAdm = {};
{
  const b = await req(HOSTS.school, `/api/guardian-onboarding?batchId=${mainBatchId}&limit=500`, { cookie: admin });
  const rows = b.data?.students || [];
  check("the batch filter returns exactly the three rows", b.status === 200 && rows.length === 3 && b.data?.total === 3, `HTTP ${b.status} n=${rows.length}`);
  for (const r of rows) statusByAdm[r.admissionNo] = r;
  check("the new-guardian row is credentialsReady", statusByAdm[admReady]?.status === "credentialsReady", String(statusByAdm[admReady]?.status));
  check("the reused-guardian row is linked", statusByAdm[admLinked]?.status === "linked", String(statusByAdm[admLinked]?.status));
  check("the no-contact row is incomplete (NOT legacy)", statusByAdm[admIncomplete]?.status === "incomplete", String(statusByAdm[admIncomplete]?.status));
  check("only the credentialsReady row can print a slip", statusByAdm[admReady]?.canPrintSlip === true && statusByAdm[admLinked]?.canPrintSlip === false && statusByAdm[admIncomplete]?.canPrintSlip === false, JSON.stringify(rows.map((r) => [r.admissionNo, r.canPrintSlip])));
  check("every batch row exposes its batchId", rows.every((r) => r.batchId === mainBatchId));

  const onlyReady = await req(HOSTS.school, `/api/guardian-onboarding?batchId=${mainBatchId}&status=CREDENTIALS_READY`, { cookie: admin });
  check("the status filter narrows to one credentialsReady row", (onlyReady.data?.students || []).length === 1 && onlyReady.data.students[0].admissionNo === admReady, JSON.stringify((onlyReady.data?.students || []).map((r) => r.admissionNo)));
  const onlyLinked = await req(HOSTS.school, `/api/guardian-onboarding?batchId=${mainBatchId}&status=LINKED`, { cookie: admin });
  check("the status filter narrows to one linked row", (onlyLinked.data?.students || []).length === 1 && onlyLinked.data.students[0].admissionNo === admLinked, JSON.stringify((onlyLinked.data?.students || []).map((r) => r.admissionNo)));
  const onlyIncomplete = await req(HOSTS.school, `/api/guardian-onboarding?batchId=${mainBatchId}&status=INCOMPLETE`, { cookie: admin });
  check("the status filter narrows to one incomplete row", (onlyIncomplete.data?.students || []).length === 1 && onlyIncomplete.data.students[0].admissionNo === admIncomplete, JSON.stringify((onlyIncomplete.data?.students || []).map((r) => r.admissionNo)));

  const byClass = await req(HOSTS.school, `/api/guardian-onboarding?batchId=${mainBatchId}&classId=${class1?.id}`, { cookie: admin });
  check("the class filter keeps the batch rows", (byClass.data?.students || []).length === 3, `n=${(byClass.data?.students || []).length}`);
  const wrongClass = await req(HOSTS.school, `/api/guardian-onboarding?batchId=${mainBatchId}&classId=cls_nope`, { cookie: admin });
  check("a non-matching class yields no rows", (wrongClass.data?.students || []).length === 0, `n=${(wrongClass.data?.students || []).length}`);

  const byQ = await req(HOSTS.school, `/api/guardian-onboarding?q=${encodeURIComponent(admReady)}`, { cookie: admin });
  check("the search filter finds the row by admission number", (byQ.data?.students || []).some((r) => r.admissionNo === admReady), `n=${(byQ.data?.students || []).length}`);
}

/* ------------------------------------------------------------ foreign batch */
console.log("\n### foreign batch is refused (404)");
{
  const foreignId = `imp_onb_foreign_${stamp}`;
  await db.collection("importBatches").doc(foreignId).set({ schoolId: `s_other_${stamp}`, module: "students", status: "DONE" });
  const r = await req(HOSTS.school, `/api/guardian-onboarding?batchId=${foreignId}`, { cookie: admin });
  check("a batch from another school answers 404", r.status === 404, `HTTP ${r.status}`);
  const missing = await req(HOSTS.school, `/api/guardian-onboarding?batchId=imp_missing_${stamp}`, { cookie: admin });
  check("an unknown batch answers 404", missing.status === 404, `HTTP ${missing.status}`);
  await db.collection("importBatches").doc(foreignId).delete();
}

/* --------------------------------------------------------- branch isolation */
console.log("\n### branch isolation with a real BRANCH_ADMIN");
{
  const a = await post(HOSTS.school, "/api/branches", { name: `Onb Branch A ${stamp}` }, admin);
  const b = await post(HOSTS.school, "/api/branches", { name: `Onb Branch B ${stamp}` }, admin);
  branchA = a.data;
  branchB = b.data;
  if (branchA?.id) branchIds.push(branchA.id);
  if (branchB?.id) branchIds.push(branchB.id);

  branchAdminEmail = `onb-branch-admin-${stamp}@demo.com`;
  const staff = await post(HOSTS.school, "/api/staff", { name: `Onb Branch Admin ${stamp}`, email: branchAdminEmail, password: "Branch@123", role: "BRANCH_ADMIN", scope: "BRANCH", branchId: branchA?.id }, admin);
  check("a branch admin was created for branch A", staff.status === 201, `HTTP ${staff.status} ${staff.error || ""}`);

  // a batch in branch B (school admin)
  const admB = `ONB-BRANCHB-${stamp}`;
  const emailB = `onb-branchb-${stamp}@demo.com`;
  createdAdmissionNos.push(admB);
  guardianEmails.push(emailB);
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "onb-branchb.csv", branchId: branchB?.id, headers: HEADERS, rows: numbered([row({ name: `Onb BranchB ${stamp}`, admissionNo: admB, class: class1?.name, guardianName: `Onb BranchB G ${stamp}`, guardianEmail: emailB })]), allowWarnings: true, totalRows: 1, final: true }, admin);
  branchBatchId = cm.data?.batchId || null;
  check("the school admin imported into branch B", cm.status === 200 && cm.data?.totals?.created === 1, `HTTP ${cm.status}`);

  const branchAdmin = await login(HOSTS.school, branchAdminEmail, "Branch@123");

  // the branch admin imports a student into its own branch
  const admA = `ONB-BRANCHA-${stamp}`;
  const emailA = `onb-brancha-${stamp}@demo.com`;
  createdAdmissionNos.push(admA);
  guardianEmails.push(emailA);
  const cmA = await post(HOSTS.school, "/api/import/students/commit", { fileName: "onb-brancha.csv", headers: HEADERS, rows: numbered([row({ name: `Onb BranchA ${stamp}`, admissionNo: admA, class: class1?.name, guardianName: `Onb BranchA G ${stamp}`, guardianEmail: emailA })]), allowWarnings: true, totalRows: 1, final: true }, branchAdmin);
  check("the branch admin imports into its own branch", cmA.status === 200 && cmA.data?.totals?.created === 1, `HTTP ${cmA.status} ${cmA.error || ""}`);

  const scoped = await req(HOSTS.school, "/api/guardian-onboarding?limit=500", { cookie: branchAdmin });
  check("the branch admin can read the monitor (200)", scoped.status === 200, `HTTP ${scoped.status}`);
  const scopedAdms = (scoped.data?.students || []).map((r) => r.admissionNo);
  check("the branch admin sees its own branch's student", scopedAdms.includes(admA), `${scopedAdms.length} row(s)`);
  check("the branch admin never sees branch B's student", !scopedAdms.includes(admB), `${scopedAdms.length} row(s)`);
  check("the branch admin sees only its own branch", (scoped.data?.students || []).every((r) => r.branchId === branchA?.id || r.branchId === null), "branch filter");

  const crossBatch = await req(HOSTS.school, `/api/guardian-onboarding?batchId=${branchBatchId}`, { cookie: branchAdmin });
  check("the branch admin cannot filter by another branch's batch (404)", crossBatch.status === 404, `HTTP ${crossBatch.status}`);

  const ownBranchOption = (scoped.data?.options?.batches || []).map((b) => b.id);
  check("the branch admin's batch options exclude other branches", !ownBranchOption.includes(branchBatchId), JSON.stringify(ownBranchOption));
}

/* ------------------------------------------------ orphaned account after undo */
console.log("\n### orphaned account after undo");
const orphanEmail = `onb-orphan-${stamp}@demo.com`;
guardianEmails.push(orphanEmail);
{
  const admOrphan = `ONB-ORPHAN-${stamp}`;
  createdAdmissionNos.push(admOrphan);
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "onb-orphan.csv", headers: HEADERS, rows: numbered([row({ name: `Onb Orphan ${stamp}`, admissionNo: admOrphan, class: class1?.name, guardianName: `Onb Orphan G ${stamp}`, guardianEmail: orphanEmail })]), allowWarnings: true, totalRows: 1, final: true }, admin);
  orphanBatchId = cm.data?.batchId || null;

  const preUndo = (await req(HOSTS.school, "/api/guardian-onboarding?limit=500", { cookie: admin })).data;
  check("the provisioned account is NOT orphaned while it has a child", !(preUndo?.orphanedAccounts || []).some((g) => g.email === orphanEmail));

  const un = await post(HOSTS.school, `/api/import/students/${orphanBatchId}/undo`, {}, admin);
  check("undo removes the imported student", un.status === 200 && un.data?.removedStudents === 1, JSON.stringify(un.data));

  const postUndo = (await req(HOSTS.school, "/api/guardian-onboarding?limit=500", { cookie: admin })).data;
  const orphans = postUndo?.orphanedAccounts || [];
  check("the account becomes orphaned after undo", orphans.some((g) => g.email === orphanEmail), JSON.stringify(orphans.map((g) => g.email)));
  check("orphaned accounts are separate from student status totals", postUndo.summary.total === postUndo.summary.credentialsReady + postUndo.summary.linked + postUndo.summary.incomplete + postUndo.summary.legacy, JSON.stringify(postUndo.summary));
  check("the orphan is not counted as a student status", !postUndo.students.some((r) => r.guardianEmail === orphanEmail));
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
const batchNames = ["onboarding.csv", "onb-brancha.csv", "onb-branchb.csv", "onb-orphan.csv"];
const strayBatches = (await db.collection("importBatches").get()).docs.filter((d) => batchNames.includes(d.data().fileName));
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

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : "✅ PASS — the onboarding monitor derives every state, filters correctly, isolates branches, lists orphaned accounts, and enforces role access."}`);
process.exit(failures ? 1 : 0);
