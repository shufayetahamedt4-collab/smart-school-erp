import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, resolveActingStudent } from "@/lib/auth";

/**
 * PRD §7.2 — published quizzes for the acting child's class, with their own
 * attempt state.
 *
 * There is no student app: a STUDENT session (kept for the API/permission
 * layer) and a GUARDIAN session both resolve to the same child through
 * resolveActingStudent, so families take quizzes in the Parents App.
 */
export async function GET() {
  const session = await getSession();
  if (!session || !["STUDENT", "GUARDIAN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const student = await resolveActingStudent(session);
  if (!student) return NextResponse.json({ data: [] });

  const quizzes = await prisma.quiz.findMany({
    where: { schoolId: student.schoolId, published: true, OR: [{ classId: student.classId || undefined }, { classId: null }] },
    include: {
      subject: { select: { name: true } },
      classRoom: { select: { name: true } },
      questions: { select: { id: true } },
      attempts: { where: { studentId: student.id }, select: { id: true, score: true, totalMarks: true, submittedAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  return NextResponse.json({
    data: quizzes.map((q: any) => ({
      id: q.id,
      title: q.title,
      description: q.description,
      durationMin: q.durationMin,
      subject: q.subject?.name || null,
      className: q.classRoom?.name || null,
      questionCount: q.questions.length,
      attempt: q.attempts[0] || null,
    })),
  });
}
