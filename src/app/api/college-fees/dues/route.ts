import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import { queryId } from "@/lib/utils";
import { collegeDues } from "@/lib/college-fees";
import {
  loadCharges,
  loadCollegeFeeConfig,
  requireCollegeFeesRead,
  serveCharge,
  targetSchoolId,
} from "@/lib/college-fees-server";

/**
 * College support (Phase 7c) — DUES, the first-class READ of D-7-14,
 * `GET /api/college-fees/dues`.
 *
 * Dues are `Σ(amount − paidAmount)` over a student's charge rows — always finite,
 * and `UNPAID / PARTIAL / PAID` is DERIVED from those same two fields, never
 * stored next to them. Overdue is a READ here, not a job: v1 adds no scheduler.
 *
 * Two shapes, both scoped:
 *   - `?studentId=` → one student's rows and their summary (a foreign or missing
 *     student is a 404, never a 403 oracle);
 *   - `?programId=&termNumber=` (either optional) → one row per student in the
 *     scope, so a dues screen can list a term without reading every charge.
 *
 * Guard order: session → target tenant → `requireCollege` → the read allow-list →
 * tenant/branch scoping.
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
  // `queryId` answers `undefined` when the parameter is absent, so an ABSENT term
  // is "no filter" — never `Number(undefined)`, which is NaN and would refuse a
  // perfectly valid read.
  const termRaw = queryId(req.nextUrl.searchParams, "termNumber");
  const termNumber = termRaw === undefined || termRaw === null ? null : Number(termRaw);
  if (termNumber !== null && (!Number.isInteger(termNumber) || termNumber < 1)) {
    return NextResponse.json({ error: "termNumber must be a whole number from 1." }, { status: 400 });
  }
  const config = await loadCollegeFeeConfig(schoolId);

  /* --------------------------------------------------------------- one student */
  if (studentId) {
    const student: any = await prisma.student.findUnique({ where: { id: studentId } });
    // A missing or foreign id is the SAME 404 — never a 403 that would confirm
    // another tenant's student exists (the course-results rule).
    if (!student || student.schoolId !== schoolId) {
      return NextResponse.json({ error: "Student not found in this school." }, { status: 404 });
    }
    if (!canAccessBranch(session, student.branchId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const rows = (await loadCharges(schoolId, { studentId, programId, termNumber })).filter(
      (c) => !c.branchId || canAccessBranch(session, c.branchId)
    );
    return NextResponse.json({
      data: {
        student: {
          id: String(student.id),
          name: String(student.name ?? ""),
          admissionNo: student.admissionNo ?? null,
          programId: student.programId ?? null,
          termNumber: student.termNumber ?? null,
          branchId: student.branchId ?? null,
        },
        summary: collegeDues(rows),
        rows: rows
          .map((r) => serveCharge({ ...r, studentName: student.name ?? null, studentAdmissionNo: student.admissionNo ?? null }))
          .sort(
            (a, b) =>
              a.termNumber - b.termNumber ||
              String(a.headId).localeCompare(String(b.headId)) ||
              a.sequence - b.sequence
          ),
        currency: config.currency,
      },
    });
  }

  /* ------------------------------------------------------------ the whole scope */
  const rows = (await loadCharges(schoolId, { programId, termNumber })).filter(
    (c) => !c.branchId || canAccessBranch(session, c.branchId)
  );
  const studentIds = [...new Set(rows.map((r) => String(r.studentId ?? "")).filter(Boolean))];
  const students: any[] = studentIds.length
    ? await prisma.student.findMany({ where: { id: { in: studentIds } } })
    : [];
  const byId = new Map<string, any>(students.map((s) => [String(s.id), s]));

  const perStudent = [...new Set(rows.map((r) => String(r.studentId ?? "")))].map((sid) => {
    const own = rows.filter((r) => String(r.studentId) === sid);
    const summary = collegeDues(own);
    const student = byId.get(sid);
    return {
      studentId: sid,
      name: student?.name ?? null,
      admissionNo: student?.admissionNo ?? null,
      programId: student?.programId ?? own[0]?.programId ?? null,
      termNumber: student?.termNumber ?? own[0]?.termNumber ?? null,
      count: summary.count,
      billed: summary.billed,
      discount: summary.discount,
      paid: summary.paid,
      due: summary.due,
      status: summary.status,
    };
  });
  perStudent.sort(
    (a, b) => String(a.name ?? a.studentId).localeCompare(String(b.name ?? b.studentId)) || String(a.studentId).localeCompare(String(b.studentId))
  );

  return NextResponse.json({
    data: {
      students: perStudent,
      totals: { ...collegeDues(rows), students: perStudent.length },
      currency: config.currency,
    },
  });
}
