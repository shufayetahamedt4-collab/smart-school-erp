/**
 * College attendance — the PURE half of Phase 8 ca-1 (docs/COLLEGE-DECISIONS.md
 * §24.8, D-CA-1…D-CA-3; the owner's answers Q7/Q8, 2026-10-11). It decides the
 * few things more than one later step must agree on, and nothing else:
 *
 *   - **the deterministic row id, `ca_<courseId>_<dateKey>_<slot>_<studentId>`**
 *     (D-CA-1). A register is re-saved whenever one row is corrected, so a row is
 *     addressed by its identity instead of appended: the same parts always derive
 *     the same id, and the ca-3 save upserts that one row. The school's own key
 *     cannot be reused (D-3-6): its `a_<studentId>_<dateKey>` has no course in it
 *     and no slot.
 *   - **the date key**, mirroring the store's own local `YYYY-MM-DD` helper
 *     (`src/lib/db.ts`'s module-local `dateKey`). D-CA-1 makes **ca-2** own the
 *     export-or-mirror decision and the assertion against the original; ca-1
 *     states the mirror, and `scripts/verify-college-attendance-logic.mjs` pins
 *     its shape against `db.ts` read as text today.
 *   - **the slot** (Q7): `1..n` in the key, and **absent = 1**. The slot is part
 *     of the id, so a second session of the same course on the same day is a
 *     different row.
 *   - **the four statuses**, reused verbatim from the school's register —
 *     `PRESENT` / `ABSENT` / `LATE` / `LEAVE` — with `UNMARKED` kept as the
 *     read-only "no row yet" placeholder (it is never stored).
 *   - **the roster** (D-CA-2): the **APPROVED registrations for that course**,
 *     read with the SAME rule college fees already bills by — "the same machine
 *     that makes a course gradable (Phase 6) and billable (24.4) decides who may
 *     be marked". The route resolves the roster server-side, so a client-sent
 *     student list cannot widen it, and a row for a student without an approved
 *     registration is refused.
 *   - **the notification decision** (D-CA-3): a guardian hears about an absence
 *     only when it is **new** — the stored register for that (course, day, slot,
 *     student) was not already ABSENT — so a corrected register never re-mails a
 *     family. The notification's text names the course and the slot; that copy
 *     belongs to ca-3's route, not here.
 *
 * **Why this file is separate, and why it is pure.** The rule has to be consumed
 * by the ca-3 API handlers (server), the ca-2 store entry (which must derive the
 * same id), and the ca-4 register screen (a client component). A `NextResponse`
 * or prisma import here would drag the database into the browser bundle, so the
 * module has **no imports at all** — the design of `course-teachers.ts`,
 * `registration-status.ts`, `college-terms.ts` and `college-routes.ts` — and the
 * offline verifier pins that property by failing if an `import` appears.
 *
 * **What ca-1 deliberately does NOT do.** It adds no db access, no route, no
 * page, no nav entry and no `COLS`/`RELS` entry: the `courseAttendance` collection
 * is ca-2 (D-CA-1's fields), the roster/session API is ca-3 and the register
 * screen is ca-4. It also does not notify anyone — `notifyGuardianOfStudent` is
 * the route's own path (the school's `/api/attendance` route, mirrored).
 */

/** The derived-id prefix — `ca_` for a course-attendance row (D-CA-1). */
export const COURSE_ATTENDANCE_ID_PREFIX = "ca_";

/** The four stored statuses, verbatim from the school's register (D-CA-3). */
export const COURSE_ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "LATE", "LEAVE"] as const;

export type CourseAttendanceStatus = (typeof COURSE_ATTENDANCE_STATUSES)[number];

/**
 * The read-only placeholder for "no row yet" — the school's register uses the
 * same word, and it is NEVER stored: a save skips it (the school's POST filters
 * `status !== "UNMARKED"`).
 */
export const COURSE_ATTENDANCE_UNMARKED = "UNMARKED";

/** The slot a session gets when the caller does not name one (Q7: absent = 1). */
export const COURSE_ATTENDANCE_DEFAULT_SLOT = 1;

/** The refusal an invalid slot receives (ca-3 returns it as a 400 body). */
export const COURSE_ATTENDANCE_SLOT_REFUSAL =
  "A college attendance slot must be a whole number of 1 or more.";

/** The refusal an unknown status receives — nothing is silently defaulted. */
export const COURSE_ATTENDANCE_STATUS_REFUSAL =
  "A college attendance status must be PRESENT, ABSENT, LATE or LEAVE.";

/** The refusal a student outside the approved roster receives (D-CA-2). */
export const COURSE_ATTENDANCE_ROSTER_REFUSAL =
  "Only a student with an APPROVED registration for this course can be marked.";

/**
 * The local `YYYY-MM-DD` key for a date — the mirror of `db.ts`'s module-local
 * `dateKey` that D-CA-1 requires (ca-2 owns the export-or-mirror decision and the
 * assertion against the original; the offline verifier pins today's shape).
 *
 * Local time, exactly like the original: the school's attendance window is built
 * from the same `new Date(dateStr + "T00:00:00")` local-midnight convention, so
 * the derived key never drifts a day across a timezone boundary.
 */
export function courseAttendanceDateKey(d: Date | string): string {
  const dt = new Date(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/**
 * Read a session slot: `undefined`, `null` or a blank string mean "no slot was
 * chosen", which is slot 1 (Q7); a positive whole number (or its numeric string)
 * is itself; anything else is `null` — the caller refuses it with
 * `COURSE_ATTENDANCE_SLOT_REFUSAL`. Never NaN, never 0, never a fraction.
 */
export function readCourseAttendanceSlot(value: unknown): number | null {
  if (value === undefined || value === null) return COURSE_ATTENDANCE_DEFAULT_SLOT;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return COURSE_ATTENDANCE_DEFAULT_SLOT;
  const n = typeof value === "number" ? value : Number(value.trim());
  if (!Number.isInteger(n) || n < 1) return null;
  return n;
}

/** A required id part: trimmed, and never empty (an empty half would collide). */
function requiredPart(value: unknown, what: string): string {
  const text = String(value ?? "").trim();
  if (!text) throw new Error(`courseAttendanceId requires a ${what}.`);
  return text;
}

/**
 * The deterministic row id (D-CA-1): `ca_<courseId>_<dateKey>_<slot>_<studentId>`.
 *
 * It is the whole idempotence story — a re-save, a retry or a second session
 * (different slot) each address exactly one row. Every part is required and
 * trimmed; an empty course id, date key or student id THROWS rather than
 * deriving an id shared by every caller that left it empty. The slot defaults to
 * 1 when absent (Q7) and throws when present-but-invalid.
 */
export function courseAttendanceId(
  courseId: unknown,
  dateKey: unknown,
  slot: unknown,
  studentId: unknown
): string {
  const course = requiredPart(courseId, "course id");
  const key = requiredPart(dateKey, "date key");
  const student = requiredPart(studentId, "student id");
  const slotNumber = readCourseAttendanceSlot(slot);
  if (slotNumber === null) throw new Error(COURSE_ATTENDANCE_SLOT_REFUSAL);
  return `${COURSE_ATTENDANCE_ID_PREFIX}${course}_${key}_${slotNumber}_${student}`;
}

/** Is this exactly one of the four stored statuses? (Strict — storage is canonical.) */
export function isCourseAttendanceStatus(value: unknown): value is CourseAttendanceStatus {
  return (
    typeof value === "string" && (COURSE_ATTENDANCE_STATUSES as readonly string[]).includes(value)
  );
}

/**
 * Does this registration row approve the student? (D-CA-2)
 *
 * The lenient reader of `college-fees.ts`'s `isApprovedRegistration`, deliberately
 * identical: `status` is trimmed and uppercased before the compare, so a row
 * written as `" approved "` is still an approval, and a row without a status is
 * not. The offline verifier pins the two readers against the same probe table —
 * "the same machine decides who may be marked and who may be billed".
 */
export function isApprovedCourseRegistration(value: unknown): boolean {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return String(raw.status ?? "").trim().toUpperCase() === "APPROVED";
}

/**
 * The roster (D-CA-2): the student ids of the course's APPROVED registrations,
 * in first-seen order, with duplicates collapsed and blank ids dropped.
 *
 * The caller passes the registrations it resolved FOR THAT COURSE (the route
 * queries by `courseId`), and a duplicated row can never read as two students.
 */
export function approvedRosterStudentIds(registrations: unknown): string[] {
  const list = Array.isArray(registrations) ? registrations : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const row of list) {
    if (!isApprovedCourseRegistration(row)) continue;
    const raw = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    const id = String(raw.studentId ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * May this student be marked in this course? The one predicate the ca-3 save
 * applies to every incoming row: the student must be on the course's APPROVED
 * roster. A blank student id is refused too.
 */
export function isOnApprovedRoster(registrations: unknown, studentId: unknown): boolean {
  const id = String(studentId ?? "").trim();
  if (!id) return false;
  return approvedRosterStudentIds(registrations).includes(id);
}

/**
 * The notification decision (D-CA-3): does saving this row count as a NEW
 * absence, so the guardian should hear about it?
 *
 * Only when the incoming status is ABSENT **and** the stored register for that
 * (course, day, slot, student) was not already ABSENT. `previousStatus` is the
 * stored row's status, or absent/null/UNMARKED when there is no row yet — the
 * school's own route reads its register exactly this way ("Who is NEWLY absent
 * on this save? … notify only a child who was not already marked absent today"),
 * which is what keeps a re-saved or corrected register from re-mailing a family.
 * The copy that goes out (course + slot, instead of a class) belongs to the ca-3
 * route.
 */
export function shouldNotifyAbsence(previousStatus: unknown, nextStatus: unknown): boolean {
  return nextStatus === "ABSENT" && previousStatus !== "ABSENT";
}
