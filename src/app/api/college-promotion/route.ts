import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache, ON_ROLL_STUDENT } from "@/lib/db";
import { getSession, requireCollege, audit, type SessionUser } from "@/lib/auth";
import { can, scopeWhere, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";
import { termCount } from "@/lib/college-terms";
import { normalizeRegistrationStatus } from "@/lib/registration-status";
import {
  buildCollegePromotionPreview,
  normalizeTermNumber,
  type CollegeCohortStudent,
} from "@/lib/college-promotion";

/**
 * Phase 5b — the college promotion ladder API (docs/COLLEGE-DECISIONS.md §15, §16).
 *
 *   GET  ?programId=&fromTermNumber=   → the cohort at one (programme, term)
 *                                        position and what each member's move is.
 *   POST { programId, fromTermNumber } → apply it, in ≤400-operation slices.
 *
 * A college student's position is `students.programId` + `students.termNumber`
 * (Phase 4a). The programme already knows how many terms it has
 * (`termCount = durationYears × termsPerYear`, `src/lib/college-terms.ts`), so a
 * term is an integer position on a ladder — **no term rows, no marker field, no
 * session coupling** (D2/D9). The pure half of that ladder lives in
 * `src/lib/college-promotion.ts` (Phase 5a) and is imported here; this file is
 * only the HTTP/DB half.
 *
 * Why this is its OWN college segment (D1) and not a branch of
 * `/api/students/promote`: `scripts/verify-college-routes.mjs` check 3 forbids a
 * non-college `src/app/api` directory from touching `prisma.program`, so the
 * ladder's DB half cannot live beside the school route. Being listed also means
 * the offline guard proves this file's handlers gate before they read.
 *
 * Guard order in EVERY handler (mirrors `programs`/`courses`):
 *   1. `getSession()`                 → 401
 *   2. target `schoolId`              → 400
 *   3. `requireCollege({ schoolId })` → 403   FIRST authorization step (this is a
 *      college segment, so a SCHOOL tenant can never reach the ladder)
 *   4. `can(role, "registration", …)` → 403   (Phase 4b's module — a REGISTRAR may
 *      apply here, unlike the school ladder's `studentTeacherInfo`)
 *   5. `writeGuard(schoolId)`         → 402   (POST only, PRD §12.1)
 *
 * The decided rules this route obeys:
 *   D2/D3 — the cohort is **strict** and server-side: only students whose
 *      `programId` AND `termNumber` both equal the target position, recomputed
 *      from the request's (programme, term) on every apply. **Client ids and
 *      preview output are never trusted** — the body names a position, not rows.
 *      Idempotency is structural: an advance moves a student off the term, so a
 *      re-run of the same `fromTermNumber` selects nobody (there is no marker).
 *   D4  — only students with a programme. A student with no `programId` is never
 *      selected; the SCHOOL ladder (`/api/students/promote`) is untouched and
 *      still moves by `classId`. The preview carries `classIdWarning` for any
 *      cohort member that also holds a `classId`, so an operator sees that the
 *      school ladder may move the same student too.
 *   D5  — the last term graduates: `action: "graduate"` stamps `status = "ALUMNI"`
 *      (the school ladder's existing terminal value) and the run reports
 *      `graduating` separately, with no destination term.
 *   D6  — course progress is not consulted. `pendingRegistrationCount` is INFO
 *      ONLY (it never excludes a student and never blocks a promotion).
 *   D7  — registrations are untouched: a promotion writes only the student's own
 *      fields (`termNumber`, or `status` when graduating).
 *   D9  — independent of the academic session: no `sessionId` is read or written.
 *   D10 — the write path mirrors the school ladder: `prisma.$transaction` in ≤400
 *      operation slices, then `audit`, `invalidateStats`, `invalidateReferenceCache`.
 */

/** The Firestore write-batch chunk the rest of the codebase uses (school ladder). */
const BATCH = 400;

/** Trimmed string, or "" for any non-string (the college routes' `read`). */
const read = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Read a term value that may arrive as a JSON number or as query text.
 *
 * A numeric string is the number it names (`"2"` → `2`); anything else is handed
 * to `normalizeTermNumber` unchanged so it is REJECTED rather than silently
 * coerced (a `""`, `"two"` or `null` is not a position).
 */
function coerceTerm(value: unknown): unknown {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const n = Number(trimmed);
    if (Number.isInteger(n)) return n;
  }
  return value;
}

/** The validated position, plus the programme row it resolved to. */
interface Ladder {
  program: any;
  programId: string;
  fromTermNumber: number;
  termCount: number;
}

type LadderResult = { ok: true; ladder: Ladder } | { ok: false; status: number; message: string };

/**
 * Resolve and validate the request's position, in the college routes' order.
 *
 * A missing or foreign programme id is the SAME 400 — never a 404 that would
 * confirm another tenant's row exists. A term past the programme's derived end
 * (or a non-position: 0, negative, fractional, text) is a 400 too. Branch
 * confinement follows the PROGRAMME (a branch admin can only ladder a programme
 * it can touch), exactly like the programme and mapping routes.
 */
async function resolveLadder(session: SessionUser, rawProgramId: unknown, rawTerm: unknown): Promise<LadderResult> {
  const programId = read(rawProgramId);
  if (!programId) return { ok: false, status: 400, message: "programId is required." };

  const program = await prisma.program.findUnique({ where: { id: programId } });
  if (!program || (program as any).schoolId !== session.schoolId) {
    return { ok: false, status: 400, message: "Program not found in this school." };
  }
  if ((program as any).status && (program as any).status !== "ACTIVE") {
    return { ok: false, status: 400, message: "The program is not active." };
  }
  if (!canAccessBranch(session, (program as any).branchId)) {
    return { ok: false, status: 403, message: "Forbidden" };
  }

  const total = termCount(Number((program as any).durationYears), (program as any).termSystem);
  const from = normalizeTermNumber(coerceTerm(rawTerm));
  if (from === null || total === 0 || from > total) {
    return { ok: false, status: 400, message: `fromTermNumber must be a whole number from 1 to ${total}.` };
  }
  return { ok: true, ladder: { program, programId, fromTermNumber: from, termCount: total } };
}

/**
 * The cohort at `(programme, term)` — recomputed server-side on every call.
 *
 * Scoped with `scopeWhere` (tenant, plus the session's branch when it is
 * branch-scoped) and `ON_ROLL_STUDENT` (ALUMNI and TRANSFERRED are never
 * promoted — the school ladder's existing rule, reused verbatim). The strict
 * `programId` + `termNumber` equality is what makes the cohort, and its
 * idempotency, structural (D2/D3); a student with no programme can never match.
 */
async function readCohort(session: SessionUser, ladder: Ladder): Promise<CollegeCohortStudent[]> {
  const where = scopeWhere(session, {
    programId: ladder.programId,
    termNumber: ladder.fromTermNumber,
    ...ON_ROLL_STUDENT,
  });
  const rows = await prisma.student.findMany({
    where,
    select: { id: true, programId: true, termNumber: true, classId: true, status: true },
  });
  return rows as unknown as CollegeCohortStudent[];
}

/**
 * `studentId → pending registration count`, DISPLAY ONLY (D6).
 *
 * Counts this programme's PENDING rows at the position being advanced. It is an
 * input to the preview alone: `buildCollegePromotionPreview` carries it on the row
 * and never uses it to include or exclude anybody.
 */
async function readPendingCounts(session: SessionUser, ladder: Ladder): Promise<Record<string, number>> {
  const rows = await prisma.courseRegistration.findMany({
    where: scopeWhere(session, { programId: ladder.programId }),
    select: { studentId: true, termNumber: true, status: true },
  });
  const counts: Record<string, number> = {};
  for (const r of rows as any[]) {
    if (normalizeRegistrationStatus(r.status) !== "PENDING") continue;
    if (Number(r.termNumber) !== ladder.fromTermNumber) continue;
    if (typeof r.studentId !== "string" || !r.studentId) continue;
    counts[r.studentId] = (counts[r.studentId] || 0) + 1;
  }
  return counts;
}

/** GET — the preview for one (programme, term) position. Reads only. */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // The gate must be the FIRST authorization step, on the TARGET tenant.
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  if (!can(session.role, "registration", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const params = req.nextUrl.searchParams;
  const resolved = await resolveLadder(session, params.get("programId"), params.get("fromTermNumber"));
  if (!resolved.ok) return NextResponse.json({ error: resolved.message }, { status: resolved.status });
  const ladder = resolved.ladder;

  const [students, pendingRegistrationCounts] = await Promise.all([
    readCohort(session, ladder),
    readPendingCounts(session, ladder),
  ]);
  const preview = buildCollegePromotionPreview({
    students,
    programId: ladder.programId,
    fromTermNumber: ladder.fromTermNumber,
    termCount: ladder.termCount,
    pendingRegistrationCounts,
  });

  return NextResponse.json({
    data: {
      program: { id: (ladder.program as any).id, name: (ladder.program as any).name },
      fromTermNumber: preview.fromTermNumber,
      termCount: preview.termCount,
      graduating: preview.graduating,
      rows: preview.rows,
      count: preview.count,
      counts: preview.counts,
    },
  });
}

/** POST — execute the move for the position's cohort, in ≤400-op slices. */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // The gate must be the FIRST authorization step, on the TARGET tenant.
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  if (!can(session.role, "registration", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // PRD §12.1 — subscription auto-lock (mutations only).
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const resolved = await resolveLadder(session, body?.programId, body?.fromTermNumber);
  if (!resolved.ok) return NextResponse.json({ error: resolved.message }, { status: resolved.status });
  const ladder = resolved.ladder;

  // The cohort is RECOMPUTED here from the position — the body carries only
  // (programId, fromTermNumber), so ids from a preview are ignored entirely. The
  // strict equality is also the idempotency: after an advance nobody remains at
  // `fromTermNumber`, so a re-run writes nothing (D2/D3).
  const students = await readCohort(session, ladder);
  const graduating = ladder.fromTermNumber === ladder.termCount;
  const toTermNumber = graduating ? null : ladder.fromTermNumber + 1;

  let promoted = 0;
  let graduated = 0;
  // A cohort row always came from the store and therefore always has an id, so
  // this stays structurally 0 — it exists to mirror the school ladder's report.
  let failed = 0;
  const ops: any[] = [];
  const flush = async () => {
    while (ops.length) {
      const slice = ops.splice(0, BATCH);
      await prisma.$transaction(slice);
    }
  };

  for (const student of students) {
    if (typeof student?.id !== "string" || !student.id) {
      failed += 1;
      continue;
    }
    // D5: the last term graduates (ALUMNI, the school ladder's terminal value);
    // every other term advances one position. Nothing else is written (D7/D9).
    const data: Record<string, any> = graduating ? { status: "ALUMNI" } : { termNumber: toTermNumber };
    ops.push(prisma.student.update({ where: { id: student.id }, data }));
    if (graduating) graduated += 1;
    else promoted += 1;
    if (ops.length >= BATCH) await flush();
  }
  await flush();

  await audit("COLLEGE_PROMOTION", "program", ladder.programId, {
    fromTermNumber: ladder.fromTermNumber,
    toTermNumber,
    graduating,
    promoted,
    graduated,
    failed,
  });
  invalidateStats(schoolId, "students");
  invalidateReferenceCache(schoolId);

  return NextResponse.json({
    data: {
      programId: ladder.programId,
      fromTermNumber: ladder.fromTermNumber,
      toTermNumber,
      graduating,
      promoted,
      graduated,
      failed,
    },
  });
}
