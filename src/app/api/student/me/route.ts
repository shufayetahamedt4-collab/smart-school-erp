import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

/**
 * PRD §7.2 — Student self-service data (limited permissions).
 * Own attendance, results, homework, fees, remarks and class materials.
 * Strictly limited to the STUDENT role and their own records.
 */
export async function GET(_req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "STUDENT") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const student = await prisma.student.findFirst({ where: { userId: session.id } });
  if (!student) return NextResponse.json({ error: "Student profile not linked." }, { status: 404 });

  const [attendance, homeworks, fees, remarks, marks, resources] = await Promise.all([
    prisma.attendance.findMany({
      where: { studentId: student.id },
      orderBy: { date: "desc" },
      take: 60,
      select: { id: true, date: true, status: true },
    }),
    prisma.homework.findMany({
      where: { schoolId: student.schoolId, classId: student.classId || undefined },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { subject: { select: { name: true } } },
    }),
    prisma.fee.findMany({ where: { studentId: student.id }, select: { id: true, title: true, amount: true, paidAmount: true, status: true, dueDate: true } }),
    prisma.dailyRemark.findMany({
      where: { studentId: student.id },
      orderBy: { date: "desc" },
      take: 20,
      include: { teacher: { select: { name: true } } },
    }),
    // Published exam results (own) — §7.2 "View own Result"
    prisma.examMark.findMany({
      where: { studentId: student.id, exam: { published: true } },
      include: {
        subject: { select: { id: true, name: true } },
        exam: { select: { id: true, name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 120,
    }),
    // Digital library — auto-filtered to the student's class (§6.2)
    prisma.resource.findMany({
      where: {
        schoolId: student.schoolId,
        OR: [{ classId: student.classId || undefined }, { classId: null }],
      },
      include: { subject: { select: { name: true } }, teacher: { select: { user: { select: { name: true } } } } },
      orderBy: { createdAt: "desc" },
      take: 30,
    }),
  ]);

  const present = attendance.filter((a) => a.status === "PRESENT" || a.status === "LATE").length;
  const due = fees.reduce((a, f) => a + (Number(f.amount) - Number(f.paidAmount)), 0);

  return NextResponse.json({
    data: {
      student: {
        id: student.id,
        name: student.name,
        admissionNo: student.admissionNo,
        photoUrl: student.photoUrl,
        classRoom: student.classId,
        roll: student.roll,
        qrToken: student.qrToken,
      },
      attendance: { present, total: attendance.length, rate: attendance.length ? Math.round((present / attendance.length) * 100) : 0, recent: attendance.slice(0, 14) },
      homeworks,
      fees: { items: fees, due },
      remarks,
      results: marks,
      resources,
    },
  });
}
