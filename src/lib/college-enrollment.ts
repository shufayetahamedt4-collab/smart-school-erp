/**
 * Phase 4a — the college side of a student's enrolment.
 *
 * A student may carry a **program** and a **term** ONLY when the target tenant
 * runs a college (`COLLEGE` or `BOTH`). Those two fields are the enrolment
 * shape Phase 4 needs and Phase 5 (the promotion ladder) builds on; a tenant
 * with no `institutionType` reads as `SCHOOL` and has neither, which is exactly
 * the "missing = the old behaviour" convention (docs/COLLEGE-DECISIONS.md §1,
 * D-3-3).
 *
 * This is the ONE place that decides the college half, so the two `students`
 * routes stay school-shaped and the college rules live here. Guard order,
 * mirroring every college handler:
 *
 *   1. `requireCollege({ schoolId })` on the TARGET tenant  → 403
 *      (a SCHOOL tenant that sends a program or a term is refused, never
 *       silently ignored)
 *   2. the program exists in THIS tenant and is ACTIVE        → 400
 *   3. branch confinement follows the program                 → 403
 *   4. the term is one this program actually has              → 400
 *   5. (Phase 4b) a programme CHANGE or an un-enrol leaves this student's
 *      course registrations behind, so it is refused  → 409 while any row
 *      still holds a place (PENDING/APPROVED). A REJECTED row does not block.
 *
 * Why this lives in `src/lib` and not under a college API segment: the
 * `students` routes are NOT a college segment, so `scripts/verify-college-routes.mjs`
 * rule 3 forbids a literal `requireCollege(` / college-model call inside them.
 * A helper import is not such a call — the rule scans `src/app/api/<non-college>`
 * only, so the guard stays strict and unexempted while the college rules sit in
 * one reviewed module.
 */
import { NextResponse } from "next/server";
import { prisma } from "./db";
import { requireCollege, type SessionUser } from "./auth";
import { canAccessBranch } from "./permissions";
import { isValidTermNumber, termCount } from "./college-terms";
import { isBlockingRegistration } from "./registration-status";
import { collegeGateDecision } from "./institution";

export type CollegeEnrolmentResult =
  | { kind: "gate"; response: NextResponse }
  | { kind: "error"; status: number; message: string }
  | { kind: "ok"; programId: string | null; termNumber: number | null };

/** Trimmed string, or "" for any non-string (mirrors the college routes). */
const read = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/**
 * Resolve and validate a student's program/term for the target tenant.
 *
 * The caller invokes this ONLY when the request actually names a program or a
 * term, so a plain school student create/patch never pays for the college gate
 * and its request/response stay byte-identical.
 */
export async function resolveCollegeEnrolment(input: {
  session: SessionUser;
  schoolId: string;
  /** the student being changed (omitted on create) — needed only for the 4b guard */
  studentId?: string | null;
  /** the student's CURRENT programme, null when none — the 4b guard's baseline */
  currentProgramId?: string | null;
  programId: unknown;
  termNumber: unknown;
}): Promise<CollegeEnrolmentResult> {
  const { session, schoolId } = input;

  // 1. The tenant must run a college — decided on the TARGET tenant, never on a
  //    cookie or a mode. A SCHOOL tenant is refused.
  const gate = await requireCollege({ schoolId });
  if (gate) return { kind: "gate", response: gate };

  const programId = read(input.programId);
  const termSent = input.termNumber !== undefined && input.termNumber !== null;

  // A term with no program has no list to fall into — the same 400 a bad term gets.
  if (!programId) {
    if (termSent) {
      return { kind: "error", status: 400, message: "A program is required when a term is set." };
    }
    // Phase 4b — an un-enrol: refused while a registration still holds a place.
    return (await guardProgramChange(input, null)) ?? { kind: "ok", programId: null, termNumber: null };
  }

  // 2. The program must exist in THIS tenant and be ACTIVE. A missing or foreign
  //    id is the SAME 400 — never a 404 that would confirm another tenant's row.
  const program = await prisma.program.findUnique({ where: { id: programId } });
  if (!program || (program as any).schoolId !== schoolId) {
    return { kind: "error", status: 400, message: "Program not found in this school." };
  }
  if ((program as any).status && (program as any).status !== "ACTIVE") {
    return { kind: "error", status: 400, message: "The program is not active." };
  }
  // 3. Branch confinement follows the program (a branch admin can only enrol into
  //    a program it can touch), exactly like the program and mapping routes.
  if (!canAccessBranch(session, (program as any).branchId)) {
    return { kind: "error", status: 403, message: "Forbidden" };
  }

  // 4. The term, when present, must be a whole number in the program's derived
  //    term list — 0, negatives, fractions and a term past the end are all 400.
  if (termSent) {
    if (
      !isValidTermNumber(
        input.termNumber,
        Number((program as any).durationYears),
        (program as any).termSystem
      )
    ) {
      const count = termCount(Number((program as any).durationYears), (program as any).termSystem);
      return { kind: "error", status: 400, message: `termNumber must be a whole number from 1 to ${count}.` };
    }
    const decided: CollegeEnrolmentResult = { kind: "ok", programId, termNumber: Number(input.termNumber) };
    return (await guardProgramChange(input, programId)) ?? decided;
  }

  return (await guardProgramChange(input, programId)) ?? { kind: "ok", programId, termNumber: null };
}

/**
 * Phase 4b — refuse a programme change (or an un-enrol) that would leave this
 * student's course registrations pointing at a programme they are no longer in.
 *
 * It runs AFTER the program/term are validated, so a bad body is still a 400 and
 * only a well-formed change is refused 409. It fires only when the student HAS a
 * programme and the request moves it (to another programme, or to none); a
 * same-programme patch (e.g. only the term) is untouched. A REJECTED row does not
 * block — only the rows that still hold a place (PENDING/APPROVED).
 */
async function guardProgramChange(
  input: { studentId?: string | null; currentProgramId?: string | null },
  nextProgramId: string | null
): Promise<CollegeEnrolmentResult | null> {
  const current = input.currentProgramId ?? null;
  // Nothing to guard when there was no programme, or the programme is unchanged.
  if (!input.studentId || !current || nextProgramId === current) return null;
  const rows = await prisma.courseRegistration.findMany({ where: { studentId: input.studentId } });
  if (!(rows as any[]).some((r) => isBlockingRegistration(r.status))) return null;
  return {
    kind: "error",
    status: 409,
    message:
      "This student has course registrations. Withdraw them before changing the student's programme.",
  };
}

/**
 * The result of a student-lifecycle college guard: a refusal to return, or null
 * to proceed. Narrow on purpose — these guards never allow, they only refuse.
 */
export type CollegeGuardRefusal = { kind: "error"; status: number; message: string } | null;

/**
 * Phase 4b-2 — refuse deleting a student who still holds a place in a course.
 *
 * A `students` DELETE cascades a pupil's own rows, but a course registration is
 * a claim on a seat that a human must withdraw first; deleting the pupil would
 * orphan a PENDING/APPROVED row mid-flow. So this guard BLOCKS (409) instead of
 * cascading. A REJECTED row holds no place and does not block — and is left
 * behind (D-4b-11: the guard never silently destroys a decided trail).
 *
 * SCHOOL tenants are untouched: the decision comes from the TARGET tenant's
 * `institutionType`, and a tenant that is not a college (absent / `SCHOOL` /
 * unknown) returns null WITHOUT reading the registrations collection — so a
 * school student's DELETE pays no registration read, gets no 403, and returns
 * exactly the response it did before. `requireCollege` is deliberately NOT
 * called here: it answers 403 for a school tenant, and `students` is a
 * BOTH-tenant route, not a college surface.
 */
export async function guardStudentDelete(input: {
  schoolId: string;
  studentId: string;
}): Promise<CollegeGuardRefusal> {
  const school = await prisma.school
    .findUnique({ where: { id: input.schoolId }, select: { institutionType: true } })
    .catch(() => null);
  // Not a college tenant → nothing to guard, and the registrations collection is
  // never touched (a SCHOOL tenant can never hold a registration anyway).
  if (collegeGateDecision((school as any)?.institutionType) !== "ALLOW") return null;
  const rows = await prisma.courseRegistration.findMany({ where: { studentId: input.studentId } });
  if (!(rows as any[]).some((r) => isBlockingRegistration(r.status))) return null;
  return {
    kind: "error",
    status: 409,
    message: "This student has course registrations. Withdraw them before deleting the student.",
  };
}
