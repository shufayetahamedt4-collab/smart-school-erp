import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { confirmPayment } from "@/lib/ledger";
import { money } from "@/lib/utils";
import type { PaymentMethod } from "@/lib/db";

/** Legacy pay endpoint — now routed through the central ledger flow (§10.1). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const amount = Number(body?.amount);
  if (!amount || amount <= 0) return NextResponse.json({ error: "Invalid payment amount." }, { status: 400 });

  // pilot P2 — the idempotency key is OPTIONAL (an absent/empty key is the old
  // behaviour), and it may arrive in the body or as `x-idempotency-key`. A key
  // that IS present must be a usable string: silently ignoring a malformed one
  // would quietly turn a repeat-proof payment into a repeatable one, so it is
  // refused by name instead (the college route's own rule, same text).
  const rawKey = body?.idempotencyKey ?? req.headers.get("x-idempotency-key");
  let idempotencyKey: string | null = null;
  if (rawKey !== undefined && rawKey !== null && rawKey !== "") {
    if (typeof rawKey !== "string" || rawKey.trim().length < 8 || rawKey.trim().length > 120) {
      return NextResponse.json({ error: "idempotencyKey must be between 8 and 120 characters." }, { status: 400 });
    }
    idempotencyKey = rawKey.trim();
  }

  const fee = await prisma.fee.findUnique({ where: { id } });
  if (!fee || fee.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Fee not found" }, { status: 404 });
  }

  // Part-payment is expected (৳200 against a ৳500 fee) but over-payment is not:
  // confirmPayment clamps the fee to the billed amount while the payment row and
  // the ledger would still record the larger figure, leaving collected money in
  // the ledger that the fee does not account for.
  //
  // P2: this is a COURTESY pre-check, and it is skipped for a keyed attempt. A
  // replay of a payment that settled the fee in full would otherwise be refused
  // here (`due` is now 0) before `confirmPayment` could answer it from the
  // original record — which would break exactly the retry the key exists for. A
  // keyed attempt is decided inside the guarded transaction instead, where the
  // same two refusals are raised against the CURRENT row.
  if (!idempotencyKey) {
    const due = money(fee.amount) - money(fee.paidAmount);
    if (due <= 0) return NextResponse.json({ error: "This fee is already fully paid." }, { status: 400 });
    if (amount > due) {
      return NextResponse.json({ error: `That is more than the ${due} still due on this fee.` }, { status: 400 });
    }
  }

  try {
    const result = await confirmPayment({
      schoolId: session.schoolId!,
      feeId: id,
      amount,
      method: (body?.method as PaymentMethod) || "CASH",
      refNo: body?.refNo || null,
      actorId: session.id,
      date: body?.date ? new Date(body.date) : undefined,
      idempotencyKey,
    });
    await audit("FEE_PAYMENT", "fee", id, { amount, receiptNo: result.receiptNo });
    return NextResponse.json({ data: { ok: true, ...result } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Payment failed" }, { status: 404 });
  }
}
