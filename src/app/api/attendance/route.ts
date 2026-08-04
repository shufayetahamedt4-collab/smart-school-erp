import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;
  const classId = sp.get("classId") || "";
  const sectionId = sp.get("sectionId") || undefined;
  const dateStr = sp.get("date") || "";
  if (!classId || !dateStr) return NextResponse.json({ error: "classId and date are required." }, { status: 400 });
  const date = new Date(`${dateStr}T00:00:00`);

  const students = await prisma.student.findMany({
    where: { schoolId, classId, sectionId, active: true },
    include: {
      section: { select: { id: true, name: true } },
      attendance: { where: { date }, take: 1 },
    },
    orderBy: { roll: "asc" },
  });
  return NextResponse.json({
    data: students.map((s) => ({
      id: s.id,
      name: s.name,
      roll: s.roll,
      admissionNo: s.admissionNo,
      photoUrl: s.photoUrl,
      status: s.attendance[0]?.status || "UNMARKED",
      remark: s.attendance[0]?.remark || "",
    })),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const { date, rows } = body || {};
  if (!date || !Array.isArray(rows)) return NextResponse.json({ error: "date and rows[] required." }, { status: 400 });

  const dt = new Date(`${date}T00:00:00`);
  const teacher = session.role === "TEACHER" ? await prisma.teacher.findUnique({ where: { userId: session.id } }) : null;
  const markedById = teacher?.id || session.id;

  await prisma.$transaction(
    rows
      .filter((r: any) => r.studentId && r.status && r.status !== "UNMARKED")
      .map((r: any) =>
        prisma.attendance.upsert({
          where: { studentId_date: { studentId: r.studentId, date: dt } },
          update: { status: r.status, remark: r.remark || null, markedById: teacher?.id },
          create: {
            schoolId,
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
  return NextResponse.json({ data: { ok: true, count: rows.filter((r: any) => r.status && r.status !== "UNMARKED").length } });
}
