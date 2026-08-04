import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const assignments = await prisma.classAssignment.findMany({
    where: { schoolId },
    include: {
      teacher: { select: { id: true, user: { select: { name: true } } } },
      classRoom: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      subject: { select: { id: true, name: true } },
    },
    orderBy: { classRoom: { order: "asc" } },
  });
  return NextResponse.json({ data: assignments });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const { teacherId, classId, subjectId } = body || {};
  if (!teacherId || !classId || !subjectId) {
    return NextResponse.json({ error: "Teacher, class and subject are required." }, { status: 400 });
  }

  const exists = await prisma.classAssignment.findFirst({
    where: { schoolId, teacherId, classId, subjectId, sectionId: body.sectionId || null },
  });
  if (exists) return NextResponse.json({ error: "Assignment already exists." }, { status: 400 });

  const assignment = await prisma.classAssignment.create({
    data: { schoolId, teacherId, classId, subjectId, sectionId: body.sectionId || null },
  });
  await audit("ASSIGNMENT_CREATE", "assignment", assignment.id);
  return NextResponse.json({ data: assignment }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await prisma.classAssignment.delete({ where: { id } });
  await audit("ASSIGNMENT_DELETE", "assignment", id);
  return NextResponse.json({ data: { ok: true } });
}
