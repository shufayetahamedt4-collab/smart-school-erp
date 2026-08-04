import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      classRoom: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      guardianUser: { select: { id: true, name: true, email: true } },
      attendance: { orderBy: { date: "desc" }, take: 30 },
      remarks: { orderBy: { date: "desc" }, take: 10, include: { teacher: { select: { user: { select: { name: true } } } } } },
      fees: { orderBy: { dueDate: "desc" }, include: { payments: { orderBy: { date: "desc" } } } },
      school: { select: { id: true, name: true } },
    },
  });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });
  return NextResponse.json({ data: student });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const allowed = [
    "admissionNo", "name", "dob", "gender", "bloodGroup", "religion", "roll", "registrationNo",
    "classId", "sectionId", "guardianName", "guardianPhone", "guardianEmail", "guardianRelation",
    "emergencyContact", "address", "medicalInfo", "photoUrl", "active", "qrPin",
  ];
  const data: any = {};
  for (const key of allowed) {
    if (body[key] !== undefined) data[key] = key === "dob" || key === "admissionDate" ? (body[key] ? new Date(body[key]) : null) : body[key];
  }

  const student = await prisma.student.update({ where: { id }, data });
  await audit("STUDENT_UPDATE", "student", id);
  return NextResponse.json({ data: student });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  await audit("STUDENT_DELETE", "student", id);
  await prisma.student.delete({ where: { id } });
  return NextResponse.json({ data: { ok: true } });
}
