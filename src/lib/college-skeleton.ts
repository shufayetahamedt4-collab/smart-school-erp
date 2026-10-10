/**
 * The college half of the onboarding wizard, in ONE reviewed module.
 *
 * The wizard (`src/app/api/onboarding/route.ts`) is a **platform** route, not a
 * college API segment, so it may not name a college model: `scripts/verify-college-routes.mjs`
 * check 3 forbids a literal college-model call (`prisma.department|program|programCourse|course`)
 * in any non-college `src/app/api` directory, and that check is deliberately
 * **strict and unexempted**. This module is where those calls live instead — the
 * same arrangement `docs/COLLEGE-DECISIONS.md` already records for the `students`
 * routes (D-4a-2, D-4b-8, D-4b-11): the route imports a helper and never spells
 * the college access itself, so the guard keeps its full strength.
 *
 * Both the READ and the WRITE gate on the TARGET tenant's own `institutionType`
 * — `hasCollege(...)`, which is the very decision `requireCollege()` makes
 * (`collegeGateDecision` in `src/lib/institution.ts`), applied here as a yes/no
 * rather than a 403. That is what keeps a SCHOOL tenant's wizard byte-identical:
 * it still receives `{ departments: 0, programs: 0, courses: 0 }` and reads **no**
 * college collection at all. Every query is `schoolId`-scoped, so a foreign id
 * can only ever narrow the result to zero.
 *
 * Nothing here is tenant-mode authorization: `requireCollege()` / `can()` remain
 * the only enforcement, and `institutionType` is read from the tenant document,
 * never from a cookie or a query parameter.
 */
import { prisma } from "./db";
import { type InstitutionType, hasCollege, normalizeInstitutionType } from "./institution";
import type { SeedCollege } from "./onboarding-seed";

/** The wizard's onboarding-progress counters for the college half. */
export interface CollegeProgressCounts {
  departments: number;
  programs: number;
  courses: number;
}

/** How many college rows the wizard actually created (idempotent: existing ones count 0). */
export interface CollegeSkeletonSeedCounts {
  departmentsCreated: number;
  programsCreated: number;
  coursesCreated: number;
  mappingsCreated: number;
}

const ZERO_COUNTS: CollegeProgressCounts = { departments: 0, programs: 0, courses: 0 };
const ZERO_CREATED: CollegeSkeletonSeedCounts = {
  departmentsCreated: 0,
  programsCreated: 0,
  coursesCreated: 0,
  mappingsCreated: 0,
};

/**
 * The college-half progress counts for the wizard's GET.
 *
 * A tenant with no college half (SCHOOL, or an absent/unknown `institutionType`,
 * which reads as SCHOOL) gets zeros and **no query at all** — the same shape the
 * route produced before this helper existed, so a school tenant's response is
 * byte-identical and pays no extra reads.
 */
export async function collegeProgressCounts(
  schoolId: string | null | undefined,
  institutionType: InstitutionType | null | undefined
): Promise<CollegeProgressCounts> {
  if (!schoolId || !hasCollege(normalizeInstitutionType(institutionType))) return ZERO_COUNTS;
  const [departments, programs, courses] = await Promise.all([
    prisma.department.count({ where: { schoolId } }),
    prisma.program.count({ where: { schoolId } }),
    prisma.course.count({ where: { schoolId } }),
  ]);
  return { departments, programs, courses };
}

/**
 * Create the wizard's default college catalogue — department → programme →
 * courses → programme-course mappings — for a tenant whose own type runs a
 * college. Idempotent: an existing row (matched by `code`) is reused, never
 * duplicated, so re-running the wizard creates nothing.
 *
 * A tenant with no college half is passed no rows: the gate re-checks
 * `institutionType` here (defence in depth, D-4b-11's rule) and returns zeros, so
 * a SCHOOL tenant can never receive college rows even if a caller asks.
 *
 * `branchId` is deliberately null: the wizard's "Main Campus" branch is created
 * after this call, and a branch-less catalogue is the shape the college pages
 * and the isolation fixtures already cover.
 */
export async function seedCollegeSkeleton(
  schoolId: string,
  institutionType: InstitutionType | null | undefined,
  spec: SeedCollege | null | undefined
): Promise<CollegeSkeletonSeedCounts> {
  if (!schoolId || !spec || !hasCollege(normalizeInstitutionType(institutionType))) return ZERO_CREATED;

  const counts: CollegeSkeletonSeedCounts = { ...ZERO_CREATED };

  let department: any = await prisma.department.findFirst({
    where: { schoolId, code: spec.department.code },
  });
  if (!department) {
    department = await prisma.department.create({
      data: {
        schoolId,
        name: spec.department.name,
        code: spec.department.code,
        branchId: null,
        headStaffId: null,
        description: null,
        status: "ACTIVE",
      },
    });
    counts.departmentsCreated++;
  }

  let program: any = await prisma.program.findFirst({
    where: { schoolId, code: spec.program.code },
  });
  if (!program) {
    program = await prisma.program.create({
      data: {
        schoolId,
        departmentId: department.id,
        name: spec.program.name,
        code: spec.program.code,
        degreeLevel: spec.program.degreeLevel,
        durationYears: spec.program.durationYears,
        branchId: null,
        status: "ACTIVE",
        termSystem: spec.program.termSystem,
      },
    });
    counts.programsCreated++;
  }

  for (const c of spec.courses) {
    let course: any = await prisma.course.findFirst({ where: { schoolId, code: c.code } });
    if (!course) {
      course = await prisma.course.create({
        data: {
          schoolId,
          departmentId: department.id,
          branchId: null,
          code: c.code,
          title: c.title,
          creditHours: c.creditHours,
          type: c.type,
          status: "ACTIVE",
        },
      });
      counts.coursesCreated++;
    }
    const already = await prisma.programCourse.findFirst({
      where: {
        programId: program.id,
        courseId: course.id,
        termNumber: spec.mapCoursesToTerm,
      },
    });
    if (!already) {
      await prisma.programCourse.create({
        data: {
          schoolId,
          programId: program.id,
          courseId: course.id,
          termNumber: spec.mapCoursesToTerm,
          requirement: "REQUIRED",
        },
      });
      counts.mappingsCreated++;
    }
  }

  return counts;
}
