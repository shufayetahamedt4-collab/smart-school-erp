import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit, guardianChildId } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { notifyUsers } from "@/lib/notify";

/**
 * PRD §7.1 / §13 — Two-way Live Chat (Teacher ↔ Guardian).
 * Conversations are keyed per (school, teacher-user, guardian-user, student).
 * Polling-based now; the schema supports Firestore realtime listeners later.
 */

function partyKey(teacherUserId: string, guardianUserId: string, studentId: string | null): string {
  return [teacherUserId, guardianUserId, studentId || "-"].join("__");
}

/** GET: list my conversations (with last message + unread count). */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "communication", "view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const conversationId = req.nextUrl.searchParams.get("conversationId");

  // Thread view: return messages of one conversation (and auto-mark read).
  if (conversationId) {
    const conv = await prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        messages: { orderBy: { createdAt: "asc" }, take: 300 },
        teacherUser: { select: { id: true, name: true, role: true } },
        guardianUser: { select: { id: true, name: true, role: true } },
        student: { select: { id: true, name: true } },
      },
    });
    if (!conv || conv.schoolId !== session.schoolId) {
      return NextResponse.json({ error: "Conversation not found" }, { status: 404 });
    }
    if (conv.teacherUserId !== session.id && conv.guardianUserId !== session.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    // mark incoming read
    const unread = conv.messages.filter((m: any) => m.senderId !== session.id && !m.readAt);
    if (unread.length) {
      await prisma.conversationMessage.updateMany({
        where: { id: { in: unread.map((m: any) => m.id) } },
        data: { readAt: new Date() },
      });
    }
    return NextResponse.json({ data: conv });
  }

  // List view: my conversations.
  const conversations = await prisma.conversation.findMany({
    where: {
      schoolId: session.schoolId,
      OR: [{ teacherUserId: session.id }, { guardianUserId: session.id }],
    },
    include: {
      student: { select: { id: true, name: true, classRoom: { select: { name: true } } } },
      teacherUser: { select: { id: true, name: true } },
      guardianUser: { select: { id: true, name: true } },
      messages: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
  });

  const result = await Promise.all(
    conversations.map(async (c) => {
      const unread = await prisma.conversationMessage.count({
        where: { conversationId: c.id, senderId: { not: session.id }, readAt: null },
      });
      const last = c.messages[0];
      const other = c.teacherUserId === session.id ? c.guardianUser : c.teacherUser;
      return {
        id: c.id,
        other: { id: other.id, name: other.name, role: other.role },
        student: c.student,
        lastMessage: last ? { body: last.body, createdAt: last.createdAt, mine: last.senderId === session.id } : null,
        unread,
      };
    })
  );
  return NextResponse.json({ data: result });
}

/** POST: send a message — creates or reuses the conversation. */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "communication", "entry") && !can(session.role, "communication", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const text = String(body?.body || "").trim();
  if (!text) return NextResponse.json({ error: "Message body is required." }, { status: 400 });

  const schoolId = session.schoolId!;
  let teacherUserId: string;
  let guardianUserId: string;
  let studentId: string | null = body?.studentId ? String(body.studentId) : null;

  if (session.role === "GUARDIAN") {
    // Only the guardian's own child can be the subject of a conversation: a
    // body-supplied studentId used to be accepted whenever it belonged to the
    // same school, so one parent could open a thread as another family's child.
    studentId = await guardianChildId(session, studentId);
    const sid = studentId || "";
    const student = sid ? await prisma.student.findUnique({ where: { id: sid } }) : null;
    if (!student || student.schoolId !== schoolId) {
      return NextResponse.json({ error: "No linked student found." }, { status: 400 });
    }
    // Route to the class teacher (first assignment) unless specified.
    let targetTeacherUserId = body?.teacherUserId ? String(body.teacherUserId) : null;
    if (!targetTeacherUserId) {
      const assignment = await prisma.classAssignment.findFirst({
        where: { classId: student.classId || undefined, schoolId },
        include: { teacher: { select: { userId: true } } },
      });
      targetTeacherUserId = assignment?.teacher.userId || null;
    }
    if (!targetTeacherUserId) {
      return NextResponse.json({ error: "No teacher assigned to this class yet." }, { status: 400 });
    }
    teacherUserId = targetTeacherUserId;
    guardianUserId = session.id;
  } else if (session.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
    if (!teacher) return NextResponse.json({ error: "Teacher profile missing." }, { status: 404 });
    teacherUserId = session.id;
    if (!studentId) {
      // Teacher picks a guardian via studentId (required context).
      return NextResponse.json({ error: "studentId is required to start a conversation." }, { status: 400 });
    }
    const student = await prisma.student.findUnique({ where: { id: studentId } });
    if (!student || student.schoolId !== schoolId) {
      return NextResponse.json({ error: "Student not found" }, { status: 404 });
    }
    let gUserId = student.guardianUserId;
    if (!gUserId && student.guardianEmail) {
      gUserId = (await prisma.user.findUnique({ where: { email: student.guardianEmail.toLowerCase() } }))?.id || null;
    }
    if (!gUserId) {
      return NextResponse.json({ error: "This student has no guardian account yet." }, { status: 400 });
    }
    guardianUserId = gUserId;
  } else {
    return NextResponse.json({ error: "Chat is available between teachers and guardians." }, { status: 403 });
  }

  const key = partyKey(teacherUserId, guardianUserId, studentId);
  const conversation = await prisma.conversation.upsert({
    where: { partyKey: key },
    create: {
      schoolId,
      partyKey: key,
      teacherUserId,
      guardianUserId,
      studentId: studentId || null,
      lastMessageAt: new Date(),
    },
    update: { lastMessageAt: new Date() },
  });

  const message = await prisma.conversationMessage.create({
    data: { conversationId: conversation.id, senderId: session.id, body: text },
  });
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastMessageAt: new Date() },
  });

  // Notify the other party (in-app + push)
  const otherId = session.id === teacherUserId ? guardianUserId : teacherUserId;
  await notifyUsers({
    schoolId,
    userIds: [otherId],
    event: "MESSAGE_RECEIVED",
    title: `New message from ${session.name}`,
    body: text.slice(0, 100),
    link: session.role === "GUARDIAN" ? "/teacher/messages" : "/parent/messages",
  });

  await audit("CHAT_SEND", "conversationMessage", message.id);
  return NextResponse.json({ data: { conversationId: conversation.id, message } }, { status: 201 });
}
