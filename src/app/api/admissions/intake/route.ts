import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache, ON_ROLL_STUDENT, intakeAdmissionId, schoolPaymentIds } from "@/lib/db";
import { enrollStudent } from "@/lib/enroll";
import { resolveSessionId } from "@/lib/academic";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { resolveBranchId } from "@/lib/branches";
import { invalidateStats } from "@/lib/stats-cache";
import { qrPin, qrToken } from "@/lib/qr";
import { confirmPayment } from "@/lib/ledger";
import { notifyUsers } from "@/lib/notify";
import { money } from "@/lib/utils";
import {
  admissionFeeDefaults,
  findSiblingCandidates,
  issueKitAtAdmission,
  kitAvailability,
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

/**
 * pilot P2b — how a REPLAY of one intake attempt is answered.
 *
 * The winner writes the admission row FIRST and stamps it with `startedAt`; the
 * student link (`convertedStudentId`) appears when the whole flow is done. A
 * loser of the race polls for that link for up to `REPLAY_WAIT_MS` (the flow is
 * a handful of writes — a second or two in production), and an attempt whose
 * stamp is already older than `REPLAY_STALE_MS` is refused at once instead of
 * waited on: that is a crash, and the operator must open the APPLIED admission
 * (or start a new attempt) rather than re-run the flow and duplicate the family.
 */
const REPLAY_WAIT_MS = 15_000;
const REPLAY_POLL_MS = 300;
const REPLAY_STALE_MS = 180_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

  // ------------------------------------------------------------------- P2b key
  // The intake key is OPTIONAL (absent/empty = the old behaviour, unchanged for
  // every API caller), and it may arrive in the body or as `x-idempotency-key`.
  // A key that IS present must be usable: silently ignoring a malformed one
  // would quietly turn a once-only admission into a repeatable one, so it is
  // refused by name before any read or write (the pay route's own rule, same
  // text). Nothing but the key's HASH is ever stored (see intakeAdmissionId).
  const rawKey = body?.idempotencyKey ?? req.headers.get("x-idempotency-key");
  let idempotencyKey: string | null = null;
  if (rawKey !== undefined && rawKey !== null && rawKey !== "") {
    if (typeof rawKey !== "string" || rawKey.trim().length < 8 || rawKey.trim().length > 120) {
      return NextResponse.json({ error: "idempotencyKey must be between 8 and 120 characters." }, { status: 400 });
    }
    idempotencyKey = rawKey.trim();
  }
  // One admission, one admission-fee payment: the payment's own key is derived
  // from the intake key, so a second attempt at the same fee row can only ever
  // replay the receipt the first one wrote.
  const attemptAdmissionId = idempotencyKey ? intakeAdmissionId(schoolId, idempotencyKey) : null;
  const paymentAttemptKey = idempotencyKey ? `${idempotencyKey}:admission-fee` : null;

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

  /**
   * P2b — answer a request whose keyed attempt already exists, writing NOTHING.
   *
   * The first request's admission row is the record: the student, its fee rows
   * and the payment row are read back FROM it, so a sequential retry, a second
   * tab or the loser of a simultaneous pair all get the ORIGINAL admission, the
   * ORIGINAL receipt and the SAME QR slip (the token and PIN live on the student
   * row) — never a second family.
   *
   * A row without `convertedStudentId` is either the winner still working (the
   * caller waits for the link above) or a crash (refused by name, with the
   * admission id and the state it was left in).
   */
  const answerFromRecord = async (row: any) => {
    // The id this attempt is filed under. A row handed back by the gate carries
    // the DATA it was written with — not the document id — so the id is taken
    // from the row when it has one and from the key's own derivation otherwise:
    // every message and every re-read below must name THIS admission, never
    // whatever a lookup with an undefined id happens to return.
    const recordId = String(row?.id || attemptAdmissionId || "");
    const storedName = String(row?.fullName || "").trim();
    if (storedName.toLowerCase() !== name.toLowerCase()) {
      return NextResponse.json(
        { error: `This admission key was already used for ${storedName}. Start a new admission to admit someone else.` },
        { status: 409 }
      );
    }
    if (row?.classId && classId && String(row.classId) !== classId) {
      return NextResponse.json(
        { error: "This admission key was already used for a different class. Start a new admission to move the child." },
        { status: 409 }
      );
    }

    let current = row;
    const startedAt = current?.intake?.startedAt ? new Date(current.intake.startedAt).getTime() : 0;
    const crashed = !current?.convertedStudentId && startedAt > 0 && Date.now() - startedAt > REPLAY_STALE_MS;
    const deadline = Date.now() + REPLAY_WAIT_MS;
    while (!current?.convertedStudentId && !crashed && Date.now() < deadline) {
      await sleep(REPLAY_POLL_MS);
      const again = await prisma.admission.findUnique({ where: { id: recordId } }).catch(() => null);
      if (again) current = again;
    }
    if (!current?.convertedStudentId) {
      return NextResponse.json(
        {
          error: `This admission attempt was already started (${recordId}, ${row.status || "APPLIED"}) and nothing new was written. Open that admission to finish it, or start a new admission.`,
        },
        { status: 409 }
      );
    }

    const student = await prisma.student.findUnique({ where: { id: current.convertedStudentId } });
    if (!student) {
      return NextResponse.json(
        { error: `This admission attempt was already started (${recordId}) and nothing new was written. Open that admission to finish it.` },
        { status: 409 }
      );
    }

    const fees = await prisma.fee.findMany({ where: { schoolId, studentId: student.id } });
    const admissionFeeRow = fees.find((f: any) => String(f.feeType) === "ADMISSION") || null;
    const monthlyRow = fees.find((f: any) => String(f.feeType) === "MONTHLY") || null;
    const extras = fees.filter((f: any) => String(f.feeType) !== "ADMISSION" && String(f.feeType) !== "MONTHLY");
    const discounts = await prisma.discount.findMany({ where: { schoolId, admissionId: row.id } });
    const proposed = discounts.find((d: any) => String(d.status) === "PROPOSED") || null;

    // The payment row is deterministic for a keyed attempt, so the replay reads
    // the ORIGINAL receipt (with its refNo) instead of minting or guessing one.
    let payment: any = null;
    if (admissionFeeRow) {
      const seen = paymentAttemptKey
        ? await prisma.payment
            .findUnique({ where: { id: schoolPaymentIds(schoolId, admissionFeeRow.id, paymentAttemptKey).paymentId } })
            .catch(() => null)
        : null;
      const stamp = admissionFeeRow.idempotency && typeof admissionFeeRow.idempotency === "object" ? admissionFeeRow.idempotency : null;
      if (seen) {
        payment = {
          collected: true,
          method: (seen as any).method ?? null,
          refNo: (seen as any).refNo ?? null,
          amount: money((seen as any).amount),
          receiptNo: (seen as any).receiptNo ?? null,
        };
      } else if (stamp?.receiptNo) {
        payment = { collected: true, method: stamp.method ?? null, refNo: null, amount: money(stamp.amount), receiptNo: String(stamp.receiptNo) };
      }
    }

    let family: any = null;
    if (student.familyId) {
      const familyRows = await prisma.student.findMany({ where: { schoolId, familyId: student.familyId } });
      const sibling = familyRows.find((s: any) => s.id !== student.id) || null;
      family = { familyId: student.familyId, siblingName: sibling?.name ?? null, guardianUserId: student.guardianUserId ?? null };
    }

    const feeAmount = money(admissionFeeRow?.amount ?? row.admissionFee);
    const due = Math.max(0, feeAmount - money(admissionFeeRow?.paidAmount));
    const pending: string[] = [];
    if (due > 0 && money(row.payableAmount) > 0) pending.push(`Admission fee ${due} not collected yet — collect it from the Fees page.`);
    if (proposed) pending.push("The discount is proposed and needs an admin's approval.");
    if (!student.guardianUserId && guardianEmail) pending.push("The guardian login for this child is not linked yet.");
    if (!student.guardianEmail) pending.push("No guardian email — no parent login was created.");
    if (Array.isArray(current.pendingKit) && current.pendingKit.length) pending.push(`Kit to hand over later: ${current.pendingKit.join(", ")}.`);
    if (current.idCardIssued !== true) pending.push("ID card not printed yet.");

    return NextResponse.json({
      data: {
        admissionId: recordId,
        studentId: student.id,
        admissionNo: student.admissionNo ?? row.admissionNo ?? null,
        qrToken: student.qrToken ?? null,
        qrPin: student.qrPin ?? null,
        classRoom: classRow ? { id: classRow.id, name: classRow.name } : null,
        guardian: { linked: !!student.guardianUserId, created: false, email: student.guardianEmail ?? null },
        family,
        fees: {
          admissionFeeId: admissionFeeRow?.id ?? null,
          admissionFee: feeAmount,
          monthlyFeeId: monthlyRow?.id ?? null,
          monthlyFee: monthlyRow ? money(monthlyRow.amount) : null,
          discountAmount: Math.max(0, money(row.admissionFee) - money(row.payableAmount)),
          proposedDiscount: proposed ? money(proposed.amount) : 0,
          payable: money(row.payableAmount),
          extraLines: extras.map((f: any) => ({ title: f.title, type: f.feeType, amount: money(f.amount) })),
        },
        discount: null,
        payment,
        kit: {
          issued: Array.isArray(current.checklist) ? current.checklist.map((title: string) => ({ title })) : [],
          unavailable: [],
          unknown: [],
          pending: Array.isArray(current.pendingKit) ? current.pendingKit : [],
        },
        uniformSize: current.uniformSize ?? null,
        idCardIssued: current.idCardIssued === true,
        done: ["Replayed from the admission already recorded — nothing new was written"],
        pending,
        replay: true,
      },
    });
  };

  // A keyed request whose attempt already exists is answered BEFORE any other
  // work: the replay must not need the pricing, the phone+name guard or the kit
  // reads to return the original result.
  if (attemptAdmissionId) {
    const already = await prisma.admission.findUnique({ where: { id: attemptAdmissionId } }).catch(() => null);
    if (already) return await answerFromRecord(already);
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
      // P2b — a KEYED request that lost the race to its own first submit must be
      // answered from its record, not refused as a duplicate applicant. A
      // DIFFERENT key (a deliberately new admission for the same child) still
      // hits this guard, which is exactly what it is for.
      if (attemptAdmissionId) {
        const mine = await prisma.admission.findUnique({ where: { id: attemptAdmissionId } }).catch(() => null);
        if (mine) return await answerFromRecord(mine);
      }
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
  const admissionData = {
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
  };

  // ------------------------------------------------ P2b — the create-once gate
  // The admission row is the request's FIRST write, so it is the boundary: a
  // keyed attempt is created inside a real Firestore transaction
  // (`$guardedUpdate`; deciding on a missing row inserts it, and the loser of a
  // race is handed the winner's row), and anything it hands back that already
  // exists is answered from that record — never re-run. The keyless path is
  // byte-for-byte the old create, so every existing caller is untouched.
  let admission: any = null;
  if (attemptAdmissionId) {
    const gate = await prisma.$guardedUpdate("admission", attemptAdmissionId, (current) =>
      current
        ? { ok: false, error: "already recorded" }
        : {
            ok: true,
            data: {
              ...admissionData,
              // Server-side only (never returned): which keyed attempt this row
              // belongs to (the id IS the key's hash), when it started and who
              // started it. The replay uses `startedAt` to tell a crash from a
              // race it should wait for.
              intake: { keyId: attemptAdmissionId, startedAt: new Date(), by: session.id },
            },
          }
    );
    if (gate.ok) admission = gate.row;
    else if (gate.reason === "REFUSED") return await answerFromRecord(gate.holder);
    else
      return NextResponse.json(
        { error: "The admission could not be reserved just now — nothing was written. Try again." },
        { status: 500 }
      );
  } else {
    admission = await prisma.admission.create({ data: admissionData });
  }
  if (!admission) {
    return NextResponse.json(
      { error: "The admission could not be reserved just now — nothing was written. Try again." },
      { status: 500 }
    );
  }
  done.push("admission record created");

  let studentId: string | null = null;
  const admissionId = admission.id;
  try {
    // ------------------------------------- student + guardian + family + fees
    // All four go through the shared enrollment kernel — the same code path the
    // enquiry-pipeline enrollment uses — and the `done` log is pushed in the same
    // order as before, so the desk sees exactly the same trail.
    const token = qrToken();
    const pin = qrPin();
    const sessionId = await resolveSessionId(schoolId, stud.sessionId || null);
    const enrolled = await enrollStudent({
      schoolId,
      branchId,
      student: {
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
        sessionId,
      },
      // pilot P1c — no guardian password is accepted here: the kernel mints
      // an unusable one and the guardian signs in with the QR slip below.
      guardian: {
        create: true,
        email: guardianEmail,
        name: str(guard.name) || "Guardian",
        phone: guardianPhone,
      },
      family: { siblingId: str(sib.siblingId) || null },
      fees: {
        includeBranch: true,
        branchId,
        rows: [
          { title: "Admission Fee", amount: admissionFee, feeType: "ADMISSION" },
          ...(createMonthly ? [{ title: "Monthly Fee", amount: monthlyFee, feeType: "MONTHLY", dueInDays: 30 }] : []),
          ...defaults.extraLines.map((line) => ({ title: line.title, amount: line.amount, feeType: line.type })),
        ],
      },
    });

    const student = enrolled.student;
    studentId = student.id;
    done.push("student record created");

    const guardianUserId = enrolled.guardianUserId;
    const guardianCreated = enrolled.guardianCreated;
    if (guardianEmail) {
      done.push(guardianCreated ? "guardian login created" : "linked to the existing guardian login");
    }

    const family = enrolled.family;
    if (family) {
      done.push(`linked to sibling ${family.siblingName} (family ${family.familyId})`);
    }

    if (!enrolled.admissionFeeId) throw new Error("Admission fee row was not created.");
    const admissionFeeRow = { id: enrolled.admissionFeeId };
    done.push("admission fee raised");

    const monthlyFeeId = enrolled.monthlyFeeId;
    if (createMonthly) done.push(`monthly fee raised (${monthlyFee})`);
    for (const line of defaults.extraLines) done.push(`class template line raised: ${line.title}`);

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
        // P2b — the intake key derives the payment key, so a repeat of this
        // attempt can only ever replay the receipt written the first time.
        idempotencyKey: paymentAttemptKey,
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
          // P2b — a keyed write says so explicitly (the school fee route's own
          // shape); a keyless caller's response is exactly what it always was.
          ...(idempotencyKey ? { replay: false } : {}),
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
