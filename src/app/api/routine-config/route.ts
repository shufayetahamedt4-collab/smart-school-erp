import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";
import { DEFAULT_ROUTINE_CONFIG, loadRoutineConfig, saveRoutineConfig, validateRoutineConfig } from "@/lib/routine-config";

/**
 * The school's timetable shape: how many periods a day, when each runs, and which
 * weekdays the school works. PRD-adjacent — this is what makes the routine grid
 * fit the school instead of the school fitting the grid.
 *
 * Because every existing reader (the live-classes board, the parent view, the
 * teacher console) reads a period's clock time off the routine row itself, a
 * change to a period's time is written back onto that school's rows here. Rows
 * that no longer exist in the new shape (a shorter day, a dropped weekday) are
 * removed, and the counts are returned so the UI can say exactly what changed.
 */

const VIEW_ROLES = ["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER"];
const EDIT_ROLES = ["SCHOOL_ADMIN", "BRANCH_ADMIN"];
const CHUNK = 400;

export async function GET() {
  const session = await getSession();
  if (!session || !VIEW_ROLES.includes(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!session.schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const config = await loadRoutineConfig(session.schoolId);
  return NextResponse.json({ data: { config, default: DEFAULT_ROUTINE_CONFIG } });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session || !EDIT_ROLES.includes(session.role)) {
    return NextResponse.json({ error: "Only a school admin can change the timetable shape." }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const result = validateRoutineConfig(body?.config ?? body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  const config = result.config;

  const rows = await prisma.routine.findMany({ where: { schoolId }, select: { id: true, day: true, period: true } });
  const byPeriod = new Map(config.periods.map((p) => [p.period, p]));
  const keep: any[] = [];
  const drop: any[] = [];
  for (const r of rows as any[]) {
    const p = byPeriod.get(Number(r.period));
    if (p && config.days.includes(Number(r.day))) keep.push({ row: r, p });
    else drop.push(r);
  }

  let updated = 0;
  let removed = 0;
  const ops: any[] = [];
  const flush = async () => {
    while (ops.length) await prisma.$transaction(ops.splice(0, CHUNK));
  };
  for (const r of drop) {
    ops.push(prisma.routine.delete({ where: { id: r.id } }));
    removed++;
    if (ops.length >= CHUNK) await flush();
  }
  for (const { row, p } of keep) {
    ops.push(prisma.routine.update({ where: { id: row.id }, data: { startTime: p.start, endTime: p.end } }));
    updated++;
    if (ops.length >= CHUNK) await flush();
  }
  await flush();

  await saveRoutineConfig(schoolId, config);
  await audit("ROUTINE_CONFIG_UPDATE", "school", schoolId, {
    days: config.days.join(","),
    periods: config.periods.length,
    rowsRetimed: updated,
    rowsRemoved: removed,
  });
  // The routine read is memoized per school; drop it so the next screen is honest.
  invalidateReferenceCache(schoolId);

  return NextResponse.json({ data: { config, retimed: updated, removed } });
}
