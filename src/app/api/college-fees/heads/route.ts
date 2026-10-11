import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { resolveBranchId } from "@/lib/branches";
import { validateCollegeFeeHead } from "@/lib/college-fees";
import {
  loadHeads,
  requireCollegeFeesRead,
  requireCollegeFeesWrite,
  serveHead,
  targetSchoolId,
} from "@/lib/college-fees-server";

/**
 * College support (Phase 7c) — the college FEE HEAD (collection `collegeFeeHead`),
 * route `/api/college-fees/heads`.
 *
 * A college head is the school's `feeCategory` shape MINUS the class pricing
 * (D-7-2): a name, the same eight buckets and five cadences, `optional`, `active`,
 * `dueDay`, `note`, and the `branchId` every college row inherits. The AMOUNT is
 * not here — it lives in the structure (D-7-6), because the same head costs
 * different money in different programmes and terms.
 *
 * Guard order in EVERY handler (D-7-18, the results routes' order):
 *   1. session                              → 401
 *   2. target tenant schoolId               → 400   (SUPER_ADMIN: ?schoolId=, else session.schoolId)
 *   3. requireCollege({ schoolId })         → 403   FIRST authorization check, on the TARGET tenant
 *   4. the college fee allow-list           → 403   (read: + REGISTRAR; write: admin + ACCOUNTANT)
 *   5. writeGuard(schoolId)                 → 402   (mutations only)
 *   6. a foreign/missing head id            → 404, and a row in a branch the caller
 *      cannot reach is a 403 — never a write, never another branch's row
 *
 * TEACHER / GUARDIAN / STUDENT are refused by step 4 even though the school's own
 * `feePayment` module would admit them: that is the whole point of D-7-18.
 */

/**
 * A head is visible to a SCHOOL-scoped caller whatever its branch, and to a
 * BRANCH-scoped caller only when it belongs to that branch. A branch-less row is
 * deliberately NOT visible to a branch scope — the same rule the college
 * departments and programmes use, so the branch verifier's branch-less fixture
 * cannot leak into a branch-scoped response.
 */
function visibleTo(session: { role: string; scope?: string | null; branchId?: string | null }, head: any): boolean {
  return canAccessBranch(session as any, head?.branchId ?? null);
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  const denied = requireCollegeFeesRead(session);
  if (denied) return denied;

  const rows = (await loadHeads(schoolId))
    .filter((h) => visibleTo(session, h))
    .map(serveHead)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id)));
  return NextResponse.json({ data: rows });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  const denied = requireCollegeFeesWrite(session);
  if (denied) return denied;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  if (body?.branchId && !canAccessBranch(session, body.branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // The school's own validation, restated in 7a (D-7-5): only the NAME is a hard
  // rule; bucket/frequency fall back and dueDay clamps 1..28.
  const checked = validateCollegeFeeHead(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  const branchId = await resolveBranchId(session, body?.branchId ?? null);
  const created = await prisma.collegeFeeHead.create({
    data: { schoolId, ...checked.head, branchId },
  });
  await audit("COLLEGE_FEE_HEAD_CREATE", "collegeFeeHead", created.id, { name: checked.head.name, branchId });
  return NextResponse.json({ data: serveHead(created) }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  const denied = requireCollegeFeesWrite(session);
  if (denied) return denied;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const existing: any = await prisma.collegeFeeHead.findUnique({ where: { id } });
  if (!existing || existing.schoolId !== schoolId) {
    return NextResponse.json({ error: "Fee head not found" }, { status: 404 });
  }
  if (!visibleTo(session, existing)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // A PATCH is merged onto the stored row BEFORE validating, so an omitted field
  // keeps its value and a partial edit cannot silently reset the rest.
  const merged = { ...serveHead(existing), ...body };
  const checked = validateCollegeFeeHead(merged);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  await prisma.collegeFeeHead.update({
    where: { id },
    data: {
      name: checked.head.name,
      bucket: checked.head.bucket,
      frequency: checked.head.frequency,
      optional: checked.head.optional,
      active: checked.head.active,
      dueDay: checked.head.dueDay,
      note: checked.head.note,
    },
  });
  await audit("COLLEGE_FEE_HEAD_UPDATE", "collegeFeeHead", id, { fields: Object.keys(body || {}), name: checked.head.name });
  const updated: any = await prisma.collegeFeeHead.findUnique({ where: { id } });
  return NextResponse.json({ data: serveHead(updated || { ...merged, id }) });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  const denied = requireCollegeFeesWrite(session);
  if (denied) return denied;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const head: any = await prisma.collegeFeeHead.findUnique({ where: { id } });
  if (!head || head.schoolId !== schoolId) {
    return NextResponse.json({ error: "Fee head not found" }, { status: 404 });
  }
  if (!visibleTo(session, head)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // D-7-5: a head that has ever been billed cannot be deleted — the school's own
  // "fees already billed keep their own title/amount" rule. The refusal names the
  // reason, and it distinguishes the two references so the fix is obvious.
  const charges = (await prisma.collegeFee.findMany({ where: { schoolId } })).filter((c) => c.headId === id);
  if (charges.length) {
    return NextResponse.json(
      { error: "This head has been billed. Mark it inactive instead — raising history is never rewritten." },
      { status: 409 }
    );
  }
  const priced = (await prisma.collegeFeeStructure.findMany({ where: { schoolId } })).filter((r) => r.headId === id);
  if (priced.length) {
    return NextResponse.json(
      { error: "This head is priced in a structure row. Remove those rows before deleting it." },
      { status: 409 }
    );
  }

  await prisma.collegeFeeHead.delete({ where: { id } });
  await audit("COLLEGE_FEE_HEAD_DELETE", "collegeFeeHead", id, { name: head.name });
  return NextResponse.json({ data: { ok: true } });
}
