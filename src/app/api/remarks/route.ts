import { NextRequest, NextResponse } from "next/server";
import { prisma, remarkId } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { queryId } from "@/lib/utils";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;
  const classId = sp.get("classId") || "";
  // Belt and braces: a client that stringifies an absent filter must not turn
  // "All sections" into a hunt for a section literally named "undefined".
  const sectionId = queryId(sp, "sectionId");
  const dateStr = sp.get("date") || "";
  if (!classId || !dateStr) return NextResponse.json({ error: "classId and date are required." }, { status: 400 });
  const date = new Date(`${dateStr}T00:00:00`);

  // The day's remarks are read as their own set and matched by studentId here,
  // instead of `include: { remarks: { where: { date }, take: 1 } }`. That
  // `take: 1` had no `orderBy`: it answered with whichever copy the store
  // listed first, so once a pupil had more than one row for the day (which the
  // old write path made easy — see POST) a teacher could correct a rating,
  // re-open the sheet, and be shown the OLD value.
  const [students, remarks] = await Promise.all([
    prisma.student.findMany({ where: { schoolId, classId, sectionId, active: true }, orderBy: { roll: "asc" } }),
    prisma.dailyRemark.findMany({ where: { schoolId, date } }),
  ]);

  const remarkByStudent = new Map<string, any>();
  for (const r of remarks) {
    if (!r.studentId) continue;
    const isCanonical = r.id === remarkId(String(r.studentId), date);
    const prev = remarkByStudent.get(r.studentId);
    // The canonical (student, day) row always wins. Among rows left over from
    // before it existed, the last one written is the better guess — it is more
    // likely a correction than the original mark.
    if (!prev || isCanonical) remarkByStudent.set(r.studentId, r);
  }

  return NextResponse.json({
    data: students.map((s) => {
      const mark = remarkByStudent.get(s.id);
      return {
        id: s.id,
        name: s.name,
        roll: s.roll,
        photoUrl: s.photoUrl,
        rating: mark?.rating || "UNMARKED",
        note: mark?.note || "",
      };
    }),
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
  if (Number.isNaN(dt.getTime())) return NextResponse.json({ error: "Invalid date." }, { status: 400 });
  const teacher = session.role === "TEACHER" ? await prisma.teacher.findUnique({ where: { userId: session.id } }) : null;
  const teacherId = teacher?.id || session.id;

  // A row's studentId arrives from the client, so it is checked against this
  // school's roster first: an unvalidated id let a saved sheet attach a remark
  // to another school's pupil (the row would carry this school's id).
  const roster = new Set(
    (await prisma.student.findMany({ where: { schoolId }, select: { id: true } })).map((s: any) => s.id)
  );
  const marks = rows.filter(
    (r: any) => r?.studentId && roster.has(String(r.studentId)) && r.rating && r.rating !== "UNMARKED"
  );
  const markedIds = new Set(marks.map((r: any) => String(r.studentId)));

  // Rows already on file for this day, so duplicates written before the
  // deterministic id existed are swept as their pupil is re-saved.
  const existing = await prisma.dailyRemark.findMany({ where: { schoolId, date: dt } });
  const staleIds = existing
    .filter((r: any) => markedIds.has(r.studentId) && r.id !== remarkId(r.studentId, dt))
    .map((r: any) => r.id);

  const writes = [
    ...staleIds.map((id: string) => prisma.dailyRemark.delete({ where: { id } })),
    ...marks.map((r: any) =>
      // upsert, not create: the day's remark for this pupil is REPLACED. A
      // `create()` here appended a new row on every save, so a teacher who
      // fixed one rating left two rows behind and the sheet showed either one.
      prisma.dailyRemark.upsert({
        where: { id: remarkId(String(r.studentId), dt) },
        create: { schoolId, studentId: r.studentId, teacherId, date: dt, rating: r.rating, note: r.note || null },
        update: { teacherId, rating: r.rating, note: r.note || null },
      })
    ),
  ];
  // A sheet saved with nothing marked (and nothing to sweep) writes nothing at
  // all, rather than committing an empty write batch.
  if (writes.length) await prisma.$transaction(writes);
  await audit("REMARK_SAVE", "remark", date, { marked: marks.length, replaced: staleIds.length });
  return NextResponse.json({ data: { ok: true, saved: marks.length, replaced: staleIds.length } });
}
