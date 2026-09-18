import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { prisma } from "@/lib/db";
import { can } from "@/lib/permissions";
import { ledgerForSchool, ledgerForStudent } from "@/lib/ledger";

/** PRD §10.1 — central ledger queries (student-wise & school-wise). */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ data: [] });

  const sp = req.nextUrl.searchParams;

  // Guardians/students see their own ledger only (§2.1: View).
  if (session.role === "GUARDIAN" || session.role === "STUDENT") {
    const studentId =
      session.studentId ||
      (session.role === "GUARDIAN" ? (await prisma.student.findFirst({ where: { guardianUserId: session.id } }))?.id : undefined);
    if (!studentId) return NextResponse.json({ data: [] });
    const entries = await ledgerForStudent(schoolId, studentId);
    return NextResponse.json({ data: entries });
  }

  if (!can(session.role, "feePayment", "full") && session.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const entries = await ledgerForSchool(schoolId, {
    kind: sp.get("kind") || undefined,
    status: sp.get("status") || undefined,
    take: Number(sp.get("take") || 200),
  });
  return NextResponse.json({ data: entries });
}
