import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit, guardianChildId, guardianChildIds } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { notifyUsers, notifyGuardianOfStudent } from "@/lib/notify";

/**
 * PRD §9.2 — Leave Management (built before Timetable/Substitution per plan).
 * Student leave (submitted by Guardian) + Teacher leave + Admin approval.
 * Approved teacher leave feeds substitution suggestions (§9.2).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;
  const where: any = { schoolId };
  if (sp.get("status")) where.status = sp.get("status");

  if (session.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
    if (teacher) where.teacherId = teacher.id;
  } else if (session.role === "GUARDIAN") {
    // Every child of this family: each row carries the student's name, so
    // listing all of them is unambiguous (and no child's leave disappears).
    const childIds = await guardianChildIds(session);
    if (!childIds.length) return NextResponse.json({ data: [] });
    where.studentId = { in: childIds };
  } else if (!can(session.role, "studentTeacherInfo", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const items = await prisma.leaveRequest.findMany({
    where,
    include: {
      student: { select: { id: true, name: true, classRoom: { select: { name: true } } } },
      teacher: { select: { id: true, name: true } },
      approver: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ data: items });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const fromDate = body?.fromDate ? new Date(body.fromDate) : null;
  const toDate = body?.toDate ? new Date(body.toDate) : fromDate;
  const reason = String(body?.reason || "").trim();
  if (!fromDate || !reason) return NextResponse.json({ error: "From date and reason are required." }, { status: 400 });
  const schoolId = session.schoolId!;

  // Guardian applies for their child (§9.2 student leave via guardian).
  if (session.role === "GUARDIAN") {
    // Apply for the child the guardian names — when it is theirs — else the
    // family's stable default child.
    const studentId = await guardianChildId(session, body?.studentId ? String(body.studentId) : null);
    if (!studentId) return NextResponse.json({ error: "No linked student." }, { status: 400 });
    const leave = await prisma.leaveRequest.create({
      data: { schoolId, studentId, fromDate, toDate, reason, status: "PENDING", type: "STUDENT" },
    });
    await audit("LEAVE_STUDENT_APPLY", "leaveRequest", leave.id);
    return NextResponse.json({ data: leave }, { status: 201 });
  }

  // Teacher applies for own leave.
  if (session.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
    if (!teacher) return NextResponse.json({ error: "Teacher profile missing." }, { status: 404 });
    const leave = await prisma.leaveRequest.create({
      data: { schoolId, teacherId: teacher.id, fromDate, toDate, reason, status: "PENDING", type: "TEACHER" },
    });
    const admins = await prisma.user.findMany({
      where: { schoolId, role: { in: ["SCHOOL_ADMIN"] } },
      select: { id: true },
    });
    await notifyUsers({
      schoolId,
      userIds: admins.map((a) => a.id),
      event: "ADMISSION_STATUS",
      title: "Teacher leave request",
      body: `${teacher.name} requested leave ${fromDate.toLocaleDateString()}–${(toDate || fromDate).toLocaleDateString()}.`,
      link: "/dashboard/leaves",
    });
    await audit("LEAVE_TEACHER_APPLY", "leaveRequest", leave.id);
    return NextResponse.json({ data: leave }, { status: 201 });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

/** Admin approval workflow (§9.2). */
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "studentTeacherInfo", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");

  // Ask for the decision explicitly. The comment used to read
  // `decision === "APPROVED" ? APPROVED : REJECTED`, so a missing or mistyped
  // `decision` silently REJECTED a leave — the one outcome the applicant cannot
  // appeal if nobody notices.
  const decision = String(body?.decision || "").trim().toUpperCase();
  if (decision !== "APPROVED" && decision !== "REJECTED") {
    return NextResponse.json({ error: "decision must be APPROVED or REJECTED." }, { status: 400 });
  }

  const leave = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!leave || leave.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // A decision is terminal. Without this the endpoint happily re-decided a
  // closed request — flipping APPROVED back to REJECTED (reversing an approved
  // absence, and with teacher leave, the substitution plan built on it), or
  // resetting approvedAt so the record no longer showed when it was signed off.
  if (leave.status !== "PENDING") {
    return NextResponse.json(
      { error: `This request was already ${String(leave.status).toLowerCase()}.` },
      { status: 409 }
    );
  }

  const status = decision as "APPROVED" | "REJECTED";
  const updated = await prisma.leaveRequest.update({
    where: { id },
    data: { status, approvedById: session.id, approvedAt: new Date() },
  });
  await audit(`LEAVE_${status}`, "leaveRequest", id);

  // PRD §13 — the applicant is told the decision, not left to re-check the page.
  const approved = status === "APPROVED";
  if (leave.teacherId) {
    const teacher: any = await prisma.teacher.findUnique({ where: { id: String(leave.teacherId) } });
    if (teacher?.userId) {
      await notifyUsers({
        schoolId: session.schoolId!,
        userIds: [teacher.userId],
        event: "LEAVE_DECISION",
        title: approved ? "Your leave was approved" : "Your leave was declined",
        body: `Request for ${new Date(leave.fromDate as any).toLocaleDateString()} was ${approved ? "approved" : "declined"} by ${session.name || "the office"}.`,
        link: "/teacher/leaves",
        excludeUserId: session.id,
      }).catch(() => null);
    }
  } else if (leave.studentId) {
    await notifyGuardianOfStudent(session.schoolId!, String(leave.studentId), {
      event: "LEAVE_DECISION",
      title: approved ? "Leave approved" : "Leave declined",
      body: `Your leave request for ${new Date(leave.fromDate as any).toLocaleDateString()} was ${approved ? "approved" : "declined"}.`,
      link: "/parent/leave",
      excludeUserId: session.id,
    }).catch(() => null);
  }

  return NextResponse.json({ data: updated });
}
