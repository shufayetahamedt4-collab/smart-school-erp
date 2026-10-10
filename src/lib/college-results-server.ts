import { NextResponse } from "next/server";
import { prisma } from "./db";
import { resolveSchemeFor } from "./grading-store";
import { COLLEGE_RESULTS_READ_REFUSAL, canReadCollegeResults } from "./college-results-access";
import { bandForPercent, round2, showsGpa, type GradeBand, type GradingScheme } from "./grading";
import {
  creditWeightedGpa,
  gpaWeightingBasis,
  normalizeCollegeRetake,
  resolveCollegeAttempts,
  type CollegeCourseResolution,
  type CollegeRetakeConfig,
  type GpaWeightingBasis,
  type ResolvedCollegeAttempt,
} from "./college-results";
import { normalizeTermSystem, termLabel } from "./college-terms";
import type { Mode } from "./institution";

/**
 * College results — the SERVER half of Phase 6c (docs/COLLEGE-DECISIONS.md §23).
 *
 * The pure arithmetic is `src/lib/college-results.ts` (6a) and the storage is
 * `courseResults` in `src/lib/db.ts` (6b). This module is the ONE place that joins
 * them: it resolves the tenant's COLLEGE scheme, turns stored `(obtained,
 * fullMarks)` into a letter/point (D-6-12 — derived ON READ, never frozen), and
 * folds a student's attempts into the per-term GPA and cumulative CGPA a
 * transcript prints (D-6-11, D-6-14).
 *
 * It lives here, not in the route, for one reason: the results route and the
 * transcript read must agree to the byte on which attempt is effective and what
 * the CGPA is. Two copies of that arithmetic is exactly the disagreement the
 * repo's other college modules (`college-terms.ts`, `college-promotion.ts`) exist
 * to prevent.
 *
 * **The caller must already have passed the college gate.** Every entry point here
 * takes an explicit `schoolId` and reads only that tenant's rows and only that
 * tenant's settings (D-6-13), but the GATE itself is the route's job:
 * `requireCollege({ schoolId })` is called first in every handler, and
 * `scripts/verify-college-routes.mjs` check 2 fails the build if it is not. This
 * module is only ever imported from inside a listed college segment.
 *
 * Why the mode is the constant below rather than `resolveActiveMode`: grading is
 * NOT UI context. A `BOTH` tenant that happens to be browsing in SCHOOL mode must
 * still have its college results graded by the college scheme (D-6-1/D-6-13), so
 * the mode is pinned here and never read from a cookie.
 */

/** Grading always uses the COLLEGE-scoped scheme (D-6-1) — never the UI mode. */
export const COLLEGE_GRADE_MODE: Mode = "COLLEGE";

/* ------------------------------------------------------ read access (6d-fix) */

/**
 * The ONE read gate every college results READ handler applies (6d-fix).
 *
 * v1 lets only the admin-level roles and the REGISTRAR read results or a
 * transcript (owner ruling, §23.6); TEACHER, GUARDIAN and STUDENT are denied.
 * The RULE itself lives in `./college-results-access` — this is that rule wrapped
 * as the 403 every route returns, so the four read handlers cannot drift apart
 * and no handler re-states the role list.
 *
 * Returns `null` when the caller may read (the same shape as `requireCollege()`
 * and `writeGuard()`), else the 403 to return:
 *
 *   const denied = requireCollegeResultsRead(session);
 *   if (denied) return denied;
 *
 * It is deliberately a READ gate only: writes keep `can(role,
 * "attendanceMarks", "full")`, and the COLLEGE tenant gate stays the FIRST check
 * in every handler.
 */
export function requireCollegeResultsRead(session: { role?: string | null } | null | undefined): NextResponse | null {
  if (canReadCollegeResults(session?.role)) return null;
  return NextResponse.json({ error: COLLEGE_RESULTS_READ_REFUSAL }, { status: 403 });
}

/* ------------------------------------------------------------------- helpers */

/** A finite number, or null. `""` and whitespace are not zero — they are absent. */
export function finiteNumber(value: unknown): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/** A whole number in [min, max], or null. */
export function wholeNumberIn(value: unknown, min: number, max: number): number | null {
  const n = finiteNumber(value);
  return n !== null && Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** A trimmed non-empty string, else "". */
export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/* --------------------------------------------------------- the scheme (D-6-18) */

/**
 * The tenant's college scheme — through the ONE resolver (D-6-18), pinned to the
 * COLLEGE mode. `programId` is passed so the later per-programme override
 * (D-6-19) lands inside `resolveSchemeFor` with no change here.
 */
export async function loadCollegeScheme(schoolId: string, programId?: string | null): Promise<GradingScheme> {
  return resolveSchemeFor({ schoolId, mode: COLLEGE_GRADE_MODE, programId: programId ?? null });
}

/** The scheme fields a reader is entitled to see, so the scale is never a guess (D-6-6). */
export interface CollegeSchemeView {
  name: string;
  gpaScale: number;
  passPercent: number;
  showGpa: boolean;
  /** Which scheme graded this read — always the college one (D-6-1). */
  source: "college";
}

export function schemeView(scheme: GradingScheme): CollegeSchemeView {
  return {
    name: scheme.name,
    gpaScale: scheme.gpaScale,
    passPercent: scheme.passPercent,
    showGpa: showsGpa(scheme),
    source: "college",
  };
}

/** The tenant's retake rule, read from the scheme document (D-6-7). */
export function retakeOf(scheme: GradingScheme): CollegeRetakeConfig {
  return normalizeCollegeRetake(scheme.retake);
}

/* ------------------------------------------------- derived grade (D-6-12/D-6-16) */

/** One stored attempt's derived grade — computed at read time, never stored. */
export interface DerivedGrade {
  /** The percentage, two decimals. */
  percent: number;
  /** The admin's own band label (D-6-14 — "A*" prints as "A*"). */
  grade: string;
  /** The band's point, or `null` when the scheme shows no GPA (D-6-16). */
  points: number | null;
  passed: boolean;
  /** The band that matched — so a caller can print its remark without re-deriving. */
  band: GradeBand;
}

/**
 * Grade one stored attempt under the tenant's own scheme.
 *
 * Returns `null` when the marks are unusable (a non-finite mark, or `fullMarks`
 * of 0), so a caller reports "no grade" rather than a fabricated one — the same
 * rule `resolveCollegeAttempts` applies when it drops a junk attempt.
 *
 * A no-GPA scheme yields `points: null` (`showGpa: false`), never `0.00`, so a
 * printed 0.00 always means a real zero (D-6-16).
 */
export function deriveGrade(scheme: GradingScheme, obtained: unknown, fullMarks: unknown): DerivedGrade | null {
  const o = finiteNumber(obtained);
  const f = finiteNumber(fullMarks);
  if (o === null || f === null || f <= 0) return null;
  const percent = round2((o / f) * 100);
  const band = bandForPercent(scheme, percent);
  return {
    percent,
    grade: band.grade,
    points: showsGpa(scheme) && typeof band.gpa === "number" ? band.gpa : null,
    passed: percent >= scheme.passPercent,
    band,
  };
}

/**
 * One result row as the API serves it: the stored fields plus the grade derived
 * from the tenant's CURRENT scheme, so editing a band re-grades every row with no
 * re-entry (D-6-12) — the same promise `verify-grading.mjs` pins for school marks.
 */
export interface ServedResultRow {
  id: string;
  schoolId: string;
  branchId: string | null;
  studentId: string;
  courseId: string;
  programId: string | null;
  termNumber: number | null;
  attempt: number | null;
  obtained: number | null;
  fullMarks: number | null;
  createdAt?: unknown;
  recordedById?: string | null;
  // ---- derived on read ----
  percent: number | null;
  grade: string | null;
  points: number | null;
  passed: boolean | null;
  gradeRemark: string | null;
  // ---- joined (the store cannot join) ----
  courseCode: string | null;
  courseTitle: string | null;
  creditHours: number | null;
  courseAvailable: boolean;
  studentName: string | null;
  studentAdmissionNo: string | null;
  programName: string | null;
}

/** Serve one stored row: the grade is derived here, the joins are looked up by the caller. */
export function serveResultRow(
  scheme: GradingScheme,
  row: any,
  joins: {
    course?: any;
    student?: any;
    program?: any;
  } = {}
): ServedResultRow {
  const derived = deriveGrade(scheme, row?.obtained, row?.fullMarks);
  const { course, student, program } = joins;
  return {
    id: String(row?.id ?? ""),
    schoolId: String(row?.schoolId ?? ""),
    branchId: row?.branchId ?? null,
    studentId: String(row?.studentId ?? ""),
    courseId: String(row?.courseId ?? ""),
    programId: row?.programId ?? null,
    termNumber: wholeNumberIn(row?.termNumber, 1, 1000),
    attempt: wholeNumberIn(row?.attempt, 1, 1000),
    obtained: finiteNumber(row?.obtained),
    fullMarks: finiteNumber(row?.fullMarks),
    createdAt: row?.createdAt,
    recordedById: row?.recordedById ?? null,
    percent: derived?.percent ?? null,
    grade: derived?.grade ?? null,
    points: derived?.points ?? null,
    passed: derived?.passed ?? null,
    gradeRemark: derived?.band?.remark || null,
    courseCode: course?.code ?? null,
    courseTitle: course?.title ?? null,
    creditHours: finiteNumber(course?.creditHours),
    courseAvailable: !!course,
    studentName: student?.name ?? null,
    studentAdmissionNo: student?.admissionNo ?? null,
    programName: program?.name ?? null,
  };
}

/* --------------------------------------------------- the transcript (D-6-14) */

/** One course in a transcript term — its attempts, and the effective grade. */
export interface TranscriptCourse {
  courseId: string;
  courseCode: string | null;
  courseTitle: string | null;
  creditHours: number | null;
  /** The course row still exists (a deleted course is reported, not hidden). */
  available: boolean;
  /** Every attempt, in attempt order, with the effective one marked (Q3). */
  attempts: ResolvedCollegeAttempt[];
  /** The policy's chosen attempt, or `null` for `AVERAGE`. */
  effectiveAttempt: number | null;
  /** The grade the CGPA and the print use — the resolved percentage. */
  percent: number | null;
  grade: string | null;
  points: number | null;
  passed: boolean | null;
  /** The stored attempts exceed what the tenant's policy allows (D-6-9). */
  overLimit: boolean;
  retakesUsed: number;
  maxRetakes: number | null;
  resolution: CollegeCourseResolution;
}

/** One term of a transcript. */
export interface TranscriptTerm {
  termNumber: number;
  label: string;
  /** Credit-weighted GPA over this term's effective points, or `null` (D-6-16). */
  gpa: number | null;
  courses: TranscriptCourse[];
}

/** The whole derived transcript for one student, one programme (D-6-14). */
export interface StudentTranscript {
  student: {
    id: string;
    name: string;
    admissionNo: string | null;
    programId: string | null;
    programName: string | null;
    degreeLevel: string | null;
    branchId: string | null;
  };
  /** The scheme in force, named — what keeps a derived print honest (D-6-6/D-6-14). */
  scheme: CollegeSchemeView;
  retake: CollegeRetakeConfig;
  /** How the GPA was weighted, so a reader can tell (Q2/D-6-11). */
  weightingBasis: GpaWeightingBasis;
  terms: TranscriptTerm[];
  /** Credit-weighted, cumulative (D-6-11) — `null` under a no-GPA scheme. */
  cgpa: number | null;
  totals: {
    courses: number;
    attempts: number;
    passed: number;
    failed: number;
  };
  /** The print date, so a reader can see which policy produced the page (D-6-12). */
  generatedAt: string;
}

/**
 * Build one student's transcript from the tenant's own rows and settings.
 *
 * Returns `null` when the student is not this tenant's — the caller answers 404,
 * never a 403 that would confirm another tenant's student exists (the same rule
 * the course-registrations route applies to a foreign id).
 *
 * Every filter is an equality on THIS tenant (`schoolId`, and the student is
 * checked against it), so a foreign row or a foreign scheme is simply not in the
 * set (D-6-13). Terms with no result are omitted rather than printed as zeroes
 * (D-6-15), and a no-GPA scheme returns `cgpa: null` and per-term `gpa: null`
 * instead of a faked `0.00` (D-6-16).
 */
export async function buildStudentTranscript({
  schoolId,
  studentId,
}: {
  schoolId: string;
  studentId: string;
}): Promise<StudentTranscript | null> {
  if (!schoolId || !studentId) return null;

  const student: any = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student || student.schoolId !== schoolId) return null;

  const programId: string | null = student.programId ?? null;
  const program: any = programId ? await prisma.program.findUnique({ where: { id: programId } }) : null;
  // A programme id that points at another tenant is treated as no programme: the
  // student is still readable, but nothing is derived from a foreign row.
  const ownProgram = program && program.schoolId === schoolId ? program : null;
  const system = normalizeTermSystem(ownProgram?.termSystem);

  const scheme = await loadCollegeScheme(schoolId, programId);
  const retake = retakeOf(scheme);

  // This tenant's rows for this student, and nothing else.
  const rows: any[] = await prisma.courseResult.findMany({ where: { schoolId, studentId } });

  const courseIds = [...new Set(rows.map((r) => r.courseId).filter((id): id is string => typeof id === "string" && !!id))];
  const courses: any[] = courseIds.length ? await prisma.course.findMany({ where: { id: { in: courseIds } } }) : [];
  const courseById = new Map<string, any>(courses.map((c) => [String(c.id), c]));

  // Group by term, then by course. Only well-formed terms are grouped; a junk
  // termNumber is not a term and must not invent one.
  const byTerm = new Map<number, Map<string, any[]>>();
  for (const row of rows) {
    const term = wholeNumberIn(row.termNumber, 1, 1000);
    const courseId = readString(row.courseId);
    if (term === null || !courseId) continue;
    const perCourse = byTerm.get(term) ?? new Map<string, any[]>();
    perCourse.set(courseId, [...(perCourse.get(courseId) ?? []), row]);
    byTerm.set(term, perCourse);
  }

  const terms: TranscriptTerm[] = [];
  const allCourseRows: { termNumber: number; credits: unknown; points: unknown }[] = [];
  let attemptsTotal = 0;
  let passedTotal = 0;
  let failedTotal = 0;
  let coursesTotal = 0;

  for (const termNumber of [...byTerm.keys()].sort((a, b) => a - b)) {
    const perCourse = byTerm.get(termNumber)!;
    const termCourses: TranscriptCourse[] = [];
    const termRows: { termNumber: number; credits: unknown; points: unknown }[] = [];

    for (const courseId of [...perCourse.keys()].sort()) {
      const stored = perCourse.get(courseId)!;
      const course = courseById.get(courseId) ?? null;
      const credits = course?.creditHours ?? null;

      const resolution = resolveCollegeAttempts({
        attempts: stored.map((r) => ({ attempt: r.attempt, obtained: r.obtained, fullMarks: r.fullMarks })),
        passPercent: scheme.passPercent,
        retake: scheme.retake,
      });

      // The effective grade is the RESOLVED percentage banded under the current
      // scheme — so REPLACE/BEST/BOTH/AVERAGE all flow through one derivation.
      const derived =
        resolution.effectivePercent === null
          ? null
          : deriveGrade(scheme, resolution.effectivePercent, 100);

      const row = { termNumber, credits, points: derived?.points ?? null };
      termRows.push(row);
      allCourseRows.push(row);

      attemptsTotal += resolution.count;
      coursesTotal += 1;
      if (derived) {
        if (derived.passed) passedTotal += 1;
        else failedTotal += 1;
      }

      termCourses.push({
        courseId,
        courseCode: course?.code ?? null,
        courseTitle: course?.title ?? null,
        creditHours: finiteNumber(credits),
        available: !!course,
        attempts: resolution.attempts,
        effectiveAttempt: resolution.effectiveAttempt,
        percent: resolution.effectivePercent,
        grade: derived?.grade ?? null,
        points: derived?.points ?? null,
        passed: resolution.effectivePassed,
        overLimit: resolution.overLimit,
        retakesUsed: resolution.retakesUsed,
        maxRetakes: resolution.maxRetakes,
        resolution,
      });
    }

    terms.push({
      termNumber,
      label: termLabel(termNumber, system),
      gpa: creditWeightedGpa(scheme, termRows),
      courses: termCourses,
    });
  }

  return {
    student: {
      id: String(student.id),
      name: String(student.name ?? ""),
      admissionNo: student.admissionNo ?? null,
      programId,
      programName: ownProgram?.name ?? null,
      degreeLevel: ownProgram?.degreeLevel ?? null,
      branchId: student.branchId ?? null,
    },
    scheme: schemeView(scheme),
    retake,
    weightingBasis: gpaWeightingBasis(scheme, allCourseRows),
    terms,
    cgpa: creditWeightedGpa(scheme, allCourseRows),
    totals: { courses: coursesTotal, attempts: attemptsTotal, passed: passedTotal, failed: failedTotal },
    generatedAt: new Date().toISOString(),
  };
}
