import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const settings = await prisma.feeSetting.findUnique({ where: { schoolId: session.schoolId! } });
  return NextResponse.json({ data: settings || { monthlyFee: 1500, admissionFee: 5000 } });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const settings = await prisma.feeSetting.upsert({
    where: { schoolId },
    update: {
      monthlyFee: body?.monthlyFee !== undefined ? Number(body.monthlyFee) : undefined,
      admissionFee: body?.admissionFee !== undefined ? Number(body.admissionFee) : undefined,
    },
    create: {
      schoolId,
      monthlyFee: Number(body?.monthlyFee || 1500),
      admissionFee: Number(body?.admissionFee || 5000),
    },
  });
  await audit("FEE_SETTINGS_UPDATE", "school", schoolId);
  return NextResponse.json({ data: settings });
}
