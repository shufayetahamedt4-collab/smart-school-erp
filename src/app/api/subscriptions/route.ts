import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { assignPlan, renewSubscription } from "@/lib/subscription";

/**
 * PRD §12.1 — School subscriptions (Super Admin).
 * GET  → all subscriptions with school + plan
 * POST → assign/switch a school's plan (auto-invoices the cycle)
 * PATCH→ mark latest invoice paid / renewal
 */
export async function GET() {
  const session = await getSession();
  if (!session || !can(session.role, "platformBilling", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const subs = await prisma.subscription.findMany({
    include: {
      school: { select: { id: true, name: true, slug: true, status: true } },
      plan: { select: { id: true, name: true, price: true, maxStudents: true } },
    },
    orderBy: { createdAt: "desc" },
  });
  const invoices = await prisma.invoice.findMany({
    include: { school: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  return NextResponse.json({ data: { subscriptions: subs, invoices } });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "platformBilling", "billing")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const schoolId = String(body?.schoolId || "");
  const planId = String(body?.planId || "");
  if (!schoolId || !planId) return NextResponse.json({ error: "schoolId and planId are required." }, { status: 400 });

  try {
    const result = await assignPlan({ schoolId, planId, actorId: session.id, cycle: body?.cycle });
    await audit("SUBSCRIPTION_ASSIGN", "subscription", result.subscription.id, { schoolId, planId });
    return NextResponse.json({ data: result }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Failed to assign plan." }, { status: 400 });
  }
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "platformBilling", "billing")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);

  // Mark an invoice paid (manual platform-level billing: bank/cash)
  if (body?.invoiceId) {
    const invoice = await prisma.invoice.findUnique({ where: { id: String(body.invoiceId) } });
    if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

    const status = String(body?.status || "PAID").toUpperCase();
    const validStatus = ["PAID", "UNPAID", "PENDING", "OVERDUE"];
    if (!validStatus.includes(status)) {
      return NextResponse.json({ error: "Invalid invoice status." }, { status: 400 });
    }

    const updated = await prisma.invoice.update({
      where: { id: invoice.id },
      data: {
        status,
        paidAt: status === "PAID" ? new Date() : null,
        method: body.method ? String(body.method) : invoice.method || "BANK",
        refNo: body.refNo ? String(body.refNo) : invoice.refNo || null,
      },
    });

    if (status === "PAID") {
      await prisma.subscription.updateMany({
        where: { schoolId: invoice.schoolId },
        data: { status: "ACTIVE" },
      });
    }

    await audit("INVOICE_MARK_PAID", "invoice", invoice.id, { method: updated.method, status });
    return NextResponse.json({ data: updated });
  }

  // Renew a school's subscription (extends period + generates invoice)
  if (body?.schoolId) {
    try {
      const result = await renewSubscription(String(body.schoolId), session.id);
      await audit("SUBSCRIPTION_RENEW", "subscription", String(body.schoolId), { periodEnd: result.periodEnd });
      return NextResponse.json({ data: result });
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || "Renewal failed." }, { status: 400 });
    }
  }

  return NextResponse.json({ error: "Nothing to do — send invoiceId or schoolId." }, { status: 400 });
}
