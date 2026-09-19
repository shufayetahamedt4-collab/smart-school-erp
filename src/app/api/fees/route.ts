import { NextRequest, NextResponse } from "next/server";
import { prisma, schoolReference } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { postToLedger } from "@/lib/ledger";
import { writeGuard } from "@/lib/subscription";

/**
 * All payments for the given fees — now a single school-scoped pull filtered
 * in memory by the caller (kept as a named helper for readability).
 */
async function paymentRowsFor(fees: any[]): Promise<any[]> {
  if (!fees.length) return [];
  const schoolId = fees[0].schoolId;
  const rows = await prisma.payment.findMany({ where: { schoolId } });
  const feeIds = new Set(fees.map((f) => f.id));
  return rows.filter((p: any) => feeIds.has(p.feeId));
}

/** All installments for the given fees — one school-scoped pull (see above). */
async function installmentRowsFor(fees: any[]): Promise<any[]> {
  if (!fees.length) return [];
  const schoolId = fees[0].schoolId;
  const rows = await prisma.installment.findMany({ where: { schoolId } });
  const feeIds = new Set(fees.map((f) => f.id));
  return rows.filter((i: any) => feeIds.has(i.feeId));
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;

  // Identity + role filtering resolved in-memory from memoized reference
  // pulls (was a sequential student findFirst before the main query).
  // NOTE: role branching matches the original exactly — only GUARDIAN and
  // STUDENT are scoped to their own fees; TEACHER and other staff roles see
  // the school-wide list. wantsFull only gates the templates payload.
  const wantsFull = can(session.role, "feePayment", "full");
  let where: any = { schoolId };
  if (session.role === "GUARDIAN" || session.role === "STUDENT") {
    const students = await schoolReference("student", schoolId);
    const student =
      session.role === "GUARDIAN"
        ? session.studentId
          ? students.find((s: any) => s.id === session.studentId)
          : students.find((s: any) => s.guardianUserId === session.id)
        : students.find((s: any) => s.userId === session.id);
    if (!student) return NextResponse.json({ data: { fees: [], settings: null } });
    where.studentId = student.id;
  } else {
    if (sp.get("status")) where.status = sp.get("status");
    if (sp.get("studentId")) where.studentId = sp.get("studentId");
    if (sp.get("q")) {
      where.student = { name: { contains: sp.get("q"), mode: "insensitive" } };
    }
  }

  // ONE wave: fees + settings + templates + payments + installments + the
  // reference maps (payments/installments are school-scoped and filtered to
  // the visible fees in memory — they never depended on the fees result).
  const [feesRaw, settings, templates, paymentRows, installmentRows, studentRows, classRows, sectionRows] = await Promise.all([
    prisma.fee.findMany({ where: { schoolId } }),
    prisma.feeSetting.findUnique({ where: { schoolId } }),
    wantsFull ? prisma.feeTemplate.findMany({ where: { schoolId }, include: { items: true } }) : Promise.resolve([]),
    prisma.payment.findMany({ where: { schoolId } }),
    prisma.installment.findMany({ where: { schoolId } }),
    schoolReference("student", schoolId),
    schoolReference("classRoom", schoolId),
    schoolReference("section", schoolId),
  ]);
  // Role/q filtering that the where-clause used to do — now in memory.
  const q = (sp.get("q") || "").toLowerCase();
  const fees = feesRaw.filter((f: any) => {
    if (where.studentId && f.studentId !== where.studentId) return false;
    if (where.status && f.status !== where.status) return false;
    if (q) {
      const s = studentRows.find((x: any) => x.id === f.studentId);
      if (!s || !String(s.name || "").toLowerCase().includes(q)) return false;
    }
    return true;
  });
  const visibleFeeIds = new Set(fees.map((f: any) => f.id));
  const paymentsByFee = new Map<string, any[]>();
  for (const p of paymentRows) {
    if (!visibleFeeIds.has(p.feeId)) continue;
    const arr = paymentsByFee.get(p.feeId) || [];
    arr.push(p);
    paymentsByFee.set(p.feeId, arr);
  }
  const installmentsByFee = new Map<string, any[]>();
  for (const i of installmentRows) {
    if (!visibleFeeIds.has(i.feeId)) continue;
    const arr = installmentsByFee.get(i.feeId) || [];
    arr.push(i);
    installmentsByFee.set(i.feeId, arr);
  }
  const studentById = new Map(studentRows.map((s) => [s.id, s]));
  const classById = new Map(classRows.map((c) => [c.id, c]));
  const sectionById = new Map(sectionRows.map((s) => [s.id, s]));
  const shaped = fees
    .map((f: any) => {
      const s = f.studentId ? studentById.get(f.studentId) : null;
      return {
        ...f,
        student: s
          ? {
              id: s.id,
              name: s.name,
              admissionNo: s.admissionNo,
              roll: s.roll,
              photoUrl: s.photoUrl,
              classRoom: s.classId ? classById.get(s.classId) || null : null,
              section: s.sectionId ? sectionById.get(s.sectionId) || null : null,
            }
          : null,
        payments: (paymentsByFee.get(f.id) || []).sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime()),
        installments: (installmentsByFee.get(f.id) || []).sort((a: any, b: any) => (a.seq ?? 0) - (b.seq ?? 0)),
      };
    })
    .sort((a: any, b: any) => {
      // orderBy [{ status: "asc" }, { dueDate: "desc" }]
      const st = String(a.status).localeCompare(String(b.status));
      if (st !== 0) return st;
      const ad = a.dueDate ? new Date(a.dueDate).getTime() : 0;
      const bd = b.dueDate ? new Date(b.dueDate).getTime() : 0;
      return bd - ad;
    });
  return NextResponse.json({ data: { fees: shaped, settings, templates } });
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
  const locked = await writeGuard(schoolId);
  if (locked) return locked; // PRD §12.1 — subscription auto-lock
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
