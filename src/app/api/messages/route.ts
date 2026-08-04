import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "GUARDIAN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const messages = await prisma.message.findMany({
    where: { schoolId, OR: [{ senderId: session.id }, { receiverId: session.id }] },
    include: {
      sender: { select: { id: true, name: true, role: true } },
      receiver: { select: { id: true, name: true, role: true } },
      student: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  // mark incoming as read
  const unreadIds = messages.filter((m) => m.receiverId === session.id && !m.readAt).map((m) => m.id);
  if (unreadIds.length) {
    await prisma.message.updateMany({ where: { id: { in: unreadIds } }, data: { readAt: new Date() } });
  }

  return NextResponse.json({ data: messages });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "GUARDIAN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const { receiverId, body: text, studentId } = body || {};
  if (!receiverId || !text) return NextResponse.json({ error: "Receiver and message are required." }, { status: 400 });

  const receiver = await prisma.user.findUnique({ where: { id: receiverId } });
  if (!receiver || receiver.schoolId !== schoolId) return NextResponse.json({ error: "Receiver not found" }, { status: 404 });

  const message = await prisma.message.create({
    data: { schoolId, senderId: session.id, receiverId, studentId: studentId || null, body: String(text) },
  });
  await audit("MESSAGE_SEND", "message", message.id);
  return NextResponse.json({ data: message }, { status: 201 });
}
