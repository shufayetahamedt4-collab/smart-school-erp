import { prisma, collegePaymentLedgerId, schoolPaymentIds } from "./db";
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
  /**
   * P2 — the OPTIONAL key that identifies ONE payment ATTEMPT.
   *
   * A retry, a second tab open on the same Collect form and a double submit all
   * carry the same key, so all of them describe one payment: the FIRST request
   * writes it and every later one is answered from it (`replay: true`) without a
   * second `payment` row, a second ledger entry or a second receipt. A different
   * key is simply a different payment.
   *
   * It is optional on purpose: a caller that sends nothing (the gateway webhook,
   * a cash intent, an admissions intake) gets exactly the behaviour this function
   * has always had.
   */
  idempotencyKey?: string | null;
}

export interface ConfirmPaymentResult {
  receiptNo: string;
  paidAmount: number;
  feeStatus: "PAID" | "PARTIAL";
  /** P2 — true when this request was answered from a payment an earlier one wrote. */
  replay?: boolean;
}

/** The school receipt sequence, minted in one place so a keyed attempt can stamp it. */
function schoolReceiptNo(now: number = Date.now()): string {
  return `RCP-${now.toString().slice(-8)}${Math.floor(Math.random() * 90 + 10)}`;
}

/** The row a keyed attempt stamps onto its fee (P2) — read only by name. */
interface SchoolPaymentStamp {
  key?: unknown;
  amount?: unknown;
  method?: unknown;
  receiptNo?: unknown;
  paidAmount?: unknown;
  feeStatus?: unknown;
  at?: unknown;
}

function paymentStampOf(row: any): SchoolPaymentStamp | null {
  const s = row && row.idempotency;
  return s && typeof s === "object" && typeof s.key === "string" && s.key ? (s as SchoolPaymentStamp) : null;
}

/**
 * The keys this fee has already been paid with, most recent last (P2).
 *
 * The stamp above describes the LAST keyed payment; this bounded list keeps an
 * EARLIER key spent even after a later, different key restamped the fee. One job:
 * a key that has already paid this fee is refused rather than paid again.
 */
function paidKeysOf(row: any): string[] {
  const list = row && row.idempotencyKeys;
  return Array.isArray(list) ? (list.filter((k) => typeof k === "string" && k) as string[]) : [];
}

const PAYMENT_KEY_MEMORY = 8;

/** P2 — one key, one payment: whatever is written for a key is written once. */
const SCHOOL_PAYMENT_KEY_TAKEN = "__SCHOOL_PAYMENT_KEY_TAKEN__";

/** The visible refusal for a key already spent on a DIFFERENT payment. */
const SCHOOL_PAYMENT_KEY_CONFLICT =
  "This payment key was already used for a different fee, amount or method. Start a new payment.";

/**
 * P2 — append the two rows a keyed attempt owns, under their DETERMINISTIC ids.
 *
 * The ids are derived from (tenant, fee, key), so a repeat lands on the same
 * documents: `$guardedUpdate`'s create-if-absent guard turns the second write
 * into a refusal rather than a second row. It is called both after a fresh
 * acceptance and on a replay path that never saw the first reply, so a dropped
 * response cannot leave a paid fee with no payment row (or no ledger entry).
 */
async function appendKeyedPaymentRows(args: {
  input: ConfirmPaymentInput;
  ids: { paymentId: string; ledgerId: string };
  fee: { studentId: string; title?: string | null };
  amount: number;
  receiptNo: string;
  newPaid: number;
  status: "PAID" | "PARTIAL";
  stamp: string;
}): Promise<void> {
  const { input, ids, fee, amount, receiptNo, newPaid, status, stamp } = args;
  await prisma.$guardedUpdate("payment", ids.paymentId, (current) =>
    current
      ? { ok: false, error: "already recorded" }
      : {
          ok: true,
          data: {
            schoolId: input.schoolId,
            studentId: fee.studentId,
            feeId: input.feeId,
            amount,
            method: input.method,
            refNo: input.refNo || null,
            receiptNo,
            date: input.date || new Date(stamp),
          },
        }
  );
  await prisma.$guardedUpdate("ledgerEntry", ids.ledgerId, (current) =>
    current
      ? { ok: false, error: "already recorded" }
      : {
          ok: true,
          data: {
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
            meta: {
              receiptNo,
              paymentKey: ids.paymentId,
              amount,
              method: input.method,
              paidAmount: newPaid,
              feeStatus: status,
              at: stamp,
            },
          },
        }
  );
}

/**
 * Shared payment-confirmation flow for ALL methods (PRD §10.2):
 * updates the fee, writes payment + ledger atomically, sends the guardian
 * a receipt notification. Returns the receipt number.
 *
 * P2 changed WHERE the decision is made, not what it decides. It used to read
 * the fee, compute `paidAmount` in JS and write the absolute value back — so two
 * simultaneous ৳500 payments against a ৳1000 fee both read 0 and both wrote 500:
 * two payment rows, two receipts, a ledger of ৳1000 and a fee that still read
 * ৳500/PARTIAL (the lost update). The new paid amount is now recomputed from the
 * CURRENT stored fee inside `$guardedUpdate`'s real Firestore transaction, and an
 * OPTIONAL idempotency key makes a repeated attempt write exactly once.
 */
export async function confirmPayment(input: ConfirmPaymentInput): Promise<ConfirmPaymentResult> {
  const fee: any = await prisma.fee.findUnique({ where: { id: input.feeId } });
  if (!fee || fee.schoolId !== input.schoolId) throw new Error("Fee not found");

  const amount = Math.max(0, Number(input.amount) || 0);
  // money() on BOTH sides: a fee row without paidAmount made `Number(undefined)`
  // NaN, and Firestore happily stored that NaN back as `paidAmount` — the rows
  // that then read ৳0 everywhere.
  const billed = money(fee.amount);
  // 7e-pre's `paymentKeyFrom` is reused verbatim: absent/blank ⇒ null (the old
  // behaviour), and a hostile over-long string is truncated, never a 400 here.
  const key = paymentKeyFrom(input.idempotencyKey);
  const ids = key ? schoolPaymentIds(input.schoolId, input.feeId, key) : null;

  // P2 — a keyed attempt that already landed is answered from the ledger entry it
  // wrote, with the ORIGINAL receipt, and writes nothing.
  if (key && ids) {
    const entry: any = await prisma.ledgerEntry.findUnique({ where: { id: ids.ledgerId } });
    if (entry && entry.schoolId === input.schoolId) {
      const meta: any = entry.meta || {};
      const samePayment =
        entry.feeId === input.feeId && money(entry.amount) === amount && entry.method === input.method;
      if (!samePayment) throw new Error(SCHOOL_PAYMENT_KEY_CONFLICT);
      return {
        receiptNo: String(meta.receiptNo ?? ""),
        paidAmount: Number(meta.paidAmount) || 0,
        feeStatus: (meta.feeStatus as "PAID" | "PARTIAL") || "PARTIAL",
        replay: true,
      };
    }
  }

  const stamp = (input.date || new Date()).toISOString();
  // A keyed attempt must be able to hand its receipt back ATOMICALLY, from inside
  // the transaction that accepts it — that stamp is what answers a later attempt
  // with the same key even if it never saw the first reply (a dropped response).
  const receiptNo = key ? schoolReceiptNo() : null;

  const written = await prisma.$guardedUpdate("fee", input.feeId, (current) => {
    if (!current) return { ok: false, error: "Fee not found" };
    const currentPaid = money(current.paidAmount);
    const currentBilled = money(current.amount) || billed;

    // One key, one payment: a repeat of THIS attempt on THIS fee writes nothing.
    const prior = paymentStampOf(current);
    if (key && ((prior && prior.key === key) || paidKeysOf(current).includes(key))) {
      return { ok: false, error: SCHOOL_PAYMENT_KEY_TAKEN };
    }

    if (key) {
      // A keyed attempt REFUSES rather than clamps, against the row as it is at
      // THIS instant — so two payments that together exceed the outstanding
      // amount cannot both succeed.
      if (currentPaid >= currentBilled) return { ok: false, error: "This fee is already fully paid." };
      const due = currentBilled - currentPaid;
      if (amount > due) return { ok: false, error: `That is more than the ${due} still due on this fee.` };
      const newPaid = currentPaid + amount;
      const status = newPaid >= currentBilled ? "PAID" : "PARTIAL";
      return {
        ok: true,
        data: {
          paidAmount: newPaid,
          status,
          idempotencyKeys: [...paidKeysOf(current), key].slice(-PAYMENT_KEY_MEMORY),
          idempotency: {
            key,
            amount,
            method: input.method,
            receiptNo,
            paidAmount: newPaid,
            due: Math.max(0, currentBilled - newPaid),
            feeStatus: status,
            at: stamp,
          },
        },
      };
    }

    // Keyless: the historical clamp, preserved exactly — the webhook and intent
    // paths rely on it — but recomputed from the CURRENT stored fee instead of
    // from a pre-read, so two simultaneous writes cannot lose one another.
    const newPaid = Math.min(currentBilled, currentPaid + amount);
    const status = newPaid >= currentBilled ? "PAID" : "PARTIAL";
    return { ok: true, data: { paidAmount: newPaid, status } };
  });

  if (!written.ok || !written.row) {
    const holder: any = (written as any).holder;
    const prior = paymentStampOf(holder);
    const spent = !!key && paidKeysOf(holder).includes(key);
    if (key && ids && (prior?.key === key || spent)) {
      // The key is already spent on THIS fee: answer from the payment it recorded.
      if (prior?.key === key && Number(prior.amount) === amount && prior.method === input.method) {
        const replayReceipt = String(prior.receiptNo ?? "");
        const replayPaid = Number(prior.paidAmount) || 0;
        const replayStatus = (prior.feeStatus as "PAID" | "PARTIAL") || "PARTIAL";
        // A request that never saw the first reply still needs the two appended
        // rows; the deterministic ids make this a create-once.
        await appendKeyedPaymentRows({
          input,
          ids,
          fee,
          amount,
          receiptNo: replayReceipt,
          newPaid: replayPaid,
          status: replayStatus,
          stamp,
        });
        return { receiptNo: replayReceipt, paidAmount: replayPaid, feeStatus: replayStatus, replay: true };
      }
      throw new Error(SCHOOL_PAYMENT_KEY_CONFLICT);
    }
    throw new Error(written.error || "Payment refused — the fee changed while it was being paid.");
  }

  const row: any = written.row;
  const newPaid = Number(row.paidAmount) || 0;
  const status = (row.status as "PAID" | "PARTIAL") || "PARTIAL";
  const receipt = receiptNo || schoolReceiptNo();

  if (key && ids) {
    await appendKeyedPaymentRows({ input, ids, fee, amount, receiptNo: receipt, newPaid, status, stamp });
  } else {
    await prisma.payment.create({
      data: {
        schoolId: input.schoolId,
        studentId: fee.studentId,
        feeId: input.feeId,
        amount,
        method: input.method,
        refNo: input.refNo || null,
        receiptNo: receipt,
        date: input.date || new Date(),
      },
    });
    await postToLedger({
      schoolId: input.schoolId,
      kind: "PAYMENT",
      amount,
      method: input.method,
      refNo: input.refNo || receipt,
      status: "CONFIRMED",
      studentId: fee.studentId,
      feeId: input.feeId,
      actorId: input.actorId || null,
      description: `Payment for ${fee.title}`,
      meta: { receiptNo: receipt },
    });
  }

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
        body: `${amount} confirmed for ${student.name}. Receipt ${receipt}.`,
        link: "/parent/fees",
      });
    }
  }

  return { receiptNo: receipt, paidAmount: newPaid, feeStatus: status, ...(key ? { replay: false } : {}) };
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
  /**
   * 7e-pre — the OPTIONAL key that identifies ONE payment ATTEMPT.
   *
   * A retry, a second tab open on the same form and a double submit all carry the
   * same key, so all of them describe one payment: the FIRST request writes it and
   * every later one is answered from it (`replay: true`) without a second ledger
   * entry, a second receipt number or a second rupee. A different key is simply a
   * different payment.
   *
   * It is optional on purpose: a caller that sends nothing (the school's own
   * code, an integration, a script) gets exactly the behaviour this function has
   * always had.
   */
  idempotencyKey?: string | null;
}

export type CollegePaymentOutcome =
  | {
      ok: true;
      /** True when this request was answered from a payment an earlier one wrote. */
      replay?: boolean;
      receiptNo: string;
      chargeId: string;
      applied: number;
      paidAmount: number;
      due: number;
      status: "UNPAID" | "PARTIAL" | "PAID";
    }
  | {
      ok: false;
      /** True when the key is already spent on a DIFFERENT charge, amount or method. */
      conflict?: boolean;
      error: string;
    };

/**
 * 7e-pre — the payment key an attempt carries, or `null` for the keyless path.
 *
 * Pure and total: anything that is not a non-empty string is `null` (an absent key
 * behaves exactly as before), and a very long client string is truncated to the
 * length the ledger id is happy with rather than rejected, so a hostile caller
 * cannot turn a valid payment into a 400.
 */
export function paymentKeyFrom(key: unknown): string | null {
  if (typeof key !== "string") return null;
  const trimmed = key.trim();
  return trimmed ? trimmed.slice(0, 120) : null;
}

/** 7e-pre — one key, one payment: whatever is written for a key is written once. */
const COLLEGE_PAYMENT_KEY_TAKEN = "__COLLEGE_PAYMENT_KEY_TAKEN__";

/** The visible 409 for a key that is already spent on a different payment. */
export const COLLEGE_PAYMENT_KEY_CONFLICT =
  "This payment key was already used for a different charge, amount or method. Start a new payment.";

/** The row a keyed attempt stamps onto its charge (7e-pre) — read only by name. */
interface CollegePaymentStamp {
  key?: unknown;
  amountMinor?: unknown;
  method?: unknown;
  receiptNo?: unknown;
  applied?: unknown;
  paidAmount?: unknown;
  due?: unknown;
  status?: unknown;
  at?: unknown;
}

function stampOf(row: any): CollegePaymentStamp | null {
  const s = row && row.idempotency;
  return s && typeof s === "object" && typeof s.key === "string" && s.key ? (s as CollegePaymentStamp) : null;
}

/**
 * The keys this charge has already been paid with, most recent last (7e-pre).
 *
 * The full stamp above describes the LAST keyed payment; this bounded list is what
 * keeps an EARLIER key spent even after a later, different key restamped the
 * charge. It is a safety net with one job: a key that has already paid this charge
 * is refused rather than paid again. Eight entries is far more than a form or a
 * retry can produce in the window that matters, and it keeps the row small.
 */
function seenKeys(row: any): string[] {
  const list = row && row.idempotencyKeys;
  return Array.isArray(list) ? list.filter((k) => typeof k === "string" && k) as string[] : [];
}

const KEY_MEMORY = 8;

/** The outcome an earlier, identical payment already produced. */
function replayOutcome(
  chargeId: string,
  stamp: CollegePaymentStamp
): Extract<CollegePaymentOutcome, { ok: true }> {
  return {
    ok: true,
    replay: true,
    receiptNo: String(stamp.receiptNo ?? ""),
    chargeId,
    applied: Number(stamp.applied) || 0,
    paidAmount: Number(stamp.paidAmount) || 0,
    due: Number(stamp.due) || 0,
    status: (stamp.status as "UNPAID" | "PARTIAL" | "PAID") || "UNPAID",
  };
}

/** Paise still owed on a charge, from the row and the post-payment paid amount. */
function dueOf(row: any, paidAmount: number): number {
  return fromMinor(Math.max(0, toMinor(row?.amount) - toMinor(paidAmount)));
}

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

  // 7e-pre — the keyless path is untouched: with no key, nothing below changes.
  const key = paymentKeyFrom(input.idempotencyKey);
  if (key) {
    // One id per (tenant, key), so this read asks "has THIS attempt already been
    // written?" and can only ever see this tenant's own payment.
    const entry: any = await prisma.ledgerEntry.findUnique({
      where: { id: collegePaymentLedgerId(input.schoolId, key) },
    });
    if (entry && entry.schoolId === input.schoolId) {
      const meta: any = entry.meta || {};
      const samePayment =
        meta.collegeFeeId === input.chargeId && Number(meta.amountMinor) === amountMinor && meta.method === input.method;
      if (!samePayment) return { ok: false, conflict: true, error: COLLEGE_PAYMENT_KEY_CONFLICT };
      return {
        ok: true,
        replay: true,
        receiptNo: String(meta.receiptNo ?? ""),
        chargeId: input.chargeId,
        applied: fromMinor(amountMinor),
        paidAmount: Number(meta.paidAmount) || 0,
        due: Number(meta.due) || 0,
        status: (meta.status as "UNPAID" | "PARTIAL" | "PAID") || "UNPAID",
      };
    }
  }

  // A courtesy refusal BEFORE the transaction, so an obvious over-payment gets a
  // clean message; the transaction below is the authoritative decision.
  const preview = acceptCollegePayment(charge, { amount: fromMinor(amountMinor) });
  if (!preview.ok) return { ok: false, error: preview.error };

  const stamp = (input.date || new Date()).toISOString();
  // A keyed attempt must be able to hand its receipt back ATOMICALLY, from inside
  // the transaction that accepts it — that stamp is what answers a later attempt
  // with the same key even if it never saw the first reply (the classic dropped
  // response). A keyless payment keeps generating its receipt after the write.
  const receiptNo = key ? collegeReceiptNo() : null;
  const written = await prisma.$guardedUpdate("collegeFee", input.chargeId, (current) => {
    if (!current) return { ok: false, error: "College charge not found." };
    // Same key AGAIN on the SAME charge: nothing is written. `written.holder`
    // below turns this into the first result (a replay) or a 409 (a different
    // amount/method), decided against the row as it is at THIS instant.
    const prior = stampOf(current);
    if (key && ((prior && prior.key === key) || seenKeys(current).includes(key))) {
      return { ok: false, error: COLLEGE_PAYMENT_KEY_TAKEN };
    }
    const decision = acceptCollegePayment(current, { amount: fromMinor(amountMinor) });
    if (!decision.ok) return { ok: false, error: decision.error };
    return {
      ok: true,
      data: {
        paidAmount: decision.paidAmount,
        status: decision.status,
        lastPaidAt: stamp,
        ...(key && receiptNo
          ? {
              idempotencyKeys: [...seenKeys(current), key].slice(-KEY_MEMORY),
              idempotency: {
                key,
                amountMinor,
                method: input.method,
                receiptNo,
                applied: fromMinor(amountMinor),
                paidAmount: decision.paidAmount,
                due: dueOf(current, decision.paidAmount),
                status: decision.status,
                at: stamp,
              },
            }
          : {}),
      },
    };
  });
  if (!written.ok || !written.row) {
    const holder: any = (written as any).holder;
    const prior = stampOf(holder);
    const spent = !!key && seenKeys(holder).includes(key);
    if (prior?.key === key || spent) {
      // The key is already spent on THIS charge: answer from the payment it
      // recorded — the same receipt, the same due, no write at all.
      if (prior?.key === key && Number(prior.amountMinor) === amountMinor && prior.method === input.method) {
        return replayOutcome(input.chargeId, prior);
      }
      return { ok: false, conflict: true, error: COLLEGE_PAYMENT_KEY_CONFLICT };
    }
    return { ok: false, error: written.error || "Payment refused — the charge changed while it was being paid." };
  }

  const previousPaid = Number(written.row.paidAmount) || 0;
  const due = dueOf(written.row, previousPaid);
  const receipt = receiptNo || collegeReceiptNo();
  await postToLedger({
    schoolId: input.schoolId,
    kind: "PAYMENT",
    amount: fromMinor(amountMinor),
    method: input.method,
    refNo: input.refNo || receipt,
    status: "CONFIRMED",
    studentId: charge.studentId ?? null,
    feeId: null,
    actorId: input.actorId || null,
    description: `College payment — ${String(charge.title ?? "charge")}`,
    meta: {
      receiptNo: receipt,
      collegeFeeId: input.chargeId,
      programId: charge.programId ?? null,
      termNumber: charge.termNumber ?? null,
      // 7e-pre — the attempt that wrote this entry, so the entry itself is what a
      // replay is answered from and what `collegePaymentLedgerId` is derived from.
      ...(key
        ? {
            collegePaymentKey: key,
            amountMinor,
            method: input.method,
            paidAmount: previousPaid,
            due,
            status: written.row.status,
          }
        : {}),
    },
  });

  return {
    ok: true,
    ...(key ? { replay: false } : {}),
    receiptNo: receipt,
    chargeId: input.chargeId,
    applied: fromMinor(amountMinor),
    paidAmount: previousPaid,
    due,
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
