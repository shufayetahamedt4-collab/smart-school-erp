import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { notifyUsers, sendSms } from "@/lib/notify";
import { applyLateFees } from "@/lib/ledger";

/**
 * PRD §10.4 — Automatic due-date reminders (Push + SMS).
 * POST /api/fees/reminders       → run reminders for fees due within N days
 * POST ?applyLateFees=1&amount=… → apply late fees (§10.3, idempotent)
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => ({}));
  const daysAhead = Math.min(Number(body?.daysAhead || 3), 30);
  const within = new Date(Date.now() + daysAhead * 86400000);

  const fees = await prisma.fee.findMany({
    where: { schoolId, status: { not: "PAID" }, dueDate: { lte: within, gte: new Date() } },
    include: { student: { select: { id: true, name: true, guardianUserId: true, guardianPhone: true } } },
  });

  let notified = 0;
  for (const fee of fees) {
    const guardianUserId = fee.student.guardianUserId;
    if (!guardianUserId) continue;
    await notifyUsers({
      schoolId,
      userIds: [guardianUserId],
      event: "FEE_DUE_REMINDER",
      title: `Fee due: ${fee.title}`,
      body: `${fee.title} for ${fee.student.name} is due ${fee.dueDate ? new Date(fee.dueDate).toLocaleDateString() : "soon"}.`,
      link: "/parent/fees",
      push: true,
    });
    if (fee.student.guardianPhone) {
      await sendSms(
        schoolId,
        fee.student.guardianPhone,
        `Reminder: ${fee.title} (${fee.student.name}) due on ${fee.dueDate ? new Date(fee.dueDate).toLocaleDateString() : "soon"}.`,
        fee.student.id
      );
    }
    notified++;
  }

  // Optional late-fee application (§10.3)
  let lateFeesApplied = 0;
  if (body?.applyLateFees) {
    const amount = Number(body?.lateFeeAmount || 50);
    lateFeesApplied = await applyLateFees(schoolId, amount);
  }

  await audit("FEE_REMINDERS_SENT", "fee", undefined, { notified, lateFeesApplied });
  return NextResponse.json({ data: { notified, lateFeesApplied, scanned: fees.length } });
}
