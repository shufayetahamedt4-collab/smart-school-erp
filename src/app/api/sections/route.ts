import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { isBranchScoped } from "@/lib/permissions";
import { resolveBranchId } from "@/lib/branches";
import { writeGuard } from "@/lib/subscription";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER", "SUPER_ADMIN", "FRONT_DESK"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  // Branch scoping (PRD §12.3): a branch admin only sees their branch's sections.
  const sections = await prisma.section.findMany({
    where: { schoolId, ...(isBranchScoped(session) ? { branchId: session.branchId } : {}) },
    include: { class: true, _count: { select: { students: true } } },
    orderBy: [{ class: { order: "asc" } }, { name: "asc" }],
  });
  return NextResponse.json({ data: sections });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const classId = String(body?.classId || "");
  const name = String(body?.name || "").trim();
  if (!classId || !name) return NextResponse.json({ error: "Class and section name are required." }, { status: 400 });

  // PRD §12.3 — a branch admin can only add sections to their branch's classes.
  const cls = await prisma.classRoom.findUnique({ where: { id: classId } });
  if (!cls || cls.schoolId !== schoolId) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  if (isBranchScoped(session) && cls.branchId !== session.branchId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const branchId = cls.branchId || (await resolveBranchId(session, null));

  const exists = await prisma.section.findFirst({ where: { classId, name } });
  if (exists) return NextResponse.json({ error: "Section already exists in this class." }, { status: 400 });

  const section = await prisma.section.create({ data: { schoolId, classId, name, branchId } });
  await audit("SECTION_CREATE", "section", section.id, { name });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: section }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // PRD §12.3 — a branch admin can only delete sections of their own branch.
  const section = await prisma.section.findUnique({ where: { id } });
  if (!section || section.schoolId !== schoolId) return NextResponse.json({ error: "Section not found" }, { status: 404 });
  if (isBranchScoped(session)) {
    const cls = section.classId ? await prisma.classRoom.findUnique({ where: { id: section.classId } }) : null;
    if ((section.branchId && section.branchId !== session.branchId) || (cls && cls.branchId !== session.branchId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }
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
