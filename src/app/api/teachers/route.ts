import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { scopeWhere } from "@/lib/permissions";
import { resolveBranchId } from "@/lib/branches";
import { writeGuard } from "@/lib/subscription";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  // Branch scoping (PRD §12.3): branch admins only see their own branch.
  // The main admin may drill into any branch via ?branchId= (monitoring).
  const drill = req.nextUrl.searchParams.get("branchId");
  let scoped = session.role === "SUPER_ADMIN" ? { schoolId } : scopeWhere(session);
  if (drill && (session.role === "SCHOOL_ADMIN" || session.role === "SUPER_ADMIN")) {
    scoped = { ...scoped, branchId: drill };
  }

  const [teachers, users, assignments, classes, sections, subjects] = await Promise.all([
    prisma.teacher.findMany({ where: scoped }),
    prisma.user.findMany({ where: scoped, select: { id: true, name: true, email: true, phone: true, photoUrl: true, active: true } }),
    prisma.classAssignment.findMany({ where: scoped, select: { id: true, teacherId: true, classId: true, sectionId: true, subjectId: true } }),
    prisma.classRoom.findMany({ where: scoped, select: { id: true, name: true } }),
    prisma.section.findMany({ where: scoped, select: { id: true, name: true } }),
    prisma.subject.findMany({ where: scoped, select: { id: true, name: true } }),
  ]);

  const userById = new Map(users.map((item: any) => [item.id, item]));
  const classById = new Map(classes.map((item: any) => [item.id, item]));
  const sectionById = new Map(sections.map((item: any) => [item.id, item]));
  const subjectById = new Map(subjects.map((item: any) => [item.id, item]));
  const assignmentsByTeacher = new Map<string, any[]>();
  for (const assignment of assignments) {
    const teacherAssignments = assignmentsByTeacher.get(assignment.teacherId) || [];
    teacherAssignments.push({
      id: assignment.id,
      classRoom: classById.get(assignment.classId) || null,
      section: assignment.sectionId ? sectionById.get(assignment.sectionId) || null : null,
      subject: subjectById.get(assignment.subjectId) || null,
    });
    assignmentsByTeacher.set(assignment.teacherId, teacherAssignments);
  }

  const result = teachers
    .map((teacher: any) => ({
      ...teacher,
      user: userById.get(teacher.userId) || null,
      assignments: assignmentsByTeacher.get(teacher.id) || [],
    }))
    .sort((a: any, b: any) => new Date(b.joinDate || 0).getTime() - new Date(a.joinDate || 0).getTime());
  return NextResponse.json({ data: result });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked; // PRD §12.1 — subscription auto-lock
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  if (!name || !email) return NextResponse.json({ error: "Name and email are required." }, { status: 400 });

  if (await prisma.user.findUnique({ where: { email } })) {
    return NextResponse.json({ error: "Email already in use." }, { status: 400 });
  }

  const branchId = await resolveBranchId(session, body?.branchId || null);
  const teacher = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        name,
        role: "TEACHER",
        schoolId,
        branchId,
        passwordHash: bcrypt.hashSync(body.password || "Teacher@123", 10),
        photoUrl: body.photoUrl || null,
      },
    });
    return tx.teacher.create({
      data: {
        userId: user.id,
        schoolId,
        branchId,
        designation: body.designation || null,
        qualification: body.qualification || null,
        phone: body.phone || null,
        address: body.address || null,
        joinDate: body.joinDate ? new Date(body.joinDate) : new Date(),
      },
    });
  });

  await audit("TEACHER_CREATE", "teacher", teacher.id, { name, branchId });
  invalidateReferenceCache(schoolId); // teacher + user docs feed the memoized name/reference maps
  return NextResponse.json({ data: teacher }, { status: 201 });
}
