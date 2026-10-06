import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { currentSessionKey } from "@/lib/academic";

/**
 * POST /api/academic-sessions/[id]/set-current — make one session the current one.
 *
 * Two things move together, so both the pointer and the flag agree: the
 * `settings` pointer (`school.<id>.current_session`, the source of truth read by
 * student creation/promotion) and the `isCurrent` flag on the session rows (at
 * most one true). Scoped to the caller's own school.
 */
export async function POST(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "systemSettings", "full")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;
  const row = await prisma.academicSession.findUnique({ where: { id } }).catch(() => null);
  if (!row) return NextResponse.json({ error: "Session not found" }, { status: 404 });
  if (session.role !== "SUPER_ADMIN" && row.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const locked = await writeGuard(row.schoolId);
  if (locked) return locked;

  const others = await prisma.academicSession.findMany({ where: { schoolId: row.schoolId } });
  for (const s of others) {
    if (s.id === id || !s.isCurrent) continue;
    await prisma.academicSession.update({ where: { id: s.id }, data: { isCurrent: false } });
  }
  if (!row.isCurrent) await prisma.academicSession.update({ where: { id }, data: { isCurrent: true } });
  await prisma.setting.upsert({
    where: { key: currentSessionKey(row.schoolId) },
    update: { value: id },
    create: { key: currentSessionKey(row.schoolId), value: id },
  });

  await audit("ACADEMIC_SESSION_CURRENT", "academicSession", id, { name: row.name });
  return NextResponse.json({ data: { id, current: true } });
}
