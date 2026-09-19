import { NextResponse } from "next/server";
import { prisma } from "./db";
import { notifyUsers } from "./notify";

/**
 * PRD §12.1 — Subscription & Billing (Super Admin).
 *
 * Plans are platform-level records (Trial/Basic/Premium) with student limits.
 * Each school holds one subscription: TRIAL → ACTIVE → GRACE → LOCKED.
 * After the grace period the school's write routes get 402 (data is never
 * deleted — PRD: "Auto-lock after Trial ends (with grace period; data will
 * not be deleted)"). Invoices are generated on assignment/renewal and
 * recorded as PAID manually by the Super Admin (bank/cash — platform-level
 * billing, no gateway; §2.1 "Platform-level billing").
 */

export const DEFAULT_TRIAL_DAYS = 14;
export const DEFAULT_GRACE_DAYS = 7;

export type SubStatus = "TRIAL" | "ACTIVE" | "GRACE" | "PAST_DUE" | "LOCKED" | "CANCELLED" | "EXPIRED";

export interface SubscriptionState {
  status: SubStatus | "NONE";
  /** school may perform writes (create/update) */
  canWrite: boolean;
  planName: string | null;
  maxStudents: number | null;
  currentPeriodEnd: Date | null;
  /** days left in current period/grace (negative = overdue) */
  daysLeft: number | null;
  trial: boolean;
}

const DAY = 86400000;

/** Compute the current state of a school's subscription. */
export async function getSubscriptionState(schoolId: string): Promise<SubscriptionState> {
  const sub = await prisma.subscription.findFirst({
    where: { schoolId },
    orderBy: { createdAt: "desc" },
    include: { plan: { select: { id: true, name: true, maxStudents: true } } },
  });
  if (!sub) {
    // No subscription record → treat as unlimited (backwards compat for
    // schools created before §12.1). Super Admin can assign a plan anytime.
    return { status: "NONE", canWrite: true, planName: null, maxStudents: null, currentPeriodEnd: null, daysLeft: null, trial: false };
  }

  const now = Date.now();
  const periodEnd = sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd as any).getTime() : null;
  const graceEndRaw = (sub as any).graceEndsAt ? new Date((sub as any).graceEndsAt as any).getTime() : null;
  const graceEnd = graceEndRaw ?? (periodEnd !== null ? periodEnd + DEFAULT_GRACE_DAYS * DAY : null);

  let status = (sub.status as SubStatus) || "TRIAL";
  let canWrite = true;
  let daysLeft: number | null = null;

  if (status === "CANCELLED") {
    canWrite = false;
  } else if (periodEnd !== null) {
    daysLeft = Math.ceil((periodEnd - now) / DAY);
    if (now >= periodEnd) {
      if (graceEnd !== null && now >= graceEnd) {
        status = "LOCKED";
        canWrite = false;
      } else if (status === "ACTIVE" || status === "TRIAL" || status === "PAST_DUE") {
        status = "GRACE";
        canWrite = false;
      }
    }
  } else if (status === "LOCKED" || status === "EXPIRED") {
    canWrite = false;
  }

  return {
    status,
    canWrite,
    planName: sub.plan?.name || null,
    maxStudents: sub.plan?.maxStudents ?? null,
    currentPeriodEnd: sub.currentPeriodEnd ? new Date(sub.currentPeriodEnd as any) : null,
    daysLeft,
    trial: status === "TRIAL",
  };
}

/**
 * Throw when a school tries to write while past grace/locked (PRD §12.1).
 * Called from mutating API routes for tenant-owned writes.
 */
export async function assertSchoolCanWrite(schoolId: string): Promise<SubscriptionState> {
  const state = await getSubscriptionState(schoolId);
  if (!state.canWrite) {
    const err = new Error(
      state.status === "LOCKED"
        ? "Subscription expired — school account is locked. Contact the platform administrator to renew."
        : "Subscription period ended — school is in the grace period. Renew to continue making changes."
    ) as Error & { status: number };
    err.status = 402; // Payment Required
    throw err;
  }
  return state;
}

/** Soft warning (banner) — non-throwing variant for UI/state checks. */
export async function subscriptionStateForSession(schoolId: string | null | undefined): Promise<SubscriptionState | null> {
  if (!schoolId) return null;
  try {
    return await getSubscriptionState(schoolId);
  } catch {
    return null;
  }
}

/**
 * Route-friendly write guard: returns a 402 response when the school is
 * past grace/locked, or null when writes are allowed. Used at the top of
 * tenant-scoped mutating API routes (PRD §12.1 auto-lock).
 */
export async function writeGuard(schoolId: string | null | undefined): Promise<NextResponse | null> {
  if (!schoolId) return null;
  try {
    await assertSchoolCanWrite(schoolId);
    return null;
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Subscription expired" }, { status: 402 });
  }
}

/* ------------------------------------------------------------------ invoices */

function invoiceNo(): string {
  return `INV-${new Date().getFullYear()}-${Date.now().toString().slice(-8)}`;
}

/**
 * Generate the platform invoice for a subscription period (§12.1).
 * Amount = plan price; period = one cycle from `start`.
 */
export async function generateInvoice(input: {
  schoolId: string;
  planId: string;
  amount: number;
  cycle: "MONTHLY" | "YEARLY";
  start?: Date;
  note?: string;
}) {
  const start = input.start || new Date();
  const end = new Date(start);
  if (input.cycle === "YEARLY") end.setFullYear(end.getFullYear() + 1);
  else end.setMonth(end.getMonth() + 1);

  return prisma.invoice.create({
    data: {
      schoolId: input.schoolId,
      planId: input.planId,
      invoiceNo: invoiceNo(),
      amount: input.amount,
      status: "UNPAID",
      issueDate: start,
      dueDate: new Date(start.getTime() + 7 * DAY),
      periodStart: start,
      periodEnd: end,
      note: input.note || null,
    },
  });
}

/* ------------------------------------------------------------------ lifecycle */

/**
 * Assign/switch a school's plan. Creates the subscription (or updates it),
 * extends the period, and issues the invoice for the new cycle.
 */
export async function assignPlan(input: {
  schoolId: string;
  planId: string;
  actorId: string;
  cycle?: "MONTHLY" | "YEARLY";
}) {
  const plan = await prisma.plan.findUnique({ where: { id: input.planId } });
  if (!plan) throw new Error("Plan not found");

  const cycle = input.cycle || (plan as any).cycle || "MONTHLY";
  const now = new Date();
  const periodEnd = new Date(now);
  if (cycle === "YEARLY") periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  else periodEnd.setMonth(periodEnd.getMonth() + 1);

  const isTrial = String(plan.name).toLowerCase() === "trial" || Number(plan.price) === 0;

  // Firestore-backed upsert has no deterministic id for subscriptions —
  // find-then-update/create keeps exactly one subscription per school.
  const existing = await prisma.subscription.findFirst({ where: { schoolId: input.schoolId } });
  const sub = existing
    ? await prisma.subscription.update({
        where: { id: existing.id },
        data: { planId: plan.id, status: "ACTIVE", cycle, currentPeriodEnd: periodEnd },
      })
    : await prisma.subscription.create({
        data: {
          schoolId: input.schoolId,
          planId: plan.id,
          status: isTrial ? "TRIAL" : "ACTIVE",
          cycle,
          startedAt: now,
          currentPeriodEnd: periodEnd,
        },
      });

  const invoice = await generateInvoice({
    schoolId: input.schoolId,
    planId: plan.id,
    amount: Number(plan.price) || 0,
    cycle,
    start: now,
    note: isTrial ? "Trial period" : `${plan.name} plan — ${cycle.toLowerCase()} cycle`,
  });

  // Notify the school's admins that the plan was applied
  const admins = await prisma.user.findMany({
    where: { schoolId: input.schoolId, role: { in: ["SCHOOL_ADMIN", "ACCOUNTANT"] } },
    select: { id: true },
  });
  if (admins.length) {
    await notifyUsers({
      schoolId: input.schoolId,
      userIds: admins.map((a) => a.id),
      event: "NOTICE_PUBLISHED",
      title: isTrial ? `Trial started — ${plan.name} plan` : `Subscription updated — ${plan.name} plan`,
      body: isTrial
        ? `Your trial runs until ${periodEnd.toDateString()}.`
        : `New billing period until ${periodEnd.toDateString()}. Invoice ${invoice.invoiceNo}.`,
      link: "/dashboard",
    });
  }

  return { subscription: sub, invoice };
}

/** Renew the current plan (extend period + invoice). */
export async function renewSubscription(schoolId: string, actorId: string) {
  const sub = await prisma.subscription.findFirst({ where: { schoolId }, orderBy: { createdAt: "desc" } });
  if (!sub) throw new Error("No subscription to renew — assign a plan first.");
  const plan = await prisma.plan.findUnique({ where: { id: sub.planId } });
  if (!plan) throw new Error("Plan missing for this subscription.");

  const base = sub.currentPeriodEnd && new Date(sub.currentPeriodEnd as any) > new Date() ? new Date(sub.currentPeriodEnd as any) : new Date();
  const cycle = (sub.cycle as "MONTHLY" | "YEARLY") || "MONTHLY";
  const periodEnd = new Date(base);
  if (cycle === "YEARLY") periodEnd.setFullYear(periodEnd.getFullYear() + 1);
  else periodEnd.setMonth(periodEnd.getMonth() + 1);

  await prisma.subscription.update({
    where: { id: sub.id },
    data: { status: "ACTIVE", currentPeriodEnd: periodEnd },
  });

  const invoice = await generateInvoice({
    schoolId,
    planId: plan.id,
    amount: Number(plan.price) || 0,
    cycle,
    start: base,
    note: `Renewal — ${plan.name} plan`,
  });

  const admins = await prisma.user.findMany({
    where: { schoolId, role: { in: ["SCHOOL_ADMIN", "ACCOUNTANT"] } },
    select: { id: true },
  });
  if (admins.length) {
    await notifyUsers({
      schoolId,
      userIds: admins.map((a) => a.id),
      event: "NOTICE_PUBLISHED",
      title: "Subscription renewed",
      body: `New period ends ${periodEnd.toDateString()}. Invoice ${invoice.invoiceNo}.`,
      link: "/dashboard",
    });
  }

  return { periodEnd, invoice };
}
