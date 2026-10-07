/**
 * College term model — the ONE definition of how a program's years become terms.
 *
 * A program carries two fields that together decide how many terms it has:
 *
 *   - `termSystem`  YEARLY (one term per year) or SEMESTER (two per year).
 *                   Optional on the wire and in storage; a missing value is
 *                   read as YEARLY (`normalizeTermSystem` never returns null),
 *                   so a program row written before Phase 3c behaves exactly
 *                   like a YEARLY one without a migration.
 *   - `durationYears` already existed (a whole number of years in [1, 6]).
 *
 * Derived: `termCount(durationYears, termSystem)`. A 3-year SEMESTER program has
 * 6 terms; the same program YEARLY has 3. A `programCourse` row points at one of
 * those terms with its `termNumber` (1-based), so the count is the upper bound
 * every mapping is validated against.
 *
 * Two callers depend on this being the ONE source of truth: the API routes
 * (`programs`, `programs/[id]`, `programs/[id]/courses`) that validate and guard,
 * and, later, the catalogue page that renders "Year 1 / Year 2 …" labels. If the
 * arithmetic lived in both, a page could offer a term the API rejects.
 *
 * This module is deliberately dependency-free — no prisma, no `node:` imports,
 * no React — the same design as `college-routes.ts`, `institution.ts` and
 * `sectors.ts`, so a verifier running under plain `node`, a client component and
 * Edge code can all import it. `scripts/verify-college-terms.mjs` pins that
 * property (it fails if an `import` appears here).
 */

/** The supported term systems, most general first. */
export const TERM_SYSTEMS = ["YEARLY", "SEMESTER"] as const;

export type TermSystem = (typeof TERM_SYSTEMS)[number];

/** The system a program gets when none is given, on create and on read. */
export const DEFAULT_TERM_SYSTEM: TermSystem = "YEARLY";

/** Is this exactly one of the stored values? (Strict — storage is always canonical.) */
export function isTermSystem(value: unknown): value is TermSystem {
  return typeof value === "string" && (TERM_SYSTEMS as readonly string[]).includes(value);
}

/**
 * Read a stored/optional value as a term system. `undefined`, `null`, `""` and
 * anything unrecognised are YEARLY — a missing field is not an error, it is the
 * default. The routes reject an *explicitly supplied* bad value with 400 before
 * this ever runs; this is the forgiving read side.
 */
export function normalizeTermSystem(value: unknown): TermSystem {
  return isTermSystem(value) ? value : DEFAULT_TERM_SYSTEM;
}

/** Terms per academic year: a YEARLY program has one, a SEMESTER program two. */
export function termsPerYear(system: unknown): number {
  return normalizeTermSystem(system) === "SEMESTER" ? 2 : 1;
}

/**
 * The number of terms a program has: `durationYears × termsPerYear(system)`.
 *
 * A non-positive or non-integer `durationYears` yields 0 rather than throwing —
 * every caller validates the duration separately (the routes keep the [1, 6]
 * rule), so this stays a total function.
 */
export function termCount(durationYears: number, system: unknown): number {
  const years = Number.isInteger(durationYears) && durationYears > 0 ? durationYears : 0;
  return years * termsPerYear(system);
}

/** The human label of one term — "Year 3" or "Semester 5". */
export function termLabel(termNumber: number, system: unknown): string {
  const unit = normalizeTermSystem(system) === "SEMESTER" ? "Semester" : "Year";
  return `${unit} ${termNumber}`;
}

/** Every term label of a program, 1-based: `["Year 1", "Year 2", …]`. */
export function termLabels(durationYears: number, system: unknown): string[] {
  const total = termCount(durationYears, system);
  const labels: string[] = [];
  for (let termNumber = 1; termNumber <= total; termNumber++) {
    labels.push(termLabel(termNumber, system));
  }
  return labels;
}

/**
 * Is this a term number the program actually has? A `programCourse.termNumber`
 * must be a whole number in [1, termCount]. Anything else — 0, a negative, a
 * fraction, a string, a term past the end — is rejected.
 */
export function isValidTermNumber(termNumber: unknown, durationYears: number, system: unknown): boolean {
  if (!Number.isInteger(termNumber)) return false;
  const n = termNumber as number;
  return n >= 1 && n <= termCount(durationYears, system);
}
