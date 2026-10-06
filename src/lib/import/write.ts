import bcrypt from "bcryptjs";
import { randomBytes } from "node:crypto";
import { prisma, userIdForEmail } from "@/lib/db";
import { qrPin } from "@/lib/qr";
import { studentDataFor, type ImportContext, type PlanRow } from "@/lib/import/plan";

/**
 * Bulk-import write planner — an IMPORT-SPECIFIC fast path.
 *
 * `enrollStudent()` is left exactly as it is; it remains the single source of
 * truth AND the path the other three student-creation flows keep using. This
 * module only re-creates the writes that a *bulk import row with no sibling*
 * needs, so those writes can be grouped into a Firestore write-batch instead of
 * one round trip per row.
 *
 * Why this is safe to batch:
 *   - every write here is an independent `set` on a document whose id is already
 *     known (deterministic student id, deterministic guardian id, random fee id);
 *   - nothing reads a document it just wrote — the existence / sibling / guardian
 *     decisions are made in-memory from the chunk's context (`ImportContext`);
 *   - a row that DOES have a sibling still goes through `enrollStudent()`, which
 *     performs the read-then-write family linking in the correct order.
 *
 * The resulting documents are identical to what `enrollStudent()` writes.
 */

export interface ImporterState {
  /** Guardian account ids already queued this chunk (one account per email). */
  createdGuardianIds: Set<string>;
  /** The school's fee setting, loaded once per chunk when fees are enabled. */
  feeSetting: { monthlyFee: number; admissionFee: number } | null;
}

/**
 * Marks a guardian account the bulk import provisioned whose portal access is
 * the per-student QR token + PIN (not an email/password the guardian chose).
 *
 * There is no invitation/email flow: the account is created with an unknown
 * random password, so email+password sign-in is impossible until the guardian
 * resets it via the existing email-OTP flow. Immediate access is the QR/PIN slip
 * the import surfaces (see the batch credentials endpoint). An account with no
 * `passwordStatus` is a normal account with a real password.
 */
export const GUARDIAN_PROVISION_STATUS = "QR_CREDENTIALS";

/**
 * A random, unusable password for an account the import provisions.
 *
 * Bulk import must NOT fall back to the shared `Guardian@123` default that New
 * Admission uses: a rostered guardian who never chose a password must not be
 * able to sign in with a password the whole platform knows. The account is
 * created with an unknown random hash and the guardian's credential is the
 * per-student QR token + PIN handed over on the credential slip.
 */
export function unusableGuardianPassword(): string {
  return randomBytes(24).toString("hex");
}

/**
 * The guardian account id a row will reference: a matched account, or the
 * deterministic id its email will produce. `null` when the row has no account.
 */
export function fastGuardianUserId(plan: PlanRow): string | null {
  if (plan.guardianUserId) return plan.guardianUserId;
  if (plan.values.guardianEmail) return userIdForEmail(plan.values.guardianEmail);
  return null;
}

/**
 * Ensure the school's fee setting exists, once per chunk (mirrors the upsert
 * `enrollStudent` performs before it bills a student).
 */
export async function ensureFeeSetting(
  schoolId: string
): Promise<{ monthlyFee: number; admissionFee: number } | null> {
  await prisma.feeSetting.upsert({
    where: { schoolId },
    update: {},
    create: { schoolId, monthlyFee: 1500, admissionFee: 5000 },
  });
  const setting = await prisma.feeSetting.findUnique({ where: { schoolId } });
  if (!setting) return null;
  return { monthlyFee: Number(setting.monthlyFee), admissionFee: Number(setting.admissionFee) };
}

/**
 * The deferred writes for one import row that has no sibling to link.
 *
 * Returns the ops (to be committed in a write-batch) plus the guardian id the
 * student was linked to, so the caller can report it.
 */
export function fastRowWrites(
  ctx: ImportContext,
  plan: PlanRow,
  state: ImporterState,
  opts: { branchId: string | null; createFees: boolean }
): { ops: any[]; guardianUserId: string | null; guardianProvisioned: boolean } {
  const ops: any[] = [];
  const guardianUserId = fastGuardianUserId(plan);
  const email = plan.values.guardianEmail;
  // A row with an email that did NOT match an existing account will have one
  // provisioned (invite-pending) — either this row or an earlier row in the
  // chunk already queued it.
  const guardianProvisioned = !!guardianUserId && !plan.guardianUserId && !!email;

  // 1) A new guardian account (at most one per email in a chunk). `upsert` keeps
  //    an existing account untouched (empty update) and produces the same
  //    document `enrollStudent` would create for a new one — but with a random,
  //    unusable password and an invite-pending marker instead of the shared
  //    default password, so the account is safe to hand to the invitation flow.
  if (guardianProvisioned && guardianUserId && email && !state.createdGuardianIds.has(guardianUserId)) {
    state.createdGuardianIds.add(guardianUserId);
    ops.push(
      prisma.user.upsert({
        where: { email },
        create: {
          email,
          name: plan.values.guardianName || "Guardian",
          role: "GUARDIAN",
          schoolId: ctx.schoolId,
          passwordHash: bcrypt.hashSync(unusableGuardianPassword(), 10),
          phone: plan.values.guardianPhone,
          passwordStatus: GUARDIAN_PROVISION_STATUS,
        },
        update: {},
      })
    );
  }

  // 2) The student. `guardianUserId` is set on the create itself (instead of a
  //    follow-up update) because it is already known here.
  ops.push(
    prisma.student.create({
      data: studentDataFor(ctx, plan, {
        qrPin: qrPin(),
        guardianUserId: guardianUserId ?? undefined,
        guardianProvisioned,
      }),
    })
  );

  // 3) Optional default fees — the same two rows `enrollStudent` raises.
  if (opts.createFees && state.feeSetting) {
    const studentId = `st_${plan.qrToken}`;
    const branch = { branchId: opts.branchId ?? null };
    ops.push(
      prisma.fee.create({
        data: {
          schoolId: ctx.schoolId,
          ...branch,
          studentId,
          feeType: "ADMISSION",
          title: "Admission Fee",
          amount: state.feeSetting.admissionFee,
          paidAmount: 0,
          status: "UNPAID",
          dueDate: new Date(),
        },
      })
    );
    ops.push(
      prisma.fee.create({
        data: {
          schoolId: ctx.schoolId,
          ...branch,
          studentId,
          feeType: "MONTHLY",
          title: "Monthly Fee",
          amount: state.feeSetting.monthlyFee,
          paidAmount: 0,
          status: "UNPAID",
          dueDate: new Date(Date.now() + 30 * 86400000),
        },
      })
    );
  }

  return { ops, guardianUserId, guardianProvisioned };
}

/**
 * A row must use the sequential `enrollStudent()` path when a sibling exists,
 * because family linking reads a sibling document and writes to it. Existence is
 * decided in memory: if any student (already on file, or created earlier in this
 * chunk) shares the row's guardian account or phone number, it is a sibling.
 */
export function rowHasSibling(ctx: ImportContext, plan: PlanRow, guardianUserId: string | null): boolean {
  if (guardianUserId && ctx.studentsByGuardianUser.has(guardianUserId)) return true;
  if (plan.values.guardianPhone && ctx.studentsByGuardianPhone.has(plan.values.guardianPhone)) return true;
  return false;
}
