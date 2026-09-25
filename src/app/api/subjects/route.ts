import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "BRANCH_ADMIN", "TEACHER", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const [subjects, assignments, homeworks] = await Promise.all([
    prisma.subject.findMany({ where: { schoolId } }),
    prisma.classAssignment.findMany({ where: { schoolId }, select: { subjectId: true } }),
    prisma.homework.findMany({ where: { schoolId }, select: { subjectId: true } }),
  ]);
  const assignmentCounts = new Map<string, number>();
  const homeworkCounts = new Map<string, number>();
  for (const assignment of assignments) {
    assignmentCounts.set(assignment.subjectId, (assignmentCounts.get(assignment.subjectId) || 0) + 1);
  }
  for (const homework of homeworks) {
    homeworkCounts.set(homework.subjectId, (homeworkCounts.get(homework.subjectId) || 0) + 1);
  }
  const result = subjects
    .map((subject: any) => ({
      ...subject,
      _count: {
        assignments: assignmentCounts.get(subject.id) || 0,
        homeworks: homeworkCounts.get(subject.id) || 0,
      },
    }))
    .sort((a: any, b: any) => String(a.name).localeCompare(String(b.name)));
  return NextResponse.json({ data: result });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  if (!name) return NextResponse.json({ error: "Subject name is required." }, { status: 400 });

  const exists = await prisma.subject.findFirst({ where: { schoolId, name } });
  if (exists) return NextResponse.json({ error: "Subject already exists." }, { status: 400 });

  const subject = await prisma.subject.create({ data: { schoolId, name, code: body.code || null } });
  await audit("SUBJECT_CREATE", "subject", subject.id, { name });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: subject }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await prisma.$transaction([
    prisma.classAssignment.deleteMany({ where: { subjectId: id } }),
    prisma.routine.deleteMany({ where: { subjectId: id } }),
    prisma.homework.deleteMany({ where: { subjectId: id } }),
    prisma.subject.delete({ where: { id } }),
  ]);
  await audit("SUBJECT_DELETE", "subject", id);
  return NextResponse.json({ data: { ok: true } });
}
