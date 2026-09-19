import { NextRequest, NextResponse } from "next/server";
import { prisma, schoolReference, userNamesFor } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const classId = req.nextUrl.searchParams.get("classId") || undefined;
  // Bulk-parallel: routines + all reference data in one wave, names mapped
  // in memory (was per-include document gets per routine row). Teachers come
  // from the memoized reference pull first so the display-name lookup can
  // ride the same wave (users have no schoolId, so ids are needed upfront).
  const teacherRows = await schoolReference("teacher", schoolId);
  const [routines, subjectRows, classRows, sectionRows, userNames] = await Promise.all([
    prisma.routine.findMany({ where: { schoolId, ...(classId ? { classId } : {}) } }),
    schoolReference("subject", schoolId),
    schoolReference("classRoom", schoolId),
    schoolReference("section", schoolId),
    userNamesFor(teacherRows.map((t: any) => t.userId)),
  ]);
  const subjectById = new Map(subjectRows.map((s) => [s.id, s]));
  const teacherById = new Map(teacherRows.map((t) => [t.id, t]));
  const classById = new Map(classRows.map((c) => [c.id, c]));
  const sectionById = new Map(sectionRows.map((s) => [s.id, s]));
  const data = routines
    .map((r: any) => {
      const t = r.teacherId ? teacherById.get(r.teacherId) : null;
      // Select-parity with the pre-sweep include: subject/classRoom/section
      // {id, name}; teacher {id, user:{name}}.
      const subj: any = r.subjectId ? subjectById.get(r.subjectId) : null;
      const cls: any = r.classId ? classById.get(r.classId) : null;
      const sec: any = r.sectionId ? sectionById.get(r.sectionId) : null;
      return {
        ...r,
        subject: subj ? { id: subj.id, name: subj.name } : null,
        teacher: t ? { id: t.id, user: { name: userNames.get(t.userId) || "" } } : null,
        classRoom: cls ? { id: cls.id, name: cls.name } : null,
        section: sec ? { id: sec.id, name: sec.name } : null,
      };
    })
    .sort((a: any, b: any) => (a.day ?? 0) - (b.day ?? 0) || (a.period ?? 0) - (b.period ?? 0));
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
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
