/**
 * Phase 8-pre — the course↔teacher link (docs/COLLEGE-DECISIONS.md §24.8, D-CA-4).
 *
 * The college could not answer "who teaches this course?" at all: verified by
 * search at `6a7a31f`, no `teacherId` existed anywhere under
 * `src/app/api/courses`, `src/app/api/course-registrations` or
 * `src/lib/college-*.ts`, and `programCourse` is `{schoolId, programId,
 * courseId, termNumber, requirement}` and nothing more. Two consequences were
 * recorded: v1 attendance marking is staff-only, and BOTH teacher-facing
 * surfaces (a teacher marking their own course register, and the post-v1
 * per-course teacher view of results) are blocked on the same missing link. The
 * owner's answer (2026-10-11, Q8) made that link `8-pre` — the FIRST step of
 * Phase 8, built before the markable register rather than after it.
 *
 * **What this module decides, and why it is pure.** Exactly one thing that more
 * than one place must agree on: the assignment ROW'S IDENTITY. A `courseTeacher`
 * row is addressed by a deterministic id derived from the pair
 * (`ct_<courseId>_<teacherId>`), which is what makes assigning a teacher
 * idempotent — the same reasoning as the school's `attendance` key, the college's
 * `cf_…` charge id (7a) and `promotionRun`'s derived key. The API route derives
 * it, and Phase 8's later steps (the roster read, the register) must derive the
 * same one, so the derivation lives here rather than inlined in a route.
 *
 * It also names the ONE role an assignment may point at. A course is taught by a
 * TEACHER account; assigning an admin, a registrar or a guardian would produce a
 * row no teacher-facing surface could ever resolve, so the rule is stated once
 * and the route refuses anything else.
 *
 * The module is deliberately dependency-free (no prisma, no `next/server`, no
 * node: imports) — the same design as `institution.ts`, `sectors.ts`,
 * `college-routes.ts` and `college-results-access.ts` — so an offline verifier
 * running under plain `node`, a server route and (later) a teacher-facing client
 * component can all import it.
 *
 * **What 8-pre deliberately does NOT do.** It adds no screen and no nav entry:
 * the admin-facing picker belongs with the course screens and the teacher-facing
 * read is the register's own step (D-CA-7's ca-4), so
 * `scripts/nav-scope-snapshot.json` must stay byte-identical while this link
 * exists. It also does not widen any existing payload: `/api/courses` keeps its
 * shape and the link is read from its own endpoint.
 */

/** The derived-id prefix — `ct_` for "course teacher". */
export const COURSE_TEACHER_ID_PREFIX = "ct_";

/**
 * The ONE role an assignment may point at.
 *
 * v1 marking is staff-only (Q8), but the LINK is about who teaches: a
 * `courseTeacher` row whose `teacherId` names a non-teacher account is a row no
 * teacher-facing surface can resolve, so the route refuses it instead of storing
 * it. The list is an allow-list so an unknown or absent role is refused too.
 */
export const COURSE_TEACHER_ASSIGNEE_ROLES = ["TEACHER"] as const;

export type CourseTeacherAssigneeRole = (typeof COURSE_TEACHER_ASSIGNEE_ROLES)[number];

const ASSIGNEE_ROLE_SET: ReadonlySet<string> = new Set(COURSE_TEACHER_ASSIGNEE_ROLES);

/** May this account role be named as a course's teacher? (strict allow-list) */
export function isAssignableTeacherRole(role: unknown): role is CourseTeacherAssigneeRole {
  return typeof role === "string" && ASSIGNEE_ROLE_SET.has(role);
}

/**
 * The id of the one row that records "this teacher teaches this course".
 *
 * Both halves are the documents' own ids, so the same pair always derives the
 * same row and a re-assign is an idempotent no-op instead of a second row. The
 * shape mirrors the store's other derived keys (`a_<studentId>_<date>`,
 * `m_<examId>_<studentId>_<subjectId>`, `cf_<…>`): a readable prefix and the
 * identity's parts, in a fixed order, joined by `_`.
 *
 * Ids are opaque strings that never contain `_` collisions in this store — a
 * document id is either the shim's `r_<hex>` or another derived id whose own
 * parts are separated by the same character — so the pair is unambiguous for any
 * two ids the API can receive. Both halves are REQUIRED: an empty half would
 * derive an id shared by every caller that left it empty.
 */
export function courseTeacherId(courseId: unknown, teacherId: unknown): string {
  const course = String(courseId ?? "").trim();
  const teacher = String(teacherId ?? "").trim();
  if (!course || !teacher) {
    throw new Error("courseTeacherId requires both a course id and a teacher id.");
  }
  return `${COURSE_TEACHER_ID_PREFIX}${course}_${teacher}`;
}

/**
 * Normalise a caller-supplied list of teacher ids: trim, drop empties, drop
 * duplicates, keep the first-seen order.
 *
 * Used for the read/report shapes a caller assembles in memory (never as an
 * authorization decision): a duplicated id must not read as two teachers, and a
 * blank entry is a typo, not an id.
 */
export function normaliseTeacherIds(value: unknown): string[] {
  const list = Array.isArray(value) ? value : [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of list) {
    const id = String(raw ?? "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** The refusal a caller receives for naming a non-teacher account as a teacher. */
export const COURSE_TEACHER_ASSIGNEE_REFUSAL =
  "A course teacher must be a teacher account of this school.";

/**
 * The refusal the course DELETE returns while a teacher is still assigned.
 *
 * A link row without its course means nothing and nothing else would clean it
 * up, so the course cannot be removed underneath it — the same shape as the
 * programme-mapping and registration guards that already block that DELETE.
 */
export const COURSE_TEACHER_DELETE_BLOCK =
  "Cannot delete a course that still has a teacher assigned. Remove the assignment first.";
