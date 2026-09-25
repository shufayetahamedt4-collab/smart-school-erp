import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { scopeWhere, isBranchScoped } from "@/lib/permissions";
import { resolveBranchId } from "@/lib/branches";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  // Branch scoping (PRD §12.3): a branch admin only sees their own branch's rows.
  const scoped = session.role === "SUPER_ADMIN" ? { schoolId } : scopeWhere(session);

  const [classes, sections, students] = await Promise.all([
    prisma.classRoom.findMany({ where: scoped, select: { id: true, name: true, order: true } }),
    prisma.section.findMany({ where: scoped, select: { id: true, classId: true, name: true } }),
    prisma.student.findMany({ where: scoped, select: { classId: true, sectionId: true } }),
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
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  if (!name) return NextResponse.json({ error: "Class name is required." }, { status: 400 });

  const exists = await prisma.classRoom.findFirst({ where: { schoolId, name } });
  if (exists) return NextResponse.json({ error: "Class already exists." }, { status: 400 });

  // New classes belong to the caller's branch (a branch admin is confined to
  // their own branch; a school admin picks explicitly or defaults to main campus).
  const branchId = await resolveBranchId(session, body?.branchId || null);
  const cls = await prisma.classRoom.create({ data: { schoolId, name, order: Number(body.order || 0), branchId } });
  if (body.sections && Array.isArray(body.sections)) {
    await prisma.section.createMany({
      data: body.sections.filter(Boolean).map((s: string) => ({ schoolId, classId: cls.id, name: String(s), branchId })),
    });
  }
  await audit("CLASS_CREATE", "class", cls.id, { name, branchId });
  invalidateStats(schoolId, "classes");
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: cls }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const cls = await prisma.classRoom.findUnique({ where: { id } });
  if (!cls || cls.schoolId !== schoolId) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  if (isBranchScoped(session) && cls.branchId !== session.branchId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
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
