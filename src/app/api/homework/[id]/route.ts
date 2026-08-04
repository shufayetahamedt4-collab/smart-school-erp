import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["TEACHER", "SCHOOL_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);

  const homework = await prisma.homework.findUnique({ where: { id } });
  if (!homework || homework.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (session.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
    if (!teacher || homework.teacherId !== teacher.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const data: any = {};
  for (const key of ["title", "description", "attachmentUrl", "classId", "sectionId", "subjectId"]) {
    if (body?.[key] !== undefined) data[key] = body[key];
  }
  if (body?.dueDate !== undefined) data.dueDate = body.dueDate ? new Date(body.dueDate) : null;

  const updated = await prisma.homework.update({ where: { id }, data });
  await audit("HOMEWORK_UPDATE", "homework", id);
  return NextResponse.json({ data: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["TEACHER", "SCHOOL_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const homework = await prisma.homework.findUnique({ where: { id } });
  if (!homework || homework.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.$transaction([
    prisma.homeworkSubmission.deleteMany({ where: { homeworkId: id } }),
    prisma.homework.delete({ where: { id } }),
  ]);
  await audit("HOMEWORK_DELETE", "homework", id);
  return NextResponse.json({ data: { ok: true } });
}
