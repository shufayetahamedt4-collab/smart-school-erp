import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "GUARDIAN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;

  let where: any = { schoolId };
  let mySubmissionMap: Record<string, string> | null = null;

  if (session.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
    if (teacher && sp.get("mine") === "1") where.teacherId = teacher.id;
  }

  if (session.role === "GUARDIAN") {
    const studentId = session.studentId;
    const student = studentId
      ? await prisma.student.findUnique({ where: { id: studentId } })
      : await prisma.student.findFirst({ where: { guardianUserId: session.id } });
    if (!student) return NextResponse.json({ data: [] });
    where = { schoolId, classId: student.classId || undefined };
    if (student.sectionId) where.sectionId = student.sectionId;
    const subs = await prisma.homeworkSubmission.findMany({ where: { studentId: student.id } });
    mySubmissionMap = Object.fromEntries(subs.map((s) => [s.homeworkId, s.status]));
  }

  if (sp.get("classId")) where.classId = sp.get("classId");
  if (sp.get("subjectId")) where.subjectId = sp.get("subjectId");

  const homeworks = await prisma.homework.findMany({
    where,
    include: {
      subject: { select: { id: true, name: true } },
      teacher: { select: { id: true, user: { select: { name: true } } } },
      classRoom: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      submissions: { select: { id: true, status: true, submittedAt: true } },
    },
    orderBy: { createdAt: "desc" },
  });

  const data = homeworks.map((h) => ({
    ...h,
    submittedCount: h.submissions.filter((s: any) => s.status === "SUBMITTED").length,
    totalStudents: 0,
    myStatus: mySubmissionMap ? mySubmissionMap[h.id] || (h.dueDate && new Date(h.dueDate) < new Date() ? "OVERDUE" : "PENDING") : null,
  }));
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "TEACHER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
  if (!teacher) return NextResponse.json({ error: "Teacher profile not found." }, { status: 400 });

  const body = await req.json().catch(() => null);
  const { classId, sectionId, subjectId, title, description, attachmentUrl, dueDate } = body || {};
  if (!classId || !title) return NextResponse.json({ error: "Class and title are required." }, { status: 400 });

  const homework = await prisma.homework.create({
    data: {
      schoolId,
      classId,
      sectionId: sectionId || null,
      subjectId: subjectId || null,
      teacherId: teacher.id,
      title: String(title),
      description: description || null,
      attachmentUrl: attachmentUrl || null,
      dueDate: dueDate ? new Date(dueDate) : null,
    },
  });
  await audit("HOMEWORK_CREATE", "homework", homework.id, { title });
  return NextResponse.json({ data: homework }, { status: 201 });
}
