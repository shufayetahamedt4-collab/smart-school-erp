import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const amount = Number(body?.amount);
  if (!amount || amount <= 0) return NextResponse.json({ error: "Invalid payment amount." }, { status: 400 });

  const fee = await prisma.fee.findUnique({ where: { id } });
  if (!fee || fee.schoolId !== schoolId) return NextResponse.json({ error: "Fee not found" }, { status: 404 });

  const newPaid = Math.min(Number(fee.amount), Number(fee.paidAmount) + amount);
  const status = newPaid >= Number(fee.amount) ? "PAID" : "PARTIAL";
  const receiptNo = `RCP-${Date.now().toString().slice(-8)}`;

  await prisma.$transaction(async (tx) => {
    await tx.fee.update({ where: { id }, data: { paidAmount: newPaid, status } });
    await tx.payment.create({
      data: {
        schoolId,
        studentId: fee.studentId,
        feeId: id,
        amount,
        method: body?.method || "CASH",
        refNo: body?.refNo || null,
        receiptNo,
        date: body?.date ? new Date(body.date) : new Date(),
      },
    });
  });

  await audit("FEE_PAYMENT", "fee", id, { amount, receiptNo });
  return NextResponse.json({ data: { ok: true, status, receiptNo } });
}
