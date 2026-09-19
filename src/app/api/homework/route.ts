import { NextRequest, NextResponse } from "next/server";
import { prisma, schoolReference, userNamesFor, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "GUARDIAN", "STUDENT"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;

  // Stage 1 (memoized — warm after first navigation): identity + teacher maps.
  const [students, teachers] = await Promise.all([
    schoolReference("student", schoolId),
    schoolReference("teacher", schoolId),
  ]);
  const studentById = new Map(students.map((s: any) => [s.id, s]));
  const teacherByUser = new Map(teachers.map((t: any) => [t.userId, t]));

  // Role scoping (same precedence as before: role scope first, then query params).
  let where: any = { schoolId };
  let mySubmissionMap: Record<string, string> | null = null;
  let scopedStudentId: string | null = null;

  if (session.role === "TEACHER") {
    const teacher = teacherByUser.get(session.id);
    if (teacher && sp.get("mine") === "1") where.teacherId = teacher.id;
  } else if (session.role === "GUARDIAN") {
    const student = session.studentId
      ? studentById.get(session.studentId)
      : students.find((s: any) => s.guardianUserId === session.id);
    if (!student) return NextResponse.json({ data: [] });
    where = { schoolId, classId: student.classId || undefined };
    if (student.sectionId) where.sectionId = student.sectionId;
    scopedStudentId = student.id;
  } else if (session.role === "STUDENT") {
    // PRD §7.2 — students see homework for their own class, with their own
    // submission status (and submitted file link).
    const student = students.find((s: any) => s.userId === session.id);
    if (!student) return NextResponse.json({ data: [] });
    where = { schoolId, classId: student.classId || undefined };
    if (student.sectionId) where.sectionId = student.sectionId;
    scopedStudentId = student.id;
  }

  if (sp.get("classId")) where.classId = sp.get("classId");
  if (sp.get("subjectId")) where.subjectId = sp.get("subjectId");

  // Stage 2 — single parallel wave: homework + all submissions (grouped in
  // memory, was one child query per homework) + reference maps + teacher
  // display names in one users pull (was sequential per-user gets).
  const [homeworks, subjectRows, classRows, sectionRows, submissionRows, userNames] = await Promise.all([
    prisma.homework.findMany({ where }),
    schoolReference("subject", schoolId),
    schoolReference("classRoom", schoolId),
    schoolReference("section", schoolId),
    prisma.homeworkSubmission.findMany({ where: { schoolId } }),
    userNamesFor(teachers.map((t: any) => t.userId)),
  ]);

  if (scopedStudentId) {
    // PRD §7.2 — guardians/students see their own submission status.
    const mine = submissionRows.filter((s: any) => s.studentId === scopedStudentId);
    mySubmissionMap = Object.fromEntries(mine.map((s) => [s.homeworkId, s.status]));
  }

  const subjectById = new Map(subjectRows.map((s) => [s.id, s]));
  const teacherById = new Map(teachers.map((t) => [t.id, t]));
  const classById = new Map(classRows.map((c) => [c.id, c]));
  const sectionById = new Map(sectionRows.map((s) => [s.id, s]));
  const subsByHomework = new Map<string, any[]>();
  for (const s of submissionRows) {
    const arr = subsByHomework.get(s.homeworkId) || [];
    arr.push(s);
    subsByHomework.set(s.homeworkId, arr);
  }

  const data = homeworks
    .map((h) => {
      const subs = (subsByHomework.get(h.id) || []).map((s: any) => ({ id: s.id, status: s.status, submittedAt: s.submittedAt }));
      const t = h.teacherId ? teacherById.get(h.teacherId) : null;
      return {
        ...h,
        subject: h.subjectId ? subjectById.get(h.subjectId) || null : null,
        teacher: t ? { id: t.id, user: { name: userNames.get(t.userId) || "" } } : null,
        classRoom: h.classId ? classById.get(h.classId) || null : null,
        section: h.sectionId ? sectionById.get(h.sectionId) || null : null,
        submissions: subs,
        submittedCount: subs.filter((s: any) => s.status === "SUBMITTED").length,
        totalStudents: 0,
        myStatus: mySubmissionMap ? mySubmissionMap[h.id] || (h.dueDate && new Date(h.dueDate) < new Date() ? "OVERDUE" : "PENDING") : null,
      };
    })
    .sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "TEACHER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked; // PRD §12.1 — subscription auto-lock
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
  invalidateStats(schoolId, "homework");
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: homework }, { status: 201 });
}
