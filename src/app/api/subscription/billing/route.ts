import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { getSubscriptionState, studentUsageFor } from "@/lib/subscription";

/**
 * PRD §12.1 — school-side billing endpoint.
 * Returns the school's own subscription, plan, usage vs. student cap and its
 * platform invoices (§2.1 keeps invoicing platform-level; schools are viewers,
 * they cannot edit subscription records).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // School context: SCHOOL_ADMIN/ACCOUNTANT of their own school, or a
  // SUPER_ADMIN peeking with ?schoolId= (read-only).
  let schoolId: string | null = session.schoolId;
  if (session.role === "SUPER_ADMIN") {
    schoolId = req.nextUrl.searchParams.get("schoolId") ?? session.schoolId;
  }
  if (!schoolId) return NextResponse.json({ data: null });

  const allowed =
    session.role === "SUPER_ADMIN" ||
    can(session.role, "platformBilling", "view") ||
    can(session.role, "systemSettings", "view");
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const [state, usage, sub, invoices] = await Promise.all([
    getSubscriptionState(schoolId),
    studentUsageFor(schoolId),
    prisma.subscription.findFirst({
      where: { schoolId },
      orderBy: { createdAt: "desc" },
      include: {
        plan: { select: { id: true, name: true, price: true, cycle: true, maxStudents: true, features: true } },
      },
    }),
    prisma.invoice.findMany({ where: { schoolId }, orderBy: { createdAt: "desc" }, take: 50 }),
  ]);

  return NextResponse.json({
    data: {
      status: state.status,
      daysLeft: state.daysLeft,
      usage,
      subscription: sub
        ? {
            id: sub.id,
            cycle: sub.cycle,
            currentPeriodEnd: sub.currentPeriodEnd,
            plan: sub.plan,
          }
        : null,
      invoices: invoices.map((i: any) => ({
        id: i.id,
        invoiceNo: i.invoiceNo,
        amount: i.amount,
        status: i.status,
        issueDate: i.issueDate,
        dueDate: i.dueDate,
        paidAt: i.paidAt ?? null,
        method: i.method ?? null,
        refNo: i.refNo ?? null,
        note: i.note ?? null,
      })),
    },
  });
}
