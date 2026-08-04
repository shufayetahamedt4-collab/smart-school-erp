import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const teachers = await prisma.teacher.findMany({
    where: { schoolId },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, photoUrl: true, active: true } },
      assignments: {
        select: {
          id: true,
          classRoom: { select: { name: true } },
          section: { select: { name: true } },
          subject: { select: { name: true } },
        },
      },
      _count: { select: { homeworks: true } },
    },
    orderBy: { joinDate: "desc" },
  });
  return NextResponse.json({ data: teachers });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  if (!name || !email) return NextResponse.json({ error: "Name and email are required." }, { status: 400 });

  if (await prisma.user.findUnique({ where: { email } })) {
    return NextResponse.json({ error: "Email already in use." }, { status: 400 });
  }

  const teacher = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email,
        name,
        role: "TEACHER",
        schoolId,
        passwordHash: bcrypt.hashSync(body.password || "Teacher@123", 10),
        photoUrl: body.photoUrl || null,
      },
    });
    return tx.teacher.create({
      data: {
        userId: user.id,
        schoolId,
        designation: body.designation || null,
        qualification: body.qualification || null,
        phone: body.phone || null,
        address: body.address || null,
        joinDate: body.joinDate ? new Date(body.joinDate) : new Date(),
      },
    });
  });

  await audit("TEACHER_CREATE", "teacher", teacher.id, { name });
  return NextResponse.json({ data: teacher }, { status: 201 });
}
