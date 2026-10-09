/**
 * College promotion ladder — the SERVER half, shared by both college-promotion
 * routes (docs/COLLEGE-DECISIONS.md §16, §19).
 *
 * `src/lib/college-promotion.ts` is the PURE ladder: no imports, no prisma, no
 * React, a property `scripts/verify-college-promotion-logic.mjs` pins by failing
 * if an `import` appears there. This module is the other half — the one that may
 * touch the store — and it exists so the rules that decide a cohort are defined
 * ONCE and used by BOTH HTTP surfaces:
 *
 *   - `src/app/api/college-promotion/route.ts`        — one (programme, term) position
 *   - `src/app/api/college-promotion/ladder/route.ts` — the whole programme
 *
 * Why it lives here and not in a route file: Next.js validates a route module's
 * exports, so a `route.ts` cannot export a helper for a sibling route to import.
 * A shared module is the only way to avoid two copies of the cohort rule drifting
 * apart — the exact drift `college-terms.ts` and `college-promotion.ts` warn
 * about in their own headers.
 *
 * What is shared, and nothing more:
 *   - `resolveProgramme` — the programme must exist, belong to the session's
 *     tenant, be ACTIVE and be reachable by the session's branch, exactly as the
 *     programme/mapping routes require. A missing or FOREIGN id is the SAME 400,
 *     never a 404 that would confirm another tenant's row exists.
 *   - `resolveLadder` — the single-position form: `resolveProgramme` plus a
 *     validated `fromTermNumber` in `[1, termCount]`.
 *   - `readCohort` — the STRICT cohort at one position (D2/D3): `programId` AND
 *     `termNumber` equality, tenant/branch scoped, `ON_ROLL_STUDENT` so ALUMNI and
 *     TRANSFERRED are never moved.
 *   - `readPendingCounts` — the DISPLAY-ONLY pending figure (D6), term-filtered.
 *
 * Neither resolver writes anything and neither reads a request body: the callers
 * own the HTTP contract and the writes.
 */

import { prisma, ON_ROLL_STUDENT } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";
import { scopeWhere, canAccessBranch } from "@/lib/permissions";
import { termCount } from "@/lib/college-terms";
import { normalizeRegistrationStatus } from "@/lib/registration-status";
import { normalizeTermNumber, type CollegeCohortStudent } from "@/lib/college-promotion";

/** The Firestore write-batch chunk the rest of the codebase uses (school ladder). */
export const PROMOTION_BATCH = 400;

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

/** A resolved programme: the stored row, its id and its DERIVED term count. */
export interface ResolvedProgramme {
  program: any;
  programId: string;
  termCount: number;
}

export type ProgrammeResult =
  | { ok: true; programme: ResolvedProgramme }
  | { ok: false; status: number; message: string };

/**
 * Resolve the request's programme, in the college routes' order.
 *
 * The term count is DERIVED here with `termCount(durationYears, termSystem)`
 * (`src/lib/college-terms.ts`) — the single source of truth — and `0` means "no
 * resolvable ladder", which every caller must treat as "cannot decide" rather
 * than "no terms".
 */
export async function resolveProgramme(
  session: SessionUser,
  rawProgramId: unknown
): Promise<ProgrammeResult> {
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
  return { ok: true, programme: { program, programId, termCount: total } };
}

/** The validated position, plus the programme row it resolved to. */
export interface Ladder {
  program: any;
  programId: string;
  fromTermNumber: number;
  termCount: number;
}

export type LadderResult = { ok: true; ladder: Ladder } | { ok: false; status: number; message: string };

/**
 * Resolve and validate a single (programme, term) position.
 *
 * A term past the programme's derived end (or a non-position: 0, negative,
 * fractional, text) is a 400, and the message names the derived bound. Branch
 * confinement follows the PROGRAMME — a branch admin can only ladder a programme
 * it can touch.
 */
export async function resolveLadder(
  session: SessionUser,
  rawProgramId: unknown,
  rawTerm: unknown
): Promise<LadderResult> {
  const base = await resolveProgramme(session, rawProgramId);
  if (!base.ok) return base;
  const { program, programId, termCount: total } = base.programme;

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
export async function readCohort(session: SessionUser, ladder: Ladder): Promise<CollegeCohortStudent[]> {
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
export async function readPendingCounts(
  session: SessionUser,
  ladder: Ladder
): Promise<Record<string, number>> {
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
