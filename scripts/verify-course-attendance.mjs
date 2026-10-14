#!/usr/bin/env node
/**
 * verify-course-attendance.mjs — Phase 8 ca-3: the college attendance register.
 *
 * ca-0 stated WHO may read and mark (`src/lib/college-attendance-access.ts`), ca-1
 * stated the rules (`src/lib/college-attendance.ts`: the derived id, the slot, the
 * four statuses, the APPROVED roster, the new-absence rule), ca-2 registered the
 * collection — this verifier proves the API that joins them.
 *
 * OFFLINE half (no emulator, no app): the pure modules are IMPORTED and exercised,
 * and the tree is read as text to pin
 *   • the guard order in BOTH route files (session → target tenant →
 *     `requireCollege` → the ca-0 allow-list → …), including the write guard on
 *     the save and the branch/tenant confinement answering 404, never 403;
 *   • the save's identity: the derived `ca_…` id, `upsert({ where: { id } })`,
 *     ONE `$transaction`, and validation of every row BEFORE that transaction;
 *   • `UNMARKED` is skipped, never stored; an unknown status is refused by name;
 *   • the notify rule is the pure `shouldNotifyAbsence`, wired to the existing
 *     guardian path, fire-and-forget, and with no external push;
 *   • the audit action, the cache invalidation, the segment + directory pair, the
 *     `courseAttendance` model having NO `idFor` entry (the id is the caller's),
 *     and that NO composite index is needed or declared.
 *
 * LIVE half (needs the app + the isolation fixture): the whole HTTP surface
 * against the COLLEGE fixture tenant — its own students/registrations are created
 * raw and deleted again, so the fixture's rows are never mutated. It proves the
 * roster read, the save's idempotence, the slot-in-the-key, the atomic refusal of
 * a mixed request, the unapproved-student refusal, the empty-roster course, the
 * role matrix, tenant + branch confinement, the per-student history, and the
 * "only a NEW absence notifies" rule against REAL notification rows — every
 * mutation bracketed by document counts and everything created deleted on the way
 * out.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-course-attendance.mjs
 * Needs the isolation fixture:  node scripts/isolation-fixture.mjs create
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { requireEmulator } from "./lib/guard.mjs";
import { installHostFetch } from "./lib/hostfetch.mjs";

installHostFetch();
requireEmulator();

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(ROOT, p), "utf8");

/*
 * The app compiles with bundler-style resolution; Node's ESM resolver wants the
 * extension. Retry a failed relative specifier with `.ts` appended, exactly as
 * the sibling verifiers do — so the probes below run against the REAL modules.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (error?.code === "ERR_MODULE_NOT_FOUND" && relative) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const pure = await import("../src/lib/college-attendance.ts");
const access = await import("../src/lib/college-attendance-access.ts");

let checks = 0;
let failures = 0;
const ok = (msg) => {
  checks += 1;
  console.log(`  ✅ ${msg}`);
};
const bad = (scope, msg) => {
  checks += 1;
  failures += 1;
  console.log(`  ❌ [${scope}] ${msg}`);
};
const yes = (scope, label, condition, detail = "") => {
  if (condition) ok(`${label}${detail ? ` — ${detail}` : ""}`);
  else bad(scope, `${label}${detail ? ` — ${detail}` : ""}`);
};

/** Blank out comments ONLY, so a text pin reads CODE (string literals included). */
function stripComments(text) {
  const out = text.split("");
  const blank = (i) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") blank(i++);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      blank(i++);
      blank(i++);
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Blank out comments AND string literals, so a text pin reads CODE only. */
function maskCommentsAndStrings(text) {
  const out = text.split("");
  const blank = (i) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") blank(i++);
      continue;
    }
    if (ch === "/" && next === "*") {
      blank(i++);
      blank(i++);
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      blank(i++);
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") blank(i++);
        blank(i++);
      }
      blank(i++);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

console.log("=== Phase 8 ca-3 — college attendance register (API + live) ===");

/* ------------------------------------------------- 1. the rules, imported */

console.log("\n1. the imported rules the routes must apply (ca-1's module, executed here)");
{
  const id = pure.courseAttendanceId("zziso-col-course-a", "2026-10-14", 2, "s1");
  yes(
    "id",
    "the derived id is `ca_` + course + dateKey + slot + student",
    id === "ca_zziso-col-course-a_2026-10-14_2_s1",
    id
  );
  yes(
    "id",
    "an absent slot is 1 and a present-but-invalid slot throws (never a shared id)",
    pure.courseAttendanceId("c", "2026-10-14", undefined, "s") === "ca_c_2026-10-14_1_s" &&
      (() => {
        try {
          pure.courseAttendanceId("c", "2026-10-14", "2.5", "s");
          return false;
        } catch {
          return true;
        }
      })()
  );
  yes(
    "roster",
    "an APPROVED registration is on the roster and a PENDING one is not (D-CA-2)",
    pure.approvedRosterStudentIds([
      { studentId: "s1", status: "APPROVED" },
      { studentId: "s2", status: "PENDING" },
    ]).join() === "s1"
  );
  yes(
    "notify",
    "only a NEW absence notifies — an already-ABSENT row and any non-ABSENT next status stay quiet",
    pure.shouldNotifyAbsence("PRESENT", "ABSENT") === true &&
      pure.shouldNotifyAbsence("ABSENT", "ABSENT") === false &&
      pure.shouldNotifyAbsence("ABSENT", "LATE") === false &&
      pure.shouldNotifyAbsence(undefined, "PRESENT") === false
  );
  yes(
    "status",
    "the stored vocabulary is exactly the four statuses, and UNMARKED is never a stored status",
    pure.COURSE_ATTENDANCE_STATUSES.join() === "PRESENT,ABSENT,LATE,LEAVE" &&
      !pure.isCourseAttendanceStatus(pure.COURSE_ATTENDANCE_UNMARKED)
  );
  yes(
    "access",
    "the allow-lists are ca-0's: admin-level writes, admin-level + REGISTRAR reads",
    access.COLLEGE_ATTENDANCE_WRITE_ROLES.join() === "SUPER_ADMIN,SCHOOL_ADMIN,BRANCH_ADMIN" &&
      access.COLLEGE_ATTENDANCE_READ_ROLES.join() === "SUPER_ADMIN,SCHOOL_ADMIN,BRANCH_ADMIN,REGISTRAR"
  );
}

/* --------------------------------------------------- 2. the route, as text */

console.log("\n2. the API tree — guard order, derived id, one transaction, validation first");
const ROUTE = read("src/app/api/course-attendance/route.ts");
const HISTORY = read("src/app/api/course-attendance/history/route.ts");
const SERVER = read("src/lib/college-attendance-server.ts");
const routeCode = stripComments(ROUTE);
const historyCode = stripComments(HISTORY);
const serverCode = stripComments(SERVER);
{
  // The guard order, in CODE only: a comment naming the order cannot satisfy it.
  const handlers = [
    { method: "GET", allow: "requireCollegeAttendanceRead(session)" },
    { method: "POST", allow: "requireCollegeAttendanceWrite(session)" },
  ].map(({ method, allow }) => ({
    method,
    allow,
    body: routeCode.slice(
      routeCode.indexOf(`export async function ${method}`),
      method === "GET" ? routeCode.indexOf("export async function POST") : routeCode.length
    ),
  }));
  const gateProblems = [];
  for (const { method, allow, body } of handlers) {
    const sessionAt = body.indexOf("getSession()");
    const gateAt = body.indexOf("requireCollege(");
    const obey = /const gate = await requireCollege\(\{ schoolId \}\);[\s\S]{0,80}?if \(gate\) return gate;/.test(body);
    if (sessionAt < 0 || gateAt < 0 || sessionAt > gateAt) gateProblems.push(`${method}: session/gate order`);
    if (!obey) gateProblems.push(`${method}: gate not obeyed`);
    if (body.indexOf(allow) < 0) gateProblems.push(`${method}: no ca-0 allow-list (${allow})`);
  }
  yes(
    "gate order",
    "the register route gates session → tenant → requireCollege → ca-0's rule in both handlers (READ on GET, WRITE on POST), and obeys the gate",
    gateProblems.length === 0,
    gateProblems.join(" · ") || "GET + POST"
  );

  const writeAllow = routeCode.indexOf("requireCollegeAttendanceWrite(session)");
  const writeGuardAt = routeCode.indexOf("writeGuard(schoolId)");
  // The CALL site in the save, not the import at the top of the file.
  const rosterAt = routeCode.lastIndexOf("approvedRosterFor(schoolId, courseId)");
  yes(
    "write gate",
    "the save is gated by the WRITE allow-list and the subscription writeGuard, both before the roster read",
    writeAllow > 0 && writeGuardAt > writeAllow && rosterAt > writeGuardAt,
    `allow=${writeAllow} writeGuard=${writeGuardAt} roster=${rosterAt}`
  );

  yes(
    "roster",
    "the rosters come from the ca-1 reader (one machine decides who may be marked and who may be billed)",
    /approvedRosterStudentIds\(registrations\)/.test(serverCode) &&
      /prisma\.courseRegistration\.findMany\(\{[\s\S]{0,120}?schoolId, courseId/.test(serverCode)
  );

  yes(
    "id",
    "the save derives the row id from the pure module and upserts THAT id (a re-save is one row)",
    /courseAttendanceId\(courseId, when\.dateKey, slot, row\.studentId\)/.test(routeCode) &&
      /upsert\(\{[\s\S]{0,120}?where: \{ id: row\.id \}/.test(routeCode)
  );
  const validateFrom = routeCode.indexOf("const rosterSet = new Set(studentIds);");
  const txAt = routeCode.indexOf("await prisma.$transaction(");
  const validateBlock =
    validateFrom >= 0 && txAt > validateFrom ? routeCode.slice(validateFrom, txAt) : "";
  yes(
    "atomic",
    "every row is validated in the loop between the roster and the ONE `$transaction` — refusal by name, writes after",
    /for \(const raw of body\.rows\)/.test(validateBlock) &&
      validateBlock.includes("COURSE_ATTENDANCE_ROSTER_REFUSAL") &&
      validateBlock.includes("COURSE_ATTENDANCE_STATUS_REFUSAL") &&
      validateBlock.includes("DUPLICATE_STUDENT") &&
      /await prisma\.\$transaction\(/.test(routeCode) &&
      routeCode.indexOf("courseAttendance.upsert(") > txAt,
    `validation=[${validateFrom},${txAt}) transaction=${txAt}`
  );
  yes(
    "status",
    "UNMARKED is skipped (never stored) and an unknown status is refused, not defaulted",
    /status === COURSE_ATTENDANCE_UNMARKED\) continue/.test(routeCode) &&
      /isCourseAttendanceStatus\(status\)/.test(routeCode)
  );
  yes(
    "isolation",
    "a foreign or another branch's course is NOT FOUND (404), never a 403 that confirms it",
    /canAccessBranch\(session, course\.branchId\)\) \{\s*return NextResponse\.json\(\{ error: "Course not found" \}, \{ status: 404 \}\)/.test(
      routeCode
    ) &&
      /canAccessBranch\(session, course\.branchId\)\) \{\s*return NextResponse\.json\(\{ error: "Course not found" \}, \{ status: 404 \}\)/.test(
        historyCode
      ) &&
      /canAccessBranch\(session, student\.branchId\)\) \{\s*return NextResponse\.json\(\{ error: "Student not found" \}, \{ status: 404 \}\)/.test(
        historyCode
      )
  );

  const notifyAt = routeCode.indexOf("notifyGuardianOfStudent(schoolId, studentId");
  yes(
    "notify",
    "the notify decision is the pure rule, wired to the existing guardian path and fire-and-forget",
    /shouldNotifyAbsence\(stored\.get\(row\.studentId\)\?\.status, row\.status\)/.test(routeCode) &&
      notifyAt > 0 &&
      /notifyGuardianOfStudent\(schoolId, studentId,[\s\S]{0,800}?\)\.catch\(\(\) => null\)/.test(routeCode) &&
      !/push: true/.test(routeCode)
  );
  yes(
    "audit",
    "the save audits by name and invalidates the caches the school's own register invalidates",
    /audit\("COURSE_ATTENDANCE_SAVE"/.test(routeCode) &&
      /invalidateStats\(schoolId, "attendance"\)/.test(routeCode) &&
      /invalidateReferenceCache\(schoolId\)/.test(routeCode)
  );
  yes(
    "history",
    "the history read serves rows in session order and reads rows only",
    /\.sort\(\(a, b\) => a\.dateKey\.localeCompare\(b\.dateKey\) \|\| a\.slot - b\.slot\)/.test(historyCode) &&
      !/upsert|create\(|update\(/.test(historyCode) &&
      /prisma\.courseAttendance\.findMany\(\{[\s\S]{0,120}?schoolId, courseId, studentId/.test(historyCode)
  );
  const roleFree = (text) => !/SUPER_ADMIN|SCHOOL_ADMIN|BRANCH_ADMIN|REGISTRAR/.test(maskCommentsAndStrings(text));
  yes(
    "allow-list",
    "both routes apply the ONE server wrapper for the allow-list (no re-stated role list)",
    /canReadCollegeAttendance/.test(serverCode) &&
      /canWriteCollegeAttendance/.test(serverCode) &&
      roleFree(ROUTE) &&
      roleFree(HISTORY)
  );
  yes(
    "refusals",
    "the wrappers answer ca-0's own refusal sentences",
    /COLLEGE_ATTENDANCE_READ_REFUSAL/.test(serverCode) && /COLLEGE_ATTENDANCE_WRITE_REFUSAL/.test(serverCode)
  );
}

/* ------------------------------------------- 3. the model, the segment, indexes */

console.log("\n3. the collection, the segment + directory pair, and the index question");
const dbText = read("src/lib/db.ts");
{
  const idFor = dbText.slice(dbText.indexOf("function idFor("), dbText.indexOf("function idForCreate("));
  yes(
    "id",
    "the model still has NO `idFor` entry — the save's derived id is the identity, not a store rule",
    idFor.length > 0 && !/courseAttendance/.test(idFor),
    /courseAttendance/.test(idFor) ? "an idFor entry appeared — ca-2's decision was changed" : "the derived id stays the caller's"
  );

  const segments = (await import("../src/lib/college-routes.ts")).COLLEGE_API_SEGMENTS;
  const listed = [...segments].includes("course-attendance");
  const dirHere = existsSync(resolve(ROOT, "src/app/api/course-attendance/route.ts"));
  yes(
    "segment",
    "`course-attendance` is listed AND its directory exists — ca-2's deferral landed with the routes (the guard's own rule)",
    listed && dirHere,
    `listed=${listed} directory=${dirHere}`
  );

  // The fees proof's segment pin names this segment too, so the two proofs agree
  // on the list rather than one being re-scoped and the other left behind.
  const feesProof = read("scripts/verify-college-fees-data.mjs");
  const laterList = /const laterSegments = \[([^\]]*)\]/.exec(feesProof)?.[1] || "";
  yes(
    "segment",
    "verify-college-fees-data's re-scoped segment pin lists both later segments",
    laterList.includes('"college-fees"') && laterList.includes('"course-attendance"'),
    laterList.trim() || "laterSegments not located"
  );

  const indexes = read("firestore.indexes.json");
  yes(
    "index",
    "NO composite index is declared for the collection — every query is scalar equality, the session filter is in memory",
    !/courseAttendan/i.test(indexes),
    "firestore.indexes.json names no courseAttendance field"
  );
}

/* ------------------------------------------------------------ 4. LIVE HTTP */

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
for (const key of ["collegeAdmin", "collegeBranchAdmin", "collegeRegistrar", "collegeAccountant", "admin", "bothAdmin", "bothTeacher", "bothGuardian", "bothStudent"]) {
  if (!CRED[key]) {
    console.error(`❌ Track file lacks the \`${key}\` credential — re-run: node scripts/isolation-fixture.mjs clean && create`);
    process.exit(1);
  }
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

/* AGENTS.md RULE 1: an app host serves ONLY its own sector. The college roles are
 * SCHOOL-sector accounts, so they sign in on `school.localhost`; a TEACHER signs
 * in on the Teacher App host, a GUARDIAN on the Parents App host, and the hub
 * serves every account — which is where the refused roles sign in and then address
 * the API. */
const HOST = `school.localhost:${PORT}`;
const HUB_HOST = `127.0.0.1:${PORT}`;
const TEACHER_HOST = `teacher.localhost:${PORT}`;
const PARENTS_HOST = `parents.localhost:${PORT}`;
async function req(path, { cookie, host = HOST, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Host: host, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null, raw: body };
}
async function login(email, password, host = HOST) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(60000),
  });
  if (res.status !== 200) throw new Error(`login ${email}: HTTP ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
const get = (path, cookie, opts = {}) => req(path, { cookie, ...opts });
const post = (path, body, cookie, opts = {}) => req(path, { cookie, method: "POST", body: JSON.stringify(body), ...opts });

const collegeAdmin = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
const collegeBranchAdmin = await login("zz-iso-college-br-admin@test.local", CRED.collegeBranchAdmin);
const collegeRegistrar = await login("zz-iso-college-registrar@test.local", CRED.collegeRegistrar);
const collegeAccountant = await login("zz-iso-college-accountant@test.local", CRED.collegeAccountant);
const schoolAdmin = await login("zz-iso-admin@test.local", CRED.admin);
/* The platform SUPER_ADMIN — the one admitted role the fixture does not mint (it
 * is a platform account, not a tenant account). Its credentials are the seeded
 * demo ones, read from the module the sign-in screen uses: no password is
 * written into this verifier. */
const demoSuper = (await import("../src/lib/demo-accounts.ts")).DEMO_ACCOUNTS.find(
  (a) => a.role === "Super Admin"
);
const superAdmin = demoSuper ? await login(demoSuper.id, demoSuper.pw, HUB_HOST) : null;
const bothTeacher = await login("zz-iso-both-teacher@test.local", CRED.bothTeacher, TEACHER_HOST);
const bothGuardian = await login("zz-iso-both-guardian@test.local", CRED.bothGuardian, PARENTS_HOST);
const bothStudent = await login("zz-iso-both-student@test.local", CRED.bothStudent, HUB_HOST);

const COLLEGE = `${P}college`;
const BRANCH_A = `${P}col-br-a`;
const BRANCH_B = `${P}col-br-b`;
const COURSE_A = `${P}col-course-a`;
const COURSE_B = `${P}col-course-b`;
const PROG_A = `${P}col-prog-a`;
const FOREIGN_COURSE = `${P}both-course`;
const FOREIGN_STUDENT = `${P}both-stu`;
const SESSION_DATE = "2026-10-14";
const stamp = Date.now();

/** Every document this run creates, so teardown is exact. */
const created = { users: [], students: [], registrations: [], attendance: [] };
const mark = (bucket, id) => created[bucket].push(id);

const attendancePath = (extra = "") => `/api/course-attendance${extra}`;

console.log("\n4. LIVE — the register over HTTP, against the COLLEGE fixture tenant");

const countAttendance = async () => (await db.collection("courseAttendances").get()).size;
const before = await countAttendance();
if (before !== 0) {
  console.log(
    `  ⚠️  the collection already holds ${before} row(s) before this run — the run is bracketed against that number`
  );
}

/** The run's own guardian + students, created raw so the fixture's rows are never touched. */
const guardianUserId = `zzcta-guard-${stamp}`;
const studentP = `zzcta-stu-p-${stamp}`;
const studentU = `zzcta-stu-u-${stamp}`;
const regP = `zzcta-reg-p-${stamp}`;
const regU = `zzcta-reg-u-${stamp}`;
const rowKeys = {
  slot1: pure.courseAttendanceId(COURSE_A, SESSION_DATE, 1, studentP),
  slot2: pure.courseAttendanceId(COURSE_A, SESSION_DATE, 2, studentP),
  studentU: pure.courseAttendanceId(COURSE_A, SESSION_DATE, 1, studentU),
};

const notificationCount = async () => {
  const snap = await db.collection("notifications").where("userId", "==", guardianUserId).get();
  return snap.size;
};

try {
  await db.collection("users").doc(guardianUserId).set({
    email: `${guardianUserId}@test.local`,
    name: "ZZ CTA Guardian",
    role: "GUARDIAN",
    schoolId: COLLEGE,
    active: true,
  });
  mark("users", guardianUserId);
  for (const [id, name, withGuardian] of [
    [studentP, "ZZ CTA Student Present", true],
    [studentU, "ZZ CTA Student Unapproved", false],
  ]) {
    await db.collection("students").doc(id).set({
      schoolId: COLLEGE,
      branchId: BRANCH_A,
      name,
      admissionNo: `ZZCTA-${id.slice(-4)}`,
      programId: PROG_A,
      termNumber: 1,
      active: true,
      ...(withGuardian ? { guardianUserId } : {}),
      createdAt: new Date().toISOString(),
    });
    mark("students", id);
  }
  for (const [id, studentId, status] of [
    [regP, studentP, "APPROVED"],
    [regU, studentU, "PENDING"],
  ]) {
    await db.collection("courseRegistrations").doc(id).set({
      schoolId: COLLEGE,
      branchId: BRANCH_A,
      studentId,
      courseId: COURSE_A,
      programId: PROG_A,
      termNumber: 1,
      status,
      requestedById: `${P}user-col-admin`,
      decidedById: status === "APPROVED" ? `${P}user-col-admin` : null,
      decidedAt: status === "APPROVED" ? new Date().toISOString() : null,
      createdAt: new Date().toISOString(),
    });
    mark("registrations", id);
  }

  /* ---------------------------------------------------------- the roster read */

  const roster = await get(`${attendancePath()}?courseId=${COURSE_A}&date=${SESSION_DATE}`, collegeAdmin);
  const rosterIds = (roster.data?.rows || []).map((r) => r.studentId);
  yes(
    "roster",
    "the register lists the APPROVED roster only — the run's approved student in, its PENDING student and the fixture's unapproved ones out",
    roster.status === 200 &&
      rosterIds.length === 1 &&
      rosterIds[0] === studentP &&
      roster.data.rows[0].status === "UNMARKED" &&
      roster.data.summary.total === 1 &&
      roster.data.summary.unmarked === 1 &&
      roster.data.slot === 1 &&
      roster.data.dateKey === SESSION_DATE,
    `HTTP ${roster.status} rows=[${rosterIds.join(", ")}] summary=${JSON.stringify(roster.data?.summary)}`
  );

  const emptyRoster = await get(`${attendancePath()}?courseId=${COURSE_B}&date=${SESSION_DATE}`, collegeAdmin);
  yes(
    "roster",
    "a course with NO approved registrations reads an empty register (no invented rows)",
    emptyRoster.status === 200 && (emptyRoster.data?.rows || []).length === 0 && emptyRoster.data?.summary?.total === 0,
    `HTTP ${emptyRoster.status} rows=${(emptyRoster.data?.rows || []).length}`
  );

  /* ------------------------------------------------------- the save + upsert */

  const saved = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, rows: [{ studentId: studentP, status: "PRESENT", remark: "first" }] }, collegeAdmin);
  const afterSave = await countAttendance();
  const stored1 = (await db.collection("courseAttendances").doc(rowKeys.slot1).get()).data();
  yes(
    "save",
    "the save writes ONE row at the derived id, stamped with the course's branch, the registration and the actor",
    saved.status === 200 &&
      saved.data?.written === 1 &&
      afterSave === before + 1 &&
      stored1 &&
      stored1.studentId === studentP &&
      stored1.status === "PRESENT" &&
      stored1.branchId === BRANCH_A &&
      stored1.programId === PROG_A &&
      stored1.termNumber === 1 &&
      stored1.registrationId === regP &&
      stored1.slot === 1 &&
      !!stored1.markedById,
    `HTTP ${saved.status} rows ${before}→${afterSave} id=${rowKeys.slot1}`
  );

  const marked = await get(`${attendancePath()}?courseId=${COURSE_A}&date=${SESSION_DATE}`, collegeAdmin);
  yes(
    "save",
    "the register read then shows the stored status (PRESENT), not UNMARKED",
    marked.status === 200 &&
      marked.data?.rows?.[0]?.status === "PRESENT" &&
      marked.data?.summary?.present === 1 &&
      marked.data?.rows?.[0]?.remark === "first",
    `HTTP ${marked.status} status=${marked.data?.rows?.[0]?.status}`
  );

  const absent = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, rows: [{ studentId: studentP, status: "ABSENT", remark: "sick" }] }, collegeAdmin);
  const afterAbsent = await countAttendance();
  const notificationsAfterAbsent = await notificationCount();
  const notif = (
    await db.collection("notifications").where("userId", "==", guardianUserId).get()
  ).docs.map((d) => d.data())[0];
  yes(
    "save",
    "a re-save upserts the SAME row (count unchanged) and a NEW absence notifies the guardian once",
    absent.status === 200 &&
      absent.data?.newlyAbsent?.join() === studentP &&
      afterAbsent === before + 1 &&
      notificationsAfterAbsent === 1 &&
      notif?.event === "ATTENDANCE_PUBLISHED" &&
      String(notif?.body || "").includes("slot 1") &&
      String(notif?.body || "").includes("ZZ Iso College Course A"),
    `HTTP ${absent.status} newlyAbsent=[${absent.data?.newlyAbsent?.join(",")}] rows ${afterAbsent} notifications ${notificationsAfterAbsent}`
  );

  const absentAgain = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, rows: [{ studentId: studentP, status: "ABSENT", remark: "sick" }] }, collegeAdmin);
  const notificationsAfterRepeat = await notificationCount();
  yes(
    "save",
    "a re-saved absence does NOT re-mail the family (no new notification row, still one row)",
    absentAgain.status === 200 &&
      (absentAgain.data?.newlyAbsent || []).length === 0 &&
      (await countAttendance()) === before + 1 &&
      notificationsAfterRepeat === notificationsAfterAbsent,
    `newlyAbsent=[${absentAgain.data?.newlyAbsent?.join(",")}] notifications ${notificationsAfterAbsent}→${notificationsAfterRepeat}`
  );

  const corrected = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, rows: [{ studentId: studentP, status: "LATE" }] }, collegeAdmin);
  const storedCorrected = (await db.collection("courseAttendances").doc(rowKeys.slot1).get()).data();
  yes(
    "save",
    "correcting ABSENT to LATE stores the correction and stays quiet",
    corrected.status === 200 &&
      (corrected.data?.newlyAbsent || []).length === 0 &&
      storedCorrected?.status === "LATE" &&
      (await notificationCount()) === notificationsAfterAbsent,
    `status=${storedCorrected?.status} newlyAbsent=[${corrected.data?.newlyAbsent?.join(",")}]`
  );

  /* --------------------------------------- whole-request validation precedes writes */

  const mixed = await post(
    attendancePath(),
    {
      courseId: COURSE_A,
      date: SESSION_DATE,
      rows: [
        { studentId: studentP, status: "ABSENT" },
        { studentId: FOREIGN_STUDENT, status: "PRESENT" },
      ],
    },
    collegeAdmin
  );
  const storedAfterMixed = (await db.collection("courseAttendances").doc(rowKeys.slot1).get()).data();
  yes(
    "atomic",
    "a request with one off-roster student is refused WHOLE — the valid row in it is not written either",
    mixed.status === 400 &&
      mixed.error === pure.COURSE_ATTENDANCE_ROSTER_REFUSAL &&
      storedAfterMixed?.status === "LATE" &&
      (await countAttendance()) === before + 1 &&
      (await notificationCount()) === notificationsAfterAbsent,
    `HTTP ${mixed.status} stored=${storedAfterMixed?.status} rows=${await countAttendance()}`
  );

  const junkStatus = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, rows: [{ studentId: studentP, status: "EXCUSED" }] }, collegeAdmin);
  yes(
    "atomic",
    "an unknown status is refused by name before any write",
    junkStatus.status === 400 &&
      junkStatus.error === pure.COURSE_ATTENDANCE_STATUS_REFUSAL &&
      (await db.collection("courseAttendances").doc(rowKeys.slot1).get()).data()?.status === "LATE",
    `HTTP ${junkStatus.status} ${junkStatus.error || ""}`
  );

  const duplicated = await post(
    attendancePath(),
    {
      courseId: COURSE_A,
      date: SESSION_DATE,
      rows: [
        { studentId: studentP, status: "PRESENT" },
        { studentId: studentP, status: "ABSENT" },
      ],
    },
    collegeAdmin
  );
  yes(
    "atomic",
    "a student named twice is refused — two statuses for one pupil are not a register",
    duplicated.status === 400 && (await countAttendance()) === before + 1,
    `HTTP ${duplicated.status} ${duplicated.error || ""}`
  );

  const unapproved = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, rows: [{ studentId: studentU, status: "PRESENT" }] }, collegeAdmin);
  const unapprovedRow = (await db.collection("courseAttendances").doc(rowKeys.studentU).get()).exists;
  yes(
    "atomic",
    "a student with only a PENDING registration is refused and nothing is written for them",
    unapproved.status === 400 &&
      unapproved.error === pure.COURSE_ATTENDANCE_ROSTER_REFUSAL &&
      unapprovedRow === false,
    `HTTP ${unapproved.status} rowWritten=${unapprovedRow}`
  );

  /* -------------------------------------------------------------------- slot */

  const slot2 = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, slot: 2, rows: [{ studentId: studentP, status: "ABSENT" }] }, collegeAdmin);
  const roster2 = await get(`${attendancePath()}?courseId=${COURSE_A}&date=${SESSION_DATE}&slot=2`, collegeAdmin);
  const notificationsAfterSlot2 = await notificationCount();
  yes(
    "slot",
    "the slot is IN the key: a second session the same day is a SECOND row, its own register, and its own new-absence notify",
    slot2.status === 200 &&
      (await countAttendance()) === before + 2 &&
      (await db.collection("courseAttendances").doc(rowKeys.slot2).get()).data()?.slot === 2 &&
      roster2.data?.slot === 2 &&
      roster2.data?.rows?.[0]?.status === "ABSENT" &&
      notificationsAfterSlot2 === notificationsAfterAbsent + 1,
    `HTTP ${slot2.status} rows=${await countAttendance()} slot2=${roster2.data?.rows?.[0]?.status} notifications ${notificationsAfterAbsent}→${notificationsAfterSlot2}`
  );
  const slot1Still = await get(`${attendancePath()}?courseId=${COURSE_A}&date=${SESSION_DATE}`, collegeAdmin);
  yes(
    "slot",
    "the default slot's register is untouched by the slot-2 save (still LATE)",
    slot1Still.data?.rows?.[0]?.status === "LATE",
    `slot1=${slot1Still.data?.rows?.[0]?.status}`
  );

  const junkSlot = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, slot: "2.5", rows: [{ studentId: studentP, status: "PRESENT" }] }, collegeAdmin);
  const junkDate = await post(attendancePath(), { courseId: COURSE_A, date: "not-a-date", rows: [{ studentId: studentP, status: "PRESENT" }] }, collegeAdmin);
  const noCourse = await post(attendancePath(), { date: SESSION_DATE, rows: [{ studentId: studentP, status: "PRESENT" }] }, collegeAdmin);
  yes(
    "refusals",
    "a junk slot, a junk date and a missing course are counted 400s that name the rule",
    junkSlot.status === 400 &&
      junkSlot.error === pure.COURSE_ATTENDANCE_SLOT_REFUSAL &&
      junkDate.status === 400 &&
      noCourse.status === 400 &&
      (await countAttendance()) === before + 2,
    `slot=${junkSlot.status} date=${junkDate.status} course=${noCourse.status}`
  );

  /* --------------------------------------------------- tenant + branch + roles */

  const ghostCourse = await get(`${attendancePath()}?courseId=zz-ghost-course&date=${SESSION_DATE}`, collegeAdmin);
  const foreignCourse = await get(`${attendancePath()}?courseId=${FOREIGN_COURSE}&date=${SESSION_DATE}`, collegeAdmin);
  const foreignSave = await post(attendancePath(), { courseId: FOREIGN_COURSE, date: SESSION_DATE, rows: [{ studentId: FOREIGN_STUDENT, status: "PRESENT" }] }, collegeAdmin);
  yes(
    "isolation",
    "a ghost course and ANOTHER tenant's course both answer 404 — never a 403 that would confirm the row exists",
    ghostCourse.status === 404 && foreignCourse.status === 404 && foreignSave.status === 404,
    `ghost=${ghostCourse.status} foreign=${foreignCourse.status} foreignSave=${foreignSave.status}`
  );

  const superRead = superAdmin
    ? await get(`${attendancePath()}?schoolId=${COLLEGE}&courseId=${COURSE_A}&date=${SESSION_DATE}`, superAdmin, { host: HUB_HOST })
    : { status: 0 };
  const superWrite = superAdmin
    ? await post(
        `${attendancePath()}?schoolId=${COLLEGE}`,
        { courseId: COURSE_A, date: SESSION_DATE, slot: 4, rows: [{ studentId: studentP, status: "PRESENT" }] },
        superAdmin,
        { host: HUB_HOST }
      )
    : { status: 0 };
  mark("attendance", pure.courseAttendanceId(COURSE_A, SESSION_DATE, 4, studentP));
  yes(
    "matrix",
    "the platform SUPER_ADMIN reaches a NAMED tenant's register with ?schoolId= and may mark it (read 200, write 200)",
    superRead.status === 200 && superWrite.status === 200,
    `read=${superRead.status} write=${superWrite.status}`
  );

  const branchOtherCourse = await get(`${attendancePath()}?courseId=${COURSE_B}&date=${SESSION_DATE}`, collegeBranchAdmin);
  const branchOwnCourse = await get(`${attendancePath()}?courseId=${COURSE_A}&date=${SESSION_DATE}`, collegeBranchAdmin);
  const branchOwnSave = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, slot: 3, rows: [{ studentId: studentP, status: "PRESENT" }] }, collegeBranchAdmin);
  mark("attendance", pure.courseAttendanceId(COURSE_A, SESSION_DATE, 3, studentP));
  const branchOtherHistory = await get(`${attendancePath()}/history?courseId=${COURSE_A}&studentId=${P}col-stu-b`, collegeBranchAdmin);
  yes(
    "branch",
    "a BRANCH_ADMIN reaches its own branch's course and is NOT FOUND for another branch's course or student",
    branchOtherCourse.status === 404 &&
      branchOwnCourse.status === 200 &&
      branchOwnSave.status === 200 &&
      branchOtherHistory.status === 404,
    `otherCourse=${branchOtherCourse.status} ownCourse=${branchOwnCourse.status} ownSave=${branchOwnSave.status} otherStudent=${branchOtherHistory.status}`
  );

  const registrarRead = await get(`${attendancePath()}?courseId=${COURSE_A}&date=${SESSION_DATE}`, collegeRegistrar);
  const registrarWrite = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, rows: [{ studentId: studentP, status: "PRESENT" }] }, collegeRegistrar);
  yes(
    "matrix",
    "the REGISTRAR reads (200) and is refused marking (403) with ca-0's write refusal",
    registrarRead.status === 200 &&
      registrarWrite.status === 403 &&
      registrarWrite.error === access.COLLEGE_ATTENDANCE_WRITE_REFUSAL,
    `HTTP read=${registrarRead.status} write=${registrarWrite.status}`
  );

  const refusedRoles = [
    ["ACCOUNTANT", collegeAccountant, HOST],
    ["TEACHER", bothTeacher, HUB_HOST],
    ["GUARDIAN", bothGuardian, HUB_HOST],
    ["STUDENT", bothStudent, HUB_HOST],
  ];
  const roleResults = [];
  for (const [label, cookie, host] of refusedRoles) {
    const readRes = await get(`${attendancePath()}?courseId=${COURSE_A}&date=${SESSION_DATE}`, cookie, { host });
    const writeRes = await post(attendancePath(), { courseId: COURSE_A, date: SESSION_DATE, rows: [{ studentId: studentP, status: "PRESENT" }] }, cookie, { host });
    roleResults.push(`${label}:${readRes.status}/${writeRes.status}`);
  }
  yes(
    "matrix",
    "ACCOUNTANT, TEACHER, GUARDIAN and STUDENT are all 403 on read AND write (v1 is staff-only)",
    roleResults.every((r) => r.endsWith("403/403")),
    roleResults.join(" ")
  );

  const schoolOnCollege = await get(`${attendancePath()}?courseId=${COURSE_A}&date=${SESSION_DATE}`, schoolAdmin);
  const anonymous = await req(`${attendancePath()}?courseId=${COURSE_A}&date=${SESSION_DATE}`, { host: HOST });
  yes(
    "isolation",
    "a SCHOOL tenant's admin is refused by the college gate (403, no data) and no session is 401",
    schoolOnCollege.status === 403 && schoolOnCollege.data === null && anonymous.status === 401,
    `school=${schoolOnCollege.status} anonymous=${anonymous.status}`
  );

  /* -------------------------------------------------------------- the history */

  const history = await get(`${attendancePath()}/history?courseId=${COURSE_A}&studentId=${studentP}`, collegeAdmin);
  const historyRows = history.data?.rows || [];
  yes(
    "history",
    "the per-student history serves every session in (date, slot) order with its stored status",
    history.status === 200 &&
      history.data?.count === 4 &&
      historyRows.map((r) => `${r.dateKey}#${r.slot}:${r.status}`).join(" ") ===
        [
          `${SESSION_DATE}#1:LATE`,
          `${SESSION_DATE}#2:ABSENT`,
          `${SESSION_DATE}#3:PRESENT`,
          `${SESSION_DATE}#4:PRESENT`,
        ].join(" "),
    `HTTP ${history.status} rows=${historyRows.map((r) => `${r.slot}:${r.status}`).join(",")}`
  );
  const historyGhost = await get(`${attendancePath()}/history?courseId=${COURSE_A}&studentId=zz-ghost-student`, collegeAdmin);
  const historyForeign = await get(`${attendancePath()}/history?courseId=${COURSE_A}&studentId=${FOREIGN_STUDENT}`, collegeAdmin);
  yes(
    "history",
    "a ghost student and another tenant's student are the SAME 404",
    historyGhost.status === 404 && historyForeign.status === 404,
    `ghost=${historyGhost.status} foreign=${historyForeign.status}`
  );

  const afterAllWrites = await countAttendance();
  yes(
    "quiescence",
    "the run's writes are exactly the four rows it intended (slots 1–2 as the school admin, slot 3 as the branch admin, slot 4 as the platform super admin)",
    afterAllWrites === before + 4,
    `rows ${before} → ${afterAllWrites}`
  );
} finally {
  for (const id of created.attendance) await db.collection("courseAttendances").doc(id).delete().catch(() => {});
  // A sweep of the prefix this run owns — a failed write can leave a row behind
  // that never reached `created`.
  const leftovers = await db.collection("courseAttendances").where("schoolId", "==", COLLEGE).get();
  for (const doc of leftovers.docs) {
    if (created.attendance.includes(doc.id)) continue;
    if (String(doc.data()?.studentId || "").startsWith("zzcta-")) await doc.ref.delete().catch(() => {});
  }
  for (const id of created.registrations) await db.collection("courseRegistrations").doc(id).delete().catch(() => {});
  for (const id of created.students) await db.collection("students").doc(id).delete().catch(() => {});
  for (const id of created.users) await db.collection("users").doc(id).delete().catch(() => {});
  const notes = await db.collection("notifications").where("userId", "==", guardianUserId).get();
  for (const doc of notes.docs) await doc.ref.delete().catch(() => {});
}

const after = await countAttendance();
yes(
  "teardown",
  "every row this run created is gone — the collection is back where it started",
  after === before,
  `rows ${before} → ${after}`
);

console.log(
  failures === 0
    ? `\n✅ COURSE ATTENDANCE OK — ${checks} checks: the roster read, the derived-id upsert, the whole-request atomicity, the slot in the key, the new-absence notify, tenant + branch confinement, the role matrix and the per-student history`
    : `\n❌ verify-course-attendance: ${failures} failure(s) of ${checks} checks`
);
process.exit(failures === 0 ? 0 : 1);
