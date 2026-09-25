import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit, resolveActingStudent } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";

/**
 * PRD §7.2 — quiz taking with server-side auto-grading.
 * GET  → quiz questions WITHOUT the answer key (published quizzes, own class)
 * POST → submit answers → graded here → score stored in quizAttempt
 *
 * Taken in the Parents App: a GUARDIAN session resolves to their own child
 * (resolveActingStudent), a STUDENT session to themselves. Grading and the
 * attempt record stay keyed to the child, so the answer key never leaves the
 * server and one attempt is recorded per child.
 */
const FAMILY_ROLES = ["STUDENT", "GUARDIAN"];

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !FAMILY_ROLES.includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const student = await resolveActingStudent(session);
  if (!student) return NextResponse.json({ error: "No student record linked to this account." }, { status: 404 });

  const quiz = await prisma.quiz.findUnique({
    where: { id },
    include: { questions: { orderBy: { seq: "asc" } } },
  });
  if (!quiz || quiz.schoolId !== student.schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!quiz.published) return NextResponse.json({ error: "Quiz is not published yet." }, { status: 400 });
  if (quiz.classId && quiz.classId !== student.classId) {
    return NextResponse.json({ error: "This quiz is not for your class." }, { status: 403 });
  }

  const prior = await prisma.quizAttempt.findFirst({
    where: { quizId: id, studentId: student.id },
    select: { id: true, score: true, totalMarks: true, submittedAt: true },
  });
  if (prior && !quiz.allowRetake) {
    return NextResponse.json({ error: "You have already taken this quiz." }, { status: 400 });
  }

  // Strip correctIndex — never expose the answer key to the client.
  return NextResponse.json({
    data: {
      quiz: {
        id: quiz.id,
        title: quiz.title,
        description: quiz.description,
        durationMin: quiz.durationMin,
        alreadyTaken: !!prior,
        previousScore: prior ? { score: prior.score, totalMarks: prior.totalMarks } : null,
      },
      questions: quiz.questions.map((q: any) => ({
        id: q.id,
        seq: q.seq,
        text: q.text,
        options: q.options,
        marks: q.marks,
      })),
    },
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !FAMILY_ROLES.includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const student = await resolveActingStudent(session);
  if (!student) return NextResponse.json({ error: "No student record linked to this account." }, { status: 404 });

  const quiz = await prisma.quiz.findUnique({ where: { id }, include: { questions: { orderBy: { seq: "asc" } } } });
  if (!quiz || quiz.schoolId !== student.schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (!quiz.published) return NextResponse.json({ error: "Quiz is not published." }, { status: 400 });
  if (quiz.classId && quiz.classId !== student.classId) {
    return NextResponse.json({ error: "This quiz is not for your class." }, { status: 403 });
  }

  const prior = await prisma.quizAttempt.findFirst({ where: { quizId: id, studentId: student.id }, select: { id: true } });
  if (prior && !quiz.allowRetake) {
    return NextResponse.json({ error: "You have already taken this quiz." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const answers: Record<string, number> = body?.answers || {};

  // Server-side auto-grade (answer key never left the server)
  let score = 0;
  let totalMarks = 0;
  const review = quiz.questions.map((q: any) => {
    totalMarks += Number(q.marks || 0);
    const given = answers[q.id] !== undefined ? Number(answers[q.id]) : null;
    const correct = given !== null && given === Number(q.correctIndex);
    if (correct) score += Number(q.marks || 0);
    return { questionId: q.id, text: q.text, given, correctIndex: Number(q.correctIndex), options: q.options, correct };
  });

  const attempt = await prisma.quizAttempt.upsert({
    where: { quizId_studentId: { quizId: id, studentId: student.id } },
    update: { score, totalMarks, submittedAt: new Date(), answers },
    create: {
      schoolId: student.schoolId,
      quizId: id,
      studentId: student.id,
      score,
      totalMarks,
      answers,
      submittedAt: new Date(),
    },
  });

  await audit("QUIZ_ATTEMPT", "quizAttempt", attempt.id, { quizId: id, score, totalMarks });
  return NextResponse.json({
    data: {
      attemptId: attempt.id,
      score,
      totalMarks,
      pct: totalMarks ? Math.round((score / totalMarks) * 100) : 0,
      review, // post-submit review with correct answers
    },
  });
}
