import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

/**
 * End a live class session.
 *
 * The teacher who owns the session ends it normally; a school or branch admin
 * may end anyone's (a relief teacher who forgot, a class that was cut short) —
 * the monitor board needs a way to correct a stuck row without asking the
 * teacher to log in. Ending is terminal: a closed session is never reopened, so
 * the durations in the history stay honest.
 */
const MANAGEMENT = ["SCHOOL_ADMIN", "BRANCH_ADMIN", "SUPER_ADMIN"];
const pad = (n: number) => String(n).padStart(2, "0");

export async function PATCH(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !session.schoolId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const allowed = session.role === "TEACHER" || MANAGEMENT.includes(session.role);
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const row: any = await prisma.classSession.findUnique({ where: { id } });
  if (!row || row.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }
  if (row.status === "DECLINED") {
    return NextResponse.json({ error: "This period was marked as not taken, so there is nothing to end." }, { status: 409 });
  }
  if (row.status !== "OPEN") {
    return NextResponse.json({ error: "That class has already ended." }, { status: 409 });
  }
  // A teacher ends only their own class; an admin may end any.
  if (session.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.id } });
    if (!teacher || row.teacherId !== teacher.id) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
  }

  const endedAt = new Date();
  const durationMin = Math.max(0, Math.round((endedAt.getTime() - new Date(row.startedAt).getTime()) / 60000));
  const updated = await prisma.classSession.update({
    where: { id },
    data: { status: "CLOSED", endedAt, endedBy: session.role, autoEnded: false },
  });
  await audit("CLASS_END", "classSession", id, {
    durationMin,
    endedByRole: session.role,
    classId: row.classId,
    teacherId: row.teacherId,
  });
  const d = new Date(endedAt);
  return NextResponse.json({
    data: {
      ...updated,
      endedClock: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
      durationMin,
    },
  });
}
