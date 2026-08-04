import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";

export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const student = await prisma.student.findUnique({
    where: { qrToken: token },
    select: {
      id: true,
      name: true,
      admissionNo: true,
      photoUrl: true,
      guardianName: true,
      guardianRelation: true,
      school: { select: { name: true, logoUrl: true } },
      classRoom: { select: { name: true } },
      section: { select: { name: true } },
    },
  });

  if (!student) {
    return NextResponse.json({ error: "Invalid or expired QR code." }, { status: 404 });
  }

  return NextResponse.json({
    data: {
      token,
      student: {
        ...student,
        schoolName: student.school.name,
      },
    },
  });
}
