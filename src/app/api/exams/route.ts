import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const classId = req.nextUrl.searchParams.get("classId") || undefined;
  const exams = await prisma.exam.findMany({
    where: { schoolId, ...(classId ? { classId } : {}) },
    include: {
      classRoom: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      _count: { select: { marks: true } },
    },
    orderBy: [{ year: "desc" }, { startDate: "desc" }],
  });
  return NextResponse.json({ data: exams });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const { name, classId, sectionId, year, startDate, endDate } = body || {};
  if (!name || !classId) return NextResponse.json({ error: "Exam name and class are required." }, { status: 400 });

  const exam = await prisma.exam.create({
    data: {
      schoolId,
      name: String(name),
      classId,
      sectionId: sectionId || null,
      year: Number(year || new Date().getFullYear()),
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
    },
  });
  await audit("EXAM_CREATE", "exam", exam.id, { name });
  return NextResponse.json({ data: exam }, { status: 201 });
}
