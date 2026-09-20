import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { notifyUsers } from "@/lib/notify";

/**
 * PRD §9.2 — Timetable slots + Teacher-Substitution Automation.
 * Slots are the visual-builder data model (day × period grid).
 * When a teacher has an approved leave on a date, free teachers are suggested.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;

  const where: any = { schoolId };
  if (sp.get("classId")) where.classId = sp.get("classId");
  if (sp.get("sectionId")) where.sectionId = sp.get("sectionId");
  if (sp.get("day")) where.dayOfWeek = Number(sp.get("day"));

  if (session.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
    if (teacher) where.teacherId = teacher.id;
  }

  const [slots, users] = await Promise.all([
    prisma.timetableSlot.findMany({
      where,
      include: {
        subject: { select: { name: true } },
        teacher: { select: { id: true, userId: true } },
        classRoom: { select: { name: true } },
        section: { select: { name: true } },
      },
      orderBy: [{ dayOfWeek: "asc" }, { period: "asc" }],
      take: 500,
    }),
    // Teacher display names live on the linked user doc (teacher has userId).
    prisma.user.findMany({ where: { schoolId }, select: { id: true, name: true } }),
  ]);
  const nameByUser = new Map(users.map((u: any) => [u.id, u.name]));
  const data = slots.map((s: any) => ({
    ...s,
    teacher: s.teacher ? { id: s.teacher.id, name: nameByUser.get(s.teacher.userId) || null } : null,
  }));
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "attendanceMarks", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const { classId, sectionId, subjectId, teacherId, dayOfWeek, period } = body || {};
  if (!classId || !subjectId || !teacherId || dayOfWeek === undefined || period === undefined) {
    return NextResponse.json({ error: "classId, subjectId, teacherId, dayOfWeek and period are required." }, { status: 400 });
  }

  // Teacher double-booking guard (§9.2): the same teacher cannot hold two
  // slots at the same day+period (excluding the cell being replaced).
  const existingSlots = await prisma.timetableSlot.findMany({
    where: { schoolId: session.schoolId!, dayOfWeek: Number(dayOfWeek), period: Number(period) },
    select: { id: true, teacherId: true },
  });
  const replaceId = typeof body?.replaceId === "string" ? body.replaceId : null;
  const clash = existingSlots.find((s: any) => s.teacherId === String(teacherId) && s.id !== replaceId);
  if (clash) {
    return NextResponse.json({ error: "That teacher already has a class in this period. Choose another teacher or period." }, { status: 409 });
  }

  const slot = await prisma.timetableSlot.create({
    data: {
      schoolId: session.schoolId!,
      classId: String(classId),
      sectionId: sectionId ? String(sectionId) : null,
      subjectId: String(subjectId),
      teacherId: String(teacherId),
      dayOfWeek: Number(dayOfWeek),
      period: Number(period),
      startTime: body?.startTime || null,
      endTime: body?.endTime || null,
    },
  });
  await audit("TIMETABLE_SLOT_CREATE", "timetableSlot", slot.id);
  return NextResponse.json({ data: slot }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "attendanceMarks", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await prisma.timetableSlot.deleteMany({ where: { id, schoolId: session.schoolId } });
  return NextResponse.json({ data: { ok: true } });
}

/**
 * Substitution suggestions (§9.2): given a date + absent teacher (approved
 * leave), list teachers with no timetable slot in the same period.
 */
export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "attendanceMarks", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const date = body?.date ? new Date(body.date) : new Date();
  const dayOfWeek = date.getDay();
  const [slots, leaveRows, allTeachers, users] = await Promise.all([
    prisma.timetableSlot.findMany({
      where: { schoolId: session.schoolId!, dayOfWeek },
      include: { teacher: { select: { id: true, userId: true } } },
    }),
    prisma.leaveRequest.findMany({
      where: {
        schoolId: session.schoolId!,
        type: "TEACHER",
        status: "APPROVED",
        fromDate: { lte: date },
        toDate: { gte: date },
      },
      select: { teacherId: true },
    }),
    prisma.teacher.findMany({
      where: { schoolId: session.schoolId! },
      select: { id: true, userId: true },
    }),
    prisma.user.findMany({ where: { schoolId: session.schoolId! }, select: { id: true, name: true } }),
  ]);
  const nameByUser = new Map(users.map((u: any) => [u.id, u.name]));
  const teacherName = (t: any) => (t ? nameByUser.get(t.userId) || null : null);

  // Teachers with approved leave that day
  const leaveTeacherIds = new Set(leaveRows.map((l: any) => l.teacherId).filter(Boolean));

  const busy = new Set(slots.map((s: any) => s.teacherId));
  const suggestions = allTeachers
    .filter((t: any) => !busy.has(t.id))
    .map((t: any) => ({
      id: t.id,
      name: teacherName(t) || "Unnamed teacher",
      available: true,
      isOnLeave: leaveTeacherIds.has(t.id),
    }));
  const affected = slots
    .filter((s: any) => s.teacherId && leaveTeacherIds.has(s.teacherId))
    .map((s: any) => ({ ...s, teacher: { id: s.teacher.id, name: teacherName(s.teacher) } }));

  return NextResponse.json({ data: { date: date.toISOString(), affected, suggestions } });
}
