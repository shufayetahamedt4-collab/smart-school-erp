import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { scopeWhere } from "@/lib/permissions";
import { resolveBranchId } from "@/lib/branches";
import { writeGuard } from "@/lib/subscription";
import { MIN_ADMIN_PASSWORD } from "@/lib/pilot-guards";

/**
 * A teacher account's password is REQUIRED and never defaulted (pilot P1b item D).
 *
 * This route used to hash `body.password || "Teacher@123"` — one shared literal
 * for every teacher account a school ever created, so anybody who had ever seen
 * this app could sign in as any teacher whose password nobody had changed. The
 * length rule is the app's own new-account rule (`MIN_ADMIN_PASSWORD`, the same
 * one the tenant wizard enforces).
 */
const TEACHER_PASSWORD_RULE = `Set a password of at least ${MIN_ADMIN_PASSWORD} characters for the teacher — a new account is never created with a built-in default password.`;

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
  const password = String(body?.password || "");
  if (!name || !email) return NextResponse.json({ error: "Name and email are required." }, { status: 400 });
  // Decided BEFORE the transaction, so a missing/weak password is a clean 400
  // and no half-created teacher can be left behind.
  if (password.length < MIN_ADMIN_PASSWORD) {
    return NextResponse.json({ error: TEACHER_PASSWORD_RULE }, { status: 400 });
  }

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
        passwordHash: bcrypt.hashSync(password, 10),
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
