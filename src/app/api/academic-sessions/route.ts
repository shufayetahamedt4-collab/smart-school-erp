import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { currentSessionKey, getCurrentSessionId } from "@/lib/academic";

/**
 * Academic sessions (Phase 1 foundation).
 *
 * GET  /api/academic-sessions      → every session of the school, current first
 * POST /api/academic-sessions      → create a session
 *
 * Managing sessions is a system-settings action (SCHOOL_ADMIN; SUPER_ADMIN passes
 * everything). Every read/write is scoped to the session's own school, so no
 * client-supplied schoolId is trusted except for a SUPER_ADMIN's explicit drill-in.
 */

function schoolIdOf(session: { role: string; schoolId: string | null }, req: NextRequest): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || session.schoolId;
  return session.schoolId;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = schoolIdOf(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const [sessions, currentId] = await Promise.all([
    prisma.academicSession.findMany({ where: { schoolId }, orderBy: { startDate: "desc" } }),
    getCurrentSessionId(schoolId),
  ]);
  const data = sessions.map((s: any) => ({ ...s, isCurrent: s.id === currentId }));
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "systemSettings", "full")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const body = await req.json().catch(() => null);
  const schoolId = session.role === "SUPER_ADMIN" ? body?.schoolId || session.schoolId : session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const name = String(body?.name || "").trim();
  if (!name) return NextResponse.json({ error: "Session name is required." }, { status: 400 });
  const startDate = body?.startDate ? new Date(body.startDate) : null;
  const endDate = body?.endDate ? new Date(body.endDate) : null;
  if (startDate && Number.isNaN(startDate.getTime())) return NextResponse.json({ error: "Invalid start date." }, { status: 400 });
  if (endDate && Number.isNaN(endDate.getTime())) return NextResponse.json({ error: "Invalid end date." }, { status: 400 });

  const isCurrent = body?.isCurrent === true;
  const created = await prisma.academicSession.create({
    data: { schoolId, name, startDate, endDate, isCurrent },
  });
  if (isCurrent) {
    await prisma.setting.upsert({
      where: { key: currentSessionKey(schoolId) },
      update: { value: created.id },
      create: { key: currentSessionKey(schoolId), value: created.id },
    });
  }
  await audit("ACADEMIC_SESSION_CREATE", "academicSession", created.id, { name });
  return NextResponse.json({ data: { ...created, isCurrent } }, { status: 201 });
}
