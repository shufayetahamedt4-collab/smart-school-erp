import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const classId = String(body?.classId || "");
  const name = String(body?.name || "").trim();
  if (!classId || !name) return NextResponse.json({ error: "Class and section name are required." }, { status: 400 });

  const exists = await prisma.section.findFirst({ where: { classId, name } });
  if (exists) return NextResponse.json({ error: "Section already exists in this class." }, { status: 400 });

  const section = await prisma.section.create({ data: { schoolId, classId, name } });
  await audit("SECTION_CREATE", "section", section.id, { name });
  return NextResponse.json({ data: section }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const count = await prisma.student.count({ where: { sectionId: id } });
  if (count > 0) return NextResponse.json({ error: "Cannot delete a section that has students." }, { status: 400 });
  await prisma.$transaction([
    prisma.routine.deleteMany({ where: { sectionId: id } }),
    prisma.classAssignment.deleteMany({ where: { sectionId: id } }),
    prisma.section.delete({ where: { id } }),
  ]);
  await audit("SECTION_DELETE", "section", id);
  return NextResponse.json({ data: { ok: true } });
}
