import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId!;
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  // ---- SCHOOL ADMIN / SUPER ADMIN (super admin passes schoolId)
  if (session.role === "SCHOOL_ADMIN" || session.role === "SUPER_ADMIN") {
    const sid = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : schoolId;
    if (!sid) return NextResponse.json({ error: "No school context" }, { status: 400 });

    const [students, teachers, classes, exams, notices, fees, attendanceToday, marksCount] = await Promise.all([
      prisma.student.count({ where: { schoolId: sid, active: true } }),
      prisma.teacher.count({ where: { schoolId: sid } }),
      prisma.classRoom.count({ where: { schoolId: sid } }),
      prisma.exam.count({ where: { schoolId: sid } }),
      prisma.notice.count({ where: { schoolId: sid } }),
      prisma.fee.findMany({ where: { schoolId: sid }, select: { amount: true, paidAmount: true, status: true } }),
      prisma.attendance.findMany({ where: { schoolId: sid, date: today }, select: { status: true } }),
      prisma.examMark.count({ where: { exam: { schoolId: sid } } }),
    ]);

    const totalFees = fees.reduce((a, f) => a + Number(f.amount), 0);
    const paidFees = fees.reduce((a, f) => a + Number(f.paidAmount), 0);
    const dueFees = fees.filter((f) => f.status !== "PAID").reduce((a, f) => a + (Number(f.amount) - Number(f.paidAmount)), 0);

    // attendance trend (last 7 days including today)
    const trendDays = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const rows = await prisma.attendance.findMany({ where: { schoolId: sid, date: d }, select: { status: true } });
      trendDays.push({
        date: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
        present: rows.filter((r) => r.status === "PRESENT" || r.status === "LATE").length,
        absent: rows.filter((r) => r.status === "ABSENT" || r.status === "LEAVE").length,
        total: rows.length,
      });
    }

    return NextResponse.json({
      data: {
        counts: { students, teachers, classes, exams, notices, marksCount },
        fees: { totalFees, paidFees, dueFees, unpaidCount: fees.filter((f) => f.status === "UNPAID").length },
        attendanceToday: {
          present: attendanceToday.filter((a) => a.status === "PRESENT" || a.status === "LATE").length,
          absent: attendanceToday.filter((a) => a.status === "ABSENT" || a.status === "LEAVE").length,
          total: attendanceToday.length,
        },
        trend: trendDays,
      },
    });
  }

  // ---- TEACHER
  if (session.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
    if (!teacher) return NextResponse.json({ error: "Teacher profile missing" }, { status: 404 });
    const [assignments, homeworks, attendanceToday] = await Promise.all([
      prisma.classAssignment.findMany({ where: { teacherId: teacher.id }, include: { classRoom: { select: { name: true } }, section: { select: { name: true } }, subject: { select: { name: true } } } }),
      prisma.homework.findMany({ where: { teacherId: teacher.id }, orderBy: { createdAt: "desc" }, take: 5 }),
      prisma.attendance.findMany({ where: { schoolId, date: today, markedById: teacher.id }, select: { status: true } }),
    ]);
    const myClasses = await prisma.classRoom.findMany({
      where: { assignments: { some: { teacherId: teacher.id } } },
      include: { _count: { select: { students: true } }, sections: { select: { id: true, name: true } } },
    });
    return NextResponse.json({ data: { assignments, homeworks, myClasses, attendanceToday: attendanceToday.length } });
  }

  // ---- GUARDIAN
  if (session.role === "GUARDIAN") {
    const student = session.studentId
      ? await prisma.student.findUnique({ where: { id: session.studentId } })
      : await prisma.student.findFirst({ where: { guardianUserId: session.id } });
    if (!student) return NextResponse.json({ error: "No linked student" }, { status: 404 });

    const [attendance, homeworks, fees, remarks] = await Promise.all([
      prisma.attendance.findMany({ where: { studentId: student.id }, select: { status: true } }),
      prisma.homework.count({ where: { schoolId: student.schoolId, classId: student.classId || undefined, sectionId: student.sectionId || undefined } }),
      prisma.fee.findMany({ where: { studentId: student.id }, select: { amount: true, paidAmount: true, status: true } }),
      prisma.dailyRemark.count({ where: { studentId: student.id } }),
    ]);
    const present = attendance.filter((a) => a.status === "PRESENT" || a.status === "LATE").length;
    const dueFees = fees.reduce((a, f) => a + (Number(f.amount) - Number(f.paidAmount)), 0);

    // 6-month attendance trend
    const trend = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const start = new Date(d.getFullYear(), d.getMonth(), 1);
      const end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      const rows = await prisma.attendance.findMany({ where: { studentId: student.id, date: { gte: start, lt: end } } });
      const p = rows.filter((r) => r.status === "PRESENT" || r.status === "LATE").length;
      trend.push({ label: d.toLocaleDateString("en-GB", { month: "short" }), rate: rows.length ? Math.round((p / rows.length) * 100) : 0 });
    }

    // subject performance from published exams
    const marks = await prisma.examMark.findMany({
      where: { studentId: student.id, exam: { published: true } },
      include: { subject: { select: { id: true, name: true } }, exam: { select: { name: true } } },
    });
    const subjectPerf = Object.values(
      marks.reduce<Record<string, { subject: string; obtained: number; full: number }>>((acc, m) => {
        const key = m.subjectId;
        if (!acc[key]) acc[key] = { subject: m.subject.name, obtained: 0, full: 0 };
        acc[key].obtained += Number(m.obtained);
        acc[key].full += m.fullMarks;
        return acc;
      }, {})
    ).map((s) => ({ ...s, pct: s.full ? Math.round((s.obtained / s.full) * 100) : 0 }));

    return NextResponse.json({
      data: {
        attendance: { present, total: attendance.length, rate: attendance.length ? Math.round((present / attendance.length) * 100) : 0 },
        homeworks,
        fees: { due: dueFees, total: fees.length },
        remarks,
        trend,
        subjectPerf,
        marksCount: marks.length,
      },
    });
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
