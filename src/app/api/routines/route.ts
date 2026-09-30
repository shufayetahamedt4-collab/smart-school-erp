import { NextRequest, NextResponse } from "next/server";
import { prisma, schoolReference, userNamesFor } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { isBranchScoped } from "@/lib/permissions";
import { queryId } from "@/lib/utils";
import { writeGuard } from "@/lib/subscription";
import { loadRoutineConfig } from "@/lib/routine-config";

/**
 * The class routine — one week per scope.
 *
 * A scope is a (class, section) pair. A section may be omitted, which means the
 * **class-wide default**: the week every section of that class follows unless it
 * has a routine of its own. Saving one scope only ever replaces that scope, so
 * authoring Section A cannot wipe Section B or the class-wide week.
 *
 * Days and periods are not free-form: they are the school's configured shape
 * (see /api/routine-config), and a save that names a day or period the school
 * does not run is refused rather than stored invisibly.
 */

const VIEW_ROLES = ["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER"];
const EDIT_ROLES = ["SCHOOL_ADMIN", "BRANCH_ADMIN"];

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !VIEW_ROLES.includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const classId = queryId(req.nextUrl.searchParams, "classId");
  const sectionId = queryId(req.nextUrl.searchParams, "sectionId");

  // Bulk-parallel: routines + all reference data in one wave, names mapped
  // in memory (was per-include document gets per routine row). Teachers come
  // from the memoized reference pull first so the display-name lookup can
  // ride the same wave (school-scoped users pull, memoized per school).
  const teacherRows = await schoolReference("teacher", schoolId);
  const [routines, subjectRows, classRows, sectionRows, userNames] = await Promise.all([
    prisma.routine.findMany({
      where: {
        schoolId,
        ...(classId ? { classId } : {}),
        // A scope is exact: the class-wide default is sectionId null, a section
        // scope is that section's id. No scope → every row (sector prefetch).
        ...(classId ? { sectionId: sectionId || null } : {}),
      },
    }),
    schoolReference("subject", schoolId),
    schoolReference("classRoom", schoolId),
    schoolReference("section", schoolId),
    userNamesFor(teacherRows.map((t: any) => t.userId), schoolId),
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
  if (!session || !EDIT_ROLES.includes(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const classId = body?.classId ? String(body.classId) : "";
  const sectionId = body?.sectionId ? String(body.sectionId) : null;
  const rows = body?.rows;
  if (!classId || !Array.isArray(rows)) return NextResponse.json({ error: "classId and rows[] required." }, { status: 400 });

  const [classRoom, config, subjects] = await Promise.all([
    prisma.classRoom.findUnique({ where: { id: classId } }),
    loadRoutineConfig(schoolId),
    schoolReference("subject", schoolId),
  ]);
  if (!classRoom || classRoom.schoolId !== schoolId) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  // PRD §12.3 — a branch admin edits only their own branch's classes.
  if (isBranchScoped(session) && classRoom.branchId !== session.branchId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (sectionId) {
    const section = await prisma.section.findUnique({ where: { id: sectionId } });
    if (!section || section.schoolId !== schoolId || section.classId !== classId) {
      return NextResponse.json({ error: "Section not found in this class." }, { status: 404 });
    }
  }

  const allowedDays = new Set(config.days);
  const byPeriod = new Map(config.periods.map((p) => [p.period, p]));
  const subjectIds = new Set(subjects.map((s: any) => s.id));

  const seen = new Set<string>();
  const valid: any[] = [];
  for (const r of rows) {
    const subjectId = r?.subjectId ? String(r.subjectId) : "";
    const day = Number(r?.day);
    const period = Number(r?.period);
    if (!subjectId || !Number.isFinite(day) || !Number.isFinite(period)) continue;
    if (!allowedDays.has(day)) {
      return NextResponse.json({ error: "That weekday is not a working day for this school." }, { status: 400 });
    }
    const slot = byPeriod.get(period);
    if (!slot) {
      return NextResponse.json({ error: `This school does not have a period ${period}.` }, { status: 400 });
    }
    if (!subjectIds.has(subjectId)) return NextResponse.json({ error: "Unknown subject." }, { status: 400 });
    // One lesson per (day, period) — the grid cannot produce two, but an API
    // caller can, and the timetable would then be ambiguous.
    const key = `${day}|${period}`;
    if (seen.has(key)) continue;
    seen.add(key);
    valid.push({
      schoolId,
      classId,
      sectionId,
      day,
      period,
      // The bell times are the school's, not the row's: a period runs when the
      // school says it runs, so they are stamped from the config on every save.
      startTime: slot.start,
      endTime: slot.end,
      subjectId,
      teacherId: r?.teacherId ? String(r.teacherId) : null,
    });
  }

  await prisma.$transaction(async (tx) => {
    await tx.routine.deleteMany({ where: { schoolId, classId, sectionId } });
    if (valid.length) await tx.routine.createMany({ data: valid });
  });
  await audit("ROUTINE_UPDATE", "class", classId, { sectionId: sectionId || null, rows: valid.length });
  return NextResponse.json({ data: { ok: true, rows: valid.length, sectionId } });
}
