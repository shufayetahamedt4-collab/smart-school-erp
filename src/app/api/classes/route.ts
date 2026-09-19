import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const [classes, sections, students] = await Promise.all([
    prisma.classRoom.findMany({ where: { schoolId }, select: { id: true, name: true, order: true } }),
    prisma.section.findMany({ where: { schoolId }, select: { id: true, classId: true, name: true } }),
    prisma.student.findMany({ where: { schoolId }, select: { classId: true, sectionId: true } }),
  ]);
  const classCounts = new Map<string, number>();
  const sectionCounts = new Map<string, number>();
  for (const student of students) {
    if (student.classId) classCounts.set(student.classId, (classCounts.get(student.classId) || 0) + 1);
    if (student.sectionId) sectionCounts.set(student.sectionId, (sectionCounts.get(student.sectionId) || 0) + 1);
  }
  const sectionsByClass = new Map<string, any[]>();
  for (const section of sections) {
    const classSections = sectionsByClass.get(section.classId) || [];
    classSections.push({ ...section, _count: { students: sectionCounts.get(section.id) || 0 } });
    sectionsByClass.set(section.classId, classSections);
  }
  const result = classes
    .map((classRoom: any) => ({
      ...classRoom,
      _count: { students: classCounts.get(classRoom.id) || 0 },
      sections: (sectionsByClass.get(classRoom.id) || []).sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
  return NextResponse.json({ data: result });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  if (!name) return NextResponse.json({ error: "Class name is required." }, { status: 400 });

  const exists = await prisma.classRoom.findFirst({ where: { schoolId, name } });
  if (exists) return NextResponse.json({ error: "Class already exists." }, { status: 400 });

  const cls = await prisma.classRoom.create({ data: { schoolId, name, order: Number(body.order || 0) } });
  if (body.sections && Array.isArray(body.sections)) {
    await prisma.section.createMany({
      data: body.sections.filter(Boolean).map((s: string) => ({ schoolId, classId: cls.id, name: String(s) })),
    });
  }
  await audit("CLASS_CREATE", "class", cls.id, { name });
  invalidateStats(schoolId, "classes");
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: cls }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const count = await prisma.student.count({ where: { classId: id } });
  if (count > 0) return NextResponse.json({ error: "Cannot delete a class that has students." }, { status: 400 });
  await prisma.$transaction([
    prisma.section.deleteMany({ where: { classId: id } }),
    prisma.routine.deleteMany({ where: { classId: id } }),
    prisma.classAssignment.deleteMany({ where: { classId: id } }),
    prisma.classRoom.delete({ where: { id } }),
  ]);
  await audit("CLASS_DELETE", "class", id);
  invalidateStats(schoolId, "classes");
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: { ok: true } });
}
