import { prisma } from "./db";
import type { PaymentMethod } from "./db";
import { confirmPayment, refAlreadyProcessed } from "./ledger";

/**
 * PRD §10.2 — Payment flow by method.
 *
 *  Method              Confirmation
 *  CASH                Accountant/Admin enters it → confirmed instantly
 *  BANK                Accountant verifies reference → confirms (reconciliation UI)
 *  BKASH/NAGAD/ROCKET  Merchant API webhook auto-confirm (mock until credentials)
 *  CARD                Gateway callback auto-confirm (mock until credentials)
 *
 * All providers create a paymentIntent (PENDING) and confirm via
 * confirmPayment() which posts to the central ledger.
 */

export interface CreateIntentInput {
  schoolId: string;
  studentId: string;
  feeId: string;
  amount: number;
  method: PaymentMethod;
}

export interface ProviderAdapter {
  /** Human label for UI. */
  label: string;
  /** Whether this adapter can complete payments without external credentials. */
  live: boolean;
  /** Create a provider-side payment intent. */
  createIntent(input: CreateIntentInput & { intentId: string }): Promise<{ redirectUrl?: string; providerRef?: string }>;
}

class CashProvider implements ProviderAdapter {
  label = "Cash";
  live = true;
  async createIntent(input: CreateIntentInput & { intentId: string }) {
    // Cash confirms immediately when the accountant records it.
    await confirmPayment({
      schoolId: input.schoolId,
      feeId: input.feeId,
      amount: input.amount,
      method: "CASH",
      actorId: null,
      refNo: input.intentId,
      notify: true,
    });
    await markConfirmed(input.intentId);
    return { providerRef: input.intentId };
  }
}

class BankProvider implements ProviderAdapter {
  label = "Bank Transfer";
  live = true;
  async createIntent(input: CreateIntentInput & { intentId: string }) {
    // Bank transfer stays PENDING until the accountant verifies the reference.
    return { providerRef: input.intentId };
  }
}

/** Shared stub for gateway methods — sandbox/mock until credentials arrive. */
class GatewayStub implements ProviderAdapter {
  label: string;
  live = false;
  method: PaymentMethod;
  constructor(method: PaymentMethod, label: string) {
    this.method = method;
    this.label = label;
  }
  async createIntent(input: CreateIntentInput & { intentId: string }) {
    // Production: call the merchant API here with env credentials and return
    // the hosted-checkout redirectUrl. Mock mode: client polls the intent
    // and completes via /api/payments/mock-complete (dev/testing only).
    return { redirectUrl: `/pay/mock?intent=${input.intentId}`, providerRef: input.intentId };
  }
}

const PROVIDERS: Record<PaymentMethod, ProviderAdapter> = {
  CASH: new CashProvider(),
  BANK: new BankProvider(),
  BKASH: new GatewayStub("BKASH", "bKash"),
  NAGAD: new GatewayStub("NAGAD", "Nagad"),
  ROCKET: new GatewayStub("ROCKET", "Rocket"),
  CARD: new GatewayStub("CARD", "Card (SSLCommerz/Aamarpay)"),
};

export function getProvider(method: PaymentMethod): ProviderAdapter {
  return PROVIDERS[method];
}

export function providerLabel(method: string): string {
  return PROVIDERS[method as PaymentMethod]?.label || method;
}

export function gatewayMethods(): PaymentMethod[] {
  return ["BKASH", "NAGAD", "ROCKET", "CARD"];
}

export async function createPaymentIntent(input: CreateIntentInput, actorId?: string | null) {
  const intentId = `pi_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const intent = await prisma.paymentIntent.create({
    data: {
      id: intentId,
      schoolId: input.schoolId,
      studentId: input.studentId,
      feeId: input.feeId,
      amount: input.amount,
      method: input.method,
      status: "PENDING",
      actorId: actorId || null,
    },
  });
  const provider = getProvider(input.method);
  const result = await provider.createIntent({ ...input, intentId });
  await prisma.paymentIntent.update({
    where: { id: intentId },
    data: { providerRef: result.providerRef || null, redirectUrl: result.redirectUrl || null },
  });
  return { ...intent, redirectUrl: result.redirectUrl || null };
}

export async function markConfirmed(intentId: string) {
  await prisma.paymentIntent.updateMany({
    where: { id: intentId, status: "PENDING" },
    data: { status: "CONFIRMED" },
  });
}

export async function markFailed(intentId: string) {
  await prisma.paymentIntent.updateMany({
    where: { id: intentId, status: "PENDING" },
    data: { status: "FAILED" },
  });
}

/**
 * Webhook handler core (PRD §10.2) — verify → idempotency check → confirm.
 * `verify` is the provider-specific signature check; return false to reject.
 */
export async function handleWebhook(
  provider: PaymentMethod,
  body: { intentId?: string; refNo?: string; amount?: number; status?: string },
  verify: (body: any) => boolean
): Promise<{ ok: boolean; error?: string }> {
  if (!verify(body)) return { ok: false, error: "Invalid signature" };

  const intent = body.intentId
    ? await prisma.paymentIntent.findUnique({ where: { id: body.intentId } })
    : body.refNo
      ? await prisma.paymentIntent.findFirst({ where: { providerRef: String(body.refNo) } })
      : null;
  if (!intent) return { ok: false, error: "Unknown payment intent" };
  if (intent.status === "CONFIRMED") return { ok: true }; // idempotent replay

  if (body.status === "FAILED") {
    await markFailed(intent.id);
    return { ok: true };
  }

  if (await refAlreadyProcessed(intent.schoolId, intent.id)) return { ok: true };

  await confirmPayment({
    schoolId: intent.schoolId,
    feeId: intent.feeId,
    amount: Number(body.amount || intent.amount),
    method: intent.method as PaymentMethod,
    refNo: intent.id,
    externallyConfirmed: true,
  });
  await markConfirmed(intent.id);
  return { ok: true };
}
