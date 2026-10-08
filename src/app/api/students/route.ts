import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { enrollStudent } from "@/lib/enroll";
import { resolveSessionId } from "@/lib/academic";
import { getSession, audit } from "@/lib/auth";
import { qrToken, qrPin } from "@/lib/qr";
import { scopeWhere } from "@/lib/permissions";
import { queryId } from "@/lib/utils";
import { resolveBranchId } from "@/lib/branches";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";
import { resolveCollegeEnrolment } from "@/lib/college-enrollment";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "TEACHER", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const searchParams = req.nextUrl.searchParams;
  const schoolId = session.role === "SUPER_ADMIN" ? searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const q = searchParams.get("q") || "";
  const classId = queryId(searchParams, "classId");
  const sectionId = queryId(searchParams, "sectionId");
  const branchId = queryId(searchParams, "branchId");

  // Branch scoping (PRD §12.3): a branch admin only ever sees their own branch.
  // The main admin may drill into any branch via ?branchId= (monitoring).
  const base = session.role === "SUPER_ADMIN" ? { schoolId } : scopeWhere(session);
  const drill = branchId && (session.role === "SUPER_ADMIN" || session.role === "SCHOOL_ADMIN") ? branchId : undefined;

  const where = {
    ...base,
    ...(classId ? { classId } : {}),
    ...(sectionId ? { sectionId } : {}),
    ...(drill ? { branchId: drill } : {}),
    ...(q
      ? {
          OR: [
            { name: { contains: q, mode: "insensitive" } },
            { admissionNo: { contains: q, mode: "insensitive" } },
            { guardianPhone: { contains: q } },
          ],
        }
      : {}),
  };

  // Fetch related list data in bulk. The Firestore adapter cannot join these
  // relations, so an include here would issue several reads per student.
  const [students, classes, sections, fees] = await Promise.all([
    prisma.student.findMany({ where }),
    prisma.classRoom.findMany({ where: base, select: { id: true, name: true, order: true } }),
    prisma.section.findMany({ where: base, select: { id: true, name: true, classId: true } }),
    prisma.fee.findMany({ where: base, select: { id: true, studentId: true, status: true, amount: true, paidAmount: true, feeType: true, title: true } }),
  ]);

  const classById = new Map(classes.map((item: any) => [item.id, item]));
  const sectionById = new Map(sections.map((item: any) => [item.id, item]));
  const feesByStudent = new Map<string, any[]>();
  for (const fee of fees) {
    const studentFees = feesByStudent.get(fee.studentId) || [];
    studentFees.push(fee);
    feesByStudent.set(fee.studentId, studentFees);
  }

  const result = students
    .map((student: any) => ({
      ...student,
      classRoom: student.classId ? classById.get(student.classId) || null : null,
      section: student.sectionId ? sectionById.get(student.sectionId) || null : null,
      fees: feesByStudent.get(student.id) || [],
    }))
    .sort((a: any, b: any) => (Number(a.classRoom?.order || 0) - Number(b.classRoom?.order || 0)) || (Number(a.roll || 0) - Number(b.roll || 0)));
  return NextResponse.json({ data: result });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked; // PRD §12.1 — subscription auto-lock
  const body = await req.json().catch(() => null);
  if (!body || !body.name) return NextResponse.json({ error: "Student name is required." }, { status: 400 });

  const existing = await prisma.student.findFirst({
    where: { schoolId, admissionNo: String(body.admissionNo || "") },
  });
  if (existing) {
    return NextResponse.json({ error: "Admission number already exists for this school." }, { status: 400 });
  }

  const token = qrToken();
  const pin = qrPin();
  const branchId = await resolveBranchId(session, body?.branchId || null);

  try {
    // Create the student, link/create the guardian login and raise the default
    // fees through the shared enrollment kernel. The field set, the guardian gate
    // (body.createGuardian && email), the fee defaults and the fee rows are all
    // exactly what this route did inline before — only the code moved. The one
    // addition is the resolved academic session.
    // Phase 4a — a program/term is college-only. The college helper is invoked
    // ONLY when the request names one, so a plain school student never reaches
    // the college gate (and its request/response stay byte-identical). A SCHOOL
    // tenant that DOES name one is refused 403, never silently ignored.
    let college: { programId: string | null; termNumber: number | null } | null = null;
    if (body.programId !== undefined || body.termNumber !== undefined) {
      const res = await resolveCollegeEnrolment({
        session,
        schoolId,
        programId: body.programId,
        termNumber: body.termNumber,
      });
      if (res.kind === "gate") return res.response;
      if (res.kind === "error") return NextResponse.json({ error: res.message }, { status: res.status });
      college = { programId: res.programId, termNumber: res.termNumber };
    }

    const sessionId = await resolveSessionId(schoolId, body.sessionId || null);
    const enrolled = await enrollStudent({
      schoolId,
      branchId,
      student: {
        schoolId,
        branchId,
        admissionNo: String(body.admissionNo || `STU-${Date.now()}`),
        name: String(body.name),
        dob: body.dob ? new Date(body.dob) : null,
        gender: body.gender || "OTHER",
        bloodGroup: body.bloodGroup || null,
        religion: body.religion || null,
        roll: body.roll ? Number(body.roll) : null,
        registrationNo: body.registrationNo || null,
        classId: body.classId || null,
        sectionId: body.sectionId || null,
        guardianName: body.guardianName || null,
        guardianPhone: body.guardianPhone || null,
        guardianEmail: body.guardianEmail || null,
        guardianRelation: body.guardianRelation || null,
        emergencyContact: body.emergencyContact || null,
        address: body.address || null,
        medicalInfo: body.medicalInfo || null,
        photoUrl: body.photoUrl || null,
        admissionDate: body.admissionDate ? new Date(body.admissionDate) : new Date(),
        qrToken: token,
        qrPin: pin,
        sessionId,
        // Stored only when actually set — a school student never gains the
        // keys, so its stored doc and response are unchanged ("absent" reads
        // as null for the college pages, per D-3-3).
        ...(college?.programId ? { programId: college.programId } : {}),
        ...(college?.termNumber ? { termNumber: college.termNumber } : {}),
      },
      guardian: {
        create: !!body.createGuardian,
        email: body.guardianEmail,
        name: body.guardianName,
        password: body.guardianPassword,
      },
      fees: { ensureDefaults: true, createDefaults: body.createFees !== false, includeBranch: true, branchId },
    });
    const student = enrolled.student;

    await audit("STUDENT_CREATE", "student", student.id, { name: body.name });
    invalidateStats(schoolId, "students");
    invalidateReferenceCache(schoolId);
    return NextResponse.json({ data: { ...student, qrToken: token, qrPin: pin } }, { status: 201 });
  } catch (e: any) {
    if (e?.code === "P2002") {
      return NextResponse.json({ error: "Duplicate record (admission number already used)." }, { status: 400 });
    }
    return NextResponse.json({ error: e?.message || "Failed to create student" }, { status: 500 });
  }
}
