import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions";

/** Single invoice for the print page (§12.1). SUPER_ADMIN or the school itself. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;
  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      school: { select: { id: true, name: true, address: true, phone: true, email: true, logoUrl: true } },
      plan: { select: { id: true, name: true, price: true, cycle: true } },
    },
  });
  if (!invoice) return NextResponse.json({ error: "Invoice not found" }, { status: 404 });

  // Only the platform or the invoiced school may view it.
  if (session.role !== "SUPER_ADMIN" && session.schoolId !== invoice.schoolId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  return NextResponse.json({
    data: {
      invoice: {
        id: invoice.id,
        invoiceNo: invoice.invoiceNo,
        amount: invoice.amount,
        status: invoice.status,
        issueDate: invoice.issueDate,
        dueDate: invoice.dueDate,
        periodStart: invoice.periodStart,
        periodEnd: invoice.periodEnd,
        method: invoice.method || null,
        refNo: invoice.refNo || null,
        paidAt: invoice.paidAt || null,
        note: invoice.note || null,
      },
      school: invoice.school,
      plan: invoice.plan,
    },
  });
}
