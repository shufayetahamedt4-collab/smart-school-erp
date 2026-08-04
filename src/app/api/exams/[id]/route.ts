import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { gpaOf, positions } from "@/lib/grades";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "GUARDIAN"].includes(session.role)) {
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

  const subjects = await prisma.subject.findMany({ where: { schoolId: exam.schoolId }, orderBy: { name: "asc" } });
  const students = await prisma.student.findMany({
    where: { schoolId: exam.schoolId, classId: exam.classId, ...(exam.sectionId ? { sectionId: exam.sectionId } : {}) },
    include: { marks: { where: { examId: exam.id } } },
    orderBy: { roll: "asc" },
  });

  const totals = students.map((s) => s.marks.reduce((a: number, m: any) => a + Number(m.obtained), 0));
  const pos = positions(totals);

  const rows = students.map((s) => {
    const bySubject = Object.fromEntries(s.marks.map((m: any) => [m.subjectId, m]));
    const marks = s.marks.map((m: any) => ({ subjectId: m.subjectId, obtained: Number(m.obtained), fullMarks: m.fullMarks, grade: m.grade, gpa: Number(m.gradePoint || 0) }));
    const gpas = marks.map((m: any) => m.gpa);
    const total = s.marks.reduce((a: number, m: any) => a + Number(m.obtained), 0);
    return {
      studentId: s.id,
      name: s.name,
      roll: s.roll,
      admissionNo: s.admissionNo,
      photoUrl: s.photoUrl,
      marks,
      bySubject,
      total,
      gpa: gpaOf(gpas),
      position: pos.get(total),
      absent: s.marks.length === 0,
    };
  });

  return NextResponse.json({ data: { exam, subjects, students: rows } });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam || exam.schoolId !== session.schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
  return NextResponse.json({ data: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const exam = await prisma.exam.findUnique({ where: { id } });
  if (!exam || exam.schoolId !== session.schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  await prisma.$transaction([
    prisma.examMark.deleteMany({ where: { examId: id } }),
    prisma.exam.delete({ where: { id } }),
  ]);
  await audit("EXAM_DELETE", "exam", id);
  return NextResponse.json({ data: { ok: true } });
}
