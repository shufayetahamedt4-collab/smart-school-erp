import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const classes = await prisma.classRoom.findMany({
    where: { schoolId },
    include: {
      sections: { orderBy: { name: "asc" }, include: { _count: { select: { students: true } } } },
      _count: { select: { students: true } },
    },
    orderBy: { order: "asc" },
  });
  return NextResponse.json({ data: classes });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
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
  return NextResponse.json({ data: cls }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
  return NextResponse.json({ data: { ok: true } });
}
