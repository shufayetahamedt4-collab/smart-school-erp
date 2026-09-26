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

/**
 * Sibling auto-suggest (§4.2/§5.4): match students by guardian phone, guardian
 * email (or the account that email belongs to), or — when the desk types a name
 * or admission number — by the student themselves.
 */
export async function findSiblingCandidates(
  schoolId: string,
  guardianPhone?: string | null,
  guardianEmail?: string | null,
  q?: string | null
) {
  const conditions: any[] = [];
  if (guardianPhone) conditions.push({ guardianPhone });
  if (guardianEmail) {
    conditions.push({ guardianEmail: guardianEmail.toLowerCase() });
    const gUser = await prisma.user.findUnique({ where: { email: guardianEmail.toLowerCase() } });
    if (gUser) conditions.push({ guardianUserId: gUser.id });
  }
  const term = String(q || "").trim();
  if (term) conditions.push({ name: { contains: term } }, { admissionNo: { contains: term } });
  if (!conditions.length) return [];
  return prisma.student.findMany({
    where: { schoolId, OR: conditions },
    select: {
      id: true,
      name: true,
      admissionNo: true,
      status: true,
      classRoom: { select: { id: true, name: true } },
      section: { select: { name: true } },
      guardianUserId: true,
      guardianName: true,
      guardianPhone: true,
      familyId: true,
    },
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
  }

  // Sibling link (§5.4) through the shared helper, so an enrolled child and a
  // walk-in admitted at the desk end up in the same family with one login.
  const sibling = await findExistingSibling(admission.schoolId, student.id, guardianUserId, admission.guardianPhone);
  if (sibling) {
    await linkSiblingFamily({ schoolId: admission.schoolId, studentId: student.id, siblingId: sibling.id, guardianUserId });
  }

  // 3) Fees: admission fee (with discount applied) + first monthly fee
  const feeSetting = await prisma.feeSetting.findUnique({ where: { schoolId: admission.schoolId } });
  const admissionFee = await prisma.fee.create({
    data: {
      schoolId: admission.schoolId,
      studentId: student.id,
      title: "Admission Fee",
      amount: payable,
      paidAmount: 0,
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
        paidAmount: 0,
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

/* ============================================================================
 * Intake helpers — shared by the walk-in intake (/api/admissions/intake) and the
 * enquiry pipeline's enrollment, so both paths link families and hand out kit by
 * exactly the same rules.
 * ==========================================================================*/

/** The nearest already-enrolled child to link a new student to, or null. */
export async function findExistingSibling(
  schoolId: string,
  studentId: string,
  guardianUserId: string | null,
  guardianPhone?: string | null
) {
  // The guardian ACCOUNT is the strongest signal (a family that already signed
  // in shares it); the phone number is the fallback the enquiry form implies.
  const byUser = guardianUserId
    ? await prisma.student.findFirst({ where: { schoolId, id: { not: studentId }, guardianUserId } })
    : null;
  if (byUser) return byUser;
  if (!guardianPhone) return null;
  return prisma.student.findFirst({ where: { schoolId, id: { not: studentId }, guardianPhone } });
}

/**
 * Put a new student in the same family as a sibling (§5.4).
 *
 * The sibling's family id wins when it has one; otherwise a new one is minted and
 * stamped on BOTH children, which is what makes the guardian portal list them
 * together (see /api/parent/siblings). The family also shares one login: whichever
 * of the two already has a guardian account keeps it for both.
 */
export async function linkSiblingFamily(opts: {
  schoolId: string;
  studentId: string;
  siblingId: string;
  guardianUserId?: string | null;
}): Promise<{ familyId: string; siblingName: string; guardianUserId: string | null }> {
  const sibling = await prisma.student.findUnique({ where: { id: opts.siblingId } });
  if (!sibling || sibling.schoolId !== opts.schoolId) throw new Error("Sibling not found in this school.");
  if (sibling.id === opts.studentId) throw new Error("A student cannot be their own sibling.");

  const familyId = sibling.familyId || `fam_${opts.studentId.slice(0, 10)}`;
  if (!sibling.familyId) await prisma.student.update({ where: { id: sibling.id }, data: { familyId } });
  await prisma.student.update({ where: { id: opts.studentId }, data: { familyId } });

  const familyGuardian = sibling.guardianUserId || opts.guardianUserId || null;
  if (familyGuardian && !sibling.guardianUserId) {
    await prisma.student.update({ where: { id: sibling.id }, data: { guardianUserId: familyGuardian } });
  }
  if (familyGuardian && !opts.guardianUserId) {
    await prisma.student.update({ where: { id: opts.studentId }, data: { guardianUserId: familyGuardian } });
  }
  return { familyId, siblingName: sibling.name, guardianUserId: familyGuardian };
}

/** One catalogue item with what is actually on the shelf right now. */
export interface KitItem {
  id: string;
  title: string;
  code: string | null;
  type: string;
  classId: string | null;
  className: string | null;
  price: number;
  total: number;
  issued: number;
  available: number;
}

/**
 * The school's catalogue with live availability. `available` is the app's existing
 * convention — copies bought minus copies currently ISSUED — so returning an item
 * (or recording one lost) frees a unit again without any extra bookkeeping.
 */
export async function kitAvailability(schoolId: string): Promise<KitItem[]> {
  const [books, stocks, active] = await Promise.all([
    prisma.bookCatalog.findMany({ where: { schoolId }, orderBy: { title: "asc" } }),
    prisma.bookStock.findMany({ where: { schoolId } }),
    prisma.bookIssue.findMany({ where: { schoolId, status: "ISSUED" }, select: { bookId: true } }),
  ]);
  const stockBy = new Map(stocks.map((s: any) => [s.bookId as string, s]));
  const issuedBy = new Map<string, number>();
  for (const issue of active) issuedBy.set((issue as any).bookId, (issuedBy.get((issue as any).bookId) || 0) + 1);

  return books.map((b: any) => {
    const total = Number(stockBy.get(b.id)?.total) || 0;
    const issued = issuedBy.get(b.id) || 0;
    return {
      id: b.id,
      title: b.title,
      code: b.code || null,
      type: b.type,
      classId: b.classId || null,
      className: b.className || null,
      price: Number(b.price) || 0,
      total,
      issued,
      available: Math.max(0, total - issued),
    };
  });
}

/** What a hand-out actually did — nothing is dropped silently. */
export interface KitResult {
  issued: { bookId: string; title: string; type: string }[];
  unavailable: { bookId: string; title: string; available: number }[];
  unknown: string[];
}

/**
 * Hand out kit to a student, refusing anything that is not on the shelf.
 *
 * Availability is re-checked here rather than trusted from the form: two desks
 * (or two tabs) can both see "1 left". Whatever cannot be issued comes back in
 * `unavailable` / `unknown` so the caller can tell the operator instead of
 * pretending the hand-out succeeded.
 */
export async function issueKitAtAdmission(opts: {
  schoolId: string;
  studentId: string;
  issuedById?: string | null;
  items: string[];
  note?: string;
}): Promise<KitResult> {
  const result: KitResult = { issued: [], unavailable: [], unknown: [] };
  const wanted = [...new Set((opts.items || []).filter(Boolean))];
  if (!wanted.length) return result;

  const catalogue = new Map((await kitAvailability(opts.schoolId)).map((k) => [k.id, k]));
  const takenNow = new Map<string, number>();

  for (const id of wanted) {
    const item = catalogue.get(id);
    if (!item) {
      result.unknown.push(id);
      continue;
    }
    const taken = takenNow.get(id) || 0;
    if (item.available - taken <= 0) {
      result.unavailable.push({ bookId: id, title: item.title, available: item.available });
      continue;
    }
    await prisma.bookIssue.create({
      data: {
        schoolId: opts.schoolId,
        bookId: id,
        studentId: opts.studentId,
        issuedById: opts.issuedById || null,
        issuedAt: new Date(),
        status: "ISSUED",
        fineAmount: 0,
        note: opts.note || "ADMISSION",
      },
    });
    takenNow.set(id, taken + 1);
    result.issued.push({ bookId: id, title: item.title, type: item.type });
  }
  return result;
}

/** Where an admission fee defaults from, and the class's other fee lines. */
export interface FeeDefaults {
  admissionFee: number;
  monthlyFee: number;
  /** "class-template" → a Fee Template for this class; "school-settings" → Fee Settings. */
  source: "class-template" | "school-settings" | "app-default";
  templateName?: string;
  /** Every other line on the class's template (exam, transport…), to bill as-is. */
  extraLines: { title: string; type: string; amount: number }[];
}

const APP_DEFAULT_ADMISSION_FEE = 5000;
const APP_DEFAULT_MONTHLY_FEE = 1500;

/**
 * Resolve what a new admission should be charged (§4.2/§10.3): the class's Fee
 * Template when one exists, else the school's Fee Settings, else the app default.
 * The desk may still override either number on the form.
 */
export async function admissionFeeDefaults(schoolId: string, classId?: string | null): Promise<FeeDefaults> {
  const setting = await prisma.feeSetting.findUnique({ where: { schoolId } });
  const base: FeeDefaults = {
    admissionFee: Number(setting?.admissionFee ?? APP_DEFAULT_ADMISSION_FEE),
    monthlyFee: Number(setting?.monthlyFee ?? APP_DEFAULT_MONTHLY_FEE),
    source: setting ? "school-settings" : "app-default",
    extraLines: [],
  };
  if (!classId) return base;

  const templates: any[] = await prisma.feeTemplate.findMany({ where: { schoolId } });
  const template = templates.find((t) => t.classId === classId);
  if (!template) return base;
  const items: any[] = await prisma.feeTemplateItem.findMany({ where: { templateId: template.id } });
  if (!items.length) return base;

  const admission = items.find((i) => i.type === "ADMISSION");
  const tuition = items.find((i) => i.type === "TUITION");
  return {
    admissionFee: Number(admission?.amount ?? base.admissionFee),
    monthlyFee: Number(tuition?.amount ?? base.monthlyFee),
    source: "class-template",
    templateName: template.name,
    extraLines: items
      .filter((i) => i.type !== "ADMISSION" && i.type !== "TUITION")
      .map((i) => ({ title: String(i.title), type: String(i.type), amount: Number(i.amount) || 0 })),
  };
}
