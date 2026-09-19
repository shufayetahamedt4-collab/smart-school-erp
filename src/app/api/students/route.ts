import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { qrToken, qrPin } from "@/lib/qr";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const searchParams = req.nextUrl.searchParams;
  const schoolId = session.role === "SUPER_ADMIN" ? searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const q = searchParams.get("q") || "";
  const classId = searchParams.get("classId") || undefined;
  const sectionId = searchParams.get("sectionId") || undefined;

  const where = {
    schoolId,
    ...(classId ? { classId } : {}),
    ...(sectionId ? { sectionId } : {}),
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
    prisma.classRoom.findMany({ where: { schoolId }, select: { id: true, name: true, order: true } }),
    prisma.section.findMany({ where: { schoolId }, select: { id: true, name: true, classId: true } }),
    prisma.fee.findMany({ where: { schoolId }, select: { id: true, studentId: true, status: true, amount: true, paidAmount: true, feeType: true, title: true } }),
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
  if (!session || session.role !== "SCHOOL_ADMIN") {
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

  try {
    const student = await prisma.$transaction(async (tx) => {
      const s = await tx.student.create({
        data: {
          schoolId,
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
        },
      });

      if (body.createGuardian && body.guardianEmail) {
        let gUser = await tx.user.findUnique({ where: { email: String(body.guardianEmail).toLowerCase() } });
        if (!gUser) {
          gUser = await tx.user.create({
            data: {
              email: String(body.guardianEmail).toLowerCase(),
              name: body.guardianName || "Guardian",
              role: "GUARDIAN",
              schoolId,
              passwordHash: bcrypt.hashSync(body.guardianPassword || "Guardian@123", 10),
            },
          });
        }
        if (!s.guardianUserId) {
          await tx.student.update({ where: { id: s.id }, data: { guardianUserId: gUser.id } });
        }
      }

      await tx.feeSetting.upsert({
        where: { schoolId },
        update: {},
        create: { schoolId, monthlyFee: 1500, admissionFee: 5000 },
      });
      const setting = await tx.feeSetting.findUnique({ where: { schoolId } });
      if (setting && body.createFees !== false) {
        await tx.fee.createMany({
          data: [
            { schoolId, studentId: s.id, feeType: "ADMISSION", title: "Admission Fee", amount: setting.admissionFee, dueDate: new Date() },
            { schoolId, studentId: s.id, feeType: "MONTHLY", title: "Monthly Fee", amount: setting.monthlyFee, status: "UNPAID", dueDate: new Date(Date.now() + 30 * 86400000) },
          ],
        });
      }
      return s;
    });

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
