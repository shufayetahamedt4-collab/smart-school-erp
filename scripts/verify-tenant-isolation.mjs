/**
 * verify-tenant-isolation.mjs — pre-push cross-school isolation check.
 *
 * Logs in as the THROWAWAY fixture school's admin/teacher/student (created by
 * isolation-fixture.mjs) and calls the 10 swept routes. Asserts:
 *   1. fixture rows ARE visible (pulls genuinely work, not just empty), and
 *   2. NO name or id belonging to any other school in the DB appears in any
 *      payload (names/ids collected from Firestore across all other schools).
 *
 * Usage: node scripts/verify-tenant-isolation.mjs   (BASE, default http://localhost:3000)
 * Cleanup afterwards: node scripts/isolation-fixture.mjs clean
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";

import { requireEmulator } from "./lib/guard.mjs";

requireEmulator();

const BASE = process.env.BASE || "http://localhost:3000";
const P = "zziso-";

/** Fixture credentials live ONLY in the untracked track file — never committed. */
const TRACK = new URL(".qa-fixtures.json", import.meta.url);
if (!existsSync(TRACK)) {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(1);
}
const track = JSON.parse(readFileSync(TRACK, "utf8"));
const CRED = track.creds || {};
if (!CRED.admin || !CRED.teacher || !CRED.student) {
  console.error("❌ Track file lacks credentials — re-run: node scripts/isolation-fixture.mjs clean && node scripts/isolation-fixture.mjs create");
  process.exit(1);
}

// Emulator-only, credential-free init with the SAME project id as seed.mjs, so
// the fixture and the seeded tenants share one emulator namespace. No
// service-account.json, no cert(), no applicationDefault().
//
// INTEGRATION 1: origin/main's side of this conflict read service-account.json /
// applicationDefault() and selected `process.env.FIRESTORE_DB_ID`; that named-DB
// path is deliberately not used by this emulator-only script (see
// docs/INTEGRATION-LOG.md and the FIRESTORE_DB_ID rule in scripts/lib/guard.mjs).
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

/* ---------- foreign names + ids from every other school ---------- */
const foreignNames = new Set();
const foreignIds = new Set();
let foreignClassId = null; // one real foreign class id, used by the read probe
const schools = await db.collection("schools").get();
for (const s of schools.docs) {
  if (s.id === `${P}school`) continue;
  foreignIds.add(s.id);
  if (s.data().name) foreignNames.add(String(s.data().name));
  for (const [col, nameField] of [
    ["students", "name"], ["classes", "name"], ["sections", "name"],
    ["subjects", "name"], ["teachers", "name"], ["homeworks", "title"],
    ["fees", "title"], ["exams", "name"], ["users", "name"],
    ["departments", "name"], ["programs", "name"],
    ["courses", "title"], ["programCourses"],
  ]) {
    const snap = await db.collection(col).where("schoolId", "==", s.id).get();
    for (const d of snap.docs) {
      foreignIds.add(d.id);
      if (col === "classes" && !foreignClassId) foreignClassId = d.id;
      const n = d.data()[nameField];
      if (n) foreignNames.add(String(n));
    }
  }
}
console.log(`foreign reference data: ${foreignNames.size} names, ${foreignIds.size} ids from ${schools.size - 1} other school(s)`);

/* ---------- helper ---------- */
async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
async function getJSON(cookie, route) {
  const res = await fetch(`${BASE}${route}`, { headers: { cookie }, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { __raw: text.slice(0, 120) }; }
  return { status: res.status, body };
}
/** PATCH helper for the cross-tenant / institution-type probes. */
async function patchJSON(cookie, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { __raw: text.slice(0, 120) }; }
  return { status: res.status, body: parsed };
}
/** POST helper (Phase 4d) for the cross-tenant course-registration probes. */
async function postJSON(cookie, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { __raw: text.slice(0, 120) }; }
  return { status: res.status, body: parsed };
}
/** DELETE helper (Phase 4d) for the cross-tenant course-registration probes. */
async function delJSON(cookie, route) {
  const res = await fetch(`${BASE}${route}`, {
    method: "DELETE",
    headers: { cookie },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { __raw: text.slice(0, 120) }; }
  return { status: res.status, body: parsed };
}
/** HTML-page helper (6e): a server-rendered page, returned as text for a leak sweep. */
async function getHTML(cookie, route) {
  const res = await fetch(`${BASE}${route}`, { headers: { cookie }, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  return { status: res.status, text };
}

/**
 * Names + ids of every tenant EXCEPT `own`, including departments and programs.
 * The college section needs "everything that is NOT the tenant under test",
 * a different exclusion than the top-level school2 sweep uses.
 */
async function referenceDataExcept(own) {
  const names = new Set();
  const ids = new Set();
  const snap = await db.collection("schools").get();
  for (const s of snap.docs) {
    if (s.id === own) continue;
    ids.add(s.id);
    if (s.data().name) names.add(String(s.data().name));
    for (const [col, nameField] of [
      ["students", "name"], ["classes", "name"], ["sections", "name"],
      ["subjects", "name"], ["teachers", "name"], ["homeworks", "title"],
      ["fees", "title"], ["exams", "name"], ["users", "name"],
      ["departments", "name"], ["programs", "name"],
    ]) {
      const docs = await db.collection(col).where("schoolId", "==", s.id).get();
      for (const d of docs.docs) {
        ids.add(d.id);
        const n = d.data()[nameField];
        if (n) names.add(String(n));
      }
    }
  }
  return { names, ids };
}

/**
 * The hrefs `navForRole` yields for one role + tenant shape + mode.
 *
 * `nav.ts` imports its sibling `../lib/institution` WITHOUT a file extension, so
 * Node's ESM resolver cannot load it (bun's can). Run in-process when this file
 * itself runs under bun, otherwise shell out to bun for just this one probe —
 * the same runner the nav harness (verify-nav-scope.mjs) already needs.
 */
async function navHrefs(role, institutionType, mode) {
  const href = new URL("../src/components/nav.ts", import.meta.url).href;
  if (typeof Bun !== "undefined") {
    const { navForRole } = await import(href);
    return navForRole(role, institutionType, mode).map((i) => i.href);
  }
  const { execFileSync } = await import("node:child_process");
  const script =
    `import(${JSON.stringify(href)}).then(m=>console.log(JSON.stringify(` +
    `m.navForRole(${JSON.stringify(role)},${JSON.stringify(institutionType)},${JSON.stringify(mode)}).map(i=>i.href))))`;
  const out = execFileSync("bun", ["-e", script], { encoding: "utf8" });
  return JSON.parse(out.trim().split("\n").pop());
}

/** Walk a payload; return every string value (bounded). */
function walkStrings(v, out, depth = 0) {
  if (depth > 12 || out.size > 20000) return;
  if (typeof v === "string") { out.add(v); return; }
  if (Array.isArray(v)) { for (const x of v) walkStrings(x, out, depth + 1); return; }
  if (v && typeof v === "object") { for (const k of Object.keys(v)) walkStrings(v[k], out, depth + 1); }
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✅ ${msg}`);
  else { failures++; console.log(`  ❌ ${msg}`); }
}

// A cross-school isolation test is only meaningful when a genuine foreign tenant
// exists to be excluded. Fail (never pass) on an empty foreign set.
console.log("\n### foreign tenant availability");
check(foreignIds.size > 0 && foreignNames.size > 0,
  `a real foreign tenant exists — ${foreignNames.size} name(s), ${foreignIds.size} id(s) from ${schools.size - 1} other school(s)`);

const SESSIONS = [
  { label: "school2-admin", email: "zz-iso-admin@test.local", password: CRED.admin },
  { label: "school2-teacher", email: "zz-iso-teacher@test.local", password: CRED.teacher },
  { label: "school2-student", email: "zz-iso-student@test.local", password: CRED.student },
];

for (const acc of SESSIONS) {
  console.log(`\n### ${acc.label}`);
  const cookie = await login(acc.email, acc.password);
  const routes = [
    "/api/chat",
    "/api/assignments",
    "/api/homework",
    "/api/fees",
    "/api/meetings",
    "/api/exams",
    "/api/routines",
    "/api/attendance?classId=zziso-class&date=2026-09-11",
    "/api/classes",
    "/api/stats",
    "/api/departments",
    "/api/programs",
    "/api/courses",
  ];
  let inspected = 0;
  for (const route of routes) {
    const { status, body } = await getJSON(cookie, route);
    if (status === 403) { console.log(`  ⛔ 403 (no access for this role)  ${route}`); continue; }
    if (status !== 200) { failures++; console.log(`  ❌ HTTP ${status}  ${route}  ${JSON.stringify(body).slice(0, 150)}`); continue; }
    inspected++;
    const strings = new Set();
    walkStrings(body, strings);
    const leakedNames = [...foreignNames].filter((n) => n && strings.has(n));
    const leakedIds = [...foreignIds].filter((id) => strings.has(id));
    check(leakedNames.length === 0 && leakedIds.length === 0,
      `${route} — no foreign data${leakedNames.length ? ` (NAMES: ${leakedNames.slice(0, 3).join(", ")})` : ""}${leakedIds.length ? ` (IDS: ${leakedIds.slice(0, 3).join(", ")})` : ""}`);
  }
  // A wall of 403s must not read as a clean isolation result: require that this
  // role actually had an accessible route whose payload was inspected.
  check(inspected > 0, `${acc.label}: at least one accessible route inspected (${inspected} of ${routes.length})`);
}

/* ---------- fixture visibility (pulls genuinely work) ---------- */
console.log("\n### fixture visibility (school2 teacher)");
const tCookie = await login("zz-iso-teacher@test.local", CRED.teacher);
const hw = await getJSON(tCookie, "/api/homework");
const hwList = hw.body.data || [];
check(hw.status === 200 && hwList.some((h) => h.title === "ZZ Iso Homework"), "homework list contains the fixture homework");
const exams = await getJSON(tCookie, "/api/exams");
check(exams.status === 200 && (exams.body.data || []).some((e) => e.name === "ZZ Iso Exam"), "exam list contains the fixture exam");
const rout = await getJSON(tCookie, "/api/routines");
const rrows = rout.body.data || [];
check(rout.status === 200 && rrows.length >= 1 && JSON.stringify(rrows).includes("ZZ Iso"), "routines contain fixture rows with resolved names");
const att = await getJSON(tCookie, "/api/attendance?classId=zziso-class&date=2026-09-11");
check(att.status === 200 && (att.body.data || []).some((a) => a.id === "zziso-student" && a.status === "PRESENT"), "attendance returns the fixture student row (PRESENT)");

console.log("\n### fixture visibility (school2 teacher chat thread)");
const chat = await getJSON(tCookie, "/api/chat");
const convs = chat.body.data || [];
check(chat.status === 200 && convs.some((c) => c.id === "zziso-conv"), "chat lists the fixture conversation");

console.log("\n### cross-tenant read by explicit foreign id");
if (!foreignClassId) {
  check(false, "a foreign class id is available for the read probe");
} else {
  const probe = await getJSON(tCookie, `/api/attendance?classId=${encodeURIComponent(foreignClassId)}&date=2026-09-11`);
  const rows = probe.body?.data || [];
  check(rows.length === 0,
    `supplying another tenant's class id returns no rows — status=${probe.status} rows=${rows.length} (${foreignClassId})`);
}

console.log("\n### userNamesFor school-scoping (school2 admin sees only ZZ names in routines/homework)");
const aCookie = await login("zz-iso-admin@test.local", CRED.admin);
const r2 = await getJSON(aCookie, "/api/routines");
const names = new Set();
walkStrings(r2.body, names);
const zzNames = [...names].filter((n) => typeof n === "string" && n.startsWith("ZZ Iso"));
check(zzNames.includes("ZZ Iso Teacher"), "routines resolve the fixture teacher name");
check(![...names].some((n) => /^s_[0-9a-f]{40}$/.test(n)), "no foreign school ids anywhere in routines payload");

/* ---------- college routes are refused for a SCHOOL tenant (no institutionType) ---------- */
// A tenant with no `institutionType` reads as SCHOOL, so the COLLEGE gate must
// answer both college routes with a 403 before any data is touched.
console.log("\n### college routes are refused for a SCHOOL tenant");
{
  const sCookie = await login("zz-iso-admin@test.local", CRED.admin);
  for (const route of ["/api/departments", "/api/programs", "/api/courses"]) {
    const r = await getJSON(sCookie, route);
    check(r.status === 403, `${route} → 403 for a SCHOOL tenant (got ${r.status})`);
  }
  // /api/courses, asserted EXPLICITLY and not left to the sweep's "403 = no
  // access for this role" counter: a SCHOOL tenant gets 403 AND zero data. An
  // empty 200 would be a leak; a 403 carrying rows would be worse.
  const c = await getJSON(sCookie, "/api/courses");
  check(
    c.status === 403 && c.body?.data === undefined,
    `/api/courses → 403 with ZERO data for a SCHOOL tenant (status=${c.status}, data=${JSON.stringify(c.body?.data)})`
  );
}

/* ---------- a COLLEGE tenant: own rows visible, zero foreign row ---------- */
console.log("\n### college tenant — own departments/programs visible, zero foreign data");
const collectStrings = (body) => {
  const out = new Set();
  walkStrings(body, out);
  return out;
};
{
  const collegeCookie = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
  const foreign = await referenceDataExcept(`${P}college`);

  const depts = await getJSON(collegeCookie, "/api/departments");
  const deptNames = (depts.body.data || []).map((d) => d.name);
  check(depts.status === 200, `/api/departments → 200 for a COLLEGE tenant (got ${depts.status})`);
  check(
    deptNames.includes("ZZ Iso College Dept A") && deptNames.includes("ZZ Iso College Dept B") &&
      deptNames.includes("ZZ Iso College Dept None"),
    `all three own departments are visible (${JSON.stringify(deptNames)})`
  );
  const dStr = collectStrings(depts.body);
  const dLeakNames = [...foreign.names].filter((n) => dStr.has(n));
  const dLeakIds = [...foreign.ids].filter((id) => dStr.has(id));
  check(
    dLeakNames.length === 0 && dLeakIds.length === 0,
    `/api/departments — no foreign id or name${dLeakNames.length ? ` (NAMES: ${dLeakNames.slice(0, 3).join(", ")})` : ""}${dLeakIds.length ? ` (IDS: ${dLeakIds.slice(0, 3).join(", ")})` : ""}`
  );

  const progs = await getJSON(collegeCookie, "/api/programs");
  const progNames = (progs.body.data || []).map((p) => p.name);
  check(progs.status === 200, `/api/programs → 200 for a COLLEGE tenant (got ${progs.status})`);
  check(
    progNames.includes("ZZ Iso College Program A") && progNames.includes("ZZ Iso College Program B"),
    `both own programs are visible (${JSON.stringify(progNames)})`
  );
  const pStr = collectStrings(progs.body);
  const pLeakNames = [...foreign.names].filter((n) => pStr.has(n));
  const pLeakIds = [...foreign.ids].filter((id) => pStr.has(id));
  check(
    pLeakNames.length === 0 && pLeakIds.length === 0,
    `/api/programs — no foreign id or name${pLeakNames.length ? ` (NAMES: ${pLeakNames.slice(0, 3).join(", ")})` : ""}${pLeakIds.length ? ` (IDS: ${pLeakIds.slice(0, 3).join(", ")})` : ""}`
  );

  // A foreign departmentId can only ever narrow the result to ZERO rows.
  const allDepts = (await db.collection("departments").get()).docs.map((d) => ({ id: d.id, ...d.data() }));
  const foreignDept = allDepts.find((d) => d.schoolId !== `${P}college`);
  if (!foreignDept) {
    check(false, "a foreign department id exists for the ?departmentId= probe");
  } else {
    const probe = await getJSON(collegeCookie, `/api/programs?departmentId=${encodeURIComponent(foreignDept.id)}`);
    const rows = probe.body?.data || [];
    check(
      rows.length === 0,
      `?departmentId=<foreign ${foreignDept.id}> returns zero rows — status=${probe.status} rows=${rows.length}`
    );
  }
  // …and the own department filter still returns exactly its own program.
  const own = await getJSON(collegeCookie, `/api/programs?departmentId=${P}col-dept-a`);
  const ownRows = own.body?.data || [];
  check(
    ownRows.length === 1 && ownRows[0].id === `${P}col-prog-a`,
    `?departmentId=<own dept A> returns exactly its own program (${JSON.stringify(ownRows.map((r) => r.id))})`
  );

  // The courses catalogue (3e): own rows visible, zero foreign row anywhere.
  const courses = await getJSON(collegeCookie, "/api/courses");
  const courseTitles = (courses.body.data || []).map((c) => c.title);
  check(courses.status === 200, `/api/courses → 200 for a COLLEGE tenant (got ${courses.status})`);
  check(
    courseTitles.includes("ZZ Iso College Course A") && courseTitles.includes("ZZ Iso College Course B") &&
      courseTitles.includes("ZZ Iso College Course None"),
    `all three own courses are visible (${JSON.stringify(courseTitles)})`
  );
  const cStr = collectStrings(courses.body);
  const cLeakNames = [...foreign.names].filter((n) => cStr.has(n));
  const cLeakIds = [...foreign.ids].filter((id) => cStr.has(id));
  check(
    cLeakNames.length === 0 && cLeakIds.length === 0,
    `/api/courses — no foreign id or name${cLeakNames.length ? ` (NAMES: ${cLeakNames.slice(0, 3).join(", ")})` : ""}${cLeakIds.length ? ` (IDS: ${cLeakIds.slice(0, 3).join(", ")})` : ""}`
  );
  // A foreign departmentId can only ever narrow the course list to ZERO rows.
  if (foreignDept) {
    const probe = await getJSON(collegeCookie, `/api/courses?departmentId=${encodeURIComponent(foreignDept.id)}`);
    check(
      (probe.body?.data || []).length === 0,
      `?departmentId=<foreign ${foreignDept.id}> returns zero courses — status=${probe.status} rows=${(probe.body?.data || []).length}`
    );
  }
  // The program→course mapping (`programCourses`) under own program A is exactly
  // its own single mapping; the foreign tenant's mapping id never appears.
  const mapList = await getJSON(collegeCookie, `/api/programs/${P}col-prog-a/courses`);
  const mapRows = mapList.body?.data || [];
  check(
    mapList.status === 200 && mapRows.length === 1 && mapRows[0].id === `${P}col-map-a`,
    `program A's term list is exactly its own mapping (${JSON.stringify(mapRows.map((m) => m.id))})`
  );
  const mStr = collectStrings(mapList.body);
  check(
    !mStr.has(`${P}both-map`) && !mStr.has(`${P}both-course`),
    "the mapping list carries no foreign (BOTH-tenant) mapping or course id"
  );
}

/* ---------- course registrations: cross-tenant isolation (Phase 4d) ---------- */
// A registration in college tenant C1 must be invisible AND untouchable from
// every other tenant: the SCHOOL tenant (gate), and the BOTH tenant (the
// second college-capable tenant, whose row set must never include C1's). A
// foreign id is NOT FOUND (404) or GATED (403) — never an oracle — and the
// foreign row is asserted unchanged afterwards. No app source is exercised
// beyond what 4b already shipped.
console.log("\n### course registrations — a COLLEGE tenant's rows are invisible and untouchable elsewhere");
{
  const C1 = `${P}college`;
  const colRegA = `${P}col-reg-a`;
  const colStuA = `${P}col-stu-a`;
  const colStuB = `${P}col-stu-b`;
  const colCourseA = `${P}col-course-a`;
  const bothStu = `${P}both-stu`;
  const bothCourse = `${P}both-course`;
  const bothReg = `${P}both-reg`;

  const collegeCookie = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
  const bothCookie = await login("zz-iso-both-admin@test.local", CRED.bothAdmin);
  const sCookie = await login("zz-iso-admin@test.local", CRED.admin);

  // (1) C1 sees its own two registrations...
  const own = await getJSON(collegeCookie, "/api/course-registrations");
  const ownIds = (own.body.data || []).map((r) => r.id);
  check(own.status === 200, `/api/course-registrations → 200 for a COLLEGE tenant (got ${own.status})`);
  check(
    ownIds.includes(colRegA) && ownIds.includes(`${P}col-reg-b`),
    `C1 sees both of its own registrations (${JSON.stringify(ownIds)})`
  );
  // (2) ...and no foreign row or name anywhere in the payload.
  const foreign = await referenceDataExcept(C1);
  const oStr = collectStrings(own.body);
  const oLeakNames = [...foreign.names].filter((n) => oStr.has(n));
  const oLeakIds = [...foreign.ids].filter((id) => oStr.has(id));
  check(
    oLeakNames.length === 0 && oLeakIds.length === 0,
    `/api/course-registrations — no foreign id or name${oLeakNames.length ? ` (NAMES: ${oLeakNames.slice(0, 3).join(", ")})` : ""}${oLeakIds.length ? ` (IDS: ${oLeakIds.slice(0, 3).join(", ")})` : ""}`
  );

  // (3) A SCHOOL tenant hits the COLLEGE gate: 403 with ZERO data (list).
  const sList = await getJSON(sCookie, "/api/course-registrations");
  check(
    sList.status === 403 && sList.body?.data === undefined,
    `/api/course-registrations → 403 with ZERO data for a SCHOOL tenant (status=${sList.status}, data=${JSON.stringify(sList.body?.data)})`
  );

  // (4) The BOTH tenant's list is 200 and carries ONLY its own registration.
  const bList = await getJSON(bothCookie, "/api/course-registrations");
  const bIds = (bList.body.data || []).map((r) => r.id);
  check(
    bList.status === 200 && bIds.includes(bothReg) && !bIds.includes(colRegA) && !bIds.includes(`${P}col-reg-b`),
    `the BOTH tenant sees only its own registration (${JSON.stringify(bIds)})`
  );

  // (5) A SCHOOL tenant's one-row read is the gate, NOT an id oracle: a REAL C1
  //     id and a GHOST id answer the SAME 403 with byte-identical bodies, so the
  //     status cannot be used to learn that the C1 row exists.
  const sOne = await getJSON(sCookie, `/api/course-registrations/${colRegA}`);
  const sGhost = await getJSON(sCookie, `/api/course-registrations/${P}no-such-reg`);
  check(
    sOne.status === 403 && sGhost.status === 403 && JSON.stringify(sOne.body) === JSON.stringify(sGhost.body),
    `a SCHOOL tenant GET one is 403 for BOTH a real and a ghost id, byte-identical (gate, not oracle) — real=${sOne.status} ghost=${sGhost.status}`
  );

  // (6) A foreign id from the COLLEGE tenant is NOT FOUND for the BOTH tenant.
  const bOne = await getJSON(bothCookie, `/api/course-registrations/${colRegA}`);
  check(bOne.status === 404, `the BOTH tenant GET one (foreign C1 id) → 404 (got ${bOne.status})`);

  // (7) PATCH and DELETE on the foreign row are 404 too (never a 403 oracle).
  const bPatch = await patchJSON(bothCookie, `/api/course-registrations/${colRegA}`, { status: "APPROVED" });
  const bDel = await delJSON(bothCookie, `/api/course-registrations/${colRegA}`);
  check(
    bPatch.status === 404 && bDel.status === 404,
    `the BOTH tenant PATCH/DELETE of the foreign C1 row → 404/404 (got ${bPatch.status}/${bDel.status})`
  );

  // (8) …and the C1 row is UNCHANGED after every foreign attempt.
  const regRow = (await db.collection("courseRegistrations").doc(colRegA).get()).data();
  check(
    regRow?.status === "PENDING" && regRow?.schoolId === C1 && regRow?.branchId === `${P}col-br-a`,
    `the C1 registration row is unchanged after the foreign attempts (${regRow?.status} / ${regRow?.schoolId} / ${regRow?.branchId})`
  );

  // (9) A FOREIGN studentId in a BOTH-tenant POST is the SAME 400 as a ghost id.
  const fStu = await postJSON(bothCookie, "/api/course-registrations", { studentId: colStuA, courseId: bothCourse });
  const gStu = await postJSON(bothCookie, "/api/course-registrations", { studentId: `${P}no-such-student`, courseId: bothCourse });
  check(
    fStu.status === 400 && JSON.stringify(fStu.body) === JSON.stringify(gStu.body),
    `a foreign studentId in a POST is 400, byte-identical to a ghost (foreign=${JSON.stringify(fStu.body)} ghost=${JSON.stringify(gStu.body)})`
  );

  // (10) A FOREIGN courseId in a BOTH-tenant POST is the SAME 400 as a ghost id.
  const fCourse = await postJSON(bothCookie, "/api/course-registrations", { studentId: bothStu, courseId: colCourseA });
  const gCourse = await postJSON(bothCookie, "/api/course-registrations", { studentId: bothStu, courseId: `${P}no-such-course` });
  check(
    fCourse.status === 400 && JSON.stringify(fCourse.body) === JSON.stringify(gCourse.body),
    `a foreign courseId in a POST is 400, byte-identical to a ghost (foreign=${JSON.stringify(fCourse.body)} ghost=${JSON.stringify(gCourse.body)})`
  );

  // (11) …and the reverse: C1 cannot pull another tenant's student/course into
  //      a registration either — the same 400 as a ghost, so no oracle.
  const cFStu = await postJSON(collegeCookie, "/api/course-registrations", { studentId: bothStu, courseId: colCourseA });
  const cGStu = await postJSON(collegeCookie, "/api/course-registrations", { studentId: `${P}no-such-student`, courseId: colCourseA });
  check(
    cFStu.status === 400 && JSON.stringify(cFStu.body) === JSON.stringify(cGStu.body),
    `C1 POST with a foreign (BOTH) studentId is 400, byte-identical to a ghost (foreign=${JSON.stringify(cFStu.body)} ghost=${JSON.stringify(cGStu.body)})`
  );
  const cFCourse = await postJSON(collegeCookie, "/api/course-registrations", { studentId: colStuB, courseId: bothCourse });
  const cGCourse = await postJSON(collegeCookie, "/api/course-registrations", { studentId: colStuB, courseId: `${P}no-such-course` });
  check(
    cFCourse.status === 400 && JSON.stringify(cFCourse.body) === JSON.stringify(cGCourse.body),
    `C1 POST with a foreign (BOTH) courseId is 400, byte-identical to a ghost (foreign=${JSON.stringify(cFCourse.body)} ghost=${JSON.stringify(cGCourse.body)})`
  );

  // (12) Another tenant's student DELETE neither sees nor is blocked by C1's
  //      registrations: the C1 student is NOT FOUND and its row survives.
  const bDelStu = await delJSON(bothCookie, `/api/students/${colStuA}`);
  const stuRow = (await db.collection("students").doc(colStuA).get()).data();
  check(
    bDelStu.status === 404 && stuRow?.schoolId === C1 && stuRow?.name === "ZZ Iso College Student A",
    `another tenant's student DELETE of a C1 student is 404 and leaves the row (status=${bDelStu.status}, schoolId=${stuRow?.schoolId}, name=${stuRow?.name})`
  );
}

/* ---------- course results: cross-tenant isolation (Phase 6c) ---------- */
// A `courseResults` row in college tenant C1 must be invisible AND untouchable
// from every other tenant: the SCHOOL tenant (the gate) and the BOTH tenant (the
// second college-capable tenant, whose row set must never include C1's). A
// foreign id is NOT FOUND (404) or GATED (403) — never an oracle — and the
// foreign row is asserted unchanged afterwards. The fixture stores no grade at
// all, so every check below also proves the read DERIVES the grade from the
// active scheme (D-6-12) and names that scheme (D-6-6): the assertions are
// written against the response's OWN `passPercent`/`showGpa`, so they hold under
// any scheme the tenant is configured with rather than pinning the shipped one.
console.log("\n### course results — a COLLEGE tenant's rows are invisible and untouchable elsewhere");
{
  const C1 = `${P}college`;
  const colResA = `${P}col-res-a`;
  const colResB = `${P}col-res-b`;
  const colStuA = `${P}col-stu-a`;
  const colCourseA = `${P}col-course-a`;
  const bothStu = `${P}both-stu`;
  const bothCourse = `${P}both-course`;
  const bothRes = `${P}both-res`;

  const collegeCookie = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
  const bothCookie = await login("zz-iso-both-admin@test.local", CRED.bothAdmin);
  const sCookie = await login("zz-iso-admin@test.local", CRED.admin);

  // (1) C1 sees its own two results...
  const own = await getJSON(collegeCookie, "/api/course-results");
  const ownIds = (own.body.data || []).map((r) => r.id);
  check(own.status === 200, `/api/course-results → 200 for a COLLEGE tenant (got ${own.status})`);
  check(
    ownIds.includes(colResA) && ownIds.includes(colResB),
    `C1 sees both of its own results (${JSON.stringify(ownIds)})`
  );

  // (2) ...graded ON READ under the tenant's own scheme (D-6-12), with the active
  //     scale named in the payload so it is never a guess (D-6-6).
  const passPercent = Number(own.body.scheme?.passPercent);
  const showGpa = own.body.scheme?.showGpa !== false;
  const rowA = (own.body.data || []).find((r) => r.id === colResA);
  check(
    rowA?.percent === 70 && typeof rowA?.grade === "string" && rowA.grade.length > 0 &&
      rowA?.passed === (70 >= passPercent),
    `the stored 70/100 is graded at read time (percent=${rowA?.percent} grade=${JSON.stringify(rowA?.grade)} passed=${rowA?.passed} pass=${passPercent}%)`
  );
  check(
    typeof own.body.scheme?.name === "string" && own.body.scheme.name.length > 0 &&
      typeof own.body.scheme?.gpaScale === "number",
    `the response names the scale in force (${own.body.scheme?.name} out of ${own.body.scheme?.gpaScale})`
  );

  // (3) ...and no foreign row or name anywhere in the payload.
  //
  // The DERIVED fields (`grade`, `gradeRemark`, and the `scheme` block) are THIS
  // tenant's own grade-band labels and scheme name, not another tenant's rows — a
  // one-letter band such as "A" collides with a class or section named "A" in some
  // other tenant, which is not a leak. They are excluded from the name comparison
  // only; every id, and every joined entity name (student, course, programme),
  // is still swept exactly as the sibling sections sweep theirs.
  const foreign = await referenceDataExcept(C1);
  const sweepable = {
    ...own.body,
    scheme: undefined,
    data: (own.body.data || []).map(({ grade, gradeRemark, ...rest }) => rest),
  };
  const oStr = collectStrings(sweepable);
  const oLeakNames = [...foreign.names].filter((n) => oStr.has(n));
  const oLeakIds = [...foreign.ids].filter((id) => oStr.has(id));
  check(
    oLeakNames.length === 0 && oLeakIds.length === 0,
    `/api/course-results — no foreign id or name${oLeakNames.length ? ` (NAMES: ${oLeakNames.slice(0, 3).join(", ")})` : ""}${oLeakIds.length ? ` (IDS: ${oLeakIds.slice(0, 3).join(", ")})` : ""}`
  );

  // (4) The transcript READ (6c) derives the same grade, and suppresses the CGPA
  //     ENTIRELY under a no-GPA scheme rather than printing a 0.00 (D-6-16).
  const tOwn = await getJSON(collegeCookie, `/api/course-results/students/${colStuA}/transcript`);
  const tData = tOwn.body.data;
  const tCourse = (tData?.terms || []).flatMap((t) => t.courses || []).find((c) => c.courseId === colCourseA);
  check(
    tOwn.status === 200 && tData?.scheme?.name === own.body.scheme?.name &&
      tData?.scheme?.passPercent === passPercent,
    `→ 200 for its own student, naming the same scheme (status=${tOwn.status}, scheme=${tData?.scheme?.name})`
  );
  check(
    tCourse?.percent === 70 && typeof tCourse?.grade === "string" && tCourse.grade.length > 0 &&
      (showGpa ? typeof tData?.cgpa === "number" : tData?.cgpa === null),
    `the transcript derives the course grade and ${showGpa ? "a numeric CGPA" : "NO CGPA at all"} (percent=${tCourse?.percent} grade=${JSON.stringify(tCourse?.grade)} cgpa=${JSON.stringify(tData?.cgpa)})`
  );

  // (5) A foreign student id on the transcript read is NOT FOUND, never an oracle.
  const tForeign = await getJSON(collegeCookie, `/api/course-results/students/${bothStu}/transcript`);
  check(tForeign.status === 404, `the transcript read of a foreign (BOTH) student → 404 (got ${tForeign.status})`);

  // (6) A SCHOOL tenant hits the COLLEGE gate: 403 with ZERO data, on both reads.
  const sList = await getJSON(sCookie, "/api/course-results");
  check(
    sList.status === 403 && sList.body?.data === undefined,
    `/api/course-results → 403 with ZERO data for a SCHOOL tenant (status=${sList.status}, data=${JSON.stringify(sList.body?.data)})`
  );
  const sTranscript = await getJSON(sCookie, `/api/course-results/students/${colStuA}/transcript`);
  check(
    sTranscript.status === 403 && sTranscript.body?.data === undefined,
    `the transcript read → 403 with ZERO data for a SCHOOL tenant (status=${sTranscript.status})`
  );

  // (7) The BOTH tenant's list is 200 and carries ONLY its own result.
  const bList = await getJSON(bothCookie, "/api/course-results");
  const bIds = (bList.body.data || []).map((r) => r.id);
  check(
    bList.status === 200 && bIds.includes(bothRes) && !bIds.includes(colResA) && !bIds.includes(colResB),
    `the BOTH tenant sees only its own result (${JSON.stringify(bIds)})`
  );

  // (8) A foreign id from the COLLEGE tenant is NOT FOUND for the BOTH tenant.
  const bOne = await getJSON(bothCookie, `/api/course-results/${colResA}`);
  check(bOne.status === 404, `the BOTH tenant GET one (foreign C1 id) → 404 (got ${bOne.status})`);

  // (9) PATCH and DELETE on the foreign row are 404 too (never a 403 oracle).
  const bPatch = await patchJSON(bothCookie, `/api/course-results/${colResA}`, { obtained: 1 });
  const bDel = await delJSON(bothCookie, `/api/course-results/${colResA}`);
  check(
    bPatch.status === 404 && bDel.status === 404,
    `the BOTH tenant PATCH/DELETE of the foreign C1 row → 404/404 (got ${bPatch.status}/${bDel.status})`
  );

  // (10) ...and the C1 row is UNCHANGED after every foreign attempt.
  const resRow = (await db.collection("courseResults").doc(colResA).get()).data();
  check(
    resRow?.obtained === 70 && resRow?.fullMarks === 100 && resRow?.schoolId === C1 &&
      resRow?.branchId === `${P}col-br-a` && resRow?.attempt === 1,
    `the C1 result row is unchanged after the foreign attempts (${resRow?.obtained}/${resRow?.fullMarks} / ${resRow?.schoolId} / ${resRow?.branchId})`
  );

  // (11) A FOREIGN studentId in a BOTH-tenant POST is the SAME 400 as a ghost id.
  const fStu = await postJSON(bothCookie, "/api/course-results", { studentId: colStuA, courseId: bothCourse, obtained: 50, fullMarks: 100 });
  const gStu = await postJSON(bothCookie, "/api/course-results", { studentId: `${P}no-such-student`, courseId: bothCourse, obtained: 50, fullMarks: 100 });
  check(
    fStu.status === 400 && JSON.stringify(fStu.body) === JSON.stringify(gStu.body),
    `a foreign studentId in a POST is 400, byte-identical to a ghost (foreign=${JSON.stringify(fStu.body)} ghost=${JSON.stringify(gStu.body)})`
  );

  // (12) A FOREIGN courseId in a BOTH-tenant POST is the SAME 400 as a ghost id.
  const fCourse = await postJSON(bothCookie, "/api/course-results", { studentId: bothStu, courseId: colCourseA, obtained: 50, fullMarks: 100 });
  const gCourse = await postJSON(bothCookie, "/api/course-results", { studentId: bothStu, courseId: `${P}no-such-course`, obtained: 50, fullMarks: 100 });
  check(
    fCourse.status === 400 && JSON.stringify(fCourse.body) === JSON.stringify(gCourse.body),
    `a foreign courseId in a POST is 400, byte-identical to a ghost (foreign=${JSON.stringify(fCourse.body)} ghost=${JSON.stringify(gCourse.body)})`
  );

  // (13) ...and the reverse: C1 cannot pull another tenant's student into a
  //      result either — the same 400 as a ghost, so no oracle.
  const cFStu = await postJSON(collegeCookie, "/api/course-results", { studentId: bothStu, courseId: colCourseA, obtained: 50, fullMarks: 100 });
  const cGStu = await postJSON(collegeCookie, "/api/course-results", { studentId: `${P}no-such-student`, courseId: colCourseA, obtained: 50, fullMarks: 100 });
  check(
    cFStu.status === 400 && JSON.stringify(cFStu.body) === JSON.stringify(cGStu.body),
    `C1 POST with a foreign (BOTH) studentId is 400, byte-identical to a ghost (foreign=${JSON.stringify(cFStu.body)} ghost=${JSON.stringify(cGStu.body)})`
  );
}

/* ---------- course results PAGES: no cross-tenant leak (6e) ---------- */
// The API reads are swept above; the SCREEN and the transcript PRINT PAGE are the
// two other surfaces a foreign tenant can reach. The page gate is the SAME rule
// the API uses (6d-fix), so a foreign student renders the NOT-FOUND refusal —
// never a transcript — and neither page names the other tenant's student.
console.log("\n### course results — the page never leaks another tenant's student (6e)");
{
  const C1 = `${P}college`;
  const colStuA = `${P}col-stu-a`;
  const bothStu = `${P}both-stu`;
  const NAME_A = "ZZ Iso College Student A";
  const NAME_BOTH = "ZZ Iso Both Student";

  const collegeCookie = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
  const bothCookie = await login("zz-iso-both-admin@test.local", CRED.bothAdmin);

  // (1) Positive control: C1's OWN transcript print page names its own student.
  const ownPrint = await getHTML(collegeCookie, `/print/college-transcript/${colStuA}`);
  check(
    ownPrint.status === 200 && ownPrint.text.includes(NAME_A),
    `C1's own transcript print page renders its own student (status=${ownPrint.status}, named=${ownPrint.text.includes(NAME_A)})`
  );

  // (2) A FOREIGN tenant asking for that same student gets the NOT-FOUND refusal,
  //     and the body never names the student.
  const foreignPrint = await getHTML(bothCookie, `/print/college-transcript/${colStuA}`);
  check(
    foreignPrint.status === 200 && /Transcript not found/.test(foreignPrint.text) && !foreignPrint.text.includes(NAME_A),
    `the BOTH tenant's print page for a C1 student is NOT FOUND and never names it (status=${foreignPrint.status}, notFound=${/Transcript not found/.test(foreignPrint.text)}, leaked=${foreignPrint.text.includes(NAME_A)})`
  );

  // (3) ...and the reverse holds too.
  const reversePrint = await getHTML(collegeCookie, `/print/college-transcript/${bothStu}`);
  check(
    reversePrint.status === 200 && /Transcript not found/.test(reversePrint.text) && !reversePrint.text.includes(NAME_BOTH),
    `C1's print page for a BOTH student is NOT FOUND and never names it (status=${reversePrint.status}, notFound=${/Transcript not found/.test(reversePrint.text)}, leaked=${reversePrint.text.includes(NAME_BOTH)})`
  );

  // (4) The results SCREEN carries no other tenant's student (name or id).
  const ownScreen = await getHTML(collegeCookie, "/dashboard/college-results");
  check(
    ownScreen.status === 200 && !ownScreen.text.includes(NAME_BOTH) && !ownScreen.text.includes(bothStu),
    `C1's results screen names no other tenant's student (status=${ownScreen.status}, leakedName=${ownScreen.text.includes(NAME_BOTH)}, leakedId=${ownScreen.text.includes(bothStu)})`
  );

  // (5) ...and the second college-capable tenant's screen names none of C1's.
  const bothScreen = await getHTML(bothCookie, "/dashboard/college-results");
  check(
    bothScreen.status === 200 && !bothScreen.text.includes(NAME_A) && !bothScreen.text.includes(colStuA),
    `the BOTH tenant's results screen names no C1 student (status=${bothScreen.status}, leakedName=${bothScreen.text.includes(NAME_A)}, leakedId=${bothScreen.text.includes(colStuA)})`
  );
}

/* ---------- BOTH tenant, mode=SCHOOL: the API still follows institutionType ---------- */
console.log("\n### BOTH tenant in SCHOOL mode — the API still follows institutionType");
// INTENDED BEHAVIOUR (docs/COLLEGE-DECISIONS.md §3): the UI *mode* is context
// only; it never grants or revokes an API capability. `requireCollege()` decides
// from `institutionType` alone, so a BOTH tenant keeps full access to the college
// routes no matter which mode its sidebar shows. Only the NAV is mode-aware: in
// SCHOOL mode the college items are hidden, so the tenant is simply not nudged
// toward them — the server, not the mode, stays the gate.
{
  const bothCookie = await login("zz-iso-both-admin@test.local", CRED.bothAdmin);
  const inSchoolMode = await getJSON(`${bothCookie}; ss_mode=SCHOOL`, "/api/departments");
  check(
    inSchoolMode.status === 200 &&
      (inSchoolMode.body.data || []).some((d) => d.id === `${P}both-dept`),
    `mode=SCHOOL does NOT block the API for a BOTH tenant — /api/departments ${inSchoolMode.status} with own row`
  );
  let schoolHrefs = null;
  let collegeHrefs = null;
  try {
    schoolHrefs = await navHrefs("SCHOOL_ADMIN", "BOTH", "SCHOOL");
    collegeHrefs = await navHrefs("SCHOOL_ADMIN", "BOTH", "COLLEGE");
  } catch (e) {
    check(false, `the nav probe could not run (${e?.message || e})`);
  }
  if (schoolHrefs) {
    check(
      schoolHrefs.length > 0 &&
        !schoolHrefs.includes("/dashboard/departments") &&
        !schoolHrefs.includes("/dashboard/programs"),
      `the NAV hides both college items for a BOTH tenant in SCHOOL mode (${schoolHrefs.length} items)`
    );
  }
  if (collegeHrefs) {
    check(
      collegeHrefs.includes("/dashboard/departments") && collegeHrefs.includes("/dashboard/programs"),
      "…and shows them again in COLLEGE mode"
    );
  }
}

/* ---------- BOTH → SCHOOL downgrade through the API (2g rule) ---------- */
console.log("\n### BOTH → SCHOOL downgrade (blocked with data, allowed without)");
{
  const superCookie = await login("admin@smartschool.com", "Admin@123");
  const blocked = await patchJSON(superCookie, `/api/schools/${P}both`, { institutionType: "SCHOOL" });
  check(
    blocked.status === 409 && /college data/i.test(blocked.body?.error || ""),
    `BOTH tenant WITH a department cannot be downgraded — 409 (${blocked.status})`
  );
  const allowed = await patchJSON(superCookie, `/api/schools/${P}both-empty`, { institutionType: "SCHOOL" });
  check(
    allowed.status === 200,
    `BOTH tenant with NO college data can be downgraded — 200 (${allowed.status})`
  );
}

/* ---------- COLLEGE registrations-only → SCHOOL downgrade (5-pre) ---------- */
// A tenant whose ONLY college data is a courseRegistrations row must be refused
// a downgrade: the 2g check (departments + programs) alone would allow it, so a
// 409 here can only come from the new registrations count. The paired control
// is the same tenant shape with no registration at all, which must still pass.
console.log("\n### COLLEGE registrations-only → SCHOOL downgrade (5-pre)");
{
  const superCookie = await login("admin@smartschool.com", "Admin@123");
  const regOnly = await patchJSON(superCookie, `/api/schools/${P}reg-only`, { institutionType: "SCHOOL" });
  check(
    regOnly.status === 409 && /college data/i.test(regOnly.body?.error || ""),
    `a COLLEGE tenant whose only college data is a registration cannot be downgraded — 409 (${regOnly.status})`
  );
  const regOnlyEmpty = await patchJSON(superCookie, `/api/schools/${P}reg-only-empty`, { institutionType: "SCHOOL" });
  check(
    regOnlyEmpty.status === 200,
    `the same tenant with no registration can still be downgraded — 200 (${regOnlyEmpty.status})`
  );
}

console.log(failures === 0 ? "\n✅ ISOLATION CONFIRMED — no cross-school data in any of the 13 swept routes" : `\n❌ ${failures} isolation failure(s)`);
process.exit(failures === 0 ? 0 : 1);
