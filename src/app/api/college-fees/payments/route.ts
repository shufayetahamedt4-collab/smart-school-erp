import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { PaymentMethod } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { confirmCollegePayment } from "@/lib/ledger";
import { requireCollegeFeesWrite, serveCharge, targetSchoolId } from "@/lib/college-fees-server";

/**
 * College support (Phase 7c) — PAYMENT against one college charge,
 * `POST /api/college-fees/payments` (D-7-12).
 *
 * The client names a charge and an amount **in integer minor units** (paisa) — it
 * never types a currency amount, and it never types the amount due. The rules:
 *
 *   - the charge must be this tenant's (and in a branch the caller can reach);
 *   - `amountMinor` must be a positive whole number of minor units            → 400;
 *   - a payment may never exceed what the charge still owes                   → 409,
 *     refused by name, never clamped into a credit;
 *   - the acceptance is re-decided INSIDE a real Firestore transaction
 *     (`confirmCollegePayment` → `$guardedUpdate`), so **two simultaneous
 *     payments that together exceed the balance cannot both succeed** — the
 *     second re-reads the first's `paidAmount` and is refused;
 *   - ONE `PAYMENT` entry is appended to the SAME central ledger (`feeId: null`,
 *     `meta.collegeFeeId`), and the receipt number comes from the college's own
 *     `CRCP-…` sequence so school and college receipts never interleave.
 *
 * Guard order: session → target tenant → `requireCollege` → the write allow-list →
 * `writeGuard`.
 */

const METHODS: PaymentMethod[] = ["CASH", "BANK", "BKASH", "NAGAD", "ROCKET", "CARD"];

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
  const chargeId = typeof body?.chargeId === "string" ? body.chargeId.trim() : "";
  if (!chargeId) return NextResponse.json({ error: "A charge is required." }, { status: 400 });

  // The amount arrives in MINOR UNITS and must be a whole, positive number.
  const rawMinor = body?.amountMinor;
  const amountMinor = Number(rawMinor);
  if (
    rawMinor === undefined ||
    rawMinor === null ||
    rawMinor === "" ||
    !Number.isFinite(amountMinor) ||
    !Number.isInteger(amountMinor) ||
    amountMinor <= 0
  ) {
    return NextResponse.json(
      { error: "amountMinor must be a positive whole number of minor units." },
      { status: 400 }
    );
  }

  const method = METHODS.includes(body?.method) ? (body.method as PaymentMethod) : null;
  if (!method) {
    return NextResponse.json({ error: `method must be one of ${METHODS.join(", ")}.` }, { status: 400 });
  }

  const charge: any = await prisma.collegeFee.findUnique({ where: { id: chargeId } });
  if (!charge || charge.schoolId !== schoolId) {
    return NextResponse.json({ error: "College charge not found" }, { status: 404 });
  }
  if (!canAccessBranch(session, charge.branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const outcome = await confirmCollegePayment({
    schoolId,
    chargeId,
    amountMinor,
    method,
    refNo: body?.refNo ? String(body.refNo) : null,
    actorId: session.id,
  });
  if (!outcome.ok) {
    // The only refusal left after the 400s above is an over-payment (or a charge
    // that settled between the read and the transaction) — a visible 409.
    return NextResponse.json({ error: outcome.error }, { status: 409 });
  }

  await audit("COLLEGE_FEE_PAYMENT", "collegeFee", chargeId, {
    schoolId,
    receiptNo: outcome.receiptNo,
    amountMinor,
    method,
    paidAmount: outcome.paidAmount,
    due: outcome.due,
    status: outcome.status,
    programId: charge.programId ?? null,
    termNumber: charge.termNumber ?? null,
  });

  const after: any = await prisma.collegeFee.findUnique({ where: { id: chargeId } });
  return NextResponse.json(
    {
      data: {
        receiptNo: outcome.receiptNo,
        chargeId,
        applied: outcome.applied,
        paidAmount: outcome.paidAmount,
        due: outcome.due,
        status: outcome.status,
        charge: serveCharge(after || charge),
      },
    },
    { status: 201 }
  );
}
