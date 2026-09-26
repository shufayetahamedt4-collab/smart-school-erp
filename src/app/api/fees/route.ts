import { NextRequest, NextResponse } from "next/server";
import { prisma, schoolReference } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { postToLedger } from "@/lib/ledger";
import { writeGuard } from "@/lib/subscription";
import { money } from "@/lib/utils";

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
  // Branch scoping (PRD §12.3): branch admins/registrars only see their branch's fees.
  if (session.scope === "BRANCH" && session.branchId) {
    where.branchId = session.branchId;
  }
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

  // Monitoring drill-down (PRD §12.3): the main admin may filter the list to
  // one branch via ?branchId=. Fees carry their branch; legacy rows fall back
  // to the owning student's branch.
  const drillBranch =
    sp.get("branchId") && (session.role === "SCHOOL_ADMIN" || session.role === "SUPER_ADMIN")
      ? sp.get("branchId")!
      : null;
  let drillStudentIds: Set<string> | null = null;
  if (drillBranch) {
    const bStudents = await prisma.student.findMany({ where: { schoolId, branchId: drillBranch }, select: { id: true } });
    drillStudentIds = new Set(bStudents.map((s) => s.id));
  }

  // ONE wave: fees + settings + templates + payments + the reference maps
  // (payments are school-scoped and filtered to the visible fees in memory
  // — they never depended on the fees result). Installments are NOT emitted:
  // the pre-sweep include was silently dropped by the old db layer (no
  // fee→installments relation in its registry), so parity = absent key.
  const [feesRaw, settings, templates, paymentRows, studentRows, classRows, sectionRows] = await Promise.all([
    prisma.fee.findMany({ where: { schoolId } }),
    prisma.feeSetting.findUnique({ where: { schoolId } }),
    wantsFull ? prisma.feeTemplate.findMany({ where: { schoolId }, include: { items: true } }) : Promise.resolve([]),
    prisma.payment.findMany({ where: { schoolId } }),
    schoolReference("student", schoolId),
    schoolReference("classRoom", schoolId),
    schoolReference("section", schoolId),
  ]);
  // Role/q filtering that the where-clause used to do — now in memory.
  const q = (sp.get("q") || "").toLowerCase();
  const fees = feesRaw.filter((f: any) => {
    if (where.studentId && f.studentId !== where.studentId) return false;
    if (where.status && f.status !== where.status) return false;
    // Branch scoping (PRD §12.3) — with the same legacy fallback as the
    // drill-down: a fee belongs to the branch if it is tagged to it or its
    // student is (rows created before the multi-branch feature are untagged).
    if (where.branchId) {
      const s = studentRows.find((x: any) => x.id === f.studentId);
      if (f.branchId !== where.branchId && s?.branchId !== where.branchId) return false;
    }
    if (drillStudentIds && !drillStudentIds.has(f.studentId) && f.branchId !== drillBranch) return false;
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
  const studentById = new Map(studentRows.map((s) => [s.id, s]));
  const classById = new Map(classRows.map((c) => [c.id, c]));
  const sectionById = new Map(sectionRows.map((s) => [s.id, s]));
  const shaped = fees
    .map((f: any) => {
      const s = f.studentId ? studentById.get(f.studentId) : null;
      // Shape-parity with the pre-sweep include selects: classRoom/section
      // carry { name } only, and the installments key is omitted (the old
      // db layer dropped that unknown include).
      // Money leaves this route as numbers. Rows written before paidAmount was
      // set (and CSV imports) carry null or no key at all; a consumer that sums
      // them turns the total into NaN and prints ৳0 — on the fees page that read
      // "৳0 collected" for a school with ৳91,200 in. Normalize once, here.
      const out: any = {
        ...f,
        amount: money(f.amount),
        paidAmount: money(f.paidAmount),
        student: s
          ? {
              id: s.id,
              name: s.name,
              admissionNo: s.admissionNo,
              roll: s.roll,
              photoUrl: s.photoUrl,
              classRoom: s.classId ? (() => { const c: any = classById.get(s.classId); return c ? { name: c.name } : null; })() : null,
              section: s.sectionId ? (() => { const x: any = sectionById.get(s.sectionId); return x ? { name: x.name } : null; })() : null,
            }
          : null,              payments: (paymentsByFee.get(f.id) || []).sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime()),
      };
      return out;
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

  // The fee inherits its student's branch so branch monitoring stays exact
  // even for fees created before the multi-branch feature.
  const owner = await prisma.student.findUnique({ where: { id: studentId }, select: { branchId: true } });

  const fee = await prisma.fee.create({
    data: {
      schoolId,
      studentId,
      branchId: owner?.branchId || null,
      title: String(title),
      amount: Number(amount),
      // Explicit 0, never absent: a brand-new fee is by definition unpaid, and a
      // missing key is what made totals across the app read ৳0.
      paidAmount: 0,
      status: "UNPAID",
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
