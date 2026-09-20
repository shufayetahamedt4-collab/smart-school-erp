import { NextRequest, NextResponse } from "next/server";
import { prisma, schoolReference } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";
import { examsCacheGet, examsCachePut, invalidateExamsCache } from "@/lib/exams-cache";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const classId = req.nextUrl.searchParams.get("classId") || undefined;
  const cacheKey = `${schoolId}|${classId || ""}`;
  const cached = examsCacheGet(cacheKey);
  if (cached) return NextResponse.json({ data: cached });

  // Bulk-parallel: exams + reference maps in one wave, mark counts as a
  // parallel wave of native counts (was a per-exam traversal each).
  const [exams, classRows, sectionRows] = await Promise.all([
    prisma.exam.findMany({ where: { schoolId, ...(classId ? { classId } : {}) } }),
    schoolReference("classRoom", schoolId),
    schoolReference("section", schoolId),
  ]);
  const classById = new Map(classRows.map((c) => [c.id, c]));
  const sectionById = new Map(sectionRows.map((s) => [s.id, s]));
  const markCounts = await Promise.all(exams.map((e: any) => prisma.examMark.count({ where: { examId: e.id } })));
  const data = exams
    .map((e: any, i: number) => {
      // Select-parity with the pre-sweep include: {id, name} only.
      const c: any = e.classId ? classById.get(e.classId) : null;
      const s: any = e.sectionId ? sectionById.get(e.sectionId) : null;
      return {
        ...e,
        classRoom: c ? { id: c.id, name: c.name } : null,
        section: s ? { id: s.id, name: s.name } : null,
        _count: { marks: markCounts[i] },
      };
    })
    .sort((a: any, b: any) => {
      // orderBy [{ year: "desc" }, { startDate: "desc" }]
      const y = (b.year ?? 0) - (a.year ?? 0);
      if (y !== 0) return y;
      const bs = b.startDate ? new Date(b.startDate).getTime() : 0;
      const as = a.startDate ? new Date(a.startDate).getTime() : 0;
      return bs - as;
    });
  examsCachePut(cacheKey, data, schoolId);
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const { name, classId, sectionId, year, startDate, endDate } = body || {};
  if (!name || !classId) return NextResponse.json({ error: "Exam name and class are required." }, { status: 400 });

  const exam = await prisma.exam.create({
    data: {
      schoolId,
      name: String(name),
      classId,
      sectionId: sectionId || null,
      year: Number(year || new Date().getFullYear()),
      startDate: startDate ? new Date(startDate) : null,
      endDate: endDate ? new Date(endDate) : null,
    },
  });
  await audit("EXAM_CREATE", "exam", exam.id, { name });
  invalidateStats(schoolId, "exams");
  invalidateExamsCache(schoolId);
  return NextResponse.json({ data: exam }, { status: 201 });
}
