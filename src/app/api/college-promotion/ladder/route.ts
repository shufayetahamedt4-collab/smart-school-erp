import { NextRequest, NextResponse } from "next/server";
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
 * Guard order (identical to the 5b route):
 *   `getSession()` → target `schoolId` → `requireCollege({ schoolId })` →
 *   `can(role, "registration", "full")` → `writeGuard(schoolId)` (POST only).
 */

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

  return NextResponse.json({
    data: {
      program: { id: (program as any).id, name: (program as any).name },
      termCount,
      steps,
      count: steps.reduce((n, s) => n + s.count, 0),
      counts,
    },
  });
}

/** POST — run the whole ladder, DESCENDING, in ≤400-op slices. */
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

  const ops: any[] = [];
  const flush = async () => {
    while (ops.length) {
      const slice = ops.splice(0, PROMOTION_BATCH);
      await prisma.$transaction(slice);
    }
  };

  let promoted = 0;
  let graduated = 0;
  // A cohort row always came from the store and therefore always has an id, so
  // this stays structurally 0 — it exists to mirror the 5b report.
  let failed = 0;
  const results: any[] = [];

  // DESCENDING — see the header. Each step sees its ORIGINAL cohort because
  // nothing has been moved into it yet, so every student moves exactly one step.
  for (let term = termCount; term >= 1; term--) {
    const ladder: Ladder = { program, programId, fromTermNumber: term, termCount };
    const students = await readCohort(session, ladder);
    const graduating = term === termCount;
    const toTermNumber = graduating ? null : term + 1;

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
      if (ops.length >= PROMOTION_BATCH) await flush();
    }

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
  await flush();

  // ONE audit row for the whole run (D10) — the per-step report is in the body.
  await audit("COLLEGE_PROMOTION", "program", programId, {
    scope: "PROGRAMME_LADDER",
    termCount,
    promoted,
    graduated,
    failed,
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
}
