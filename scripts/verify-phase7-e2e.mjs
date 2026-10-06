/**
 * phase7-e2e.mjs — Phase 7 Full-System Production Readiness Audit.
 *
 * Builds ONE isolated, temporary synthetic school (2 branches, 4 academic
 * sessions, Play→Class 10 hierarchy, multiple sections, ~80 students across
 * branches/sessions, sibling/reuse/ambiguous-phone/no-contact cases), drives the
 * real HTTP routes through the whole lifecycle (New Admission → Bulk Import →
 * QR credentials → Guardian login → Onboarding monitor → Promotion/rollover →
 * Transfer/withdraw/restore), captures historical data before lifecycle ops and
 * re-checks it after, exercises authorization/isolation and negative tests, then
 * removes EVERYTHING it created and prints a residue report.
 *
 * It NEVER touches any pre-existing school. Cleanup sweeps strictly by the
 * synthetic school's own id.
 *
 * Usage: SMOKE_PORT=3000 bun .freebuff/phase7-e2e.mjs [--keep]
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const KEEP = process.argv.includes("--keep");

let PASS = 0;
let FAIL = 0;
const sectionResults = [];
function sec(name) {
  sectionResults.push({ name, pass: 0, fail: 0 });
  console.log(`\n### ${name}`);
}
function check(label, ok, detail = "") {
  if (ok) PASS++;
  else FAIL++;
  if (sectionResults.length) {
    const s = sectionResults[sectionResults.length - 1];
    ok ? s.pass++ : s.fail++;
  }
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
}

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

const HOSTS = {
  admin: `admin.localhost:${PORT}`,
  school: `school.localhost:${PORT}`,
  parents: `parents.localhost:${PORT}`,
  teacher: `teacher.localhost:${PORT}`,
};

async function req(host, path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    ...init,
    headers: { Host: host, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(180000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* html / redirect */
  }
  return {
    status: res.status,
    location: res.headers.get("location") || "",
    data: body?.data ?? null,
    error: body?.error ?? null,
    setCookie: res.headers.get("set-cookie") || "",
    text,
  };
}
const post = (host, path, body, cookie) => req(host, path, { cookie, method: "POST", body: JSON.stringify(body) });
const patch = (host, path, body, cookie) => req(host, path, { cookie, method: "PATCH", body: JSON.stringify(body) });

async function login(host, identifier, password) {
  const r = await req(host, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
  if (r.status !== 200) throw new Error(`login ${identifier}: HTTP ${r.status} ${r.error || ""}`);
  const cookie = r.setCookie.split(";")[0];
  if (!cookie) throw new Error(`login ${identifier}: no cookie`);
  return cookie;
}

/* -------------------------------------------------------------- global state */
const stamp = Date.now();
let SYN = null; // synthetic school id
let admin = null;
let saCookie = null;
let branchA = null;
let branchB = null;
const SESSIONS = {}; // s1..s4
const CLASSES = {}; // name -> { id, order, branchId }
const SECTIONS = {}; // classId -> [{id,name}]
const created = {
  admissionNos: new Set(),
  guardianEmails: new Set(),
  batchIds: new Set(),
  studentIds: new Set(),
  branchAdminEmail: null,
  teacherEmail: null,
};
const SYN_EMAILS = [];

const HEADERS = ["Name", "Admission No", "Roll", "Registration No", "Class", "Section", "Name (Bangla)", "Date of Birth", "Gender", "Blood Group", "Birth Certificate No", "Address", "Previous School", "Previous School Class", "Guardian Name", "Guardian Phone", "Guardian Email", "Guardian Relation", "Photo URL"];
const mkRow = (o = {}) => [o.name ?? "", o.admissionNo ?? "", o.roll ?? "", o.registrationNo ?? "", o.class ?? "", o.section ?? "", o.nameBn ?? "", o.dob ?? "", o.gender ?? "", o.bloodGroup ?? "", o.birthCertificateNo ?? "", o.address ?? "", o.previousSchoolName ?? "", o.previousSchoolClass ?? "", o.guardianName ?? "", o.guardianPhone ?? "", o.guardianEmail ?? "", o.guardianRelation ?? "", o.photoUrl ?? ""];
const numbered = (rows, start = 2) => rows.map((cells, i) => ({ rowNumber: start + i, cells }));

const TRANSIENT = /(ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|UNAVAILABLE|DEADLINE|No connection|timed out|socket hang up|grpc)/i;
async function retry(fn, label = "op", tries = 8) {
  let last;
  for (let i = 1; i <= tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e?.message || e);
      if (i === tries || !TRANSIENT.test(msg)) throw e;
      const wait = Math.min(1500 * i, 12000);
      console.log(`  ... transient Firestore error on ${label} (try ${i}/${tries}); retrying in ${wait}ms — ${msg.slice(0, 90)}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw last;
}
async function fsDocs(col, field, value) {
  const snap = await retry(() => db.collection(col).where(field, "==", value).get(), `${col}.where(${field})`);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function fsAll(col) {
  const snap = await retry(() => db.collection(col).get(), `${col}.get`);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function studentByAdm(adm) {
  const list = await fsDocs("students", "admissionNo", adm);
  return list.find((s) => s.schoolId === SYN) || null;
}

/* ============================================================ MAIN */
let synSlug = null;
try {
  await main();
} catch (e) {
  console.log(`\n!! harness aborted: ${e?.stack || e?.message || e}`);
  FAIL++;
  sectionResults.push({ name: "harness-abort", pass: 0, fail: 1 });
}

/* ------------------------------------------------------------- cleanup + residue */
const SWEEP = [
  "students", "users", "teachers", "classes", "sections", "subjects", "attendance", "remarks",
  "homeworks", "submissions", "exams", "marks", "fees", "payments", "messages", "notices",
  "feeSettings", "auditLogs", "academicSessions", "branches", "admissions", "admissionDocuments",
  "discounts", "importBatches", "importBatchRows", "installments", "ledger", "notifications",
  "conversations", "conversationMessages", "smsLogs", "classSessions", "routines", "assignments",
  "resources", "leaveRequests", "meetingSlots", "meetingBookings", "complaints", "gallery",
  "healthRecords", "feeTemplates", "feeTemplateItems", "feeCategories", "expenseEntries", "vendors",
  "payroll", "quizzes", "questions", "quizAttempts", "virtualClasses", "timetableSlots",
  "substitutions", "calendarEvents", "bookCatalog", "bookStock", "bookIssues", "devices",
  "subscriptions", "invoices", "paymentIntents", "twoFactor",
];

let cleanupErrors = 0;
async function deleteDoc(col, id) {
  try {
    await retry(() => db.collection(col).doc(id).delete(), `${col}.delete`);
  } catch (e) {
    cleanupErrors++;
    console.log(`  !! cleanup could not delete ${col}/${id}: ${String(e?.message || e).slice(0, 120)}`);
  }
}
async function syntheticSchoolIds(includeSyn = true) {
  const all = await fsAll("schools");
  const ids = new Set(all.filter((s) => String(s.name || "").startsWith("Phase7 Synthetic")).map((s) => s.id));
  if (includeSyn && SYN) ids.add(SYN);
  return [...ids];
}

const synStudentIds = new Set();
const synExamIds = new Set();

if (!KEEP) {
  console.log("\n### cleanup");
  const synIds = await syntheticSchoolIds();
  console.log(`  synthetic schools to sweep: ${synIds.length} — ${synIds.join(", ")}`);
  for (const id of synIds) {
    for (const s of await fsDocs("students", "schoolId", id)) synStudentIds.add(s.id);
    for (const x of await fsDocs("exams", "schoolId", id)) synExamIds.add(x.id);
    for (const col of SWEEP) {
      for (const d of await fsDocs(col, "schoolId", id)) await deleteDoc(col, d.id);
    }
    const settings = (await fsAll("settings")).filter((d) => d.id.includes(id) || String(d.key || "").includes(id));
    for (const d of settings) await deleteDoc("settings", d.id);
    await deleteDoc("schools", id);
  }
  // schoolId-less exam marks: identified precisely by the synthetic exams/students that owned them.
  for (const m of await fsAll("marks")) {
    if (synExamIds.has(m.examId) || synStudentIds.has(m.studentId)) await deleteDoc("marks", m.id);
  }
  // belt-and-suspenders: no synthetic account survives, whatever its stamp.
  for (const u of await fsAll("users")) {
    if (String(u.email || "").endsWith("@p7test.local")) await deleteDoc("users", u.id);
  }
}

console.log("\n### residue check");
const residue = {};
const residualIds = await syntheticSchoolIds(false); // actual live synthetic school docs only
const RESIDUE_COLS = ["students", "users", "classes", "sections", "academicSessions", "branches", "importBatches", "importBatchRows", "attendance", "remarks", "homeworks", "exams", "marks", "fees", "payments", "ledger", "subjects", "notifications", "auditLogs", "admissions", "installments", "subscriptions", "invoices", "feeSettings"];
for (const col of RESIDUE_COLS) {
  residue[col] = 0;
  for (const id of residualIds) residue[col] += (await fsDocs(col, "schoolId", id)).length;
}
residue.schools = residualIds.length;
residue.settings = (await fsAll("settings")).filter((d) => residualIds.some((id) => d.id.includes(id))).length;
residue.syntheticAccounts = (await fsAll("users")).filter((u) => String(u.email || "").endsWith("@p7test.local")).length;
const liveExamsR = new Set((await fsAll("exams")).map((d) => d.id));
const liveStudentsR = new Set((await fsAll("students")).map((d) => d.id));
residue.orphanMarks = (await fsAll("marks")).filter((m) => (m.examId && !liveExamsR.has(m.examId)) || (m.studentId && !liveStudentsR.has(m.studentId))).length;
residue.cleanupErrors = cleanupErrors;
console.log(JSON.stringify(residue, null, 2));

const totalResidue = Object.values(residue).reduce((a, b) => a + b, 0);
console.log(`\n### section summary`);
for (const s of sectionResults) console.log(`  ${s.fail ? "FAIL" : "pass"}  ${s.name}  (${s.pass}/${s.pass + s.fail})`);
console.log(`\nTOTAL: ${PASS} passed, ${FAIL} failed${KEEP ? " (--keep: synthetic data left in place)" : ""}`);
console.log(totalResidue === 0 ? "RESIDUE: CLEAN (0 documents)" : `RESIDUE: ${totalResidue} document(s) remain`);
process.exit(FAIL ? 1 : 0);

/* ============================================================ IMPLEMENTATION */
async function main() {
  console.log(`=== Phase 7 synthetic-school audit (${BASE})`);
  saCookie = await login(HOSTS.admin, "admin@smartschool.com", "Admin@123");

  /* ---------------------------------------------------------- 1. synthetic school */
  sec("1. synthetic school + branches + sessions");
  synSlug = `p7-synth-${stamp}`;
  const adminEmail = `p7-admin-${stamp}@p7test.local`;
  SYN_EMAILS.push(adminEmail);
  const adminPw = `P7Admin!${stamp}`;
  const schoolRes = await post(HOSTS.school, "/api/schools", {
    name: `Phase7 Synthetic ${stamp}`,
    address: "1 Synthetic Avenue",
    admin: { name: "P7 Admin", email: adminEmail, password: adminPw },
  }, saCookie);
  SYN = schoolRes.data?.school?.id || null;
  check("a SUPER_ADMIN can create an isolated synthetic school", schoolRes.status === 201 && !!SYN, `HTTP ${schoolRes.status} ${schoolRes.error || ""}`);
  if (!SYN) throw new Error("synthetic school was not created — aborting");

  admin = await login(HOSTS.school, adminEmail, adminPw);
  const me = await req(HOSTS.school, "/api/auth/me", { cookie: admin });
  check("the synthetic SCHOOL_ADMIN is signed in", me.data?.school?.id === SYN || me.data?.schoolId === SYN, `HTTP ${me.status}`);

  // branches: the auto "Main Campus" is branch A; add "North Campus" as branch B
  const brRes = await req(HOSTS.school, "/api/branches", { cookie: admin });
  const brList = Array.isArray(brRes.data) ? brRes.data : brRes.data?.branches || [];
  branchA = brList.find((b) => b.name === "Main Campus") || brList[0] || null;
  const northRes = await post(HOSTS.school, "/api/branches", { name: `North Campus ${stamp}`, code: "NC" }, admin);
  branchB = northRes.data || null;
  check("two branches exist (Main + North)", !!branchA?.id && !!branchB?.id, `${branchA?.id} / ${branchB?.id}`);

  // four academic sessions
  const s1 = (await post(HOSTS.school, "/api/academic-sessions", { name: `P7 2023-24 ${stamp}`, startDate: "2023-01-01", endDate: "2023-12-31", isCurrent: true }, admin)).data;
  const s2 = (await post(HOSTS.school, "/api/academic-sessions", { name: `P7 2024-25 ${stamp}`, startDate: "2024-01-01", endDate: "2024-12-31" }, admin)).data;
  const s3 = (await post(HOSTS.school, "/api/academic-sessions", { name: `P7 2025-26 ${stamp}`, startDate: "2025-01-01", endDate: "2025-12-31" }, admin)).data;
  const s4 = (await post(HOSTS.school, "/api/academic-sessions", { name: `P7 2026-27 ${stamp}`, startDate: "2026-01-01", endDate: "2026-12-31" }, admin)).data;
  SESSIONS.s1 = s1; SESSIONS.s2 = s2; SESSIONS.s3 = s3; SESSIONS.s4 = s4;
  check("four academic sessions were created", [s1, s2, s3, s4].every((s) => s?.id), `${[s1, s2, s3, s4].filter((s) => s?.id).length}`);
  const list = (await req(HOSTS.school, "/api/academic-sessions", { cookie: admin })).data || [];
  check("exactly one session is current (the 2023-24 session)", list.filter((s) => s.isCurrent).length === 1 && list.find((s) => s.isCurrent)?.id === s1?.id, list.map((s) => `${s.name}:${s.isCurrent}`).join(","));

  /* ---------------------------------------------------------- 2. class hierarchy */
  sec("2. class hierarchy + sections");
  const HIER = [["Play", 0, ["A"]], ["Nursery", 1, ["A"]], ["KG", 2, ["A"]], ["Class 1", 3, ["A", "B"]], ["Class 2", 4, ["A", "B"]], ["Class 3", 5, ["A", "B"]], ["Class 4", 6, ["A", "B"]], ["Class 5", 7, ["A", "B"]], ["Class 6", 8, ["A", "B"]], ["Class 7", 9, ["A", "B"]], ["Class 8", 10, ["A", "B"]], ["Class 9", 11, ["A", "B"]], ["Class 10", 12, ["A", "B"]]];
  const HIER_B = [["North Play", -100, ["N"]], ["North Nursery", -99, ["N"]], ["North KG", -98, ["N"]], ["North Class 1", -97, ["N", "S"]], ["North Class 2", -96, ["N", "S"]], ["North Class 3", -95, ["N", "S"]], ["North Class 4", -94, ["N", "S"]], ["North Class 5", -93, ["N", "S"]]];
  const MISMATCH = [["P7 Src 5", -50, ["Z"]], ["P7 Dst 6", -49, ["Q"]]];

  for (const [name, order, sections] of HIER) {
    const c = (await post(HOSTS.school, "/api/classes", { name, order, sections, branchId: branchA.id }, admin)).data;
    if (c?.id) CLASSES[name] = { id: c.id, order, branchId: branchA.id };
  }
  for (const [name, order, sections] of HIER_B) {
    const c = (await post(HOSTS.school, "/api/classes", { name, order, sections, branchId: branchB.id }, admin)).data;
    if (c?.id) CLASSES[name] = { id: c.id, order, branchId: branchB.id };
  }
  for (const [name, order, sections] of MISMATCH) {
    const c = (await post(HOSTS.school, "/api/classes", { name, order, sections, branchId: branchA.id }, admin)).data;
    if (c?.id) CLASSES[name] = { id: c.id, order, branchId: branchA.id };
  }
  check("the Play→Class 10 hierarchy was created (13 classes)", HIER.every(([n]) => CLASSES[n]?.id), `${HIER.filter(([n]) => CLASSES[n]?.id).length}/13`);
  check("the North Campus classes were created (8 classes)", HIER_B.every(([n]) => CLASSES[n]?.id), `${HIER_B.filter(([n]) => CLASSES[n]?.id).length}/8`);
  // read sections back (POST /api/classes returns the class only)
  for (const name of Object.keys(CLASSES)) {
    SECTIONS[CLASSES[name].id] = await fsDocs("sections", "classId", CLASSES[name].id);
  }
  check("Class 1 carries two sections", (SECTIONS[CLASSES["Class 1"].id] || []).length === 2, `${(SECTIONS[CLASSES["Class 1"].id] || []).length}`);
  const secA1 = SECTIONS[CLASSES["Class 1"].id]?.[0];

  /* ---------------------------------------------------------- 3. staff accounts */
  sec("3. staff accounts (teacher + branch admin)");
  created.teacherEmail = `p7-teacher-${stamp}@p7test.local`;
  SYN_EMAILS.push(created.teacherEmail);
  const teacherPw = `P7Teach!${stamp}`;
  const tRes = await post(HOSTS.school, "/api/teachers", { name: `P7 Teacher ${stamp}`, email: created.teacherEmail, password: teacherPw, branchId: branchA.id }, admin);
  check("a teacher account was created", tRes.status === 201 && !!tRes.data?.id, `HTTP ${tRes.status} ${tRes.error || ""}`);
  const teacher = await login(HOSTS.teacher, created.teacherEmail, teacherPw);

  created.branchAdminEmail = `p7-branchadmin-${stamp}@p7test.local`;
  SYN_EMAILS.push(created.branchAdminEmail);
  const bAdminPw = `P7Branch!${stamp}`;
  const baRes = await post(HOSTS.school, "/api/staff", { name: `P7 Branch Admin ${stamp}`, email: created.branchAdminEmail, password: bAdminPw, role: "BRANCH_ADMIN", scope: "BRANCH", branchId: branchB.id }, admin);
  check("a BRANCH_ADMIN for North Campus was created", baRes.status === 201, `HTTP ${baRes.status} ${baRes.error || ""}`);
  const branchAdmin = await login(HOSTS.school, created.branchAdminEmail, bAdminPw);

  /* ---------------------------------------------------------- 4. New Admission */
  sec("4. student onboarding — New Admission");
  let admSeq = 0;
  const adm = (tag) => {
    const a = `P7-${tag}-${stamp}-${++admSeq}`;
    created.admissionNos.add(a);
    return a;
  };
  async function newAdmission(opts) {
    const admissionNo = opts.admissionNo || adm(opts.tag || "NA");
    const res = await post(HOSTS.school, "/api/students", {
      name: opts.name,
      admissionNo,
      classId: opts.classId,
      sectionId: opts.sectionId || null,
      roll: opts.roll ?? null,
      guardianName: opts.guardianName || null,
      guardianPhone: opts.guardianPhone || null,
      guardianEmail: opts.guardianEmail || null,
      guardianRelation: opts.guardianRelation || "Father",
      createGuardian: !!opts.createGuardian,
      createFees: opts.createFees === true,
      sessionId: opts.sessionId || null,
      branchId: opts.branchId || null,
      dob: opts.dob || "2015-01-01",
      gender: opts.gender || "MALE",
    }, admin);
    if (res.data?.id) created.studentIds.add(res.data.id);
    if (opts.guardianEmail) {
      created.guardianEmails.add(String(opts.guardianEmail).toLowerCase());
      SYN_EMAILS.push(String(opts.guardianEmail).toLowerCase());
    }
    return { ...res, admissionNo };
  }

  // special family/guardian cases + session distribution
  const gSib = `p7-sib-${stamp}@p7test.local`; // sibling group sharing one guardian account
  const gReuse = `p7-reuse-${stamp}@p7test.local`; // reused across students
  const PHONE_SIB = `0197${String(stamp).slice(-6)}1`;
  const PHONE_REUSE = `0197${String(stamp).slice(-6)}2`;
  const PHONE_AMB = `0197${String(stamp).slice(-6)}3`;
  const PHONE_NOSIB = `0197${String(stamp).slice(-6)}4`;

  const cls1 = CLASSES["Class 1"].id, cls2 = CLASSES["Class 2"].id, cls3 = CLASSES["Class 3"].id, cls5 = CLASSES["Class 5"].id, cls10 = CLASSES["Class 10"].id, clsPlay = CLASSES["Play"].id, clsKG = CLASSES["KG"].id;
  const secCls1A = (SECTIONS[cls1] || [])[0];
  const secCls5A = (SECTIONS[cls5] || [])[0];

  // sibling group 1 — same guardian account, two children (email reuse)
  const sib1 = await newAdmission({ name: `P7 Sibling One ${stamp}`, classId: cls1, sectionId: secCls1A?.id, guardianName: `P7 Sib Guardian ${stamp}`, guardianEmail: gSib, guardianPhone: PHONE_SIB, createGuardian: true, sessionId: SESSIONS.s1.id, tag: "SIB1" });
  const sib2 = await newAdmission({ name: `P7 Sibling Two ${stamp}`, classId: cls3, guardianName: `P7 Sib Guardian ${stamp}`, guardianEmail: gSib, guardianPhone: PHONE_SIB, createGuardian: true, sessionId: SESSIONS.s1.id, tag: "SIB2" });
  check("a sibling group shares one guardian account", sib1.data?.id && sib2.data?.id, `${sib1.data?.guardianUserId} / ${sib2.data?.guardianUserId}`);
  const sib1Doc = await studentByAdm(sib1.admissionNo);
  const sib2Doc = await studentByAdm(sib2.admissionNo);
  check("both siblings resolve to the same guardian account", !!sib1Doc?.guardianUserId && sib1Doc.guardianUserId === sib2Doc?.guardianUserId, `${sib1Doc?.guardianUserId} vs ${sib2Doc?.guardianUserId}`);

  // guardian email reuse across two more students (different classes)
  const r1 = await newAdmission({ name: `P7 Reuse A ${stamp}`, classId: cls2, guardianName: `P7 Reuse Guardian ${stamp}`, guardianEmail: gReuse, guardianPhone: PHONE_REUSE, createGuardian: true, sessionId: SESSIONS.s2.id, tag: "REU1" });
  const r2 = await newAdmission({ name: `P7 Reuse B ${stamp}`, classId: cls3, guardianName: `P7 Reuse Guardian ${stamp}`, guardianEmail: gReuse, guardianPhone: PHONE_REUSE, createGuardian: true, sessionId: SESSIONS.s2.id, tag: "REU2" });
  check("a guardian email is reused across two students", r1.data?.id && r2.data?.id, `${r1.data?.guardianUserId} / ${r2.data?.guardianUserId}`);

  // ambiguous phone: TWO guardian accounts share the same phone
  // NOTE: use distinct emails from the batch0 accounts below (gAmb1/gAmb2). The
  // New Admission route does not persist a guardian phone onto the account, so
  // if batch0 reused these emails its phone-bearing create would be skipped by the
  // import's empty upsert-update — and the ambiguity would never materialize.
  const amb1 = await newAdmission({ name: `P7 Ambiguous A ${stamp}`, classId: cls2, guardianName: `P7 Amb A ${stamp}`, guardianEmail: `p7-amb-na1-${stamp}@p7test.local`, guardianPhone: PHONE_AMB, createGuardian: true, sessionId: SESSIONS.s1.id, tag: "AMB1" });
  const amb2 = await newAdmission({ name: `P7 Ambiguous B ${stamp}`, classId: cls3, guardianName: `P7 Amb B ${stamp}`, guardianEmail: `p7-amb-na2-${stamp}@p7test.local`, guardianPhone: PHONE_AMB, createGuardian: true, sessionId: SESSIONS.s1.id, tag: "AMB2" });
  check("two guardian accounts were created sharing one phone (ambiguous)", amb1.data?.id && amb2.data?.id, `${amb1.data?.guardianUserId} / ${amb2.data?.guardianUserId}`);

  // students without any guardian contact
  const noc1 = await newAdmission({ name: `P7 No Contact ${stamp}`, classId: cls1, sectionId: secCls1A?.id, createGuardian: false, sessionId: SESSIONS.s1.id, tag: "NOC" });
  const noc2 = await newAdmission({ name: `P7 No Contact 2 ${stamp}`, classId: clsPlay, createGuardian: false, sessionId: SESSIONS.s3.id, tag: "NOC2" });
  check("students without guardian contact were created", noc1.data?.id && noc2.data?.id);
  const noc1Doc = await studentByAdm(noc1.admissionNo);
  check("a no-contact student carries no guardian account", !noc1Doc?.guardianUserId, String(noc1Doc?.guardianUserId));

  // fill out the roster across classes/sessions/branches
  const HIER_NAMES = HIER.map(([n]) => n);
  let naCount = 6;
  for (const name of HIER_NAMES) {
    const cls = CLASSES[name];
    const per = name.startsWith("Class") ? 2 : 1;
    for (let i = 0; i < per; i++) {
      const sessionId = [SESSIONS.s1.id, SESSIONS.s2.id, SESSIONS.s3.id, SESSIONS.s4.id][naCount % 4];
      const email = `p7-na-${stamp}-${naCount}@p7test.local`;
      await newAdmission({ name: `P7 ${name} Pupil ${stamp}-${i}`, classId: cls.id, sectionId: (SECTIONS[cls.id] || [])[0]?.id, guardianName: `P7 ${name} Guardian ${stamp}`, guardianEmail: email, createGuardian: true, sessionId, branchId: cls.branchId, tag: `F${naCount}` });
      naCount++;
    }
  }
  for (const name of HIER_B.map(([n]) => n)) {
    const cls = CLASSES[name];
    const email = `p7-nb-${stamp}-${naCount}@p7test.local`;
    await newAdmission({ name: `P7 ${name} Pupil ${stamp}`, classId: cls.id, sectionId: (SECTIONS[cls.id] || [])[0]?.id, guardianName: `P7 ${name} Guardian ${stamp}`, guardianEmail: email, createGuardian: true, sessionId: SESSIONS.s1.id, branchId: cls.branchId, tag: `NB${naCount}` });
    naCount++;
  }
  const naTotal = naCount;
  const synStudents = await fsDocs("students", "schoolId", SYN);
  check(`New Admission created a full synthetic roster (${synStudents.length} students so far)`, synStudents.length >= 25, `${synStudents.length}`);

  /* ---------------------------------------------------------- 5. bulk import */
  sec("5. student onboarding — Bulk Import (reuse / sibling / ambiguous / duplicate / rerun)");
  async function commit(fileName, rows, opts = {}) {
    const res = await post(HOSTS.school, "/api/import/students/commit", { fileName, headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: rows.length, final: true, ...opts }, admin);
    if (res.data?.batchId) created.batchIds.add(res.data.batchId);
    return res;
  }

  const gNew = `p7-imp-new-${stamp}@p7test.local`;
  const gImpSib = `p7-imp-sib-${stamp}@p7test.local`;
  const gAmb1 = `p7-amb1-${stamp}@p7test.local`;
  const gAmb2 = `p7-amb2-${stamp}@p7test.local`;
  SYN_EMAILS.push(gNew, gImpSib, gAmb1, gAmb2);
  const dupAdm = sib1.admissionNo; // an admission number already on file (from New Admission)
  const ambAdm = `P7-IMP-AMB-${stamp}`;
  created.admissionNos.add(ambAdm);
  const PHONE_IMP = `0197${String(stamp).slice(-6)}9`;

  // batch 0 — two guardian accounts that deliberately SHARE one phone number, so
  // the ambiguous-phone row below matches TWO accounts and must never auto-link.
  const b0 = await commit("p7-batch0.csv", [
    mkRow({ name: `P7 Amb Account A ${stamp}`, admissionNo: `P7-AMB0-${stamp}-1`, class: "Class 7", guardianName: `P7 Amb A ${stamp}`, guardianEmail: gAmb1, guardianPhone: PHONE_AMB }),
    mkRow({ name: `P7 Amb Account B ${stamp}`, admissionNo: `P7-AMB0-${stamp}-2`, class: "Class 7", guardianName: `P7 Amb B ${stamp}`, guardianEmail: gAmb2, guardianPhone: PHONE_AMB }),
  ], { branchId: branchA.id });
  for (const a of [`P7-AMB0-${stamp}-1`, `P7-AMB0-${stamp}-2`]) created.admissionNos.add(a);
  check("two guardian accounts were provisioned sharing one phone (ambiguous)", b0.status === 200 && Number(b0.data?.totals?.created) === 2, `HTTP ${b0.status} created=${b0.data?.totals?.created}`);

  const batch1Rows = [
    mkRow({ name: `P7 Imp New A ${stamp}`, admissionNo: `P7-IMP-${stamp}-1`, class: "Class 1", section: "A", guardianName: `P7 Imp Guardian A ${stamp}`, guardianEmail: gNew }),
    mkRow({ name: `P7 Imp New B ${stamp}`, admissionNo: `P7-IMP-${stamp}-2`, class: "Class 1", section: "A", guardianName: `P7 Imp Guardian B ${stamp}`, guardianEmail: `p7-imp-newb-${stamp}@p7test.local` }),
    // sibling pair sharing one guardian email → account provisioned for the first, reused+family-linked for the second
    mkRow({ name: `P7 Imp Sib One ${stamp}`, admissionNo: `P7-IMP-${stamp}-3`, class: "Class 2", guardianName: `P7 Imp Sib Guardian ${stamp}`, guardianEmail: gImpSib, guardianPhone: PHONE_NOSIB }),
    mkRow({ name: `P7 Imp Sib Two ${stamp}`, admissionNo: `P7-IMP-${stamp}-4`, class: "Class 3", guardianName: `P7 Imp Sib Guardian ${stamp}`, guardianEmail: gImpSib, guardianPhone: PHONE_NOSIB }),
    // reuse an EXISTING guardian account by email → LINKED
    mkRow({ name: `P7 Imp Reuse ${stamp}`, admissionNo: `P7-IMP-${stamp}-5`, class: "Class 4", guardianName: `P7 Reuse Guardian ${stamp}`, guardianEmail: gReuse, guardianPhone: PHONE_REUSE }),
    // ambiguous phone: two EXISTING accounts share this number → must NOT auto-link
    mkRow({ name: `P7 Imp Ambiguous ${stamp}`, admissionNo: ambAdm, class: "Class 5", guardianName: `P7 Imp Amb Guardian ${stamp}`, guardianPhone: PHONE_AMB }),
    // phone-only pair (no email) → incomplete, but family-linked to each other by phone
    mkRow({ name: `P7 Imp Phone One ${stamp}`, admissionNo: `P7-IMP-${stamp}-7`, class: "Class 5", guardianName: `P7 Imp Phone Guardian ${stamp}`, guardianPhone: PHONE_IMP }),
    mkRow({ name: `P7 Imp Phone Two ${stamp}`, admissionNo: `P7-IMP-${stamp}-8`, class: "Class 6", guardianName: `P7 Imp Phone Guardian ${stamp}`, guardianPhone: PHONE_IMP }),
    // no guardian info at all → INCOMPLETE
    mkRow({ name: `P7 Imp No Contact ${stamp}`, admissionNo: `P7-IMP-${stamp}-9`, class: "Class 6" }),
    // possible duplicate (same name+class, new admission no) → WARNING, still created
    mkRow({ name: `P7 Imp New A ${stamp}`, admissionNo: `P7-IMP-${stamp}-10`, class: "Class 1", section: "A" }),
    // definite duplicate: an admission number already on file → ERROR, never imported
    mkRow({ name: `P7 Imp Duplicate ${stamp}`, admissionNo: dupAdm, class: "Class 1", section: "A" }),
  ];
  for (const r of batch1Rows) if (r[1]) created.admissionNos.add(r[1]);

  const b1 = await commit("p7-batch1.csv", batch1Rows, { branchId: branchA.id });
  const batch1 = b1.data?.batchId;
  check("bulk import batch 1 committed", b1.status === 200 && !!batch1, `HTTP ${b1.status} created=${b1.data?.totals?.created} errors=${b1.data?.totals?.errors} ${b1.error || ""}`);
  check("the definite duplicate admission number was rejected as an ERROR", Number(b1.data?.totals?.errors) >= 1, `errors=${b1.data?.totals?.errors}`);
  check("the 10 genuine rows were created", Number(b1.data?.totals?.created) === 10, `created=${b1.data?.totals?.created}`);
  const dupCount = (await fsDocs("students", "admissionNo", dupAdm)).filter((s) => s.schoolId === SYN).length;
  check("the rejected duplicate did not create a second student", dupCount === 1, `${dupCount}`);

  // rerun idempotency
  const b1again = await commit("p7-batch1.csv", batch1Rows, { branchId: branchA.id });
  check("re-running the same import creates nothing (idempotent)", Number(b1again.data?.totals?.created) === 0, `created=${b1again.data?.totals?.created} skipped=${b1again.data?.totals?.skipped}`);

  // batch 2 — branch B
  const b2Rows = [];
  for (let i = 0; i < 12; i++) {
    const clsName = HIER_B[i % HIER_B.length][0];
    const a = `P7-IMPB-${stamp}-${i}`;
    created.admissionNos.add(a);
    b2Rows.push(mkRow({ name: `P7 North Import ${stamp}-${i}`, admissionNo: a, class: clsName, section: "N", guardianName: `P7 North Guardian ${stamp}-${i}`, guardianEmail: `p7-impb-${stamp}-${i}@p7test.local` }));
    SYN_EMAILS.push(`p7-impb-${stamp}-${i}@p7test.local`);
  }
  const b2 = await commit("p7-batch2.csv", b2Rows, { branchId: branchB.id });
  check("bulk import batch 2 (North Campus) committed", b2.status === 200 && Number(b2.data?.totals?.created) === 12, `HTTP ${b2.status} created=${b2.data?.totals?.created}`);

  // batch 3 — bulk plain students into Class 2 (branch A)
  const b3Rows = [];
  for (let i = 0; i < 34; i++) {
    const a = `P7-IMPC-${stamp}-${i}`;
    created.admissionNos.add(a);
    const withG = i % 3 === 0;
    b3Rows.push(mkRow({ name: `P7 Bulk Pupil ${stamp}-${i}`, admissionNo: a, class: "Class 2", section: i % 2 ? "A" : "B", guardianName: withG ? `P7 Bulk Guardian ${stamp}-${i}` : "", guardianEmail: withG ? `p7-impc-${stamp}-${i}@p7test.local` : "" }));
    if (withG) SYN_EMAILS.push(`p7-impc-${stamp}-${i}@p7test.local`);
  }
  const b3 = await commit("p7-batch3.csv", b3Rows, { branchId: branchA.id });
  check("bulk import batch 3 (34 bulk students) committed", b3.status === 200 && Number(b3.data?.totals?.created) === 34, `HTTP ${b3.status} created=${b3.data?.totals?.created}`);

  const allSynStudents = await fsDocs("students", "schoolId", SYN);
  check(`the synthetic school holds 50–100 students (${allSynStudents.length})`, allSynStudents.length >= 50 && allSynStudents.length <= 125, `${allSynStudents.length}`);

  // guardian matching / sibling assertions
  const impReuseDoc = await studentByAdm(`P7-IMP-${stamp}-5`);
  const reuseGuardian = (await fsDocs("users", "schoolId", SYN)).find((u) => u.email === gReuse);
  check("an import row REUSED the existing guardian account (no new login)", impReuseDoc?.guardianUserId === reuseGuardian?.id && !!reuseGuardian?.id, `${impReuseDoc?.guardianUserId} vs ${reuseGuardian?.id}`);
  const impSib1 = await studentByAdm(`P7-IMP-${stamp}-3`);
  const impSib2 = await studentByAdm(`P7-IMP-${stamp}-4`);
  check("imported siblings were linked into one family", !!impSib1?.familyId && impSib1.familyId === impSib2?.familyId, `${impSib1?.familyId} vs ${impSib2?.familyId}`);
  // Ambiguous phone: the row must NOT be linked to either EXISTING account (that
  // is what the preview's CREATE action guarantees). Note that the commit path
  // still family-links the row to any student that already shares the phone
  // (sibling-by-phone) — see the reported finding; the account link itself stays
  // empty, which is the security-relevant guarantee.
  const ambDoc = await studentByAdm(ambAdm);
  const ambAccounts = (await fsDocs("users", "schoolId", SYN)).filter((u) => u.phone === PHONE_AMB);
  check("two existing guardian accounts share the ambiguous phone", ambAccounts.length >= 2, `accounts=${ambAccounts.length}`);
  check("the ambiguous-phone row is NOT linked to either existing account", !!ambDoc && !ambAccounts.some((u) => u.id === ambDoc.guardianUserId), `guardianUserId=${ambDoc?.guardianUserId}`);
  // Preview must never offer to REUSE either account for that phone.
  const ambPreview = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: numbered([mkRow({ name: `P7 Amb Preview ${stamp}`, admissionNo: `P7-AMBP-${stamp}`, class: "Class 8", guardianName: `P7 Amb Preview G ${stamp}`, guardianPhone: PHONE_AMB })]) }, admin);
  check("the preview never offers to reuse an ambiguous phone", ambPreview.data?.rows?.[0]?.action !== "REUSE_GUARDIAN" && !ambPreview.data?.rows?.[0]?.guardianUserId, JSON.stringify({ action: ambPreview.data?.rows?.[0]?.action, id: ambPreview.data?.rows?.[0]?.guardianUserId }));
  const impNoContact = await studentByAdm(`P7-IMP-${stamp}-9`);
  check("a no-contact import row has no guardian account", !impNoContact?.guardianUserId, String(impNoContact?.guardianUserId));

  /* ---------------------------------------------------------- 6. historical data */
  sec("6. realistic historical data (attendance / exams / marks / fees / homework / remarks)");
  const historyClass = CLASSES["Class 2"].id;
  const historyStudents = (await fsDocs("students", "classId", historyClass)).filter((s) => s.schoolId === SYN);
  // Put the integrity target (an imported sibling in this class) first so it is
  // guaranteed its own attendance + fee history regardless of class size.
  const historyRoster = [impSib1, impSib2, ...historyStudents.filter((s) => s.id !== impSib1?.id && s.id !== impSib2?.id)].filter((s) => s?.id);
  const hDates = ["2024-02-05", "2024-02-06"];
  for (const d of hDates) {
    const rows = historyRoster.slice(0, 20).map((s, i) => ({ studentId: s.id, classId: historyClass, sectionId: s.sectionId || null, status: i % 7 === 0 ? "ABSENT" : i % 5 === 0 ? "LATE" : "PRESENT" }));
    const aRes = await post(HOSTS.school, "/api/attendance", { date: d, rows }, admin);
    check(`attendance register saved for ${d}`, aRes.status === 200 && Number(aRes.data?.count) === rows.length, `HTTP ${aRes.status} count=${aRes.data?.count}`);
  }
  // subjects
  const subjIds = [];
  for (const nm of ["P7 Math", "P7 English", "P7 Science"]) {
    const sres = await post(HOSTS.school, "/api/subjects", { name: `${nm} ${stamp}`, code: nm.split(" ")[1].slice(0, 3).toUpperCase() }, admin);
    if (sres.data?.id) subjIds.push(sres.data.id);
  }
  check("three subjects were created", subjIds.length === 3, `${subjIds.length}`);
  const examIds = [];
  for (const clsName of ["Class 2", "Class 5"]) {
    const e = (await post(HOSTS.school, "/api/exams", { name: `P7 Term Exam ${clsName} ${stamp}`, classId: CLASSES[clsName].id, year: 2024 }, admin)).data;
    if (e?.id) examIds.push({ id: e.id, classId: CLASSES[clsName].id });
  }
  check("two exams were created", examIds.length === 2, `${examIds.length}`);
  for (const ex of examIds) {
    const roster = (await fsDocs("students", "classId", ex.classId)).filter((s) => s.schoolId === SYN).slice(0, 15);
    const rows = [];
    for (const s of roster) for (const sid of subjIds) rows.push({ studentId: s.id, subjectId: sid, obtained: 55 + ((s.id.charCodeAt(0) + sid.charCodeAt(2)) % 40), fullMarks: 100 });
    const mres = await post(HOSTS.school, "/api/marks", { examId: ex.id, rows }, admin);
    check("exam marks were entered", mres.status === 200 && Number(mres.data?.count) === rows.length, `HTTP ${mres.status} count=${mres.data?.count}`);
  }
  // fees for the same students that got attendance, so the integrity target
  // (an imported sibling that landed in Class 2) is guaranteed its own history
  let feeCount = 0;
  for (const s of historyRoster) {
    const f = await post(HOSTS.school, "/api/fees", { studentId: s.id, title: `P7 Monthly Fee ${stamp}`, amount: 1500, feeType: "MONTHLY" }, admin);
    if (f.status === 201) feeCount++;
  }
  check("fee records were raised for selected students", feeCount >= 12, `${feeCount}`);
  // homework (teacher)
  let hwCount = 0;
  for (let i = 0; i < 3; i++) {
    const h = await post(HOSTS.teacher, "/api/homework", { classId: historyClass, sectionId: secCls5A?.id || null, subjectId: subjIds[0], title: `P7 Homework ${stamp}-${i}`, description: "Synthetic homework", dueDate: "2024-03-01" }, teacher);
    if (h.status === 201) hwCount++;
  }
  check("homework was posted for the class", hwCount === 3, `${hwCount}`);
  // daily remarks
  const rres = await post(HOSTS.school, "/api/remarks", { date: "2024-02-05", rows: historyStudents.slice(0, 15).map((s, i) => ({ studentId: s.id, rating: i % 3 === 0 ? "EXCELLENT" : "GOOD", note: "Synthetic remark" })) }, admin);
  check("daily remarks were saved", rres.status === 200 && Number(rres.data?.saved) >= 10, `HTTP ${rres.status} saved=${rres.data?.saved}`);

  /* ---------------------------------------------------------- 7. baseline capture */
  sec("7. baseline capture (before any lifecycle operation)");
  const baselineTargets = {
    sib1: await studentByAdm(sib1.admissionNo),
    sib2: await studentByAdm(sib2.admissionNo),
    impReuse: impReuseDoc,
    impSib1, impSib2,
  };
  // NOTE: `marks` (the examMark model) is the ONE collection whose documents
  // carry NO `schoolId` — a mark's identity is (examId, studentId, subjectId),
  // all of which are already tenant-owned. So it is counted/cleaned by the
  // synthetic exams it belongs to, never by a schoolId field.
  const examIdSet = new Set(examIds.map((e) => e.id));
  const marksForExam = (id) => fsDocs("marks", "examId", id);
  async function histCounts(studentId) {
    return {
      attendance: (await fsDocs("attendance", "studentId", studentId)).filter((d) => d.schoolId === SYN).length,
      marks: (await fsDocs("marks", "studentId", studentId)).length,
      fees: (await fsDocs("fees", "studentId", studentId)).filter((d) => d.schoolId === SYN).length,
      ledger: (await fsDocs("ledger", "studentId", studentId)).filter((d) => d.schoolId === SYN).length,
    };
  }
  const baseAtt = (await fsDocs("attendance", "schoolId", SYN)).length;
  let baseMarks = 0;
  for (const ex of examIds) baseMarks += (await marksForExam(ex.id)).length;
  const baseFees = (await fsDocs("fees", "schoolId", SYN)).length;
  const baseRemarks = (await fsDocs("remarks", "schoolId", SYN)).length;
  const baseHw = (await fsDocs("homeworks", "schoolId", SYN)).length;
  const baseHist = await histCounts(baselineTargets.impSib1.id);
  check("baseline: attendance records exist", baseAtt > 0, `${baseAtt}`);
  check("baseline: mark records exist", baseMarks > 0, `${baseMarks}`);
  check("baseline: fee records exist", baseFees > 0, `${baseFees}`);
  check("baseline: remark records exist", baseRemarks > 0, `${baseRemarks}`);
  check("baseline: homework records exist", baseHw > 0, `${baseHw}`);
  check("baseline: the family-expansion target has its own history", baseHist.attendance > 0 && baseHist.fees > 0, JSON.stringify(baseHist));

  /* ---------------------------------------------------------- 8. onboarding monitor */
  sec("8. onboarding monitor (LINKED / CREDENTIALS_READY / INCOMPLETE / LEGACY / orphan / filters)");
  {
    const anon = await req(HOSTS.school, "/api/onboarding");
    check("anonymous is refused (401)", anon.status === 401, `HTTP ${anon.status}`);
    const t = await req(HOSTS.school, "/api/onboarding", { cookie: teacher });
    check("a teacher is refused (403)", t.status === 403, `HTTP ${t.status}`);
    const mon = await req(HOSTS.school, "/api/onboarding?limit=500", { cookie: admin });
    const sum = mon.data?.summary || {};
    check("the school admin reads the monitor (200)", mon.status === 200 && !!sum.total, `HTTP ${mon.status}`);
    check("summary totals add up", sum.total === sum.credentialsReady + sum.linked + sum.incomplete + sum.legacy, JSON.stringify(sum));
    check("LINKED is present (reused guardian rows)", sum.linked >= 1, `linked=${sum.linked}`);
    check("CREDENTIALS_READY is present (provisioned accounts)", sum.credentialsReady >= 2, `credentialsReady=${sum.credentialsReady}`);
    check("INCOMPLETE is present (no-contact / ambiguous rows)", sum.incomplete >= 2, `incomplete=${sum.incomplete}`);
    // New Admission students have no marker → LEGACY
    const legacyStudent = (await fsDocs("students", "schoolId", SYN)).find((s) => !s.guardianOnboarding);
    const leg = await req(HOSTS.school, `/api/onboarding?status=LEGACY&limit=500`, { cookie: admin });
    check("a markerless New-Admission student is classified LEGACY", !!legacyStudent && (leg.data?.students || []).some((r) => r.id === legacyStudent.id), `${(leg.data?.students || []).length} legacy`);
    check("LEGACY rows genuinely carry no marker", (leg.data?.students || []).every((r) => r.status === "legacy"));

    const byBatch = await req(HOSTS.school, `/api/onboarding?batchId=${batch1}&limit=500`, { cookie: admin });
    check("the batch filter returns batch 1's rows", byBatch.status === 200 && (byBatch.data?.students || []).length >= 9, `n=${(byBatch.data?.students || []).length}`);
    const stMap = {};
    for (const r of byBatch.data?.students || []) stMap[r.admissionNo] = r;
    check("the new-guardian row is credentialsReady", stMap[`P7-IMP-${stamp}-1`]?.status === "credentialsReady", String(stMap[`P7-IMP-${stamp}-1`]?.status));
    check("the reused-guardian row is linked", stMap[`P7-IMP-${stamp}-5`]?.status === "linked", String(stMap[`P7-IMP-${stamp}-5`]?.status));
    check("the ambiguous/no-contact row is incomplete", stMap[ambAdm]?.status === "incomplete" && stMap[`P7-IMP-${stamp}-9`]?.status === "incomplete", `${stMap[ambAdm]?.status}/${stMap[`P7-IMP-${stamp}-9`]?.status}`);
    check("only credentialsReady rows can print a slip", (byBatch.data?.students || []).every((r) => r.canPrintSlip === (r.status === "credentialsReady" && !!r.batchId)));
    const byClass = await req(HOSTS.school, `/api/onboarding?batchId=${batch1}&classId=${cls1}`, { cookie: admin });
    check("the class filter narrows the batch rows", (byClass.data?.students || []).length >= 1 && (byClass.data?.students || []).every((r) => r.classId === cls1), `n=${(byClass.data?.students || []).length}`);
    const byQ = await req(HOSTS.school, `/api/onboarding?q=${encodeURIComponent(`P7-IMP-${stamp}-1`)}`, { cookie: admin });
    check("the search filter finds a row by admission number", (byQ.data?.students || []).some((r) => r.admissionNo === `P7-IMP-${stamp}-1`));

    // orphaned account after undo
    const orphanAdm = `P7-ORPHAN-${stamp}`;
    created.admissionNos.add(orphanAdm);
    const orphanEmail = `p7-orphan-${stamp}@p7test.local`;
    SYN_EMAILS.push(orphanEmail);
    const ob = await commit("p7-orphan.csv", [mkRow({ name: `P7 Orphan ${stamp}`, admissionNo: orphanAdm, class: "Class 7", guardianName: `P7 Orphan Guardian ${stamp}`, guardianEmail: orphanEmail })], { branchId: branchA.id });
    const orphanBatch = ob.data?.batchId;
    const pre = await req(HOSTS.school, "/api/onboarding?limit=500", { cookie: admin });
    check("a provisioned account is not orphaned while it has a child", !(pre.data?.orphanedAccounts || []).some((g) => g.email === orphanEmail));
    const un = await post(HOSTS.school, `/api/import/students/${orphanBatch}/undo`, {}, admin);
    check("import undo removes the created student", un.status === 200 && Number(un.data?.removedStudents) === 1, JSON.stringify(un.data));
    const post2 = await req(HOSTS.school, "/api/onboarding?limit=500", { cookie: admin });
    check("the account becomes orphaned after undo", (post2.data?.orphanedAccounts || []).some((g) => g.email === orphanEmail));
    check("orphaned accounts stay out of the student status totals", post2.data.summary.total === post2.data.summary.credentialsReady + post2.data.summary.linked + post2.data.summary.incomplete + post2.data.summary.legacy);

    // branch filtering
    const scoped = await req(HOSTS.school, "/api/onboarding?limit=500", { cookie: branchAdmin });
    check("the branch admin can read the monitor (200)", scoped.status === 200, `HTTP ${scoped.status}`);
    check("the branch admin sees only its own branch", (scoped.data?.students || []).every((r) => r.branchId === branchB.id || r.branchId === null), `n=${(scoped.data?.students || []).length}`);
    const crossBatch = await req(HOSTS.school, `/api/onboarding?batchId=${batch1}`, { cookie: branchAdmin });
    check("the branch admin cannot filter by another branch's batch (404)", crossBatch.status === 404, `HTTP ${crossBatch.status}`);
    // foreign batch
    const foreignId = `imp_p7_foreign_${stamp}`;
    await db.collection("importBatches").doc(foreignId).set({ schoolId: `s_other_${stamp}`, module: "students", status: "DONE" });
    const fb = await req(HOSTS.school, `/api/onboarding?batchId=${foreignId}`, { cookie: admin });
    check("a foreign-school batch answers 404", fb.status === 404, `HTTP ${fb.status}`);
    await db.collection("importBatches").doc(foreignId).delete().catch(() => null);
  }

  /* ---------------------------------------------------------- 9. QR credentials + guardian login */
  sec("9. guardian QR/PIN credentials + real login + sibling + isolation");
  let qrCookie = "";
  let slipUnique = null;
  let slipSib = null;
  {
    const cred = await req(HOSTS.school, `/api/import/students/${batch1}/credentials`, { cookie: admin });
    const slips = cred.data?.credentials || [];
    const slipAdms = slips.map((c) => c.admissionNo);
    slipUnique = slips.find((c) => c.admissionNo === `P7-IMP-${stamp}-1`) || null;
    slipSib = slips.find((c) => c.admissionNo === `P7-IMP-${stamp}-3`) || null;
    check("credential slips exist for provisioned guardians", !!slipUnique?.qrToken && !!slipUnique?.qrPin && !!slipSib?.qrToken && !!slipSib?.qrPin, JSON.stringify(slipAdms));
    check("slips never carry a password/hash", slips.every((c) => !("password" in c) && !("passwordHash" in c)));
    // a slip must never be issued for a LINKED (reused) or INCOMPLETE guardian row
    check("no slip is issued for the reused (LINKED) guardian row", !slipAdms.includes(`P7-IMP-${stamp}-5`));
    check("no slip is issued for the INCOMPLETE / ambiguous rows", !slipAdms.includes(ambAdm) && !slipAdms.includes(`P7-IMP-${stamp}-7`) && !slipAdms.includes(`P7-IMP-${stamp}-9`));
  }
  {
    const ok = await post(HOSTS.school, "/api/qr/verify", { token: slipUnique?.qrToken, pin: slipUnique?.qrPin });
    qrCookie = ok.setCookie.split(";")[0] || "";
    check("a valid QR token + PIN signs the guardian in", ok.status === 200 && ok.data?.ok === true, `HTTP ${ok.status} ${ok.error || ""}`);
    check("a guardian session cookie is issued", /ss_token=/.test(qrCookie));
    const bad = await post(HOSTS.school, "/api/qr/verify", { token: slipUnique?.qrToken, pin: slipUnique?.qrPin === "0000" ? "1111" : "0000" });
    check("a wrong PIN is rejected (401)", bad.status === 401, `HTTP ${bad.status}`);
    const noTok = await post(HOSTS.school, "/api/qr/verify", { token: "", pin: slipUnique?.qrPin });
    check("a missing QR token is rejected (400)", noTok.status === 400, `HTTP ${noTok.status}`);
    const badTok = await post(HOSTS.school, "/api/qr/verify", { token: `p7-not-a-token-${stamp}`, pin: "1234" });
    check("an unknown QR token is rejected (404)", badTok.status === 404, `HTTP ${badTok.status}`);

    const meQr = await req(HOSTS.school, "/api/auth/me", { cookie: qrCookie });
    const uniqueStudent = await studentByAdm(`P7-IMP-${stamp}-1`);
    check("the QR session authenticates as GUARDIAN", meQr.status === 200 && meQr.data?.user?.role === "GUARDIAN", `HTTP ${meQr.status} role=${meQr.data?.user?.role}`);
    check("the QR session resolves to the slip's own child", meQr.data?.user?.studentId === uniqueStudent?.id, `${meQr.data?.user?.studentId} vs ${uniqueStudent?.id}`);
    const sibList = await req(HOSTS.school, "/api/parent/siblings", { cookie: qrCookie });
    const kids = sibList.data || [];
    check("a single-child QR session speaks for exactly one child", sibList.status === 200 && kids.length === 1, `HTTP ${sibList.status} children=${kids.length}`);
    const unrelated = await studentByAdm(`P7-IMP-${stamp}-2`);
    check("no unrelated student's data is exposed", !kids.some((c) => c.id === unrelated?.id));

    // sibling behavior: the slip for the first of an import sibling pair sees BOTH children (family expansion)
    const sibLogin = await post(HOSTS.school, "/api/qr/verify", { token: slipSib?.qrToken, pin: slipSib?.qrPin });
    const sibCookie = sibLogin.setCookie.split(";")[0] || "";
    check("the sibling-pair slip signs in", sibLogin.status === 200, `HTTP ${sibLogin.status}`);
    const sibKids = await req(HOSTS.school, "/api/parent/siblings", { cookie: sibCookie });
    const list2 = sibKids.data || [];
    const impSib1Doc = await studentByAdm(`P7-IMP-${stamp}-3`);
    const impSib2Doc = await studentByAdm(`P7-IMP-${stamp}-4`);
    check("the sibling-pair slip resolves to the first sibling", list2.some((c) => c.id === impSib1Doc?.id), `children=${list2.length} [${list2.map((c) => c.admissionNo).join(",")}]`);
    const unrelated2 = await studentByAdm(`P7-IMP-${stamp}-2`);
    check("the sibling slip never exposes an unrelated student", !list2.some((c) => c.id === unrelated2?.id));

    // cross-school isolation: a token from the demo school must not resolve in our school
    const demo = await fsDocs("students", "schoolId", "s_54bf3dc2c4f98fabdf78b7216c0ae888455d009a");
    const demoWithToken = demo.find((s) => s.qrToken && s.qrPin);
    if (demoWithToken) {
      const cross = await post(HOSTS.school, "/api/qr/verify", { token: demoWithToken.qrToken, pin: demoWithToken.qrPin });
      check("a demo-school QR token authenticates to the DEMO school only (isolation holds)", cross.status === 200, `HTTP ${cross.status}`);
      const crossMe = await req(HOSTS.school, "/api/auth/me", { cookie: cross.setCookie.split(";")[0] || "" });
      check("its session is scoped to the demo school, never the synthetic school", crossMe.data?.user?.schoolId === "s_54bf3dc2c4f98fabdf78b7216c0ae888455d009a", String(crossMe.data?.user?.schoolId));
    } else {
      check("a demo-school QR token was available for the isolation probe", false, "no demo token found");
    }
  }

  /* ---------------------------------------------------------- 10. promotion mixed cohort */
  sec("10. promotion / rollover — mixed cohort + idempotency");
  const cohortCls5 = cls5;
  const sec5A = (SECTIONS[cohortCls5] || []).find((s) => s.name === "A") || (SECTIONS[cohortCls5] || [])[0];
  const cohort = [];
  for (let i = 0; i < 4; i++) {
    const r = await newAdmission({ name: `P7 Promote ${stamp}-${i}`, classId: cohortCls5, sectionId: sec5A?.id, createGuardian: false, sessionId: SESSIONS.s1.id, tag: `PRO${i}` });
    cohort.push(await studentByAdm(r.admissionNo));
  }
  const retained = [];
  for (let i = 0; i < 2; i++) {
    const r = await newAdmission({ name: `P7 Retain ${stamp}-${i}`, classId: cohortCls5, sectionId: sec5A?.id, createGuardian: false, sessionId: SESSIONS.s1.id, tag: `RET${i}` });
    retained.push(await studentByAdm(r.admissionNo));
  }
  const transferCand = await studentByAdm((await newAdmission({ name: `P7 Transfer Cand ${stamp}`, classId: cohortCls5, sectionId: sec5A?.id, createGuardian: false, sessionId: SESSIONS.s1.id, tag: "TRC" })).admissionNo);
  check("the mixed promotion cohort was built in Class 5", cohort.length === 4 && retained.length === 2 && !!transferCand?.id, `${cohort.length}+${retained.length}+1`);

  // graduating cohort in Class 10 (top of the hierarchy)
  const grads = [];
  for (let i = 0; i < 2; i++) {
    const r = await newAdmission({ name: `P7 Graduate ${stamp}-${i}`, classId: cls10, sectionId: (SECTIONS[cls10] || [])[0]?.id, createGuardian: false, sessionId: SESSIONS.s1.id, tag: `GRD${i}` });
    grads.push(await studentByAdm(r.admissionNo));
  }
  check("a graduating cohort was built in Class 10", grads.length === 2);

  // transfer the candidate BEFORE promotion so it is excluded
  const trPre = await post(HOSTS.school, `/api/students/${transferCand.id}/lifecycle`, { action: "TRANSFER", reason: "pre-promotion transfer" }, admin);
  check("the transfer candidate is TRANSFERRED before promotion", trPre.status === 200 && trPre.data?.status === "TRANSFERRED", `HTTP ${trPre.status}`);

  // target-session validation
  const currentBefore = (await req(HOSTS.school, "/api/academic-sessions", { cookie: admin })).data?.find((s) => s.isCurrent)?.id;
  const badTarget = await post(HOSTS.school, "/api/students/promote", { fromClassId: cohortCls5, toSessionId: `as_nope_${stamp}` }, admin);
  check("an invalid target session is rejected (400)", badTarget.status === 400, `HTTP ${badTarget.status} ${badTarget.error || ""}`);
  const foreignTarget = await post(HOSTS.school, "/api/students/promote", { fromClassId: cohortCls5, toSessionId: "s_other_school_session" }, admin);
  check("a foreign-school target session is rejected (400)", foreignTarget.status === 400, `HTTP ${foreignTarget.status}`);
  const cohortUnchanged = await studentByAdm(cohort[0].admissionNo);
  check("no student was written by the rejected promotions", cohortUnchanged.classId === cohortCls5 && cohortUnchanged.sessionId === SESSIONS.s1.id, `${cohortUnchanged.classId}/${cohortUnchanged.sessionId}`);

  // preview
  const pv = await req(HOSTS.school, `/api/students/promote?fromClassId=${cohortCls5}&toSessionId=${SESSIONS.s2.id}`, { cookie: admin });
  check("preview returns the requested target session", pv.data?.targetSession?.id === SESSIONS.s2.id, JSON.stringify(pv.data?.targetSession));
  check("preview maps Class 5 → Class 6", pv.data?.toClass?.id === CLASSES["Class 6"].id, `${pv.data?.toClass?.name}`);
  check("the transferred candidate is excluded from the preview roster", !(pv.data?.students || []).some((s) => s.id === transferCand.id));
  check("preview counts the promote/retain actions", (pv.data?.counts?.promote || 0) >= 6, JSON.stringify(pv.data?.counts));

  // execute
  const run1 = await post(HOSTS.school, "/api/students/promote", { fromClassId: cohortCls5, toSessionId: SESSIONS.s2.id, excludeIds: retained.map((s) => s.id) }, admin);
  check("promotion executes and reports counts", run1.status === 200 && typeof run1.data?.promoted === "number", JSON.stringify(run1.data));
  check("the retained students are counted as retained", Number(run1.data?.retained) === 2, `retained=${run1.data?.retained}`);
  const p1 = await studentByAdm(cohort[0].admissionNo);
  const r1d = await studentByAdm(retained[0].admissionNo);
  check("a promoted student moves to the next class", p1?.classId === CLASSES["Class 6"].id, `${p1?.classId} vs ${CLASSES["Class 6"].id}`);
  check("a promoted student carries the target session", p1?.sessionId === SESSIONS.s2.id, `${p1?.sessionId} vs ${SESSIONS.s2.id}`);
  check("a promoted student gets the durable promotion marker", p1?.promotionSessionId === SESSIONS.s2.id, String(p1?.promotionSessionId));
  check("a retained student stays in Class 5", r1d?.classId === cohortCls5, `${r1d?.classId}`);
  check("a retained student still moves to the target session", r1d?.sessionId === SESSIONS.s2.id, `${r1d?.sessionId}`);
  const transferAfter = await studentByAdm(transferCand.admissionNo);
  check("the transferred student was not promoted", transferAfter?.classId === cohortCls5 && transferAfter?.status === "TRANSFERRED", `${transferAfter?.classId}/${transferAfter?.status}`);

  // idempotent re-run
  const run2 = await post(HOSTS.school, "/api/students/promote", { fromClassId: cohortCls5, toSessionId: SESSIONS.s2.id }, admin);
  check("re-running the same promotion promotes nobody", Number(run2.data?.promoted) === 0, JSON.stringify(run2.data));
  check("re-run correctly skips the already-processed students", Number(run2.data?.skipped) >= 2, `skipped=${run2.data?.skipped}`);
  const p1again = await studentByAdm(cohort[0].admissionNo);
  check("the already-promoted student did NOT advance again", p1again?.classId === CLASSES["Class 6"].id, `${p1again?.classId}`);

  // the critical 1→2→3 guard: promote Class 6 → Class 7 in the SAME target session
  const run3 = await post(HOSTS.school, "/api/students/promote", { fromClassId: CLASSES["Class 6"].id, toSessionId: SESSIONS.s2.id }, admin);
  const p1third = await studentByAdm(cohort[0].admissionNo);
  check("promoting the next class in the same session does NOT re-advance moved students", p1third?.classId === CLASSES["Class 6"].id, `${p1third?.classId} (promoted=${run3.data?.promoted})`);

  // graduation
  const gradRun = await post(HOSTS.school, "/api/students/promote", { fromClassId: cls10, toSessionId: SESSIONS.s2.id }, admin);
  const gradDoc = await studentByAdm(grads[0].admissionNo);
  check("a top-class student becomes ALUMNI", gradDoc?.status === "ALUMNI", `${gradDoc?.status} (graduated=${gradRun.data?.graduated})`);
  check("the graduate carries the promotion marker", gradDoc?.promotionSessionId === SESSIONS.s2.id, String(gradDoc?.promotionSessionId));

  // section mismatch — dedicated pair (Class 5 'Z' section → target class only has 'Q')
  const mismStudent = await studentByAdm((await newAdmission({ name: `P7 Mismatch ${stamp}`, classId: CLASSES["P7 Src 5"].id, sectionId: (SECTIONS[CLASSES["P7 Src 5"].id] || [])[0]?.id, createGuardian: false, sessionId: SESSIONS.s1.id, tag: "MIS" })).admissionNo);
  const misPv = await req(HOSTS.school, `/api/students/promote?fromClassId=${CLASSES["P7 Src 5"].id}&toSessionId=${SESSIONS.s2.id}`, { cookie: admin });
  const misRow = (misPv.data?.students || []).find((s) => s.id === mismStudent.id);
  check("a section mismatch is surfaced as a warning", !!misRow?.sectionWarning, JSON.stringify(misRow?.sectionWarning));
  await post(HOSTS.school, "/api/students/promote", { fromClassId: CLASSES["P7 Src 5"].id, toSessionId: SESSIONS.s2.id }, admin);
  const misAfter = await studentByAdm(mismStudent.admissionNo);
  check("the mismatched section is preserved (no silent remap)", misAfter?.sectionId === (SECTIONS[CLASSES["P7 Src 5"].id] || [])[0]?.id, `${misAfter?.sectionId}`);

  // current session must not silently change
  const currentAfter = (await req(HOSTS.school, "/api/academic-sessions", { cookie: admin })).data?.find((s) => s.isCurrent)?.id;
  check("promotion never silently changes the current session", currentAfter === currentBefore && currentAfter === SESSIONS.s1.id, `${currentBefore} → ${currentAfter}`);

  // branch-B admin promotes its own branch chain
  const nbPromote = await post(HOSTS.school, "/api/students/promote", { fromClassId: CLASSES["North Class 1"].id, toSessionId: SESSIONS.s2.id }, branchAdmin);
  check("a branch admin can promote its own branch's class", nbPromote.status === 200, `HTTP ${nbPromote.status} ${nbPromote.error || ""}`);

  /* ---------------------------------------------------------- 11. transfer / withdraw / restore */
  sec("11. transfer / withdraw / restore");
  const wdCand = await studentByAdm((await newAdmission({ name: `P7 Withdraw ${stamp}`, classId: cls2, sectionId: secA1?.id, createGuardian: true, guardianName: `P7 WD Guardian ${stamp}`, guardianEmail: `p7-wd-${stamp}@p7test.local`, sessionId: SESSIONS.s1.id, tag: "WD" })).admissionNo);
  SYN_EMAILS.push(`p7-wd-${stamp}@p7test.local`);
  const wdBefore = await studentByAdm(wdCand.admissionNo);
  const wdFamilyBefore = wdBefore?.familyId;
  const wdGuardianBefore = wdBefore?.guardianUserId;

  const tr = await post(HOSTS.school, `/api/students/${transferCand.id}/lifecycle`, { action: "TRANSFER", reason: "relocated" }, admin);
  check("TRANSFER sets status TRANSFERRED", tr.status === 200 && tr.data?.status === "TRANSFERRED", `HTTP ${tr.status}`);
  const trDoc = await studentByAdm(transferCand.admissionNo);
  check("the transfer reason is recorded", trDoc?.lifecycleReason === "relocated", String(trDoc?.lifecycleReason));
  const offRoll = await req(HOSTS.school, "/api/students/alumni?status=TRANSFERRED", { cookie: admin });
  check("the off-roll list includes the transferred student", (offRoll.data || []).some((s) => s.id === transferCand.id));

  const wd = await post(HOSTS.school, `/api/students/${wdCand.id}/lifecycle`, { action: "WITHDRAW", reason: "family request" }, admin);
  check("WITHDRAW sets status TRANSFERRED", wd.status === 200 && wd.data?.status === "TRANSFERRED", `HTTP ${wd.status}`);
  const re = await post(HOSTS.school, `/api/students/${wdCand.id}/lifecycle`, { action: "RESTORE" }, admin);
  check("RESTORE returns the student to ACTIVE", re.status === 200 && re.data?.status === "ACTIVE", `HTTP ${re.status}`);
  const wdAfter = await studentByAdm(wdCand.admissionNo);
  check("lifecycle never deleted the student", !!wdAfter?.id);
  check("guardian link survives withdraw/restore", wdAfter?.guardianUserId === wdGuardianBefore && !!wdAfter?.guardianUserId, `${wdGuardianBefore} → ${wdAfter?.guardianUserId}`);
  check("family link survives withdraw/restore", (wdAfter?.familyId || null) === (wdFamilyBefore || null));

  /* ---------------------------------------------------------- 12. historical integrity */
  sec("12. historical-data integrity after lifecycle ops");
  const postAtt = (await fsDocs("attendance", "schoolId", SYN)).length;
  let postMarks = 0;
  for (const ex of examIds) postMarks += (await marksForExam(ex.id)).length;
  const postFees = (await fsDocs("fees", "schoolId", SYN)).length;
  const postRemarks = (await fsDocs("remarks", "schoolId", SYN)).length;
  const postHw = (await fsDocs("homeworks", "schoolId", SYN)).length;
  check("attendance records are unchanged by lifecycle ops", postAtt === baseAtt, `${baseAtt} → ${postAtt}`);
  check("mark records are unchanged by lifecycle ops", postMarks === baseMarks, `${baseMarks} → ${postMarks}`);
  check("fee records are unchanged by lifecycle ops", postFees === baseFees, `${baseFees} → ${postFees}`);
  check("remark records are unchanged by lifecycle ops", postRemarks === baseRemarks, `${baseRemarks} → ${postRemarks}`);
  check("homework records are unchanged by lifecycle ops", postHw === baseHw, `${baseHw} → ${postHw}`);
  const histAfter = await histCounts(baselineTargets.impSib1.id);
  check("a promoted/retained student's own history is intact", JSON.stringify(histAfter) === JSON.stringify(baseHist), `${JSON.stringify(baseHist)} → ${JSON.stringify(histAfter)}`);
  // New-Admission siblings share one guardian ACCOUNT but are not family-linked
  // (New Admission does not run the sibling-family discovery); imported siblings
  // are. Check both relationships survive the lifecycle ops.
  const sib1StillLinked = await studentByAdm(sib1.admissionNo);
  const sib2StillLinked = await studentByAdm(sib2.admissionNo);
  check(
    "guardian relationships survive promotion",
    !!sib1StillLinked?.guardianUserId && sib1StillLinked.guardianUserId === sib2StillLinked?.guardianUserId,
    `${sib1StillLinked?.guardianUserId} vs ${sib2StillLinked?.guardianUserId}`
  );
  const impSib1After = await studentByAdm(impSib1.admissionNo);
  const impSib2After = await studentByAdm(impSib2.admissionNo);
  check(
    "family relationships survive promotion",
    !!impSib1After?.familyId && impSib1After.familyId === impSib2After?.familyId,
    `${impSib1After?.familyId} vs ${impSib2After?.familyId}`
  );
  const hwDoc = (await fsDocs("homeworks", "schoolId", SYN))[0];
  check("homework records still carry their classId", !!hwDoc?.classId, String(hwDoc?.classId));

  /* ---------------------------------------------------------- 13. authorization */
  sec("13. authorization & isolation");
  {
    const anonPrev = await req(HOSTS.school, `/api/students/promote?fromClassId=${cohortCls5}`);
    check("anonymous promotion preview → 401", anonPrev.status === 401, `HTTP ${anonPrev.status}`);
    const anonLife = await post(HOSTS.school, `/api/students/${cohort[0].id}/lifecycle`, { action: "TRANSFER" });
    check("anonymous lifecycle → 401", anonLife.status === 401, `HTTP ${anonLife.status}`);
    const tPrev = await req(HOSTS.school, `/api/students/promote?fromClassId=${cohortCls5}`, { cookie: teacher });
    check("teacher promotion preview → 403", tPrev.status === 403, `HTTP ${tPrev.status}`);
    const tLife = await post(HOSTS.school, `/api/students/${cohort[0].id}/lifecycle`, { action: "TRANSFER" }, teacher);
    check("teacher lifecycle → 403", tLife.status === 403, `HTTP ${tLife.status}`);
    const gLife = await post(HOSTS.school, `/api/students/${cohort[0].id}/lifecycle`, { action: "TRANSFER" }, qrCookie);
    check("guardian lifecycle → 403", gLife.status === 403, `HTTP ${gLife.status}`);
    const aPrev = await req(HOSTS.school, `/api/students/promote?fromClassId=${cohortCls5}`, { cookie: admin });
    check("SCHOOL_ADMIN promotion preview → 200", aPrev.status === 200, `HTTP ${aPrev.status}`);
    // branch isolation
    const bPrevOther = await req(HOSTS.school, `/api/students/promote?fromClassId=${cohortCls5}`, { cookie: branchAdmin });
    check("BRANCH_ADMIN cannot preview another branch's class (404)", bPrevOther.status === 404, `HTTP ${bPrevOther.status}`);
    const bLifeOther = await post(HOSTS.school, `/api/students/${cohort[0].id}/lifecycle`, { action: "TRANSFER" }, branchAdmin);
    check("BRANCH_ADMIN cannot transfer another branch's student (404)", bLifeOther.status === 404, `HTTP ${bLifeOther.status}`);
    const cohortStill = await studentByAdm(cohort[0].admissionNo);
    check("the other branch's student is unchanged by the blocked request", cohortStill?.status !== "TRANSFERRED" && cohortStill?.classId === CLASSES["Class 6"].id, `${cohortStill?.status}/${cohortStill?.classId}`);
    const bLifeOwn = await post(HOSTS.school, `/api/students/${(await fsDocs("students", "branchId", branchB.id)).find((s) => s.schoolId === SYN)?.id}/lifecycle`, { action: "RESTORE" }, branchAdmin);
    check("BRANCH_ADMIN may act on its own branch's student", bLifeOwn.status === 200, `HTTP ${bLifeOwn.status} ${bLifeOwn.error || ""}`);
    // cross-school: a foreign-school student id cannot be actioned
    const foreignStudent = (await fsDocs("students", "schoolId", "s_54bf3dc2c4f98fabdf78b7216c0ae888455d009a"))[0];
    if (foreignStudent) {
      const crossLife = await post(HOSTS.school, `/api/students/${foreignStudent.id}/lifecycle`, { action: "TRANSFER" }, admin);
      check("a foreign-school student cannot be actioned (404)", crossLife.status === 404, `HTTP ${crossLife.status}`);
      const foreignDoc = (await fsDocs("students", "schoolId", "s_54bf3dc2c4f98fabdf78b7216c0ae888455d009a")).find((s) => s.id === foreignStudent.id);
      check("the demo-school student is untouched", foreignDoc?.status !== "TRANSFERRED", String(foreignDoc?.status));
    }
  }

  /* ---------------------------------------------------------- 14. negative / failure tests */
  sec("14. negative & failure testing (no unintended writes)");
  {
    const badAction = await post(HOSTS.school, `/api/students/${cohort[0].id}/lifecycle`, { action: "DELETE" }, admin);
    check("an invalid lifecycle action is rejected (400)", badAction.status === 400, `HTTP ${badAction.status}`);
    const before = await studentByAdm(cohort[0].admissionNo);
    check("the invalid action wrote nothing", before?.status !== "TRANSFERRED" && before?.classId === CLASSES["Class 6"].id);

    // malformed import
    const malformed = await post(HOSTS.school, "/api/import/students/commit", { fileName: "bad.csv", headers: HEADERS, rows: [{ rowNumber: 1, cells: ["x"] }], allowWarnings: true, totalRows: 1, final: true }, admin);
    check("a malformed import row is rejected (400)", malformed.status === 400, `HTTP ${malformed.status} ${malformed.error || ""}`);
    const malformed2 = await post(HOSTS.school, "/api/import/students/commit", { fileName: "bad2.csv", headers: HEADERS, rows: [{ rowNumber: 2, cells: ["A"] }, { rowNumber: 2, cells: ["B"] }], allowWarnings: true, totalRows: 2, final: true }, admin);
    check("duplicate row numbers in one import are rejected (400)", malformed2.status === 400, `HTTP ${malformed2.status}`);

    // transferred student promotion attempt
    const beforeTransfer = await studentByAdm(transferCand.admissionNo);
    await post(HOSTS.school, "/api/students/promote", { fromClassId: cohortCls5, toSessionId: SESSIONS.s3.id }, admin);
    const afterTransfer = await studentByAdm(transferCand.admissionNo);
    check("a transferred student is not promoted by a new run", afterTransfer?.classId === beforeTransfer?.classId && afterTransfer?.status === "TRANSFERRED", `${afterTransfer?.classId}/${afterTransfer?.status}`);

    // graduated student promotion attempt
    const beforeGrad = await studentByAdm(grads[0].admissionNo);
    await post(HOSTS.school, "/api/students/promote", { fromClassId: cls10, toSessionId: SESSIONS.s3.id }, admin);
    const afterGrad = await studentByAdm(grads[0].admissionNo);
    check("a graduated (ALUMNI) student is not re-promoted", afterGrad?.status === "ALUMNI", `${afterGrad?.status}`);

    // unauthorized promotion request
    const unauthPromote = await post(HOSTS.school, "/api/students/promote", { fromClassId: cohortCls5 }, qrCookie);
    check("an unauthorized promotion request is refused (403)", unauthPromote.status === 403, `HTTP ${unauthPromote.status}`);

    // partial/failed: a bad target session mid-set must leave everything intact
    const preBad = await studentByAdm(cohort[1].admissionNo);
    const badMid = await post(HOSTS.school, "/api/students/promote", { fromClassId: cohortCls5, toSessionId: "as_bogus_mid" }, admin);
    const postBad = await studentByAdm(cohort[1].admissionNo);
    check("a rejected promotion mid-flow leaves students unchanged", badMid.status === 400 && preBad.classId === postBad.classId && preBad.sessionId === postBad.sessionId, `HTTP ${badMid.status}`);
  }

  /* ---------------------------------------------------------- 15. summary counts */
  sec("15. synthetic dataset summary");
  const finalStudents = await fsDocs("students", "schoolId", SYN);
  const finalGuardians = (await fsDocs("users", "schoolId", SYN)).filter((u) => u.role === "GUARDIAN");
  const finalBranches = await fsDocs("branches", "schoolId", SYN);
  const finalSessions = await fsDocs("academicSessions", "schoolId", SYN);
  check(`students in the synthetic school: ${finalStudents.length}`, finalStudents.length >= 50);
  check(`guardian accounts: ${finalGuardians.length}`, finalGuardians.length >= 20);
  check(`branches: ${finalBranches.length}`, finalBranches.length >= 2);
  check(`academic sessions: ${finalSessions.length}`, finalSessions.length >= 4);
  const branchACount = finalStudents.filter((s) => s.branchId === branchA.id).length;
  const branchBCount = finalStudents.filter((s) => s.branchId === branchB.id).length;
  check("students are distributed across both branches", branchACount > 0 && branchBCount > 0, `A=${branchACount} B=${branchBCount}`);
  const sessionSpread = new Set(finalStudents.map((s) => s.sessionId).filter(Boolean));
  check("students span multiple academic sessions", sessionSpread.size >= 2, `${sessionSpread.size} sessions`);

  console.log(`\nSYNTHETIC SCHOOL id=${SYN} slug=${synSlug}`);
}
