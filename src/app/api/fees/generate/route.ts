import { NextRequest, NextResponse } from "next/server";
import { prisma, generatedFeeId } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";
import { postToLedger } from "@/lib/ledger";
import { money } from "@/lib/utils";

/**
 * Bill a fee category across the classes it is priced for.
 *
 *   POST { categoryIds: string[], classIds?: string[], period?: "2026-10",
 *          dueDate?: ISO, dryRun?: boolean }
 *
 * This is the bridge between the catalogue (§10.3) and the money the guardians
 * pay: every row it writes is an ordinary `fee`, so it shows up in the Fees
 * page, in the parent app, in the student's dues and in the central ledger
 * without any of those reading anything new.
 *
 * It is deliberately idempotent. A (student, category, period) triple is billed
 * at most once, so running "October" twice tops up the students who enrolled
 * late instead of double-charging everybody. Pass `dryRun` to preview the exact
 * list before a single row is written.
 *
 * The period is validated against each category's `frequency` — a YEARLY head
 * is billed for a year ("2026"), a MONTHLY head for a month ("2026-10") — and
 * a mismatch is skipped and reported, not billed. That is the guard against
 * the yearly-trip fee that once landed on the books twice.
 *
 * Two things keep that promise. The skip list below is a read taken before the
 * write loop, so on its own it is a check-then-act race: two overlapping
 * submissions (a double-clicked Generate button, two admins on the same period)
 * would both find nothing and both bill. The second is the row's identity —
 * `generatedFeeId` gives every (student, category, period) the same document id
 * — so even if both get past the check, they write ONE row. The per-row
 * `findUnique` below is a direct document read, never a cached list, so it also
 * catches a bill raised out of band while this request was planning.
 */

/** The month a bill belongs to, e.g. "2026-10". */
function defaultPeriod(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * The period shape each cadence bills under. A YEARLY head billed under a
 * monthly period is not a technicality — it is exactly how the demo school
 * came to owe "Yearly Study Tour 2026" twice (once for `2026`, once for
 * `2026-09`, both on the books). The period must match the cadence or the
 * category is skipped and reported, never half-billed.
 */
function periodShapeOk(frequency: string | undefined, period: string): boolean {
  const freq = frequency || "MONTHLY"; // fee-categories POST defaults to MONTHLY
  if (freq === "MONTHLY") return /^\d{4}-(0[1-9]|1[0-2])$/.test(period);
  if (freq === "YEARLY") return /^\d{4}$/.test(period);
  // WEEKLY / TERM / ONE_TIME have no fixed period convention — the field is a
  // free-form label for them ("2026-09" for a one-off September event is fine).
  return true;
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;

  const body = await req.json().catch(() => ({}));
  const dryRun = !!body?.dryRun;
  const period = String(body?.period || "").trim() || defaultPeriod();
  const categoryIds: string[] = Array.isArray(body?.categoryIds) ? body.categoryIds.filter(Boolean) : [];
  const classIds: string[] = Array.isArray(body?.classIds) ? body.classIds.filter(Boolean) : [];

  // A preview writes nothing, so it must not be blocked by the subscription lock.
  if (!dryRun) {
    const locked = await writeGuard(schoolId);
    if (locked) return locked; // PRD §12.1 — subscription auto-lock
  }

  const [categories, students, existingFees] = await Promise.all([
    prisma.feeCategory.findMany({ where: { schoolId } }),
    prisma.student.findMany({ where: { schoolId } }),
    prisma.fee.findMany({ where: { schoolId } }),
  ]);

  // Only active categories, and only the ones the caller picked. A branch-scoped
  // user can only bill their own branch's categories.
  const selected = categories.filter(
    (c: any) =>
      c.active !== false &&
      (!categoryIds.length || categoryIds.includes(c.id)) &&
      (!session.branchId || !c.branchId || c.branchId === session.branchId)
  );

  const enrolled = students.filter(
    (s: any) =>
      s.active !== false &&
      s.classId &&
      (!session.branchId || !s.branchId || s.branchId === session.branchId)
  );

  // (studentId|categoryId|period) triples already on the books.
  const alreadyBilled = new Set(
    existingFees.map((f: any) => `${f.studentId}|${f.categoryId}|${f.period}`)
  );

  const plan: {
    categoryId: string;
    categoryName: string;
    bucket: string;
    studentId: string;
    studentName: string;
    classId: string;
    branchId: string | null;
    amount: number;
  }[] = [];
  const mismatched: { id: string; name: string; frequency: string; period: string }[] = [];
  let skipped = 0;

  for (const cat of selected) {
    if (!periodShapeOk(cat.frequency, period)) {
      mismatched.push({ id: cat.id, name: cat.name, frequency: cat.frequency || "MONTHLY", period });
      continue;
    }
    const amounts = (cat.amounts || {}) as Record<string, number>;
    for (const [classId, rawAmount] of Object.entries(amounts)) {
      if (classIds.length && !classIds.includes(classId)) continue;
      const amount = money(rawAmount);
      if (!(amount > 0)) continue;
      for (const s of enrolled) {
        if (s.classId !== classId) continue;
        if (alreadyBilled.has(`${s.id}|${cat.id}|${period}`)) {
          skipped++;
          continue;
        }
        plan.push({
          categoryId: cat.id,
          categoryName: cat.name,
          bucket: cat.bucket || "OTHER",
          studentId: s.id,
          studentName: s.name,
          classId,
          branchId: s.branchId || cat.branchId || null,
          amount,
        });
      }
    }
  }

  if (dryRun) {
    return NextResponse.json({
      data: { dryRun: true, period, wouldBill: plan.length, skipped, mismatched, total: plan.reduce((a, p) => a + p.amount, 0), plan },
    });
  }

  const dueDate = body?.dueDate ? new Date(body.dueDate) : null;
  let created = 0;
  for (const p of plan) {
    // The id this row will get. A hit here means the triple is already billed —
    // by a concurrent submission, or by a row this request's earlier read did
    // not see — so skip instead of writing, and never touch the existing fee
    // (it may already carry payments).
    const feeId = generatedFeeId(p.studentId, p.categoryId, period);
    if (await prisma.fee.findUnique({ where: { id: feeId }, select: { id: true } })) {
      skipped++;
      continue;
    }
    const title = `${p.categoryName} — ${period}`;
    const fee = await prisma.fee.create({
      data: {
        id: feeId,
        schoolId,
        branchId: p.branchId,
        studentId: p.studentId,
        title,
        amount: p.amount,
        // Explicit, never absent — see the ৳0-totals fix: a fee row without
        // paidAmount zeroes every total in the app.
        paidAmount: 0,
        status: "UNPAID",
        feeType: p.bucket,
        dueDate,
        categoryId: p.categoryId,
        period,
      },
    });
    await postToLedger({
      schoolId,
      kind: "FEE",
      amount: p.amount,
      status: "CONFIRMED",
      studentId: p.studentId,
      feeId: fee.id,
      actorId: session.id,
      description: `Fee billed: ${title}`,
    });
    created++;
  }

  if (created) invalidateStats(schoolId, "all"); // also drops the read cache
  await audit("FEE_GENERATE", "feeCategory", categoryIds.join(",") || undefined, { period, created, skipped, mismatched: mismatched.length });
  return NextResponse.json({ data: { period, created, skipped, mismatched } });
}
