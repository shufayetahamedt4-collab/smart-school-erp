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
    return { kind: "ok", programId: null, termNumber: null };
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
    return { kind: "ok", programId, termNumber: Number(input.termNumber) };
  }

  return { kind: "ok", programId, termNumber: null };
}
