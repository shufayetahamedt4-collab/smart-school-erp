import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { scopeWhere } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";
import { invalidateReferenceCache } from "@/lib/db";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;
  const classId = sp.get("classId") || "";
  // The literal string "undefined" (legacy client bug) or an empty value must
  // mean "no section filter" — not a section whose id is "undefined".
  const rawSectionId = (sp.get("sectionId") || "").trim();
  const sectionId = rawSectionId && rawSectionId !== "undefined" && rawSectionId !== "null" ? rawSectionId : undefined;
  const dateStr = sp.get("date") || "";
  if (!classId || !dateStr) return NextResponse.json({ error: "classId and date are required." }, { status: 400 });
  const date = new Date(`${dateStr}T00:00:00`);

  // Branch scoping (PRD §12.3): a branch admin only marks attendance for their branch.
  const scoped = scopeWhere(session);

  // Single-wave: students + ONE date-windowed attendance pull (the include
  // ran one child query per student), joined in memory. The gte/lt window
  // rides the (schoolId, date) composite index and is re-checked in memory.
  const nextDay = new Date(date);
  nextDay.setDate(nextDay.getDate() + 1);
  const [students, attendanceRows] = await Promise.all([
    prisma.student.findMany({
      where: { ...scoped, classId, sectionId, active: true },
      include: {
        section: { select: { id: true, name: true } },
      },
      orderBy: { roll: "asc" },
    }),
    prisma.attendance.findMany({ where: { ...scoped, date: { gte: date, lt: nextDay } } }),
  ]);
  const sameDay = (d: any) => d && new Date(d).toDateString() === date.toDateString();
  const attByStudent = new Map(
    attendanceRows.filter((a: any) => sameDay(a.date)).map((a: any) => [a.studentId, a])
  );
  return NextResponse.json({
    data: students.map((s) => {
      const att: any = attByStudent.get(s.id);
      return {
        id: s.id,
        name: s.name,
        roll: s.roll,
        admissionNo: s.admissionNo,
        photoUrl: s.photoUrl,
        status: att?.status || "UNMARKED",
        remark: att?.remark || "",
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked; // PRD §12.1 — subscription auto-lock
  const body = await req.json().catch(() => null);
  const { date, rows } = body || {};
  if (!date || !Array.isArray(rows)) return NextResponse.json({ error: "date and rows[] required." }, { status: 400 });

  // Branch stamping (PRD §12.3): attendance rows carry the student's branch so
  // branch admins can query their own branch's registers.
  const rowIds = rows.map((r: any) => r.studentId).filter(Boolean);
  const rowStudents = rowIds.length
    ? await prisma.student.findMany({ where: { id: { in: rowIds } }, select: { id: true, branchId: true } })
    : [];
  const branchOf = new Map(rowStudents.map((s: any) => [s.id, s.branchId]));

  const dt = new Date(`${date}T00:00:00`);
  const teacher = session.role === "TEACHER" ? await prisma.teacher.findUnique({ where: { userId: session.id } }) : null;
  const markedById = teacher?.id || session.id;

  await prisma.$transaction(
    rows
      .filter((r: any) => r.studentId && r.status && r.status !== "UNMARKED")
      .map((r: any) =>
        prisma.attendance.upsert({
          where: { studentId_date: { studentId: r.studentId, date: dt } },
          update: { status: r.status, remark: r.remark || null, markedById: teacher?.id, branchId: branchOf.get(r.studentId) || null },
          create: {
            schoolId,
            branchId: branchOf.get(r.studentId) || null,
            studentId: r.studentId,
            classId: r.classId,
            sectionId: r.sectionId || null,
            date: dt,
            status: r.status,
            remark: r.remark || null,
            markedById,
          },
        })
      )
  );
  await audit("ATTENDANCE_SAVE", "attendance", date);
  invalidateStats(schoolId, "attendance");
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: { ok: true, count: rows.filter((r: any) => r.status && r.status !== "UNMARKED").length } });
}
