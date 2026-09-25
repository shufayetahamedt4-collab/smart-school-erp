import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession, audit, guardianOwnsStudent } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";

/**
 * PRD §7.2 — "Separate, limited-permission login from Guardian (school will
 * decide from which class students receive login access)." POST creates a
 * STUDENT login for a specific student; PATCH grants/revokes portal access.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const locked = await writeGuard(session.schoolId);
  if (locked) return locked;

  const student = await prisma.student.findUnique({ where: { id } });
  if (!student || student.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }
  if (student.userId) return NextResponse.json({ error: "This student already has a login." }, { status: 400 });

  const body = await req.json().catch(() => null);
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (!email || !password) return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  if (password.length < 6) return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
  if (await prisma.user.findUnique({ where: { email } })) {
    return NextResponse.json({ error: "Email already in use." }, { status: 400 });
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: student.name,
      role: "STUDENT",
      schoolId: session.schoolId!,
      active: true,
      passwordHash: bcrypt.hashSync(password, 10),
    },
  });
  await prisma.student.update({ where: { id }, data: { userId: user.id } });
  await audit("STUDENT_LOGIN_CREATE", "user", user.id, { studentId: id });
  return NextResponse.json({ data: { userId: user.id, email } }, { status: 201 });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "SUPER_ADMIN", "GUARDIAN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      classRoom: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      guardianUser: { select: { id: true, name: true, email: true } },
      user: { select: { id: true, email: true, active: true } },
      attendance: { orderBy: { date: "desc" }, take: 30 },
      remarks: { orderBy: { date: "desc" }, take: 10, include: { teacher: { select: { user: { select: { name: true } } } } } },
      fees: { orderBy: { dueDate: "desc" }, include: { payments: { orderBy: { date: "desc" } } } },
      school: { select: { id: true, name: true } },
    },
  });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });
  // Tenant isolation: never let one school's session read another school's
  // student by guessing an id. SUPER_ADMIN is cross-school by design.
  if (session.role !== "SUPER_ADMIN" && student.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }
  // PRD §7.2 — a guardian may read ONLY their own linked child (this is what
  // the Attendance, Remarks and Exam Results pages load). Credential fields
  // (the child's QR token/PIN) are stripped from the response.
  if (session.role === "GUARDIAN") {
    // Own child or a sibling the family link put in the same household (§5.4) —
    // the same rule the printable marksheet/report card/id card pages use.
    const own = await guardianOwnsStudent(session, student);
    if (!own || student.schoolId !== session.schoolId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { qrPin, qrToken, ...safe } = student as any;
    return NextResponse.json({ data: safe });
  }
  return NextResponse.json({ data: student });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const locked = await writeGuard(session.schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const student = await prisma.student.findUnique({ where: { id } });
  if (!student || student.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  const allowed = [
    "admissionNo", "name", "dob", "gender", "bloodGroup", "religion", "roll", "registrationNo",
    "classId", "sectionId", "guardianName", "guardianPhone", "guardianEmail", "guardianRelation",
    "emergencyContact", "address", "medicalInfo", "photoUrl", "active", "qrPin",
  ];
  const data: any = {};
  for (const key of allowed) {
    if (body[key] !== undefined) data[key] = key === "dob" || key === "admissionDate" ? (body[key] ? new Date(body[key]) : null) : body[key];
  }
  // PRD §7.2 — revoke student portal access (deactivate the login, keep data).
  if (body.portalAccess === false && student.userId) {
    await prisma.user.update({ where: { id: student.userId }, data: { active: false } });
  }
  if (body.portalAccess === true && student.userId) {
    await prisma.user.update({ where: { id: student.userId }, data: { active: true } });
  }

  const updated = await prisma.student.update({ where: { id }, data });
  await audit("STUDENT_UPDATE", "student", id);
  invalidateStats(session.schoolId, "students");
  return NextResponse.json({ data: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const locked = await writeGuard(session.schoolId);
  if (locked) return locked;
  await audit("STUDENT_DELETE", "student", id);
  invalidateStats(session.schoolId, "students");
  await prisma.student.delete({ where: { id } });
  return NextResponse.json({ data: { ok: true } });
}
