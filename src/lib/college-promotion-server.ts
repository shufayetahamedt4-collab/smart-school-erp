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
import { seamTtlMs, seamFailRead } from "@/lib/college-promotion-seam";

/** The Firestore write-batch chunk the rest of the codebase uses (school ladder). */
export const PROMOTION_BATCH = 400;

/**
 * How long a run may go WITHOUT RENEWING its programme lease (Phase 6-pre 4,
 * docs/COLLEGE-DECISIONS.md §22).
 *
 * Phase 6-pre 2 sized this as "longer than a whole run", which was the wrong shape:
 * a run that outlived it could be taken over mid-flight and double-advance a cohort.
 * The run now RENEWS before every step and before every ≤400-op slice flush
 * (`renewProgrammeRun`), so this window only has to cover ONE slice — the longest gap
 * between two renewals — and it is renewed on the run's own key, so a successor can
 * still only take over a run that has genuinely stopped renewing.
 *
 * 30 s is a deliberate safety factor on a MEASURED slice (§22 records the numbers):
 * 400 single-field writes in one `WriteBatch` against the local emulator took 195 ms
 * cold and 23 / 14 ms warm, so the window covers a slice ~150× over. A production
 * worst case (cold Cloud Firestore, a full batch, contention) is **NOT PROVEN** — it
 * is reasoned about in §22 — and a crashed run is still recoverable in 30 s rather
 * than two minutes.
 */
export const LADDER_LEASE_MS = 30 * 1000;

/**
 * The abort reason when a run discovers it no longer owns its lease (Phase 6-pre 4).
 *
 * It reaches the operator through the structured 500's `data.reason` — the response
 * shape itself is unchanged — and it says what happened and what to do, because the
 * run has stopped and the remaining terms now belong to the operator.
 */
export const LADDER_LEASE_LOST_MESSAGE =
  "Another run has taken over this programme's lease, so this run stopped where it was. The terms reported as completed are already applied; finish the rest with the single-position apply, descending.";

/**
 * The refusal when the programme's run state cannot be READ (Phase 6-pre 4).
 *
 * The block used to fail OPEN (a read error read as "not blocked"), which would let a
 * re-run double-advance a half-applied ladder precisely when the store is having
 * trouble. It now fails CLOSED: the ladder does not start, nothing is written, and
 * the operator is told to try again.
 */
export const LADDER_BLOCK_UNREADABLE_MESSAGE =
  "This programme's run state could not be read, so the ladder was not started. Nothing was written. Try again in a moment.";

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

/**
 * WHO holds a claimed lease: the id the run records and the instant it was claimed.
 * Both are written by `$claim` and compared by every later owned write, so a successor
 * taking the row over changes them and the previous run can no longer renew, release
 * or overwrite it (Phase 6-pre 4).
 */
export interface ProgrammeRunOwner {
  ownerId: string | null;
  acquiredAtMs: number;
}

/** What a claim attempt answered. */
export interface ProgrammeRunClaim {
  /** The row's document id (deterministic from the pair). */
  id: string;
  /** True when THIS caller now holds the programme's lease. */
  claimed: boolean;
  /** The key every later owned write (renew/release) must still match. */
  owner: ProgrammeRunOwner;
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
export async function claimProgrammeRun(
  input: {
    schoolId: string;
    programId: string;
    branchId?: string | null;
    ownerId?: string | null;
  },
  /** TEST-ONLY override of the lease window (a shorter one lets a verifier outlive a
   *  renewal interval deterministically); unset in production.
   *
   *  Phase 6-pre 6 — the option is INERT IN PRODUCTION HERE, not at the caller:
   *  `seamTtlMs` returns `undefined` whenever `NODE_ENV === "production"`, whatever is
   *  passed in, so a future caller cannot make this knob live by forwarding request
   *  data. The guard is proved behaviourally in `verify-college-promotion-page.mjs`
   *  (§22 D-6pre6-2/3). */
  options: { ttlMs?: number } = {}
): Promise<ProgrammeRunClaim> {
  const id = promotionRunId(input.schoolId, input.programId);
  const ttlMs = seamTtlMs(options.ttlMs);
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
    { ttlMs: ttlMs ?? LADDER_LEASE_MS, attemptedAtMs }
  );
  return {
    id,
    claimed: result.claimed,
    owner: { ownerId: input.ownerId ?? null, acquiredAtMs: attemptedAtMs },
  };
}

/**
 * Renew this run's lease, atomically, only while it is still the owner
 * (Phase 6-pre 4).
 *
 * Called before every step and before every ≤400-op slice flush. It is one
 * transaction (`$renewOwned`): read, compare `ownerId` + `acquiredAtMs`, write the new
 * expiry. `renewed: false` means the row is GONE or a successor holds it — the run
 * must stop, write nothing further, and say so.
 *
 * A renewal never touches a row it does not own, so it cannot revive a lease that has
 * already been taken over.
 */
export async function renewProgrammeRun(input: {
  schoolId: string;
  programId: string;
  owner: ProgrammeRunOwner;
  ttlMs?: number;
}): Promise<{ renewed: boolean; reason?: string }> {
  const result = await prisma.$renewOwned("promotionRun", promotionRunId(input.schoolId, input.programId), {
    ownerId: input.owner.ownerId,
    acquiredAtMs: input.owner.acquiredAtMs,
    ttlMs: input.ttlMs ?? LADDER_LEASE_MS,
  });
  return result.ok ? { renewed: true } : { renewed: false, reason: result.reason };
}

/**
 * Release the lease and record how the run ended (Phase 6-pre 2).
 *
 * Called from the run's `finally`, on SUCCESS and on FAILURE alike, so a lease can
 * never outlive its run. It clears `expiresAtMs`, which is what makes the lease
 * released rather than merely re-stamped: the moment a run ends, the next run is
 * allowed — unless this run FAILED, in which case Phase 6-pre 3 refuses the next
 * LADDER run until the recorded work list has been applied.
 *
 * Phase 6-pre 4: it does so ONLY while this run still owns the row. If a successor
 * took the lease over, the row is left exactly as the successor left it, and the
 * refusal is reported (`released: false`) instead of silently ignored.
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
  /** The key this run claimed with — the release happens ONLY if it still matches. */
  owner: ProgrammeRunOwner;
  status: "OK" | "PARTIAL" | "FAILED";
  completed?: any[];
  remainingTerms?: number[];
  /** The terms that still have to be applied, DESCENDING (Phase 6-pre 3). */
  finishTerms?: number[];
  reason?: string | null;
}): Promise<{ released: boolean; reason?: string }> {
  // PHASE 6-PRE 4: owned, NOT unconditional. `$releaseOwned` compares this run's key
  // (ownerId + acquiredAtMs) inside a transaction and writes the ending ONLY if the
  // row is still this run's. A run that lost its lease therefore cannot clear a
  // SUCCESSOR's `expiresAtMs` or overwrite its status — which is what the previous
  // unconditional merge update could do, letting a third run straight in.
  const result = await prisma.$releaseOwned(
    "promotionRun",
    promotionRunId(input.schoolId, input.programId),
    {
      status: input.status,
      finishedAt: new Date().toISOString(),
      completed: input.completed ?? [],
      remainingTerms: input.remainingTerms ?? [],
      // The failed term PLUS the terms never attempted, DESCENDING: the work list the
      // single-position route strikes off, one term at a time (6-pre 3). Empty for a
      // clean run, which is what makes an OK run never block.
      finishTerms: input.finishTerms ?? [],
      reason: input.reason ?? null,
      // `expiresAtMs: 0` and `releasedAtMs` are written BY the helper, on the same
      // transaction that proved the row is still ours.
    },
    { ownerId: input.owner.ownerId, acquiredAtMs: input.owner.acquiredAtMs }
  );
  // Never thrown: a release that could not be written (or was refused because the
  // lease is gone) is REPORTED to the caller and must not change the run's own answer.
  return result.ok ? { released: true } : { released: false, reason: result.reason };
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
 *
 * PHASE 6-PRE 4 — it FAILS CLOSED. Until then a store error was swallowed and read as
 * "not blocked", which would let a re-run double-advance a half-applied ladder exactly
 * when the store is unhealthy. Now a read error is THROWN: the ladder's POST answers
 * 503 and writes nothing at all (`LADDER_BLOCK_UNREADABLE_MESSAGE`), and a programme
 * that has never run is still simply "not blocked" (`no row = no block`).
 */
export async function readProgrammeRunBlock(
  schoolId: string,
  programId: string,
  /** TEST-ONLY (Phase 6-pre 4): force the unreadable case. Set ONLY from the temp-file
   *  seam and never from a request body.
   *
   *  Phase 6-pre 6 — INERT IN PRODUCTION HERE, not at the caller: `seamFailRead` is
   *  false whenever `NODE_ENV === "production"`, whatever is passed in, so this is the
   *  last line of defence even if a caller forwards request data. Proved
   *  behaviourally in `verify-college-promotion-page.mjs` (§22 D-6pre6-2/3). */
  options: { failRead?: boolean } = {}
): Promise<ProgrammeRunBlock> {
  const nothing: ProgrammeRunBlock = {
    blocked: false,
    status: null,
    finishTerms: [],
    remainingTerms: [],
    stoppedAtTermNumber: null,
    message: null,
  };
  if (seamFailRead(options.failRead)) throw new Error("qa-injected block read failure (test-only)");
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

/* ---------------------------------------------------------------------------
 * Phase 6-pre 5 — the audited ABANDON hatch, and the run row after the PROGRAMME
 * changed (docs/COLLEGE-DECISIONS.md §22)
 * ------------------------------------------------------------------------- */

/** A term list off a row, DESCENDING, numbers only (the block's own reading). */
function termsDesc(v: unknown): number[] {
  return (Array.isArray(v) ? v : [])
    .filter((t): t is number => typeof t === "number")
    .sort((a, b) => b - a);
}

/**
 * The shortest reason that may abandon a run. A one-word reason is not a record of
 * WHY a whole ladder was given up, and the reason is the only thing a later reader
 * has; the number is stated here, enforced by `abandonReasonProblem`, and mirrored
 * (as a DISABLE rule, never as the enforcement) by the page.
 */
export const ABANDON_REASON_MIN = 10;

/** The status an abandoned run's row carries. NOT a block: only PARTIAL/FAILED are. */
export const ABANDON_STATUS = "ABANDONED";

/** The reason problem, or null when the reason is acceptable (trimmed, >= min). */
export function abandonReasonProblem(reason: unknown): string | null {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (!text) return "A reason is required to abandon a run.";
  if (text.length < ABANDON_REASON_MIN) {
    return `The reason must be at least ${ABANDON_REASON_MIN} characters, so the record says WHY the run was given up.`;
  }
  return null;
}

/**
 * Abandon a programme's UNFINISHED run (Phase 6-pre 5) — the escape hatch for a work
 * list that can never be finished.
 *
 * It moves NO student and it does NOT undo the terms that already ran: it only marks
 * the row `ABANDONED`, keeps `finishTerms` as the record of what was owed, and stores
 * the reason (`resolvedAt`/`resolvedBy` say who and when). An `ABANDONED` row is NOT a
 * block — `readProgrammeRunBlock` only refuses on `PARTIAL`/`FAILED` — so the ladder is
 * usable again immediately, and a later run will advance the terms that were never
 * applied (which is exactly what the page's confirmation says, bluntly).
 *
 * Only a `PARTIAL`/`FAILED` row can be abandoned: an `OK` run has nothing to abandon,
 * and a LIVE lease (`IN_PROGRESS`) belongs to a run that is still working, so both are
 * refused (409) rather than raced. The previous failure reason is PRESERVED on
 * `failureReason` so the abandon does not erase the history it replaces.
 */
export async function abandonProgrammeRun(input: {
  schoolId: string;
  programId: string;
  actorId?: string | null;
  reason: string;
}): Promise<
  { ok: true; status: string; finishTerms: number[] } | { ok: false; status: number; message: string }
> {
  const id = promotionRunId(input.schoolId, input.programId);
  const row: any = await prisma.promotionRun.findFirst({ where: { id } });
  if (!row) {
    return { ok: false, status: 409, message: "This programme has no unfinished run to abandon." };
  }
  const status = typeof row.status === "string" ? row.status : "";
  if (status !== "PARTIAL" && status !== "FAILED") {
    return {
      ok: false,
      status: 409,
      message: `Only an unfinished run (PARTIAL or FAILED) can be abandoned; this programme's run is ${status || "unknown"}.`,
    };
  }
  const finishTerms = termsDesc(row.finishTerms);
  await prisma.promotionRun.update({
    where: { id },
    data: {
      status: ABANDON_STATUS,
      resolvedAt: new Date().toISOString(),
      resolvedBy: ABANDON_STATUS,
      reason: input.reason,
      // The failure that made the run unfinished is KEPT, not overwritten by the
      // abandon reason: the row is the only record of either.
      failureReason: row.reason ?? null,
      abandonedBy: input.actorId ?? null,
      // `finishTerms` is deliberately left as it is: it is the record of what was owed.
    },
  });
  return { ok: true, status: ABANDON_STATUS, finishTerms };
}

/**
 * Reconcile a programme's run row after the programme was SHRUNK (Phase 6-pre 5).
 *
 * A run's work list names terms of the ladder it walked. If the programme's derived
 * term count falls, a listed term ABOVE the new end can never be applied again — the
 * single-position route would refuse it — so it would block the ladder for ever. So
 * the list is filtered to terms `<= termCount`; when that leaves nothing and the run
 * was unfinished, the row becomes `OK` with `resolvedBy: "RECONCILE"` (the block lifts
 * because there is provably nothing left to apply).
 *
 * Best effort by design, and CALLED FROM THE PROGRAMMES ROUTE ONLY AFTER its own write
 * has succeeded: the programmes route's response, status and audit are unchanged by
 * anything that happens here, and a failure to write the row is swallowed.
 *
 * **Defensive, and recorded as such**: the filter can only empty the list when a
 * programme's terms fall below the LOWEST outstanding term. `parseDuration` requires
 * 1..6 years and every work list always contains term 1, so on the shipped routes that
 * branch is unreachable — it exists so a hand-written or future row cannot wedge a
 * programme, and it is NOT PROVEN over HTTP (§22).
 */
export async function reconcileProgrammeRunAfterShrink(input: {
  schoolId: string;
  programId: string;
  termCount: number;
}): Promise<void> {
  try {
    const id = promotionRunId(input.schoolId, input.programId);
    const row: any = await prisma.promotionRun.findFirst({ where: { id } });
    if (!row) return;
    const terms = termsDesc(row.finishTerms);
    const kept = terms.filter((t) => t <= input.termCount);
    if (kept.length === terms.length) return; // nothing referenced the dropped terms
    const unfinished = row.status === "PARTIAL" || row.status === "FAILED";
    if (kept.length) {
      await prisma.promotionRun.update({ where: { id }, data: { finishTerms: kept } });
      return;
    }
    if (!unfinished) return;
    await prisma.promotionRun.update({
      where: { id },
      data: {
        finishTerms: [],
        status: "OK",
        resolvedAt: new Date().toISOString(),
        resolvedBy: "RECONCILE",
      },
    });
  } catch {
    /* best effort: the programmes route's own answer must never change */
  }
}

/**
 * Delete a programme's run row after the programme itself was deleted
 * (Phase 6-pre 5).
 *
 * The row is addressed by a hash of `(schoolId, programId)`, so it is NOT reachable by
 * any prefix scan — a deleted programme would otherwise leave an orphan nobody can
 * find. Best effort, called only after the programmes route's delete has succeeded, and
 * it never changes that route's response.
 */
export async function deleteProgrammeRunRow(input: { schoolId: string; programId: string }): Promise<void> {
  try {
    const id = promotionRunId(input.schoolId, input.programId);
    const row = await prisma.promotionRun.findFirst({ where: { id } });
    if (row) await prisma.promotionRun.delete({ where: { id } });
  } catch {
    /* best effort: the programmes route's own answer must never change */
  }
}
