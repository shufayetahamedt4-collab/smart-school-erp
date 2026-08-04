import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const teacher = await prisma.teacher.findUnique({
    where: { id },
    include: {
      user: { select: { id: true, name: true, email: true, phone: true, photoUrl: true, active: true } },
      assignments: {
        include: { classRoom: { select: { id: true, name: true } }, section: { select: { id: true, name: true } }, subject: { select: { id: true, name: true } } },
      },
    },
  });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });
  return NextResponse.json({ data: teacher });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => null);

  const teacher = await prisma.teacher.findUnique({ where: { id }, include: { user: true } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });

  const data: any = {};
  for (const key of ["designation", "qualification", "phone", "address", "joinDate"]) {
    if (body?.[key] !== undefined) data[key] = key === "joinDate" ? (body[key] ? new Date(body[key]) : null) : body[key];
  }
  if (body?.name) data.user = { update: { name: body.name } };
  if (body?.active !== undefined) data.user = { update: { ...(data.user?.update || {}), active: body.active } };

  const updated = await prisma.teacher.update({ where: { id }, data });
  await audit("TEACHER_UPDATE", "teacher", id);
  return NextResponse.json({ data: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const teacher = await prisma.teacher.findUnique({ where: { id } });
  if (!teacher) return NextResponse.json({ error: "Teacher not found" }, { status: 404 });
  await audit("TEACHER_DELETE", "teacher", id);
  await prisma.$transaction([
    prisma.classAssignment.deleteMany({ where: { teacherId: id } }),
    prisma.teacher.delete({ where: { id } }),
    prisma.user.delete({ where: { id: teacher.userId } }),
  ]);
  return NextResponse.json({ data: { ok: true } });
}
