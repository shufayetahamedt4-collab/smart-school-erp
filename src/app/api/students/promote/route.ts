import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";

/**
 * PRD §5.2 — Class Promotion Workflow.
 * GET  → preview: counts per target class, excluded (failed) students
 * POST → execute promotion (status + class change; old records archived by design)
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "studentTeacherInfo", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const fromClassId = req.nextUrl.searchParams.get("fromClassId");
  if (!fromClassId) return NextResponse.json({ error: "fromClassId is required." }, { status: 400 });

  const classes = await prisma.classRoom.findMany({ where: { schoolId }, orderBy: { order: "asc" } });
  const idx = classes.findIndex((c) => c.id === fromClassId);
  if (idx < 0) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  const target = classes[idx + 1] || null; // null = graduating (top class)

  const students = await prisma.student.findMany({
    where: { schoolId, classId: fromClassId, status: "ACTIVE" },
    select: { id: true, name: true, roll: true, section: { select: { name: true } } },
    orderBy: { roll: "asc" },
  });

  return NextResponse.json({
    data: {
      fromClass: { id: classes[idx].id, name: classes[idx].name },
      toClass: target ? { id: target.id, name: target.name } : null,
      graduating: !target,
      students: students.map((s) => ({ id: s.id, name: s.name, roll: s.roll, section: s.section?.name || null, exclude: false })),
      count: students.length,
    },
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "studentTeacherInfo", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const fromClassId = String(body?.fromClassId || "");
  const excludeIds: string[] = Array.isArray(body?.excludeIds) ? body.excludeIds : [];
  const graduateIds: string[] = Array.isArray(body?.graduateIds) ? body.graduateIds : [];

  const classes = await prisma.classRoom.findMany({ where: { schoolId }, orderBy: { order: "asc" } });
  const idx = classes.findIndex((c) => c.id === fromClassId);
  if (idx < 0) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  const target = classes[idx + 1] || null;

  const students = await prisma.student.findMany({
    where: { schoolId, classId: fromClassId, status: "ACTIVE", id: { notIn: excludeIds } },
    select: { id: true },
  });

  let promoted = 0;
  let graduated = 0;
  for (const s of students) {
    const isGraduating = !target || graduateIds.includes(s.id);
    if (isGraduating) {
      // §5.3 — alumni archive, not delete.
      await prisma.student.update({ where: { id: s.id }, data: { status: "ALUMNI" } });
      graduated++;
    } else {
      await prisma.student.update({ where: { id: s.id }, data: { classId: target.id } });
      promoted++;
    }
  }

  await audit("STUDENT_PROMOTE", "classRoom", fromClassId, { promoted, graduated, excluded: excludeIds.length });
  return NextResponse.json({ data: { promoted, graduated, excluded: excludeIds.length } });
}
