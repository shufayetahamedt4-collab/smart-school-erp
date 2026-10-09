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

/**
 * How long a whole-programme run may hold the programme's lease (Phase 6-pre 2,
 * docs/COLLEGE-DECISIONS.md §21). ONE constant: a run that crashes mid-step, or a
 * process that dies, must not wedge a programme for ever, so a lease older than
 * this is treated as abandoned and may be taken over. Two minutes is several times
 * the longest run the verifier exercises (a 405-student ladder), so the window is
 * about crash recovery, not about the run's normal duration.
 */
export const LADDER_LEASE_MS = 2 * 60 * 1000;

/** The refusal a second, concurrent run receives. */
export const LADDER_RUN_IN_PROGRESS_MESSAGE =
  "Another run is in progress for this programme.";

/** FNV-style string hash, base-36. Pure, deterministic, no dependency. */
function runHash(value: string, seed: number): string {
  let x = seed >>> 0;
  for (let i = 0; i < value.length; i++) {
    x = (((x << 5) + x) ^ value.charCodeAt(i)) >>> 0;
  }
  return x.toString(36);
}

/**
 * The document id of a programme's run row: deterministic from `(schoolId,
 * programId)` so every run of the same programme addresses the SAME row.
 *
 * The pair is hashed twice, with different seeds, so the id is a 64-bit address
 * rather than a readable concatenation — a raw id could contain `/` (illegal in a
 * document id) or exceed Firestore's 1500-byte limit. The id is only an ADDRESS:
 * the row itself stores the true `schoolId` and `programId`, so a hash collision
 * could at worst refuse an unrelated run (the claim fails closed) and could never
 * let one programme write another's students.
 */
export function promotionRunId(schoolId: string, programId: string): string {
  const key = `${schoolId}\u0000${programId}`;
  return `run_${runHash(key, 5381)}${runHash(key, 131)}`;
}

/** What a claim attempt answered. */
export interface ProgrammeRunClaim {
  /** The row's document id (deterministic from the pair). */
  id: string;
  /** True when THIS caller now holds the programme's lease. */
  claimed: boolean;
}

/**
 * Claim the programme's lease, atomically (Phase 6-pre 2).
 *
 * One row per `(schoolId, programId)`. A live lease means another run is moving
 * this programme's cohorts right now, so the caller must write NOTHING and answer
 * 409. An EXPIRED lease is not a holder: it may be taken over, which is what keeps
 * a crashed run from locking a programme out for ever.
 *
 * The row is REPLACED on claim, so a new run never inherits a previous run's
 * fields, and it carries what the run needs to report itself afterwards:
 * `schoolId`, `branchId`, `programId`, `ownerId`, `status`, `acquiredAt`,
 * `expiresAtMs` (the lease), plus `finishedAt`, `completed` and `remainingTerms`
 * (filled in by `finaliseProgrammeRun`).
 */
export async function claimProgrammeRun(input: {
  schoolId: string;
  programId: string;
  branchId?: string | null;
  ownerId?: string | null;
}): Promise<ProgrammeRunClaim> {
  const id = promotionRunId(input.schoolId, input.programId);
  // When THIS request began asking. The claim is refused if the row it finds was
  // released after this instant, because that means the row was still held while
  // this request was arriving: a second, CONCURRENT run — not a deliberate re-run
  // (see `$claim`). `Date.now()` is read once, outside the transaction, so the
  // SDK's own conflict retries cannot move it forward.
  const attemptedAtMs = Date.now();
  const result = await prisma.$claim(
    "promotionRun",
    id,
    {
      schoolId: input.schoolId,
      branchId: input.branchId ?? null,
      programId: input.programId,
      ownerId: input.ownerId ?? null,
      status: "IN_PROGRESS",
      acquiredAt: new Date().toISOString(),
      acquiredAtMs: attemptedAtMs,
      finishedAt: null,
      completed: [],
      remainingTerms: [],
    },
    { ttlMs: LADDER_LEASE_MS, attemptedAtMs }
  );
  return { id, claimed: result.claimed };
}

/**
 * Release the lease and record how the run ended (Phase 6-pre 2).
 *
 * Called from the run's `finally`, on SUCCESS and on FAILURE alike, so a lease can
 * never outlive its run. It ALWAYS clears `expiresAtMs`, which is what makes the
 * lease released rather than merely re-stamped: the moment a run ends, the next
 * run is allowed — unless this run FAILED, in which case Phase 6-pre 3 refuses the
 * next LADDER run until the recorded work list has been applied.
 *
 * `status` is `"OK"` for a completed run and `"PARTIAL"` / `"FAILED"` for a run
 * that threw — the distinction `wroteAnything` already makes in the response.
 *
 * For a failure it also records `finishTerms`, the work list Phase 6-pre 3 refuses a
 * ladder re-run against and that the SINGLE-POSITION route strikes off, one term at a
 * time, as each is applied (`markProgrammeTermFinished`).
 *
 * Best effort by design: finalising must never mask the run's own response. A
 * failure to write the row is swallowed (the run's real answer is already built).
 */
export async function finaliseProgrammeRun(input: {
  schoolId: string;
  programId: string;
  status: "OK" | "PARTIAL" | "FAILED";
  completed?: any[];
  remainingTerms?: number[];
  /** The terms that still have to be applied, DESCENDING (Phase 6-pre 3). */
  finishTerms?: number[];
  reason?: string | null;
}): Promise<void> {
  try {
    await prisma.promotionRun.update({
      where: { id: promotionRunId(input.schoolId, input.programId) },
      data: {
        status: input.status,
        finishedAt: new Date().toISOString(),
        completed: input.completed ?? [],
        remainingTerms: input.remainingTerms ?? [],
        // The failed term PLUS the terms never attempted, DESCENDING: the work list
        // the single-position route strikes off, one term at a time (6-pre 3). Empty
        // for a clean run, which is what makes an OK run never block.
        finishTerms: input.finishTerms ?? [],
        reason: input.reason ?? null,
        // RELEASED: the lease is over whatever the outcome, so the next run may
        // claim it. The release itself stays unconditional — what a FAILED run
        // additionally changes is that a ladder RE-RUN is refused until the
        // recorded work list is finished (Phase 6-pre 3, `readProgrammeRunBlock`).
        expiresAtMs: 0,
        // WHEN it was released. A claim that asked BEFORE this instant was asking
        // while this run was in flight, and is refused as a concurrent run rather
        // than queued behind it (`$claim`); a claim that asked after it is the
        // ordinary re-run the 5b/5d verifiers pin, and is allowed.
        releasedAtMs: Date.now(),
      },
    });
  } catch {
    /* best effort: never mask the run's own answer */
  }
}

/* ---------------------------------------------------------------------------
 * Phase 6-pre 3 — a re-run is refused until the work the FAILED run left is done
 * ------------------------------------------------------------------------- */

/** How the ladder's last run ended, and what is still outstanding (if anything). */
export interface ProgrammeRunBlock {
  /** True when the LAST run for this programme is unfinished AND has work left. */
  blocked: boolean;
  /** The last run's status: `"OK"` / `"PARTIAL"` / `"FAILED"`, or null when it
   *  has never run. (The row's `IN_PROGRESS` is a LIVE lease, not a block — the
   *  claim refuses that with its own message.) */
  status: string | null;
  /** The terms still to apply, DESCENDING (the failed term first). */
  finishTerms: number[];
  /** The terms the run never attempted, DESCENDING (the row's own record). */
  remainingTerms: number[];
  /** The term the run STOPPED at: the first (highest) term still to apply. */
  stoppedAtTermNumber: number | null;
  /** The operator-facing refusal, or null when nothing is blocked. */
  message: string | null;
}

/** The refusal sentence for a failed run's work list. One builder, so the route
 *  and the row can never disagree about which terms are outstanding. */
export function ladderRunBlockedMessage(input: {
  status: string | null;
  finishTerms: number[];
}): string {
  const terms = input.finishTerms.map((t) => `term ${t}`).join(", then ");
  return (
    `The last ladder run for this programme did not finish (${input.status}, stopped at term ${input.finishTerms[0]}), ` +
    `so the ladder is refused: re-running it would advance the steps that already landed a SECOND time. ` +
    `Finish it with the single-position apply (POST /api/college-promotion), descending: ${terms}.`
  );
}

/**
 * Read the programme's last run and decide whether a LADDER re-run is refused
 * (Phase 6-pre 3).
 *
 * The block is deliberately narrow, and the two halves of it are read from the same
 * row the failed run wrote:
 *
 *   • only `PARTIAL` / `FAILED` blocks. A clean `OK` run never does (the page's and
 *     the API verifier's run-after-run behaviour is unchanged);
 *   • only while there is WORK LEFT. `finishTerms` is the work list the run recorded
 *     (its failed term plus the terms it never attempted), and the SINGLE-POSITION
 *     route strikes each term off as it applies it (`markProgrammeTermFinished`), so
 *     the block lifts exactly when the outstanding terms have actually been applied —
 *     proved from the row's own writes, never inferred from a student's term number
 *     (which the finishing walk re-fills, so a term number cannot tell the two apart).
 *
 * Reading cannot change the answer: this is a read of a row whose ONLY writers are the
 * ladder's claim/finalise and that strike-off. Between this read and the claim, a
 * concurrent run is refused by the lease, so a `PARTIAL` row can never be seen as free:
 * the release and the `PARTIAL` status are written in the SAME update.
 */
export async function readProgrammeRunBlock(
  schoolId: string,
  programId: string
): Promise<ProgrammeRunBlock> {
  const nothing: ProgrammeRunBlock = {
    blocked: false,
    status: null,
    finishTerms: [],
    remainingTerms: [],
    stoppedAtTermNumber: null,
    message: null,
  };
  try {
    const row: any = await prisma.promotionRun.findFirst({
      where: { id: promotionRunId(schoolId, programId) },
    });
    if (!row) return nothing;
    const status = typeof row.status === "string" ? row.status : null;
    const nums = (v: unknown) =>
      (Array.isArray(v) ? v : []).filter((t): t is number => typeof t === "number").sort((a, b) => b - a);
    const finishTerms = nums(row.finishTerms);
    const remainingTerms = nums(row.remainingTerms);
    const unfinished = status === "PARTIAL" || status === "FAILED";
    if (!unfinished || finishTerms.length === 0) {
      return { ...nothing, status, finishTerms, remainingTerms };
    }
    return {
      blocked: true,
      status,
      finishTerms,
      remainingTerms,
      stoppedAtTermNumber: finishTerms[0],
      message: ladderRunBlockedMessage({ status, finishTerms }),
    };
  } catch {
    // Fail OPEN, deliberately: this is a guard on top of the run, and a read error
    // must not turn a working ladder into a 500. The lease still serialises runs.
    return nothing;
  }
}

/**
 * Strike one term off the failed run's work list, because the SINGLE-POSITION route
 * has just applied it (Phase 6-pre 3).
 *
 * This is how the block LIFTS: the operator finishes the ladder with
 * `POST /api/college-promotion` descending, and each successful apply removes its
 * own term. When the list is empty the row is marked `OK` (with `resolvedAt` and
 * `resolvedBy` for the record), and the ladder is allowed again.
 *
 * It changes NOTHING about that route: it is called after the apply has already
 * written and audited, it reads a row only the ladder writes, it touches only a row
 * whose status is `PARTIAL` / `FAILED`, and it swallows every error — so the route's
 * behaviour, its audit and its response are exactly as before. A term that is not on
 * the list (a re-apply, or a term that never failed) is a no-op.
 */
export async function markProgrammeTermFinished(input: {
  schoolId: string;
  programId: string;
  termNumber: number;
}): Promise<void> {
  try {
    const id = promotionRunId(input.schoolId, input.programId);
    const row: any = await prisma.promotionRun.findFirst({ where: { id } });
    if (!row) return;
    if (row.status !== "PARTIAL" && row.status !== "FAILED") return;
    const finishTerms = (Array.isArray(row.finishTerms) ? row.finishTerms : []).filter(
      (t: unknown): t is number => typeof t === "number"
    );
    if (!finishTerms.includes(input.termNumber)) return;
    const left = finishTerms.filter((t: number) => t !== input.termNumber).sort((a: number, b: number) => b - a);
    await prisma.promotionRun.update({
      where: { id },
      data: left.length
        ? { finishTerms: left }
        : {
            finishTerms: [],
            status: "OK",
            resolvedAt: new Date().toISOString(),
            resolvedBy: "SINGLE_POSITION",
          },
    });
  } catch {
    /* best effort: the apply's own answer is already built and must not change */
  }
}

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
