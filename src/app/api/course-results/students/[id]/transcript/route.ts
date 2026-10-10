import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege } from "@/lib/auth";
import { can, canAccessBranch } from "@/lib/permissions";
import { buildStudentTranscript } from "@/lib/college-results-server";

/**
 * College support (Phase 6c) — ONE student's derived transcript, READ.
 *
 *   GET → the whole transcript derived at read time from this tenant's own rows
 *         and this tenant's own COLLEGE scheme (docs/COLLEGE-DECISIONS.md §23
 *         D-6-14): the scheme's name, its scale and the pass mark; per term, the
 *         courses the student has a RESULT for with every attempt and the
 *         effective one marked (Q3); the credit-weighted term GPA and CGPA
 *         (D-6-11); and a no-GPA scheme with the GPA blocks ABSENT rather than
 *         zeroed (D-6-16).
 *
 * **Why this lives under `course-results` and not `/api/students/[id]/transcript`.**
 * §23.7 names the read as `/api/students/[id]/transcript`, but `students` is a
 * FROZEN non-college segment: `scripts/verify-college-routes.mjs` check 3 fails
 * any file under it that calls `requireCollege` or touches a college model, and
 * that guard has no allowlist to weaken. A college read therefore belongs in a
 * college segment, so the doc's own tail is kept and prefixed by the new one —
 * `/api/course-results/students/[id]/transcript`. (The transcript PRINT page is
 * 6d and is not built here; this is the read the page will use.)
 *
 * Guard order in the handler:
 *   1. session                        → 401
 *   2. target tenant schoolId         → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId)       → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "attendanceMarks", …) → 403  (Q5: the grading-scheme module, reused)
 *   5. id present                     → 400
 *   6. load the student, row.schoolId === schoolId → else 404 (a foreign id is
 *      NOT FOUND — never a 403 oracle)
 *   7. canAccessBranch(student.branchId) → 403
 */

/** The tenant this request targets — the SUPER_ADMIN's `?schoolId=`, else the session's own. */
function targetSchoolId(
  session: { role: string; schoolId: string | null },
  req: NextRequest
): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
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
  // 4. permission
  if (!can(session.role, "attendanceMarks", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  // 6. the student must be THIS tenant's — a foreign id is NOT FOUND.
  const student: any = await prisma.student.findUnique({ where: { id } });
  if (!student || student.schoolId !== schoolId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }
  // 7. branch confinement on the student's own branch.
  if (!canAccessBranch(session, student.branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const transcript = await buildStudentTranscript({ schoolId, studentId: id });
  // `buildStudentTranscript` returns null only for a student that is not this
  // tenant's, which the check above already excluded — so this is defensive.
  if (!transcript) return NextResponse.json({ error: "Student not found" }, { status: 404 });
  return NextResponse.json({ data: transcript });
}
