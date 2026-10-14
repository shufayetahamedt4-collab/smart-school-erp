import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import {
  courseTeacherId,
  isAssignableTeacherRole,
  COURSE_TEACHER_ASSIGNEE_REFUSAL,
} from "@/lib/course-teachers";

/**
 * Phase 8-pre — the course↔teacher link (docs/COLLEGE-DECISIONS.md §24.8,
 * D-CA-4, owner's answer Q8 2026-10-11).
 *
 * Before this route the college could not answer "who teaches this course?":
 * there was no `teacherId` anywhere under `src/app/api/courses`,
 * `src/app/api/course-registrations` or `src/lib/college-*.ts`. This is the
 * admin-facing half of the link — list / assign / remove the teachers of ONE
 * course — and it is the step the owner's ruling put FIRST in Phase 8, because
 * both teacher-facing college surfaces (a teacher marking their own course
 * register, and the post-v1 per-course teacher view of results) are blocked on
 * it. The register itself is ca-1..ca-4; **nothing here marks or reads
 * attendance, and no teacher-facing read is added yet** (v1 marking stays
 * staff-only until the register exists).
 *
 * A row is addressed by a DETERMINISTIC id derived from the pair
 * (`ct_<courseId>_<teacherId>`, `src/lib/course-teachers.ts`), so assigning the
 * same teacher twice addresses the same row and is an idempotent no-op instead
 * of a duplicate. That is why `COLS.courseTeacher` has no `idFor` entry: the id
 * is supplied here.
 *
 * Guard order in EVERY handler (the college routes' order — `courses` is a
 * listed college segment, so `scripts/verify-college-routes.mjs` proves the gate
 * comes first):
 *   1. session                  → 401
 *   2. target tenant schoolId   → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId) → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "courses", …)  → 403   (view for the read, full for the writes)
 *   5. id present               → 400
 *   6. writeGuard(schoolId)      → 402   (mutations only)
 *   7. load the course by id AND require row.schoolId === schoolId → else 404
 *      (a foreign/another-tenant id behaves as NOT FOUND, never as a 403 oracle)
 *   8. canAccessBranch(row.branchId) → 403
 *   9. the named account must be a TEACHER of THIS tenant, in a branch this
 *      caller may touch — anything else is a counted 400, never a stored row
 *  10. the assignment is idempotent: an existing row answers 200 and writes
 *      nothing; a new one writes once, audits once and invalidates.
 *
 * The link is a college row, so the same tenant + branch confinement the fee and
 * result rows use applies: a course from another tenant is a 404, and a branch
 * admin cannot attach a teacher of another branch.
 */

/** The tenant this request targets — the SUPER_ADMIN's `?schoolId=`, else the session's own. */
function targetSchoolId(
  session: { role: string; schoolId: string | null },
  req: NextRequest
): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

function readString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission — the read is the same `courses` view its sibling routes use
  if (!can(session.role, "courses", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // 7. the course must exist IN THIS TENANT — a foreign id is NOT FOUND.
  const course = await prisma.course.findUnique({ where: { id } });
  if (!course || (course as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, (course as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The rows are ONE tenant-scoped read (the store cannot join), and the display
  // names come from the users the rows already name — never from a per-row read.
  const rows = (await prisma.courseTeacher.findMany({ where: { schoolId, courseId: id } })) as any[];
  const userIds = Array.from(new Set(rows.map((r) => r.teacherUserId).filter(Boolean)));
  const users = userIds.length
    ? ((await prisma.user.findMany({
        where: { schoolId },
        select: { id: true, name: true, email: true },
      })) as any[])
    : [];
  const userById = new Map<string, any>(users.map((u) => [u.id, u]));

  const data = rows
    .map((r) => {
      const user = userById.get(r.teacherUserId) || null;
      return {
        id: r.id,
        courseId: r.courseId,
        teacherId: r.teacherId,
        teacherUserId: r.teacherUserId || null,
        name: user?.name || null,
        email: user?.email || null,
        branchId: r.branchId ?? null,
        assignedAt: r.assignedAt ?? null,
        assignedById: r.assignedById ?? null,
      };
    })
    // Teacher id order is the store's own id order, which is not meaningful to a
    // reader; the alphabet is. Same tie-break rule the course list uses on `code`.
    .sort((a, b) => String(a.name || a.teacherId).localeCompare(String(b.name || b.teacherId)));

  return NextResponse.json({ data });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission — assigning a teacher is a catalogue write, like editing the course
  if (!can(session.role, "courses", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. the course, confined to the tenant
  const course = await prisma.course.findUnique({ where: { id } });
  if (!course || (course as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, (course as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const teacherId = readString(body?.teacherId);
  if (!teacherId) {
    return NextResponse.json({ error: "A teacher is required." }, { status: 400 });
  }

  // 9. the teacher must be ONE OF THIS TENANT'S TEACHERS, and its account must
  // carry the TEACHER role. A missing/foreign teacher id is a 400 with the same
  // sentence (never a 404 that would confirm another tenant's row exists), and a
  // non-teacher account is refused by NAME of the rule rather than stored as a
  // row no teacher-facing surface could resolve.
  const teacher = await prisma.teacher.findUnique({ where: { id: teacherId } });
  if (!teacher || (teacher as any).schoolId !== schoolId) {
    return NextResponse.json({ error: COURSE_TEACHER_ASSIGNEE_REFUSAL }, { status: 400 });
  }
  if (!canAccessBranch(session, (teacher as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const user = (teacher as any).userId
    ? ((await prisma.user.findUnique({ where: { id: (teacher as any).userId } })) as any)
    : null;
  if (!user || user.schoolId !== schoolId || !isAssignableTeacherRole(user.role)) {
    return NextResponse.json({ error: COURSE_TEACHER_ASSIGNEE_REFUSAL }, { status: 400 });
  }

  // 10. idempotence: the derived id IS the uniqueness rule, so a re-assign reads
  // the row it would have written and writes nothing.
  const rowId = courseTeacherId(id, teacherId);
  const existing = (await prisma.courseTeacher.findUnique({ where: { id: rowId } })) as any;
  if (existing) {
    return NextResponse.json({ data: existing, already: true });
  }

  const created = await prisma.courseTeacher.create({
    data: {
      id: rowId,
      schoolId,
      // Inherited from the COURSE, exactly as a registration inherits its
      // programme's branch, so scopeWhere/canAccessBranch filter the row directly.
      branchId: (course as any).branchId || null,
      courseId: id,
      teacherId,
      teacherUserId: (teacher as any).userId || null,
      assignedById: session.id,
      assignedAt: new Date().toISOString(),
    },
  });
  await audit("COURSE_TEACHER_ASSIGN", "courseTeacher", rowId, {
    schoolId,
    courseId: id,
    teacherId,
  });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: created }, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission
  if (!can(session.role, "courses", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. the course, confined to the tenant
  const course = await prisma.course.findUnique({ where: { id } });
  if (!course || (course as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, (course as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const teacherId = readString(req.nextUrl.searchParams.get("teacherId") || "");
  if (!teacherId) {
    return NextResponse.json({ error: "A teacher is required." }, { status: 400 });
  }

  // 9. the row must exist, IN THIS TENANT's course — a teacher who is not
  // assigned here is NOT FOUND, not a silent success.
  const rowId = courseTeacherId(id, teacherId);
  const row = (await prisma.courseTeacher.findUnique({ where: { id: rowId } })) as any;
  if (!row || row.schoolId !== schoolId || row.courseId !== id) {
    return NextResponse.json(
      { error: "That teacher is not assigned to this course." },
      { status: 404 }
    );
  }

  await prisma.courseTeacher.delete({ where: { id: rowId } });
  await audit("COURSE_TEACHER_UNASSIGN", "courseTeacher", rowId, {
    schoolId,
    courseId: id,
    teacherId,
  });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: { ok: true } });
}
