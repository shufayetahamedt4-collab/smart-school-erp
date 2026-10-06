import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can, isBranchScoped } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";

/**
 * POST /api/import/students/[batchId]/undo
 *
 * Rolls back the STUDENTS this batch created and nothing else. It deliberately
 * does NOT delete any guardian account: a guardian may be shared with siblings
 * in this import or with students outside it, so removing it would strand data
 * that is not the import's to remove. Only students whose document still carries
 * the batch's own deterministic qr token are removed, so a record that was
 * since replaced by hand is left alone.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role) || !can(session.role, "admission", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const { batchId } = await params;
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } }).catch(() => null);
  if (!batch || batch.schoolId !== schoolId) return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  // Branch scoping (PRD §12.3): a branch admin can only undo its own branch's
  // import, never another branch's.
  if (isBranchScoped(session) && batch.branchId !== session.branchId) {
    return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  }
  if (batch.status === "UNDONE") return NextResponse.json({ data: { removedStudents: 0, alreadyUndone: true } });

  const rows = (await prisma.importBatchRow.findMany({ where: { batchId } })).filter((r: any) => r.schoolId === schoolId);
  let removed = 0;

  for (const row of rows as any[]) {
    if (row.status !== "OK" || !row.studentId) continue;
    const student = await prisma.student.findUnique({ where: { id: row.studentId } }).catch(() => null);
    if (!student || student.schoolId !== schoolId) continue;
    // Only remove the exact record this import created.
    if (row.qrToken && student.qrToken !== row.qrToken) continue;
    await prisma.fee.deleteMany({ where: { studentId: student.id } });
    await prisma.student.delete({ where: { id: student.id } });
    removed++;
  }

  await prisma.importBatch.update({
    where: { id: batch.id },
    data: { status: "UNDONE", undoneAt: new Date(), updatedAt: new Date(), undoneStudents: removed },
  });

  invalidateReferenceCache(schoolId);
  invalidateStats(schoolId, "students");
  await audit("STUDENT_IMPORT_UNDO", "importBatch", batch.id, { removedStudents: removed });

  // Guardians, families and reused accounts are intentionally left intact.
  return NextResponse.json({ data: { removedStudents: removed, guardiansKept: true } });
}
