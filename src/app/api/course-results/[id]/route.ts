import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import {
  finiteNumber,
  loadCollegeScheme,
  retakeOf,
  schemeView,
  serveResultRow,
  type ServedResultRow,
} from "@/lib/college-results-server";

/**
 * College support (Phase 6c) — read, re-mark and delete ONE college result.
 *
 *   GET    → the row with its grade DERIVED under the tenant's current scheme
 *            (D-6-12), joined with its course/student/programme. A course deleted
 *            after its mappings were removed is reported as unavailable, not a
 *            crash.
 *   PATCH  → re-record the marks (`obtained` and/or `fullMarks`). The attempt
 *            number, the term and the identity of the row are immutable: they are
 *            what `(studentId, courseId, termNumber, attempt)` means.
 *   DELETE → remove the attempt.
 *
 * Guard order in EVERY handler:
 *   1. session                        → 401
 *   2. target tenant schoolId         → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId)       → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "attendanceMarks", …) → 403  (Q5: the grading-scheme module, reused)
 *   5. id present                     → 400
 *   6. writeGuard(schoolId)           → 402   (mutations only)
 *   7. load by id AND row.schoolId === schoolId → else 404
 *      (a foreign id must behave as NOT FOUND — never a 403 oracle that confirms
 *       the row exists in another tenant)
 *   8. canAccessBranch(row.branchId)  → 403
 */

/** The tenant this request targets — the SUPER_ADMIN's `?schoolId=`, else the session's own. */
function targetSchoolId(
  session: { role: string; schoolId: string | null },
  req: NextRequest
): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

/** Join one result row with its course/student/programme (a missing course is reported, not raised). */
async function enrichOne(row: any, scheme: any): Promise<ServedResultRow> {
  const [course, student, program] = await Promise.all([
    row.courseId ? prisma.course.findUnique({ where: { id: row.courseId } }) : null,
    row.studentId ? prisma.student.findUnique({ where: { id: row.studentId } }) : null,
    row.programId ? prisma.program.findUnique({ where: { id: row.programId } }) : null,
  ]);
  return serveResultRow(scheme, row, { course, student, program });
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
  // 4. permission
  if (!can(session.role, "attendanceMarks", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // 7. load and confine to the target tenant — a foreign id is NOT FOUND.
  const row: any = await prisma.courseResult.findUnique({ where: { id } });
  if (!row || row.schoolId !== schoolId) {
    return NextResponse.json({ error: "Result not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, row.branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const scheme = await loadCollegeScheme(schoolId, row.programId);
  return NextResponse.json({
    data: await enrichOne(row, scheme),
    scheme: schemeView(scheme),
    retake: retakeOf(scheme),
  });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  if (!can(session.role, "attendanceMarks", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. load and confine to the target tenant — a foreign id is NOT FOUND.
  const row: any = await prisma.courseResult.findUnique({ where: { id } });
  if (!row || row.schoolId !== schoolId) {
    return NextResponse.json({ error: "Result not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, row.branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const hasObtained = body?.obtained !== undefined && body?.obtained !== null;
  const hasFull = body?.fullMarks !== undefined && body?.fullMarks !== null;
  if (!hasObtained && !hasFull) {
    return NextResponse.json({ error: "Supply obtained and/or fullMarks." }, { status: 400 });
  }

  const obtained = hasObtained ? finiteNumber(body.obtained) : finiteNumber(row.obtained);
  const fullMarks = hasFull ? finiteNumber(body.fullMarks) : finiteNumber(row.fullMarks);
  if (obtained === null || obtained < 0) {
    return NextResponse.json({ error: "obtained must be a number of 0 or more." }, { status: 400 });
  }
  if (fullMarks === null || fullMarks <= 0) {
    return NextResponse.json({ error: "fullMarks must be a number greater than 0." }, { status: 400 });
  }
  if (obtained > fullMarks) {
    return NextResponse.json({ error: "obtained cannot be greater than fullMarks." }, { status: 400 });
  }

  const updated = await prisma.courseResult.update({
    where: { id },
    data: { obtained, fullMarks, recordedById: session.id },
  });
  await audit("RESULT_UPDATE", "courseResult", id, { schoolId, obtained, fullMarks });
  const scheme = await loadCollegeScheme(schoolId, row.programId);
  return NextResponse.json({ data: await enrichOne(updated, scheme) });
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
  if (!can(session.role, "attendanceMarks", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. load and confine to the target tenant — a foreign id is NOT FOUND.
  const row: any = await prisma.courseResult.findUnique({ where: { id } });
  if (!row || row.schoolId !== schoolId) {
    return NextResponse.json({ error: "Result not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, row.branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  await prisma.courseResult.delete({ where: { id } });
  await audit("RESULT_DELETE", "courseResult", id, { schoolId, studentId: row.studentId, courseId: row.courseId });
  return NextResponse.json({ data: { ok: true } });
}
