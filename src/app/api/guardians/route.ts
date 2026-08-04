import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;

  const guardians = await prisma.user.findMany({
    where: { schoolId, role: "GUARDIAN" },
    include: {
      studentOf: {
        select: {
          id: true,
          name: true,
          admissionNo: true,
          roll: true,
          classRoom: { select: { name: true } },
          section: { select: { name: true } },
        },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ data: guardians });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const { email, name, password, studentId } = body || {};
  if (!email || !name || !studentId) {
    return NextResponse.json({ error: "Email, name and student are required." }, { status: 400 });
  }

  const student = await prisma.student.findFirst({ where: { id: studentId, schoolId } });
  if (!student) return NextResponse.json({ error: "Student not found." }, { status: 404 });
  if (student.guardianUserId) {
    return NextResponse.json({ error: "This student already has a guardian account." }, { status: 400 });
  }
  if (await prisma.user.findUnique({ where: { email: String(email).toLowerCase() } })) {
    return NextResponse.json({ error: "Email already in use." }, { status: 400 });
  }

  const user = await prisma.$transaction(async (tx) => {
    const u = await tx.user.create({
      data: {
        email: String(email).toLowerCase(),
        name: String(name),
        role: "GUARDIAN",
        schoolId,
        passwordHash: bcrypt.hashSync(password || "Guardian@123", 10),
      },
    });
    await tx.student.update({ where: { id: studentId }, data: { guardianUserId: u.id, guardianEmail: String(email).toLowerCase(), guardianName: String(name) } });
    return u;
  });
  await audit("GUARDIAN_CREATE", "user", user.id, { email });
  return NextResponse.json({ data: user }, { status: 201 });
}
