import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can, scopeWhere, isBranchScoped } from "@/lib/permissions";
import { resolveBranchId } from "@/lib/branches";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";
import { money } from "@/lib/utils";

/**
 * PRD §10.3 — the school's own fee heads.
 *
 * A "fee category" is whatever the school calls a charge: Weekly Exam Fee,
 * Monthly Exam Fee, Yearly Exam Fee, Tuition, Transport, Library fine, and
 * anything else they invent. Nothing here is hard-coded to a list — the admin
 * defines the catalogue. What IS constrained is the `bucket`, the accounting
 * line the money posts to in the central ledger (§10.1), and `frequency`,
 * which describes how often the charge recurs.
 *
 * The amount varies class to class, so each category carries a simple
 * `amounts` map of { classId: amount }. A class with no entry simply is not
 * billed for that category.
 *
 * Who may do what: the whole catalogue sits behind `feePayment:full` — reading
 * it exposes every class's pricing for every fee head, so it is staff-only
 * (same gate as /api/fee-templates). The matrix grants `full` to SCHOOL_ADMIN,
 * BRANCH_ADMIN and ACCOUNTANT, i.e. the main admin, a sub-school (branch) admin
 * and any staff member assigned to fees all manage the same catalogue; a
 * branch-scoped user only sees their own branch's categories plus the
 * school-wide ones. Guardians and students read their own fee rows, not this.
 */

const BUCKETS = ["TUITION", "ADMISSION", "EXAM", "TRANSPORT", "HOSTEL", "LIBRARY_FINE", "LATE_FEE", "OTHER"];
const FREQUENCIES = ["WEEKLY", "MONTHLY", "TERM", "YEARLY", "ONE_TIME"];

/** Normalise a `{ classId: amount }` payload into finite, positive numbers. */
function cleanAmounts(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [classId, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = money(v);
    if (classId && n > 0) out[classId] = n;
  }
  return out;
}

/**
 * Build the fields to write. On PATCH only the keys the caller actually sent
 * are returned, so a partial edit cannot silently reset the rest to defaults.
 */
function fields(body: any): Record<string, any> {
  const d: Record<string, any> = {};
  if (body?.name !== undefined) d.name = String(body.name).trim();
  if (body?.bucket !== undefined) d.bucket = BUCKETS.includes(body.bucket) ? body.bucket : "OTHER";
  if (body?.frequency !== undefined) d.frequency = FREQUENCIES.includes(body.frequency) ? body.frequency : "MONTHLY";
  if (body?.optional !== undefined) d.optional = !!body.optional;
  if (body?.active !== undefined) d.active = !!body.active;
  if (body?.dueDay !== undefined) d.dueDay = body.dueDay ? Math.min(28, Math.max(1, Number(body.dueDay))) : null;
  if (body?.note !== undefined) d.note = body.note ? String(body.note) : null;
  if (body?.amounts !== undefined) d.amounts = cleanAmounts(body.amounts);
  return d;
}

/** A category is visible to a branch-scoped session when it is theirs or school-wide. */
function visibleTo(session: { branchId?: string | null } & Record<string, any>, cat: any): boolean {
  if (!isBranchScoped(session as any)) return true;
  return !cat.branchId || cat.branchId === session.branchId;
}

export async function GET() {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;

  // The class list comes back with the categories so the editor can draw one
  // amount per class in a single request (and so an ACCOUNTANT, who is not
  // allowed to read /api/classes, can still see the grid).
  const [categories, classRows] = await Promise.all([
    prisma.feeCategory.findMany({ where: { schoolId } }),
    prisma.classRoom.findMany({ where: scopeWhere(session) }),
  ]);

  const classes = classRows
    .map((c: any) => ({ id: c.id, name: c.name, order: Number(c.order || 0) }))
    .sort((a: any, b: any) => a.order - b.order || String(a.name).localeCompare(String(b.name)));

  const shaped = categories
    .filter((c: any) => visibleTo(session, c))
    .map((c: any) => ({
      id: c.id,
      name: c.name,
      bucket: c.bucket || "OTHER",
      frequency: c.frequency || "MONTHLY",
      optional: !!c.optional,
      active: c.active !== false,
      dueDay: c.dueDay ?? null,
      note: c.note || null,
      branchId: c.branchId || null,
      // Never let a legacy/hand-written row leak null or a string into the UI —
      // the fees page learned that lesson the expensive way.
      amounts: cleanAmounts(c.amounts),
      createdAt: c.createdAt || null,
    }))
    .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));

  return NextResponse.json({ data: { categories: shaped, classes } });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked; // PRD §12.1 — subscription auto-lock

  const body = await req.json().catch(() => null);
  const d = fields(body);
  if (!d.name) return NextResponse.json({ error: "Give the fee a name." }, { status: 400 });
  if (!Object.keys(d.amounts || {}).length) {
    return NextResponse.json({ error: "Set the amount for at least one class." }, { status: 400 });
  }

  const branchId = await resolveBranchId(session, body?.branchId || null);
  const category = await prisma.feeCategory.create({
    data: {
      schoolId,
      branchId,
      name: d.name,
      bucket: d.bucket || "OTHER",
      frequency: d.frequency || "MONTHLY",
      optional: d.optional ?? false,
      active: d.active ?? true,
      dueDay: d.dueDay ?? null,
      note: d.note ?? null,
      amounts: d.amounts,
    },
  });
  await audit("FEE_CATEGORY_CREATE", "feeCategory", category.id, { name: d.name, branchId });
  return NextResponse.json({ data: category }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const id = body?.id;
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const existing = await prisma.feeCategory.findUnique({ where: { id } });
  if (!existing || existing.schoolId !== schoolId) {
    return NextResponse.json({ error: "Fee category not found" }, { status: 404 });
  }
  if (!visibleTo(session, existing)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const d = fields(body);
  if (d.name !== undefined && !d.name) {
    return NextResponse.json({ error: "Give the fee a name." }, { status: 400 });
  }
  if (!Object.keys(d).length) return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const updated = await prisma.feeCategory.update({ where: { id }, data: d });
  await audit("FEE_CATEGORY_UPDATE", "feeCategory", id, { fields: Object.keys(d) });
  return NextResponse.json({ data: updated });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const category = await prisma.feeCategory.findUnique({ where: { id } });
  if (!category || category.schoolId !== schoolId) {
    return NextResponse.json({ error: "Fee category not found" }, { status: 404 });
  }
  if (!visibleTo(session, category)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Fees already billed keep their own title/amount, so deleting the category
  // never rewrites history — it only stops future billing.
  await prisma.feeCategory.delete({ where: { id } });
  invalidateStats(schoolId, "all");
  await audit("FEE_CATEGORY_DELETE", "feeCategory", id, { name: category.name });
  return NextResponse.json({ data: { ok: true } });
}
