import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { isValidTermNumber, normalizeTermSystem, termCount, termLabel } from "@/lib/college-terms";

/**
 * College support (Phase 3c) — the program→course MAPPING (collection
 * `programCourses`, route `/api/programs/[id]/courses`).
 *
 * A mapping says "this course sits in term N of this program, as REQUIRED or
 * ELECTIVE". It is the program's term list, which is why the course is reached
 * through it rather than hanging off the program directly.
 *
 * It lives under the `programs` segment on purpose: `programs` is already a
 * listed college segment (`src/lib/college-routes.ts`), so the offline route
 * guard gates these handlers automatically, with no new segment to remember.
 *
 * Guard order in EVERY handler:
 *   1. session                    → 401
 *   2. target tenant schoolId     → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId)   → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "programs", …)   → 403
 *   5. program id present         → 400
 *   6. writeGuard(schoolId)       → 402   (mutations only)
 *   7. load the program by id AND require program.schoolId === schoolId → else 404
 *      (a foreign id must behave as NOT FOUND, never as a 403 oracle)
 *   8. canAccessBranch(program.branchId) → 403   (branch access follows the PROGRAM)
 *
 * POST/PATCH are not in this file; a mapping is created and removed, never
 * edited — changing a course or a term is a remove + add, which keeps the
 * `(programId, courseId, termNumber)` uniqueness rule simple.
 */

/** How a mapped course counts towards its program. */
const REQUIREMENTS = ["REQUIRED", "ELECTIVE"] as const;

/** The tenant this request targets — the SUPER_ADMIN's `?schoolId=`, else the session's own. */
function targetSchoolId(
  session: { role: string; schoolId: string | null },
  req: NextRequest
): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

function readString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission — reading the term list needs only the view action.
  if (!can(session.role, "programs", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // 6. load the program and confine it to the target tenant — a foreign id is NOT FOUND.
  const program = await prisma.program.findUnique({ where: { id } });
  if (!program || (program as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  // 7. branch confinement follows the program.
  if (!canAccessBranch(session, (program as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The mapping rows carry only ids and term data; the course's code/title/credits
  // are read in ONE extra query and joined in memory (the store cannot join).
  const mappings = await prisma.programCourse.findMany({ where: { programId: id } });
  const courseIds = [...new Set((mappings as any[]).map((m) => m.courseId))].filter(Boolean);
  const courses = courseIds.length
    ? await prisma.course.findMany({ where: { id: { in: courseIds } } })
    : [];
  const courseById = new Map<string, any>((courses as any[]).map((c) => [c.id, c]));

  const termSystem = normalizeTermSystem((program as any).termSystem);
  const count = termCount(Number((program as any).durationYears), (program as any).termSystem);

  const data = (mappings as any[])
    .map((m) => {
      const course = courseById.get(m.courseId) || null;
      return {
        id: m.id,
        programId: m.programId,
        courseId: m.courseId,
        termNumber: Number(m.termNumber),
        termLabel: termLabel(Number(m.termNumber), termSystem),
        requirement: m.requirement === "ELECTIVE" ? "ELECTIVE" : "REQUIRED",
        // A course deleted out from under a mapping cannot happen (its DELETE is
        // blocked while mapped); these stay null only if a row was written
        // outside the API, so the list never breaks on one bad row.
        courseCode: course?.code ?? null,
        courseTitle: course?.title ?? null,
        creditHours: course?.creditHours ?? null,
        type: course?.type ?? null,
      };
    })
    .sort((a, b) => a.termNumber - b.termNumber || String(a.courseCode).localeCompare(String(b.courseCode)));

  return NextResponse.json({ data, termSystem, termCount: count });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission — mapping edits need full on programs (same as the program itself).
  if (!can(session.role, "programs", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. load the program and confine it to the target tenant — a foreign id is NOT FOUND.
  const program = await prisma.program.findUnique({ where: { id } });
  if (!program || (program as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  // 8. branch confinement follows the program — a branch admin cannot map into a
  //    program that sits in another branch.
  if (!canAccessBranch(session, (program as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const courseId = readString(body?.courseId);
  if (!courseId) return NextResponse.json({ error: "A course is required." }, { status: 400 });

  // The course must exist IN THIS SCHOOL. A missing or foreign id is the SAME 400
  // — never a 404 that would confirm another tenant's course exists.
  const course = await prisma.course.findUnique({ where: { id: courseId } });
  if (!course || (course as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found in this school." }, { status: 400 });
  }
  if ((course as any).status && (course as any).status !== "ACTIVE") {
    return NextResponse.json({ error: "The course is not active." }, { status: 400 });
  }
  // A branch admin may only map a course from a branch they can touch (the same
  // rule programs POST applies to its department).
  if (!canAccessBranch(session, (course as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The term must be one this program actually has: a whole number in
  // [1, durationYears × termsPerYear(termSystem)]. 0, negatives, fractions and a
  // term past the end are all the same 400.
  const termSystem = normalizeTermSystem((program as any).termSystem);
  const count = termCount(Number((program as any).durationYears), (program as any).termSystem);
  if (!isValidTermNumber(body?.termNumber, Number((program as any).durationYears), (program as any).termSystem)) {
    return NextResponse.json(
      { error: `termNumber must be a whole number from 1 to ${count}.` },
      { status: 400 }
    );
  }
  const termNumber = Number(body.termNumber);

  const requirement = body?.requirement === undefined ? "REQUIRED" : readString(body.requirement);
  if (!REQUIREMENTS.includes(requirement as (typeof REQUIREMENTS)[number])) {
    return NextResponse.json(
      { error: `requirement must be one of: ${REQUIREMENTS.join(", ")}.` },
      { status: 400 }
    );
  }

  // A course may sit in a given term of a program only once.
  const clash = await prisma.programCourse.findFirst({
    where: { programId: id, courseId, termNumber },
  });
  if (clash) {
    return NextResponse.json(
      { error: "This course is already mapped to that term of this program." },
      { status: 409 }
    );
  }

  const mapping = await prisma.programCourse.create({
    data: { schoolId, programId: id, courseId, termNumber, requirement },
  });
  await audit("PROGRAM_COURSE_ADD", "programCourse", mapping.id, {
    schoolId,
    programId: id,
    courseId,
    termNumber,
    requirement,
  });
  invalidateReferenceCache(schoolId);
  return NextResponse.json(
    { data: { ...mapping, termLabel: termLabel(termNumber, termSystem) } },
    { status: 201 }
  );
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission
  if (!can(session.role, "programs", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. load the program and confine it to the target tenant — a foreign id is NOT FOUND.
  const program = await prisma.program.findUnique({ where: { id } });
  if (!program || (program as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  // 8. branch confinement follows the program.
  if (!canAccessBranch(session, (program as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // The mapping is addressed as a query parameter under the program, so a foreign
  // mapping id, or one that belongs to a DIFFERENT program, is NOT FOUND.
  const mappingId = req.nextUrl.searchParams.get("mappingId") || "";
  if (!mappingId) return NextResponse.json({ error: "Missing mappingId" }, { status: 400 });
  const mapping = await prisma.programCourse.findUnique({ where: { id: mappingId } });
  if (
    !mapping ||
    (mapping as any).schoolId !== schoolId ||
    (mapping as any).programId !== id
  ) {
    return NextResponse.json({ error: "Mapping not found" }, { status: 404 });
  }

  await prisma.programCourse.delete({ where: { id: mappingId } });
  await audit("PROGRAM_COURSE_REMOVE", "programCourse", mappingId, {
    schoolId,
    programId: id,
    courseId: (mapping as any).courseId,
    termNumber: (mapping as any).termNumber,
  });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: { ok: true } });
}
