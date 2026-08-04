import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function GET() {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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
        select: { id: true, name: true, slug: true, logoUrl: true, plan: true, status: true, tagline: true },
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
