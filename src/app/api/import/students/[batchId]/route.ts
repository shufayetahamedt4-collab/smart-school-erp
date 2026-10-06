import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { can, isBranchScoped } from "@/lib/permissions";

/**
 * GET /api/import/students/[batchId]?level=&offset=&limit=
 *
 * The result summary for one import: the batch totals plus the per-row records
 * (row-level errors and warnings included). Scoped to the caller's school — a
 * batch that belongs to another tenant answers 404 rather than leaking.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ batchId: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "admission", "view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { batchId } = await params;
  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } }).catch(() => null);
  if (!batch) return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  if (session.role !== "SUPER_ADMIN" && batch.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  }
  // Branch scoping (PRD §12.3): a branch admin only sees batches of its own
  // branch — another branch's import is invisible, exactly like its students.
  if (isBranchScoped(session) && batch.branchId !== session.branchId) {
    return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
  }

  const sp = req.nextUrl.searchParams;
  const level = (sp.get("level") || "").toUpperCase();
  const offset = Math.max(0, Number(sp.get("offset")) || 0);
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit")) || 200));

  const all = (await prisma.importBatchRow.findMany({ where: { batchId } }))
    .filter((r: any) => r.schoolId === batch.schoolId)
    .sort((a: any, b: any) => Number(a.rowNumber) - Number(b.rowNumber));

  const counts = {
    total: all.length,
    ok: all.filter((r: any) => r.status === "OK").length,
    skipped: all.filter((r: any) => r.status === "SKIPPED").length,
    errors: all.filter((r: any) => r.status === "ERROR").length,
    warnings: all.filter((r: any) => (r.messages || []).some((m: any) => m.level === "WARNING")).length,
  };

  const filtered = level ? all.filter((r: any) => (level === "WARNING" ? (r.messages || []).some((m: any) => m.level === "WARNING") : r.status === level)) : all;
  const rows = filtered.slice(offset, offset + limit);

  return NextResponse.json({ data: { batch, counts, rows, offset, limit, filteredTotal: filtered.length } });
}
