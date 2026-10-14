import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import {
  ATTENDANCE_COURSE_REQUIRED,
  ATTENDANCE_STUDENT_REQUIRED,
  readString,
  requireCollegeAttendanceRead,
  serveAttendanceRow,
  targetSchoolId,
} from "@/lib/college-attendance-server";

/**
 * College attendance — ONE STUDENT's history in ONE course (Phase 8 ca-3,
 * docs/COLLEGE-DECISIONS.md §24.8, D-CA-1…D-CA-3).
 *
 * `GET /api/course-attendance/history?courseId=&studentId=` answers "what has this
 * student's register looked like in this course?" — every stored row, in session
 * order (date, then slot), with the status, remark and actor each row already
 * carries. It reads rows only; nothing here marks anything, and the roster rule
 * (D-CA-2) belongs to the register route, not to a history read.
 *
 * Guard order (the college order, proved by `scripts/verify-college-routes.mjs`):
 *   1. session                  → 401
 *   2. target tenant schoolId   → 400
 *   3. requireCollege(schoolId) → 403  FIRST authorization check
 *   4. the READ allow-list      → 403  (admin-level + REGISTRAR)
 *   5. course + student params  → 400
 *   6. the course, IN THIS TENANT and in a reachable branch → else 404
 *   7. the student, IN THIS TENANT and in a reachable branch → else 404
 *      (a foreign or another branch's id behaves as NOT FOUND, never a 403 that
 *      would confirm the row exists)
 */

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
  // 4. the attendance READ allow-list (ca-0)
  const denied = requireCollegeAttendanceRead(session);
  if (denied) return denied;

  // 5. the two ids this read is about
  const courseId = readString(req.nextUrl.searchParams.get("courseId"));
  if (!courseId) return NextResponse.json({ error: ATTENDANCE_COURSE_REQUIRED }, { status: 400 });
  const studentId = readString(req.nextUrl.searchParams.get("studentId"));
  if (!studentId) return NextResponse.json({ error: ATTENDANCE_STUDENT_REQUIRED }, { status: 400 });

  // 6. the course, confined to the tenant and the caller's branch.
  const course: any = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || course.schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  if (!canAccessBranch(session, course.branchId)) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  // 7. the student, confined the same way.
  const student: any = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student || student.schoolId !== schoolId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }
  if (!canAccessBranch(session, student.branchId)) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  // One tenant-scoped query on the pair — scalar equality only, so the collection
  // needs no composite index; the session order is applied in memory.
  const rows: any[] = (await prisma.courseAttendance.findMany({
    where: { schoolId, courseId, studentId },
  })) as any[];

  const served = rows
    .map(serveAttendanceRow)
    .sort((a, b) => a.dateKey.localeCompare(b.dateKey) || a.slot - b.slot);

  return NextResponse.json({
    data: {
      courseId,
      studentId,
      course: {
        id: String(course.id),
        code: course.code ?? null,
        title: course.title ?? null,
      },
      rows: served,
      count: served.length,
    },
  });
}
