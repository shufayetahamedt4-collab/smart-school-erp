import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { invalidateStats } from "@/lib/stats-cache";

/** PRD §5.3 — Alumni tracking: archive (never delete) + listing + re-archive. */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "studentTeacherInfo", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const q = req.nextUrl.searchParams.get("q") || "";
  // `?status=TRANSFERRED` lists the off-roll (transferred/withdrawn) students;
  // the default stays the alumni archive, so existing callers are unchanged.
  const status = req.nextUrl.searchParams.get("status") === "TRANSFERRED" ? "TRANSFERRED" : "ALUMNI";
  const alumni = await prisma.student.findMany({
    where: {
      schoolId,
      status,
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: "insensitive" } },
              { admissionNo: { contains: q, mode: "insensitive" } },
            ],
          }
        : {}),
    },
    include: { classRoom: { select: { name: true } } },
    orderBy: { updatedAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ data: alumni });
}

/** Move an active student to alumni (e.g., TC taken) — archive, not delete. */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "studentTeacherInfo", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const studentId = String(body?.studentId || "");
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student || student.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }
  const updated = await prisma.student.update({
    where: { id: studentId },
    data: { status: body?.restore ? "ACTIVE" : "ALUMNI" },
  });
  await audit(body?.restore ? "STUDENT_RESTORE" : "STUDENT_ARCHIVE", "student", studentId);
  invalidateStats(student.schoolId, "students");
  return NextResponse.json({ data: updated });
}
