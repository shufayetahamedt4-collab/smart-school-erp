import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import { queryId } from "@/lib/utils";
import { collegeDues } from "@/lib/college-fees";
import { loadCharges, requireCollegeFeesRead, serveCharge, targetSchoolId } from "@/lib/college-fees-server";

/**
 * College support (Phase 7c) — the college CHARGE rows (collection `collegeFee`),
 * route `/api/college-fees/charges` (read-only; charges are DERIVED, never typed —
 * see `/api/college-fees/generate`).
 *
 * A charge carries its own `title`, `amount` and `paidAmount` (D-7-9/D-7-11), so
 * editing a structure row never rewrites money a family already owes. Every money
 * field leaves as a finite number, and `status` is DERIVED from `amount` and
 * `paidAmount` (D-7-14) — never stored independently of them.
 *
 * Guard order: session → target tenant → `requireCollege` → the read allow-list →
 * tenant/branch scoping. Optional filters are applied ON TOP of the scope, so a
 * foreign id can only ever narrow the answer to zero.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  const denied = requireCollegeFeesRead(session);
  if (denied) return denied;

  const studentId = queryId(req.nextUrl.searchParams, "studentId");
  const programId = queryId(req.nextUrl.searchParams, "programId");
  // An ABSENT term is "no filter" (`queryId` answers `undefined`, and
  // `Number(undefined)` would be NaN and refuse a valid read).
  const termRaw = queryId(req.nextUrl.searchParams, "termNumber");
  const termNumber = termRaw === undefined || termRaw === null ? null : Number(termRaw);
  if (termNumber !== null && (!Number.isInteger(termNumber) || termNumber < 1)) {
    return NextResponse.json({ error: "termNumber must be a whole number from 1." }, { status: 400 });
  }
  const status = queryId(req.nextUrl.searchParams, "status");

  const scoped = (await loadCharges(schoolId, { studentId, programId, termNumber })).filter(
    (c) => !c.branchId || canAccessBranch(session, c.branchId)
  );
  const rows = status ? scoped.filter((c) => (c.status || "UNPAID") === status) : scoped;

  // Names, in one bulk read (the store cannot join).
  const studentIds = [...new Set(rows.map((r) => String(r.studentId ?? "")).filter(Boolean))];
  const students: any[] = studentIds.length
    ? await prisma.student.findMany({ where: { id: { in: studentIds } } })
    : [];
  const byId = new Map<string, any>(students.map((s) => [String(s.id), s]));

  const data = rows
    .map((row) =>
      serveCharge({
        ...row,
        studentName: byId.get(String(row.studentId))?.name ?? null,
        studentAdmissionNo: byId.get(String(row.studentId))?.admissionNo ?? null,
      })
    )
    .sort(
      (a, b) =>
        String(a.studentName ?? a.studentId).localeCompare(String(b.studentName ?? b.studentId)) ||
        a.termNumber - b.termNumber ||
        String(a.headId).localeCompare(String(b.headId)) ||
        a.sequence - b.sequence
    );

  // The totals come from 7a's ONE dues arithmetic, over exactly the rows served —
  // so the list and the summary can never disagree.
  return NextResponse.json({ data, totals: collegeDues(rows) });
}
