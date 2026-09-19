import { NextRequest, NextResponse } from "next/server";
import { prisma, schoolReference } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";

/** Exams are near-static between mark entries; 30s cache with tag invalidation. */
const EXAMS_CACHE_TTL_MS = 30_000;
const examsCache = new Map<string, { at: number; data: any }>();

function examsCacheGet(key: string) {
  const hit = examsCache.get(key);
  if (hit && Date.now() - hit.at < EXAMS_CACHE_TTL_MS) return hit.data;
  return null;
}
function examsCachePut(key: string, data: any) {
  examsCache.set(key, { at: Date.now(), data });
  if (examsCache.size > 100) {
    const cutoff = Date.now() - EXAMS_CACHE_TTL_MS;
    for (const [k, v] of examsCache) if (v.at < cutoff) examsCache.delete(k);
  }
}

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
    .map((e: any, i: number) => ({
      ...e,
      classRoom: e.classId ? classById.get(e.classId) || null : null,
      section: e.sectionId ? sectionById.get(e.sectionId) || null : null,
      _count: { marks: markCounts[i] },
    }))
    .sort((a: any, b: any) => {
      // orderBy [{ year: "desc" }, { startDate: "desc" }]
      const y = (b.year ?? 0) - (a.year ?? 0);
      if (y !== 0) return y;
      const bs = b.startDate ? new Date(b.startDate).getTime() : 0;
      const as = a.startDate ? new Date(a.startDate).getTime() : 0;
      return bs - as;
    });
  examsCachePut(cacheKey, data);
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
  return NextResponse.json({ data: exam }, { status: 201 });
}
