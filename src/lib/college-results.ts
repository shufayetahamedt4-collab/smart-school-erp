/**
 * College results logic — the ONE definition of how a college student's attempts
 * per course become a grade, and how those grades become a term GPA and a CGPA
 * (Phase 6a, docs/COLLEGE-DECISIONS.md §23.3–§23.4).
 *
 * This is the pure half of Phase 6: given a student's attempts for a course and
 * the tenant's own settings, it decides which attempt is the effective grade and
 * what the credit-weighted GPA/CGPA is. It writes nothing, reads nothing, and
 * knows nothing about HTTP, prisma, sessions, React or Firestore — the same
 * design as `college-promotion.ts`, `college-terms.ts` and `college-routes.ts`,
 * so the offline verifier (`scripts/verify-college-grading-logic.mjs`), a client
 * component and Edge code can all import it. That verifier pins the property by
 * failing if an `import` appears in this file.
 *
 * Why it does NOT import `grading.ts` for its types: the no-import property is
 * what makes the module trivially portable, and `grading.ts` stays the single
 * source of truth for the scheme. The caller passes the few fields this module
 * needs (a `passPercent`, a structural scheme view, the retake block), so the
 * shapes here are deliberately structural — a `GradingScheme` is assignable to
 * `CollegeGpaScheme` without a cast.
 *
 * The decided rules (docs/COLLEGE-DECISIONS.md §23):
 *
 *   - **D-6-8** — `policy` is one of `REPLACE | BEST | BOTH | AVERAGE`, and the
 *     resolution is a pure function of the attempts. The policy never changes the
 *     stored attempts — only which value the CGPA uses and what a transcript
 *     prints (D-6-12).
 *   - **D-6-9** — `maxRetakes` is an integer or `null` (unlimited). It is enforced
 *     when a retake is RECORDED (the API); `retakeLimitReached` is the predicate
 *     that API calls, and no attempt is ever deleted.
 *   - **D-6-10** — there is ONE pass mark, the scheme's `passPercent`; a course is
 *     failed when its percentage is below it.
 *   - **D-6-11** — a course with no `creditHours` is never silently zero-weighted:
 *     it weighs 1, and when NO course in the set carries credits the arithmetic
 *     falls back to the plain mean.
 *   - **D-6-16** — a scheme with `showGpa: false` returns NO GPA at all (`null`),
 *     never a printed `0.00`.
 *   - **D-6-13** — the computation reads only the scheme and rows it is given, so
 *     a foreign row can only narrow the result to zero and a foreign scheme is
 *     simply not passed in.
 */

/** Keep the top two decimals — the same rounding the report card prints. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** A finite number, or null when the input is unusable. */
function finite(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/* --------------------------------------------------- retake policy (D-6-7…D-6-10) */

/**
 * The four ways a tenant may treat a retaken course (D-6-8) — the same list
 * `grading.ts` exports as `RETAKE_POLICIES`. It is re-declared here (not imported)
 * to keep this module dependency-free; the offline verifier asserts the two lists
 * are identical, so they are **pinned**, not assumed to agree.
 */
export const COLLEGE_RETAKE_POLICIES = ["REPLACE", "BEST", "BOTH", "AVERAGE"] as const;

export type CollegeRetakePolicy = (typeof COLLEGE_RETAKE_POLICIES)[number];

/** A tenant's retake rule, stored beside the scheme (D-6-7). */
export interface CollegeRetakeConfig {
  policy: CollegeRetakePolicy;
  /** Attempts allowed BEYOND the first, or `null` for unlimited (D-6-9). */
  maxRetakes: number | null;
}

/** What an absent `retake` block means: no retakes recorded, single attempt. */
export const DEFAULT_COLLEGE_RETAKE: CollegeRetakeConfig = { policy: "REPLACE", maxRetakes: 0 };

/** Is this exactly one of the four stored policies? */
export function isCollegeRetakePolicy(value: unknown): value is CollegeRetakePolicy {
  return typeof value === "string" && (COLLEGE_RETAKE_POLICIES as readonly string[]).includes(value);
}

/**
 * Read a stored/optional retake block leniently. A missing block, a bad policy,
 * or a non-integer limit all fall back to `DEFAULT_COLLEGE_RETAKE` (no retakes) —
 * the same fail-safe convention `grading.ts`'s `normalizeRetakeConfig` uses, so
 * the two readers agree. `undefined`, `""` and `null` for the limit mean
 * unlimited (D-6-9). Never throws.
 */
export function normalizeCollegeRetake(value: unknown): CollegeRetakeConfig {
  const block = value as any;
  if (!block || typeof block !== "object" || !isCollegeRetakePolicy(block.policy)) return DEFAULT_COLLEGE_RETAKE;
  const raw = block.maxRetakes;
  if (raw === undefined || raw === null || raw === "") return { policy: block.policy, maxRetakes: null };
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return { policy: block.policy, maxRetakes: raw };
  return DEFAULT_COLLEGE_RETAKE;
}

/** Retakes a student has already used: attempts beyond the first (never negative). */
export function retakesUsed(attemptCount: unknown): number {
  const n = finite(attemptCount);
  return n !== null && Number.isInteger(n) && n > 1 ? n - 1 : 0;
}

/**
 * Would recording ONE MORE attempt exceed the limit? `attemptCount` is the number
 * of attempts already on file. With no limit (`null`) it is never true.
 */
export function retakeLimitReached(attemptCount: unknown, retake: unknown): boolean {
  // The limit is independent of the policy, so it is read here directly: a bare
  // `{ maxRetakes }` and a full block both work, and an absent block reads as 0.
  const raw = (retake as any)?.maxRetakes;
  const limit =
    raw === null || raw === ""
      ? null
      : typeof raw === "number" && Number.isInteger(raw) && raw >= 0
        ? raw
        : DEFAULT_COLLEGE_RETAKE.maxRetakes;
  if (limit === null) return false;
  const already = finite(attemptCount);
  return already !== null && already > limit;
}

/* ------------------------------------------------- attempt resolution (D-6-8) */

/** One stored attempt, as the caller passes it (unknown shapes are dropped). */
export interface CollegeAttemptInput {
  /** 1-based attempt number. */
  attempt?: unknown;
  obtained?: unknown;
  fullMarks?: unknown;
}

/** One attempt after resolution — its own percentage and its pass/fail verdict. */
export interface ResolvedCollegeAttempt {
  attempt: number;
  obtained: number;
  fullMarks: number;
  /** The percentage, kept to two decimals. */
  percent: number;
  passed: boolean;
  /** Is this the attempt the CGPA and transcript use? */
  effective: boolean;
  /** Reported but not effective (the rest of a `REPLACE`/`BEST`/`BOTH` set). */
  superseded: boolean;
}

/** The whole resolution for one course. */
export interface CollegeCourseResolution {
  policy: CollegeRetakePolicy;
  /** The valid attempts, in attempt order. */
  attempts: ResolvedCollegeAttempt[];
  count: number;
  /** The effective attempt's number, or `null` (an `AVERAGE`, or no attempts). */
  effectiveAttempt: number | null;
  /** The grade the CGPA/transcript uses, or `null` when there is nothing to grade. */
  effectivePercent: number | null;
  effectivePassed: boolean | null;
  retakesUsed: number;
  maxRetakes: number | null;
  /** Do the stored attempts exceed what the policy allows (D-6-9)? */
  overLimit: boolean;
}

/** A 1-based whole attempt number, or null. */
function normalizeAttemptNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** The pass mark, read defensively: a percentage in [0, 100], else 0. */
function normalizePassPercent(value: unknown): number {
  const n = finite(value);
  return n !== null && n >= 0 && n <= 100 ? n : 0;
}

/**
 * Resolve a student's attempts for ONE course under the tenant's policy.
 *
 * Junk is dropped, not guessed: an attempt without a 1-based integer number, a
 * non-finite obtained/full, a `full marks` of 0, or a duplicate attempt number is
 * ignored, and the rest are sorted by attempt. An empty (or all-junk) set yields
 * a resolution with `effectivePercent: null` — never a fabricated grade.
 *
 * The four policies (D-6-8):
 *   - `REPLACE` — the latest attempt is effective; the rest are superseded;
 *   - `BEST`    — the highest percentage is effective (a tie takes the later
 *                 attempt); the rest are superseded;
 *   - `BOTH`    — every attempt is reported, the LATEST is effective;
 *   - `AVERAGE` — no single attempt is effective; `effectivePercent` is the mean.
 */
export function resolveCollegeAttempts(input: {
  attempts?: readonly CollegeAttemptInput[] | null;
  passPercent?: unknown;
  /** The scheme's retake block (D-6-7). */
  retake?: unknown;
  /** Shorthand for the block's two fields — either form is accepted. */
  policy?: unknown;
  maxRetakes?: unknown;
}): CollegeCourseResolution {
  const passPercent = normalizePassPercent(input?.passPercent);
  const config = normalizeCollegeRetake(
    input?.retake !== undefined && input?.retake !== null
      ? input.retake
      : { policy: input?.policy, maxRetakes: input?.maxRetakes }
  );
  const raw = Array.isArray(input?.attempts) ? input.attempts : [];

  const seen = new Set<number>();
  const attempts: ResolvedCollegeAttempt[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const attempt = normalizeAttemptNumber((row as any).attempt);
    if (attempt === null || seen.has(attempt)) continue;
    const obtained = finite((row as any).obtained);
    const fullMarks = finite((row as any).fullMarks);
    if (obtained === null || fullMarks === null || fullMarks <= 0) continue;
    seen.add(attempt);
    const percent = round2((obtained / fullMarks) * 100);
    attempts.push({ attempt, obtained, fullMarks, percent, passed: percent >= passPercent, effective: false, superseded: false });
  }
  attempts.sort((a, b) => a.attempt - b.attempt);

  let effectiveAttempt: number | null = null;
  let effectivePercent: number | null = null;
  let effectivePassed: boolean | null = null;

  if (attempts.length) {
    if (config.policy === "AVERAGE") {
      const mean = round2(attempts.reduce((sum, r) => sum + r.percent, 0) / attempts.length);
      effectivePercent = mean;
      effectivePassed = mean >= passPercent;
    } else {
      let chosen = attempts[attempts.length - 1];
      if (config.policy === "BEST") {
        // `>=` keeps a tie breaker on the LATER attempt (a left-to-right reduce).
        chosen = attempts.reduce((best, r) => (r.percent >= best.percent ? r : best), attempts[0]);
      }
      chosen.effective = true;
      for (const r of attempts) r.superseded = !r.effective;
      effectiveAttempt = chosen.attempt;
      effectivePercent = chosen.percent;
      effectivePassed = chosen.passed;
    }
  }

  return {
    policy: config.policy,
    attempts,
    count: attempts.length,
    effectiveAttempt,
    effectivePercent,
    effectivePassed,
    retakesUsed: retakesUsed(attempts.length),
    maxRetakes: config.maxRetakes,
    overLimit: config.maxRetakes !== null && retakesUsed(attempts.length) > config.maxRetakes,
  };
}

/* --------------------------------------- credit-weighted GPA/CGPA (D-6-11) */

/** The scheme fields this module needs — a `GradingScheme` satisfies this. */
export interface CollegeGpaScheme {
  /** Absent/true shows a GPA; only an explicit `false` suppresses it (D-6-2). */
  showGpa?: unknown;
  gpaScale?: unknown;
}

/** One gradable course row. `credits` is `course.creditHours` (nullable). */
export interface CollegeGpaRow {
  termNumber?: unknown;
  /** The course's credit hours, when the catalogue carries them. */
  credits?: unknown;
  /** The band point for this course, absent/null under a no-GPA scheme. */
  points?: unknown;
}

/** How the set was weighted — printed so a reader can tell (Q2/D-6-11). */
export type GpaWeightingBasis = "credits" | "courses" | "none";

/** Does this scheme show a GPA at all? Absent means yes (D-6-2). */
export function showsGpaIn(scheme: CollegeGpaScheme | null | undefined): boolean {
  return (scheme as any)?.showGpa !== false;
}

/** A credit weight: a positive finite number, else null (must not zero-weight). */
function creditWeight(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
}

/** A band point: any finite number, else null (a missing point is not a 0.00). */
function bandPoint(value: unknown): number | null {
  return finite(value);
}

/** A term number: a 1-based whole number, else null. */
function termNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/** The gradable rows: those that actually carry a point. */
function gradableRows(rows: readonly CollegeGpaRow[] | null | undefined): CollegeGpaRow[] {
  const list = Array.isArray(rows) ? rows : [];
  return list.filter((r) => r !== null && typeof r === "object" && bandPoint((r as any).points) !== null);
}

/**
 * How a set of rows would be weighted: `credits` when at least one carries
 * credits, `courses` when none does (a plain mean), `none` when there is nothing
 * to grade or the scheme shows no GPA.
 */
export function gpaWeightingBasis(
  scheme: CollegeGpaScheme | null | undefined,
  rows: readonly CollegeGpaRow[] | null | undefined
): GpaWeightingBasis {
  if (!showsGpaIn(scheme)) return "none";
  const usable = gradableRows(rows);
  if (!usable.length) return "none";
  return usable.some((r) => creditWeight((r as any).credits) !== null) ? "credits" : "courses";
}

/**
 * The credit-weighted mean of a set of course points (D-6-11).
 *
 *   - a course's weight is its `credits`; a course with no credits weighs **1**
 *     (never zero-weighted), so a set that mixes them is still meaningful;
 *   - when NO course in the set carries credits, the arithmetic is the plain mean
 *     (which the per-row weight of 1 produces naturally);
 *   - the result is capped at the scheme's `gpaScale` and kept to two decimals;
 *   - a no-GPA scheme returns `null` — never `0.00` (D-6-16) — and an empty set
 *     returns `null` too, so a caller can tell "no GPA" from "zero GPA".
 */
export function creditWeightedGpa(
  scheme: CollegeGpaScheme | null | undefined,
  rows: readonly CollegeGpaRow[] | null | undefined
): number | null {
  if (!showsGpaIn(scheme)) return null;
  const usable = gradableRows(rows);
  if (!usable.length) return null;

  const creditsPresent = usable.some((r) => creditWeight((r as any).credits) !== null);
  let total = 0;
  let totalWeight = 0;
  for (const row of usable) {
    const point = bandPoint((row as any).points) as number;
    const weight = creditsPresent ? creditWeight((row as any).credits) ?? 1 : 1;
    total += point * weight;
    totalWeight += weight;
  }
  if (totalWeight <= 0) return null;

  const mean = round2(total / totalWeight);
  const scale = finite((scheme as any)?.gpaScale);
  return scale !== null && scale > 0 ? Math.min(scale, mean) : mean;
}

/** The credit-weighted GPA of ONE term's rows (D-6-11), or `null` when none. */
export function termGpa(
  scheme: CollegeGpaScheme | null | undefined,
  rows: readonly CollegeGpaRow[] | null | undefined,
  termNumberValue: unknown
): number | null {
  const term = termNumber(termNumberValue);
  if (term === null) return null;
  const list = Array.isArray(rows) ? rows : [];
  return creditWeightedGpa(
    scheme,
    list.filter((r) => r !== null && typeof r === "object" && termNumber((r as any).termNumber) === term)
  );
}

/**
 * The cumulative GPA over every row given (D-6-11) — the same credit-weighted
 * arithmetic, so a CGPA and a term GPA can never disagree about how to weight.
 */
export function cumulativeGpa(
  scheme: CollegeGpaScheme | null | undefined,
  rows: readonly CollegeGpaRow[] | null | undefined
): number | null {
  return creditWeightedGpa(scheme, rows);
}
