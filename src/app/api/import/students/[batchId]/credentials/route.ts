import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { can, isBranchScoped } from "@/lib/permissions";

/**
 * GET /api/import/students/[batchId]/credentials
 *
 * The guardian-access slips for one import: only the students this batch
 * CREATED whose guardian account was newly provisioned (a QR/PIN credential,
 * no password). Reused guardians (LINKED) and rows with no usable contact
 * (INCOMPLETE) are deliberately excluded — there is nothing to hand over for
 * them, and a reused account must never be re-issued a credential.
 *
 * Read-only, so it cannot affect idempotency, undo or isolation. Scoped to the
 * caller's school exactly like the sibling batch route: a batch that belongs to
 * another tenant answers 404 rather than leaking.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "admission", "view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { batchId } = await params;
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } }).catch(() => null);
  if (!batch) return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  if (session.role !== "SUPER_ADMIN" && batch.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  }
  // Branch scoping (PRD §12.3): a branch admin can only read its own branch's
  // slips, so it can never hand a guardian another branch's QR credential.
  if (isBranchScoped(session) && batch.branchId !== session.branchId) {
    return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  }

  const schoolId = batch.schoolId;
  // A rolled-back batch created nothing (its students are gone), so there is
  // nothing to hand over — return the same empty, safe shape.
  if (batch.status === "UNDONE") {
    return NextResponse.json({ data: { batchId, credentials: [] } });
  }

  // The batch's own row records are the proof a student was created by THIS
  // import; the live student document is then filtered to the provisioned
  // credential state, so a deleted (undone), reused or incomplete student can
  // never appear on a slip.
  const rows = (await prisma.importBatchRow.findMany({ where: { batchId } }))
    .filter((r: any) => r.schoolId === schoolId && r.status === "OK" && r.studentId)
    .sort((a: any, b: any) => Number(a.rowNumber) - Number(b.rowNumber));

  const studentIds = [...new Set(rows.map((r: any) => String(r.studentId)))];

  const [students, classes, sections] = await Promise.all([
    studentIds.length ? prisma.student.findMany({ where: { schoolId } }) : Promise.resolve([]),
    prisma.classRoom.findMany({ where: { schoolId } }),
    prisma.section.findMany({ where: { schoolId } }),
  ]);

  const wanted = new Set(studentIds);
  const classById = new Map((classes as any[]).map((c) => [String(c.id), c]));
  const sectionById = new Map((sections as any[]).map((s) => [String(s.id), s]));

  const credentials = (students as any[])
    .filter((s) => wanted.has(String(s.id)) && s.guardianOnboarding === "CREDENTIALS_READY")
    .map((s) => ({
      studentId: String(s.id),
      name: s.name || null,
      admissionNo: s.admissionNo || null,
      className: s.classId ? classById.get(String(s.classId))?.name || null : null,
      sectionName: s.sectionId ? sectionById.get(String(s.sectionId))?.name || null : null,
      guardianName: s.guardianName || null,
      qrToken: s.qrToken || null,
      qrPin: s.qrPin || null,
    }))
    .filter((c) => c.qrToken && c.qrPin);

  return NextResponse.json({ data: { batchId, credentials } });
}
