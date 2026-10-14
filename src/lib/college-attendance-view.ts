/**
 * College course attendance — the register SCREEN's decisions, pure (Phase 8
 * ca-4, docs/COLLEGE-DECISIONS.md §24.8/§29, D-CA-1…D-CA-4).
 *
 * `src/app/dashboard/course-attendance/page.tsx` (a client component) is mostly
 * JSX. What is NOT JSX — and what a reviewer must not have to read hundreds of
 * lines of markup to check — is a small set of load-bearing rules:
 *
 *   - **D-CA-3's vocabulary is the SERVER's.** The five things a mark control may
 *     offer (the four stored statuses plus the read-only `UNMARKED` placeholder)
 *     come from `src/lib/college-attendance.ts` — ca-1's pure module — so the
 *     screen cannot offer, store or label a value the API would refuse.
 *   - **D-CA-2's roster is the SERVER's.** `rowsToSave` can only ever return rows
 *     it was HANDED, in the order it was handed them: a screen cannot add a
 *     student, widen the roster, or address a row by anything but the `studentId`
 *     the API served. `UNMARKED` rows are skipped (the API skips them too), and a
 *     remark is trimmed to `null` so "empty" has one spelling.
 *   - **The slot is ca-1's reader**, not a second parser: `slotFromInput` IS
 *     `readCourseAttendanceSlot` (absent = 1; anything else unusable is `null`, so
 *     the screen refuses to send it instead of guessing).
 *
 * This module imports ONE thing — `./college-attendance`, which is itself
 * dependency-free — and nothing else: no React, no `next/`, no prisma, no
 * `node:`, so a plain-`node` offline verifier
 * (`scripts/verify-college-attendance-page.mjs`) imports it directly and fails if
 * a heavier import appears.
 *
 * **Nothing here proves a page RENDERS.** There is no DOM, no React and no
 * browser in this file: a real browser pass is a separate, recorded step, and the
 * register's own HTTP behaviour is proved by `verify-course-attendance.mjs`.
 */
import {
  COURSE_ATTENDANCE_STATUSES,
  COURSE_ATTENDANCE_UNMARKED,
  readCourseAttendanceSlot,
} from "./college-attendance";

/* --------------------------------------------------------------- the surface */

/**
 * The ONE endpoint this screen uses: `GET` the session's register, `POST` the
 * save (ca-3). The per-student history endpoint exists (`/history`) but belongs to
 * a later read (a student's own history view), so this screen never calls it and
 * the path is not spelled here — a second path would be a second contract.
 */
export const ATTENDANCE_ENDPOINT = "/api/course-attendance";

/** The human fallback for every load on this screen, in one place. */
export const PAGE_ERRORS = {
  courses: "Could not load the courses",
  roster: "Could not load the register",
  save: "Could not save the register",
} as const;

/** The fallback message for a failed call whose error carries no usable text. */
export function messageOf(e: unknown, fallback: string): string {
  const message = (e as { message?: unknown } | null | undefined)?.message;
  return typeof message === "string" && message.trim() ? message : fallback;
}

/**
 * A failed call, as the screen must show it.
 *
 * The API's own sentence is the clearest thing available and is preferred
 * verbatim — it names the rule that refused (ca-0's refusal, ca-1's roster/status
 * rule, "Course not found"). Only when there is NO sentence (a middleware or proxy
 * refusal renders HTML, so `api()` finds no `error` field) does this map the HTTP
 * status to a plain sentence, so a 403/404/400 is never an empty red box.
 */
export function pageError(e: unknown, fallback: string): string {
  const message = (e as { message?: unknown } | null | undefined)?.message;
  if (typeof message === "string" && message.trim()) return message;
  const status = (e as { status?: unknown } | null | undefined)?.status;
  if (status === 401) return "Your session ended — sign in again.";
  if (status === 403) return "Your role may not read this register.";
  if (status === 404) return "That course is not in this college.";
  if (status === 400) return "The register refused the request — check the course, date and slot.";
  return fallback;
}

/** The notes a reader may see instead of a grid, each said once. */
export const NO_COLLEGE_NOTE = "Course attendance is a college-mode screen — this tenant runs a school.";
export const REFUSED_NOTE = "Your role may not read a course register.";
export const READ_ONLY_NOTE = "Your role may read this register but never mark it.";
export const PICK_COURSE_NOTE = "Choose a course to load its register.";
export const SLOT_HINT = "Session 1 is the default; a second session of the same course on the same day is its own register.";

/** Why a course can be listed and still have nothing to mark (D-CA-2). */
export function noRosterNote(courseLabel: string): string {
  const label = courseLabel || "this course";
  return `No APPROVED registrations for ${label} yet — a register lists a course's approved students only.`;
}

/* ------------------------------------------------------- the status vocabulary */

/** The words one status is shown under. Every value ca-1 defines has one. */
export function statusLabel(status: unknown): string {
  switch (status) {
    case COURSE_ATTENDANCE_UNMARKED:
      return "Not marked";
    case "PRESENT":
      return "Present";
    case "ABSENT":
      return "Absent";
    case "LATE":
      return "Late";
    case "LEAVE":
      return "Leave";
    default:
      return typeof status === "string" && status.trim() ? status : String(status);
  }
}

/**
 * The mark controls a session offers: the FOUR stored statuses, in ca-1's order,
 * each with the word the screen shows. `UNMARKED` is deliberately NOT offered —
 * it is a placeholder the API reads, never a choice a marker makes (a row left
 * alone keeps its stored status), and ca-1 refuses to store it.
 */
export function statusOptions(): { value: string; label: string }[] {
  return COURSE_ATTENDANCE_STATUSES.map((value) => ({ value, label: statusLabel(value) }));
}

/**
 * The fill a CHOSEN mark control takes, by status. Presentation, decided once so
 * the page carries no status literal of its own: the four stored values each have
 * their own tone (the school register's own four), and anything else — the
 * placeholder included — is the neutral "nothing chosen yet" fill.
 */
export function markTone(status: unknown): string {
  switch (status) {
    case "PRESENT":
      return "border-emerald-500 bg-emerald-500 text-white";
    case "ABSENT":
      return "border-rose-500 bg-rose-500 text-white";
    case "LATE":
      return "border-amber-500 bg-amber-500 text-white";
    case "LEAVE":
      return "border-sky-500 bg-sky-500 text-white";
    default:
      return "border-slate-300 bg-slate-100 text-slate-600";
  }
}

/** Is this value one the API will store? (Nothing else may be sent.) */
export function isStorableStatus(value: unknown): boolean {
  return COURSE_ATTENDANCE_STATUSES.some((s) => s === value);
}

/** The slot field's reader — ca-1's own, so the screen and the API agree. */
export function slotFromInput(value: unknown): number | null {
  return readCourseAttendanceSlot(value);
}

/* ------------------------------------------------------------- the roster grid */

/** One row as the REGISTER read serves it (`GET /api/course-attendance`). */
export interface RegisterRow {
  studentId: string;
  registrationId?: string | null;
  programId?: string | null;
  termNumber?: number | null;
  name?: string | null;
  admissionNo?: string | null;
  status: string;
  remark?: string | null;
  markedById?: string | null;
}

/** One row as the SCREEN holds it while marking (the served fields + edits). */
export interface EditableRow {
  studentId: string;
  name: string;
  admissionNo: string;
  status: string;
  remark: string;
}

/** The served rows, as editable rows: the screen adds no student and drops none. */
export function editableRows(rows: readonly RegisterRow[] | null | undefined): EditableRow[] {
  return (rows || []).map((row) => ({
    studentId: String(row?.studentId ?? ""),
    name: typeof row?.name === "string" && row.name.trim() ? row.name : String(row?.studentId ?? ""),
    admissionNo: typeof row?.admissionNo === "string" ? row.admissionNo : "",
    status: typeof row?.status === "string" && row.status.trim() ? row.status : COURSE_ATTENDANCE_UNMARKED,
    remark: typeof row?.remark === "string" ? row.remark : "",
  }));
}

/** Set one row's status (the grid's own update, by the id the API served). */
export function withStatus(rows: readonly EditableRow[], studentId: string, status: string): EditableRow[] {
  return rows.map((row) => (row.studentId === studentId ? { ...row, status } : row));
}

/** Set one row's remark. */
export function withRemark(rows: readonly EditableRow[], studentId: string, remark: string): EditableRow[] {
  return rows.map((row) => (row.studentId === studentId ? { ...row, remark } : row));
}

/** One row of the save payload — exactly the three fields the API reads. */
export interface SaveRow {
  studentId: string;
  status: string;
  remark: string | null;
}

/**
 * The rows a save may send, and how many it left alone (D-CA-2/D-CA-3).
 *
 * Only rows the API HANDED to the screen, only ids it served, only statuses ca-1
 * stores; `UNMARKED` (and anything unknown) is skipped and counted, never sent.
 * The remark is trimmed, and an empty one becomes `null` so "no remark" has ONE
 * spelling in the store. The order is the roster's own, so a save reads the way
 * the grid does.
 */
export function rowsToSave(rows: readonly EditableRow[] | null | undefined): {
  rows: SaveRow[];
  skipped: number;
} {
  const out: SaveRow[] = [];
  let skipped = 0;
  for (const row of rows || []) {
    const studentId = typeof row?.studentId === "string" ? row.studentId.trim() : "";
    if (!studentId || !isStorableStatus(row?.status)) {
      skipped += 1;
      continue;
    }
    const remark = typeof row?.remark === "string" ? row.remark.trim() : "";
    out.push({ studentId, status: row.status, remark: remark ? remark : null });
  }
  return { rows: out, skipped };
}

/** The save button's label, so a busy save reads consistently with the app. */
export function saveButtonLabel(busy: unknown): string {
  return busy ? "Saving…" : "Save register";
}

/**
 * What the save reports back: what was written, what was left unmarked, and how
 * many families the new-absence rule actually notified (D-CA-3). A save that
 * wrote nothing says so rather than claiming success.
 */
export function saveMessage(input: {
  written?: unknown;
  skipped?: unknown;
  newlyAbsent?: unknown;
} | null | undefined): string {
  const written = count(input?.written);
  const skipped = count(input?.skipped);
  const absent = Array.isArray(input?.newlyAbsent) ? input.newlyAbsent.length : count(input?.newlyAbsent);
  if (!written) return skipped ? "Nothing to save — every student was left unmarked." : "Nothing to save.";
  const parts = [`Saved ${written} mark${written === 1 ? "" : "s"}`];
  if (skipped) parts.push(`${skipped} left unmarked`);
  if (absent) parts.push(`${absent} famil${absent === 1 ? "y" : "ies"} notified`);
  return parts.join(" · ");
}

/** A non-negative integer from whatever the API sent, or 0. */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/* ------------------------------------------------------------ the summary line */

/** The register's counts, as the API serves them (`summary`). */
export interface RegisterSummary {
  total?: unknown;
  present?: unknown;
  absent?: unknown;
  late?: unknown;
  leave?: unknown;
  unmarked?: unknown;
}

/** `12 students` / `1 student` — the roster's own size. */
export function rosterCountText(rows: readonly unknown[] | null | undefined): string {
  const n = Array.isArray(rows) ? rows.length : 0;
  return `${n} student${n === 1 ? "" : "s"}`;
}

/** `3 of 12 marked` — how much of the session is recorded. */
export function markedCountText(rows: readonly EditableRow[] | null | undefined): string {
  const total = Array.isArray(rows) ? rows.length : 0;
  const marked = (rows || []).filter((row) => isStorableStatus(row?.status)).length;
  return `${marked} of ${total} marked`;
}

/** The five counters, in the order the screen shows them, from the API's summary. */
export function summaryCells(summary: RegisterSummary | null | undefined): { label: string; value: number }[] {
  return [
    { label: "Present", value: count(summary?.present) },
    { label: "Absent", value: count(summary?.absent) },
    { label: "Late", value: count(summary?.late) },
    { label: "Leave", value: count(summary?.leave) },
    { label: "Not marked", value: count(summary?.unmarked) },
  ];
}

/** The course, in one label, for the header and the empty-roster note. */
export function courseLabel(course: { code?: unknown; title?: unknown } | null | undefined): string {
  const code = typeof course?.code === "string" ? course.code.trim() : "";
  const title = typeof course?.title === "string" ? course.title.trim() : "";
  if (code && title) return `${code} — ${title}`;
  return title || code;
}
