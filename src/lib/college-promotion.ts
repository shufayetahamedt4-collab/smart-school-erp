/**
 * College promotion ladder — the ONE definition of how a college student moves
 * from one term of a programme to the next (Phase 5a, docs/COLLEGE-DECISIONS.md §15).
 *
 * A college student carries `students.programId` + `students.termNumber` (Phase
 * 4a). The programme already knows how many terms it has — `termCount =
 * durationYears × (SEMESTER ? 2 : 1)`, derived by `src/lib/college-terms.ts` —
 * so a term is a plain **integer position** on a ladder and there are **no term
 * rows and no new collection** (the Phase 5 ruling).
 *
 * This module is the pure half of the ladder: given a programme's term count and
 * a cohort of students, it decides what each student's position means. It writes
 * nothing, reads nothing, and knows nothing about HTTP, prisma, sessions or
 * React — `scripts/verify-college-promotion-logic.mjs` pins that property by
 * failing if an `import` appears in this file.
 *
 * Why it takes `termCount` as an argument instead of importing `college-terms.ts`:
 * the no-import property is what lets the verifier, a client component and Edge
 * code import this module, and `college-terms.ts` stays the single source of
 * truth for the arithmetic — duplicating it here is exactly the drift that
 * module's own header warns against. The caller derives the count with
 * `termCount(durationYears, termSystem)` and passes the number in.
 *
 * The decided rules (D1–D11, recorded in docs/COLLEGE-DECISIONS.md §15):
 *
 *   - **D2 — no marker field, no retain.** Idempotency is structural: the cohort
 *     is defined by an exact `termNumber`, so once a student has advanced it is
 *     no longer in the previous term's cohort and a re-run selects nobody. There
 *     is no `promotionSessionId`-style marker and no `retain` action.
 *   - **D3 — strict cohort.** A student is in the cohort only when
 *     `programId` **and** `termNumber` both equal the target position.
 *   - **D4 — only students with a programme.** A student with no `programId` is
 *     never in the ladder; a cohort member that ALSO holds a `classId` is kept,
 *     but flagged (`classIdWarning`) so the preview can warn that the school
 *     ladder may move the same student independently.
 *   - **D5 — the last term graduates.** At the programme's final term the action
 *     is `graduate` (the caller stamps `status = "ALUMNI"`, the existing
 *     terminal value), and the run is reported as `graduating` on its own.
 *   - **D6 — course progress is not consulted.** A `pendingRegistrationCount`
 *     may be carried on a student for display; it is INFO ONLY and never removes
 *     a student from the cohort.
 *   - **D7 — registrations are untouched.** Nothing here mutates, carries or
 *     resets a registration; the caller writes only the student's own fields.
 *   - **D9 — independent of the academic session.** A term advance has no
 *     `sessionId` dimension and no target session; the ladder is a programmatic
 *     position, not a calendar row.
 */

/** The two actions a cohort member can have. There is deliberately no `retain`. */
export const COLLEGE_PROMOTION_ACTIONS = ["advance", "graduate"] as const;

export type CollegePromotionAction = (typeof COLLEGE_PROMOTION_ACTIONS)[number];

/** Is this exactly one of the two stored actions? */
export function isCollegePromotionAction(value: unknown): value is CollegePromotionAction {
  return typeof value === "string" && (COLLEGE_PROMOTION_ACTIONS as readonly string[]).includes(value);
}

/**
 * A student's term position: a whole number ≥ 1, or `null` for anything else
 * (absent, `null`, `0`, negative, fractional, a string, `NaN`). A missing or
 * unrecognised value is NOT a position — it is "not a college student", the same
 * `missing = the old behaviour` convention as `programId` itself.
 */
export function normalizeTermNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

/**
 * The programme's term count, read defensively: a whole number > 0, else `0`.
 * `0` means "no resolvable ladder", which every caller must treat as "cannot
 * decide" rather than "no terms" — with no count there is no way to tell a mid
 * term from the last one, so no action may be inferred.
 */
export function normalizeTermCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : 0;
}

/** A whole number ≥ 0 for display-only counters (D6); anything else reads 0. */
export function normalizeCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

/** Is this term the programme's last one? (`termCount` 0 knows no last term.) */
export function isLastCollegeTerm(termNumber: number, termCount: number): boolean {
  const total = normalizeTermCount(termCount);
  return total > 0 && normalizeTermNumber(termNumber) === total;
}

/**
 * The action for one position on the ladder, or `null` when the position is not
 * reachable on this programme (a bad term, a bad count, or a term past the end).
 * The caller must treat `null` as "not in the cohort", never as an advance.
 */
export function collegePromotionActionFor(termNumber: unknown, termCount: unknown): CollegePromotionAction | null {
  const term = normalizeTermNumber(termNumber);
  const total = normalizeTermCount(termCount);
  if (term === null || total === 0 || term > total) return null;
  return term === total ? "graduate" : "advance";
}

/** The destination term of an advance: one step up, or `null` for a bad term. */
export function collegeNextTerm(termNumber: unknown): number | null {
  const term = normalizeTermNumber(termNumber);
  return term === null ? null : term + 1;
}

/** The student fields the ladder reads. Nothing else is consulted (D6/D7/D9). */
export interface CollegeCohortStudent {
  id: string;
  programId?: unknown;
  termNumber?: unknown;
  classId?: unknown;
  /** Informational only (D6): never removes the student from the cohort. */
  pendingRegistrationCount?: unknown;
}

/**
 * Is this student in the cohort at `(programId, fromTermNumber)`? (D3 + D4.)
 *
 * Both halves must match exactly: a student on the same programme at a different
 * term, a student of another programme at the same term, a student with no
 * programme, and a student with no term are all NOT in the cohort. An unset
 * target programme never matches anything.
 */
export function inCollegeCohort(
  student: CollegeCohortStudent | null | undefined,
  programId: string | null | undefined,
  fromTermNumber: unknown
): boolean {
  if (!student || typeof student !== "object") return false;
  const target = typeof programId === "string" ? programId : "";
  const from = normalizeTermNumber(fromTermNumber);
  if (!target || from === null) return false;
  const pid = typeof student.programId === "string" ? student.programId : "";
  return pid === target && normalizeTermNumber(student.termNumber) === from;
}

/** One line of the preview: what happens to one student. */
export interface CollegePromotionRow {
  studentId: string;
  fromTermNumber: number;
  action: CollegePromotionAction;
  /** The term the student moves to, or `null` when the action is `graduate`. */
  toTermNumber: number | null;
  graduating: boolean;
  /** The student also sits in a school class, so the school ladder may move it too (D4). */
  classIdWarning: boolean;
  /** Information only — the ladder does not block on it (D6). */
  pendingRegistrationCount: number;
}

/** The preview's tallies. `pendingRegistrations` is informational (D6). */
export interface CollegePromotionCounts {
  advance: number;
  graduate: number;
  classIdWarnings: number;
  pendingRegistrations: number;
}

/** The whole preview for one `(programme, term)` position. */
export interface CollegePromotionPreview {
  programId: string;
  fromTermNumber: number;
  termCount: number;
  /** True when this position is the programme's last term, so the run graduates. */
  graduating: boolean;
  rows: CollegePromotionRow[];
  count: number;
  counts: CollegePromotionCounts;
}

/**
 * The row for one student, or `null` when the student is not in the cohort.
 *
 * Pure: it never mutates the student and never reads anything but the five
 * fields above. `toTermNumber` is derived from the action, so a graduating row
 * can never carry a destination term.
 */
export function buildCollegePromotionRow(
  student: CollegeCohortStudent | null | undefined,
  programId: string | null | undefined,
  fromTermNumber: unknown,
  termCount: unknown
): CollegePromotionRow | null {
  const from = normalizeTermNumber(fromTermNumber);
  const total = normalizeTermCount(termCount);
  if (from === null || total === 0 || from > total) return null;
  if (!inCollegeCohort(student, programId, from)) return null;
  const action = collegePromotionActionFor(from, total);
  if (action === null) return null;
  const row: CollegePromotionRow = {
    studentId: typeof student?.id === "string" ? student.id : "",
    fromTermNumber: from,
    action,
    toTermNumber: action === "advance" ? from + 1 : null,
    graduating: action === "graduate",
    classIdWarning: typeof student?.classId === "string" && student.classId.length > 0,
    pendingRegistrationCount: normalizeCount(student?.pendingRegistrationCount),
  };
  return row;
}

/**
 * Build the preview for one `(programme, fromTermNumber)` position.
 *
 * A student in the cohort is listed exactly once, in the order given. Students
 * outside the cohort (another programme, another term, no programme, no term)
 * are silently omitted — they are not "retained" and there is no marker to
 * report (D2), so the preview lists only real work.
 *
 * An unresolvable position — no programme, a bad term, or a term past the
 * programme's end — yields an EMPTY preview with `count` 0 rather than a guess,
 * because with no term count a mid term cannot be told from the last one.
 *
 * `pendingRegistrationCounts` is an optional `studentId → count` map for
 * DISPLAY only (D6); a missing entry reads 0 and never excludes anybody.
 */
export function buildCollegePromotionPreview(input: {
  students: readonly CollegeCohortStudent[] | null | undefined;
  programId: string | null | undefined;
  fromTermNumber: unknown;
  termCount: unknown;
  pendingRegistrationCounts?: Readonly<Record<string, number>> | null;
}): CollegePromotionPreview {
  const programId = typeof input?.programId === "string" ? input.programId : "";
  const from = normalizeTermNumber(input?.fromTermNumber);
  const total = normalizeTermCount(input?.termCount);
  const students = Array.isArray(input?.students) ? input.students : [];
  const pendingBy =
    input?.pendingRegistrationCounts && typeof input.pendingRegistrationCounts === "object"
      ? input.pendingRegistrationCounts
      : null;

  const rows: CollegePromotionRow[] = [];
  const counts: CollegePromotionCounts = { advance: 0, graduate: 0, classIdWarnings: 0, pendingRegistrations: 0 };

  const reachable = programId !== "" && from !== null && total > 0 && from <= total;
  if (reachable) {
    for (const student of students) {
      if (!student || typeof student !== "object") continue;
      const row = buildCollegePromotionRow(student, programId, from, total);
      if (!row) continue;
      if (pendingBy && typeof student.id === "string" && Object.prototype.hasOwnProperty.call(pendingBy, student.id)) {
        row.pendingRegistrationCount = normalizeCount(pendingBy[student.id]);
      }
      rows.push(row);
      if (row.action === "advance") counts.advance += 1;
      else counts.graduate += 1;
      if (row.classIdWarning) counts.classIdWarnings += 1;
      counts.pendingRegistrations += row.pendingRegistrationCount;
    }
  }

  return {
    programId,
    fromTermNumber: from === null ? 0 : from,
    termCount: total,
    graduating: reachable && from === total,
    rows,
    count: rows.length,
    counts,
  };
}
