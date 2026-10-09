import { NextRequest, NextResponse } from "next/server";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, requireCollege, audit, type SessionUser } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";
import { buildCollegePromotionPreview } from "@/lib/college-promotion";
import {
  PROMOTION_BATCH,
  readCohort,
  readPendingCounts,
  resolveProgramme,
  LADDER_RUN_IN_PROGRESS_MESSAGE,
  claimProgrammeRun,
  finaliseProgrammeRun,
  readProgrammeRunBlock,
  type Ladder,
} from "@/lib/college-promotion-server";

/**
 * Phase 5d — the WHOLE-PROGRAMME ladder (docs/COLLEGE-DECISIONS.md §19).
 *
 *   GET  ?programId=      → the plan: every term's cohort and its one move, in
 *                           ASCENDING term order, so an operator reviews each step.
 *   POST { programId }    → run it: every cohort advances exactly one step, and
 *                           the programme's final term graduates as ALUMNI.
 *
 * This is the SAME ladder as `/api/college-promotion` (5b), applied to every
 * position at once instead of one. It is a SEPARATE route rather than a mode of
 * the 5b one so the single-position contract stays exactly as it shipped, and it
 * lives under the same `college-promotion` segment — so it is covered by
 * `scripts/verify-college-routes.mjs` check 2 (that walk is recursive) and the
 * gate below is asserted statically.
 *
 * **The ordering rule, and why it is the server's job.** "Advance every term" must
 * move each cohort exactly ONE step. Applying the positions in ASCENDING order
 * would re-sweep the students it had just moved — a student advanced 1 → 2 would be
 * picked up again by the step for term 2 and pushed onward, so the whole programme
 * would cascade to graduation in a single run. The run therefore walks the
 * positions DESCENDING: term `termCount` first (graduate it), then `termCount-1`
 * (advance into the now-empty final term), … down to 1. Because a student holds
 * exactly one `termNumber`, the cohorts are disjoint, so walking downward
 * guarantees every position sees its ORIGINAL cohort and every student moves
 * exactly once. Keeping that rule here — not in the browser, which could send the
 * positions in any order — is the reason this endpoint exists.
 *
 * The plan (GET) is read-only and returns the steps ASCENDING, which is how a
 * reviewer wants to read the programme. The run (POST) writes DESCENDING and
 * reports each step's result. Its `steps` are returned ASCENDING for the same
 * reason; the write order is this comment's and the `for` loop's.
 *
 * Everything else is unchanged from 5b, because the helpers are shared
 * (`src/lib/college-promotion-server.ts`) and the rules are the same:
 *   D2/D3 — the cohort is STRICT and recomputed per position; no client ids, no
 *      marker, no preview output is trusted, and a re-run selects nobody.
 *   D4  — only students WITH a programme; a cohort member that also holds a
 *      `classId` is flagged (`classIdWarning`) since the SCHOOL ladder may move it.
 *   D5  — the final term graduates (`status = "ALUMNI"`); a graduating step has no
 *      destination term.
 *   D6  — registrations/pending counts are INFO ONLY and never block a step.
 *   D7  — registrations are untouched; only the student's own fields are written.
 *   D9  — no `sessionId` is read or written.
 *   D10 — the write path is the 5b one: `prisma.$transaction` in ≤400-operation
 *      slices, then ONE `audit` for the whole run, `invalidateStats` and
 *      `invalidateReferenceCache`.
 *
 * Phase 5d-2 — the run FAILS SAFELY (docs/COLLEGE-DECISIONS.md §20). Each step is
 * flushed at its END, never mid-step across a term boundary; a mid-run failure is
 * caught and answered with a STRUCTURED 500 (the steps COMPLETED, the step that
 * FAILED and the terms never ATTEMPTED) plus a best-effort audit row, so a partial
 * run is neither silent nor invisible. The operator is told to finish the remaining
 * terms with the idempotent single-position route (`POST /api/college-promotion`),
 * DESCENDING — re-running the ladder would double-advance the steps that landed.
 *
 * Phase 6-pre 2 — ONE RUN AT A TIME (docs/COLLEGE-DECISIONS.md §21). The POST now
 * takes a per-(school, programme) LEASE through `prisma.$claim` (a real Firestore
 * transaction: read, then conditional write) BEFORE it reads its first cohort, and
 * releases it in a `finally`. A second concurrent run of the same programme is
 * refused with 409 and writes NOTHING — the concurrency limitation §20 recorded as
 * D-5d2-7 is closed here. A lease older than `LADDER_LEASE_MS` is abandoned, not
 * held, so a crashed run cannot wedge a programme. The single-position route is
 * deliberately NOT leased: it is idempotent by construction (D2/D3) and it is the
 * documented way to FINISH a partial ladder, so leasing it would break the very
 * recovery this route's 500 message tells the operator to perform. Residual, and
 * recorded rather than hidden: a deliberate single-position apply fired at the same
 * moment as a ladder run is still possible — the lease serialises whole-programme
 * runs against each other, not against that. The GET plan is unaffected and the
 * structured-500 contract is unchanged.
 *
 * Phase 6-pre 3 — A FAILED RUN BLOCKS THE LADDER UNTIL IT IS FINISHED (§21). A run
 * that threw midway recorded what it completed and what it did NOT (`finishTerms`:
 * the failed term plus the terms never attempted). While that work list is outstanding
 * a re-run is refused with 409 — re-running the ladder would advance the steps that
 * already landed a second time — and the refusal names the outstanding terms and the
 * single-position route that finishes them, DESCENDING. The block lifts when the
 * SINGLE-POSITION route has applied those terms (it strikes each one off the row), so
 * it is decided by the route's own writes and never inferred from a student's term
 * number, which the finishing walk re-fills. A clean `OK` run records an empty list
 * and never blocks, and the GET plan exposes the state additively (`data.runBlock`).
 *
 * Guard order (identical to the 5b route):
 *   `getSession()` → target `schoolId` → `requireCollege({ schoolId })` →
 *   `can(role, "registration", "full")` → `writeGuard(schoolId)` (POST only).
 */

/**
 * TEST-ONLY fault injection for `scripts/verify-college-promotion-api.mjs` (§20, D-5d2-8).
 *
 * A deterministic mid-run failure is otherwise unreachable over HTTP: every write this
 * route makes is a valid single-field update, so no request can make a step fail. The
 * verifier therefore plants a JSON file naming a programme and a term, runs the ladder,
 * and deletes the file; this helper turns that file into the failure. It is DOUBLE-gated
 * so a NORMAL request can never reach it:
 *
 *   1. a production build returns null immediately (`NODE_ENV === "production"`), so the
 *      switch is inert in production whatever happens to be on disk;
 *   2. the fault comes from a FILE, never from the request — no header, body or query
 *      parameter can trigger it — and the file names the EXACT programme id, which in
 *      practice is only ever the throwaway programme the verifier created.
 *
 * The file lives in the OS temp directory (never inside the app), so it is not a build
 * input and is not part of any deployment.
 */
function ladderFault(programId: string, term: number): string | null {
  if (process.env.NODE_ENV === "production") return null;
  try {
    const spec = JSON.parse(readFileSync(join(tmpdir(), "smart-school-qa-ladder-fault.json"), "utf8"));
    if (spec && spec.programId === programId && Number(spec.term) === term) {
      return typeof spec.message === "string" && spec.message ? spec.message : "Injected ladder fault (test-only).";
    }
  } catch {
    /* no fault file — the ordinary path */
  }
  return null;
}

/** The tallies a step and the whole plan carry (mirrors the 5b preview shape). */
interface StepCounts {
  advance: number;
  graduate: number;
  classIdWarnings: number;
  pendingRegistrations: number;
}

/**
 * Resolve the programme and refuse a ladder that cannot exist.
 *
 * `resolveProgramme` already answers the tenant/branch/ACTIVE questions (and the
 * foreign-id-is-a-400 rule). A programme whose derived term count is 0 has no
 * resolvable ladder, so a run is a 400 rather than a silent no-op — the same
 * "cannot decide" reading `college-promotion.ts` gives a 0 count.
 */
async function resolveRun(programIdRaw: unknown, session: SessionUser) {
  const resolved = await resolveProgramme(session, programIdRaw);
  if (!resolved.ok) return { ok: false as const, status: resolved.status, message: resolved.message };
  if (resolved.programme.termCount === 0) {
    return {
      ok: false as const,
      status: 400,
      message: "This programme has no resolvable terms, so it has no ladder to run.",
    };
  }
  return { ok: true as const, ...resolved.programme };
}

/** GET — the plan: every term's cohort and its move, ASCENDING. Reads only. */
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

  const resolved = await resolveRun(req.nextUrl.searchParams.get("programId"), session);
  if (!resolved.ok) return NextResponse.json({ error: resolved.message }, { status: resolved.status });
  const { program, programId, termCount } = resolved;

  const steps: any[] = [];
  const counts: StepCounts = { advance: 0, graduate: 0, classIdWarnings: 0, pendingRegistrations: 0 };
  for (let term = 1; term <= termCount; term++) {
    const ladder: Ladder = { program, programId, fromTermNumber: term, termCount };
    const [students, pendingRegistrationCounts] = await Promise.all([
      readCohort(session, ladder),
      readPendingCounts(session, ladder),
    ]);
    const preview = buildCollegePromotionPreview({
      students,
      programId,
      fromTermNumber: term,
      termCount,
      pendingRegistrationCounts,
    });
    steps.push({
      fromTermNumber: preview.fromTermNumber,
      toTermNumber: preview.graduating ? null : preview.fromTermNumber + 1,
      graduating: preview.graduating,
      rows: preview.rows,
      count: preview.count,
      counts: preview.counts,
    });
    counts.advance += preview.counts.advance;
    counts.graduate += preview.counts.graduate;
    counts.classIdWarnings += preview.counts.classIdWarnings;
    counts.pendingRegistrations += preview.counts.pendingRegistrations;
  }

  // Phase 6-pre 3 — ADDITIVE: whether a re-run would be refused, and why. The
  // operator must be able to see the blocked state BEFORE pressing Run, and the step
  // list above is unchanged, so an existing reader of this plan sees the same plan.
  const runBlock = await readProgrammeRunBlock(schoolId, programId);

  return NextResponse.json({
    data: {
      program: { id: (program as any).id, name: (program as any).name },
      termCount,
      steps,
      count: steps.reduce((n, s) => n + s.count, 0),
      counts,
      runBlock,
    },
  });
}

/** POST — run the whole ladder, DESCENDING, flushing each step at its END (§20). */
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
  const resolved = await resolveRun(body?.programId, session);
  if (!resolved.ok) return NextResponse.json({ error: resolved.message }, { status: resolved.status });
  const { program, programId, termCount } = resolved;

  // ---- Phase 6-pre 3: no re-run while the LAST run is unfinished (docs §21) ---
  // A run that failed midway left a work list on its row (`finishTerms`). Re-running
  // the LADDER would advance the steps that already landed a second time, so the
  // refusal lists the outstanding terms and names the single-position route instead.
  // Checked BEFORE the claim, so a blocked request takes no lease and writes nothing;
  // and the check cannot be fooled by a race, because the release and the PARTIAL
  // status are the SAME write, so a row this read sees as free is a row whose status
  // is already settled. Placed after every authorization step: a 403 must never learn
  // anything about a programme's run state.
  const block = await readProgrammeRunBlock(schoolId, programId);
  if (block.blocked) {
    return NextResponse.json(
      {
        error: block.message,
        data: {
          status: block.status,
          finishTerms: block.finishTerms,
          remainingTerms: block.remainingTerms,
          stoppedAtTermNumber: block.stoppedAtTermNumber,
        },
      },
      { status: 409 }
    );
  }

  // ---- Phase 6-pre 2: ONE whole-programme run at a time (docs §21) ----------
  // The claim is ATOMIC (`prisma.$claim`: a real Firestore transaction, read then
  // conditional write). Two runs that race cannot both win, and a live lease means
  // another run is already moving this programme's cohorts — so this request
  // writes NOTHING. Claimed AFTER every authorization step (a 403 must never take
  // a lease) and BEFORE the first cohort read, because the cohort a run walks must
  // not be able to change underneath it.
  const claim = await claimProgrammeRun({
    schoolId,
    programId,
    branchId: (program as any).branchId ?? null,
    ownerId: (session as any).id ?? null,
  });
  if (!claim.claimed) {
    return NextResponse.json(
      { error: LADDER_RUN_IN_PROGRESS_MESSAGE, data: { status: "IN_PROGRESS" } },
      { status: 409 }
    );
  }

  // The steps that COMPLETED, in application order (descending). A step's ops are
  // collected in its own array and flushed at its END, so a slice never spans two
  // steps (D-5d2-2). A step that needs more than one ≤400-op slice is still
  // recoverable: the single-position route is idempotent for that position (D2), so
  // finishing a half-applied step with `POST /api/college-promotion` cannot advance
  // anybody twice.
  const results: any[] = [];
  let promoted = 0;
  let graduated = 0;
  // A cohort row always came from the store and therefore always has an id, so
  // this stays structurally 0 — it exists to mirror the 5b report.
  let failed = 0;
  let wroteAnything = false;
  let attemptedTerm: number | null = null;
  let attemptedCount: number | null = null;
  let failure: any = null;
  // What the `finally` records on the run's row when the run does NOT complete
  // (Phase 6-pre 2). Filled in by the failure branch below, and read only by the
  // release — never by the response, whose shape is unchanged.
  let runCompleted: any[] = [];
  let runRemainingTerms: number[] = [];
  let runFinishTerms: number[] = [];
  let runReason: string | null = null;

  /** Send one step's ops as ≤PROMOTION_BATCH-op slices. Any committed slice counts
   *  as a write, which is what distinguishes PARTIAL from FAILED in the report. */
  const flushStep = async (ops: any[]) => {
    while (ops.length) {
      const slice = ops.splice(0, PROMOTION_BATCH);
      await prisma.$transaction(slice);
      wroteAnything = true;
    }
  };

  try {
    // DESCENDING — see the header. Each step sees its ORIGINAL cohort because
    // nothing has been moved into it yet, so every student moves exactly one step.
    for (let term = termCount; term >= 1; term--) {
      const ladder: Ladder = { program, programId, fromTermNumber: term, termCount };
      attemptedTerm = term;
      const students = await readCohort(session, ladder);
      attemptedCount = students.length;
      const graduating = term === termCount;
      const toTermNumber = graduating ? null : term + 1;

      // TEST-ONLY fault injection: thrown BEFORE this step writes, so a failed step
      // is atomic (all-or-nothing) and the already-completed steps stay applied.
      const fault = ladderFault(programId, term);
      if (fault) throw new Error(fault);

      const ops: any[] = [];
      let stepPromoted = 0;
      let stepGraduated = 0;
      let stepFailed = 0;
      for (const student of students) {
        if (typeof student?.id !== "string" || !student.id) {
          stepFailed += 1;
          continue;
        }
        // D5/D7/D9 — the same single-field writes the 5b route makes.
        const data: Record<string, any> = graduating ? { status: "ALUMNI" } : { termNumber: toTermNumber };
        ops.push(prisma.student.update({ where: { id: student.id }, data }));
        if (graduating) stepGraduated += 1;
        else stepPromoted += 1;
      }
      await flushStep(ops); // the END of the step — never mid-step across terms

      promoted += stepPromoted;
      graduated += stepGraduated;
      failed += stepFailed;
      results.push({
        fromTermNumber: term,
        toTermNumber,
        graduating,
        count: students.length,
        promoted: stepPromoted,
        graduated: stepGraduated,
        failed: stepFailed,
      });
    }
  } catch (e) {
    failure = e;
  }

  // Everything from here runs under the lease, released in the `finally` below
  // whatever the outcome: a completed run marks the row OK (so the NEXT run is
  // allowed — unchanged behaviour), a failed one records why (read in 6-pre 3).
  try {
    if (failure) {
      // A PARTIAL run: report what landed, what failed and what was never attempted,
      // and audit it, so the half-done ladder is neither silent nor invisible (§20).
      const completed = results.slice().sort((a, b) => a.fromTermNumber - b.fromTermNumber);
      const remainingTerms: number[] = [];
      const fromTerm = attemptedTerm === null ? termCount : attemptedTerm;
      for (let t = fromTerm - 1; t >= 1; t--) remainingTerms.push(t);
      // To finish safely: re-apply the FAILED term (idempotent, D2) and then every
      // not-attempted term, all DESCENDING. Re-running the LADDER is forbidden here:
      // the steps that landed have moved students into the next term, so a ladder
      // re-run would advance them a SECOND time.
      const finishTerms = attemptedTerm === null ? remainingTerms : [attemptedTerm, ...remainingTerms];
      const status = wroteAnything ? "PARTIAL" : "FAILED";
      const failedStep =
        attemptedTerm === null
          ? null
          : {
              fromTermNumber: attemptedTerm,
              toTermNumber: attemptedTerm === termCount ? null : attemptedTerm + 1,
              graduating: attemptedTerm === termCount,
              count: attemptedCount,
            };
      const completedText = completed.length
        ? completed.map((s) => `term ${s.fromTermNumber} (${s.promoted} advanced, ${s.graduated} graduated)`).join("; ")
        : "none";
      const remainingText = remainingTerms.length ? remainingTerms.map((t) => `term ${t}`).join(", ") : "none";
      const finishText = finishTerms.map((t) => `term ${t}`).join(", then ");
      const message =
        `The ladder run stopped at term ${attemptedTerm ?? "?"}. Completed: ${completedText}. ` +
        `Failed: term ${attemptedTerm ?? "?"}. Not attempted: ${remainingText}. ` +
        `The completed terms are already written, so do NOT re-run the ladder (that would advance them again). ` +
        `Finish the rest with the single-position apply (POST /api/college-promotion), descending: ${finishText}.`;

      // Best effort — `audit()` already swallows its own failure, and this try/catch
      // guarantees an audit problem can never mask the original write error.
      try {
        await audit("COLLEGE_PROMOTION", "program", programId, {
          scope: "PROGRAMME_LADDER",
          status,
          termCount,
          promoted,
          graduated,
          failed,
          completed,
          failedStep,
          remainingTerms,
          reason: String(failure?.message || failure),
        });
      } catch {
        /* best effort: never mask the original error */
      }
      invalidateStats(schoolId, "students");
      invalidateReferenceCache(schoolId);

      // Phase 6-pre 2: hand this outcome to the release in the `finally`, so the
      // run's row says how it ended (OK / PARTIAL / FAILED) without the response
      // shape changing at all.
      runCompleted = completed;
      runRemainingTerms = remainingTerms;
      // The work list Phase 6-pre 3 refuses a re-run against and the single-position
      // route strikes off, term by term (the failed term first).
      runFinishTerms = finishTerms;
      runReason = String(failure?.message || failure);

      return NextResponse.json(
        {
          error: message,
          data: {
            programId,
            termCount,
            status,
            promoted,
            graduated,
            failed,
            completed,
            failedStep,
            remainingTerms,
            finishTerms,
            reason: String(failure?.message || failure),
          },
        },
        // 500, NOT 207: the run did not complete and left a partial write behind. The
        // shared client treats every 2xx (207 included) as success — it returns only
        // `body.data` and never throws — so a 207 would silently take the UI's success
        // path and hide the failure. 500 keeps it on the error path, and `error`
        // carries the whole report.
        { status: 500 }
      );
    }

    // ONE audit row for the whole run (D10) — now carrying the per-step breakdown.
    await audit("COLLEGE_PROMOTION", "program", programId, {
      scope: "PROGRAMME_LADDER",
      status: "OK",
      termCount,
      promoted,
      graduated,
      failed,
      steps: results.slice().sort((a, b) => a.fromTermNumber - b.fromTermNumber),
    });
    invalidateStats(schoolId, "students");
    invalidateReferenceCache(schoolId);

    return NextResponse.json({
      data: {
        programId,
        termCount,
        promoted,
        graduated,
        failed,
        // Ascending for the reader; the writes happened descending (see header).
        steps: results.slice().sort((a, b) => a.fromTermNumber - b.fromTermNumber),
      },
    });
  } finally {
    await finaliseProgrammeRun({
      schoolId,
      programId,
      status: failure ? (wroteAnything ? "PARTIAL" : "FAILED") : "OK",
      completed: failure
        ? runCompleted
        : results.slice().sort((a, b) => a.fromTermNumber - b.fromTermNumber),
      remainingTerms: failure ? runRemainingTerms : [],
      finishTerms: failure ? runFinishTerms : [],
      reason: runReason,
    });
  }
}
