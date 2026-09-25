import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit, guardianChildId } from "@/lib/auth";
import { isBranchScoped } from "@/lib/permissions";
import { positions } from "@/lib/grades";
import { gradeForScheme, gpaOfScheme, resolveExamColumns } from "@/lib/grading";
import { loadScheme } from "@/lib/grading-store";
import { writeGuard } from "@/lib/subscription";
import { invalidateExamsCache } from "@/lib/exams-cache";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER", "GUARDIAN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const exam = await prisma.exam.findUnique({
    where: { id },
    include: {
      classRoom: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      school: { select: { name: true, logoUrl: true, address: true, phone: true, email: true } },
    },
  });
  if (!exam || exam.schoolId !== session.schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // PRD §7.2 — a guardian may open only PUBLISHED exams for their own child's
  // class (drafts and other classes must not leak, nor be reachable by id).
  if (session.role === "GUARDIAN") {
    const childId = await guardianChildId(session);
    const child = childId ? await prisma.student.findUnique({ where: { id: childId } }) : null;
    if (!child || !exam.published || exam.classId !== child.classId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  // PRD §12.3 — a branch admin may only open exams of their branch's classes.
  if (isBranchScoped(session)) {
    const cls = exam.classId ? await prisma.classRoom.findUnique({ where: { id: exam.classId } }) : null;
    if (!cls || cls.branchId !== session.branchId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const subjectRows = await prisma.subject.findMany({ where: { schoolId: exam.schoolId }, orderBy: { name: "asc" } });
  const students = await prisma.student.findMany({
    where: { schoolId: exam.schoolId, classId: exam.classId, ...(exam.sectionId ? { sectionId: exam.sectionId } : {}) },
    include: { marks: { where: { examId: exam.id } } },
    orderBy: { roll: "asc" },
  });

  // The school's own grading scheme, and this exam's sheet. `declared` is empty
  // for an exam that never had its columns edited: its sheet is every subject
  // out of 100, exactly as before this became configurable.
  const scheme = await loadScheme(exam.schoolId);
  const declared: any[] = Array.isArray((exam as any).columns) ? (exam as any).columns : [];
  const columns = resolveExamColumns(declared, subjectRows.map((s) => ({ id: s.id, name: s.name })));
  const columnIds = new Set(columns.map((c) => c.id));

  // Grades are recomputed from the CURRENT scheme on every read rather than
  // trusted from the stored fields: editing a band must correct every sheet
  // immediately, not only the rows somebody re-saves afterwards.
  const sheetOf = (marks: any[]) => marks.filter((m: any) => columnIds.has(m.subjectId));
  const totals = students.map((s) => sheetOf(s.marks).reduce((a: number, m: any) => a + Number(m.obtained), 0));
  const pos = positions(totals);

  const rows = students.map((s) => {
    const onSheet = sheetOf(s.marks);
    const marks = onSheet.map((m: any) => {
      const g = gradeForScheme(scheme, Number(m.obtained), Number(m.fullMarks));
      return {
        subjectId: m.subjectId,
        obtained: Number(m.obtained),
        fullMarks: Number(m.fullMarks),
        grade: g.grade,
        gpa: g.gpa,
        percent: g.percent,
        pass: g.pass,
        remark: g.remark,
      };
    });
    const bySubject = Object.fromEntries(marks.map((m: any) => [m.subjectId, m]));
    const total = onSheet.reduce((a: number, m: any) => a + Number(m.obtained), 0);
    const fullTotal = onSheet.reduce((a: number, m: any) => a + Number(m.fullMarks), 0);
    return {
      studentId: s.id,
      name: s.name,
      roll: s.roll,
      admissionNo: s.admissionNo,
      photoUrl: s.photoUrl,
      marks,
      bySubject,
      total,
      fullTotal,
      gpa: gpaOfScheme(scheme, marks.map((m: any) => m.gpa)),
      position: pos.get(total),
      absent: onSheet.length === 0,
    };
  });

  return NextResponse.json({
    data: {
      exam,
      // `subjects` IS the marks sheet (this exam's columns, each with its full
      // marks); `allSubjects` is the school's catalogue, for the column picker.
      subjects: columns,
      allSubjects: subjectRows.map((s) => ({ id: s.id, name: s.name })),
      columnsDeclared: declared.length > 0,
      scheme,
      students: rows,
    },
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const locked = await writeGuard(session.schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam || exam.schoolId !== session.schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // PRD §12.3 — branch admins manage only their branch's classes (both the
  // exam's current class and any class the edit would move it to).
  if (isBranchScoped(session)) {
    const classChecks = [exam.classId, body?.classId].filter(Boolean) as string[];
    for (const cid of classChecks) {
      const c = await prisma.classRoom.findUnique({ where: { id: cid } });
      if (!c || c.branchId !== session.branchId) return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
  }

  const data: any = {};
  for (const key of ["name", "classId", "sectionId", "year"]) {
    if (body?.[key] !== undefined) data[key] = body[key];
  }
  for (const key of ["startDate", "endDate"]) {
    if (body?.[key] !== undefined) data[key] = body[key] ? new Date(body[key]) : null;
  }
  if (body?.published !== undefined) {
    data.published = !!body.published;
    if (body.published && !exam.publishedAt) data.publishedAt = new Date();
  }
  const updated = await prisma.exam.update({ where: { id }, data });
  await audit("EXAM_UPDATE", "exam", id, { published: updated.published });
  invalidateExamsCache(exam.schoolId);
  return NextResponse.json({ data: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const locked = await writeGuard(session.schoolId);
  if (locked) return locked;
  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam || exam.schoolId !== session.schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // PRD §12.3 — a branch admin can only delete exams of their own branch.
  if (isBranchScoped(session)) {
    const cls = exam.classId ? await prisma.classRoom.findUnique({ where: { id: exam.classId } }) : null;
    if (!cls || cls.branchId !== session.branchId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.$transaction([
    prisma.examMark.deleteMany({ where: { examId: id } }),
    prisma.exam.delete({ where: { id } }),
  ]);
  await audit("EXAM_DELETE", "exam", id);
  invalidateExamsCache(exam.schoolId);
  return NextResponse.json({ data: { ok: true } });
}
