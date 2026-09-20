import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import {
  BUILTIN_CERT_BODIES,
  DEFAULT_CERT_DESIGN,
  buildCertValues,
  resolveCertText,
  type CertTemplateDoc,
} from "@/lib/certificate";

/**
 * PRD §9.2 — Transfer / Character Certificate generator.
 *
 * Returns everything the printable page needs:
 *   • the student's data with father/mother names derived from the guardian
 *     record (falls back cleanly instead of rendering "—")
 *   • the school's custom template for this type when one exists, otherwise
 *     `useBuiltIn: true` and the built-in bodies/design.
 *
 * Auth (hardened):
 *   • GUARDIAN/STUDENT → only their own child's certificate
 *   • TEACHER → only students of their own classes (viewOwnClass)
 *   • other roles need studentTeacherInfo:full, AND the student must belong
 *     to the caller's school (SUPER_ADMIN is the only cross-school reader).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const studentId = req.nextUrl.searchParams.get("studentId");
  const type = req.nextUrl.searchParams.get("type") === "CHARACTER" ? "CHARACTER" : "TC";
  if (!studentId) return NextResponse.json({ error: "studentId is required." }, { status: 400 });

  const isGuardian = session.role === "GUARDIAN" || session.role === "STUDENT";
  const isTeacher = session.role === "TEACHER";

  if (isGuardian) {
    const studentIdOwn =
      session.studentId || (await prisma.student.findFirst({ where: { guardianUserId: session.id } }))?.id;
    if (studentIdOwn !== studentId) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  } else if (!isTeacher && !can(session.role, "studentTeacherInfo", "full")) {
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

  // ---- Tenant isolation: the student must belong to the caller's school ----
  if (session.role !== "SUPER_ADMIN" && student.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Teachers may only certify students of their own classes (viewOwnClass).
  if (isTeacher) {
    const profile = await prisma.teacher.findFirst({ where: { userId: session.id } });
    const assignments = profile
      ? await prisma.classAssignment.findMany({
          where: { teacherId: profile.id, classId: student.classId },
        })
      : [];
    if (!assignments.length) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ---- Father / mother names with graceful derivation ---------------------
  // Students record one guardian name + relation; the linked guardian user
  // account (created via import/enrollment) carries the canonical name.
  const guardianName = student.guardianName || student.guardianUser?.name || null;
  const relation = (student.guardianRelation || "FATHER").toUpperCase();
  const fatherName = relation === "FATHER" ? guardianName : null;
  const motherName = relation === "MOTHER" ? guardianName : null;

  const serial = `CERT-${type === "TC" ? "TC" : "CC"}-${new Date().getFullYear()}-${student.id.slice(-6).toUpperCase()}`;

  // Current academic session title ({{academicYear}}), when one is active.
  const activeSession = await prisma.academicSession.findFirst({
    where: { schoolId: student.schoolId, active: true },
  });

  const values = buildCertValues({
    serial,
    generatedAt: new Date().toISOString(),
    academicYear: activeSession?.name || activeSession?.title || null,
    student: {
      name: student.name,
      fatherName,
      motherName,
      className: student.classRoom?.name || null,
      section: student.section?.name || null,
      admissionNo: student.admissionNo,
      admissionDate: student.admissionDate,
      leavingDate: student.status !== "ACTIVE" ? student.updatedAt : null,
      dob: student.dob,
      conduct: type === "CHARACTER" ? "Good" : null,
      rollNo: student.roll ? String(student.roll) : null,
    },
    school: student.school,
  });

  // ---- Template resolution: custom → built-in -----------------------------
  const templates = (await prisma.certificateTemplate.findMany({
    where: { schoolId: student.schoolId, type },
  })) as CertTemplateDoc[];
  const template = templates.find((t) => t.isDefault) || templates[0] || null;

  const builtin = BUILTIN_CERT_BODIES[type];
  const bodyEn = template?.bodyEn?.trim() || builtin.en;
  const bodyBn = template?.bodyBn?.trim() || builtin.bn;

  return NextResponse.json({
    data: {
      type,
      serial,
      generatedAt: new Date().toISOString(),
      useBuiltIn: !template,
      templateName: template?.name || null,
      template: template
        ? {
            id: template.id,
            name: template.name,
            isDefault: !!template.isDefault,
            bodyEn: template.bodyEn || null,
            bodyBn: template.bodyBn || null,
            design: template.design || null,
          }
        : null,
      values,
      resolved: {
        en: resolveCertText(bodyEn, values),
        bn: resolveCertText(bodyBn, values),
      },
      student: {
        name: student.name,
        nameBn: student.nameBn || null,
        admissionNo: student.admissionNo,
        fatherName,
        motherName,
        guardianName,
        guardianRelation: student.guardianRelation || null,
        className: student.classRoom?.name || null,
        section: student.section?.name || null,
        admissionDate: student.admissionDate,
        leavingDate: student.status !== "ACTIVE" ? student.updatedAt : null,
        dob: student.dob,
        rollNo: student.roll ?? null,
        conduct: type === "CHARACTER" ? "Good" : null,
        previousSchoolName: student.previousSchoolName || null,
      },
      school: student.school,
    },
  });
}
