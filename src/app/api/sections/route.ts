import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "SUPER_ADMIN", "FRONT_DESK"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const sections = await prisma.section.findMany({
    where: { schoolId },
    include: { class: true, _count: { select: { students: true } } },
    orderBy: [{ class: { order: "asc" } }, { name: "asc" }],
  });
  return NextResponse.json({ data: sections });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const classId = String(body?.classId || "");
  const name = String(body?.name || "").trim();
  if (!classId || !name) return NextResponse.json({ error: "Class and section name are required." }, { status: 400 });

  const exists = await prisma.section.findFirst({ where: { classId, name } });
  if (exists) return NextResponse.json({ error: "Section already exists in this class." }, { status: 400 });

  const section = await prisma.section.create({ data: { schoolId, classId, name } });
  await audit("SECTION_CREATE", "section", section.id, { name });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: section }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
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
