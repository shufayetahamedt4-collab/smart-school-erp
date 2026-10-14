import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";
import { notifyGuardianOfStudent } from "@/lib/notify";
import {
  COURSE_ATTENDANCE_ROSTER_REFUSAL,
  COURSE_ATTENDANCE_SLOT_REFUSAL,
  COURSE_ATTENDANCE_STATUS_REFUSAL,
  COURSE_ATTENDANCE_UNMARKED,
  courseAttendanceId,
  isCourseAttendanceStatus,
  readCourseAttendanceSlot,
  shouldNotifyAbsence,
} from "@/lib/college-attendance";
import {
  ATTENDANCE_COURSE_REQUIRED,
  ATTENDANCE_DATE_REQUIRED,
  approvedRosterFor,
  readString,
  requireCollegeAttendanceRead,
  requireCollegeAttendanceWrite,
  sessionDateFor,
  storedRowsForSession,
  summariseAttendance,
  targetSchoolId,
} from "@/lib/college-attendance-server";

/**
 * College attendance — the course REGISTER (Phase 8 ca-3, docs/COLLEGE-DECISIONS.md
 * §24.8, D-CA-1…D-CA-3; owner's answers Q7/Q8). Two operations on ONE segment:
 *
 *   - `GET /api/course-attendance?courseId=&date=&slot=` — the session's register:
 *     the course's APPROVED roster (D-CA-2, resolved server-side, so a client-sent
 *     student list cannot widen it) with each student's stored status, or
 *     `UNMARKED` when no row exists yet. The slot is part of the identity (Q7):
 *     absent = 1, so a second session of the same course on the same day is a
 *     different register.
 *   - `POST /api/course-attendance` — save a session: `{ courseId, date, slot,
 *     rows: [{ studentId, status, remark }] }`. Every row is addressed by the
 *     derived id `ca_<courseId>_<dateKey>_<slot>_<studentId>` (D-CA-1), so a
 *     re-saved or corrected register upserts ONE row per student instead of
 *     appending; the whole request is validated BEFORE any write (an unapproved
 *     student, an unknown status or a duplicated student writes NOTHING), and the
 *     batch is one `$transaction`. `UNMARKED` is skipped, never stored — the
 *     school's own register filter, reused verbatim.
 *
 * The save notifies ONLY a NEW absence (D-CA-3): the guardian path is the
 * school's own `notifyGuardianOfStudent`, fire-and-forget, and the copy names the
 * course and the slot instead of a class. A re-saved or corrected register never
 * re-mails a family. No family-facing page exists yet (the register screen is
 * ca-4 and is staff-facing), so the notification carries no link.
 *
 * Guard order in EVERY handler (proved by `scripts/verify-college-routes.mjs`):
 *   1. session                          → 401
 *   2. target tenant schoolId           → 400  (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId)         → 403  FIRST authorization check, on the TARGET tenant
 *   4. the ca-0 allow-list              → 403  (READ = admin-level + REGISTRAR; WRITE = admin-level)
 *   5. required parameters              → 400  (course, date, rows[])
 *   6. writeGuard(schoolId)             → 402  (the save only)
 *   7. the course, IN THIS TENANT and in a branch the caller can reach → else 404
 *      (a foreign or another branch's id behaves as NOT FOUND — never a 403 that
 *      would confirm the row exists)
 *   8. the roster, then the rows       → 400 by name (unapproved student, unknown
 *      status, duplicate student) — before ANY write
 *   9. one transaction, then audit, cache invalidation and the new-absence notify.
 */

/** The message a malformed `rows` receives (the school register's own wording). */
const ROWS_REQUIRED = "date and rows[] are required.";

/** The message a payload naming the same student twice receives. */
const DUPLICATE_STUDENT = "Each student may appear once in a session save.";

export async function GET(req: NextRequest) {
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. the attendance READ allow-list (ca-0)
  const denied = requireCollegeAttendanceRead(session);
  if (denied) return denied;

  // 5. the session's parameters
  const courseId = readString(req.nextUrl.searchParams.get("courseId"));
  if (!courseId) return NextResponse.json({ error: ATTENDANCE_COURSE_REQUIRED }, { status: 400 });
  const when = sessionDateFor(req.nextUrl.searchParams.get("date"));
  if (!when) return NextResponse.json({ error: ATTENDANCE_DATE_REQUIRED }, { status: 400 });
  const slot = readCourseAttendanceSlot(req.nextUrl.searchParams.get("slot"));
  if (slot === null) return NextResponse.json({ error: COURSE_ATTENDANCE_SLOT_REFUSAL }, { status: 400 });

  // 7. the course must exist IN THIS TENANT, in a branch this caller may touch —
  // a foreign or another branch's course is NOT FOUND.
  const course: any = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || course.schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  if (!canAccessBranch(session, course.branchId)) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  // 8. the roster (D-CA-2) and what is already stored for this session.
  const { studentIds, registrationByStudent } = await approvedRosterFor(schoolId, courseId);
  const students: any[] = studentIds.length
    ? ((await prisma.student.findMany({ where: { schoolId, id: { in: studentIds } } })) as any[])
    : [];
  const studentById = new Map<string, any>(students.map((s) => [String(s.id), s]));
  const stored = await storedRowsForSession(schoolId, courseId, when.dateKey, slot);

  const rows = studentIds
    .map((studentId) => {
      const registration = registrationByStudent.get(studentId) || null;
      const student = studentById.get(studentId) || null;
      const storedRow = stored.get(studentId) || null;
      return {
        studentId,
        registrationId: registration?.id ?? null,
        programId: registration?.programId ?? null,
        termNumber: registration?.termNumber ?? null,
        name: student?.name ?? null,
        admissionNo: student?.admissionNo ?? null,
        status:
          storedRow && isCourseAttendanceStatus(storedRow.status)
            ? (storedRow.status as string)
            : COURSE_ATTENDANCE_UNMARKED,
        remark: typeof storedRow?.remark === "string" ? storedRow.remark : "",
        markedById: storedRow?.markedById ?? null,
      };
    })
    // The store's registration order is not meaningful to a reader; the alphabet is.
    .sort((a, b) => String(a.name || a.studentId).localeCompare(String(b.name || b.studentId)));

  return NextResponse.json({
    data: {
      courseId,
      course: {
        id: String(course.id),
        code: course.code ?? null,
        title: course.title ?? null,
        creditHours: course.creditHours ?? null,
        branchId: course.branchId ?? null,
      },
      dateKey: when.dateKey,
      slot,
      rows,
      summary: summariseAttendance(rows.map((row) => row.status)),
    },
  });
}

export async function POST(req: NextRequest) {
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. the attendance WRITE allow-list (ca-0) — the REGISTRAR reads, never marks
  const denied = requireCollegeAttendanceWrite(session);
  if (denied) return denied;

  // 5. the request's shape
  const body = await req.json().catch(() => null);
  const courseId = readString(body?.courseId);
  if (!courseId) return NextResponse.json({ error: ATTENDANCE_COURSE_REQUIRED }, { status: 400 });
  if (!Array.isArray(body?.rows)) {
    return NextResponse.json({ error: ROWS_REQUIRED }, { status: 400 });
  }
  const when = sessionDateFor(body?.date);
  if (!when) return NextResponse.json({ error: ATTENDANCE_DATE_REQUIRED }, { status: 400 });
  const slot = readCourseAttendanceSlot(body?.slot);
  if (slot === null) return NextResponse.json({ error: COURSE_ATTENDANCE_SLOT_REFUSAL }, { status: 400 });

  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. the course, confined to the tenant and to a branch the caller may touch.
  const course: any = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || course.schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  if (!canAccessBranch(session, course.branchId)) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }

  // 8. VALIDATE EVERY ROW BEFORE ANY WRITE. The roster is resolved here, so a row
  // for a student without an APPROVED registration is refused by name; an unknown
  // status is refused; a student named twice is refused because two statuses for
  // one pupil is not a register. `UNMARKED` is a read-only placeholder and is
  // skipped, exactly as the school's own POST filters it.
  const { studentIds, registrationByStudent } = await approvedRosterFor(schoolId, courseId);
  const rosterSet = new Set(studentIds);
  const seen = new Set<string>();
  const wanted: { studentId: string; status: string; remark: string | null; registration: any }[] = [];
  for (const raw of body.rows) {
    const studentId = readString(raw?.studentId);
    if (!studentId || !rosterSet.has(studentId)) {
      return NextResponse.json({ error: COURSE_ATTENDANCE_ROSTER_REFUSAL }, { status: 400 });
    }
    if (seen.has(studentId)) {
      return NextResponse.json({ error: DUPLICATE_STUDENT }, { status: 400 });
    }
    seen.add(studentId);
    const status = raw?.status;
    if (status === COURSE_ATTENDANCE_UNMARKED) continue; // never stored
    if (!isCourseAttendanceStatus(status)) {
      return NextResponse.json({ error: COURSE_ATTENDANCE_STATUS_REFUSAL }, { status: 400 });
    }
    wanted.push({
      studentId,
      status,
      remark: typeof raw?.remark === "string" && raw.remark.trim() ? raw.remark.trim() : null,
      registration: registrationByStudent.get(studentId) || null,
    });
  }

  // The stored register for THIS session, read before the write: a re-saved row
  // compares against what was already recorded, which is what keeps a family from
  // being mailed twice.
  const stored = await storedRowsForSession(schoolId, courseId, when.dateKey, slot);

  const written = wanted.map((row) => {
    const id = courseAttendanceId(courseId, when.dateKey, slot, row.studentId);
    const registration = row.registration;
    return {
      id,
      studentId: row.studentId,
      status: row.status,
      /** The row's identity and its immutable stamps (created on first save). */
      base: {
        schoolId,
        // Inherited from the COURSE, like `courseTeacher` and a registration's
        // branch — so scopeWhere/canAccessBranch filter the row directly.
        branchId: course.branchId || null,
        courseId,
        programId: registration?.programId ?? null,
        termNumber: registration?.termNumber ?? null,
        sessionDate: when.date,
        slot,
        studentId: row.studentId,
        status: row.status,
        remark: row.remark,
        markedById: session.id,
        registrationId: registration?.id ?? null,
      },
    };
  });

  // 9. ONE transaction: the shim's `idFor` honours `where.id`, so the derived id
  // IS the identity and a re-save is a merge over the same row — never a second
  // one.
  await prisma.$transaction(
    written.map((row) =>
      prisma.courseAttendance.upsert({
        where: { id: row.id },
        create: row.base,
        update: {
          status: row.base.status,
          remark: row.base.remark,
          markedById: session.id,
          branchId: row.base.branchId,
          programId: row.base.programId,
          termNumber: row.base.termNumber,
          registrationId: row.base.registrationId,
        },
      })
    )
  );

  // Only a NEW absence notifies (D-CA-3) — the school's own rule, applied to the
  // stored row this save replaced.
  const newlyAbsent = written
    .filter((row) => shouldNotifyAbsence(stored.get(row.studentId)?.status, row.status))
    .map((row) => row.studentId);

  await audit("COURSE_ATTENDANCE_SAVE", "courseAttendance", `${courseId}_${when.dateKey}_${slot}`, {
    schoolId,
    courseId,
    dateKey: when.dateKey,
    slot,
    rows: written.length,
    skipped: body.rows.length - wanted.length,
    newlyAbsent,
  });
  invalidateStats(schoolId, "attendance");
  invalidateReferenceCache(schoolId);

  if (newlyAbsent.length) {
    const kids: any[] = (await prisma.student.findMany({
      where: { schoolId, id: { in: newlyAbsent } },
    })) as any[];
    const nameOf = new Map((kids as any[]).map((s) => [String(s.id), s.name]));
    const courseLabel = course.title || course.code || "The course";
    await Promise.all(
      newlyAbsent.map((studentId) =>
        notifyGuardianOfStudent(schoolId, studentId, {
          event: "ATTENDANCE_PUBLISHED",
          title: `${nameOf.get(studentId) || "Your child"} was marked absent`,
          // D-CA-3's ONE legitimate difference from the school's register: the
          // copy names the COURSE and the slot instead of a class.
          body: `${courseLabel} (slot ${slot}) on ${when.dateKey} records an absence.`,
        }).catch(() => null)
      )
    );
  }

  return NextResponse.json({
    data: {
      ok: true,
      courseId,
      dateKey: when.dateKey,
      slot,
      written: written.length,
      skipped: body.rows.length - wanted.length,
      newlyAbsent,
      summary: summariseAttendance(written.map((row) => row.status)),
    },
  });
}
