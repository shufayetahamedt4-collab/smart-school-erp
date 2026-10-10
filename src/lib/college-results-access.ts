/**
 * College results — WHO may READ them, in the ONE place that decides it
 * (Phase 6d-fix, docs/COLLEGE-DECISIONS.md §23.6, owner ruling 2026-10-10).
 *
 * v1 read access is deliberately narrower than the `attendanceMarks` module the
 * routes reuse (Q5): the results and the transcript are administration documents,
 * so the roles that may read them are the **admin-level roles and the REGISTRAR**
 * — `SUPER_ADMIN`, `SCHOOL_ADMIN`, `BRANCH_ADMIN`, `REGISTRAR`.
 *
 * `TEACHER`, `GUARDIAN` and `STUDENT` are DENIED, and the ruling records why: the
 * module alone would admit a guardian (`attendanceMarks: view`) and a teacher
 * (`entry` implies `view`), and §23.6 already says there is **no parent/guardian
 * transcript view** in v1. **Per-child guardian view** and **per-course teacher
 * view** are post-v1 and marked *owner to decide* (§23.6).
 *
 * **Why this file is separate, and why it is pure.** The rule has to be consumed
 * by three places that cannot share a module: the four API read handlers (server),
 * the transcript PRINT page (server component) and the results SCREEN (a client
 * component). A `NextResponse`-shaped helper would pull `next/server` — and any
 * prisma import would pull the database — into the client bundle, so the RULE
 * lives here with **no imports at all**, and each caller applies it:
 *
 *   - the routes call `requireCollegeResultsRead(session)`
 *     (`src/lib/college-results-server.ts`), which is this rule wrapped as a 403;
 *   - the print page and the results screen call `canReadCollegeResults(role)`
 *     directly and render their refusal instead of any data.
 *
 * One rule, three callers, no copies — `scripts/verify-college-results-page.mjs`
 * fails if a page re-implements it, and `scripts/verify-college-results-api.mjs`
 * pins the HTTP behaviour for every role.
 *
 * Writes are NOT governed here: `POST`/`PATCH`/`DELETE` keep today's rule
 * (`attendanceMarks` full), so this change only ever narrows reads.
 */

/** The roles that may READ college results and transcripts in v1 (owner ruling). */
export const COLLEGE_RESULTS_READ_ROLES = ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR"] as const;

export type CollegeResultsReadRole = (typeof COLLEGE_RESULTS_READ_ROLES)[number];

/** Set form, so an unknown/absent role is rejected safely. */
const READ_ROLE_SET: ReadonlySet<string> = new Set(COLLEGE_RESULTS_READ_ROLES);

/**
 * May this role read a college result or a transcript?
 *
 * A strict allow-list: only the four roles above. Everything else — including a
 * role that holds `attendanceMarks` view but is not administration (TEACHER,
 * GUARDIAN) — is refused, and an absent/unknown role is refused too.
 */
export function canReadCollegeResults(role: unknown): boolean {
  return typeof role === "string" && READ_ROLE_SET.has(role);
}

/** The refusal a denied reader receives — the 403 body and the page's own message. */
export const COLLEGE_RESULTS_READ_REFUSAL =
  "College results are available to the school administration and the registrar.";
