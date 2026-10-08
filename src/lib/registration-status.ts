/**
 * Course-registration status — the ONE definition of the request/approval state machine.
 *
 * A `courseRegistration` row is a student's request to take one course in one term
 * of their programme. It moves through exactly three states:
 *
 *   PENDING   — requested, not yet decided. The only state that can be decided or
 *               withdrawn.
 *   APPROVED  — accepted. Terminal.
 *   REJECTED  — refused. Terminal.
 *
 * Two orthogonal questions are answered here, and keeping them in one module is
 * what stops the API routes and the (later) registration page from disagreeing:
 *
 *   - `isBlockingRegistration(status)` — does this row still HOLD the student's
 *     place? PENDING and APPROVED do; REJECTED does not. This is the single rule
 *     used by every guard: the duplicate check, the un-enrol / programme-change
 *     block, the mapping-delete guard and the course-delete guard all call THIS
 *     function, so "a rejected row never blocks anything" is stated once.
 *   - `canDecideRegistration` / `canWithdrawRegistration` — only a PENDING row may
 *     be decided (→ APPROVED/REJECTED) or withdrawn (deleted); APPROVED and
 *     REJECTED are terminal (no re-open in this phase).
 *
 * This module is deliberately dependency-free — no prisma, no `node:` imports, no
 * React — the same design as `college-terms.ts`, `college-routes.ts`,
 * `institution.ts` and `sectors.ts`, so a verifier running under plain `node`, a
 * client component and Edge code can all import it. `scripts/verify-registration-status.mjs`
 * pins that property (it fails if an `import` appears here).
 */

/** The supported statuses, most general first. */
export const REGISTRATION_STATUSES = ["PENDING", "APPROVED", "REJECTED"] as const;

export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** The status a new request gets. */
export const DEFAULT_REGISTRATION_STATUS: RegistrationStatus = "PENDING";

/** The two statuses a PENDING row may be decided INTO. */
export const DECISION_STATUSES = ["APPROVED", "REJECTED"] as const;

export type DecisionStatus = (typeof DECISION_STATUSES)[number];

/** Is this exactly one of the stored statuses? (Strict — storage is always canonical.) */
export function isRegistrationStatus(value: unknown): value is RegistrationStatus {
  return typeof value === "string" && (REGISTRATION_STATUSES as readonly string[]).includes(value);
}

/** Is this exactly APPROVED or REJECTED — the two answers a decision may give? */
export function isDecisionStatus(value: unknown): value is DecisionStatus {
  return typeof value === "string" && (DECISION_STATUSES as readonly string[]).includes(value);
}

/**
 * Read a stored/optional value as a status. A missing or unrecognised value is
 * PENDING — a row written before the field existed is treated as un-decided, the
 * conservative reading that keeps a guard from silently passing.
 */
export function normalizeRegistrationStatus(value: unknown): RegistrationStatus {
  return isRegistrationStatus(value) ? value : DEFAULT_REGISTRATION_STATUS;
}

/**
 * Does this row still hold the student's place?
 *
 * PENDING and APPROVED do; REJECTED does not. This is the ONE rule behind every
 * guard — the duplicate `(studentId, courseId, termNumber)` check, the un-enrol /
 * programme-change block (4b), the mapping-delete guard and the course-delete
 * guard. A REJECTED row never blocks a new registration for the same triple, never
 * blocks an un-enrol, and never blocks deleting a mapping or a course.
 */
export function isBlockingRegistration(status: unknown): boolean {
  return status === "PENDING" || status === "APPROVED";
}

/** APPROVED and REJECTED are terminal — no re-open, no re-decide, no withdraw. */
export function isTerminalRegistration(status: unknown): boolean {
  return status === "APPROVED" || status === "REJECTED";
}

/** Only a PENDING row may be decided (→ APPROVED / REJECTED). */
export function canDecideRegistration(status: unknown): boolean {
  return status === "PENDING";
}

/** Only a PENDING row may be withdrawn (deleted). */
export function canWithdrawRegistration(status: unknown): boolean {
  return status === "PENDING";
}
