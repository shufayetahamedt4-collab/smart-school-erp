import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { cleanChannels } from "@/lib/fee-channels";

/**
 * School fee defaults (§10.3) plus the payment channels the school collects
 * through (§10.2).
 *
 * The channels are the school's own bKash / Nagad / bank / walk-in details. The
 * Parents App reads them and shows them beside the fee that is due, so a family
 * knows exactly where to send the money. They are staff-maintained: `full` on
 * `feePayment` (SCHOOL_ADMIN, BRANCH_ADMIN, ACCOUNTANT) may read and write.
 */

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

export async function GET() {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const settings = await prisma.feeSetting.findUnique({ where: { schoolId: session.schoolId! } });
  return NextResponse.json({
    data: settings || { monthlyFee: 1500, admissionFee: 5000, channels: [], paymentNote: null },
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);

  // Only touch the keys the caller actually sent — the Fees page's settings
  // dialog posts { monthlyFee, admissionFee, channels, … } back, and a partial
  // write must never blank the rest.
  const update: Record<string, any> = {};
  if (body?.monthlyFee !== undefined) update.monthlyFee = num(body.monthlyFee, 1500);
  if (body?.admissionFee !== undefined) update.admissionFee = num(body.admissionFee, 5000);
  if (body?.channels !== undefined) update.channels = cleanChannels(body.channels);
  if (body?.paymentNote !== undefined) {
    const note = body.paymentNote === null ? null : String(body.paymentNote).slice(0, 500);
    update.paymentNote = note && note.trim() ? note.trim() : null;
  }

  const settings = await prisma.feeSetting.upsert({
    where: { schoolId },
    update,
    create: {
      schoolId,
      monthlyFee: num(body?.monthlyFee, 1500),
      admissionFee: num(body?.admissionFee, 5000),
      channels: cleanChannels(body?.channels),
      paymentNote: body?.paymentNote ? String(body.paymentNote).trim().slice(0, 500) : null,
    },
  });
  await audit("FEE_SETTINGS_UPDATE", "school", schoolId, { fields: Object.keys(update) });
  return NextResponse.json({ data: settings });
}
