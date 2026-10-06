import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can, isBranchScoped } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";

/**
 * POST /api/students/[id]/lifecycle — transfer / withdraw / restore (Phase 6).
 *
 * The smallest safe lifecycle action: it changes ONLY `status` (plus the
 * recorded reason / effective date), never deletes the student and never touches
 * guardian or family links. A TRANSFER or WITHDRAW sets `status = "TRANSFERRED"`,
 * which `ON_ROLL_STUDENT` already excludes — so the student disappears from
 * on-roll lists (promotion, attendance registers, sibling lists) while every
 * historical record and the guardian account stay intact. RESTORE returns the
 * student to `ACTIVE`.
 *
 * Authorization: SCHOOL_ADMIN (whole school) and BRANCH_ADMIN (own branch only),
 * via the shared `studentTeacherInfo` permission and `isBranchScoped`. TEACHER /
 * GUARDIAN are refused; `schoolId` always comes from the session.
 */

const ACTIONS = ["TRANSFER", "WITHDRAW", "RESTORE"] as const;
type Action = (typeof ACTIONS)[number];

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "studentTeacherInfo", "full")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const { id } = await params;
  const student = await prisma.student.findUnique({ where: { id } }).catch(() => null);
  if (!student || student.schoolId !== schoolId) return NextResponse.json({ error: "Student not found" }, { status: 404 });
  // Branch scoping: a branch admin can only act on its own branch's students.
  if (isBranchScoped(session) && student.branchId !== session.branchId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const action = String(body?.action || "").toUpperCase() as Action;
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ error: "action must be TRANSFER, WITHDRAW or RESTORE." }, { status: 400 });
  }

  const reason = body?.reason ? String(body.reason).trim() : null;
  const effectiveDate = body?.effectiveDate ? new Date(String(body.effectiveDate)) : null;
  if (effectiveDate && Number.isNaN(effectiveDate.getTime())) {
    return NextResponse.json({ error: "Invalid effective date." }, { status: 400 });
  }

  const data: Record<string, any> =
    action === "RESTORE"
      ? { status: "ACTIVE", lifecycleReason: null, lifecycleEffectiveDate: null }
      : { status: "TRANSFERRED", lifecycleAction: action, lifecycleReason: reason, lifecycleEffectiveDate: effectiveDate };

  const updated = await prisma.student.update({ where: { id }, data });
  await audit(action === "RESTORE" ? "STUDENT_RESTORE" : "STUDENT_TRANSFER", "student", id, {
    action,
    reason,
    effectiveDate: effectiveDate ? effectiveDate.toISOString() : null,
  });
  invalidateStats(schoolId, "students");
  invalidateReferenceCache(schoolId);

  return NextResponse.json({ data: { id, status: updated.status } });
}
