import { NextRequest, NextResponse } from "next/server";
import { prisma } from "./db";
import {
  COLLEGE_ATTENDANCE_READ_REFUSAL,
  COLLEGE_ATTENDANCE_WRITE_REFUSAL,
  canReadCollegeAttendance,
  canWriteCollegeAttendance,
} from "./college-attendance-access";
import {
  COURSE_ATTENDANCE_UNMARKED,
  approvedRosterStudentIds,
  courseAttendanceDateKey,
  isCourseAttendanceStatus,
  readCourseAttendanceSlot,
} from "./college-attendance";

/**
 * College attendance — the SERVER half of Phase 8 ca-3 (docs/COLLEGE-DECISIONS.md
 * §24.8, D-CA-1…D-CA-3). The rule is `src/lib/college-attendance-access.ts` (ca-0)
 * and the identity/status/roster logic is `src/lib/college-attendance.ts` (ca-1);
 * this module is the ONE place that joins them to the store, so the roster read,
 * the session save and the per-student history cannot disagree.
 *
 * It exists for the reason ca-0's header names: each caller applies the pure rule
 * "the way `college-results-server.ts` and `college-fees-server.ts` wrap theirs".
 * A route that re-stated the allow-list or re-derived a `YYYY-MM-DD` key would be
 * the second copy this module prevents.
 *
 * **The caller must already have passed the college gate.** Every entry point
 * takes an explicit `schoolId` and reads only that tenant's rows; the GATE is the
 * route's job (`requireCollege({ schoolId })` first in every handler, proved by
 * `scripts/verify-college-routes.mjs`), exactly as in the results server half.
 *
 * **No composite index is required.** Every store query here is a scalar
 * equality (`schoolId`, `courseId`, `studentId`); the session's date and slot are
 * not stored as query keys — the derived `ca_…` id is the identity, and a course's
 * rows are filtered in memory against the session's own `dateKey`/slot. The new
 * collection therefore appears in no `firestore.indexes.json` definition.
 */

/** The tenant this request targets — the SUPER_ADMIN's `?schoolId=`, else the session's own. */
export function targetSchoolId(
  session: { role: string; schoolId: string | null },
  req: NextRequest
): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

/**
 * The READ gate every college attendance reader passes (ca-0's rule as a 403).
 *
 * v1 lets the admin-level roles and the REGISTRAR read a register; TEACHER,
 * GUARDIAN, STUDENT, ACCOUNTANT, LIBRARIAN and FRONT_DESK are denied, and an
 * absent/unknown role is denied too. Returns `null` when the caller may read, else
 * the 403 body — the same shape as `requireCollege()` and `writeGuard()`:
 *
 *   const denied = requireCollegeAttendanceRead(session);
 *   if (denied) return denied;
 */
export function requireCollegeAttendanceRead(
  session: { role?: string | null } | null | undefined
): NextResponse | null {
  if (canReadCollegeAttendance(session?.role)) return null;
  return NextResponse.json({ error: COLLEGE_ATTENDANCE_READ_REFUSAL }, { status: 403 });
}

/** The WRITE gate (ca-0's rule as a 403): marking a register is admin-level only, never the REGISTRAR. */
export function requireCollegeAttendanceWrite(
  session: { role?: string | null } | null | undefined
): NextResponse | null {
  if (canWriteCollegeAttendance(session?.role)) return null;
  return NextResponse.json({ error: COLLEGE_ATTENDANCE_WRITE_REFUSAL }, { status: 403 });
}

/** A trimmed non-empty string, else "". */
export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The message a missing course parameter receives. */
export const ATTENDANCE_COURSE_REQUIRED = "A course is required.";
/** The message a missing student parameter receives. */
export const ATTENDANCE_STUDENT_REQUIRED = "A student is required.";
/** The message an unusable session date receives. */
export const ATTENDANCE_DATE_REQUIRED = "A valid session date is required.";

/**
 * The session's local midnight and its `YYYY-MM-DD` key — the SAME convention the
 * school's register uses (`new Date(dateStr + "T00:00:00")`), so the derived id
 * never drifts a day; `null` for a missing or unparseable date (the caller answers
 * 400 rather than inventing a session).
 */
export function sessionDateFor(value: unknown): { date: Date; dateKey: string } | null {
  const text = readString(value);
  if (!text) return null;
  const date = new Date(`${text}T00:00:00`);
  if (Number.isNaN(date.getTime())) return null;
  return { date, dateKey: courseAttendanceDateKey(date) };
}

/** One stored row has this session's identity (course is already filtered by the query). */
function isSessionRow(row: any, dateKey: string, slot: number): boolean {
  if (!row) return false;
  if (courseAttendanceDateKey(row.sessionDate) !== dateKey) return false;
  return readCourseAttendanceSlot(row.slot) === slot;
}

/**
 * The course's stored rows for ONE session: `(course, dateKey, slot) → Map<studentId, row>`.
 *
 * One tenant-scoped query on `courseId`, the session filter in memory (the store
 * cannot join, and the id is the identity). Used by the roster read (to show a
 * stored status) and by the save (to compare against what was already recorded,
 * which is what makes a re-saved absence quiet).
 */
export async function storedRowsForSession(
  schoolId: string,
  courseId: string,
  dateKey: string,
  slot: number
): Promise<Map<string, any>> {
  const rows: any[] = (await prisma.courseAttendance.findMany({
    where: { schoolId, courseId },
  })) as any[];
  const byStudent = new Map<string, any>();
  for (const row of rows) {
    if (!isSessionRow(row, dateKey, slot)) continue;
    const studentId = readString(row.studentId);
    if (studentId) byStudent.set(studentId, row);
  }
  return byStudent;
}

/**
 * The roster (D-CA-2): the course's APPROVED registrations, resolved server-side.
 *
 * Returns the student ids in first-seen order plus the registration each came
 * from, so a saved row records the registration that put the student on the
 * roster (`registrationId`, `programId`, `termNumber`) and a client-sent student
 * list can never widen it. An unapproved registration is not on the roster.
 */
export async function approvedRosterFor(
  schoolId: string,
  courseId: string
): Promise<{ studentIds: string[]; registrationByStudent: Map<string, any> }> {
  const registrations: any[] = (await prisma.courseRegistration.findMany({
    where: { schoolId, courseId },
  })) as any[];
  const studentIds = approvedRosterStudentIds(registrations);
  const registrationByStudent = new Map<string, any>();
  for (const studentId of studentIds) {
    const row = registrations.find(
      (candidate) => readString(candidate?.studentId) === studentId
    );
    if (row) registrationByStudent.set(studentId, row);
  }
  return { studentIds, registrationByStudent };
}

/** The register's counts, over ONE vocabulary (the four stored statuses plus the placeholder). */
export interface AttendanceSummary {
  total: number;
  present: number;
  absent: number;
  late: number;
  leave: number;
  unmarked: number;
}

/**
 * Count a register's statuses. A value outside the four stored statuses counts as
 * `unmarked` rather than inventing a bucket — the reader's vocabulary is closed.
 */
export function summariseAttendance(statuses: unknown[]): AttendanceSummary {
  const count = (want: string) => statuses.filter((s) => s === want).length;
  return {
    total: statuses.length,
    present: count("PRESENT"),
    absent: count("ABSENT"),
    late: count("LATE"),
    leave: count("LEAVE"),
    unmarked: count(COURSE_ATTENDANCE_UNMARKED),
  };
}

/** One stored row as the API serves it — never a raw document. */
export interface ServedAttendanceRow {
  id: string;
  studentId: string;
  status: string;
  remark: string;
  dateKey: string;
  sessionDate: string | null;
  slot: number;
  markedById: string | null;
}

/**
 * Serve one stored row. A status outside the four stored values is reported as
 * `UNMARKED` rather than echoed — storage is canonical (ca-1) and a reader must
 * never see a value the four-value vocabulary does not contain.
 */
export function serveAttendanceRow(row: any): ServedAttendanceRow {
  // The store returns a real Date for a stored timestamp (`conv`), but a legacy
  // or hand-written string is tolerated: an unusable date serves null, never
  // `Invalid Date`.
  const when = row?.sessionDate ? new Date(row.sessionDate) : null;
  const valid = when !== null && !Number.isNaN(when.getTime());
  return {
    id: String(row?.id ?? ""),
    studentId: readString(row?.studentId),
    status: isCourseAttendanceStatus(row?.status) ? row.status : COURSE_ATTENDANCE_UNMARKED,
    remark: typeof row?.remark === "string" ? row.remark : "",
    dateKey: valid ? courseAttendanceDateKey(when as Date) : "",
    sessionDate: valid ? (when as Date).toISOString() : null,
    slot: readCourseAttendanceSlot(row?.slot) ?? 1,
    markedById: row?.markedById ?? null,
  };
}
