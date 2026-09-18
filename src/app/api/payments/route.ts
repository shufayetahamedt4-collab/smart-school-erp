import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can, PermissionError } from "@/lib/permissions";
import { createPaymentIntent, markFailed, markConfirmed } from "@/lib/payments";
import type { PaymentMethod } from "@/lib/db";

const METHODS: PaymentMethod[] = ["CASH", "BANK", "BKASH", "NAGAD", "ROCKET", "CARD"];

/**
 * PRD §10 — payments API.
 * GET  → list payment intents (accountant/admin reconciliation view)
 * POST → create a payment intent (guardian "View + Pay" §2.1, or admin entry)
 * PATCH→ confirm/fail a BANK transfer after reference verification
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const sp = req.nextUrl.searchParams;
  const status = sp.get("status") || undefined;
  const where: any = { schoolId };
  if (status) where.status = status;
  if (session.role === "GUARDIAN") {
    const studentId = session.studentId || (await prisma.student.findFirst({ where: { guardianUserId: session.id } }))?.id;
    if (!studentId) return NextResponse.json({ data: [] });
    where.studentId = studentId;
  }

  const intents = await prisma.paymentIntent.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 100,
    include: {
      student: { select: { id: true, name: true, admissionNo: true } },
      fee: { select: { id: true, title: true, amount: true, paidAmount: true, status: true } },
    },
  });
  return NextResponse.json({ data: intents });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const { feeId, method } = body || {};
  const amount = Number(body?.amount);
  if (!feeId || !method || !amount || amount <= 0) {
    return NextResponse.json({ error: "feeId, method and a positive amount are required." }, { status: 400 });
  }
  if (!METHODS.includes(method)) {
    return NextResponse.json({ error: "Unknown payment method." }, { status: 400 });
  }

  const fee = await prisma.fee.findUnique({ where: { id: String(feeId) } });
  if (!fee) return NextResponse.json({ error: "Fee not found" }, { status: 404 });

  // Authorization per §2.1 matrix: guardians pay own child's fees;
  // accountant/admin record on behalf of any student.
  if (session.role === "GUARDIAN") {
    const studentId = session.studentId || (await prisma.student.findFirst({ where: { guardianUserId: session.id } }))?.id;
    if (!studentId || studentId !== fee.studentId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  } else if (!can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const remaining = Number(fee.amount) - Number(fee.paidAmount);
  if (remaining <= 0) return NextResponse.json({ error: "This fee is already fully paid." }, { status: 400 });

  try {
    const intent = await createPaymentIntent(
      {
        schoolId: fee.schoolId,
        studentId: fee.studentId,
        feeId: fee.id,
        amount: Math.min(amount, remaining),
        method: method as PaymentMethod,
      },
      session.id
    );
    await audit("PAYMENT_INTENT", "paymentIntent", intent.id, { method, amount });
    return NextResponse.json({ data: intent }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Payment failed" }, { status: 500 });
  }
}

/** Accountant reconciliation: confirm a BANK/CASH entry, or fail it. */
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const { intentId, action, refNo } = body || {};
  if (!intentId || !["confirm", "fail"].includes(action)) {
    return NextResponse.json({ error: "intentId and action (confirm|fail) are required." }, { status: 400 });
  }

  const intent = await prisma.paymentIntent.findUnique({ where: { id: String(intentId) } });
  if (!intent || intent.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Payment intent not found" }, { status: 404 });
  }
  if (intent.status !== "PENDING") {
    return NextResponse.json({ error: `Intent already ${intent.status.toLowerCase()}.` }, { status: 400 });
  }

  if (action === "fail") {
    await markFailed(intent.id);
    await audit("PAYMENT_FAIL", "paymentIntent", intent.id);
    return NextResponse.json({ data: { ok: true, status: "FAILED" } });
  }

  // Confirm → runs the full confirmPayment flow (fee + payment + ledger + notify)
  const { confirmPayment } = await import("@/lib/ledger");
  const result = await confirmPayment({
    schoolId: intent.schoolId,
    feeId: intent.feeId,
    amount: Number(intent.amount),
    method: intent.method as PaymentMethod,
    refNo: refNo || intent.providerRef || intent.id,
    actorId: session.id,
  });
  await markConfirmed(intent.id);
  await audit("PAYMENT_CONFIRM", "paymentIntent", intent.id, result);
  return NextResponse.json({ data: { ok: true, ...result } });
}
