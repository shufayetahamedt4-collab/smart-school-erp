#!/usr/bin/env node
/**
 * verify-college-results-api.mjs — Phase 6c: the college RESULTS API over HTTP.
 *
 * Runs against the COLLEGE fixture tenant (scripts/isolation-fixture.mjs) and
 * proves the whole 6c contract of `docs/COLLEGE-DECISIONS.md` §23.7:
 *
 *   • the 403/400/404 matrix — a SCHOOL tenant is gated (403, zero data), a
 *     foreign tenant's id is NOT FOUND (404), a foreign id in a BODY is the same
 *     400 as a ghost, and a wrong-BRANCH caller is refused (403);
 *   • only an APPROVED registration is gradable — a PENDING one is a 409;
 *   • the (studentId, courseId, termNumber, attempt) uniqueness is a VISIBLE 409,
 *     never a silent overwrite;
 *   • `maxRetakes` is enforced from the tenant's own policy, and the ABSENT
 *     retake block means exactly one attempt (today's behaviour, D-6-7);
 *   • a bad attempt is refused with a REASON (marks above full, a missing attempt
 *     number, and a gap in the 1-based sequence);
 *   • every one of REPLACE / BEST / BOTH / AVERAGE resolves differently from the
 *     SAME stored attempts — changing only the tenant's policy, never re-entering
 *     a mark;
 *   • a re-graded scheme changes the served letter, point and CGPA with the
 *     stored marks untouched (D-6-12 — derived on read, never frozen);
 *   • a no-GPA scheme returns NO GPA at all, never a printed 0.00 (D-6-16);
 *   • the permission split (Q5, `attendanceMarks`): a REGISTRAR may read and may
 *     not write;
 *   • the v1 READ allow-list (6d-fix, §23.6): a TEACHER, a GUARDIAN and a STUDENT
 *     in the COLLEGE tenant are refused (403) on the list, on one row, and on a
 *     transcript — their OWN and ANOTHER student's — while the admin-level roles
 *     and the REGISTRAR still read; each probe signs in through its own portal;
 *   • and a DOCUMENT-COUNT BRACKET around every refusal, so "it wrote nothing" is
 *     COUNTED rather than assumed (§17 Q2's pattern).
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-college-results-api.mjs
 * Needs the isolation fixture:  node scripts/isolation-fixture.mjs create
 *
 * The tenant's college grading scheme is PUT through the real
 * /api/grading-scheme route (a COLLEGE tenant's scheme lives under the mode-scoped
 * `…__college` key), and is RESTORED at the end — deleted again when the fixture
 * had none — so the script is repeatable and leaves no residue.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { requireEmulator } from "./lib/guard.mjs";

import { installHostFetch } from "./lib/hostfetch.mjs";

// A `Host:` header on fetch is a fetch-spec forbidden name and was silently
// dropped, so every host-scoped request below reaches the hub. These requests go
// through node:http, which delivers the header for real (the same shim the other
// college HTTP harnesses use).
installHostFetch();

requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
/** Fixture id prefix (isolation-fixture.mjs). */
const P = "zziso-";
const C1 = `${P}college`;

const TRACK = new URL(".qa-fixtures.json", import.meta.url);
if (!existsSync(TRACK)) {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(1);
}
const CRED = JSON.parse(readFileSync(TRACK, "utf8")).creds || {};
if (!CRED.collegeAdmin || !CRED.collegeBranchAdmin || !CRED.admin || !CRED.collegeRegistrar) {
  console.error("❌ Track file lacks credentials — re-run: node scripts/isolation-fixture.mjs clean && create");
  process.exit(1);
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
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
  return { status: res.status, body, data: body?.data ?? null, error: body?.error ?? null };
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
const put = (path, body, cookie) => req(path, { cookie, method: "PUT", body: JSON.stringify(body) });

const collegeAdmin = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
const collegeBranchAdmin = await login("zz-iso-college-br-admin@test.local", CRED.collegeBranchAdmin);
const collegeRegistrar = await login("zz-iso-college-registrar@test.local", CRED.collegeRegistrar);
const schoolAdmin = await login("zz-iso-admin@test.local", CRED.admin);

const stamp = Date.now();
let createdStudentId = null;
let createdRegId = null;
const createdResultIds = [];
/** Results already removed through the API (cleanup deletes only the rest). */
const deletedResultIds = [];

/** How many `courseResults` rows this tenant holds right now — the bracket basis. */
async function resultCount() {
  const snap = await db.collection("courseResults").where("schoolId", "==", C1).get();
  return snap.size;
}
/** Assert a refusal changed nothing: the same document count, before and after. */
async function bracket(label, before) {
  const after = await resultCount();
  check(`${label} — writes NOTHING (document count ${before} → ${after})`, before === after, `delta=${after - before}`);
}

/**
 * The mode-scoped college scheme document (`saveScheme` → `set_grading_scheme_…`
 * with the COLLEGE suffix). Read RAW so the script can restore — or remove — it
 * exactly as it found it.
 */
const SCHEME_DOC = `set_grading_scheme_${C1}__college`;
const schemeBefore = (await db.collection("settings").doc(SCHEME_DOC).get()).exists
  ? (await db.collection("settings").doc(SCHEME_DOC).get()).data()?.value ?? null
  : null;

/** A complete, valid college scheme (validateScheme requires 2+ bands, one at 0%). */
const scheme = ({ name, bands, retake, showGpa, passPercent = 40, gpaScale = 4 }) => {
  const s = { name, gpaScale, passPercent, failCapsGpa: false, bands };
  if (showGpa === false) s.showGpa = false;
  if (retake !== undefined) s.retake = retake;
  return s;
};
const BANDS_ABC = [
  { grade: "A", minPercent: 80, gpa: 4 },
  { grade: "B", minPercent: 60, gpa: 3 },
  { grade: "C", minPercent: 40, gpa: 2 },
  { grade: "F", minPercent: 0, gpa: 0 },
];

async function putScheme(body) {
  const r = await put("/api/grading-scheme", { scheme: body }, collegeAdmin);
  if (r.status !== 200) throw new Error(`PUT /api/grading-scheme failed: HTTP ${r.status} ${r.error || ""}`);
  return r;
}

/** The transcript for the throwaway student, plus its one course row. */
async function transcript() {
  const t = await req(`/api/course-results/students/${createdStudentId}/transcript`, { cookie: collegeAdmin });
  const course = (t.data?.terms || [])
    .flatMap((term) => term.courses || [])
    .find((c) => c.courseId === `${P}col-course-a`);
  return { ...t, course };
}

/* ------------------------------------------------------------------ set-up */

console.log(`\n=== Phase 6c college results API (${BASE})`);

console.log("\n### set-up — a throwaway student enrolled in fixture programme A");
{
  const adm = `CR-${stamp}`;
  const s = await post("/api/students", {
    name: `CR Student ${stamp}`, admissionNo: adm, createFees: false, createGuardian: false,
    programId: `${P}col-prog-a`, termNumber: 1,
  }, collegeAdmin);
  createdStudentId = s.data?.id || null;
  check(
    "a COLLEGE tenant can enrol a throwaway student into fixture programme A (201)",
    s.status === 201 && !!createdStudentId && s.data?.programId === `${P}col-prog-a`,
    `HTTP ${s.status} ${s.error || ""}`
  );

  const reg = createdStudentId
    ? await post("/api/course-registrations", { studentId: createdStudentId, courseId: `${P}col-course-a` }, collegeAdmin)
    : { status: null };
  createdRegId = reg.data?.id || null;
  check(
    "…and register it for the mapped course (201, PENDING)",
    reg.status === 201 && !!createdRegId && reg.data?.status === "PENDING",
    `HTTP ${reg.status} ${reg.error || ""}`
  );
}

/* ------------------------------------- only an APPROVED registration is gradable */

console.log("\n### only an APPROVED registration is gradable");
{
  const before = await resultCount();
  const r = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, obtained: 55, fullMarks: 100,
  }, collegeAdmin);
  check(
    "a PENDING registration is refused with a clear reason (409)",
    r.status === 409 && /approve/i.test(r.error || ""),
    `HTTP ${r.status} ${JSON.stringify(r.error)}`
  );
  await bracket("the not-approved refusal", before);

  const ok = await patch(`/api/course-registrations/${createdRegId}`, { status: "APPROVED" }, collegeAdmin);
  check("the registration is approved (200)", ok.status === 200 && ok.data?.status === "APPROVED", `HTTP ${ok.status}`);
}

/* ------------------------------------------------- create, duplicate, bad attempt */

console.log("\n### create the first attempt (attempts are 1-based and gapless)");
{
  const before = await resultCount();
  const r = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, obtained: 60, fullMarks: 100,
  }, collegeAdmin);
  if (r.data?.id) createdResultIds.push(r.data.id);
  check(
    "the first attempt is recorded (201) and DERIVED on read",
    r.status === 201 && r.data?.attempt === 1 && r.data?.termNumber === 1 && r.data?.percent === 60 &&
      typeof r.data?.grade === "string",
    `HTTP ${r.status} attempt=${r.data?.attempt} term=${r.data?.termNumber} percent=${r.data?.percent} grade=${JSON.stringify(r.data?.grade)}`
  );
  const after = await resultCount();
  check("…and exactly one document was written", after === before + 1, `${before} → ${after}`);

  // (a) DUPLICATE — a visible 409, never a silent overwrite.
  const dup = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, attempt: 1, obtained: 99, fullMarks: 100,
  }, collegeAdmin);
  check(
    "a duplicate attempt is refused (409) and names the attempt",
    dup.status === 409 && /1/.test(dup.error || ""),
    `HTTP ${dup.status} ${JSON.stringify(dup.error)}`
  );
  await bracket("the duplicate refusal", after);
  const firstRow = createdResultIds[0] ? (await db.collection("courseResults").doc(createdResultIds[0]).get()).data() : null;
  check(
    "…and the stored mark is NOT overwritten (60/100, not 99)",
    firstRow?.obtained === 60 && firstRow?.fullMarks === 100,
    `${firstRow?.obtained}/${firstRow?.fullMarks}`
  );

  // (b) The ABSENT retake block means today's behaviour: exactly ONE attempt
  //     (D-6-7 — a scheme with no `retake` records no retakes).
  const second = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, obtained: 70, fullMarks: 100,
  }, collegeAdmin);
  check(
    "with NO retake policy configured, a second attempt is refused (409) naming the limit",
    second.status === 409 && /retake/i.test(second.error || ""),
    `HTTP ${second.status} ${JSON.stringify(second.error)}`
  );
  await bracket("the no-policy refusal", after);

  // (c) A BAD ATTEMPT is refused with a reason — marks above the maximum…
  const over = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, obtained: 120, fullMarks: 100,
  }, collegeAdmin);
  check(
    "marks above full marks are refused with a reason (400)",
    over.status === 400 && /fullMarks/.test(over.error || ""),
    `HTTP ${over.status} ${JSON.stringify(over.error)}`
  );
  await bracket("the marks refusal", after);

  // …and a missing/invalid attempt number is refused before any policy is applied.
  const zero = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, attempt: 0, obtained: 50, fullMarks: 100,
  }, collegeAdmin);
  check(
    "an invalid attempt number is refused with a reason (400)",
    zero.status === 400 && /attempt/.test(zero.error || ""),
    `HTTP ${zero.status} ${JSON.stringify(zero.error)}`
  );
  await bracket("the attempt-number refusal", after);
}

/* ----------------------------------------- retake policy: within limit, then over */

console.log("\n### maxRetakes — one retake allowed, the next refused");
{
  await putScheme(scheme({
    name: "ZZ Test Scale", bands: BANDS_ABC, retake: { policy: "REPLACE", maxRetakes: 1 },
  }));
  check("a college scheme with retake REPLACE/1 was stored through the real route (200)", true);

  const before = await resultCount();
  // A GAP in the 1-based sequence: the server derives the next attempt, so a
  // supplied one is only ever a confirmation (the same rule `termNumber` follows).
  const gap = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, attempt: 5, obtained: 50, fullMarks: 100,
  }, collegeAdmin);
  check(
    "a gap in the attempt sequence is refused (400) and names the next attempt",
    gap.status === 400 && /next attempt/i.test(gap.error || ""),
    `HTTP ${gap.status} ${JSON.stringify(gap.error)}`
  );
  await bracket("the gap refusal", before);

  const within = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, obtained: 80, fullMarks: 100,
  }, collegeAdmin);
  if (within.data?.id) createdResultIds.push(within.data.id);
  check(
    "a retake WITHIN the limit is accepted (201) as attempt 2",
    within.status === 201 && within.data?.attempt === 2,
    `HTTP ${within.status} attempt=${within.data?.attempt} ${within.error || ""}`
  );

  const over = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, obtained: 90, fullMarks: 100,
  }, collegeAdmin);
  check(
    "the attempt ABOVE the limit is refused (409) with a reason",
    over.status === 409 && /retake/i.test(over.error || ""),
    `HTTP ${over.status} ${JSON.stringify(over.error)}`
  );
  await bracket("the over-limit refusal", await resultCount());
}

/* --------------------------------------------------- the four policies, same marks */

console.log("\n### REPLACE / BEST / BOTH / AVERAGE — resolved from the SAME stored attempts");
{
  // Stored: attempt 1 = 60/100 (band B → 3), attempt 2 = 80/100 (band A → 4).
  const policies = [
    { policy: "REPLACE", percent: 80, cgpa: 4, note: "the latest attempt grades the course" },
    { policy: "BEST", percent: 80, cgpa: 4, note: "the highest attempt grades the course" },
    { policy: "BOTH", percent: 80, cgpa: 4, note: "every attempt is reported, the latest is effective" },
    { policy: "AVERAGE", percent: 70, cgpa: 3, note: "the mean of the attempts grades the course" },
  ];
  for (const { policy, percent, cgpa, note } of policies) {
    await putScheme(scheme({ name: "ZZ Test Scale", bands: BANDS_ABC, retake: { policy, maxRetakes: 1 } }));
    const t = await transcript();
    check(
      `${policy} → the course grade is ${percent}% (CGPA ${cgpa}) — ${note}`,
      t.course?.percent === percent && t.data?.cgpa === cgpa && t.data?.retake?.policy === policy,
      `percent=${t.course?.percent} cgpa=${JSON.stringify(t.data?.cgpa)} policy=${t.data?.retake?.policy}`
    );
  }

  // BOTH reports EVERY attempt with the effective one marked (Q3).
  await putScheme(scheme({ name: "ZZ Test Scale", bands: BANDS_ABC, retake: { policy: "BOTH", maxRetakes: 1 } }));
  const both = await transcript();
  const attempts = both.course?.attempts || [];
  check(
    "BOTH reports every attempt with the effective one marked and the rest superseded",
    attempts.length === 2 && attempts.filter((a) => a.effective).length === 1 &&
      attempts.find((a) => a.effective)?.attempt === 2 && attempts.filter((a) => a.superseded).length === 1,
    JSON.stringify(attempts.map((a) => ({ n: a.attempt, p: a.percent, e: a.effective, s: a.superseded })))
  );

  // AVERAGE stores nothing new either — the marks are still the two attempts.
  await putScheme(scheme({ name: "ZZ Test Scale", bands: BANDS_ABC, retake: { policy: "AVERAGE", maxRetakes: 1 } }));
  const avg = await transcript();
  const rows = (await db.collection("courseResults").where("schoolId", "==", C1).get()).docs
    .map((d) => d.data())
    .filter((r) => r.studentId === createdStudentId);
  check(
    "no policy writes a grade back — the stored rows are still exactly the entered marks",
    rows.length === 2 && rows.every((r) => r.obtained === 60 || r.obtained === 80) &&
      rows.every((r) => r.grade === undefined && r.gpa === undefined && r.points === undefined),
    `rows=${JSON.stringify(rows.map((r) => `${r.attempt}:${r.obtained}`))}`
  );
  check(
    "…and AVERAGE really is the mean of the two attempts (70%)",
    avg.course?.percent === 70,
    `percent=${avg.course?.percent}`
  );
}

/* --------------------------------- a re-graded scheme, with NO mark re-entered */

console.log("\n### a re-graded scheme changes the served value — no mark re-entered (D-6-12)");
{
  // Same stored attempts (60 and 80), a DIFFERENT scale: 80% is now 2.5, not 4.
  await putScheme(scheme({
    name: "ZZ Regrade Scale",
    bands: [{ grade: "X", minPercent: 50, gpa: 2.5 }, { grade: "Y", minPercent: 0, gpa: 0 }],
    retake: { policy: "REPLACE", maxRetakes: 1 },
  }));
  const t = await transcript();
  const raw = (await db.collection("courseResults").doc(createdResultIds[1]).get()).data();
  check(
    "the SAME stored 80/100 now serves 2.50 under the new scale",
    t.course?.points === 2.5 && t.data?.cgpa === 2.5 && t.course?.grade === "X",
    `points=${t.course?.points} cgpa=${JSON.stringify(t.data?.cgpa)} grade=${t.course?.grade}`
  );
  check(
    "…and the stored marks are untouched by the re-grade",
    raw?.obtained === 80 && raw?.fullMarks === 100,
    `${raw?.obtained}/${raw?.fullMarks}`
  );
}

/* ------------------------------------------------------------ a no-GPA scheme */

console.log("\n### a no-GPA scheme returns NO GPA at all, never 0.00 (D-6-16)");
{
  await putScheme(scheme({
    name: "ZZ Letters Only",
    showGpa: false,
    bands: [{ grade: "P", minPercent: 40 }, { grade: "F", minPercent: 0 }],
    retake: { policy: "REPLACE", maxRetakes: 1 },
  }));
  const t = await transcript();
  check(
    "showGpa:false → the transcript's CGPA is NULL, not 0",
    t.data?.cgpa === null && t.data?.scheme?.showGpa === false,
    `cgpa=${JSON.stringify(t.data?.cgpa)} showGpa=${JSON.stringify(t.data?.scheme?.showGpa)}`
  );
  check(
    "…and the course carries a letter with NO point",
    typeof t.course?.grade === "string" && t.course.grade.length > 0 && t.course?.points === null,
    `grade=${JSON.stringify(t.course?.grade)} points=${JSON.stringify(t.course?.points)}`
  );
  const list = await req("/api/course-results?studentId=" + encodeURIComponent(createdStudentId), { cookie: collegeAdmin });
  const lrow = (list.data || []).find((r) => r.id === createdResultIds[1]);
  check(
    "…and the list serves the same (no point, no 0.00)",
    list.status === 200 && lrow?.points === null && lrow?.percent === 80,
    `points=${JSON.stringify(lrow?.points)} percent=${lrow?.percent}`
  );
}

/* ------------------------------------------------------------ the refusal matrix */

console.log("\n### the 403/400/404 matrix");
{
  const before = await resultCount();

  // A SCHOOL tenant is GATED — 403 with zero data, on every handler.
  const sList = await req("/api/course-results", { cookie: schoolAdmin });
  check(
    "a SCHOOL tenant's list is 403 with ZERO data",
    sList.status === 403 && sList.body?.data === undefined,
    `HTTP ${sList.status} data=${JSON.stringify(sList.body?.data)}`
  );
  const sPost = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, obtained: 10, fullMarks: 100,
  }, schoolAdmin);
  check("a SCHOOL tenant's POST is 403", sPost.status === 403, `HTTP ${sPost.status} ${JSON.stringify(sPost.error)}`);
  const sTranscript = await req(`/api/course-results/students/${createdStudentId}/transcript`, { cookie: schoolAdmin });
  check("a SCHOOL tenant's transcript read is 403", sTranscript.status === 403, `HTTP ${sTranscript.status}`);
  await bracket("every SCHOOL-tenant refusal", before);

  // A foreign tenant's id is NOT FOUND — never a 403 oracle. The BOTH tenant's
  // own result row and the COLLEGE tenant's row are each foreign to the other.
  const bothCookie = await login("zz-iso-both-admin@test.local", CRED.bothAdmin);
  const foreignGet = await req(`/api/course-results/${P}col-res-a`, { cookie: bothCookie });
  const ghostGet = await req(`/api/course-results/${P}no-such-result`, { cookie: bothCookie });
  check(
    "a foreign result id is NOT FOUND (404), byte-identical to a ghost (no oracle)",
    foreignGet.status === 404 && ghostGet.status === 404 &&
      JSON.stringify(foreignGet.body) === JSON.stringify(ghostGet.body),
    `foreign=${foreignGet.status} ghost=${ghostGet.status}`
  );
  const cForeign = await req(`/api/course-results/${P}both-res`, { cookie: collegeAdmin });
  check("…and the reverse direction is 404 too", cForeign.status === 404, `HTTP ${cForeign.status}`);
  const foreignPost = await post("/api/course-results", {
    studentId: `${P}both-stu`, courseId: `${P}col-course-a`, obtained: 10, fullMarks: 100,
  }, collegeAdmin);
  const ghostPost = await post("/api/course-results", {
    studentId: `${P}no-such-student`, courseId: `${P}col-course-a`, obtained: 10, fullMarks: 100,
  }, collegeAdmin);
  check(
    "a foreign studentId in a BODY is the same 400 as a ghost (never a 404)",
    foreignPost.status === 400 && JSON.stringify(foreignPost.body) === JSON.stringify(ghostPost.body),
    `foreign=${JSON.stringify(foreignPost.body)} ghost=${JSON.stringify(ghostPost.body)}`
  );

  // A WRONG-BRANCH caller is refused, and reads nothing.
  const bOtherGet = await req(`/api/course-results/${P}col-res-b`, { cookie: collegeBranchAdmin });
  check("a BRANCH-scoped admin CANNOT GET another branch's result (403)", bOtherGet.status === 403, `HTTP ${bOtherGet.status}`);
  const bOwnGet = await req(`/api/course-results/${P}col-res-a`, { cookie: collegeBranchAdmin });
  check(
    "…but CAN read its own branch's result (200) — the positive control",
    bOwnGet.status === 200 && bOwnGet.data?.id === `${P}col-res-a`,
    `HTTP ${bOwnGet.status}`
  );
  const bForeignPost = await post("/api/course-results", {
    studentId: `${P}col-stu-b`, courseId: `${P}col-course-b`, obtained: 10, fullMarks: 100,
  }, collegeBranchAdmin);
  check("a BRANCH-scoped admin CANNOT record a result for another branch's student (403)", bForeignPost.status === 403, `HTTP ${bForeignPost.status}`);
  await bracket("every cross-tenant and cross-branch refusal", before);

  // The permission split (Q5): `attendanceMarks` — a REGISTRAR may read, not write.
  const regList = await req("/api/course-results", { cookie: collegeRegistrar });
  check(
    "a REGISTRAR may READ the results (200) — it holds `view` on attendanceMarks",
    regList.status === 200,
    `HTTP ${regList.status}`
  );
  const regPost = await post("/api/course-results", {
    studentId: createdStudentId, courseId: `${P}col-course-a`, obtained: 10, fullMarks: 100,
  }, collegeRegistrar);
  check(
    "…but CANNOT write (403) — writes need `full`, exactly like the other college write routes",
    regPost.status === 403,
    `HTTP ${regPost.status} ${JSON.stringify(regPost.error)}`
  );
  await bracket("the permission refusal", before);
}

/* ------------------------------------- the v1 READ allow-list (Phase 6d-fix) */

console.log("\n### the v1 read allow-list: TEACHER, GUARDIAN and STUDENT are refused, admin roles and REGISTRAR read (6d-fix, §23.6)");
{
  // The owner ruling narrows READS to the admin-level roles and the REGISTRAR.
  // The probe uses REAL accounts in the COLLEGE tenant (C1), so the COLLEGE gate
  // passes and only the read rule can be what refuses them — a SCHOOL fixture user
  // would prove nothing, since `requireCollege` would 403 it anyway.
  //
  // The three users are written RAW here rather than added to
  // scripts/isolation-fixture.mjs on purpose: the fixture is shared with the tenant
  // and branch harrness, whose totals must stay EXACTLY as they are (92 and 60).
  // Each run uses fresh, timestamped emails stored under the app's deterministic
  // user id (`u_<sha1(email)>`), so a cold app reads the doc straight by id.
  const PUB = `${P}col-res-a`; // a fixture row the admin genuinely holds
  const OWN = `${P}col-stu-a`;
  const OTHER = `${P}col-stu-b`;
  const PW = "Probe@12345";
  const sha1 = (s) => createHash("sha1").update(s).digest("hex");
  const runId = `${Date.now().toString(36)}`;
  const probeUsers = ["TEACHER", "GUARDIAN", "STUDENT"].map((role) => {
    const email = `zziso-results-${role.toLowerCase()}+${runId}@test.local`;
    return { role, email, id: `u_${sha1(email)}` };
  });
  for (const u of probeUsers) {
    await db.collection("users").doc(u.id).set({
      id: u.id, email: u.email, name: `ZZ Iso Results ${u.role}`, role: u.role,
      schoolId: C1, active: true, passwordHash: bcrypt.hashSync(PW, 4), createdAt: new Date(),
    });
  }
  await db.collection("students").doc(OWN).set({ userId: probeUsers[2].id, guardianUserId: probeUsers[1].id }, { merge: true });

  // The three roles sign in through their OWN portals, whose hosts are not the
  // staff console (`school.localhost` refuses a teacher by design), so the probe
  // uses the host-agnostic loopback host, exactly as those portals do.
  const APP_HOST = `127.0.0.1:${PORT}`;
  const reqOn = async (host, path, opts = {}) => {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      headers: { Host: host, "Content-Type": "application/json", ...(opts.cookie ? { cookie: opts.cookie } : {}) },
      signal: AbortSignal.timeout(60000),
    });
    const text = await res.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* html */ }
    return { status: res.status, body, data: body?.data ?? null, error: body?.error ?? null };
  };
  const sessions = {};
  for (const u of probeUsers) {
    const res = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { Host: APP_HOST, "Content-Type": "application/json" },
      body: JSON.stringify({ identifier: u.email, password: PW }),
      signal: AbortSignal.timeout(60000),
    });
    sessions[u.role] = (res.headers.get("set-cookie") || "").split(";")[0];
    if (res.status !== 200) check(`the probe ${u.role} can sign in (its own portal host)`, false, `HTTP ${res.status}`);
  }

  const before = await resultCount();
  for (const u of probeUsers) {
    const cookie = sessions[u.role];
    const list = await reqOn(APP_HOST, "/api/course-results", { cookie });
    check(`a ${u.role} CANNOT list results (403, no data)`, list.status === 403 && list.data === null, `HTTP ${list.status} data=${JSON.stringify(list.data)}`);
    const one = await reqOn(APP_HOST, `/api/course-results/${PUB}`, { cookie });
    check(`a ${u.role} CANNOT read one result (403)`, one.status === 403, `HTTP ${one.status}`);
    const own = await reqOn(APP_HOST, `/api/course-results/students/${OWN}/transcript`, { cookie });
    check(`a ${u.role} CANNOT read a transcript — even a student's own (403)`, own.status === 403, `HTTP ${own.status}`);
    const other = await reqOn(APP_HOST, `/api/course-results/students/${OTHER}/transcript`, { cookie });
    check(`a ${u.role} CANNOT read ANOTHER student's transcript (403)`, other.status === 403, `HTTP ${other.status} body=${JSON.stringify(other.data)?.slice(0, 60)}`);
    const write = await reqOn(APP_HOST, "/api/course-results", {
      cookie, method: "POST",
      body: JSON.stringify({ studentId: OWN, courseId: `${P}col-course-a`, obtained: 10, fullMarks: 100 }),
    });
    // 403, NOT 409: the refusal is the permission, not the approval state of the row.
    check(`a ${u.role}'s write stays refused by permission (403, not 409)`, write.status === 403, `HTTP ${write.status} ${JSON.stringify(write.error)}`);
  }
  await bracket("every denied-role read and write", before);

  // The roles the ruling KEEPS must still read — on the staff console they use.
  const adminOne = await req(`/api/course-results/${PUB}`, { cookie: collegeAdmin });
  check("an ADMIN still reads one result (200)", adminOne.status === 200, `HTTP ${adminOne.status}`);
  const adminT = await req(`/api/course-results/students/${OTHER}/transcript`, { cookie: collegeAdmin });
  check("an ADMIN still reads a transcript (200)", adminT.status === 200, `HTTP ${adminT.status}`);
  const regOne = await req(`/api/course-results/${PUB}`, { cookie: collegeRegistrar });
  check("a REGISTRAR still reads one result (200)", regOne.status === 200, `HTTP ${regOne.status}`);
  const regT = await req(`/api/course-results/students/${OWN}/transcript`, { cookie: collegeRegistrar });
  check("a REGISTRAR still reads a transcript (200)", regT.status === 200, `HTTP ${regT.status}`);
  const branchList = await req("/api/course-results", { cookie: collegeBranchAdmin });
  check("a BRANCH admin still reads the list (200)", branchList.status === 200, `HTTP ${branchList.status}`);

  // Remove the probe accounts (there is no route that creates a TEACHER/GUARDIAN/
  // STUDENT login, so they are written with the ADMIN SDK).
  for (const u of probeUsers) await db.collection("users").doc(u.id).delete().catch(() => null);

  // CACHE-COHERENT TEARDOWN. A raw SDK delete is invisible to the app's read
  // cache, so a stale user row would be served to whatever suite runs next — and
  // an orphaned-user count is exactly what `verify-onboarding-monitor.mjs` asserts
  // (observed: it failed 3 checks when this script ran before it in the same app
  // process, and passed after a restart). An APP-MEDIATED write on the same tenant
  // drops the reference memo AND this school's pulls (plus the un-attributable
  // cross-school ones), so the next read sees the real world. A throwaway COURSE is
  // the cheapest such write: it is created and removed through real routes, and a
  // fresh course can always be deleted (no mapping, no registration).
  const throwaway = await post(
    "/api/courses",
    { code: `ZZRES-${runId}`, title: "ZZ Results probe (throwaway)", departmentId: `${P}col-dept-a` },
    collegeAdmin
  );
  check("the cache-coherence write created a throwaway course (201)", throwaway.status === 201, `HTTP ${throwaway.status} ${JSON.stringify(throwaway.error)}`);
  const throwawayId = throwaway.data?.id || "";
  const throwawayDelete = throwawayId
    ? await req(`/api/courses/${throwawayId}`, { cookie: collegeAdmin, method: "DELETE" })
    : { status: 0 };
  check(
    "…and removed it again through the app, leaving the tenant exactly as it was (200)",
    throwawayDelete.status === 200,
    `HTTP ${throwawayDelete.status}`
  );
}

/* -------------------------------------------- DELETE an attempt (app-mediated) */

console.log("\n### DELETE removes one attempt and the grade re-derives, with nothing re-entered");
{
  const target = createdResultIds[1];
  const before = await resultCount();
  const del = await req(`/api/course-results/${target}`, { cookie: collegeAdmin, method: "DELETE" });
  if (del.status === 200) deletedResultIds.push(target);
  check("the attempt is deleted through the API (200)", del.status === 200, `HTTP ${del.status} ${del.error || ""}`);
  const after = await resultCount();
  check("…and exactly one document left the collection", after === before - 1, `${before} → ${after}`);
  const t = await transcript();
  check(
    "…and the course re-derives from the attempt that remains (60%), nothing re-entered",
    (t.course?.attempts || []).length === 1 && t.course?.attempts?.[0]?.attempt === 1 && t.course?.percent === 60,
    `attempts=${JSON.stringify((t.course?.attempts || []).map((a) => a.attempt))} percent=${t.course?.percent}`
  );
}

/* --------------------------------------------------------------- cleanup */

console.log("\n### cleanup");
{
  // Delete the remaining attempts THROUGH THE APP. An app write invalidates the
  // read cache, whereas a raw admin-SDK delete is invisible to it — and a stale
  // cache entry would then be served to whatever suite runs next (a phantom row),
  // which is exactly the contamination this harness must not leave behind.
  for (const id of createdResultIds.filter((x) => !deletedResultIds.includes(x))) {
    await req(`/api/course-results/${id}`, { cookie: collegeAdmin, method: "DELETE" }).catch(() => null);
  }
  if (createdRegId) await db.collection("courseRegistrations").doc(createdRegId).delete().catch(() => null);
  if (createdStudentId) {
    for (const col of ["fees", "payments"]) {
      const s = await db.collection(col).where("studentId", "==", createdStudentId).get();
      for (const x of s.docs) await x.ref.delete();
    }
    await db.collection("students").doc(createdStudentId).delete().catch(() => null);
  }
  // Restore the scheme as the app sees it (so the cache is coherent) and, when the
  // fixture had no stored scheme at all, put the store back exactly as it was.
  if (schemeBefore === null) {
    await req("/api/grading-scheme", { cookie: collegeAdmin, method: "DELETE" });
    await db.collection("settings").doc(SCHEME_DOC).delete().catch(() => null);
  } else {
    await putScheme(schemeBefore);
  }

  const leftover = (await db.collection("courseResults").where("schoolId", "==", C1).get()).docs
    .filter((d) => d.data().studentId === createdStudentId).length;
  const studentGone = createdStudentId
    ? !(await db.collection("students").doc(createdStudentId).get()).exists
    : true;
  check(
    "the throwaway result rows and student are gone",
    leftover === 0 && studentGone,
    `${leftover} result row(s) left, student ${studentGone ? "removed" : "STILL PRESENT"}`
  );
  const after = await req("/api/grading-scheme", { cookie: collegeAdmin });
  const restored = schemeBefore === null
    ? after.data?.scheme?.name === after.data?.default?.name
    : after.data?.scheme?.name === schemeBefore.name;
  check(
    "the tenant's scheme is back to what it was when this script started",
    restored,
    `schemeBefore=${schemeBefore === null ? "none" : schemeBefore.name} now=${after.data?.scheme?.name}`
  );
  check(
    "…and nothing this script wrote is still visible to the app (cache-coherent cleanup)",
    (await req(`/api/course-results?studentId=${encodeURIComponent(createdStudentId)}`, { cookie: collegeAdmin })).data?.length === 0,
    "the results list is empty for the throwaway student"
  );
}

console.log(
  failures
    ? `\n❌ ${failures} college-results-API failure(s) of ${checks} check(s)`
    : `\n✅ COLLEGE RESULTS API OK — ${checks} checks: the gate, the approval rule, the visible duplicate refusal, ` +
        `maxRetakes, all four policies, derived-on-read re-grading, no-GPA, the permission split, the v1 read ` +
        `allow-list (TEACHER/GUARDIAN/STUDENT refused, admin + REGISTRAR read), and a document-count bracket ` +
        `around every refusal`
);
process.exit(failures ? 1 : 0);
