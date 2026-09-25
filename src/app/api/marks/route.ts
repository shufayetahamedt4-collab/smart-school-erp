import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { isBranchScoped } from "@/lib/permissions";
import { gradeForScheme, resolveExamColumns } from "@/lib/grading";
import { loadScheme } from "@/lib/grading-store";
import { invalidateStats } from "@/lib/stats-cache";
import { invalidateExamsCache } from "@/lib/exams-cache";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const { examId, rows } = body || {};
  if (!examId || !Array.isArray(rows)) return NextResponse.json({ error: "examId and rows[] required." }, { status: 400 });

  const exam = await prisma.exam.findUnique({ where: { id: examId } });
  if (!exam || exam.schoolId !== schoolId) return NextResponse.json({ error: "Exam not found" }, { status: 404 });

  // Branch scoping (PRD §12.3): a branch admin enters marks only for their
  // branch's exam (class) and only for their branch's students.
  let allowedStudentIds: Set<string> | null = null;
  if (isBranchScoped(session)) {
    const cls = exam.classId ? await prisma.classRoom.findUnique({ where: { id: exam.classId } }) : null;
    if (!cls || cls.branchId !== session.branchId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const branchStudents = await prisma.student.findMany({ where: { schoolId, branchId: session.branchId! }, select: { id: true } });
    allowedStudentIds = new Set(branchStudents.map((s) => s.id));
  }

  if (exam.published) {
    return NextResponse.json({ error: "Result is published. Unpublish before editing marks." }, { status: 400 });
  }

  // The school's grading scheme decides every letter and grade point, so the
  // sheet a teacher submits and the report card a guardian prints can never
  // disagree. An exam with explicit columns also fixes which subjects may be
  // marked and what each is out of (src/lib/grading.ts).
  const scheme = await loadScheme(schoolId);
  const declared: any[] = Array.isArray((exam as any).columns) ? (exam as any).columns : [];
  let fullBySubject = new Map<string, number>();
  if (declared.length) {
    const subjects = await prisma.subject.findMany({ where: { schoolId }, select: { id: true, name: true } });
    fullBySubject = new Map(resolveExamColumns(declared, subjects).map((c) => [c.id, c.fullMarks]));
  }
  const onSheet = (subjectId: string) => (declared.length ? fullBySubject.has(subjectId) : true);
  const fullFor = (r: any) => (Number(r.fullMarks) > 0 ? Number(r.fullMarks) : fullBySubject.get(String(r.subjectId)) ?? 100);

  const incoming = rows.filter(
    (r: any) =>
      r.studentId &&
      r.subjectId &&
      r.obtained !== undefined &&
      r.obtained !== null &&
      r.obtained !== "" &&
      onSheet(String(r.subjectId)) &&
      (!allowedStudentIds || allowedStudentIds.has(r.studentId))
  );
  // A mark above its column's full marks would grade as an impossible
  // percentage and quietly inflate a GPA, so refuse the whole save and say so.
  const overFull = incoming.filter((r: any) => Number(r.obtained) > fullFor(r));
  if (overFull.length) {
    return NextResponse.json(
      { error: `${overFull.length} mark(s) are above their column's full marks — correct them before saving.` },
      { status: 400 }
    );
  }

  let count = 0;
  await prisma.$transaction(
    incoming
      .map((r: any) => {
        count++;
        const full = fullFor(r);
        const obtained = Number(r.obtained);
        const gi = gradeForScheme(scheme, obtained, full);
        return prisma.examMark.upsert({
          where: { examId_studentId_subjectId: { examId, studentId: r.studentId, subjectId: r.subjectId } },
          update: { obtained, fullMarks: full, grade: gi.grade, gradePoint: gi.gpa },
          create: { examId, studentId: r.studentId, subjectId: r.subjectId, fullMarks: full, obtained, grade: gi.grade, gradePoint: gi.gpa },
        });
      })
  );
  await audit("MARKS_SAVE", "exam", examId, { count });
  invalidateStats(schoolId, "marks");
  invalidateExamsCache(schoolId); // cached exams list carries _count.marks
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: { ok: true, count } });
}
