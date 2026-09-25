import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit, guardianChildId } from "@/lib/auth";
import { notifyUsers } from "@/lib/notify";

/** PRD §7.1 — Complaint/Feedback Box with tracking status. */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId!;

  if (session.role === "GUARDIAN") {
    const items = await prisma.complaint.findMany({
      where: { schoolId, guardianUserId: session.id },
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    return NextResponse.json({ data: items });
  }

  // Admin/staff: all complaints for the school
  const items = await prisma.complaint.findMany({
    where: { schoolId },
    include: {
      guardian: { select: { id: true, name: true } },
      student: { select: { id: true, name: true, admissionNo: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ data: items });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "GUARDIAN") {
    return NextResponse.json({ error: "Only guardians can submit complaints/feedback." }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const subject = String(body?.subject || "").trim();
  const message = String(body?.message || "").trim();
  if (!subject || !message) return NextResponse.json({ error: "Subject and message are required." }, { status: 400 });

  // Attach the complaint to the child it is about — the one the guardian names
  // (when it is theirs) or the portal's stable default child, never an
  // arbitrary sibling.
  const studentId: string | null = await guardianChildId(session, body?.studentId ? String(body.studentId) : null);
  const complaint = await prisma.complaint.create({
    data: { schoolId: session.schoolId!, guardianUserId: session.id, studentId, subject, message, category: body?.category || "GENERAL", status: "OPEN" },
  });

  // Notify admins
  const admins = await prisma.user.findMany({
    where: { schoolId: session.schoolId, role: { in: ["SCHOOL_ADMIN", "ACCOUNTANT"] } },
    select: { id: true },
  });
  await notifyUsers({
    schoolId: session.schoolId!,
    userIds: admins.map((a) => a.id),
    event: "COMPLAINT_UPDATE",
    title: "New complaint/feedback",
    body: subject,
    link: "/dashboard/complaints",
  });
  await audit("COMPLAINT_CREATE", "complaint", complaint.id);
  return NextResponse.json({ data: complaint }, { status: 201 });
}

/** Admin updates status; guardian gets a tracked notification. */
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role === "GUARDIAN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");
  const complaint = await prisma.complaint.findUnique({ where: { id } });
  if (!complaint || complaint.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const status = ["OPEN", "IN_REVIEW", "RESOLVED", "DISMISSED"].includes(body?.status) ? body.status : "IN_REVIEW";
  const updated = await prisma.complaint.update({
    where: { id },
    data: { status, resolution: body?.resolution || null, resolvedAt: status === "RESOLVED" ? new Date() : null },
  });
  await notifyUsers({
    schoolId: session.schoolId!,
    userIds: [complaint.guardianUserId],
    event: "COMPLAINT_UPDATE",
    title: `Complaint update: ${complaint.subject}`,
    body: `Status is now ${status.replace("_", " ").toLowerCase()}.`,
    link: "/parent/feedback",
  });
  await audit("COMPLAINT_STATUS", "complaint", id, { status });
  return NextResponse.json({ data: updated });
}
