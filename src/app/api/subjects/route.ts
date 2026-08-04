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

  const subjects = await prisma.subject.findMany({
    where: { schoolId },
    include: { _count: { select: { assignments: true, homeworks: true } } },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ data: subjects });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  if (!name) return NextResponse.json({ error: "Subject name is required." }, { status: 400 });

  const exists = await prisma.subject.findFirst({ where: { schoolId, name } });
  if (exists) return NextResponse.json({ error: "Subject already exists." }, { status: 400 });

  const subject = await prisma.subject.create({ data: { schoolId, name, code: body.code || null } });
  await audit("SUBJECT_CREATE", "subject", subject.id, { name });
  return NextResponse.json({ data: subject }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await prisma.$transaction([
    prisma.classAssignment.deleteMany({ where: { subjectId: id } }),
    prisma.routine.deleteMany({ where: { subjectId: id } }),
    prisma.homework.deleteMany({ where: { subjectId: id } }),
    prisma.subject.delete({ where: { id } }),
  ]);
  await audit("SUBJECT_DELETE", "subject", id);
  return NextResponse.json({ data: { ok: true } });
}
