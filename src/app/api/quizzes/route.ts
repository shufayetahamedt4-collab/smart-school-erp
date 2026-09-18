import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";

/**
 * PRD §7.2 — Online MCQ/Quiz test module (teacher authoring side).
 * Teacher builds a quiz with MCQ questions (options + correct index + marks);
 * correct answers are never sent to students — grading happens server-side
 * in /api/quizzes/[id]/attempt.
 */

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;

  if (session.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
    const quizzes = await prisma.quiz.findMany({
      where: { schoolId, ...(sp.get("mine") === "1" && teacher ? { teacherId: teacher.id } : {}) },
      include: {
        classRoom: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
        questions: { orderBy: { seq: "asc" }, select: { id: true, seq: true, text: true, options: true, marks: true } },
        attempts: { select: { id: true, score: true, totalMarks: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ data: quizzes });
  }

  // SCHOOL_ADMIN: all quizzes in the school
  if (can(session.role, "attendanceMarks", "full") || session.role === "SCHOOL_ADMIN") {
    const quizzes = await prisma.quiz.findMany({
      where: { schoolId },
      include: {
        classRoom: { select: { id: true, name: true } },
        subject: { select: { id: true, name: true } },
        questions: { select: { id: true } },
        attempts: { select: { id: true } },
      },
      orderBy: { createdAt: "desc" },
    });
    return NextResponse.json({ data: quizzes });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "TEACHER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher profile not found." }, { status: 400 });

  const body = await req.json().catch(() => null);
  const title = String(body?.title || "").trim();
  if (!title || !body?.classId) return NextResponse.json({ error: "Title and class are required." }, { status: 400 });

  const questions = (Array.isArray(body?.questions) ? body.questions : [])
    .filter((q: any) => q?.text && Array.isArray(q?.options) && q.options.length >= 2)
    .map((q: any, i: number) => ({
      seq: i + 1,
      text: String(q.text),
      options: q.options.map((o: any) => String(o)),
      correctIndex: Math.max(0, Math.min(q.options.length - 1, Number(q.correctIndex || 0))),
      marks: Number(q.marks || 1),
    }));
  if (!questions.length) return NextResponse.json({ error: "At least one complete question is required." }, { status: 400 });

  const quiz = await prisma.quiz.create({
    data: {
      schoolId,
      teacherId: teacher.id,
      classId: body.classId,
      sectionId: body.sectionId || null,
      subjectId: body.subjectId || null,
      title,
      description: body?.description || null,
      durationMin: Number(body?.durationMin || 0) || null,
      published: false,
      allowRetake: body?.allowRetake === true,
      questions: { create: questions },
    },
    include: { questions: true },
  });
  await audit("QUIZ_CREATE", "quiz", quiz.id, { title, questions: questions.length });
  return NextResponse.json({ data: quiz }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "TEACHER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const quiz = await prisma.quiz.findUnique({ where: { id } });
  if (!quiz || quiz.schoolId !== schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: any = {};
  if (body.published !== undefined) data.published = !!body.published;
  if (body.allowRetake !== undefined) data.allowRetake = !!body.allowRetake;
  if (body.title !== undefined) data.title = String(body.title);
  if (body.description !== undefined) data.description = body.description || null;
  if (body.durationMin !== undefined) data.durationMin = Number(body.durationMin) || null;

  const updated = await prisma.quiz.update({ where: { id }, data });
  await audit("QUIZ_UPDATE", "quiz", id, data);
  return NextResponse.json({ data: updated });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "TEACHER") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const quiz = await prisma.quiz.findUnique({ where: { id } });
  if (!quiz || quiz.schoolId !== session.schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await prisma.question.deleteMany({ where: { quizId: id } });
  await prisma.quizAttempt.deleteMany({ where: { quizId: id } });
  await prisma.quiz.delete({ where: { id } });
  await audit("QUIZ_DELETE", "quiz", id);
  return NextResponse.json({ data: { ok: true } });
}
