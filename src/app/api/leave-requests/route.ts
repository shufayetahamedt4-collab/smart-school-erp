import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit, guardianChildId, guardianChildIds } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { notifyUsers } from "@/lib/notify";

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
  const leave = await prisma.leaveRequest.findUnique({ where: { id } });
  if (!leave || leave.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const status = body?.decision === "APPROVED" ? "APPROVED" : "REJECTED";
  const updated = await prisma.leaveRequest.update({
    where: { id },
    data: { status, approvedById: session.id, approvedAt: new Date() },
  });
  await audit(`LEAVE_${status}`, "leaveRequest", id);
  return NextResponse.json({ data: updated });
}
