import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, scopeWhere, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { isBlockingRegistration } from "@/lib/registration-status";
import { queryId } from "@/lib/utils";
import {
  finiteNumber,
  loadCollegeScheme,
  readString,
  retakeOf,
  schemeView,
  serveResultRow,
  wholeNumberIn,
  type ServedResultRow,
} from "@/lib/college-results-server";
import { retakeLimitReached } from "@/lib/college-results";

/**
 * College support (Phase 6c) — the college RESULT row (collection
 * `courseResults`), route `/api/course-results`.
 *
 * A result is ONE attempt (`attempt`, 1-based) at ONE course in ONE term of the
 * student's programme, under the tenant's own COLLEGE grading scheme
 * (docs/COLLEGE-DECISIONS.md §23, D-6-17). It is deliberately a SEPARATE
 * collection from the school marks spine (`examMark` → `marks`, LOCKED by
 * D-3-6/D-4a-0): a college mark never touches `marks`, `subjects`, `exams`, the
 * report card or `/api/marks`.
 *
 * The stored row holds the MARKS (`obtained`, `fullMarks`) and the attempt
 * number. The letter, the point and the CGPA are DERIVED at read time from the
 * tenant's scheme (D-6-12), so editing a band re-grades every row with no
 * re-entry — the same promise the school already makes for its own marks.
 *
 * Guard order in EVERY handler:
 *   1. session                          → 401
 *   2. target tenant schoolId           → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId)         → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "attendanceMarks", …)  → 403   (Q5: the grading-scheme module, reused — no new ModuleKey)
 *   5. writeGuard(schoolId)             → 402   (mutations only)
 *   6. a foreign/missing studentId, courseId, programme or mapping → 400 with ONE
 *      message, the same as a non-existent id (never a 404 that would confirm a
 *      row in another tenant exists)
 *   7. canAccessBranch(programme.branchId) → 403   — checked BEFORE the state-
 *      revealing refusals below, so a wrong-branch caller learns nothing about
 *      another branch's registrations
 *   8. the registration must be APPROVED → 409 (only an APPROVED registration is
 *      gradable; PENDING/REJECTED/none is a visible refusal, never a silent skip)
 *   9. the (studentId, courseId, termNumber, attempt) uniqueness → 409, a VISIBLE
 *      refusal, never a silent overwrite (D-6-17)
 *  10. the tenant's `maxRetakes` → 409 naming the limit (D-6-9); an attempt is
 *      never deleted to make room
 *
 * A result stores the `branchId` it inherited from the student's programme, so
 * branch scoping (`scopeWhere`) filters the row directly — the store cannot join.
 */

/** The tenant this request targets — the SUPER_ADMIN's `?schoolId=`, else the session's own. */
function targetSchoolId(
  session: { role: string; schoolId: string | null },
  req: NextRequest
): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

const MAPPING_REQUIRED = "This course is not mapped to the student's programme.";
const NOT_GRADABLE = "Only an approved registration can be graded — approve the registration first.";

/**
 * Join result rows with their course/student/programme in bulk (the store cannot
 * join), tolerating a DANGLING course: a course deleted after its mappings were
 * removed can still be referenced by an old result, so the row is served with the
 * course marked unavailable rather than crashing.
 */
async function enrich(rows: any[], scheme: any): Promise<ServedResultRow[]> {
  const ids = (field: string) => [...new Set(rows.map((r) => r[field]).filter(Boolean))] as string[];
  const [courses, students, programs] = await Promise.all([
    ids("courseId").length ? prisma.course.findMany({ where: { id: { in: ids("courseId") } } }) : [],
    ids("studentId").length ? prisma.student.findMany({ where: { id: { in: ids("studentId") } } }) : [],
    ids("programId").length ? prisma.program.findMany({ where: { id: { in: ids("programId") } } }) : [],
  ]);
  const courseById = new Map<string, any>((courses as any[]).map((c) => [c.id, c]));
  const studentById = new Map<string, any>((students as any[]).map((s) => [s.id, s]));
  const programById = new Map<string, any>((programs as any[]).map((p) => [p.id, p]));
  return rows.map((row) =>
    serveResultRow(scheme, row, {
      course: courseById.get(row.courseId) ?? null,
      student: studentById.get(row.studentId) ?? null,
      program: programById.get(row.programId) ?? null,
    })
  );
}

export async function GET(req: NextRequest) {
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission (Q5: the grading-scheme module, reused)
  if (!can(session.role, "attendanceMarks", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Branch scoping: a result stores the branch it inherited from the programme, so
  // a branch admin sees only its own branch's rows.
  const scoped = session.role === "SUPER_ADMIN" ? { schoolId } : scopeWhere(session);
  const rows = await prisma.courseResult.findMany({ where: scoped });

  // Optional filters, applied in memory ON TOP of the tenant/branch scope, so a
  // foreign id can only ever narrow the result to zero.
  const studentId = queryId(req.nextUrl.searchParams, "studentId");
  const programId = queryId(req.nextUrl.searchParams, "programId");
  const courseId = queryId(req.nextUrl.searchParams, "courseId");
  const termNumber = wholeNumberIn(queryId(req.nextUrl.searchParams, "termNumber"), 1, 1000);
  const filtered = (rows as any[]).filter(
    (r) =>
      (!studentId || r.studentId === studentId) &&
      (!programId || r.programId === programId) &&
      (!courseId || r.courseId === courseId) &&
      (termNumber === null || wholeNumberIn(r.termNumber, 1, 1000) === termNumber)
  );

  // Grading always uses the tenant's COLLEGE scheme (D-6-1/D-6-13) — never a cookie.
  const scheme = await loadCollegeScheme(schoolId, programId);
  const data = (await enrich(filtered, scheme)).sort(
    (a, b) =>
      String(a.studentId).localeCompare(String(b.studentId)) ||
      String(a.courseId).localeCompare(String(b.courseId)) ||
      Number(a.termNumber ?? 0) - Number(b.termNumber ?? 0) ||
      Number(a.attempt ?? 0) - Number(b.attempt ?? 0)
  );
  // The scheme travels with the rows so the active scale is never a guess (D-6-6).
  return NextResponse.json({ data, scheme: schemeView(scheme), retake: retakeOf(scheme) });
}

export async function POST(req: NextRequest) {
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission
  if (!can(session.role, "attendanceMarks", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const studentId = readString(body?.studentId);
  const courseId = readString(body?.courseId);
  if (!studentId) return NextResponse.json({ error: "A student is required." }, { status: 400 });
  if (!courseId) return NextResponse.json({ error: "A course is required." }, { status: 400 });

  // 6. The student must exist in THIS tenant. A missing or foreign id is the SAME
  //    400 — never a 404 that would confirm another tenant's student exists.
  const student: any = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student || student.schoolId !== schoolId) {
    return NextResponse.json({ error: "Student not found in this school." }, { status: 400 });
  }
  if (!student.programId) {
    return NextResponse.json({ error: "The student is not enrolled in a programme." }, { status: 400 });
  }
  const program: any = await prisma.program.findUnique({ where: { id: student.programId } });
  if (!program || program.schoolId !== schoolId) {
    return NextResponse.json({ error: "The student's programme was not found in this school." }, { status: 400 });
  }
  // The course must exist in THIS tenant — the same 400 as a non-existent id.
  const course: any = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || course.schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found in this school." }, { status: 400 });
  }
  // The mapping is what makes a course gradable and what decides its term.
  const mapping: any = await prisma.programCourse.findFirst({ where: { programId: program.id, courseId } });
  if (!mapping) return NextResponse.json({ error: MAPPING_REQUIRED }, { status: 400 });
  const termNumber = wholeNumberIn(mapping.termNumber, 1, 1000);
  if (termNumber === null) {
    return NextResponse.json({ error: "This course has no valid term in the programme." }, { status: 400 });
  }
  // An explicitly supplied termNumber must AGREE with the mapping — the server
  // derives it, and a disagreement is a 400, never silently ignored.
  if (body?.termNumber !== undefined && body?.termNumber !== null && body?.termNumber !== "") {
    if (wholeNumberIn(body.termNumber, 1, 1000) !== termNumber) {
      return NextResponse.json(
        { error: `termNumber must match the term this course is mapped to (${termNumber}).` },
        { status: 400 }
      );
    }
  }

  // 7. Branch confinement follows the PROGRAMME, and it comes BEFORE the
  //    state-revealing refusals below so a wrong-branch caller learns nothing
  //    about another branch's registrations or attempts.
  if (!canAccessBranch(session, program.branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 8. Only an APPROVED registration is gradable (src/lib/registration-status.ts).
  //    A PENDING row, a REJECTED row and no row at all are each a visible
  //    refusal — never a silently recorded mark.
  const registrations: any[] = await prisma.courseRegistration.findMany({
    where: { schoolId, studentId, courseId, termNumber },
  });
  if (!registrations.some((r) => r.status === "APPROVED")) {
    const pending = registrations.some((r) => isBlockingRegistration(r.status));
    return NextResponse.json(
      {
        error: pending
          ? "This registration has not been approved yet — only an approved registration can be graded."
          : NOT_GRADABLE,
      },
      { status: 409 }
    );
  }

  // The marks themselves. A mark above full marks is nonsense, so it is refused
  // rather than stored and printed.
  const obtained = finiteNumber(body?.obtained);
  const fullMarks = finiteNumber(body?.fullMarks);
  if (obtained === null || obtained < 0) {
    return NextResponse.json({ error: "obtained must be a number of 0 or more." }, { status: 400 });
  }
  if (fullMarks === null || fullMarks <= 0) {
    return NextResponse.json({ error: "fullMarks must be a number greater than 0." }, { status: 400 });
  }
  if (obtained > fullMarks) {
    return NextResponse.json({ error: "obtained cannot be greater than fullMarks." }, { status: 400 });
  }

  // The tenant's own scheme decides what the attempt means (D-6-1).
  const scheme = await loadCollegeScheme(schoolId, program.id);
  const retake = retakeOf(scheme);

  const stored: any[] = await prisma.courseResult.findMany({ where: { schoolId, studentId, courseId, termNumber } });
  const attempts = stored.map((r) => wholeNumberIn(r.attempt, 1, 1000)).filter((n): n is number => n !== null);
  const nextAttempt = attempts.length ? Math.max(...attempts) + 1 : 1;

  let attempt = nextAttempt;
  if (body?.attempt !== undefined && body?.attempt !== null && body?.attempt !== "") {
    const asked = wholeNumberIn(body.attempt, 1, 1000);
    if (asked === null) {
      return NextResponse.json({ error: "attempt must be a whole number from 1." }, { status: 400 });
    }
    attempt = asked;
  }

  // 9. The uniqueness of (studentId, courseId, termNumber, attempt) is a VISIBLE
  //    refusal, never a silent overwrite (D-6-17) — this is the check the random
  //    id (6b) exists to make possible.
  if (attempts.includes(attempt)) {
    return NextResponse.json(
      { error: `Attempt ${attempt} already exists for this course in that term.` },
      { status: 409 }
    );
  }

  // 10. The tenant's retake limit (D-6-9), naming the limit. An attempt is never
  //     deleted to make room for a new one.
  if (retakeLimitReached(attempts.length, retake)) {
    const limit = retake.maxRetakes;
    return NextResponse.json(
      {
        error:
          `This course allows ${limit} retake${limit === 1 ? "" : "s"} under the current policy — ` +
          `no further attempt can be recorded.`,
      },
      { status: 409 }
    );
  }

  // The attempt must be the NEXT one: attempts are 1-based and gapless, and the
  // server derives the number, so a supplied one is only ever a confirmation
  // (the same "must agree" rule the registration route applies to termNumber).
  if (attempt !== nextAttempt) {
    return NextResponse.json(
      { error: `The next attempt for this course is ${nextAttempt}.` },
      { status: 400 }
    );
  }

  const created = await prisma.courseResult.create({
    data: {
      schoolId,
      branchId: program.branchId || null,
      studentId,
      courseId,
      programId: program.id,
      termNumber,
      attempt,
      obtained,
      fullMarks,
      recordedById: session.id,
    },
  });
  await audit("RESULT_CREATE", "courseResult", created.id, {
    schoolId,
    studentId,
    courseId,
    programId: program.id,
    termNumber,
    attempt,
  });
  const [served] = await enrich([created], scheme);
  return NextResponse.json({ data: served }, { status: 201 });
}
