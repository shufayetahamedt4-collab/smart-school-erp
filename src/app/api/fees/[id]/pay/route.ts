import { NextRequest, NextResponse } from "next/server";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { confirmPayment } from "@/lib/ledger";
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
