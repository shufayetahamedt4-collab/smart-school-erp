import { prisma } from "./db";
import type { PaymentMethod } from "./db";
import { notifyUsers } from "./notify";
import { money } from "./utils";
import { acceptCollegePayment, fromMinor, toMinor } from "./college-fees";

/**
 * PRD §10.1 — Central Ledger System.
 * Every fee / discount / payment / late-fee becomes an immutable ledger entry
 * (amount, method, reference, date, status, actor). Queryable student-wise and
 * school-wise. All money flows through here — nothing bypasses the ledger.
 */

export interface LedgerInput {
  schoolId: string;
  kind: "FEE" | "PAYMENT" | "DISCOUNT" | "LATE_FEE" | "EXPENSE";
  amount: number;
  method?: PaymentMethod | null;
  refNo?: string | null;
  status?: "PENDING" | "CONFIRMED" | "FAILED";
  studentId?: string | null;
  feeId?: string | null;
  actorId?: string | null;
  description?: string | null;
  meta?: Record<string, unknown> | null;
}

/** Append one immutable ledger entry. */
export async function postToLedger(input: LedgerInput) {
  return prisma.ledgerEntry.create({
    data: {
      schoolId: input.schoolId,
      kind: input.kind,
      amount: input.amount,
      method: input.method || null,
      refNo: input.refNo || null,
      status: input.status || "CONFIRMED",
      studentId: input.studentId || null,
      feeId: input.feeId || null,
      actorId: input.actorId || null,
      description: input.description || null,
      meta: input.meta ? JSON.parse(JSON.stringify(input.meta)) : null,
    },
  });
}

/* ------------------------------------------------------------------ queries */

export async function ledgerForStudent(schoolId: string, studentId: string) {
  return prisma.ledgerEntry.findMany({
    where: { schoolId, studentId },
    orderBy: { createdAt: "desc" },
    include: { actor: { select: { id: true, name: true, role: true } } },
  });
}

export async function ledgerForSchool(schoolId: string, opts?: { kind?: string; status?: string; take?: number }) {
  const where: any = { schoolId };
  if (opts?.kind) where.kind = opts.kind;
  if (opts?.status) where.status = opts.status;
  return prisma.ledgerEntry.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: opts?.take || 200,
    include: {
      student: { select: { id: true, name: true, admissionNo: true } },
      actor: { select: { id: true, name: true, role: true } },
    },
  });
}

/* ------------------------------------------------------------------ payments */

export interface ConfirmPaymentInput {
  schoolId: string;
  feeId: string;
  amount: number;
  method: PaymentMethod;
  refNo?: string | null;
  actorId?: string | null;
  date?: Date;
  /** payment already confirmed externally (webhook / gateway) */
  externallyConfirmed?: boolean;
  notify?: boolean;
}

/**
 * Shared payment-confirmation flow for ALL methods (PRD §10.2):
 * updates the fee, writes payment + ledger atomically, sends the guardian
 * a receipt notification. Returns the receipt number.
 */
export async function confirmPayment(input: ConfirmPaymentInput) {
  const fee = await prisma.fee.findUnique({ where: { id: input.feeId } });
  if (!fee || fee.schoolId !== input.schoolId) throw new Error("Fee not found");

  const amount = Math.max(0, Number(input.amount) || 0);
  // money() on BOTH sides: a fee row without paidAmount made `Number(undefined)`
  // NaN, and Firestore happily stored that NaN back as `paidAmount` — the rows
  // that then read ৳0 everywhere. Clamp to the billed amount so a double-click
  // can never overpay a fee either.
  const billed = money(fee.amount);
  const newPaid = Math.min(billed, money(fee.paidAmount) + amount);
  const status = newPaid >= billed ? "PAID" : "PARTIAL";
  const receiptNo = `RCP-${Date.now().toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`;

  await prisma.$transaction(async (tx) => {
    await tx.fee.update({ where: { id: input.feeId }, data: { paidAmount: newPaid, status } });
    await tx.payment.create({
      data: {
        schoolId: input.schoolId,
        studentId: fee.studentId,
        feeId: input.feeId,
        amount,
        method: input.method,
        refNo: input.refNo || null,
        receiptNo,
        date: input.date || new Date(),
      },
    });
    await postToLedger({
      schoolId: input.schoolId,
      kind: "PAYMENT",
      amount,
      method: input.method,
      refNo: input.refNo || receiptNo,
      status: "CONFIRMED",
      studentId: fee.studentId,
      feeId: input.feeId,
      actorId: input.actorId || null,
      description: `Payment for ${fee.title}`,
      meta: { receiptNo },
    });
  });

  if (input.notify !== false) {
    const student = await prisma.student.findUnique({
      where: { id: fee.studentId },
      select: { guardianUserId: true, name: true },
    });
    if (student?.guardianUserId) {
      await notifyUsers({
        schoolId: input.schoolId,
        userIds: [student.guardianUserId],
        event: "FEE_CONFIRMED",
        title: `Payment received — ${fee.title}`,
        body: `${amount} confirmed for ${student.name}. Receipt ${receiptNo}.`,
        link: "/parent/fees",
      });
    }
  }

  return { receiptNo, paidAmount: newPaid, feeStatus: status };
}

/** Idempotency guard: has this provider reference been confirmed already? */
export async function refAlreadyProcessed(schoolId: string, refNo: string): Promise<boolean> {
  const hit = await prisma.ledgerEntry.findFirst({
    where: { schoolId, refNo, kind: "PAYMENT", status: "CONFIRMED" },
    select: { id: true },
  });
  return !!hit;
}

/* ---------------------------------------------------- college payments (7c) */

/**
 * The college receipt sequence (D-7-12): `CRCP-…`.
 *
 * It is deliberately a different prefix from the school's `RCP-…`, so the two
 * modes' receipt numbers cannot interleave: a number a family is holding always
 * says which half of a BOTH tenant issued it, and no school receipt number can
 * ever be re-issued by a college payment (or the other way round).
 */
export function collegeReceiptNo(now: number = Date.now()): string {
  return `CRCP-${now.toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`;
}

export interface ConfirmCollegePaymentInput {
  schoolId: string;
  /** The `collegeFee` charge the payment is against. */
  chargeId: string;
  /** The amount in INTEGER MINOR UNITS (paisa) — never a typed currency amount. */
  amountMinor: number;
  method: PaymentMethod;
  refNo?: string | null;
  actorId?: string | null;
  date?: Date;
}

export type CollegePaymentOutcome =
  | {
      ok: true;
      receiptNo: string;
      chargeId: string;
      applied: number;
      paidAmount: number;
      due: number;
      status: "UNPAID" | "PARTIAL" | "PAID";
    }
  | { ok: false; error: string };

/**
 * Confirm a payment against ONE college charge (D-7-12) — the college counterpart
 * of `confirmPayment()`, posting to the SAME central ledger.
 *
 * Three rules, and each one is load-bearing:
 *
 *  1. **Over-payment is refused.** `acceptCollegePayment` (7a) refuses any payment
 *     larger than what the charge still owes, by name — it is never clamped into a
 *     credit.
 *  2. **The decision is made atomically.** The amount is re-decided INSIDE
 *     `$guardedUpdate`'s real Firestore transaction, against the row as it is at
 *     that instant — so two simultaneous payments that together exceed the
 *     outstanding balance cannot both succeed. The loser re-reads the winner's
 *     `paidAmount`, sees the smaller balance and is refused. (The school's own
 *     `confirmPayment` clamps instead, and its callback `$transaction` is only
 *     sequential; this is the D-7-12 path and it is proved by
 *     `scripts/verify-college-fees-api.mjs`.)
 *  3. **The ledger is shared, not duplicated.** ONE `PAYMENT` entry is appended,
 *     with `feeId: null` and a `meta` naming the college charge, programme and
 *     term — so the entry is in the same ledger the school uses, and 7e can prove
 *     no school-mode read shows it (Q3).
 *
 * It writes NO `payment` row: the school's `payments` collection is read by the
 * school's own screens, and a college payment must not appear there (D-7-12
 * records only the ledger entry and the charge's own receipt number).
 */
export async function confirmCollegePayment(input: ConfirmCollegePaymentInput): Promise<CollegePaymentOutcome> {
  const charge: any = await prisma.collegeFee.findUnique({ where: { id: input.chargeId } });
  if (!charge || charge.schoolId !== input.schoolId) return { ok: false, error: "College charge not found." };

  const amountMinor = Math.trunc(Number(input.amountMinor));
  if (!Number.isFinite(amountMinor) || amountMinor <= 0) {
    return { ok: false, error: "Payment must be a positive whole number of minor units." };
  }

  // A courtesy refusal BEFORE the transaction, so an obvious over-payment gets a
  // clean message; the transaction below is the authoritative decision.
  const preview = acceptCollegePayment(charge, { amount: fromMinor(amountMinor) });
  if (!preview.ok) return { ok: false, error: preview.error };

  const stamp = (input.date || new Date()).toISOString();
  const written = await prisma.$guardedUpdate("collegeFee", input.chargeId, (current) => {
    if (!current) return { ok: false, error: "College charge not found." };
    const decision = acceptCollegePayment(current, { amount: fromMinor(amountMinor) });
    if (!decision.ok) return { ok: false, error: decision.error };
    return { ok: true, data: { paidAmount: decision.paidAmount, status: decision.status, lastPaidAt: stamp } };
  });
  if (!written.ok || !written.row) {
    return { ok: false, error: written.error || "Payment refused — the charge changed while it was being paid." };
  }

  const receiptNo = collegeReceiptNo();
  await postToLedger({
    schoolId: input.schoolId,
    kind: "PAYMENT",
    amount: fromMinor(amountMinor),
    method: input.method,
    refNo: input.refNo || receiptNo,
    status: "CONFIRMED",
    studentId: charge.studentId ?? null,
    feeId: null,
    actorId: input.actorId || null,
    description: `College payment — ${String(charge.title ?? "charge")}`,
    meta: {
      receiptNo,
      collegeFeeId: input.chargeId,
      programId: charge.programId ?? null,
      termNumber: charge.termNumber ?? null,
    },
  });

  return {
    ok: true,
    receiptNo,
    chargeId: input.chargeId,
    applied: fromMinor(amountMinor),
    paidAmount: Number(written.row.paidAmount) || 0,
    due: fromMinor(Math.max(0, toMinor(written.row.amount) - toMinor(written.row.paidAmount))),
    status: written.row.status,
  };
}

/** PRD §10.3 — automatic late fee after due date (called by reminder/job run). */
export async function applyLateFees(schoolId: string, lateFeeAmount: number): Promise<number> {
  const now = new Date();
  const overdue = await prisma.fee.findMany({
    where: { schoolId, status: { not: "PAID" }, dueDate: { lt: now } },
  });
  let applied = 0;
  for (const fee of overdue) {
    const existing = await prisma.ledgerEntry.findFirst({
      where: { schoolId, kind: "LATE_FEE", feeId: fee.id },
      select: { id: true },
    });
    if (existing) continue; // once per fee
    // money(), not Number(): a late fee on a row with a missing amount would
    // otherwise write NaN into the fee — the same corruption that zeroed totals.
    await prisma.fee.update({ where: { id: fee.id }, data: { amount: money(fee.amount) + lateFeeAmount } });
    await postToLedger({
      schoolId,
      kind: "LATE_FEE",
      amount: lateFeeAmount,
      status: "CONFIRMED",
      studentId: fee.studentId,
      feeId: fee.id,
      description: `Late fee applied to ${fee.title}`,
    });
    applied++;
  }
  return applied;
}
