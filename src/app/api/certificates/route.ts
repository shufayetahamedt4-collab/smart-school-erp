import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, resolveActingStudent } from "@/lib/auth";
import { can } from "@/lib/permissions";

/**
 * PRD §9.2 — Transfer Certificate / Character Certificate auto-generator.
 * Returns all template data; the printable page (src/app/print/certificate)
 * renders the PDF-ready layout with signature/seal space.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const studentId = req.nextUrl.searchParams.get("studentId");
  const type = req.nextUrl.searchParams.get("type") === "CHARACTER" ? "CHARACTER" : "TC";
  if (!studentId) return NextResponse.json({ error: "studentId is required." }, { status: 400 });

  // Guardians may only view their own child's certificate — any of their
  // children, asked for by id (§5.4 siblings), and nothing but their own.
  if (session.role === "GUARDIAN" || session.role === "STUDENT") {
    const own = await resolveActingStudent(session, session.role === "GUARDIAN" ? studentId : null);
    if (!own || own.id !== studentId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  } else if (!can(session.role, "studentTeacherInfo", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      school: { select: { name: true, address: true, phone: true, email: true, logoUrl: true } },
      classRoom: { select: { name: true } },
      section: { select: { name: true } },
      guardianUser: { select: { name: true } },
    },
  });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });
  // Tenant isolation: staff of one school must not read another school's
  // student certificate by guessing the id (SUPER_ADMIN is cross-school).
  if (session.role !== "SUPER_ADMIN" && student.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  const serial = `CERT-${type === "TC" ? "TC" : "CC"}-${new Date().getFullYear()}-${student.id.slice(-6).toUpperCase()}`;
  return NextResponse.json({
    data: {
      type,
      serial,
      generatedAt: new Date().toISOString(),
      student: {
        name: student.name,
        nameBn: student.nameBn || null,
        admissionNo: student.admissionNo,
        dob: student.dob,
        guardianName: student.guardianName || student.guardianUser?.name || null,
        className: student.classRoom?.name || null,
        section: student.section?.name || null,
        admissionDate: student.admissionDate,
        leavingDate: student.status !== "ACTIVE" ? student.updatedAt : null,
        conduct: type === "CHARACTER" ? "Good" : null,
        previousSchoolName: student.previousSchoolName || null,
      },
      school: student.school,
    },
  });
}
