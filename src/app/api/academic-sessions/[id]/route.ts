import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";

/**
 * PATCH /api/academic-sessions/[id] — update a session's name and dates.
 *
 * Only the name and dates are editable. The `isCurrent` flag is NOT set here:
 * that goes through POST /[id]/set-current so exactly one session is current at a
 * time. Scoped to the caller's own school.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
  const data: Record<string, any> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "Session name is required." }, { status: 400 });
    data.name = name;
  }
  if (body.startDate !== undefined) {
    const d = body.startDate ? new Date(body.startDate) : null;
    if (d && Number.isNaN(d.getTime())) return NextResponse.json({ error: "Invalid start date." }, { status: 400 });
    data.startDate = d;
  }
  if (body.endDate !== undefined) {
    const d = body.endDate ? new Date(body.endDate) : null;
    if (d && Number.isNaN(d.getTime())) return NextResponse.json({ error: "Invalid end date." }, { status: 400 });
    data.endDate = d;
  }
  if (!Object.keys(data).length) return NextResponse.json({ data: row });

  const updated = await prisma.academicSession.update({ where: { id }, data });
  await audit("ACADEMIC_SESSION_UPDATE", "academicSession", id, data);
  return NextResponse.json({ data: updated });
}
