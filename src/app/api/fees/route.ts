import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { postToLedger } from "@/lib/ledger";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;

  let where: any = { schoolId };
  if (session.role === "GUARDIAN") {
    const studentId = session.studentId || (await prisma.student.findFirst({ where: { guardianUserId: session.id } }))?.id;
    if (!studentId) return NextResponse.json({ data: { fees: [], settings: null } });
    where.studentId = studentId;
  } else if (session.role === "STUDENT") {
    const studentId = (await prisma.student.findFirst({ where: { userId: session.id } }))?.id;
    if (!studentId) return NextResponse.json({ data: { fees: [], settings: null } });
    where.studentId = studentId;
  } else {
    if (sp.get("status")) where.status = sp.get("status");
    if (sp.get("studentId")) where.studentId = sp.get("studentId");
    if (sp.get("q")) {
      where.student = { name: { contains: sp.get("q"), mode: "insensitive" } };
    }
  }

  const fees = await prisma.fee.findMany({
    where,
    include: {
      student: { select: { id: true, name: true, admissionNo: true, roll: true, photoUrl: true, classRoom: { select: { name: true } }, section: { select: { name: true } } } },
      payments: { orderBy: { date: "desc" } },
      installments: { orderBy: { seq: "asc" } },
    },
    orderBy: [{ status: "asc" }, { dueDate: "desc" }],
  });

  const settings = await prisma.feeSetting.findUnique({ where: { schoolId } });
  const templates = can(session.role, "feePayment", "full")
    ? await prisma.feeTemplate.findMany({ where: { schoolId }, include: { items: true } })
    : [];
  return NextResponse.json({ data: { fees, settings, templates } });
}

/**
 * Create a fee (admin/accountant). Supports template-based line items and
 * installment plans; every creation posts a FEE entry to the central ledger.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const { studentId, title, amount, feeType, dueDate } = body || {};
  if (!studentId || !title || !amount) {
    return NextResponse.json({ error: "Student, title and amount are required." }, { status: 400 });
  }

  const fee = await prisma.fee.create({
    data: {
      schoolId,
      studentId,
      title: String(title),
      amount: Number(amount),
      feeType: feeType || "OTHER",
      dueDate: dueDate ? new Date(dueDate) : null,
      note: body?.note || null,
    },
  });

  // Optional installment plan (PRD §10.3)
  const installments: { seq: number; amount: number; dueDate?: string }[] = body?.installments || [];
  if (installments.length > 0) {
    let seq = 1;
    for (const inst of installments) {
      await prisma.installment.create({
        data: {
          schoolId,
          feeId: fee.id,
          studentId,
          seq: seq++,
          amount: Number(inst.amount),
          dueDate: inst.dueDate ? new Date(inst.dueDate) : null,
          status: "PENDING",
        },
      });
    }
  }

  await postToLedger({
    schoolId,
    kind: "FEE",
    amount: Number(amount),
    status: "CONFIRMED",
    studentId,
    feeId: fee.id,
    actorId: session.id,
    description: `Fee created: ${title}`,
  });
  await audit("FEE_CREATE", "fee", fee.id, { title });
  return NextResponse.json({ data: fee }, { status: 201 });
}
