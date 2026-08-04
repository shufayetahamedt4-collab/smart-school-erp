import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "GUARDIAN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;

  let where: any = { schoolId };
  if (session.role === "GUARDIAN") {
    const studentId = session.studentId || (await prisma.student.findFirst({ where: { guardianUserId: session.id } }))?.id;
    if (!studentId) return NextResponse.json({ data: [] });
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
    },
    orderBy: [{ status: "asc" }, { dueDate: "desc" }],
  });

  const settings = await prisma.feeSetting.findUnique({ where: { schoolId } });
  return NextResponse.json({ data: { fees, settings } });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
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
  await audit("FEE_CREATE", "fee", fee.id, { title });
  return NextResponse.json({ data: fee }, { status: 201 });
}
