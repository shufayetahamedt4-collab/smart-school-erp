import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { isBranchScoped } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { invalidateExamsCache } from "@/lib/exams-cache";
import { invalidateStats } from "@/lib/stats-cache";
import { validateColumns } from "@/lib/grading";

/**
 * The columns of an exam's marks sheet.
 *
 * An exam without explicit columns marks EVERY school subject out of 100 (the
 * behaviour the app shipped with). Saving columns fixes the sheet to a chosen
 * set of subjects, each with its own full marks — so an exam can be five
 * subjects out of 100 plus a project out of 50.
 *
 * Editing is open to SCHOOL_ADMIN / BRANCH_ADMIN and TEACHER, because the
 * teacher entering the marks is the person who knows the sheet. A published
 * exam is locked: restructuring a sheet people have already seen would silently
 * change everyone's GPA.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam || exam.schoolId !== schoolId) return NextResponse.json({ error: "Exam not found" }, { status: 404 });

  // PRD §12.3 — a branch admin only edits their branch's classes.
  if (isBranchScoped(session)) {
    const cls = exam.classId ? await prisma.classRoom.findUnique({ where: { id: exam.classId } }) : null;
    if (!cls || cls.branchId !== session.branchId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (exam.published) {
    return NextResponse.json({ error: "Result is published. Unpublish before changing the subject columns." }, { status: 400 });
  }

  const body = await req.json().catch(() => null);
  const subjects = await prisma.subject.findMany({ where: { schoolId }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  const result = validateColumns(body?.columns, subjects);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  // A mark has to leave with its column when the column goes — otherwise it
  // keeps counting in totals and positions without ever being displayed. And a
  // mark has to leave when its column's FULL MARKS change: 85/100 is not 85/50,
  // so keeping it would grade against a denominator the sheet no longer uses.
  //
  // The exam update and the deletes go in ONE batch: a sheet must never end up
  // minus its columns but plus the orphaned marks, or the other way round.
  const newFull = new Map(result.columns.map((c) => [c.subjectId, c.fullMarks]));
  const existing = await prisma.examMark.findMany({
    where: { examId: id },
    select: { id: true, subjectId: true, fullMarks: true },
  });
  const cleared = existing.filter((m) => {
    const keep = newFull.get(String(m.subjectId));
    if (keep === undefined) return true; // column removed
    return Number(m.fullMarks) !== keep; // denominator changed
  });

  await prisma.$transaction([
    prisma.exam.update({ where: { id }, data: { columns: result.columns } }),
    ...cleared.map((m) => prisma.examMark.delete({ where: { id: m.id } })),
  ]);

  await audit("EXAM_COLUMNS_UPDATE", "exam", id, { columns: result.columns.length, clearedMarks: cleared.length });
  invalidateStats(schoolId, "marks");
  invalidateExamsCache(schoolId);
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: { columns: result.columns, clearedMarks: cleared.length } });
}
