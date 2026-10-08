import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import {
  isDecisionStatus,
  canDecideRegistration,
  canWithdrawRegistration,
} from "@/lib/registration-status";

/**
 * College support (Phase 4b) — read, decide and withdraw ONE registration.
 *
 *   GET    → the row, joined with its course/student/programme (a dangling
 *            course is shown as unavailable, never a crash).
 *   PATCH  → decide: `{ status: "APPROVED" | "REJECTED" }`. Only a PENDING row
 *            can be decided; APPROVED and REJECTED are terminal.
 *   DELETE → withdraw: only a PENDING row may be removed.
 *
 * Guard order in EVERY handler:
 *   1. session                        → 401
 *   2. target tenant schoolId         → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId)       → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "registration", …)   → 403
 *   5. id present                     → 400
 *   6. writeGuard(schoolId)           → 402   (mutations only)
 *   7. load row by id AND row.schoolId === schoolId → else 404
 *      (a foreign/another-tenant id must behave as NOT FOUND, never as a 403
 *       oracle that confirms the row exists)
 *   8. canAccessBranch(row.branchId)  → 403
 *   9. status rules: a PENDING row only (decide/withdraw); a decided row is 409
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

/**
 * Join one registration with its course/student/programme. A course deleted after
 * its mapping was removed can still be referenced by a REJECTED row, so a missing
 * course is reported as unavailable rather than raising.
 */
async function enrich(row: any): Promise<any> {
  const [course, student, program] = await Promise.all([
    row.courseId ? prisma.course.findUnique({ where: { id: row.courseId } }) : null,
    row.studentId ? prisma.student.findUnique({ where: { id: row.studentId } }) : null,
    row.programId ? prisma.program.findUnique({ where: { id: row.programId } }) : null,
  ]);
  return {
    ...row,
    courseCode: (course as any)?.code ?? null,
    courseTitle: (course as any)?.title ?? null,
    creditHours: (course as any)?.creditHours ?? null,
    courseAvailable: !!course,
    studentName: (student as any)?.name ?? null,
    studentAdmissionNo: (student as any)?.admissionNo ?? null,
    programName: (program as any)?.name ?? null,
  };
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
  if (!can(session.role, "registration", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // 7. load and confine to the target tenant — a foreign id is NOT FOUND.
  const row = await prisma.courseRegistration.findUnique({ where: { id } });
  if (!row || (row as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, (row as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  return NextResponse.json({ data: await enrich(row) });
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
  if (!can(session.role, "registration", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. load and confine to the target tenant — a foreign id is NOT FOUND.
  const row = await prisma.courseRegistration.findUnique({ where: { id } });
  if (!row || (row as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, (row as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const status = readString(body?.status);
  // The decision must be exactly APPROVED or REJECTED.
  if (!isDecisionStatus(status)) {
    return NextResponse.json(
      { error: "status must be one of: APPROVED, REJECTED." },
      { status: 400 }
    );
  }
  // 9. Only a PENDING row can be decided; a decided row is terminal.
  if (!canDecideRegistration((row as any).status)) {
    return NextResponse.json(
      { error: "This registration has already been decided." },
      { status: 409 }
    );
  }

  const updated = await prisma.courseRegistration.update({
    where: { id },
    data: { status, decidedById: session.id, decidedAt: new Date() },
  });
  await audit("REGISTRATION_DECIDE", "courseRegistration", id, { schoolId, status });
  return NextResponse.json({ data: updated });
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
  if (!can(session.role, "registration", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. load and confine to the target tenant — a foreign id is NOT FOUND.
  const row = await prisma.courseRegistration.findUnique({ where: { id } });
  if (!row || (row as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Registration not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, (row as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // 9. Only a PENDING row can be withdrawn — a decided row is terminal.
  if (!canWithdrawRegistration((row as any).status)) {
    return NextResponse.json(
      { error: "Only a pending registration can be withdrawn." },
      { status: 409 }
    );
  }

  await prisma.courseRegistration.delete({ where: { id } });
  await audit("REGISTRATION_WITHDRAW", "courseRegistration", id, { schoolId });
  return NextResponse.json({ data: { ok: true } });
}
