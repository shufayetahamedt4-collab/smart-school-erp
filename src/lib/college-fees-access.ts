/**
 * College fees — WHO may READ and WRITE them, in the ONE place that decides it
 * (Phase 7c, docs/COLLEGE-DECISIONS.md §24.5, D-7-18; owner ruling 2026-10-11, Q4).
 *
 * **Why the school's `feePayment` module is not the gate.** §24.1's finding, read
 * from `src/lib/permissions.ts`: `feePayment` is granted to **GUARDIAN**
 * (`view` + `pay`) and **STUDENT** (`view`) alongside SCHOOL_ADMIN / BRANCH_ADMIN /
 * ACCOUNTANT (`full`), REGISTRAR (`view`) and SUPER_ADMIN (`billing`). Reusing it
 * would hand every parent and every student the college's whole billing surface —
 * the hole `college-results-access.ts` was created to close for results. So college
 * fees get their own explicit allow-list, exactly as D-7-18 requires, and it is the
 * FIRST thing every `/api/college-fees` handler consults after `requireCollege`.
 *
 * v1 (the owner's answer, Q4 — "staff-only in v1"):
 *
 *   - **WRITE** — the admin-level roles (`SUPER_ADMIN`, `SCHOOL_ADMIN`,
 *     `BRANCH_ADMIN`) and the `ACCOUNTANT`.
 *   - **READ** — the same set, with the `REGISTRAR` added **read-only** (today's
 *     `feePayment: view` for a registrar, and the results precedent's read rule).
 *   - **REFUSED** — `TEACHER`, `GUARDIAN` and `STUDENT`, in both directions, even
 *     though the school's own module would admit a guardian and a student. A
 *     teacher/student/guardian write to college money is a stop-and-report, and
 *     `scripts/verify-college-fees-api.mjs` fails if one is ever admitted.
 *
 * **Why this file is separate, and why it is pure.** The rule has to be consumed by
 * the API handlers (server) and, in 7d, by the college fee pages (client). A
 * `NextResponse`-shaped helper would pull `next/server` into a client bundle, so the
 * RULE lives here with **no imports at all** and each caller applies it:
 *
 *   - the routes call `requireCollegeFeesWrite(session)` / `requireCollegeFeesRead(session)`
 *     (`src/lib/college-fees-server.ts`), which are this rule wrapped as a 403;
 *   - 7d's pages call `canReadCollegeFees(role)` / `canWriteCollegeFees(role)`
 *     directly and render their refusal instead of any data.
 *
 * One rule, every caller, no copies.
 */

/** The roles that may WRITE college fees in v1 — admin-level + ACCOUNTANT (D-7-18). */
export const COLLEGE_FEES_WRITE_ROLES = ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN", "ACCOUNTANT"] as const;

/** The roles that may READ college fees in v1 — the writers, plus a read-only REGISTRAR. */
export const COLLEGE_FEES_READ_ROLES = [...COLLEGE_FEES_WRITE_ROLES, "REGISTRAR"] as const;

export type CollegeFeesWriteRole = (typeof COLLEGE_FEES_WRITE_ROLES)[number];
export type CollegeFeesReadRole = (typeof COLLEGE_FEES_READ_ROLES)[number];

/** Set forms, so an unknown/absent role is rejected safely. */
const WRITE_ROLE_SET: ReadonlySet<string> = new Set(COLLEGE_FEES_WRITE_ROLES);
const READ_ROLE_SET: ReadonlySet<string> = new Set(COLLEGE_FEES_READ_ROLES);

/**
 * May this role WRITE college fees (heads, structure, generation, payments,
 * awards, config)?
 *
 * A strict allow-list: the four roles above. Everything else — including
 * `REGISTRAR`, whose v1 access is read-only — is refused, and an absent/unknown
 * role is refused too.
 */
export function canWriteCollegeFees(role: unknown): boolean {
  return typeof role === "string" && WRITE_ROLE_SET.has(role);
}

/**
 * May this role READ college fees (heads, structure, charges, dues, awards,
 * config)? The writers plus the REGISTRAR.
 */
export function canReadCollegeFees(role: unknown): boolean {
  return typeof role === "string" && READ_ROLE_SET.has(role);
}

/**
 * The roles that may APPROVE or REJECT an award, against the roles that may
 * PROPOSE one (D-7-13 reuses the school's propose/approve flow, whose §24.1 entry
 * reads "accountant proposes, admin approves").
 *
 * So: any writer may propose, only an ADMIN-LEVEL role may decide, and an award
 * may never be approved by the person who proposed it — the same
 * four-eyes rule the school's own discount flow carries.
 */
export const COLLEGE_FEES_AWARD_APPROVER_ROLES = ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN"] as const;

const APPROVER_ROLE_SET: ReadonlySet<string> = new Set(COLLEGE_FEES_AWARD_APPROVER_ROLES);

/** May this role approve or reject an award? (admin-level only — never the ACCOUNTANT) */
export function canDecideCollegeFeeAward(role: unknown): boolean {
  return typeof role === "string" && APPROVER_ROLE_SET.has(role);
}

/** The refusal a denied writer receives — the 403 body and the page's own message. */
export const COLLEGE_FEES_WRITE_REFUSAL =
  "College fees are managed by the school administration and the accounts office.";

/** The refusal a denied reader receives. */
export const COLLEGE_FEES_READ_REFUSAL =
  "College fees are available to the school administration, the accounts office and the registrar.";

/** The refusal for deciding an award one is not allowed to decide. */
export const COLLEGE_FEES_AWARD_APPROVAL_REFUSAL =
  "An award is approved or rejected by the administration, and never by the person who proposed it.";
