import { NextRequest, NextResponse } from "next/server";
import { prisma, schoolReference, userNamesFor } from "@/lib/db";
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
    // Single wave: slots + teachers + ALL school bookings; the guardian's
    // student resolved from the memoized students pull (was a sequential
    // findFirst + a bookings child query per slot).
    const [slots, teacherRows, students, bookingRows] = await Promise.all([
      prisma.meetingSlot.findMany({ where: { schoolId, active: true } }),
      schoolReference("teacher", schoolId),
      schoolReference("student", schoolId),
      prisma.meetingBooking.findMany({ where: { schoolId } }),
    ]);
    const student =
      session.studentId
        ? students.find((s: any) => s.id === session.studentId)
        : students.find((s: any) => s.guardianUserId === session.id);
    const teacherById = new Map(teacherRows.map((t) => [t.id, t]));
    const bookedSlotIds = new Set(
      student ? bookingRows.filter((b: any) => b.studentId === student.id).map((b: any) => b.slotId) : []
    );
    const data = slots
      .map((s: any) => ({
        id: s.id,
        teacher: s.teacherId ? teacherById.get(s.teacherId)?.name || "" : "",
        title: s.title,
        startAt: s.startAt,
        durationMin: s.durationMin,
        mode: s.mode,
        booked: bookedSlotIds.has(s.id),
      }))
      .sort((a: any, b: any) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
      .slice(0, 60);
    return NextResponse.json({ data });
  }

  // Staff view with bookings — single wave: slots + teachers + students +
  // all school bookings (was a bookings query per slot, then per-booking
  // and per-name document gets).
  const [slots, teacherRows, studentRows, bookingRows] = await Promise.all([
    prisma.meetingSlot.findMany({ where: { schoolId } }),
    schoolReference("teacher", schoolId),
    schoolReference("student", schoolId),
    prisma.meetingBooking.findMany({ where: { schoolId } }),
  ]);
  const teacherById = new Map(teacherRows.map((t) => [t.id, t]));
  const studentById = new Map(studentRows.map((s: any) => [s.id, s]));
  const bookingsBySlot = new Map<string, any[]>();
  for (const b of bookingRows) {
    const arr = bookingsBySlot.get(b.slotId) || [];
    arr.push(b);
    bookingsBySlot.set(b.slotId, arr);
  }
  const guardianUserIds = [...new Set(bookingRows.map((b: any) => b.guardianUserId).filter(Boolean))];
  const guardianNames = await userNamesFor(guardianUserIds); // memoized users pull
  const guardianById = new Map(guardianUserIds.map((id: string) => [id, { id, name: guardianNames.get(id) || "" }]));
  const data = slots
    .map((s: any) => ({
      ...s,
      teacher: s.teacherId ? teacherById.get(s.teacherId) || null : null,
      bookings: (bookingsBySlot.get(s.id) || []).map((b: any) => ({
        ...b,
        student: b.studentId ? studentById.get(b.studentId) || null : null,
        guardian: b.guardianUserId ? guardianById.get(b.guardianUserId) || null : null,
      })),
    }))
    .sort((a: any, b: any) => new Date(a.startAt).getTime() - new Date(b.startAt).getTime())
    .slice(0, 100);
  return NextResponse.json({ data });
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
        active: true,
        capacity: Number(body?.capacity || 1),
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
  if (slot.bookings.length >= Number(slot.capacity ?? 1)) {
    return NextResponse.json({ error: "This slot is fully booked." }, { status: 400 });
  }

  const booking = await prisma.meetingBooking.upsert({
    where: { slotId_guardianUserId: { slotId, guardianUserId: session.id } },
    create: { schoolId, slotId, guardianUserId: session.id, studentId, status: "BOOKED" },
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
