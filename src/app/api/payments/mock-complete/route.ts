import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, guardianChildIds } from "@/lib/auth";
import { confirmPayment, refAlreadyProcessed } from "@/lib/ledger";
import { markConfirmed } from "@/lib/payments";
import type { PaymentMethod } from "@/lib/db";

/**
 * Mock completion for gateway intents while merchant credentials are absent
 * (sandbox mode). ONLY available when PAYMENT_WEBHOOK_SECRET is unset —
 * production deployments set the secret and this route refuses to run.
 */
export async function POST(req: NextRequest) {
  if (process.env.PAYMENT_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Disabled in production" }, { status: 403 });
  }
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const intentId = String(body?.intentId || "");
  const intent = await prisma.paymentIntent.findUnique({ where: { id: intentId } });
  if (!intent) return NextResponse.json({ error: "Intent not found" }, { status: 404 });

  // Guardian may only complete their own children's intents (§5.4 — a family
  // login covers every child, not just whichever one resolved first);
  // staff any in their school.
  if (session.role === "GUARDIAN") {
    const ownChildIds = await guardianChildIds(session);
    if (!ownChildIds.includes(intent.studentId)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  } else if (intent.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  if (intent.status !== "PENDING") return NextResponse.json({ error: `Intent already ${intent.status.toLowerCase()}.` }, { status: 400 });
  if (await refAlreadyProcessed(intent.schoolId, intent.id)) {
    await markConfirmed(intent.id);
    return NextResponse.json({ data: { ok: true } });
  }

  const result = await confirmPayment({
    schoolId: intent.schoolId,
    feeId: intent.feeId,
    amount: Number(intent.amount),
    method: intent.method as PaymentMethod,
    refNo: intent.id,
    actorId: session.id,
  });
  await markConfirmed(intent.id);
  return NextResponse.json({ data: { ok: true, ...result } });
}
