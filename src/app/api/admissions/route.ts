import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import type { AdmissionStatus } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import {
  canTransition,
  suggestClassIndex,
  findSiblingCandidates,
  payAdmissionFeeAndEnroll,
} from "@/lib/admission";

/**
 * PRD §4 — Admissions API.
 *
 * POST /api/admissions                     → public enquiry form (no login) §4.1 step 1
 * GET  /api/admissions                     → pipeline list (staff)
 * PATCH /api/admissions?id=…               → status transition / edit (staff)
 * POST /api/admissions?action=discount     → propose a discount (accountant/front desk)
 * PATCH /api/admissions?action=discount    → approve/reject a discount (admin)
 * POST /api/admissions?action=enroll       → admission fee payment → full enrollment
 */
export async function POST(req: NextRequest) {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");

  // ---------------------------------------------------------------- public enquiry (no login)
  if (!action) {
    const body = await req.json().catch(() => null);
    const fullName = String(body?.fullName || "").trim();
    const phone = String(body?.guardianPhone || "").trim();
    if (!fullName || !phone) {
      return NextResponse.json({ error: "Student name and guardian phone are required." }, { status: 400 });
    }
    const schoolId = String(body?.schoolId || "");
    if (!schoolId) return NextResponse.json({ error: "School is required." }, { status: 400 });
    const school = await prisma.school.findUnique({ where: { id: schoolId } });
    if (!school) return NextResponse.json({ error: "School not found" }, { status: 404 });

    // Auto-suggest class from previous class (§4.2) — stored as suggestion.
    const classes = await prisma.classRoom.findMany({ where: { schoolId }, select: { id: true, name: true, order: true } });
    const suggestedClassId = suggestClassIndex(body?.previousClass, classes as any);

    const admission = await prisma.admission.create({
      data: {
        schoolId,
        fullName,
        fullNameBn: body?.fullNameBn || null,
        guardianName: body?.guardianName || null,
        guardianPhone: phone,
        guardianEmail: body?.guardianEmail ? String(body.guardianEmail).toLowerCase() : null,
        previousSchoolName: body?.previousSchoolName || null,
        previousClass: body?.previousClass || null,
        status: "ENQUIRY",
        source: "ONLINE_FORM",
        suggestedClassId,
      },
    });
    // Notify front desk + admins of a new enquiry
    const staff = await prisma.user.findMany({
      where: { schoolId, role: { in: ["SCHOOL_ADMIN", "FRONT_DESK"] } },
      select: { id: true },
    });
    await import("@/lib/notify").then((n) =>
      n.notifyUsers({
        schoolId,
        userIds: staff.map((s) => s.id),
        event: "ADMISSION_STATUS",
        title: "New admission enquiry",
        body: `${fullName} (guardian ${phone}) submitted an online enquiry.`,
        link: "/dashboard/admissions",
      })
    );
    return NextResponse.json({ data: { id: admission.id, message: "Enquiry received. Our front desk will contact you." } }, { status: 201 });
  }

  // ---------------------------------------------------------------- staff actions (login + matrix)
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId!;

  if (action === "enroll") {
    if (!can(session.role, "admission", "full") && !can(session.role, "admission", "entry")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const body = await req.json().catch(() => null);
    const admissionId = String(body?.admissionId || "");
    const method = (body?.method || "CASH") as "CASH" | "BANK" | "BKASH" | "NAGAD" | "ROCKET" | "CARD";
    try {
      const result = await payAdmissionFeeAndEnroll(admissionId, { method, refNo: body?.refNo, actorId: session.id });
      await audit("ADMISSION_ENROLL", "admission", admissionId, { studentId: result.student.id });
      return NextResponse.json({
        data: { studentId: result.student.id, admissionNo: result.student.admissionNo, qrToken: result.student.qrToken },
      });
    } catch (e: any) {
      return NextResponse.json({ error: e?.message || "Enrollment failed" }, { status: 400 });
    }
  }

  if (action === "discount") {
    const body = await req.json().catch(() => null);
    const admissionId = String(body?.admissionId || "");
    const admission = await prisma.admission.findUnique({ where: { id: admissionId } });
    if (!admission || admission.schoolId !== schoolId) {
      return NextResponse.json({ error: "Admission not found" }, { status: 404 });
    }

    // Propose (accountant/front desk) — §4.2 approval workflow
    if (req.method === "POST") {
      if (!can(session.role, "admission", "entry") && !can(session.role, "admission", "full")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      const type = body?.type === "FIXED" ? "FIXED" : "PERCENT";
      const originalValue = Number(body?.value);
      if (!originalValue || originalValue <= 0) {
        return NextResponse.json({ error: "Discount value is required." }, { status: 400 });
      }
      const base = Number(admission.payableAmount || admission.admissionFee || 0);
      const amount = type === "PERCENT" ? Math.round((base * originalValue) / 100) : originalValue;
      const discount = await prisma.discount.create({
        data: {
          schoolId,
          admissionId,
          type,
          originalValue,
          amount,
          reason: body?.reason || "OTHER",
          reasonNote: body?.reasonNote || null,
          status: "PROPOSED",
          proposedById: session.id,
        },
      });
      await audit("DISCOUNT_PROPOSE", "discount", discount.id, { admissionId, amount });
      return NextResponse.json({ data: discount }, { status: 201 });
    }

    // Approve / reject (admin) — final approval per §4.2
    if (req.method === "PATCH") {
      if (!can(session.role, "admission", "full")) {
        return NextResponse.json({ error: "Only Admin/Principal can approve discounts." }, { status: 403 });
      }
      const decision = body?.decision === "APPROVED" ? "APPROVED" : "REJECTED";
      const discount = await prisma.discount.update({
        where: { id: String(body?.discountId || "") },
        data: { status: decision, approvedById: session.id, approvedAt: new Date() },
      });
      // Recompute payable on approval: fee − discount
      if (decision === "APPROVED") {
        const admissionFresh = await prisma.admission.findUnique({ where: { id: admissionId } });
        const gross = Number(admissionFresh?.admissionFee || 0);
        const payable = Math.max(0, gross - Number(discount.amount));
        await prisma.admission.update({ where: { id: admissionId }, data: { payableAmount: payable } });
      }
      await audit(`DISCOUNT_${decision}`, "discount", discount.id, { admissionId });
      return NextResponse.json({ data: discount });
    }
  }

  // ---------------------------------------------------------------- pipeline transition / edit
  if (action === "transition") {
    if (!can(session.role, "admission", "full") && !can(session.role, "admission", "entry")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const body = await req.json().catch(() => null);
    const id = String(body?.id || "");
    const to = String(body?.status || "") as AdmissionStatus;
    const admission = await prisma.admission.findUnique({ where: { id } });
    if (!admission || admission.schoolId !== schoolId) {
      return NextResponse.json({ error: "Admission not found" }, { status: 404 });
    }
    if (!canTransition(admission.status, to)) {
      return NextResponse.json({ error: `Cannot move from ${admission.status} to ${to}.` }, { status: 400 });
    }

    const data: Record<string, unknown> = { status: to };
    if (body?.classId !== undefined) data.classId = body.classId || null;
    if (body?.sectionId !== undefined) data.sectionId = body.sectionId || null;
    if (body?.sessionId !== undefined) data.sessionId = body.sessionId || null;
    if (body?.testDate) data.testDate = new Date(body.testDate);
    if (body?.testResult) data.testResult = String(body.testResult);
    if (body?.admissionNo) data.admissionNo = String(body.admissionNo);
    if (to === "SEAT_CONFIRMED") {
      if (body?.admissionFee !== undefined) data.admissionFee = Number(body.admissionFee);
      if (body?.payableAmount !== undefined) data.payableAmount = Number(body.payableAmount);
      else if (body?.admissionFee !== undefined) data.payableAmount = Number(body.admissionFee);
    }

    const updated = await prisma.admission.update({ where: { id }, data });
    await audit("ADMISSION_TRANSITION", "admission", id, { to });
    return NextResponse.json({ data: updated });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}

/** Pipeline list with filters (staff, per §2.1 admission module). */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "admission", "view") && !can(session.role, "admission", "entry") && !can(session.role, "admission", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;

  const where: any = { schoolId };
  if (sp.get("status")) where.status = sp.get("status");
  if (sp.get("q")) {
    where.OR = [
      { fullName: { contains: sp.get("q"), mode: "insensitive" } },
      { guardianPhone: { contains: sp.get("q") } },
      { admissionNo: { contains: sp.get("q"), mode: "insensitive" } },
    ];
  }

  const admissions = await prisma.admission.findMany({
    where,
    include: {
      classRoom: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      documents: { select: { id: true, kind: true, url: true, uploadedAt: true } },
      discounts: true,
      convertedStudent: { select: { id: true, name: true, admissionNo: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ data: admissions });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "admission", "full") && !can(session.role, "admission", "entry")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");
  const admission = await prisma.admission.findUnique({ where: { id } });
  if (!admission || admission.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Admission not found" }, { status: 404 });
  }
  const editable = ["fullName", "fullNameBn", "guardianName", "guardianPhone", "guardianEmail", "previousSchoolName", "previousClass", "leavingReason", "photoUrl", "dob", "gender", "bloodGroup", "religion", "birthCertificateNo", "permanentAddress", "currentAddress"] as const;
  const data: Record<string, unknown> = {};
  for (const key of editable) {
    if (body?.[key] !== undefined) data[key] = body[key];
  }
  const updated = await prisma.admission.update({ where: { id }, data });
  return NextResponse.json({ data: updated });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "admission", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const admission = await prisma.admission.findUnique({ where: { id } });
  if (!admission || admission.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (admission.status === "ENROLLED") {
    return NextResponse.json({ error: "Enrolled admissions cannot be deleted — archive the student instead." }, { status: 400 });
  }
  await prisma.admissionDocument.deleteMany({ where: { admissionId: id } });
  await prisma.discount.deleteMany({ where: { admissionId: id } });
  await prisma.admission.delete({ where: { id } });
  await audit("ADMISSION_DELETE", "admission", id);
  return NextResponse.json({ data: { ok: true } });
}
