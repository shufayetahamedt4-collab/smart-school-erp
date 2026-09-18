import { prisma } from "@/lib/db";
import type { AdmissionStatus } from "@/lib/db";
import { qrToken, qrPin } from "@/lib/qr";
import { postToLedger, confirmPayment } from "@/lib/ledger";
import { notifyUsers } from "@/lib/notify";
import bcrypt from "bcryptjs";

/**
 * PRD §4 — Admission module: a complete workflow, not an "Add Student" form.
 * ENQUIRY → APPLIED → (docs, test) → SEAT_CONFIRMED → (fee payment) → ENROLLED.
 */

export const ADMISSION_STATUSES: AdmissionStatus[] = [
  "ENQUIRY",
  "APPLIED",
  "DOCS_PENDING",
  "TEST_SCHEDULED",
  "SEAT_CONFIRMED",
  "ENROLLED",
  "REJECTED",
];

/** Valid pipeline transitions (kept strict so statuses stay meaningful). */
const TRANSITIONS: Record<AdmissionStatus, AdmissionStatus[]> = {
  ENQUIRY: ["APPLIED", "REJECTED"],
  APPLIED: ["DOCS_PENDING", "TEST_SCHEDULED", "SEAT_CONFIRMED", "REJECTED"],
  DOCS_PENDING: ["APPLIED", "TEST_SCHEDULED", "SEAT_CONFIRMED", "REJECTED"],
  TEST_SCHEDULED: ["SEAT_CONFIRMED", "REJECTED", "APPLIED"],
  SEAT_CONFIRMED: ["ENROLLED", "REJECTED"],
  ENROLLED: [],
  REJECTED: ["APPLIED"],
};

export function canTransition(from: AdmissionStatus, to: AdmissionStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Auto-suggest class from the previous class name (§4.2); admin can override. */
export function suggestClassIndex(prevClassName: string | undefined | null, classOrder: { id: string; name: string; order: number }[]): string | null {
  if (!prevClassName) return null;
  const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u0980-\u09FF]/g, "");
  const prev = normalize(prevClassName);
  const sorted = [...classOrder].sort((a, b) => a.order - b.order);
  // Exact match first, then "play"/"nursery"-style loose match, else null.
  const exact = sorted.find((c) => normalize(c.name) === prev);
  if (exact) return exact.id;
  const partial = sorted.find((c) => prev.includes(normalize(c.name)) || normalize(c.name).includes(prev));
  return partial?.id || null;
}

/** Sibling auto-suggest (§4.2/§5.4): match students by guardian phone or email. */
export async function findSiblingCandidates(schoolId: string, guardianPhone?: string | null, guardianEmail?: string | null) {
  if (!guardianPhone && !guardianEmail) return [];
  const conditions: any[] = [];
  if (guardianPhone) conditions.push({ guardianPhone });
  if (guardianEmail) {
    conditions.push({ guardianEmail: guardianEmail.toLowerCase() });
    const gUser = await prisma.user.findUnique({ where: { email: guardianEmail.toLowerCase() } });
    if (gUser) conditions.push({ guardianUserId: gUser.id });
  }
  return prisma.student.findMany({
    where: { schoolId, OR: conditions },
    select: { id: true, name: true, classRoom: { select: { name: true } }, section: { select: { name: true } }, guardianUserId: true, familyId: true },
    take: 10,
  });
}

/** Record admission fee payment → completes enrollment (§4.1 step 5). */
export async function payAdmissionFeeAndEnroll(
  admissionId: string,
  opts: { method: "CASH" | "BANK" | "BKASH" | "NAGAD" | "ROCKET" | "CARD"; refNo?: string; actorId?: string }
) {
  const admission = await prisma.admission.findUnique({ where: { id: admissionId } });
  if (!admission) throw new Error("Admission not found");
  if (admission.status !== "SEAT_CONFIRMED") {
    throw new Error("Seat must be confirmed before fee payment.");
  }
  if (admission.convertedStudentId) throw new Error("Already enrolled.");

  const payable = Number(admission.payableAmount || 0);
  if (payable <= 0) throw new Error("No payable amount set on this admission.");

  // 1) Convert to a full student profile (§4.3)
  const token = qrToken();
  const pin = qrPin();
  const student = await prisma.student.create({
    data: {
      schoolId: admission.schoolId,
      admissionNo: admission.admissionNo || `ADM-${Date.now().toString().slice(-6)}`,
      name: admission.fullName,
      nameBn: admission.fullNameBn || null,
      dob: admission.dob || null,
      gender: (admission.gender as any) || "OTHER",
      bloodGroup: admission.bloodGroup || null,
      religion: admission.religion || null,
      birthCertificateNo: admission.birthCertificateNo || null,
      permanentAddress: admission.permanentAddress || null,
      currentAddress: admission.currentAddress || admission.permanentAddress || null,
      previousSchoolName: admission.previousSchoolName || null,
      previousSchoolAddress: admission.previousSchoolAddress || null,
      previousClass: admission.previousClass || null,
      leavingReason: admission.leavingReason || null,
      roll: null,
      classId: admission.classId,
      sectionId: admission.sectionId,
      guardianName: admission.guardianName,
      guardianPhone: admission.guardianPhone,
      guardianEmail: admission.guardianEmail,
      guardianRelation: admission.guardianRelation || null,
      address: admission.permanentAddress || admission.currentAddress || null,
      photoUrl: admission.photoUrl || null,
      admissionDate: new Date(),
      status: "ACTIVE",
      qrToken: token,
      qrPin: pin,
      sessionId: admission.sessionId || null,
      branchId: admission.branchId || null,
    },
  });

  // 2) Guardian account auto-create/link (§4.3) + sibling linking (§5.4)
  let guardianUserId: string | null = null;
  if (admission.guardianEmail) {
    const email = admission.guardianEmail.toLowerCase();
    let gUser = await prisma.user.findUnique({ where: { email } });
    if (!gUser) {
      gUser = await prisma.user.create({
        data: {
          email,
          name: admission.guardianName || "Guardian",
          role: "GUARDIAN",
          schoolId: admission.schoolId,
          phone: admission.guardianPhone || null,
          passwordHash: bcrypt.hashSync("Guardian@123", 10),
        },
      });
    }
    guardianUserId = gUser.id;
    await prisma.student.update({ where: { id: student.id }, data: { guardianUserId } });

    // Sibling auto-link via familyId
    const siblings = await prisma.student.findMany({
      where: {
        schoolId: admission.schoolId,
        id: { not: student.id },
        OR: [
          { guardianUserId: guardianUserId },
          ...(admission.guardianPhone ? [{ guardianPhone: admission.guardianPhone }] : []),
        ],
        familyId: { not: null },
      },
      select: { familyId: true },
      take: 1,
    });
    const familyId = siblings[0]?.familyId || `fam_${student.id.slice(0, 10)}`;
    await prisma.student.update({ where: { id: student.id }, data: { familyId } });
  }

  // 3) Fees: admission fee (with discount applied) + first monthly fee
  const feeSetting = await prisma.feeSetting.findUnique({ where: { schoolId: admission.schoolId } });
  const admissionFee = await prisma.fee.create({
    data: {
      schoolId: admission.schoolId,
      studentId: student.id,
      title: "Admission Fee",
      amount: payable,
      feeType: "ADMISSION",
      status: "UNPAID",
      dueDate: new Date(),
    },
  });
  if (feeSetting) {
    await prisma.fee.create({
      data: {
        schoolId: admission.schoolId,
        studentId: student.id,
        title: "Monthly Fee",
        amount: Number(feeSetting.monthlyFee),
        feeType: "MONTHLY",
        status: "UNPAID",
        dueDate: new Date(Date.now() + 30 * 86400000),
      },
    });
  }

  // 4) Confirm the admission fee payment via the central ledger flow
  await confirmPayment({
    schoolId: admission.schoolId,
    feeId: admissionFee.id,
    amount: payable,
    method: opts.method,
    refNo: opts.refNo || null,
    actorId: opts.actorId || null,
    notify: true,
  });

  // 5) Ledger: discount record if one was approved
  const discount = await prisma.discount.findFirst({
    where: { admissionId: admission.id, status: "APPROVED" },
  });
  if (discount) {
    await postToLedger({
      schoolId: admission.schoolId,
      kind: "DISCOUNT",
      amount: Number(discount.amount),
      status: "CONFIRMED",
      studentId: student.id,
      actorId: discount.approvedById,
      description: `${discount.reason} discount (${discount.type === "PERCENT" ? `${discount.originalValue}%` : "fixed"})`,
    });
  }

  // 6) Mark admission enrolled
  await prisma.admission.update({
    where: { id: admission.id },
    data: { status: "ENROLLED", convertedStudentId: student.id },
  });

  // 7) Notify front desk / admins
  const admins = await prisma.user.findMany({
    where: { schoolId: admission.schoolId, role: { in: ["SCHOOL_ADMIN", "ACCOUNTANT", "FRONT_DESK"] } },
    select: { id: true },
  });
  await notifyUsers({
    schoolId: admission.schoolId,
    userIds: admins.map((a) => a.id),
    event: "ADMISSION_STATUS",
    title: "Admission enrolled",
    body: `${admission.fullName} is now enrolled (Admission ID ${admission.admissionNo || admission.id}).`,
    link: "/dashboard/admissions",
  });

  return { student, guardianUserId, admissionFeeId: admissionFee.id };
}
