import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { resolveBranchId } from "@/lib/branches";
import { isCollegeDiscountKind, isCollegeDiscountState, validateCollegeDiscount } from "@/lib/college-fees";
import {
  loadDiscounts,
  requireCollegeFeeAwardDecider,
  requireCollegeFeesRead,
  requireCollegeFeesWrite,
  serveDiscount,
  targetSchoolId,
} from "@/lib/college-fees-server";

/**
 * College support (Phase 7c) — DISCOUNTS and WAIVERS
 * (collection `collegeDiscount`), route `/api/college-fees/discounts` (D-7-13).
 *
 * Two shapes, both admin-set (Q5): a PERCENTAGE of a term's charges, and a FIXED
 * amount per head (a lab-fee waiver). An award targets the CHARGE SET it
 * discounts — a programme and/or a term, optionally narrowed to named heads.
 *
 * **Who may do what, and the rule used.** D-7-13 reuses the school's propose/approve
 * flow; §24.1's own inventory of that flow reads "accountant proposes, admin
 * approves". So this route enforces exactly that: anyone holding the college fee
 * WRITE allow-list may PROPOSE, only an admin-level role may DECIDE, and **nobody
 * may approve their own proposal** (`requireCollegeFeeAwardDecider`) — the
 * four-eyes rule the school's discount flow carries.
 *
 * The award is inert until it is APPROVED, and it only ever reduces charges raised
 * AFTER it takes effect: `generate` applies approved awards to the NEW rows it
 * derives (never to a row already on the books, D-7-9). The money it waives is
 * posted to the shared ledger as a `DISCOUNT` entry **when it is applied** — a
 * percentage has no amount until there is a charge to apply it to, so a ledger
 * entry at decision time would state a number nobody could stand behind.
 *
 * Guard order: session → target tenant → `requireCollege` → the allow-list
 * (read / write, then the award decider) → `writeGuard` (mutations) → 404/403.
 */

/**
 * An award follows the head/structure rule: visible to a SCHOOL scope whatever
 * its branch, and to a BRANCH scope only inside that branch (a branch-less award
 * is not reachable from a branch scope).
 */
function visibleTo(session: { role: string; scope?: string | null; branchId?: string | null }, award: any): boolean {
  return canAccessBranch(session as any, award?.branchId ?? null);
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

  const data = (await loadDiscounts(schoolId))
    .filter((a) => visibleTo(session, a))
    .map(serveDiscount)
    .sort((a, b) => String(a.createdAt ?? "").localeCompare(String(b.createdAt ?? "")) || String(a.id).localeCompare(String(b.id)));
  return NextResponse.json({ data });
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
  if (!isCollegeDiscountKind(body?.kind)) {
    return NextResponse.json({ error: "A discount is either PERCENT or FIXED." }, { status: 400 });
  }

  // An award that names a programme must name ONE of this tenant's, in a branch the
  // caller can reach; an award over the whole tenant carries no programme.
  let branchId: string | null = null;
  const programId = typeof body?.programId === "string" ? body.programId.trim() : "";
  if (programId) {
    const program: any = await prisma.program.findUnique({ where: { id: programId } });
    if (!program || program.schoolId !== schoolId) {
      return NextResponse.json({ error: "Programme not found in this school." }, { status: 400 });
    }
    if (!canAccessBranch(session, program.branchId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    branchId = program.branchId || null;
  } else {
    if (body?.branchId && !canAccessBranch(session, body.branchId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    branchId = await resolveBranchId(session, body?.branchId ?? null);
  }

  // 7a's ONE validation: a percentage in 1..100, a fixed amount with at least one
  // head, and — the guard that matters — every head named must be this tenant's.
  const checked = validateCollegeDiscount({ ...body, status: "PROPOSED", proposedBy: session.id, approvedBy: null });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });
  if (checked.award.headIds.length) {
    const heads = await prisma.collegeFeeHead.findMany({ where: { schoolId } });
    const owned = new Set((heads as any[]).map((h) => String(h.id)));
    const foreign = checked.award.headIds.filter((h) => !owned.has(h));
    if (foreign.length) {
      return NextResponse.json({ error: "A discount names a fee head that is not in this school." }, { status: 400 });
    }
  }

  const created = await prisma.collegeDiscount.create({
    data: {
      schoolId,
      branchId,
      kind: checked.award.kind,
      percent: checked.award.percent,
      amountPerHead: checked.award.amountPerHead,
      headIds: checked.award.headIds,
      programId: checked.award.programId,
      termNumber: checked.award.termNumber,
      status: "PROPOSED",
      proposedBy: session.id,
      approvedBy: null,
      note: checked.award.note,
      createdAt: new Date().toISOString(),
      decidedAt: null,
    },
  });
  await audit("COLLEGE_FEE_DISCOUNT_PROPOSE", "collegeDiscount", created.id, {
    kind: checked.award.kind,
    percent: checked.award.percent,
    amountPerHead: checked.award.amountPerHead,
    headIds: checked.award.headIds,
    programId: checked.award.programId,
    termNumber: checked.award.termNumber,
  });
  return NextResponse.json({ data: serveDiscount(created) }, { status: 201 });
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

  const state = body?.state;
  if (state !== "APPROVED" && state !== "REJECTED") {
    return NextResponse.json({ error: "state must be APPROVED or REJECTED." }, { status: 400 });
  }
  if (!isCollegeDiscountState(state)) {
    return NextResponse.json({ error: "state must be APPROVED or REJECTED." }, { status: 400 });
  }

  const award: any = await prisma.collegeDiscount.findUnique({ where: { id } });
  if (!award || award.schoolId !== schoolId) {
    return NextResponse.json({ error: "Discount not found" }, { status: 404 });
  }
  if (!visibleTo(session, award)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // The decider rule: an admin-level role, and never the proposer (D-7-13/§24.1).
  const deciderDenied = requireCollegeFeeAwardDecider(session, award.proposedBy);
  if (deciderDenied) return deciderDenied;

  // A decided award is not re-decided — a visible refusal, never a silent rewrite.
  if (award.status !== "PROPOSED") {
    return NextResponse.json(
      { error: `This award is already ${String(award.status).toLowerCase()}.` },
      { status: 409 }
    );
  }

  const approvedBy = state === "APPROVED" ? session.id : null;
  const merged = {
    id,
    kind: award.kind,
    percent: award.percent,
    amountPerHead: award.amountPerHead,
    headIds: award.headIds,
    programId: award.programId,
    termNumber: award.termNumber,
    note: body?.note !== undefined ? body.note : award.note,
    status: state,
    proposedBy: award.proposedBy,
    approvedBy,
  };
  const checked = validateCollegeDiscount(merged);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  const decidedAt = new Date().toISOString();
  await prisma.collegeDiscount.update({
    where: { id },
    data: { status: state, approvedBy, note: checked.award.note ?? null, decidedAt },
  });
  await audit(state === "APPROVED" ? "COLLEGE_FEE_DISCOUNT_APPROVE" : "COLLEGE_FEE_DISCOUNT_REJECT", "collegeDiscount", id, {
    kind: checked.award.kind,
    programId: checked.award.programId,
    termNumber: checked.award.termNumber,
    approvedBy,
  });

  const updated: any = await prisma.collegeDiscount.findUnique({ where: { id } });
  return NextResponse.json({ data: serveDiscount(updated || { ...merged, schoolId, decidedAt }) });
}
