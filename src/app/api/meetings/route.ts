import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { notifyUsers } from "@/lib/notify";

/**
 * PRD §7.1 — Parent-Teacher Meeting Scheduling.
 * GET   → my slots (staff) / available + my bookings (guardian)
 * POST  → staff publish slots | guardian books a slot
 * PATCH → cancel a booking
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId!;

  if (session.role === "GUARDIAN") {
    const studentId = session.studentId || (await prisma.student.findFirst({ where: { guardianUserId: session.id } }))?.id;
    const slots = await prisma.meetingSlot.findMany({
      where: { schoolId, active: true },
      include: {
        teacher: { select: { id: true, name: true } },
        bookings: studentId ? { where: { studentId } } : false,
      },
      orderBy: { startAt: "asc" },
      take: 60,
    });
    return NextResponse.json({
      data: slots.map((s) => ({
        id: s.id,
        teacher: s.teacher.name,
        title: s.title,
        startAt: s.startAt,
        durationMin: s.durationMin,
        mode: s.mode,
        booked: Array.isArray(s.bookings) && s.bookings.length > 0,
      })),
    });
  }

  // Staff view with bookings
  const slots = await prisma.meetingSlot.findMany({
    where: { schoolId },
    include: {
      teacher: { select: { id: true, name: true } },
      bookings: { include: { student: { select: { id: true, name: true } }, guardian: { select: { name: true } } } },
    },
    orderBy: { startAt: "asc" },
    take: 100,
  });
  return NextResponse.json({ data: slots });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const schoolId = session.schoolId!;

  // Staff publishes a slot
  if (session.role !== "GUARDIAN") {
    if (!can(session.role, "communication", "full")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const startAt = body?.startAt ? new Date(body.startAt) : null;
    if (!startAt) return NextResponse.json({ error: "startAt is required." }, { status: 400 });
    let teacherId = body?.teacherId || null;
    if (!teacherId && session.role === "TEACHER") {
      teacherId = (await prisma.teacher.findUnique({ where: { userId: session.id }, select: { id: true } }))?.id || null;
    }
    const slot = await prisma.meetingSlot.create({
      data: {
        schoolId,
        teacherId,
        title: body?.title || "Parent-Teacher Meeting",
        startAt,
        durationMin: Number(body?.durationMin || 15),
        mode: body?.mode || "IN_PERSON",
        meetingLink: body?.meetingLink || null,
      },
    });
    await audit("PTM_SLOT_CREATE", "meetingSlot", slot.id);
    return NextResponse.json({ data: slot }, { status: 201 });
  }

  // Guardian books a slot
  const slotId = String(body?.slotId || "");
  const studentId = session.studentId || (await prisma.student.findFirst({ where: { guardianUserId: session.id } }))?.id;
  if (!slotId || !studentId) return NextResponse.json({ error: "slotId and a linked student are required." }, { status: 400 });

  const slot = await prisma.meetingSlot.findUnique({ where: { id: slotId }, include: { bookings: true } });
  if (!slot || slot.schoolId !== schoolId) return NextResponse.json({ error: "Slot not found" }, { status: 404 });
  if (slot.bookings.length >= Number(slot.capacity)) {
    return NextResponse.json({ error: "This slot is fully booked." }, { status: 400 });
  }

  const booking = await prisma.meetingBooking.upsert({
    where: { slotId_guardianUserId: { slotId, guardianUserId: session.id } },
    create: { slotId, guardianUserId: session.id, studentId, status: "BOOKED" },
    update: { status: "BOOKED", studentId },
  });

  // Remind the teacher (§7.1 reminders)
  const teacherUserId = (await prisma.teacher.findUnique({ where: { id: slot.teacherId || "" }, select: { userId: true } }))?.userId;
  if (teacherUserId) {
    const student = await prisma.student.findUnique({ where: { id: studentId }, select: { name: true } });
    await notifyUsers({
      schoolId,
      userIds: [teacherUserId],
      event: "PTM_BOOKED",
      title: "PTM slot booked",
      body: `${student?.name || "A student"}'s guardian booked ${new Date(slot.startAt).toLocaleString()}.`,
      link: "/dashboard/meetings",
    });
  }
  await audit("PTM_BOOK", "meetingBooking", booking.id);
  return NextResponse.json({ data: booking }, { status: 201 });
}

/** Cancel a booking (guardian) or deactivate a slot (staff). */
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  if (body?.bookingId) {
    await prisma.meetingBooking.updateMany({
      where: { id: String(body.bookingId), guardianUserId: session.id },
      data: { status: "CANCELLED" },
    });
  }
  if (body?.slotId && session.role !== "GUARDIAN") {
    await prisma.meetingSlot.updateMany({
      where: { id: String(body.slotId), schoolId: session.schoolId },
      data: { active: !!body.active },
    });
  }
  return NextResponse.json({ data: { ok: true } });
}
