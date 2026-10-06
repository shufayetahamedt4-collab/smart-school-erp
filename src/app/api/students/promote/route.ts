import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache, ON_ROLL_STUDENT } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can, isBranchScoped, scopeWhere } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";
import { getCurrentSessionId } from "@/lib/academic";

/**
 * PRD §5.2 — Class Promotion Workflow (Phase 6: session-aware, idempotent).
 *
 * GET  → preview for one class: the target class, the target session, per-student
 *        action (promote / retain / graduate / already-processed), section warnings.
 * POST → execute promotion in bounded write-batches.
 *
 * Session awareness
 *   Every promoted or retained student is stamped with `sessionId = toSessionId`.
 *   The target session defaults to the school's CURRENT session (which is what a
 *   class-by-class promotion within the same year does), and is never silently
 *   switched to — changing the current session stays the explicit
 *   /api/academic-sessions/[id]/set-current action.
 *
 * Idempotency (safe re-run)
 *   Each processed student is stamped with `promotionSessionId = <target session>`
 *   — a durable, data-driven marker (Firestore is schemaless; the facade already
 *   persists additive fields like `guardianOnboarding`/`passwordStatus`, so this
 *   needs NO schema change or migration). A student whose marker already equals
 *   the target session is SKIPPED, so a re-run can never move Class 2 → Class 3.
 *   The marker also makes rollover order-safe: promoting Class 1 → Class 2 then
 *   Class 2 → Class 3 in the SAME target session leaves the just-moved students
 *   skipped (their marker is already the target), while the genuine Class 2
 *   cohort (marker from the previous session) still advances.
 *
 *   When a school has no academic sessions at all, the marker value is a constant
 *   sentinel, so a re-run is still skipped; the only limitation is that two
 *   intentional promotions of the same cohort within a session-less setup would
 *   also be skipped.
 *
 * Batched writes
 *   Updates are queued as ops and flushed with `prisma.$transaction` in ≤400-op
 *   slices (the codebase's Firestore write-batch chunk). A student whose section
 *   does not belong to the target class is surfaced as a WARNING but still
 *   promoted — the stale section is preserved, never silently remapped.
 */

const BATCH = 400;
/** Marker value when a school has no academic sessions configured. */
const NO_SESSION_MARKER = "__no_session__";

interface Target {
  sessionId: string | null;
  sourceSessionId: string | null;
  id: string | null;
  name: string | null;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "studentTeacherInfo", "full")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;

  const fromClassId = req.nextUrl.searchParams.get("fromClassId");
  if (!fromClassId) return NextResponse.json({ error: "fromClassId is required." }, { status: 400 });

  const classes = await prisma.classRoom.findMany({ where: { schoolId }, orderBy: { order: "asc" } });
  const idx = classes.findIndex((c: any) => c.id === fromClassId);
  if (idx < 0) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  // Branch scoping: a branch admin may only preview its own branch's class.
  if (isBranchScoped(session) && (classes[idx] as any).branchId && (classes[idx] as any).branchId !== session.branchId) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  }
  const targetClass = (classes[idx + 1] as any) || null; // null = graduating (top class)

  let target: Target;
  try {
    target = await resolveTarget(session, req.nextUrl.searchParams.get("toSessionId"), fromClassId);
  } catch (e: any) {
    if (e?.message === "TARGET_SESSION_INVALID") return NextResponse.json({ error: "Target session not found for this school." }, { status: 400 });
    throw e;
  }

  const scoped = scopeWhere(session, { classId: fromClassId, ...ON_ROLL_STUDENT });
  const students = await prisma.student.findMany({
    where: scoped,
    select: { id: true, name: true, roll: true, classId: true, sessionId: true, sectionId: true, status: true, branchId: true, promotionSessionId: true },
    orderBy: { roll: "asc" },
  });

  const targetSectionIds = new Set(
    (await prisma.section.findMany({ where: { schoolId, classId: targetClass?.id || "__none__" }, select: { id: true } })).map((s: any) => s.id)
  );
  const marker = markerFor(target);

  const rows = (students as any[]).map((s) => {
    const graduating = !targetClass;
    // Already processed for THIS target session → skip (safe re-run).
    const already = s.promotionSessionId === marker;
    const action = graduating ? "graduate" : already ? "already" : "promote";
    const sectionWarning =
      !graduating && s.sectionId && !targetSectionIds.has(s.sectionId)
        ? "This student's section does not belong to the target class — it will be kept as-is (no auto-remap)."
        : null;
    return { id: s.id, name: s.name, roll: s.roll, section: null, action, sectionWarning, graduating };
  });

  const counts = countActions(rows);
  return NextResponse.json({
    data: {
      fromClass: { id: (classes[idx] as any).id, name: (classes[idx] as any).name },
      toClass: targetClass ? { id: targetClass.id, name: targetClass.name } : null,
      graduating: !targetClass,
      targetSession: target.id ? { id: target.id, name: target.name } : null,
      sourceSession: target.sourceSessionId ? { id: target.sourceSessionId } : null,
      students: rows,
      count: rows.length,
      counts,
    },
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "studentTeacherInfo", "full")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const fromClassId = String(body?.fromClassId || "");
  const excludeIds: string[] = Array.isArray(body?.excludeIds) ? body.excludeIds.map(String) : [];
  const graduateIds: string[] = Array.isArray(body?.graduateIds) ? body.graduateIds.map(String) : [];
  if (!fromClassId) return NextResponse.json({ error: "fromClassId is required." }, { status: 400 });

  const classes = await prisma.classRoom.findMany({ where: { schoolId }, orderBy: { order: "asc" } });
  const idx = classes.findIndex((c: any) => c.id === fromClassId);
  if (idx < 0) return NextResponse.json({ error: "Class not found" }, { status: 404 });
  if (isBranchScoped(session) && (classes[idx] as any).branchId && (classes[idx] as any).branchId !== session.branchId) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  }
  const targetClass = (classes[idx + 1] as any) || null;

  let target: Target;
  try {
    target = await resolveTarget(session, body?.toSessionId, fromClassId);
  } catch (e: any) {
    if (e?.message === "TARGET_SESSION_INVALID") return NextResponse.json({ error: "Target session not found for this school." }, { status: 400 });
    throw e;
  }

  // ON_ROLL_STUDENT excludes ALUMNI and TRANSFERRED — a transferred student is
  // never promoted.
  const scoped = scopeWhere(session, { classId: fromClassId, ...ON_ROLL_STUDENT });
  const students = await prisma.student.findMany({ where: scoped, select: { id: true, classId: true, sessionId: true, sectionId: true, promotionSessionId: true } });
  const marker = markerFor(target);

  let promoted = 0;
  let retained = 0;
  let graduated = 0;
  let skipped = 0;
  let failed = 0;
  const ops: any[] = [];

  const flush = async () => {
    while (ops.length) {
      const slice = ops.splice(0, BATCH);
      await prisma.$transaction(slice);
    }
  };

  for (const s of students as any[]) {
    // Idempotency: already processed for the target session → skip (never re-promote).
    if (s.promotionSessionId === marker) {
      skipped++;
      continue;
    }
    const graduating = !targetClass || graduateIds.includes(s.id);
    const excluded = excludeIds.includes(s.id);
    const data: Record<string, any> = { promotionSessionId: marker };
    try {
      if (graduating) {
        data.status = "ALUMNI";
        graduated++;
      } else if (excluded) {
        // Retained: stay in the current class, move to the target session.
        if (target.sessionId) data.sessionId = target.sessionId;
        retained++;
      } else {
        data.classId = targetClass.id;
        if (target.sessionId) data.sessionId = target.sessionId;
        promoted++;
      }
      ops.push(prisma.student.update({ where: { id: s.id }, data }));
      if (ops.length >= BATCH) await flush();
    } catch {
      failed++;
    }
  }
  await flush();

  await audit("STUDENT_PROMOTE", "classRoom", fromClassId, {
    toSessionId: target.sessionId,
    promoted,
    retained,
    graduated,
    skipped,
    failed,
    excluded: excludeIds.length,
  });
  invalidateStats(schoolId, "students");
  invalidateReferenceCache(schoolId);

  return NextResponse.json({ data: { promoted, retained, graduated, skipped, failed, excluded: excludeIds.length, targetSessionId: target.sessionId } });
}

/**
 * Resolve the target session and the source session a promotion is moving FROM.
 *
 *   target = explicit `toSessionId` (validated to this school) or the current session
 *   source = the session the class is being promoted OUT of: the previous session
 *            by start date when promoting across sessions, otherwise the current
 *            session (promoting within the same year).
 */
async function resolveTarget(
  session: { role: string; schoolId: string | null },
  explicit: string | null | undefined,
  _fromClassId: string
): Promise<Target> {
  const schoolId = session.schoolId!;
  const currentId = await getCurrentSessionId(schoolId);

  let targetId: string | null = null;
  if (explicit) {
    const row = await prisma.academicSession.findUnique({ where: { id: String(explicit) } }).catch(() => null);
    if (!row || row.schoolId !== schoolId) throw new Error("TARGET_SESSION_INVALID");
    targetId = row.id;
  } else {
    targetId = currentId;
  }

  const targetRow = targetId ? await prisma.academicSession.findUnique({ where: { id: targetId } }).catch(() => null) : null;
  if (targetId && (!targetRow || targetRow.schoolId !== schoolId)) throw new Error("TARGET_SESSION_INVALID");

  // Source session = the previous session by start date, else the target itself.
  let sourceSessionId = currentId;
  const all = await prisma.academicSession.findMany({ where: { schoolId } });
  if (targetRow) {
    const ordered = (all as any[])
      .slice()
      .sort((a, b) => new Date(a.startDate || 0).getTime() - new Date(b.startDate || 0).getTime());
    const at = ordered.findIndex((s) => s.id === targetRow.id);
    if (at > 0) sourceSessionId = ordered[at - 1].id;
  }

  return { sessionId: targetId, sourceSessionId, id: targetRow?.id || null, name: targetRow?.name || null };
}

/** The durable marker value for a target session (session id, or a sentinel). */
function markerFor(target: Target): string {
  return target.sessionId || NO_SESSION_MARKER;
}

function countActions(rows: any[]) {
  return {
    promote: rows.filter((r) => r.action === "promote").length,
    graduate: rows.filter((r) => r.action === "graduate").length,
    already: rows.filter((r) => r.action === "already").length,
    sectionWarnings: rows.filter((r) => r.sectionWarning).length,
  };
}
