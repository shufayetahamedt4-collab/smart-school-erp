import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { findExistingSibling, linkSiblingFamily } from "@/lib/family";

/**
 * Shared enrollment kernel (Phase 1).
 *
 * One place that turns a normalized set of student fields into a student record
 * plus its guardian account, family link and fee rows.
 *
 * IMPORTANT — it does NOT unify the three existing creation paths. Each caller
 * passes the exact options that reproduce its current behaviour and keeps its own
 * orchestration (admission records, payment, kit, notifications, audit, return
 * shape). Behaviour that genuinely differed between the paths is preserved via
 * the options below rather than silently normalized — see the Phase 1 difference
 * report in the plan. Specifically:
 *
 *  - the caller supplies the whole student field object (the kernel adds/removes
 *    nothing), so per-path field sets are untouched;
 *  - a created guardian's `phone` is only written when the caller passes one
 *    (`undefined` omits the key, as POST /api/students does);
 *  - family linking is opt-in per caller (POST /api/students links no family);
 *  - fee rows are either the school's default admission+monthly pair
 *    (POST /api/students) or an explicit, ordered row list (intake / enrollment),
 *    with branchId included only when the caller asks for it;
 *  - duplicate checks stay in each caller (they differ in rule and message).
 */

/** The password a created guardian account gets when the caller supplies none. */
export const DEFAULT_GUARDIAN_PASSWORD = "Guardian@123";

export interface EnrollGuardianInput {
  /** Attempt to create/link an account (callers gate this, e.g. body.createGuardian). */
  create: boolean;
  email?: string | null;
  name?: string | null;
  /**
   * Phone written on a newly-created guardian user. Leave undefined to omit the
   * field entirely (POST /api/students does not set one); pass null to write null.
   */
  phone?: string | null;
  /** Explicit password; falls back to `defaultPassword` then the app default. */
  password?: string | null;
  defaultPassword?: string;
  /**
   * Provisioning marker written on a NEWLY-CREATED guardian account. The bulk
   * import sets this ("QR_CREDENTIALS") so an account whose access is a QR/PIN
   * slip is distinguishable from one the guardian already signs into. Existing
   * callers (New Admission / intake / enrollment) pass nothing, so their
   * behaviour is unchanged.
   */
  passwordStatus?: string | null;
}

export interface EnrollFamilyInput {
  /** Link this exact sibling (walk-in desk intake). */
  siblingId?: string | null;
  /** Discover the nearest existing sibling by guardian account/phone (enrollment). */
  findExisting?: boolean;
  guardianPhone?: string | null;
}

export interface EnrollFeeRow {
  title: string;
  amount: number;
  feeType: string;
  /** Due date offset in days from now (default 0). */
  dueInDays?: number;
}

export interface EnrollFeesInput {
  /** Upsert the school's fee setting, then bill its default admission+monthly rows. */
  ensureDefaults?: boolean;
  /** With ensureDefaults, whether the two default rows are actually raised. */
  createDefaults?: boolean;
  /** Explicit rows (walk-in intake, enrollment) — created in the given order. */
  rows?: EnrollFeeRow[];
  /** Include a branchId on the fee rows (intake + POST /api/students do; enrollment does not). */
  includeBranch?: boolean;
  branchId?: string | null;
}

export interface EnrollStudentOptions {
  schoolId: string;
  /** Already resolved by the caller — each path resolves it slightly differently. */
  branchId: string | null;
  /** Fully normalized student fields. The kernel adds nothing and removes nothing. */
  student: Record<string, any>;
  guardian?: EnrollGuardianInput | null;
  family?: EnrollFamilyInput | null;
  fees?: EnrollFeesInput | null;
}

export interface EnrollFamilyResult {
  familyId: string;
  siblingName: string;
  guardianUserId: string | null;
}

export interface EnrollStudentResult {
  student: any;
  guardianUserId: string | null;
  guardianCreated: boolean;
  family: EnrollFamilyResult | null;
  admissionFeeId: string | null;
  monthlyFeeId: string | null;
}

/**
 * Enroll one student: create the record, match/create+link the guardian account,
 * link the family when asked, and raise the fee rows the caller requested.
 */
export async function enrollStudent(opts: EnrollStudentOptions): Promise<EnrollStudentResult> {
  const { schoolId } = opts;

  // 1) The student itself — the caller's field set, written verbatim.
  const student = await prisma.student.create({ data: opts.student });

  // 2) Guardian account: match by email, else create, then link to the student.
  let guardianUserId: string | null = student.guardianUserId || null;
  let guardianCreated = false;
  const g = opts.guardian;
  if (g?.create && g.email) {
    const email = String(g.email).toLowerCase();
    let user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      const data: Record<string, any> = {
        email,
        name: g.name || "Guardian",
        role: "GUARDIAN",
        schoolId,
        passwordHash: bcrypt.hashSync(g.password || g.defaultPassword || DEFAULT_GUARDIAN_PASSWORD, 10),
      };
      // Only write a phone when the caller supplies one (undefined omits the key).
      if (g.phone !== undefined) data.phone = g.phone;
      // Provisioning marker (bulk import only) — omitted entirely for every
      // other caller, so those accounts are byte-for-byte what they were.
      if (g.passwordStatus !== undefined) data.passwordStatus = g.passwordStatus;
      user = await prisma.user.create({ data });
      guardianCreated = true;
    }
    guardianUserId = user.id;
    await prisma.student.update({ where: { id: student.id }, data: { guardianUserId } });
  }

  // 3) Family link (siblings share one family id and one login).
  let family: EnrollFamilyResult | null = null;
  const f = opts.family;
  if (f) {
    let siblingId = f.siblingId ? String(f.siblingId) : null;
    if (!siblingId && f.findExisting) {
      const sibling = await findExistingSibling(schoolId, student.id, guardianUserId, f.guardianPhone ?? undefined);
      if (sibling) siblingId = sibling.id;
    }
    if (siblingId) {
      family = await linkSiblingFamily({ schoolId, studentId: student.id, siblingId, guardianUserId });
      if (!guardianUserId && family.guardianUserId) guardianUserId = family.guardianUserId;
    }
  }

  // 4) Fees — the caller's plan, nothing more.
  const fees = await createStudentFees(schoolId, student.id, opts.fees);

  return {
    student,
    guardianUserId,
    guardianCreated,
    family,
    admissionFeeId: fees.admissionFeeId,
    monthlyFeeId: fees.monthlyFeeId,
  };
}

/** Raise the fee rows a caller asked for. Returns the admission/monthly row ids. */
async function createStudentFees(
  schoolId: string,
  studentId: string,
  fees: EnrollFeesInput | null | undefined
): Promise<{ admissionFeeId: string | null; monthlyFeeId: string | null }> {
  if (!fees) return { admissionFeeId: null, monthlyFeeId: null };
  const branch = fees.includeBranch ? { branchId: fees.branchId ?? null } : {};

  // POST /api/students mode: ensure the school's fee setting, then bill its
  // default admission + monthly pair exactly as before.
  if (fees.ensureDefaults) {
    await prisma.feeSetting.upsert({
      where: { schoolId },
      update: {},
      create: { schoolId, monthlyFee: 1500, admissionFee: 5000 },
    });
    const setting = await prisma.feeSetting.findUnique({ where: { schoolId } });
    if (setting && fees.createDefaults) {
      await prisma.fee.createMany({
        data: [
          // paidAmount is written explicitly: a row without it makes every money
          // total in the app (fees page, dashboard, student debt) read ৳0.
          { schoolId, ...branch, studentId, feeType: "ADMISSION", title: "Admission Fee", amount: setting.admissionFee, paidAmount: 0, status: "UNPAID", dueDate: new Date() },
          { schoolId, ...branch, studentId, feeType: "MONTHLY", title: "Monthly Fee", amount: setting.monthlyFee, paidAmount: 0, status: "UNPAID", dueDate: new Date(Date.now() + 30 * 86400000) },
        ],
      });
    }
    return { admissionFeeId: null, monthlyFeeId: null };
  }

  // Explicit-row mode: created in order so the admission row (the payment target)
  // exists first, matching both current callers.
  let admissionFeeId: string | null = null;
  let monthlyFeeId: string | null = null;
  for (const row of fees.rows || []) {
    const created = await prisma.fee.create({
      data: {
        schoolId,
        ...branch,
        studentId,
        title: row.title,
        amount: row.amount,
        paidAmount: 0,
        feeType: row.feeType as any,
        status: "UNPAID",
        dueDate: new Date(Date.now() + (row.dueInDays || 0) * 86400000),
      },
    });
    if (row.feeType === "ADMISSION" && !admissionFeeId) admissionFeeId = created.id;
    if (row.feeType === "MONTHLY" && !monthlyFeeId) monthlyFeeId = created.id;
  }
  return { admissionFeeId, monthlyFeeId };
}
