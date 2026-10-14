#!/usr/bin/env node
/**
 * verify-course-teachers.mjs — Phase 8-pre: the course↔teacher link.
 *
 * Until this step the college could not answer "who teaches this course?":
 * verified by search at `6a7a31f`, no `teacherId` existed anywhere under
 * `src/app/api/courses`, `src/app/api/course-registrations` or
 * `src/lib/college-*.ts`, and `programCourse` was `{schoolId, programId,
 * courseId, termNumber, requirement}` and nothing more (docs/COLLEGE-DECISIONS.md
 * §24.8, D-CA-4; the owner's answer Q8 made the link `8-pre`, the first step of
 * Phase 8). This verifier proves the link end to end.
 *
 * OFFLINE half (no emulator, no app): the pure module is IMPORTED and exercised
 * (`courseTeacherId`, `isAssignableTeacherRole`, `normaliseTeacherIds`), and the
 * tree is read as text to pin
 *   • `COLS.courseTeacher` → `courseTeachers`, exactly once, with NO
 *     `idFor`/`idForCreate` entry (the id is derived by the caller, like
 *     `promotionRun`) — so a re-assign can never mint a second row;
 *   • `RELS.courseTeacher`'s four relations, every fk a STORED field;
 *   • that NO pre-existing RELS body was touched (the `course` and `teacher`
 *     bodies must not name the link — 7b/6b hash those bodies, and a relation
 *     added inside one of them would break their additive proof);
 *   • the API's guard order (session → requireCollege → can → … ), its derived
 *     id, its audit rows, and the course DELETE's new block;
 *   • that the link is COLLEGE-only: `COLLEGE_MODEL_RE` lists it, both additive
 *     data verifiers drop it by name, and no non-college API file reaches for it;
 *   • that `/api/courses` was NOT widened (no nav entry, no payload change).
 *
 * LIVE half (needs the app + the isolation fixture): the whole HTTP surface
 * against the COLLEGE fixture tenant — assign, idempotent re-assign, list, the
 * foreign-teacher and non-teacher refusals, the foreign-course 404, the role
 * matrix (admin-level in, REGISTRAR read-only, ACCOUNTANT/TEACHER/GUARDIAN/
 * STUDENT out), branch confinement, unassign, and the course DELETE blocked
 * while a teacher is still assigned, with document-count brackets around every
 * mutation. It deletes everything it created on the way out.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-course-teachers.mjs
 * Needs the isolation fixture:  node scripts/isolation-fixture.mjs create
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync, readdirSync } from "node:fs";
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
 * extension. Retry a failed relative specifier with `.ts`, exactly as
 * verify-college-gate.mjs and verify-pilot-hardening.mjs do — so the checks below
 * run against the REAL module, not a copy of its rules.
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

const link = await import("../src/lib/course-teachers.ts");

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

console.log("=== Phase 8-pre course↔teacher link ===");

/* ---------------------------------------------------------------- 1. the id */

console.log("\n1. the derived id — one row per pair, the id IS the uniqueness rule");
{
  const { courseTeacherId, COURSE_TEACHER_ID_PREFIX } = link;
  yes("id", "the prefix is `ct_`", COURSE_TEACHER_ID_PREFIX === "ct_", COURSE_TEACHER_ID_PREFIX);
  const id = courseTeacherId("zziso-col-course-a", "t_zziso-user-teacher");
  yes(
    "id",
    "the id is `ct_` + the course id + the teacher id",
    id === "ct_zziso-col-course-a_t_zziso-user-teacher",
    id
  );
  yes(
    "id",
    "the same pair always derives the same id (a re-assign addresses one row)",
    courseTeacherId("c1", "t1") === courseTeacherId("c1", "t1")
  );
  yes(
    "id",
    "a different course or a different teacher is a different row",
    courseTeacherId("c1", "t1") !== courseTeacherId("c2", "t1") &&
      courseTeacherId("c1", "t1") !== courseTeacherId("c1", "t2")
  );
  yes(
    "id",
    "whitespace around either half is trimmed, so ` c1 ` and `c1` are one row",
    courseTeacherId("  c1  ", " t1 ") === courseTeacherId("c1", "t1")
  );
  let threw = 0;
  for (const [a, b] of [["", "t1"], ["c1", ""], [null, "t1"], ["c1", undefined], ["   ", "t1"]]) {
    try {
      courseTeacherId(a, b);
    } catch {
      threw += 1;
    }
  }
  yes(
    "id",
    "an empty half THROWS rather than deriving an id shared by every caller",
    threw === 5,
    `${threw}/5 refused`
  );
}

/* ------------------------------------------------------------ 2. the assignee */

console.log("\n2. the assignee rule — a course is taught by a TEACHER account, and nothing else");
{
  const { isAssignableTeacherRole, COURSE_TEACHER_ASSIGNEE_ROLES } = link;
  yes("assignee", "the allow-list is exactly [TEACHER]", JSON.stringify([...COURSE_TEACHER_ASSIGNEE_ROLES]) === '["TEACHER"]');
  yes("assignee", "TEACHER is assignable", isAssignableTeacherRole("TEACHER") === true);
  const refused = ["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "GUARDIAN", "STUDENT", "SUPER_ADMIN", "", null, undefined, 7, {}];
  const wrong = refused.filter((r) => isAssignableTeacherRole(r) !== false);
  yes(
    "assignee",
    `every other role/absent value is refused (${refused.length} probed)`,
    wrong.length === 0,
    wrong.length ? `accepted ${JSON.stringify(wrong)}` : "none accepted"
  );
}

/* ------------------------------------------------------------- 3. the list rule */

console.log("\n3. the id-list normaliser — duplicates are one teacher, blanks are typos");
{
  const { normaliseTeacherIds } = link;
  yes(
    "list",
    "trims, drops duplicates and blanks, keeps the first-seen order",
    JSON.stringify(normaliseTeacherIds([" t2 ", "t1", "t2", "", "  ", null])) === '["t2","t1"]'
  );
  yes("list", "a non-array is an empty list (never a throw)", JSON.stringify(normaliseTeacherIds(undefined)) === "[]" && JSON.stringify(normaliseTeacherIds("t1")) === "[]");
}

/* ------------------------------------------------------------- 4. the store pins */

/** The text between a start marker and the next top-level `\n};` (an object literal). */
function block(text, startRe) {
  const m = startRe.exec(text);
  if (!m) return null;
  const from = m.index + m[0].length;
  const end = text.indexOf("\n};", from);
  return end === -1 ? text.slice(from) : text.slice(from, end);
}

/**
 * The body of ONE `KEY: { … },` entry inside RELS. `\r?\n` because db.ts is a CRLF
 * file — a literal `\n` after the brace would silently find nothing and turn a
 * real check into a vacuous one.
 */
function relBody(relsText, key) {
  const m = new RegExp(`^  ${key}: \\{\\r?\\n([\\s\\S]*?)^  \\},`, "m").exec(relsText);
  return m ? m[1] : null;
}

/** Blank out comments and string literals, PRESERVING LENGTH (code-only scans). */
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

console.log("\n4. the store — one collection, one relation block, no derived-id entry");
const dbText = read("src/lib/db.ts");
const colsText = block(dbText, /const COLS: Record<string, string> = \{/);
const relsText = block(dbText, /const RELS: Record<string, Record<string, Rel>> = \{/);
const prismaText = block(dbText, /export const prisma = \{/);
{
  const countOf = (haystack, needle) => haystack.split(needle).length - 1;
  yes(
    "collection",
    'COLS maps courseTeacher to "courseTeachers"',
    Boolean(colsText) && /^  courseTeacher: "courseTeachers",$/m.test(colsText),
    colsText ? "" : "the COLS block was not located"
  );
  yes(
    "collection",
    "no second model shares that collection name",
    Boolean(colsText) && countOf(colsText, '"courseTeachers"') === 1,
    colsText ? `${countOf(colsText, '"courseTeachers"')} use(s)` : ""
  );

  const maskedIdFor = maskCommentsAndStrings(
    (() => {
      const m = /function idFor\(model: string, where: Record<string, any>\): string \| undefined \{/.exec(dbText);
      if (!m) return "";
      const from = m.index + m[0].length;
      const end = dbText.indexOf("\n}", from);
      return end === -1 ? dbText.slice(from) : dbText.slice(from, end);
    })()
  );
  const maskedIdForCreate = maskCommentsAndStrings(
    (() => {
      const m = /function idForCreate\(model: string, data: Record<string, any>\): string \| undefined \{/.exec(dbText);
      if (!m) return "";
      const from = m.index + m[0].length;
      const end = dbText.indexOf("\n}", from);
      return end === -1 ? dbText.slice(from) : dbText.slice(from, end);
    })()
  );
  yes(
    "derived-id",
    "neither idFor nor idForCreate has a courseTeacher entry (the caller supplies the id)",
    maskedIdFor.length > 0 &&
      maskedIdForCreate.length > 0 &&
      !maskedIdFor.includes("courseTeacher") &&
      !maskedIdForCreate.includes("courseTeacher")
  );

  const body = relsText ? relBody(relsText, "courseTeacher") : null;
  const relations = body ? [...body.matchAll(/(\w+): \{ to: "(\w+)", (?:fk|via): "(\w+)"/g)].map((m) => ({ key: m[1], to: m[2], field: m[3] })) : [];
  yes(
    "relations",
    "RELS.courseTeacher exists with school/branch/course/teacher, every fk a stored field",
    JSON.stringify(relations.map((r) => r.key)) === '["school","branch","course","teacher"]' &&
      relations.every((r) => ["schoolId", "branchId", "courseId", "teacherId"].includes(r.field)) &&
      relations.every((r) => r.to === r.key),
    relations.map((r) => `${r.key}->${r.to}(${r.field})`).join(" ") || "no block"
  );
  const registered = new Set(
    [...(colsText || "").matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => m[1])
  );
  yes(
    "relations",
    "every relation target is a registered model",
    relations.every((r) => registered.has(r.to)),
    relations.filter((r) => !registered.has(r.to)).map((r) => r.to).join(" ") || "all registered"
  );

  /* The pinned bodies: 6b's and 7b's additive proofs hash EVERY pre-existing RELS
   * body, so 8-pre must add a key, never a relation inside one. */
  const courseBody = relsText ? relBody(relsText, "course") : null;
  const teacherBody = relsText ? relBody(relsText, "teacher") : null;
  yes(
    "additive",
    "no pre-existing RELS body was touched: `course` and `teacher` do not name the link",
    Boolean(courseBody) &&
      Boolean(teacherBody) &&
      !courseBody.includes("courseTeacher") &&
      !teacherBody.includes("courseTeacher")
  );
  yes(
    "additive",
    "and both kept the relations they had before 8-pre",
    Boolean(courseBody) &&
      JSON.stringify([...courseBody.matchAll(/(\w+): \{ to: "/g)].map((m) => m[1])) ===
        '["school","branch","department","programCourses","registrations"]' &&
      Boolean(teacherBody) &&
      !teacherBody.includes('to: "courseTeacher"'),
    courseBody ? [...courseBody.matchAll(/(\w+): \{ to: "/g)].map((m) => m[1]).join(",") : "no course body"
  );

  yes(
    "accessor",
    "the prisma shim exposes courseTeacher (the ONE way to reach the row)",
    Boolean(prismaText) && /^  courseTeacher: model\("courseTeacher"\),$/m.test(prismaText)
  );
}

/* --------------------------------------------------------------- 5. the API */

console.log("\n5. the API — the college guard order, the derived id, the audit");
const apiPath = "src/app/api/courses/[id]/teachers/route.ts";
const apiExists = existsSync(join(ROOT, apiPath));
yes("api", `the link lives in the \`courses\` college segment (${apiPath})`, apiExists);
if (apiExists) {
  const api = read(apiPath);
  const handlers = ["GET", "POST", "DELETE"].filter((m) =>
    new RegExp(`export async function ${m}\\(`).test(api)
  );
  yes("api", "it exports GET, POST and DELETE", handlers.length === 3, handlers.join(","));

  // Guard order: in every handler, getSession() first, requireCollege() next, and
  // nothing that decides authorization or touches data before the gate.
  const parts = api.split(/export async function (GET|POST|DELETE)\(/).slice(1);
  const orderProblems = [];
  for (let i = 0; i < parts.length; i += 2) {
    const method = parts[i];
    const body = parts[i + 1];
    const session = body.indexOf("getSession(");
    const gate = body.indexOf("requireCollege(");
    const firstData = ["can(", "writeGuard(", "prisma.", "canAccessBranch("]
      .map((t) => body.indexOf(t))
      .filter((n) => n !== -1)
      .reduce((a, b) => Math.min(a, b), Number.MAX_SAFE_INTEGER);
    if (session === -1 || gate === -1 || session > gate || gate > firstData) {
      orderProblems.push(`${method} session=${session} gate=${gate} first=${firstData}`);
    }
  }
  yes("api", "getSession() → requireCollege() → can()/prisma in every handler", orderProblems.length === 0, orderProblems.join(" · "));
  yes("api", "the id is derived with the module's own helper (never re-implemented)", api.includes("courseTeacherId(") && api.includes('from "@/lib/course-teachers"'));
  yes("api", "the write is guarded (writeGuard) and audited", api.includes("writeGuard(") && api.includes('"COURSE_TEACHER_ASSIGN"') && api.includes('"COURSE_TEACHER_UNASSIGN"'));
  yes("api", "a foreign course id is NOT FOUND, never a 403 oracle", api.includes('{ error: "Course not found" }'));
  yes("api", "a non-teacher account is refused by the module's own sentence", api.includes("COURSE_TEACHER_ASSIGNEE_REFUSAL"));
  yes("api", "an existing assignment answers `already: true` and writes nothing", api.includes("already: true") && api.includes("if (existing)"));
}

console.log("\n6. the course DELETE is blocked while a teacher is assigned");
{
  const courseRoute = read("src/app/api/courses/[id]/route.ts");
  yes(
    "delete-guard",
    "the delete reads prisma.courseTeacher.count and returns the module's block message",
    courseRoute.includes("prisma.courseTeacher.count(") && courseRoute.includes("COURSE_TEACHER_DELETE_BLOCK")
  );
  yes(
    "delete-guard",
    "the block message is imported from the module, not re-typed",
    courseRoute.includes('from "@/lib/course-teachers"') && !/Cannot delete a course that still has a teacher/.test(courseRoute.replace(/import[^;]+;/, ""))
  );
}

/* ------------------------------------------------- 7. the guard list + proofs */

console.log("\n7. the link is wired into the guards that must know about it");
{
  const routesGuard = read("scripts/verify-college-routes.mjs");
  const modelList = /const COLLEGE_MODEL_RE = \/\\bprisma\\\.\(([^)]+)\)\\b\/;/.exec(routesGuard);
  yes(
    "guard",
    "COLLEGE_MODEL_RE lists courseTeacher (a school file cannot reach the link unnoticed)",
    Boolean(modelList) && modelList[1].split("|").includes("courseTeacher"),
    modelList ? modelList[1] : "regex not located"
  );
  for (const file of ["scripts/verify-college-fees-data.mjs", "scripts/verify-college-results-data.mjs"]) {
    const text = read(file);
    const later = /const LATER_MODELS = \[([^\]]*)\];/.exec(text);
    yes(
      "additive",
      `${file} drops courseTeacher by name, so its recorded baseline still reproduces`,
      Boolean(later) && later[1].includes('"courseTeacher"'),
      later ? later[1].trim() : "LATER_MODELS not located"
    );
  }
}

console.log("\n8. no school surface, and no wider payload");
{
  const segment = "src/app/api/courses";
  const offenders = [];
  const walk = (rel) => {
    const abs = join(ROOT, rel);
    let entries = [];
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(child);
      else if (e.name.endsWith(".ts")) {
        const text = read(child);
        if (text.includes("prisma.courseTeacher") && !child.startsWith(segment)) offenders.push(child);
      }
    }
  };
  walk("src/app/api");
  yes(
    "college-only",
    "only the `courses` segment reaches prisma.courseTeacher (no school API file does)",
    offenders.length === 0,
    offenders.join(" ") || "none"
  );
  const pureModule = read("src/lib/course-teachers.ts");
  yes(
    "pure",
    "the pure module imports nothing (no prisma, no next/server)",
    !/^\s*import\s/m.test(pureModule)
  );
  const coursesRoute = read("src/app/api/courses/route.ts");
  const coursesPatch = read("src/app/api/courses/[id]/route.ts");
  // The PATCH handler decides what a course update writes; the link must not have
  // been folded into it (it has its own endpoint). The DELETE half legitimately
  // names it, so only the PATCH body is checked — comments and imports masked out.
  const patchBody = maskCommentsAndStrings(
    coursesPatch.slice(
      coursesPatch.indexOf("export async function PATCH"),
      coursesPatch.indexOf("export async function DELETE")
    )
  );
  yes(
    "no-widening",
    "the existing course list/update payloads were not widened (the link has its own endpoint)",
    !coursesRoute.includes("courseTeacher") && patchBody.length > 0 && !patchBody.includes("courseTeacher")
  );
}

/* ------------------------------------------------------------ 9. LIVE HTTP */

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
 * in on the Teacher App host and a GUARDIAN on the Parents App host — and the one
 * host that serves every account is the hub, which is where the refused roles
 * below sign in and then address the API. Sending a teacher to
 * `school.localhost` would be refused by `sectorMismatch` (403) before the route
 * under test was ever reached, which would prove the wrong rule. */
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
  // `raw` keeps the top-level fields a response adds beside `data` (POST's
  // `already: true` is one), which `data`-only would hide.
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
const del = (path, cookie, opts = {}) => req(path, { cookie, method: "DELETE", ...opts });

const collegeAdmin = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
const collegeBranchAdmin = await login("zz-iso-college-br-admin@test.local", CRED.collegeBranchAdmin);
const collegeRegistrar = await login("zz-iso-college-registrar@test.local", CRED.collegeRegistrar);
const collegeAccountant = await login("zz-iso-college-accountant@test.local", CRED.collegeAccountant);
const schoolAdmin = await login("zz-iso-admin@test.local", CRED.admin);
const bothAdmin = await login("zz-iso-both-admin@test.local", CRED.bothAdmin);
// The three roles D-7-18 refuses sign in on their OWN sector host (RULE 1).
const bothTeacher = await login("zz-iso-both-teacher@test.local", CRED.bothTeacher, TEACHER_HOST);
const bothGuardian = await login("zz-iso-both-guardian@test.local", CRED.bothGuardian, PARENTS_HOST);
const bothStudent = await login("zz-iso-both-student@test.local", CRED.bothStudent, HUB_HOST);

const COLLEGE = `${P}college`;
const COURSE_A = `${P}col-course-a`;
const COURSE_B = `${P}col-course-b`;
const FOREIGN_COURSE = `${P}both-course`;
const FOREIGN_TEACHER = `t_${P}user-teacher`;
const stamp = Date.now();

/** Every document this run creates, so teardown is exact. */
const created = { users: [], teachers: [], courses: [], links: [] };
const mark = (bucket, id) => created[bucket].push(id);
const countLinks = async () => (await db.collection("courseTeachers").get()).size;

async function makeTeacher(id, { schoolId, branchId, role = "TEACHER", name }) {
  const userId = `${id}-user`;
  await db.collection("users").doc(userId).set({
    email: `${id}@test.local`,
    name,
    role,
    schoolId,
    branchId: branchId ?? null,
    scope: branchId ? "BRANCH" : null,
    active: true,
    passwordHash: "$2a$10$zzisolationfixtureplaceholderhashxxxxxxxxxxxxxxxxxxxxxx",
    createdAt: new Date().toISOString(),
  });
  mark("users", userId);
  const teacherId = `t_${userId}`;
  await db.collection("teachers").doc(teacherId).set({
    id: teacherId,
    schoolId,
    userId,
    name,
    designation: role === "TEACHER" ? "Teacher" : "Administrator",
    branchId: branchId ?? null,
    createdAt: new Date().toISOString(),
  });
  mark("teachers", teacherId);
  return { userId, teacherId };
}

console.log("\n9. live: assign, list, refuse, unassign (COLLEGE fixture tenant)");
let teacherA = null;
let teacherB = null;
let nonTeacher = null;
try {
  teacherA = await makeTeacher(`${P}ct-a-${stamp}`, {
    schoolId: COLLEGE,
    branchId: `${P}col-br-a`,
    name: `ZZ CT A ${stamp}`,
  });
  teacherB = await makeTeacher(`${P}ct-b-${stamp}`, {
    schoolId: COLLEGE,
    branchId: `${P}col-br-b`,
    name: `ZZ CT B ${stamp}`,
  });
  // A `teachers` row whose ACCOUNT is not a TEACHER — the row exists, the role
  // rule is what must refuse it.
  nonTeacher = await makeTeacher(`${P}ct-admin-${stamp}`, {
    schoolId: COLLEGE,
    branchId: `${P}col-br-a`,
    role: "SCHOOL_ADMIN",
    name: `ZZ CT Admin ${stamp}`,
  });

  const before = await countLinks();

  const anon = await get(`/api/courses/${COURSE_A}/teachers`);
  yes("live-auth", "an unauthenticated read is 401", anon.status === 401, `HTTP ${anon.status}`);
  const anonWrite = await post(`/api/courses/${COURSE_A}/teachers`, { teacherId: teacherA.teacherId });
  yes("live-auth", "an unauthenticated assign is 401", anonWrite.status === 401, `HTTP ${anon.status}`);

  const empty = await get(`/api/courses/${COURSE_A}/teachers`, collegeAdmin);
  yes(
    "live-read",
    "the tenant's admin reads an empty list for a course with no teacher",
    empty.status === 200 && Array.isArray(empty.data) && empty.data.length === 0,
    `HTTP ${empty.status} rows=${empty.data?.length}`
  );

  const assigned = await post(`/api/courses/${COURSE_A}/teachers`, { teacherId: teacherA.teacherId }, collegeAdmin);
  yes(
    "live-write",
    "the admin assigns a teacher (201)",
    assigned.status === 201 && assigned.data?.teacherId === teacherA.teacherId,
    `HTTP ${assigned.status} teacherId=${assigned.data?.teacherId}`
  );
  const rowId = `ct_${COURSE_A}_${teacherA.teacherId}`;
  const stored = (await db.collection("courseTeachers").doc(rowId).get()).data();
  yes(
    "live-write",
    "the stored row id is the DERIVED id and the row carries the course's branch + the actor",
    Boolean(stored) &&
      stored.courseId === COURSE_A &&
      stored.teacherId === teacherA.teacherId &&
      stored.schoolId === COLLEGE &&
      stored.branchId === `${P}col-br-a` &&
      stored.teacherUserId === teacherA.userId &&
      Boolean(stored.assignedById) &&
      Boolean(stored.assignedAt),
    stored ? `id=${rowId} branchId=${stored.branchId}` : "row missing"
  );
  if (stored) mark("links", rowId);

  const listed = await get(`/api/courses/${COURSE_A}/teachers`, collegeAdmin);
  const listedRow = (listed.data || [])[0] || null;
  yes(
    "live-read",
    "the list resolves the teacher's name and email in one read",
    listed.status === 200 && listed.data?.length === 1 && listedRow?.name === `ZZ CT A ${stamp}`,
    `HTTP ${listed.status} name=${listedRow?.name}`
  );

  const again = await post(`/api/courses/${COURSE_A}/teachers`, { teacherId: teacherA.teacherId }, collegeAdmin);
  const afterAgain = await countLinks();
  yes(
    "live-idempotence",
    "re-assigning the same teacher is a 200 no-op: `already` true and no new document",
    again.status === 200 && again.raw?.already === true && afterAgain === before + 1 && again.data?.id === rowId,
    `HTTP ${again.status} already=${again.raw?.already} rows ${before}→${afterAgain}`
  );

  const foreignTeacher = await post(`/api/courses/${COURSE_A}/teachers`, { teacherId: FOREIGN_TEACHER }, collegeAdmin);
  const notTeacher = await post(`/api/courses/${COURSE_A}/teachers`, { teacherId: nonTeacher.teacherId }, collegeAdmin);
  const ghostTeacher = await post(`/api/courses/${COURSE_A}/teachers`, { teacherId: "t_nope" }, collegeAdmin);
  const noTeacher = await post(`/api/courses/${COURSE_A}/teachers`, {}, collegeAdmin);
  const afterRefusals = await countLinks();
  yes(
    "live-refusal",
    "another tenant's teacher, a non-TEACHER account, a ghost id and a missing id are all 400 with no row written",
    foreignTeacher.status === 400 &&
      notTeacher.status === 400 &&
      notTeacher.error === link.COURSE_TEACHER_ASSIGNEE_REFUSAL &&
      ghostTeacher.status === 400 &&
      noTeacher.status === 400 &&
      afterRefusals === before + 1,
    `HTTP ${foreignTeacher.status}/${notTeacher.status}/${ghostTeacher.status}/${noTeacher.status} rows ${afterRefusals}`
  );

  const foreignCourse = await post(`/api/courses/${FOREIGN_COURSE}/teachers`, { teacherId: teacherA.teacherId }, collegeAdmin);
  const ghostCourse = await post(`/api/courses/zziso-nope-${stamp}/teachers`, { teacherId: teacherA.teacherId }, collegeAdmin);
  const afterForeign = await countLinks();
  yes(
    "live-isolation",
    "another tenant's course and a ghost course are the SAME 404, with no row written",
    foreignCourse.status === 404 && ghostCourse.status === 404 && afterForeign === before + 1,
    `HTTP ${foreignCourse.status}/${ghostCourse.status} rows ${afterForeign}`
  );

  const bothOnOwnCourse = await post(`/api/courses/${FOREIGN_COURSE}/teachers`, { teacherId: teacherA.teacherId }, bothAdmin);
  // (the BOTH tenant's own admin addresses its own course on the school app host)
  const afterBoth = await countLinks();
  yes(
    "live-isolation",
    "the BOTH tenant's admin is admitted on its OWN course but cannot attach the college tenant's teacher (400, no row)",
    bothOnOwnCourse.status === 400 &&
      bothOnOwnCourse.error === link.COURSE_TEACHER_ASSIGNEE_REFUSAL &&
      afterBoth === before + 1,
    `HTTP ${bothOnOwnCourse.status} rows ${afterBoth}`
  );

  const registrarRead = await get(`/api/courses/${COURSE_A}/teachers`, collegeRegistrar);
  const registrarWrite = await post(`/api/courses/${COURSE_A}/teachers`, { teacherId: teacherB.teacherId }, collegeRegistrar);
  const registrarUnassign = await del(`/api/courses/${COURSE_A}/teachers?teacherId=${encodeURIComponent(teacherA.teacherId)}`, collegeRegistrar);
  yes(
    "live-matrix",
    "the REGISTRAR reads (200) and is refused both writes (403)",
    registrarRead.status === 200 && registrarWrite.status === 403 && registrarUnassign.status === 403,
    `HTTP read=${registrarRead.status} assign=${registrarWrite.status} unassign=${registrarUnassign.status}`
  );

  const refusedRoles = [
    ["ACCOUNTANT", collegeAccountant, HOST],
    ["TEACHER (inside a college-capable tenant)", bothTeacher, HUB_HOST],
    ["GUARDIAN", bothGuardian, HUB_HOST],
    ["STUDENT", bothStudent, HUB_HOST],
  ];
  const roleResults = [];
  for (const [label, cookie, host] of refusedRoles) {
    const read = await get(`/api/courses/${COURSE_A}/teachers`, cookie, { host });
    const write = await post(`/api/courses/${COURSE_A}/teachers`, { teacherId: teacherB.teacherId }, cookie, { host });
    roleResults.push(`${label}:${read.status}/${write.status}`);
  }
  const afterRoles = await countLinks();
  yes(
    "live-matrix",
    "ACCOUNTANT, TEACHER, GUARDIAN and STUDENT are all 403 on read AND write",
    roleResults.every((r) => r.endsWith("403/403")) && afterRoles === before + 1,
    roleResults.join(" ")
  );

  const schoolOnCollege = await get(`/api/courses/${COURSE_A}/teachers`, schoolAdmin);
  yes(
    "live-isolation",
    "a SCHOOL tenant's admin is refused by the college gate (403, no data)",
    schoolOnCollege.status === 403 && schoolOnCollege.data === null,
    `HTTP ${schoolOnCollege.status}`
  );

  const branchOtherCourse = await get(`/api/courses/${COURSE_B}/teachers`, collegeBranchAdmin);
  const branchOtherTeacher = await post(`/api/courses/${COURSE_A}/teachers`, { teacherId: teacherB.teacherId }, collegeBranchAdmin);
  const branchOwn = await post(`/api/courses/${COURSE_A}/teachers`, { teacherId: teacherA.teacherId }, collegeBranchAdmin);
  const afterBranch = await countLinks();
  yes(
    "live-branch",
    "a BRANCH_ADMIN cannot reach another branch's course (403) or attach another branch's teacher (403)",
    branchOtherCourse.status === 403 &&
      branchOtherTeacher.status === 403 &&
      branchOwn.status === 200 &&
      afterBranch === before + 1,
    `HTTP course=${branchOtherCourse.status} foreignTeacher=${branchOtherTeacher.status} ownTeacher=${branchOwn.status}`
  );

  const unassigned = await del(`/api/courses/${COURSE_A}/teachers?teacherId=${encodeURIComponent(teacherA.teacherId)}`, collegeAdmin);
  const goneRow = (await db.collection("courseTeachers").doc(rowId).get()).exists;
  const afterUnassign = await get(`/api/courses/${COURSE_A}/teachers`, collegeAdmin);
  const unassignAgain = await del(`/api/courses/${COURSE_A}/teachers?teacherId=${encodeURIComponent(teacherA.teacherId)}`, collegeAdmin);
  const afterAll = await countLinks();
  yes(
    "live-unassign",
    "unassign removes the row (and repeating it is 404) — the collection is back where it started",
    unassigned.status === 200 && goneRow === false && afterUnassign.data?.length === 0 && unassignAgain.status === 404 && afterAll === before,
    `HTTP ${unassigned.status} exists=${goneRow} again=${unassignAgain.status} rows ${before}→${afterAll}`
  );

  /* The course DELETE's new block, proved with a course this run creates so the
   * fixture's own courses are never removed. */
  const createdCourse = await post(
    "/api/courses",
    { code: `ZZCT-${String(stamp).slice(-6)}`, title: `ZZ CT Course ${stamp}`, departmentId: `${P}col-dept-a` },
    collegeAdmin
  );
  const courseId = createdCourse.data?.id;
  yes(
    "live-course-delete",
    "a course created for the probe is there (201)",
    createdCourse.status === 201 && Boolean(courseId),
    `HTTP ${createdCourse.status} id=${courseId}`
  );
  if (courseId) {
    mark("courses", courseId);
    await post(`/api/courses/${courseId}/teachers`, { teacherId: teacherA.teacherId }, collegeAdmin);
    mark("links", `ct_${courseId}_${teacherA.teacherId}`);
    const blocked = await del(`/api/courses/${courseId}`, collegeAdmin);
    yes(
      "live-course-delete",
      "deleting a course that still has a teacher is refused (400, the module's own sentence)",
      blocked.status === 400 && blocked.error === link.COURSE_TEACHER_DELETE_BLOCK,
      `HTTP ${blocked.status} ${blocked.error || ""}`
    );
    await del(`/api/courses/${courseId}/teachers?teacherId=${encodeURIComponent(teacherA.teacherId)}`, collegeAdmin);
    const after = await del(`/api/courses/${courseId}`, collegeAdmin);
    const stillThere = (await db.collection("courses").doc(courseId).get()).exists;
    yes(
      "live-course-delete",
      "once the teacher is removed the same delete succeeds",
      after.status === 200 && stillThere === false,
      `HTTP ${after.status}`
    );
  }

  const finalLinks = await countLinks();
  yes(
    "live-quiescence",
    "every link row this run created is gone (the fixture's own data is untouched)",
    finalLinks === before,
    `rows ${before} → ${finalLinks}`
  );
} finally {
  for (const id of created.links) await db.collection("courseTeachers").doc(id).delete().catch(() => {});
  for (const id of created.courses) await db.collection("courses").doc(id).delete().catch(() => {});
  for (const id of created.teachers) await db.collection("teachers").doc(id).delete().catch(() => {});
  for (const id of created.users) await db.collection("users").doc(id).delete().catch(() => {});
}

console.log(
  failures === 0
    ? `\n✅ COURSE TEACHERS OK — ${checks} checks: the derived id, the store entry, the guard order, and the live matrix (assign/idempotent/list, the refusals, branch + tenant confinement, unassign, the course-delete block)`
    : `\n❌ verify-course-teachers: ${failures} failure(s) of ${checks} checks`
);
process.exit(failures === 0 ? 0 : 1);
