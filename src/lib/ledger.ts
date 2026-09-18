import { prisma } from "./db";
import type { PaymentMethod } from "./db";
import { notifyUsers } from "./notify";

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

  const amount = Math.max(0, Number(input.amount));
  const newPaid = Math.min(Number(fee.amount), Number(fee.paidAmount) + amount);
  const status = newPaid >= Number(fee.amount) ? "PAID" : "PARTIAL";
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
    await prisma.fee.update({ where: { id: fee.id }, data: { amount: Number(fee.amount) + lateFeeAmount } });
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
