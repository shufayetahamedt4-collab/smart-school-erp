import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { statsCacheGet, statsCachePut } from "@/lib/stats-cache";

/**
 * PRD §14.2 — dashboard stats for every role.
 *
 * Performance: this connection costs ~2s per round-trip batch to Firestore,
 * so each branch resolves in ONE parallel batch of school-scoped pulls and
 * derives every relation/count in memory (the db layer only pushes one
 * equality filter down and would otherwise do per-relation or per-month
 * queries). Payloads are cached for 30s (src/lib/stats-cache.ts) and
 * invalidated by write routes on attendance/homework/marks/class-student
 * changes, so dashboards never show stale numbers after a submit.
 */

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId!;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const trendStart = new Date(today);
  trendStart.setDate(trendStart.getDate() - 6); // 7-day window start (00:00)

  // ---- SCHOOL ADMIN / SUPER ADMIN (super admin passes schoolId)
  if (session.role === "SCHOOL_ADMIN" || session.role === "SUPER_ADMIN") {
    const sid = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : schoolId;
    if (!sid) return NextResponse.json({ error: "No school context" }, { status: 400 });

    const cacheKey = `admin|${session.id}|${sid}`;
    const cached = statsCacheGet(cacheKey);
    if (cached) return NextResponse.json(cached);

    const [students, teachers, classes, exams, notices, fees, attendanceRows, marksCount] = await Promise.all([
      prisma.student.count({ where: { schoolId: sid, active: true } }),
      prisma.teacher.count({ where: { schoolId: sid } }),
      prisma.classRoom.count({ where: { schoolId: sid } }),
      prisma.exam.count({ where: { schoolId: sid } }),
      prisma.notice.count({ where: { schoolId: sid } }),
      prisma.fee.findMany({ where: { schoolId: sid }, select: { amount: true, paidAmount: true, status: true } }),
      prisma.attendance.findMany({ where: { schoolId: sid, date: { gte: trendStart } }, select: { status: true, date: true } }),
      prisma.examMark.count({ where: { exam: { schoolId: sid } } }),
    ]);

    const totalFees = fees.reduce((a, f) => a + Number(f.amount), 0);
    const paidFees = fees.reduce((a, f) => a + Number(f.paidAmount), 0);
    const dueFees = fees.filter((f) => f.status !== "PAID").reduce((a, f) => a + (Number(f.amount) - Number(f.paidAmount)), 0);

    // attendance trend (last 7 days including today) — grouped in memory
    const attendanceByDate = new Map<string, { status: string }[]>();
    for (const row of attendanceRows) {
      const key = new Date(row.date).toISOString().slice(0, 10);
      const rows = attendanceByDate.get(key) || [];
      rows.push(row);
      attendanceByDate.set(key, rows);
    }
    const trendDays = Array.from({ length: 7 }, (_, index) => 6 - index).map((daysAgo) => {
      const d = new Date(today);
      d.setDate(d.getDate() - daysAgo);
      const rows = attendanceByDate.get(d.toISOString().slice(0, 10)) || [];
      return {
        date: d.toISOString().slice(0, 10),
        label: d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
        present: rows.filter((r) => r.status === "PRESENT" || r.status === "LATE").length,
        absent: rows.filter((r) => r.status === "ABSENT" || r.status === "LEAVE").length,
        total: rows.length,
      };
    });
    const attendanceToday = attendanceByDate.get(today.toISOString().slice(0, 10)) || [];

    const payload = {
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
    };
    statsCachePut(cacheKey, payload, sid);
    return NextResponse.json(payload);
  }

  // ---- TEACHER
  if (session.role === "TEACHER") {
    const cacheKey = `teacher|${session.id}|${schoolId}`;
    const cached = statsCacheGet(cacheKey);
    if (cached) return NextResponse.json(cached);

    // Single parallel batch. teacher-scoped pulls use the db layer's
    // documented deterministic teacher id (t_<userId>) so they can fire in
    // the same batch as the teacher lookup; the fallback below re-pulls with
    // the real id if that convention ever drifts.
    const teacherIdHint = `t_${session.id}`;
    let [teacher, assignments, homeworks, allAttendanceToday, allSections, allStudents, classRooms, subjects] = await Promise.all([
      prisma.teacher.findUnique({ where: { userId: session.id } }),
      prisma.classAssignment.findMany({ where: { schoolId, teacherId: teacherIdHint } }),
      prisma.homework.findMany({ where: { schoolId, teacherId: teacherIdHint }, orderBy: { createdAt: "desc" }, take: 5 }),
      prisma.attendance.findMany({ where: { schoolId, date: today }, select: { markedById: true, status: true } }),
      prisma.section.findMany({ where: { schoolId } }),
      prisma.student.findMany({ where: { schoolId, active: true }, select: { id: true, classId: true } }),
      prisma.classRoom.findMany({ where: { schoolId } }),
      prisma.subject.findMany({ where: { schoolId }, select: { id: true, name: true } }),
    ]);
    if (!teacher) return NextResponse.json({ error: "Teacher profile missing" }, { status: 404 });
    if (teacher.id !== teacherIdHint) {
      [assignments, homeworks] = await Promise.all([
        prisma.classAssignment.findMany({ where: { schoolId, teacherId: teacher.id } }),
        prisma.homework.findMany({ where: { schoolId, teacherId: teacher.id }, orderBy: { createdAt: "desc" }, take: 5 }),
      ]);
    }

    const sectionById = new Map(allSections.map((s) => [s.id, s]));
    const studentsByClass = new Map<string, number>();
    for (const s of allStudents) {
      if (!s.classId) continue;
      studentsByClass.set(s.classId, (studentsByClass.get(s.classId) || 0) + 1);
    }
    const classById = new Map(classRooms.map((c) => [c.id, c]));
    const subjectById = new Map(subjects.map((s) => [s.id, s]));
    const shapedAssignments = assignments.map((a: any) => ({
      ...a,
      classRoom: a.classId ? (classById.get(a.classId) ? { name: classById.get(a.classId)!.name } : null) : null,
      section: a.sectionId ? (sectionById.get(a.sectionId) ? { name: sectionById.get(a.sectionId)!.name } : null) : null,
      subject: a.subjectId ? (subjectById.get(a.subjectId) ? { name: subjectById.get(a.subjectId)!.name } : null) : null,
    }));
    // classes where this teacher has an assignment, with student counts + sections
    const myClassIds = [...new Set(assignments.map((a: any) => a.classId))];
    const myClasses = myClassIds
      .map((classId) => classById.get(classId))
      .filter((c): c is (typeof classRooms)[number] => Boolean(c))
      .map((c) => ({
        ...c,
        _count: { students: studentsByClass.get(c.id) || 0 },
        sections: allSections.filter((s) => s.classId === c.id).map((s) => ({ id: s.id, name: s.name })),
      }))
      // Firestore's implicit doc-id order, preserved from the old code path
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const attendanceToday = allAttendanceToday.filter((a) => a.markedById === teacher.id).length;

    const payload = {
      data: { assignments: shapedAssignments, homeworks, myClasses, attendanceToday },
    };
    statsCachePut(cacheKey, payload, schoolId);
    return NextResponse.json(payload);
  }

  // ---- GUARDIAN
  if (session.role === "GUARDIAN") {
    const cacheKey = `guardian|${session.id}|${schoolId}`;
    const cached = statsCacheGet(cacheKey);
    if (cached) return NextResponse.json(cached);

    // Single parallel batch when session.studentId is known (the normal
    // case): every student-scoped pull keys off it directly. The fallback
    // re-pulls in a second stage when the session carries no studentId.
    const sid0 = session.studentId;
    const [student, attendance0, fees, remarks, marks0, examRows, subjectRows, schoolHomeworks] = await Promise.all([
      sid0 ? prisma.student.findUnique({ where: { id: sid0 } }) : prisma.student.findFirst({ where: { guardianUserId: session.id } }),
      sid0 ? prisma.attendance.findMany({ where: { studentId: sid0 }, select: { status: true, date: true } }) : Promise.resolve([] as any[]),
      sid0 ? prisma.fee.findMany({ where: { studentId: sid0 }, select: { amount: true, paidAmount: true, status: true } }) : Promise.resolve([] as any[]),
      sid0 ? prisma.dailyRemark.count({ where: { studentId: sid0 } }) : Promise.resolve(0),
      sid0 ? prisma.examMark.findMany({ where: { studentId: sid0 } }) : Promise.resolve([] as any[]),
      prisma.exam.findMany({ where: { schoolId }, select: { id: true, name: true, published: true } }),
      prisma.subject.findMany({ where: { schoolId }, select: { id: true, name: true } }),
      prisma.homework.findMany({ where: { schoolId }, select: { id: true, classId: true, sectionId: true } }),
    ]);
    if (!student) return NextResponse.json({ error: "No linked student" }, { status: 404 });

    let attendance = attendance0;
    let marks = marks0;
    let fees2 = fees;
    let remarks2 = remarks;
    if (!sid0) {
      // rare fallback: session had no studentId — pull with the real id now
      [attendance, marks, fees2, remarks2] = await Promise.all([
        prisma.attendance.findMany({ where: { studentId: student.id }, select: { status: true, date: true } }),
        prisma.examMark.findMany({ where: { studentId: student.id } }),
        prisma.fee.findMany({ where: { studentId: student.id }, select: { amount: true, paidAmount: true, status: true } }),
        prisma.dailyRemark.count({ where: { studentId: student.id } }),
      ]);
    }

    // published marks only, with subject/exam names resolved in memory
    const examById = new Map(examRows.map((e) => [e.id, e]));
    const subjectById = new Map(subjectRows.map((s) => [s.id, s]));
    const publishedMarks = marks.filter((m: any) => examById.get(m.examId)?.published);
    const shapedMarks = publishedMarks.map((m: any) => ({
      ...m,
      subject: { id: m.subjectId, name: subjectById.get(m.subjectId)?.name || "" },
      exam: { name: examById.get(m.examId)?.name || "" },
    }));

    // homework count with the original semantics:
    // classId filter only when the student has one; sectionId additionally when set
    const homeworks = !student.classId
      ? schoolHomeworks.length
      : schoolHomeworks.filter(
          (h) => h.classId === student.classId && (!student.sectionId || h.sectionId === student.sectionId)
        ).length;

    const present = attendance.filter((a) => a.status === "PRESENT" || a.status === "LATE").length;
    const dueFees = fees2.reduce((a, f) => a + (Number(f.amount) - Number(f.paidAmount)), 0);

    // 6-month attendance trend — grouped in memory
    const byMonth = new Map<string, { present: number; total: number }>();
    for (const row of attendance) {
      const d = new Date(row.date);
      const key = `${d.getFullYear()}-${d.getMonth()}`;
      const agg = byMonth.get(key) || { present: 0, total: 0 };
      agg.total += 1;
      if (row.status === "PRESENT" || row.status === "LATE") agg.present += 1;
      byMonth.set(key, agg);
    }
    const trend = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date();
      d.setDate(1);
      d.setMonth(d.getMonth() - i);
      const agg = byMonth.get(`${d.getFullYear()}-${d.getMonth()}`);
      trend.push({ label: d.toLocaleDateString("en-GB", { month: "short" }), rate: agg && agg.total ? Math.round((agg.present / agg.total) * 100) : 0 });
    }

    // subject performance from published exams
    const subjectPerf = Object.values(
      shapedMarks.reduce<Record<string, { subject: string; obtained: number; full: number }>>((acc, m) => {
        const key = m.subjectId;
        if (!acc[key]) acc[key] = { subject: m.subject.name, obtained: 0, full: 0 };
        acc[key].obtained += Number(m.obtained);
        acc[key].full += m.fullMarks;
        return acc;
      }, {})
    ).map((s) => ({ ...s, pct: s.full ? Math.round((s.obtained / s.full) * 100) : 0 }));

    const payload = {
      data: {
        attendance: { present, total: attendance.length, rate: attendance.length ? Math.round((present / attendance.length) * 100) : 0 },
        homeworks,
        fees: { due: dueFees, total: fees2.length },
        remarks: remarks2,
        trend,
        subjectPerf,
        marksCount: shapedMarks.length,
      },
    };
    statsCachePut(cacheKey, payload, schoolId);
    return NextResponse.json(payload);
  }

  return NextResponse.json({ error: "Forbidden" }, { status: 403 });
}
