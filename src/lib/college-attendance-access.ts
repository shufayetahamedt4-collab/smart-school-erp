/**
 * College attendance — WHO may READ it and WHO may MARK it, in the ONE place
 * that decides it (Phase 8 ca-0, docs/COLLEGE-DECISIONS.md §24.8 D-CA-4 and §25
 * D-8P-5; owner's answer Q8, 2026-10-11). The module follows the results pattern
 * (`src/lib/college-results-access.ts`) and the fees rule
 * (`src/lib/college-fees-access.ts`): a strict allow-list stated once, applied by
 * every caller — never the school's `attendanceMarks` module.
 *
 * **Why the school's `attendanceMarks` module is not the gate.** Read from
 * `src/lib/permissions.ts`: `attendanceMarks` grants TEACHER `entry` (which
 * implies view), GUARDIAN `view` and STUDENT `viewOwn`. Reusing it would let a
 * teacher mark a college register — post-v1, D-8P-5 — and would expose every
 * course register to every family, which is post-v1 too. That is the same hole
 * `college-results-access.ts` was created to close for results.
 *
 * v1 (staff-only, Q8):
 *
 *   - **WRITE (mark a session):** the admin-level roles — `SUPER_ADMIN`,
 *     `SCHOOL_ADMIN`, `BRANCH_ADMIN`.
 *   - **READ:** the same set, with the `REGISTRAR` added **read-only** — the
 *     results precedent.
 *   - **REFUSED, both directions:** `TEACHER` (the 8-pre course↔teacher link
 *     makes a teacher-facing surface POSSIBLE; D-8P-5 says v1 adds none),
 *     `GUARDIAN` and `STUDENT` (post-v1), `ACCOUNTANT`, `LIBRARIAN` and
 *     `FRONT_DESK`.
 *
 * **Why this file is separate, and why it is pure.** The rule has to be consumed
 * by the ca-3 API handlers (server) and, in ca-4, by the register screen (a
 * client component). A `NextResponse`-shaped helper would pull `next/server` —
 * and any prisma import would pull the database — so the RULE lives here with
 * **no imports at all**, and each caller applies it the way
 * `college-results-server.ts` and `college-fees-server.ts` wrap theirs.
 *
 * **What ca-0 deliberately does NOT do.** It adds no route, no page, no nav
 * entry, no `COLS`/`RELS` entry and no consumer at all: the markable register is
 * ca-1..ca-4's work (D-CA-7), and
 * `scripts/verify-college-attendance-access.mjs` proves the boundary while it
 * holds.
 */

/** The roles that may MARK a college attendance session in v1 — admin-level only (Q8). */
export const COLLEGE_ATTENDANCE_WRITE_ROLES = ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN"] as const;

/** The roles that may READ college attendance in v1 — the markers, plus a read-only REGISTRAR. */
export const COLLEGE_ATTENDANCE_READ_ROLES = [...COLLEGE_ATTENDANCE_WRITE_ROLES, "REGISTRAR"] as const;

export type CollegeAttendanceWriteRole = (typeof COLLEGE_ATTENDANCE_WRITE_ROLES)[number];
export type CollegeAttendanceReadRole = (typeof COLLEGE_ATTENDANCE_READ_ROLES)[number];

/** Set forms, so an unknown/absent role is rejected safely. */
const WRITE_ROLE_SET: ReadonlySet<string> = new Set(COLLEGE_ATTENDANCE_WRITE_ROLES);
const READ_ROLE_SET: ReadonlySet<string> = new Set(COLLEGE_ATTENDANCE_READ_ROLES);

/**
 * May this role MARK a college attendance session (save a register)?
 *
 * A strict allow-list: the three admin-level roles and nothing else — including
 * the `REGISTRAR`, whose v1 access is read-only, and a `TEACHER` even when 8-pre
 * links them to the course (D-8P-5: v1 marking stays staff-only).
 */
export function canWriteCollegeAttendance(role: unknown): boolean {
  return typeof role === "string" && WRITE_ROLE_SET.has(role);
}

/**
 * May this role READ college attendance (a course register, a student's history)?
 *
 * The markers, plus the `REGISTRAR`. Everything else — including the roles the
 * school's `attendanceMarks` module would admit (TEACHER, GUARDIAN, STUDENT) —
 * is refused, and an absent/unknown role is refused too.
 */
export function canReadCollegeAttendance(role: unknown): boolean {
  return typeof role === "string" && READ_ROLE_SET.has(role);
}

/** The refusal a denied marker receives — the 403 body and the screen's own message. */
export const COLLEGE_ATTENDANCE_WRITE_REFUSAL =
  "College attendance is marked by the school administration.";

/** The refusal a denied reader receives. */
export const COLLEGE_ATTENDANCE_READ_REFUSAL =
  "College attendance is available to the school administration and the registrar.";
