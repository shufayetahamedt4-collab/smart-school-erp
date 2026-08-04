import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { gradeFor } from "@/lib/grades";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const { examId, rows } = body || {};
  if (!examId || !Array.isArray(rows)) return NextResponse.json({ error: "examId and rows[] required." }, { status: 400 });

  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam || exam.schoolId !== schoolId) return NextResponse.json({ error: "Exam not found" }, { status: 404 });

  if (exam.published) {
    return NextResponse.json({ error: "Result is published. Unpublish before editing marks." }, { status: 400 });
  }

  let count = 0;
  await prisma.$transaction(
    rows
      .filter((r: any) => r.studentId && r.subjectId && r.obtained !== undefined && r.obtained !== null && r.obtained !== "")
      .map((r: any) => {
        count++;
        const full = Number(r.fullMarks || 100);
        const obtained = Number(r.obtained);
        const gi = gradeFor(obtained, full);
        return prisma.examMark.upsert({
          where: { examId_studentId_subjectId: { examId, studentId: r.studentId, subjectId: r.subjectId } },
          update: { obtained, fullMarks: full, grade: gi.grade, gradePoint: gi.gpa },
          create: { examId, studentId: r.studentId, subjectId: r.subjectId, fullMarks: full, obtained, grade: gi.grade, gradePoint: gi.gpa },
        });
      })
  );
  await audit("MARKS_SAVE", "exam", examId, { count });
  return NextResponse.json({ data: { ok: true, count } });
}
