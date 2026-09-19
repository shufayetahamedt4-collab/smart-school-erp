import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

/**
 * PRD §7.2 — homework submission (student self-service + guardian-assisted).
 * Accepts a fileUrl (uploaded via /api/uploads) with the submission status.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["TEACHER", "GUARDIAN", "SCHOOL_ADMIN", "STUDENT"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const body = await req.json().catch(() => null);

  const homework = await prisma.homework.findUnique({ where: { id } });
  if (!homework || homework.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  let studentId = body?.studentId;
  if (session.role === "GUARDIAN") {
    studentId = session.studentId || (await prisma.student.findFirst({ where: { guardianUserId: session.id } }))?.id;
  } else if (session.role === "STUDENT") {
    // Students submit for themselves only (§7.2).
    studentId = (await prisma.student.findFirst({ where: { userId: session.id } }))?.id;
  }
  if (!studentId) return NextResponse.json({ error: "Missing studentId" }, { status: 400 });

  const status = body?.status === "SUBMITTED" ? "SUBMITTED" : "PENDING";
  const fileUrl = body?.fileUrl ? String(body.fileUrl) : null;
  const submission = await prisma.homeworkSubmission.upsert({
    where: { homeworkId_studentId: { homeworkId: id, studentId } },
    update: {
      status,
      submittedAt: status === "SUBMITTED" ? new Date() : null,
      ...(fileUrl ? { fileUrl } : {}),
    },
    create: {
      schoolId: homework.schoolId,
      homeworkId: id,
      studentId,
      status,
      submittedAt: status === "SUBMITTED" ? new Date() : null,
      fileUrl,
    },
  });
  await audit("HOMEWORK_SUBMIT", "homework", id, { status, by: session.role });
  return NextResponse.json({ data: submission });
}
