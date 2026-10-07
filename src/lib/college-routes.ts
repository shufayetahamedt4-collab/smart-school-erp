/**
 * College API segments — the ONE list of college-only route directories.
 *
 * Every college surface lives under `src/app/api/<segment>/…`. The list below is
 * the single source of truth for *which* segments those are, so two things can
 * never disagree:
 *
 *   - the offline guard `scripts/verify-college-routes.mjs`, which statically
 *     asserts that every exported handler in every listed segment calls
 *     `requireCollege()` first, and
 *   - a future route author, who adds the new segment name here as part of the
 *     change that creates the route — the same "each phase adds its own entry in
 *     the same change that creates it" rule as the nav registry
 *     (docs/COLLEGE-DECISIONS.md §8, D-A).
 *
 * Why this matters: `src/middleware.ts` returns `NextResponse.next()` for every
 * `/api` path and therefore cannot see `institutionType`, so `requireCollege()`
 * (`src/lib/auth.ts`) is the ONLY thing keeping a SCHOOL tenant out of college
 * data. A college route that forgets that call fails silently and leaks
 * cross-tenant rows; it does not crash. The guard makes that failure loud at
 * build/verify time instead of at runtime.
 *
 * This module is deliberately dependency-free (no prisma, no node: imports) —
 * the same design as `institution.ts` and `sectors.ts` — so a verifier running
 * under plain `node`, a client component and Edge code can all import it.
 *
 * Phase 3 (`docs/COLLEGE-DECISIONS.md` §10): the catalogue phase. `courses` is
 * added to this list by its own change, together with `programCourses` under the
 * same segment, once those routes exist.
 */

export const COLLEGE_API_SEGMENTS = ["departments", "programs"] as const;

export type CollegeApiSegment = (typeof COLLEGE_API_SEGMENTS)[number];

/** Set form for membership tests (a plain Set so an unknown value is rejected safely). */
export const COLLEGE_API_SEGMENT_SET: ReadonlySet<string> = new Set(COLLEGE_API_SEGMENTS);

/** Is this exactly one of the listed college segments? */
export function isCollegeApiSegment(value: unknown): value is CollegeApiSegment {
  return typeof value === "string" && COLLEGE_API_SEGMENT_SET.has(value);
}
