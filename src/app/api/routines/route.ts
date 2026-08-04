import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const classId = req.nextUrl.searchParams.get("classId") || undefined;
  const routines = await prisma.routine.findMany({
    where: { schoolId, ...(classId ? { classId } : {}) },
    include: {
      subject: { select: { id: true, name: true } },
      teacher: { select: { id: true, user: { select: { name: true } } } },
      classRoom: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
    },
    orderBy: [{ day: "asc" }, { period: "asc" }],
  });
  return NextResponse.json({ data: routines });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const { classId, rows } = body || {};
  if (!classId || !Array.isArray(rows)) return NextResponse.json({ error: "classId and rows[] required." }, { status: 400 });

  await prisma.$transaction(async (tx) => {
    await tx.routine.deleteMany({ where: { schoolId, classId } });
    const valid = rows.filter((r: any) => r.subjectId && r.day !== undefined && r.period);
    if (valid.length) {
      await tx.routine.createMany({
        data: valid.map((r: any) => ({
          schoolId,
          classId,
          sectionId: r.sectionId || null,
          day: Number(r.day),
          period: Number(r.period),
          startTime: r.startTime || null,
          endTime: r.endTime || null,
          subjectId: r.subjectId,
          teacherId: r.teacherId || null,
        })),
      });
    }
  });
  await audit("ROUTINE_UPDATE", "class", classId);
  return NextResponse.json({ data: { ok: true } });
}
