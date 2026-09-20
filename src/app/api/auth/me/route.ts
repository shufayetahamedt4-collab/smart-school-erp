import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ---------------------------------------------------------------- QR guardian synthetic session
  // /api/qr/verify signs a session WITHOUT a user document (id = `qr-<studentId>`).
  // It must resolve to a minimal READ-ONLY identity built from the signed
  // claims + the linked student record — never from a user lookup.
  const isQrSession = session.role === "GUARDIAN" && !!session.studentId && String(session.id).startsWith("qr-");
  if (isQrSession) {
    const studentId = String(session.studentId);
    const schoolId = session.schoolId ? String(session.schoolId) : null;
    if (!schoolId) return NextResponse.json({ error: "Invalid session" }, { status: 401 });

    const student = await prisma.student.findFirst({
      where: { id: studentId, schoolId, active: true },
      select: {
        id: true,
        name: true,
        guardianName: true,
        admissionNo: true,
        photoUrl: true,
        classRoom: { select: { name: true } },
        section: { select: { name: true } },
      },
    });
    if (!student) return NextResponse.json({ error: "Account not found" }, { status: 401 });

    const school = await prisma.school.findUnique({
      where: { id: schoolId },
      select: { id: true, name: true, slug: true, logoUrl: true, plan: true, status: true, tagline: true, themeColor: true },
    });
    if (!school || school.status === "SUSPENDED") {
      return NextResponse.json({ error: "School unavailable" }, { status: 401 });
    }

    // Minimal identity — same shape /api/auth/me returns for account guardians.
    return NextResponse.json({
      data: {
        user: {
          id: session.id,
          name: student.guardianName || student.name,
          email: session.email ?? null,
          role: "GUARDIAN",
          schoolId,
          studentId,
        },
        school,
        student,
      },
    });
  }

  const user = await prisma.user.findUnique({
    where: { id: session.id },
    select: { id: true, name: true, email: true, phone: true, role: true, schoolId: true, photoUrl: true },
  });

  if (!user) {
    return NextResponse.json({ error: "Account not found" }, { status: 401 });
  }

  const school = user.schoolId
    ? await prisma.school.findUnique({
        where: { id: user.schoolId },
        select: { id: true, name: true, slug: true, logoUrl: true, plan: true, status: true, tagline: true, themeColor: true },
      })
    : null;

  let student = null;
  if (user.role === "GUARDIAN") {
    const studentId = session.studentId;
    student = await prisma.student.findFirst({
      where: studentId ? { id: studentId } : { guardianUserId: user.id },
      select: {
        id: true,
        name: true,
        admissionNo: true,
        photoUrl: true,
        classRoom: { select: { name: true } },
        section: { select: { name: true } },
      },
    });
  }

  return NextResponse.json({ data: { user, school, student } });
}
