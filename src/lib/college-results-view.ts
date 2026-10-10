/**
 * College results — the page and print layer's DECISIONS, pure (Phase 6d,
 * docs/COLLEGE-DECISIONS.md §23, D-6-6/D-6-12/D-6-14/D-6-16).
 *
 * `src/app/dashboard/college-results/page.tsx` (a client component) and
 * `src/app/print/college-transcript/[studentId]/page.tsx` (a server component)
 * are mostly JSX. What is NOT JSX — and what a reviewer must not have to read
 * hundreds of lines of markup to check — is a small set of load-bearing rules:
 *
 *   - **D-6-6** the active scheme's NAME and its SCALE must be visible on the
 *     college results screen, and on every printed transcript, at all times. The
 *     scale line is derived here (`scaleLine`) so the screen and the page cannot
 *     describe the same scheme differently.
 *   - **D-6-16** a no-GPA scheme prints NO GPA/CGPA figure — never `0.00`, which
 *     would read as a real zero. `formatGpa` returns `null` for "nothing to show"
 *     (absent scheme GPA, null value), and the page renders nothing for a null.
 *   - **Q3/D-6-8** every retake attempt is listed, with the EFFECTIVE one marked
 *     and the rest visibly superseded — `attemptStatus`/`attemptSummary`.
 *
 * This module is **dependency-free** in the same sense as `college-results.ts`,
 * `college-promotion-view.ts`, `college-terms.ts` and `institution.ts`: no
 * `import`, no `require(`, no prisma, no `node:`, no React — so a plain-`node`
 * offline verifier (`scripts/verify-college-results-page.mjs`) can import it
 * directly. That verifier fails if an `import` appears here, and it fails if the
 * pages stop using this module or re-inline a literal it owns.
 *
 * **Nothing here proves a page RENDERS.** There is no DOM, no React, no browser
 * and no server in this file: a real browser pass is a separate step.
 */

/* --------------------------------------------------------------- copy & errors */

/** The human fallback for every load on the results screen, in one place. */
export const PAGE_ERRORS = {
  scheme: "Could not load the grading scheme",
  students: "Could not load the students",
  courses: "Could not load the courses",
  results: "Could not load the results",
  record: "Could not record the result",
} as const;

/** The fallback message for a failed call whose error carries no usable text. */
export function messageOf(e: unknown, fallback: string): string {
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/* ------------------------------------------------------- the scale (D-6-6) */

/** Does this scheme show a GPA figure at all? Absent means yes (D-6-2). */
export function showsGpaFigure(scheme: { showGpa?: unknown } | null | undefined): boolean {
  return scheme?.showGpa !== false;
}

/**
 * The scheme's SCALE, in one line, for the results screen and every print
 * (D-6-6/D-6-14): `"GPA out of 5.00"` when a GPA is shown, else a description of
 * the GPA-free scale.
 *
 * The no-GPA wording is decided by the BANDS, not guessed: a no-GPA scheme with
 * only two bands is a pass/fail percentage scale (the shipped `percent-only`
 * preset, `P`/`F`), and anything richer is a letters ladder (`A*`, `A`, `B`…).
 * That is the whole discriminator — documented so it cannot drift silently, and
 * pinned by the offline verifier.
 */
export function scaleLine(scheme: { showGpa?: unknown; gpaScale?: unknown; bands?: unknown } | null | undefined): string {
  if (!scheme) return "";
  if (showsGpaFigure(scheme)) {
    const scale = Number((scheme as { gpaScale?: unknown }).gpaScale);
    return `GPA out of ${Number.isFinite(scale) ? scale.toFixed(2) : "—"}`;
  }
  const bands = Array.isArray((scheme as { bands?: unknown }).bands) ? (scheme as { bands: unknown[] }).bands : [];
  return bands.length <= 2 ? "percent only" : "letters only";
}

/**
 * A GPA/point figure, or `null` for "nothing to show" (D-6-16).
 *
 * Returns `null` when the scheme shows no GPA at all (so a no-GPA transcript
 * prints NO figure — never `0.00`) and when the value itself is absent/not a
 * finite number (a missing point is not a zero either). A caller renders a null
 * as a dash, never as a number.
 */
export function formatGpa(value: unknown, showGpa: boolean): string | null {
  if (!showGpa) return null;
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return n.toFixed(2);
}

/** A percentage, two decimals, or an em-dash when there is nothing to show. */
export function percentText(percent: unknown): string {
  const n = typeof percent === "string" && percent.trim() !== "" ? Number(percent) : percent;
  return typeof n === "number" && Number.isFinite(n) ? `${n.toFixed(2)}%` : "—";
}

/** A band letter, or an em-dash (a course with no gradable attempt). */
export function gradeText(grade: unknown): string {
  return typeof grade === "string" && grade.trim() ? grade : "—";
}

/** The note under the results table when the tenant shows no GPA (D-6-16). */
export function noGpaNote(): string {
  return "This scale shows no GPA — the point and CGPA columns are omitted, never printed as 0.00.";
}

/* ---------------------------------------------------- retakes & attempts (Q3) */

/** The four stored policies, in their own words for the screen. */
export function policyWords(policy: unknown): string {
  switch (policy) {
    case "REPLACE":
      return "latest attempt counts";
    case "BEST":
      return "best attempt counts";
    case "BOTH":
      return "every attempt kept";
    case "AVERAGE":
      return "attempts averaged";
    default:
      return "latest attempt counts";
  }
}

/**
 * The one-line statement of the tenant's retake rule (D-6-7/D-6-9), e.g.
 * `Retakes: best attempt counts, up to 2 retakes` — or `no retakes recorded`
 * when the limit is 0, and `unlimited` when it is null.
 */
export function policyLine(retake: { policy?: unknown; maxRetakes?: unknown } | null | undefined): string {
  const policy = retake?.policy;
  const words = policyWords(policy);
  const raw = retake?.maxRetakes;
  if (raw === null) return `Retakes: ${words}, unlimited`;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    // An absent/odd limit is read as "no retakes", exactly like the API's own
    // `normalizeCollegeRetake` fallback — the two must not disagree.
    return "Retakes: no retakes recorded";
  }
  if (raw === 0) return "Retakes: no retakes recorded";
  return `Retakes: ${words}, up to ${raw} retake${raw === 1 ? "" : "s"}`;
}

/** One resolved attempt, as the transcript read serves it (`ResolvedCollegeAttempt`). */
export interface AttemptView {
  attempt?: unknown;
  percent?: unknown;
  effective?: unknown;
  superseded?: unknown;
}

/** The status word for one attempt: the effective one, or the superseded rest (Q3). */
export function attemptStatus(attempt: AttemptView | null | undefined): string {
  if (attempt?.effective) return "Effective";
  return "Superseded";
}

/** One attempt, one line: `Attempt 2 — 64.00% — Effective`. */
export function attemptSummary(attempt: AttemptView | null | undefined): string {
  const n = attempt?.attempt;
  const label = typeof n === "number" && Number.isInteger(n) && n >= 1 ? `Attempt ${n}` : "Attempt";
  return `${label} — ${percentText(attempt?.percent)} — ${attemptStatus(attempt)}`;
}

/** True when a course holds more than one attempt (so the transcript shows the set). */
export function hasRetakes(attempts: readonly unknown[] | null | undefined): boolean {
  return Array.isArray(attempts) && attempts.length > 1;
}

/* ------------------------------------------------------- weighting (Q2/D-6-11) */

/** How the CGPA was weighted, in words, so a reader can tell (D-6-11). */
export function weightingBasisText(basis: unknown): string {
  if (basis === "credits") return "Weighted by credit hours";
  if (basis === "courses") return "One per course (no credit hours recorded)";
  return "";
}

/* --------------------------------------------------------------- page wiring */

/** The transcript PRINT page for a student — the one place the path is spelled. */
export function transcriptHref(studentId: unknown): string {
  const id = typeof studentId === "string" ? studentId.trim() : "";
  return `/print/college-transcript/${encodeURIComponent(id)}`;
}

/** The grading editor, where the presets and the bands live (D-6-3/D-6-6). */
export const GRADING_EDITOR_HREF = "/dashboard/grades";

/** The results-list heading count: `3 results` / `1 result`. */
export function resultsCountText(n: unknown): string {
  const count = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `${count} result${count === 1 ? "" : "s"}`;
}

/** A form field is usable only when both marks are finite and non-negative. */
function usableMarks(obtained: unknown, fullMarks: unknown): boolean {
  const o = typeof obtained === "string" && obtained.trim() !== "" ? Number(obtained) : obtained;
  const f = typeof fullMarks === "string" && fullMarks.trim() !== "" ? Number(fullMarks) : fullMarks;
  if (typeof o !== "number" || !Number.isFinite(o) || o < 0) return false;
  if (typeof f !== "number" || !Number.isFinite(f) || f <= 0) return false;
  return o <= f;
}

/** The record form's inputs, as the page holds them (all strings until submit). */
export interface RecordInput {
  studentId: unknown;
  courseId: unknown;
  obtained: unknown;
  fullMarks: unknown;
  busy?: unknown;
}

/** Is the Record button disabled? (A student, a course, valid marks, not busy.) */
export function recordDisabled(input: RecordInput): boolean {
  return (
    !!input?.busy ||
    !input?.studentId ||
    !input?.courseId ||
    !usableMarks(input?.obtained, input?.fullMarks)
  );
}

/** May a handler proceed? The same rule as the button, so the form cannot be bypassed. */
export function recordBlocked(input: RecordInput): boolean {
  return recordDisabled(input);
}

/** The record button's label, so `busy` reads consistently with the rest of the app. */
export function recordButtonLabel(busy: unknown): string {
  return busy ? "Recording…" : "Record result";
}
