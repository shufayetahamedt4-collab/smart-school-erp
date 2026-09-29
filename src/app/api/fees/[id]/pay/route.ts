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

  // Part-payment is expected (৳200 against a ৳500 fee) but over-payment is not:
  // confirmPayment clamps the fee to the billed amount while the payment row and
  // the ledger would still record the larger figure, leaving collected money in
  // the ledger that the fee does not account for. Refuse it here instead.
  const fee = await prisma.fee.findUnique({ where: { id } });
  if (!fee || fee.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Fee not found" }, { status: 404 });
  }
  const due = money(fee.amount) - money(fee.paidAmount);
  if (due <= 0) return NextResponse.json({ error: "This fee is already fully paid." }, { status: 400 });
  if (amount > due) {
    return NextResponse.json({ error: `That is more than the ${due} still due on this fee.` }, { status: 400 });
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
    });
    await audit("FEE_PAYMENT", "fee", id, { amount, receiptNo: result.receiptNo });
    return NextResponse.json({ data: { ok: true, ...result } });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Payment failed" }, { status: 404 });
  }
}
