import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, scopeWhere, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { isBlockingRegistration } from "@/lib/registration-status";
import { queryId } from "@/lib/utils";

/**
 * College support (Phase 4b) — course registration (collection
 * `courseRegistrations`), route `/api/course-registrations`.
 *
 * A registration is a student's request to take ONE mapped course in ONE term of
 * their programme. It is created PENDING here and decided (APPROVED/REJECTED) by
 * `PATCH /api/course-registrations/[id]`; a PENDING row may be withdrawn with
 * DELETE. APPROVED and REJECTED are terminal — see `src/lib/registration-status.ts`,
 * the single status machine this route, the decision route and every guard
 * (un-enrol, mapping-delete, course-delete) share.
 *
 * The request carries only `studentId` + `courseId` (an optional `termNumber`
 * must AGREE with the mapping). `programId` and `termNumber` are DERIVED from the
 * student and the programme→course mapping, so there is one source of truth for
 * which term a course belongs to.
 *
 * Guard order in EVERY handler:
 *   1. session                      → 401
 *   2. target tenant schoolId       → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId)     → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "registration", …) → 403
 *   5. writeGuard(schoolId)         → 402   (mutations only)
 *   6. a foreign/missing studentId or courseId → 400 with ONE message, the same
 *      as a non-existent id (never a 404 that would confirm a row in another
 *      tenant exists)
 *   7. canAccessBranch(program.branchId) → 403
 *
 * A registration stores the `branchId` it inherited from the student's programme,
 * so branch scoping (`scopeWhere`) filters the row directly — the store cannot join.
 */

const MAPPING_REQUIRED = "This course is not mapped to the student's programme.";

/** The tenant this request targets — the SUPER_ADMIN's `?schoolId=`, else the session's own. */
function targetSchoolId(
  session: { role: string; schoolId: string | null },
  req: NextRequest
): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

function readString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Join the registrations with their course/student/programme in bulk (the store
 * cannot join), tolerating a DANGLING course: a course deleted after its mapping
 * was removed can still be referenced by a REJECTED row, so the list must show
 * the row with the course marked unavailable rather than crash.
 */
async function enrich(rows: any[]): Promise<any[]> {
  const ids = (field: string) => [...new Set(rows.map((r) => r[field]).filter(Boolean))];
  const [courses, students, programs] = await Promise.all([
    ids("courseId").length ? prisma.course.findMany({ where: { id: { in: ids("courseId") } } }) : [],
    ids("studentId").length ? prisma.student.findMany({ where: { id: { in: ids("studentId") } } }) : [],
    ids("programId").length ? prisma.program.findMany({ where: { id: { in: ids("programId") } } }) : [],
  ]);
  const courseById = new Map<string, any>((courses as any[]).map((c) => [c.id, c]));
  const studentById = new Map<string, any>((students as any[]).map((s) => [s.id, s]));
  const programById = new Map<string, any>((programs as any[]).map((p) => [p.id, p]));
  return rows.map((r) => {
    const course = courseById.get(r.courseId) || null;
    const student = studentById.get(r.studentId) || null;
    const program = programById.get(r.programId) || null;
    return {
      ...r,
      courseCode: course?.code ?? null,
      courseTitle: course?.title ?? null,
      creditHours: course?.creditHours ?? null,
      // A missing course is not an error here — the row is still readable.
      courseAvailable: !!course,
      studentName: student?.name ?? null,
      studentAdmissionNo: student?.admissionNo ?? null,
      programName: program?.name ?? null,
    };
  });
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
  // 4. permission
  if (!can(session.role, "registration", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Branch scoping (PRD §12.3): a branch admin sees only its own branch's rows —
  // a registration stores the branch it inherited from the programme.
  const scoped = session.role === "SUPER_ADMIN" ? { schoolId } : scopeWhere(session);
  const rows = await prisma.courseRegistration.findMany({ where: scoped });

  // Optional filters, applied in memory ON TOP of the tenant/branch scope, so a
  // foreign id can only ever narrow the result to zero.
  const studentId = queryId(req.nextUrl.searchParams, "studentId");
  const programId = queryId(req.nextUrl.searchParams, "programId");
  const courseId = queryId(req.nextUrl.searchParams, "courseId");
  const statusFilter = req.nextUrl.searchParams.get("status");
  const filtered = (rows as any[]).filter((r) =>
    (!studentId || r.studentId === studentId) &&
    (!programId || r.programId === programId) &&
    (!courseId || r.courseId === courseId) &&
    (!statusFilter || r.status === statusFilter)
  );

  const data = (await enrich(filtered)).sort(
    (a, b) =>
      String(a.studentId).localeCompare(String(b.studentId)) ||
      String(a.courseId).localeCompare(String(b.courseId)) ||
      Number(a.termNumber) - Number(b.termNumber)
  );
  return NextResponse.json({ data });
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
  if (!can(session.role, "registration", "full")) {
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
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student || (student as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Student not found in this school." }, { status: 400 });
  }
  // The student must be enrolled in a programme (4a): with no programme there is
  // no term list to register against.
  if (!(student as any).programId) {
    return NextResponse.json({ error: "The student is not enrolled in a programme." }, { status: 400 });
  }
  const program = await prisma.program.findUnique({ where: { id: (student as any).programId } });
  if (!program || (program as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "The student's programme was not found in this school." }, { status: 400 });
  }

  // The course must exist in THIS tenant — the same 400 as a non-existent id.
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || (course as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found in this school." }, { status: 400 });
  }

  // The course must be MAPPED to the student's programme — the mapping is the
  // programme's term list, so it also decides the term.
  const mapping = await prisma.programCourse.findFirst({ where: { programId: program.id, courseId } });
  if (!mapping) {
    return NextResponse.json({ error: MAPPING_REQUIRED }, { status: 400 });
  }
  const termNumber = Number((mapping as any).termNumber);

  // An explicitly supplied termNumber must AGREE with the mapping — the server
  // derives it, and a disagreement is a 400, never silently ignored.
  if (body?.termNumber !== undefined && body?.termNumber !== null) {
    if (Number(body.termNumber) !== termNumber) {
      return NextResponse.json(
        { error: `termNumber must match the term this course is mapped to (${termNumber}).` },
        { status: 400 }
      );
    }
  }

  // 7. Branch confinement follows the PROGRAMME (the same rule the mapping uses).
  if (!canAccessBranch(session, (program as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // A student may hold the same (course, term) only once — among the rows that
  // still hold a place (PENDING/APPROVED). A REJECTED row never blocks a retry.
  const existing = await prisma.courseRegistration.findMany({
    where: { schoolId, studentId, courseId, termNumber },
  });
  if ((existing as any[]).some((r) => isBlockingRegistration(r.status))) {
    return NextResponse.json(
      { error: "This student is already registered for that course in that term." },
      { status: 409 }
    );
  }

  const registration = await prisma.courseRegistration.create({
    data: {
      schoolId,
      branchId: (program as any).branchId || null,
      studentId,
      courseId,
      programId: program.id,
      termNumber,
      status: "PENDING",
      requestedById: session.id,
    },
  });
  await audit("REGISTRATION_CREATE", "courseRegistration", registration.id, {
    schoolId,
    studentId,
    courseId,
    programId: program.id,
    termNumber,
  });
  return NextResponse.json({ data: registration }, { status: 201 });
}
