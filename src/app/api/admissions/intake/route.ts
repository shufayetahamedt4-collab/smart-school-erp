import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma, invalidateReferenceCache, ON_ROLL_STUDENT } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { resolveBranchId } from "@/lib/branches";
import { invalidateStats } from "@/lib/stats-cache";
import { qrPin, qrToken } from "@/lib/qr";
import { confirmPayment } from "@/lib/ledger";
import { notifyUsers } from "@/lib/notify";
import {
  admissionFeeDefaults,
  findSiblingCandidates,
  issueKitAtAdmission,
  kitAvailability,
  linkSiblingFamily,
} from "@/lib/admission";

/**
 * PRD §4 — the desk's side of admissions: one walk-in, one action.
 *
 * GET  /api/admissions/intake?classId=…        → fee defaults for that class + live kit
 * GET  /api/admissions/intake?phone=&email=&q= → sibling candidates
 * POST /api/admissions/intake                  → admit: student + guardian login + family
 *                                                link + fees + discount + payment + kit + QR
 *
 * The enquiry pipeline (POST /api/admissions?action=…) stays as it is for online
 * applicants who have to be contacted, tested and given a seat over several days.
 * This endpoint is for the family standing at the front desk: everything the desk
 * knows is captured once, and the admission comes out the other side enrolled.
 *
 * It deliberately lives on the `admission` permission module — FRONT_DESK,
 * REGISTRAR and ACCOUNTANT hold `admission: entry` but cannot POST /api/students,
 * so today they cannot admit anyone at all.
 */

const METHODS = ["CASH", "BANK", "BKASH", "NAGAD", "ROCKET", "CARD"] as const;
type Method = (typeof METHODS)[number];

const str = (v: unknown): string => String(v ?? "").trim();
const num = (v: unknown, fallback = 0): number => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
};
const dateOrNull = (v: unknown): Date | null => {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Everything the form needs to price and stock an admission. */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || (!can(session.role, "admission", "view") && !can(session.role, "admission", "entry") && !can(session.role, "admission", "full"))) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;
  const classId = sp.get("classId");
  const phone = sp.get("phone");
  const email = sp.get("email");
  const q = sp.get("q");

  const [feeDefaults, kit] = await Promise.all([
    admissionFeeDefaults(schoolId, classId),
    kitAvailability(schoolId),
  ]);
  const siblings = phone || email || q ? await findSiblingCandidates(schoolId, phone, email, q) : [];

  return NextResponse.json({ data: { feeDefaults, kit, siblings } });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "admission", "entry") && !can(session.role, "admission", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid request body." }, { status: 400 });

  // ------------------------------------------------------------------ validate
  const stud = body?.student || {};
  const guard = body?.guardian || {};
  const sib = body?.sibling || {};
  const feesIn = body?.fees || {};
  const discIn = body?.discount || null;
  const payIn = body?.payment || {};
  const kitIn = body?.kit || {};

  const name = str(stud.name);
  if (!name) return NextResponse.json({ error: "Student name is required." }, { status: 400 });
  const classId = str(stud.classId) || null;
  if (!classId) return NextResponse.json({ error: "Choose the class the student is joining." }, { status: 400 });

  const classRow = await prisma.classRoom.findUnique({ where: { id: classId } });
  if (!classRow || classRow.schoolId !== schoolId) {
    return NextResponse.json({ error: "That class does not belong to this school." }, { status: 400 });
  }
  const sectionId = str(stud.sectionId) || null;
  if (sectionId) {
    const sectionRow = await prisma.section.findUnique({ where: { id: sectionId } });
    if (!sectionRow || sectionRow.schoolId !== schoolId) {
      return NextResponse.json({ error: "That section does not belong to this school." }, { status: 400 });
    }
  }

  const guardianPhone = str(guard.phone) || null;
  const guardianEmail = str(guard.email).toLowerCase() || null;
  if (guard.createLogin && !guardianEmail) {
    return NextResponse.json({ error: "A guardian email is needed to create the login." }, { status: 400 });
  }

  // ------------------------------------------------------- duplicate applicants
  // The desk is the one place a family can be admitted twice by accident (the demo
  // data already had one). An active child of the same guardian with the same name
  // is treated as a duplicate and named, so the operator can confirm rather than
  // guess.
  if (guardianPhone) {
    const samePhone = await prisma.student.findMany({
      where: { schoolId, guardianPhone, ...ON_ROLL_STUDENT },
      select: { id: true, name: true, admissionNo: true },
    });
    const clash = samePhone.find((s: any) => String(s.name).trim().toLowerCase() === name.toLowerCase());
    if (clash) {
      return NextResponse.json(
        { error: `${clash.name} (${clash.admissionNo}) is already enrolled for this guardian phone — open that student instead of admitting them twice.` },
        { status: 400 }
      );
    }
  }

  // ------------------------------------------------------------------ the money
  const defaults = await admissionFeeDefaults(schoolId, classId);
  const admissionFee = Math.max(0, num(feesIn.admissionFee, defaults.admissionFee));
  const monthlyFee = Math.max(0, num(feesIn.monthlyFee, defaults.monthlyFee));
  const createMonthly = feesIn.createMonthly !== false && monthlyFee > 0;

  // A discount entered at the desk is applied on the spot by an admin/principal,
  // and only PROPOSED by everyone else (§4.2 — the approval rule the pipeline uses,
  // expressed once for both paths).
  const canApprove = can(session.role, "admission", "full");
  let discount: { type: "PERCENT" | "FIXED"; originalValue: number; amount: number; status: string; reason: string; reasonNote: string | null } | null = null;
  if (discIn && num(discIn.value, 0) > 0) {
    const type = discIn.type === "FIXED" ? "FIXED" : "PERCENT";
    const originalValue = num(discIn.value, 0);
    if (type === "PERCENT" && (originalValue <= 0 || originalValue > 100)) {
      return NextResponse.json({ error: "A percentage discount must be between 1 and 100." }, { status: 400 });
    }
    const amount = type === "PERCENT" ? Math.round((admissionFee * originalValue) / 100) : Math.round(originalValue);
    if (amount > admissionFee) {
      return NextResponse.json({ error: `The discount (${amount}) is more than the admission fee (${admissionFee}).` }, { status: 400 });
    }
    discount = {
      type,
      originalValue,
      amount,
      status: canApprove ? "APPROVED" : "PROPOSED",
      reason: str(discIn.reason) || "OTHER",
      reasonNote: str(discIn.reasonNote) || null,
    };
  }
  const approvedDiscount = discount?.status === "APPROVED" ? discount.amount : 0;
  const payable = Math.max(0, admissionFee - approvedDiscount);

  // ---------------------------------------------------------------- the payment
  const collect = payIn.collect !== false && payable > 0;
  const method = (METHODS as readonly string[]).includes(payIn.method) ? (payIn.method as Method) : "CASH";
  const refNo = str(payIn.refNo) || null;

  const branchId = await resolveBranchId(session, stud.branchId || null);
  const issueIds: string[] = Array.isArray(kitIn.issue) ? kitIn.issue.map((v: any) => str(v)).filter(Boolean) : [];
  const pendingIds: string[] = Array.isArray(kitIn.pending) ? kitIn.pending.map((v: any) => str(v)).filter(Boolean) : [];

  // --------------------------------------------------------------------- write
  // Written in the pipeline's own order so a failure part-way leaves an APPLIED
  // admission an operator can open and finish, never a silent half-record.
  const done: string[] = [];
  const admission = await prisma.admission.create({
    data: {
      schoolId,
      branchId,
      fullName: name,
      fullNameBn: str(stud.nameBn) || null,
      guardianName: str(guard.name) || null,
      guardianPhone,
      guardianEmail,
      guardianRelation: str(guard.relation) || null,
      dob: dateOrNull(stud.dob),
      gender: str(stud.gender) || "OTHER",
      bloodGroup: str(stud.bloodGroup) || null,
      religion: str(stud.religion) || null,
      birthCertificateNo: str(stud.birthCertificateNo) || null,
      permanentAddress: str(stud.address) || null,
      currentAddress: str(stud.currentAddress) || null,
      previousSchoolName: str(stud.previousSchoolName) || null,
      previousSchoolAddress: str(stud.previousSchoolAddress) || null,
      previousClass: str(stud.previousClass) || null,
      leavingReason: str(stud.leavingReason) || null,
      photoUrl: str(stud.photoUrl) || null,
      classId,
      sectionId,
      status: "APPLIED",
      source: "WALK_IN",
      admissionFee,
      payableAmount: payable,
    },
  });
  done.push("admission record created");

  let studentId: string | null = null;
  const admissionId = admission.id;
  try {
    // ---------------------------------------------------------------- student
    const token = qrToken();
    const pin = qrPin();
    const student = await prisma.student.create({
      data: {
        schoolId,
        branchId,
        admissionNo: str(stud.admissionNo) || `ADM-${Date.now().toString().slice(-6)}`,
        name,
        nameBn: str(stud.nameBn) || null,
        dob: dateOrNull(stud.dob),
        gender: str(stud.gender) || "OTHER",
        bloodGroup: str(stud.bloodGroup) || null,
        religion: str(stud.religion) || null,
        birthCertificateNo: str(stud.birthCertificateNo) || null,
        roll: stud.roll !== undefined && stud.roll !== "" ? num(stud.roll) : null,
        registrationNo: str(stud.registrationNo) || null,
        classId,
        sectionId,
        address: str(stud.address) || null,
        permanentAddress: str(stud.address) || null,
        currentAddress: str(stud.currentAddress) || str(stud.address) || null,
        previousSchoolName: str(stud.previousSchoolName) || null,
        previousSchoolAddress: str(stud.previousSchoolAddress) || null,
        previousClass: str(stud.previousClass) || null,
        leavingReason: str(stud.leavingReason) || null,
        medicalInfo: str(stud.medicalInfo) || null,
        photoUrl: str(stud.photoUrl) || null,
        guardianName: str(guard.name) || null,
        guardianPhone,
        guardianEmail,
        guardianRelation: str(guard.relation) || null,
        emergencyContact: str(guard.emergencyContact) || null,
        admissionDate: dateOrNull(stud.admissionDate) || new Date(),
        status: "ACTIVE",
        qrToken: token,
        qrPin: pin,
      },
    });
    studentId = student.id;
    done.push("student record created");

    // -------------------------------------------------------- guardian account
    let guardianUserId: string | null = null;
    let guardianCreated = false;
    if (guardianEmail) {
      let gUser = await prisma.user.findUnique({ where: { email: guardianEmail } });
      if (!gUser) {
        gUser = await prisma.user.create({
          data: {
            email: guardianEmail,
            name: str(guard.name) || "Guardian",
            role: "GUARDIAN",
            schoolId,
            phone: guardianPhone,
            passwordHash: bcrypt.hashSync(str(guard.password) || "Guardian@123", 10),
          },
        });
        guardianCreated = true;
      }
      guardianUserId = gUser.id;
      await prisma.student.update({ where: { id: student.id }, data: { guardianUserId } });
      done.push(guardianCreated ? "guardian login created" : "linked to the existing guardian login");
    }

    // -------------------------------------------------------------- family link
    let family: { familyId: string; siblingName: string; guardianUserId: string | null } | null = null;
    const siblingId = str(sib.siblingId);
    if (siblingId) {
      family = await linkSiblingFamily({ schoolId, studentId: student.id, siblingId, guardianUserId });
      if (!guardianUserId && family.guardianUserId) guardianUserId = family.guardianUserId;
      done.push(`linked to sibling ${family.siblingName} (family ${family.familyId})`);
    }

    // -------------------------------------------------------------------- fees
    const admissionFeeRow = await prisma.fee.create({
      data: {
        schoolId,
        branchId,
        studentId: student.id,
        title: "Admission Fee",
        amount: admissionFee,
        paidAmount: 0,
        feeType: "ADMISSION",
        status: "UNPAID",
        dueDate: new Date(),
      },
    });
    done.push("admission fee raised");

    let monthlyFeeId: string | null = null;
    if (createMonthly) {
      const monthly = await prisma.fee.create({
        data: {
          schoolId,
          branchId,
          studentId: student.id,
          title: "Monthly Fee",
          amount: monthlyFee,
          paidAmount: 0,
          feeType: "MONTHLY",
          status: "UNPAID",
          dueDate: new Date(Date.now() + 30 * 86400000),
        },
      });
      monthlyFeeId = monthly.id;
      done.push(`monthly fee raised (${monthlyFee})`);
    }
    for (const line of defaults.extraLines) {
      await prisma.fee.create({
        data: {
          schoolId,
          branchId,
          studentId: student.id,
          title: line.title,
          amount: line.amount,
          paidAmount: 0,
          feeType: line.type as any,
          status: "UNPAID",
          dueDate: new Date(),
        },
      });
      done.push(`class template line raised: ${line.title}`);
    }

    // ---------------------------------------------------------------- discount
    let discountRow: any = null;
    if (discount) {
      discountRow = await prisma.discount.create({
        data: {
          schoolId,
          admissionId,
          studentId: student.id,
          type: discount.type,
          originalValue: discount.originalValue,
          amount: discount.amount,
          reason: discount.reason,
          reasonNote: discount.reasonNote,
          status: discount.status,
          proposedById: session.id,
          approvedById: discount.status === "APPROVED" ? session.id : null,
          approvedAt: discount.status === "APPROVED" ? new Date() : null,
        },
      });
      done.push(
        discount.status === "APPROVED"
          ? `discount approved (${discount.amount})`
          : `discount proposed (${discount.amount}) — awaiting an admin`
      );
    }

    // ----------------------------------------------------------------- payment
    let receiptNo: string | null = null;
    if (collect) {
      const payment = await confirmPayment({
        schoolId,
        feeId: admissionFeeRow.id,
        amount: payable,
        method,
        refNo,
        actorId: session.id,
        notify: true,
      });
      receiptNo = payment.receiptNo;
      done.push(`payment of ${payable} confirmed (${receiptNo})`);
    }

    // --------------------------------------------------------------------- kit
    const kit = await issueKitAtAdmission({
      schoolId,
      studentId: student.id,
      issuedById: session.id,
      items: issueIds,
      note: "ADMISSION",
    });
    if (kit.issued.length) done.push(`kit issued: ${kit.issued.map((k) => k.title).join(", ")}`);

    const catalogue = pendingIds.length ? new Map((await kitAvailability(schoolId)).map((k) => [k.id, k])) : new Map();
    const pendingItems = pendingIds
      .map((id) => catalogue.get(id)?.title)
      .filter(Boolean)
      .map((t) => String(t));

    // --------------------------------------------------- finish the admission
    // APPLIED → SEAT_CONFIRMED → ENROLLED through the pipeline's own transitions,
    // so the row is a normal enrolled admission in the list afterwards.
    await prisma.admission.update({ where: { id: admissionId }, data: { status: "SEAT_CONFIRMED" } });
    await prisma.admission.update({
      where: { id: admissionId },
      data: {
        status: "ENROLLED",
        convertedStudentId: student.id,
        admissionNo: student.admissionNo,
        checklist: kit.issued.map((k) => k.title),
        pendingKit: pendingItems,
        uniformSize: str(kitIn.uniformSize) || null,
        idCardIssued: kitIn.idCardIssued === true,
      },
    });
    done.push("admission marked enrolled");

    // -------------------------------------------------------------- tell desk
    const staff = await prisma.user.findMany({
      where: { schoolId, role: { in: ["SCHOOL_ADMIN", "FRONT_DESK", "ACCOUNTANT"] } },
      select: { id: true },
    });
    if (staff.length) {
      await notifyUsers({
        schoolId,
        userIds: staff.map((s) => s.id),
        event: "ADMISSION_STATUS",
        title: "Admission completed at the desk",
        body: `${student.name} (${student.admissionNo}) admitted to ${classRow.name}${
          receiptNo ? ` · fee collected, receipt ${receiptNo}` : " · fee not collected yet"
        }.`,
        link: `/dashboard/students/${student.id}`,
      });
    }
    await audit("ADMISSION_INTAKE", "admission", admissionId, {
      studentId: student.id,
      admissionFee,
      discount: discount ? { ...discount } : null,
      payment: receiptNo,
      kitIssued: kit.issued.length,
      kitPending: pendingItems,
      kitUnavailable: kit.unavailable.map((u) => u.title),
    });

    invalidateStats(schoolId, "students");
    invalidateReferenceCache(schoolId);

    // What the operator still has to do, in plain words.
    const pending: string[] = [];
    if (!collect && payable > 0) pending.push(`Admission fee ${payable} not collected yet — collect it from the Fees page.`);
    if (discount && discount.status === "PROPOSED") pending.push("The discount is proposed and needs an admin's approval.");
    if (kit.unavailable.length) pending.push(`Out of stock, could not hand over: ${kit.unavailable.map((u) => u.title).join(", ")}.`);
    if (kit.unknown.length) pending.push(`${kit.unknown.length} kit item(s) were not in the catalogue.`);
    if (pendingItems.length) pending.push(`Kit to hand over later: ${pendingItems.join(", ")}.`);
    if (!guardianEmail) pending.push("No guardian email — no parent login was created.");
    if (kitIn.idCardIssued !== true) pending.push("ID card not printed yet.");

    return NextResponse.json(
      {
        data: {
          admissionId,
          studentId: student.id,
          admissionNo: student.admissionNo,
          qrToken: token,
          qrPin: pin,
          classRoom: { id: classRow.id, name: classRow.name },
          guardian: { linked: !!guardianUserId, created: guardianCreated, email: guardianEmail },
          family,
          fees: {
            admissionFeeId: admissionFeeRow.id,
            admissionFee,
            monthlyFeeId,
            monthlyFee: createMonthly ? monthlyFee : null,
            discountAmount: approvedDiscount,
            proposedDiscount: discount?.status === "PROPOSED" ? discount.amount : 0,
            payable,
            extraLines: defaults.extraLines,
          },
          discount: discountRow,
          payment: collect ? { collected: true, method, refNo, amount: payable, receiptNo } : null,
          kit: { issued: kit.issued, unavailable: kit.unavailable, unknown: kit.unknown, pending: pendingItems },
          uniformSize: str(kitIn.uniformSize) || null,
          idCardIssued: kitIn.idCardIssued === true,
          done,
          pending,
        },
      },
      { status: 201 }
    );
  } catch (e: any) {
    // The admission record survives, so nothing the desk typed is lost: it lands
    // in the pipeline as an APPLIED row they can open and finish.
    await audit("ADMISSION_INTAKE_FAILED", "admission", admissionId, { step: done.length, error: e?.message || "unknown" });
    return NextResponse.json(
      {
        error: `${e?.message || "Admission failed"} — the applicant was saved as an APPLIED admission (${admissionId}) with what was already done: ${done.join(", ") || "nothing"}.`,
        data: { admissionId, studentId, done },
      },
      { status: 500 }
    );
  }
}
