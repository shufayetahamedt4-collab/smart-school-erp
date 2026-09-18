import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "node:crypto";
import { handleWebhook } from "@/lib/payments";
import type { PaymentMethod } from "@/lib/db";

/**
 * PRD §10.2 — gateway webhook endpoint (bKash / Nagad / Rocket / Card).
 *
 * Signature verification: each provider shares a secret via env
 * (`PAYMENT_WEBHOOK_SECRET` — one secret now, per-provider secrets later).
 * Idempotent: replays return ok without double-posting the ledger.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ provider: string }> }) {
  const { provider } = await params;
  const upper = provider.toUpperCase() as PaymentMethod;
  if (!["BKASH", "NAGAD", "ROCKET", "CARD"].includes(upper)) {
    return NextResponse.json({ error: "Unknown provider" }, { status: 404 });
  }

  const raw = await req.text();
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const secret = process.env.PAYMENT_WEBHOOK_SECRET || "";
  const signature = req.headers.get("x-payment-signature") || "";
  const verify = (payload: any) => {
    if (!secret) return true; // mock/sandbox mode until credentials are set
    const expected = createHmac("sha256", secret).update(raw).digest("hex");
    try {
      return timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
    } catch {
      return false;
    }
  };

  const result = await handleWebhook(upper, body, verify);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ data: { ok: true } });
}
