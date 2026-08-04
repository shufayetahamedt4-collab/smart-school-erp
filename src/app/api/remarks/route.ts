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
    include: { remarks: { where: { date }, take: 1 } },
    orderBy: { roll: "asc" },
  });
  return NextResponse.json({
    data: students.map((s) => ({
      id: s.id,
      name: s.name,
      roll: s.roll,
      photoUrl: s.photoUrl,
      rating: s.remarks[0]?.rating || "UNMARKED",
      note: s.remarks[0]?.note || "",
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
  const teacherId = teacher?.id || session.id;

  await prisma.$transaction(
    rows
      .filter((r: any) => r.studentId && r.rating && r.rating !== "UNMARKED")
      .map((r: any) =>
        prisma.dailyRemark.create({
          data: { schoolId, studentId: r.studentId, teacherId, date: dt, rating: r.rating, note: r.note || null },
        })
      )
  );
  await audit("REMARK_SAVE", "remark", date);
  return NextResponse.json({ data: { ok: true } });
}
