import { NextRequest, NextResponse } from "next/server";
import { prisma } from "./db";
import { canAccessBranch, scopeWhere } from "./permissions";
import type { SessionUser } from "./auth";
import {
  COLLEGE_FEES_AWARD_APPROVAL_REFUSAL,
  COLLEGE_FEES_READ_REFUSAL,
  COLLEGE_FEES_WRITE_REFUSAL,
  canDecideCollegeFeeAward,
  canReadCollegeFees,
  canWriteCollegeFees,
} from "./college-fees-access";
import {
  applyCollegeDiscounts,
  collegeTermLabel,
  deriveCollegeCharges,
  duesStatus,
  fromMinor,
  isApprovedRegistration,
  isValidCollegeTermNumber,
  normalizeCollegeFeeConfig,
  resolveCollegeFeeSettings,
  roundMoney,
  safeMoney,
  toMinor,
  type CollegeCharge,
  type CollegeFeeConfig,
} from "./college-fees";

/**
 * College fees — the SERVER half of Phase 7c (docs/COLLEGE-DECISIONS.md §24).
 *
 * The pure arithmetic is `src/lib/college-fees.ts` (7a), the access rule is
 * `src/lib/college-fees-access.ts` (D-7-18) and the storage is the four
 * `collegeFee*` collections (7b). This module joins them, so the eight
 * `/api/college-fees/…` handlers stay thin and cannot drift apart on the two
 * things that must never be re-implemented: the guard ORDER and the way a charge
 * set is derived from an enrolment.
 *
 * **The guard order (the results routes' order, D-7-18):** every handler calls
 * `requireCollege` FIRST, then the allow-list (`requireCollegeFeesRead` /
 * `requireCollegeFeesWrite`) — both live here as the 403 every route returns —
 * then tenant/branch scoping, then a 404 on a foreign row.
 *
 * **Money never comes from the client as a charge amount.** A `collegeFee` row is
 * only ever built by `buildGeneration` from the admin's own structure rows, the
 * student's enrolment (`programId`/`termNumber`) and their APPROVED registrations
 * (D-7-10). A payment names a charge id and an integer count of MINOR UNITS, and
 * `src/lib/ledger.ts`'s `confirmCollegePayment` decides atomically whether the
 * charge still owes it.
 */

/* --------------------------------------------------------------- the gates */

/** The ONE read gate every college fee READ handler applies (D-7-18). */
export function requireCollegeFeesRead(session: { role?: string | null } | null | undefined): NextResponse | null {
  if (canReadCollegeFees(session?.role)) return null;
  return NextResponse.json({ error: COLLEGE_FEES_READ_REFUSAL }, { status: 403 });
}

/** The ONE write gate every college fee WRITE handler applies (D-7-18). */
export function requireCollegeFeesWrite(session: { role?: string | null } | null | undefined): NextResponse | null {
  if (canWriteCollegeFees(session?.role)) return null;
  return NextResponse.json({ error: COLLEGE_FEES_WRITE_REFUSAL }, { status: 403 });
}

/**
 * The gate for DECIDING an award (approve / reject), applied on top of the write
 * gate: only an admin-level role may decide, and never the proposer themselves
 * (D-7-13 reuses the school's "accountant proposes, admin approves" flow).
 */
export function requireCollegeFeeAwardDecider(
  session: { id?: string | null; role?: string | null } | null | undefined,
  proposedBy: string | null | undefined
): NextResponse | null {
  if (!canDecideCollegeFeeAward(session?.role)) {
    return NextResponse.json({ error: COLLEGE_FEES_AWARD_APPROVAL_REFUSAL }, { status: 403 });
  }
  if (session?.id && proposedBy && session.id === proposedBy) {
    return NextResponse.json({ error: COLLEGE_FEES_AWARD_APPROVAL_REFUSAL }, { status: 403 });
  }
  return null;
}

/* ------------------------------------------------------------- targeting */

/** The tenant this request targets — the SUPER_ADMIN's `?schoolId=`, else the session's own. */
export function targetSchoolId(
  session: { role: string; schoolId: string | null },
  req: NextRequest
): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

/**
 * The tenant/branch scope for a college fee read or write. A SUPER_ADMIN reads the
 * target tenant whole; everyone else is filtered by `scopeWhere`, so a
 * branch-scoped user only ever sees their own branch's rows (and every college fee
 * row stores the `branchId` it inherited, because the store cannot join).
 */
export function scopeFor(session: SessionUser, schoolId: string): Record<string, any> {
  return session.role === "SUPER_ADMIN" ? { schoolId } : scopeWhere(session, undefined);
}

/* -------------------------------------------------------------- loaders */

/** This tenant's own heads, branch-filtered by the caller. */
export async function loadHeads(schoolId: string): Promise<any[]> {
  return (await prisma.collegeFeeHead.findMany({ where: { schoolId } })) as any[];
}

/** This tenant's own structure rows for one programme and term (or all of them). */
export async function loadStructure(schoolId: string, programId?: string | null, termNumber?: number | null): Promise<any[]> {
  const rows = (await prisma.collegeFeeStructure.findMany({ where: { schoolId } })) as any[];
  return rows.filter(
    (r) =>
      (!programId || r.programId === programId) &&
      (termNumber === undefined || termNumber === null || Number(r.termNumber) === Number(termNumber))
  );
}

/** This tenant's own charge rows, with any extra equality filters applied in memory. */
export async function loadCharges(
  schoolId: string,
  extra: { studentId?: string | null; programId?: string | null; termNumber?: number | null; branchId?: string | null } = {}
): Promise<any[]> {
  const rows = (await prisma.collegeFee.findMany({ where: { schoolId } })) as any[];
  return rows.filter(
    (r) =>
      (!extra.studentId || r.studentId === extra.studentId) &&
      (!extra.programId || r.programId === extra.programId) &&
      (extra.termNumber === undefined || extra.termNumber === null || Number(r.termNumber) === Number(extra.termNumber)) &&
      (!extra.branchId || r.branchId === extra.branchId)
  );
}

/** Every award this tenant holds (any state) — the caller filters by status. */
export async function loadDiscounts(schoolId: string): Promise<any[]> {
  return (await prisma.collegeDiscount.findMany({ where: { schoolId } })) as any[];
}

/** The deterministic id of the tenant's ONE college fee config row (D-7-3, one per tenant in v1). */
export function collegeFeeConfigId(schoolId: string): string {
  return `cfc_${schoolId}`;
}

/** The tenant's college fee config, through the ONE resolver (D-6-18 pattern). */
export async function loadCollegeFeeConfig(schoolId: string): Promise<CollegeFeeConfig> {
  const row: any = await prisma.collegeFeeConfig.findUnique({ where: { id: collegeFeeConfigId(schoolId) } });
  if (row && row.schoolId !== schoolId) return resolveCollegeFeeSettings({});
  return resolveCollegeFeeSettings({ stored: row ?? null, schoolId });
}

/* --------------------------------------------------------- served shapes */

/** One head as the API serves it — the school's own shape, minus the class pricing. */
export function serveHead(row: any) {
  return {
    id: String(row?.id ?? ""),
    schoolId: row?.schoolId ?? null,
    branchId: row?.branchId ?? null,
    name: String(row?.name ?? ""),
    bucket: row?.bucket ?? "OTHER",
    frequency: row?.frequency ?? "MONTHLY",
    optional: !!row?.optional,
    active: row?.active !== false,
    dueDay: row?.dueDay ?? null,
    note: row?.note ?? null,
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** One structure row as the API serves it, every money field finite. */
export function serveStructure(row: any) {
  return {
    id: String(row?.id ?? ""),
    schoolId: row?.schoolId ?? null,
    branchId: row?.branchId ?? null,
    programId: String(row?.programId ?? ""),
    termNumber: Number.isInteger(Number(row?.termNumber)) ? Number(row.termNumber) : 1,
    headId: String(row?.headId ?? ""),
    amount: roundMoney(safeMoney(row?.amount)),
    required: row?.required !== false,
    unit: row?.unit === "COURSE" ? "COURSE" : "STUDENT",
    basis: row?.basis === "PER_CREDIT" ? "PER_CREDIT" : "FLAT",
    note: row?.note ?? null,
    createdAt: row?.createdAt ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

/** One charge row as the API serves it — money finite, `due` derived (D-7-11/D-7-14). */
export function serveCharge(row: any) {
  const amount = roundMoney(safeMoney(row?.amount));
  const paid = roundMoney(safeMoney(row?.paidAmount));
  return {
    id: String(row?.id ?? ""),
    schoolId: row?.schoolId ?? null,
    branchId: row?.branchId ?? null,
    studentId: String(row?.studentId ?? ""),
    studentName: row?.studentName ?? null,
    studentAdmissionNo: row?.studentAdmissionNo ?? null,
    programId: String(row?.programId ?? ""),
    termNumber: Number.isInteger(Number(row?.termNumber)) ? Number(row.termNumber) : 1,
    headId: String(row?.headId ?? ""),
    headName: row?.headName ?? null,
    bucket: row?.bucket ?? null,
    title: String(row?.title ?? ""),
    amount,
    grossAmount: roundMoney(safeMoney(row?.grossAmount ?? row?.amount)),
    discount: roundMoney(safeMoney(row?.discount)),
    paidAmount: paid,
    due: fromMinor(Math.max(0, toMinor(amount) - toMinor(paid))),
    status: duesStatus(amount, paid),
    sequence: Number.isInteger(Number(row?.sequence)) ? Number(row.sequence) : 1,
    unit: row?.unit === "COURSE" ? "COURSE" : "STUDENT",
    dueDay: row?.dueDay ?? null,
    dueDate: row?.dueDate ?? null,
    billedAt: row?.billedAt ?? null,
    actorId: row?.actorId ?? null,
  };
}

/** One award as the API serves it. */
export function serveDiscount(row: any) {
  return {
    id: String(row?.id ?? ""),
    schoolId: row?.schoolId ?? null,
    branchId: row?.branchId ?? null,
    kind: row?.kind === "FIXED" ? "FIXED" : "PERCENT",
    percent: Number.isFinite(Number(row?.percent)) ? Number(row.percent) : null,
    amountPerHead: Number.isFinite(Number(row?.amountPerHead)) ? Number(row.amountPerHead) : null,
    headIds: Array.isArray(row?.headIds) ? row.headIds.map((h: unknown) => String(h)) : [],
    programId: row?.programId ?? null,
    termNumber: Number.isInteger(Number(row?.termNumber)) ? Number(row.termNumber) : null,
    status: row?.status ?? "PROPOSED",
    proposedBy: row?.proposedBy ?? null,
    approvedBy: row?.approvedBy ?? null,
    note: row?.note ?? null,
    createdAt: row?.createdAt ?? null,
    decidedAt: row?.decidedAt ?? null,
  };
}

/* ------------------------------------------------------- the generation */

export interface GenerationStudentResult {
  studentId: string;
  name: string;
  admissionNo: string | null;
  branchId: string | null;
  courseCount: number;
  newCharges: CollegeCharge[];
  existingIds: string[];
  total: number;
  refused: { headId: string | null; reason: string }[];
}

export type GenerationOutcome =
  | { ok: false; status: number; error: string }
  | {
      ok: true;
      dryRun: boolean;
      programId: string;
      programName: string;
      termNumber: number;
      termLabel: string;
      currency: string;
      students: GenerationStudentResult[];
      written: number;
      skippedExisting: number;
      totals: { students: number; newRows: number; existingRows: number; amount: number; refused: number };
      discounts: { awardId: string; amount: number; clamped: boolean }[];
      skippedAwards: { awardId: string; reason: string }[];
    };

/**
 * Derive — and, unless `dryRun`, write — the charge set for a programme's term
 * (D-7-10, D-7-13).
 *
 * Every input is the admin's own row: the structure priced for this programme and
 * term, the heads those rows point at, the students on roll in it, and each
 * student's APPROVED registrations for the term. APPROVED awards are applied to the
 * NEW rows before they are written (a charge already on the books is never
 * rewritten — D-7-9).
 *
 * The write is a conditional CREATE against the deterministic `cf_…` id, inside a
 * real transaction (`$guardedUpdate`), so two simultaneous generations cannot
 * double-create a charge, and a re-run after a late registration simply tops the
 * missing rows up. A row that already exists is counted as `skippedExisting` and
 * left byte-identical — its `paidAmount` in particular is never reset.
 */
export async function buildGeneration(input: {
  session: SessionUser;
  schoolId: string;
  programId: string;
  termNumber: unknown;
  headIds?: unknown;
  includeOptional?: boolean;
  dueDate?: string | null;
  dryRun: boolean;
}): Promise<GenerationOutcome> {
  const program: any = await prisma.program.findUnique({ where: { id: input.programId } });
  if (!program || program.schoolId !== input.schoolId) {
    return { ok: false, status: 400, error: "Programme not found in this school." };
  }
  if (!canAccessBranch(input.session, program.branchId)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  const termNumber = Number(input.termNumber);
  if (!Number.isInteger(termNumber) || termNumber < 1) {
    return { ok: false, status: 400, error: "The term must be a whole number starting at 1." };
  }
  if (!isValidCollegeTermNumber(termNumber, Number(program.durationYears), program.termSystem)) {
    return {
      ok: false,
      status: 400,
      error: `This programme has no term ${termNumber} — bill one of its own terms.`,
    };
  }

  const heads = await loadHeads(input.schoolId);
  const structure = await loadStructure(input.schoolId, input.programId, termNumber);
  const config = await loadCollegeFeeConfig(input.schoolId);
  const awards = (await loadDiscounts(input.schoolId)).filter((a) => a.status === "APPROVED");

  const onRoll = ((await prisma.student.findMany({
    where: { schoolId: input.schoolId, programId: input.programId, termNumber },
  })) as any[])
    .filter((s) => canAccessBranch(input.session, s.branchId))
    .sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? "")) || String(a.id).localeCompare(String(b.id)));

  const students: GenerationStudentResult[] = [];
  const appliedDiscounts: { awardId: string; amount: number; clamped: boolean }[] = [];
  const skippedAwards: { awardId: string; reason: string }[] = [];
  let written = 0;
  let skippedExisting = 0;
  let amountMinorTotal = 0;
  const stamp = new Date().toISOString();

  for (const student of onRoll) {
    const studentId = String(student.id);
    const [registrations, existingRows] = await Promise.all([
      prisma.courseRegistration.findMany({ where: { schoolId: input.schoolId, studentId, termNumber } }),
      loadCharges(input.schoolId, { studentId, programId: input.programId, termNumber }),
    ]);

    const plan = deriveCollegeCharges({
      schoolId: input.schoolId,
      branchId: student.branchId ?? program.branchId ?? null,
      studentId,
      programId: input.programId,
      termNumber,
      programme: { durationYears: Number(program.durationYears), termSystem: program.termSystem },
      heads,
      structure,
      registrations,
      existing: existingRows.map((r) => ({ id: r.id })),
      includeOptional: input.includeOptional === true,
      headIds: input.headIds,
      dueDate: input.dueDate ?? null,
    });

    // Awards reduce the NEW rows only — a charge already on the books keeps the
    // money it was raised with (D-7-9/D-7-13).
    let charges = plan.charges;
    if (charges.length && awards.length) {
      const discounted = applyCollegeDiscounts(charges, awards);
      const byId = new Map(discounted.rows.map((r) => [r.id, r] as const));
      charges = charges.map((c) => {
        const row = byId.get(c.id);
        return row ? { ...c, grossAmount: row.grossAmount, discount: row.discount, amount: row.amount, status: duesStatus(row.amount, row.paidAmount) } : c;
      });
      for (const a of discounted.applied) {
        const seen = appliedDiscounts.find((x) => x.awardId === a.awardId);
        if (seen) seen.amount = roundMoney(seen.amount + a.amount);
        else appliedDiscounts.push({ ...a });
      }
      for (const s of discounted.skippedAwards) if (!skippedAwards.some((x) => x.awardId === s.awardId)) skippedAwards.push(s);
    }

    let studentMinor = 0;
    for (const charge of charges) {
      studentMinor += toMinor(charge.amount);
      if (input.dryRun) continue;
      const written1 = await prisma.$guardedUpdate("collegeFee", charge.id, (current) =>
        current
          ? { ok: false, error: "This charge already exists." }
          : {
              ok: true,
              data: {
                schoolId: input.schoolId,
                branchId: charge.branchId ?? null,
                studentId,
                programId: input.programId,
                termNumber,
                headId: charge.headId,
                headName: charge.headName,
                bucket: charge.bucket,
                title: charge.title,
                amount: charge.amount,
                grossAmount: (charge as any).grossAmount ?? charge.amount,
                discount: (charge as any).discount ?? 0,
                paidAmount: 0,
                status: duesStatus(charge.amount, 0),
                sequence: charge.sequence,
                unit: charge.unit,
                dueDay: charge.dueDay ?? null,
                dueDate: charge.dueDate ?? null,
                billedAt: stamp,
                actorId: input.session.id,
              },
            }
      );
      if (written1.ok) written += 1;
      else skippedExisting += 1;
    }
    amountMinorTotal += studentMinor;

    students.push({
      studentId,
      name: String(student.name ?? ""),
      admissionNo: student.admissionNo ?? null,
      branchId: student.branchId ?? null,
      courseCount: plan.courseCount,
      newCharges: charges,
      existingIds: plan.existing,
      total: fromMinor(studentMinor),
      refused: plan.refused,
    });
  }

  return {
    ok: true,
    dryRun: input.dryRun,
    programId: input.programId,
    programName: String(program.name ?? ""),
    termNumber,
    termLabel: collegeTermLabel(termNumber, program.termSystem),
    currency: config.currency,
    students,
    written,
    skippedExisting,
    totals: {
      students: students.length,
      newRows: students.reduce((a, s) => a + s.newCharges.length, 0),
      existingRows: students.reduce((a, s) => a + s.existingIds.length, 0),
      amount: fromMinor(amountMinorTotal),
      refused: students.reduce((a, s) => a + s.refused.length, 0),
    },
    discounts: appliedDiscounts,
    skippedAwards,
  };
}

/* ---------------------------------------------------------------- config */

/** The stored config row, normalised (never a raw row). */
export function serveConfig(schoolId: string, config: CollegeFeeConfig) {
  const normalized = normalizeCollegeFeeConfig(config);
  return { schoolId, ...normalized };
}
