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

  const slots = await prisma.timetableSlot.findMany({
    where,
    include: {
      subject: { select: { name: true } },
      teacher: { select: { id: true, name: true } },
      classRoom: { select: { name: true } },
      section: { select: { name: true } },
    },
    orderBy: [{ dayOfWeek: "asc" }, { period: "asc" }],
    take: 500,
  });
  return NextResponse.json({ data: slots });
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
  const slots = await prisma.timetableSlot.findMany({
    where: { schoolId: session.schoolId!, dayOfWeek },
    include: { teacher: { select: { id: true, name: true } } },
  });

  // Teachers with approved leave that day
  const leaveTeacherIds = new Set(
    (
      await prisma.leaveRequest.findMany({
        where: {
          schoolId: session.schoolId!,
          type: "TEACHER",
          status: "APPROVED",
          fromDate: { lte: date },
          toDate: { gte: date },
        },
        select: { teacherId: true },
      })
    )
      .map((l) => l.teacherId)
      .filter(Boolean)
  );

  const busy = new Set(slots.map((s) => s.teacherId));
  const allTeachers = await prisma.teacher.findMany({
    where: { schoolId: session.schoolId! },
    select: { id: true, name: true },
  });
  const suggestions = allTeachers
    .filter((t) => !busy.has(t.id))
    .map((t) => ({
      ...t,
      available: true,
      isOnLeave: leaveTeacherIds.has(t.id),
    }));
  const affected = slots.filter((s) => s.teacherId && leaveTeacherIds.has(s.teacherId));

  return NextResponse.json({ data: { date: date.toISOString(), affected, suggestions } });
}
