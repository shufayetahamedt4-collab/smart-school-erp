import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";

/**
 * College support (Phase 2) — update/delete one program.
 *
 * Guard order in EVERY handler:
 *   1. session                 → 401
 *   2. target tenant schoolId  → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId) → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "programs", "full") → 403
 *   5. id present              → 400
 *   6. writeGuard(schoolId)     → 402
 *   7. load row by id AND require row.schoolId === schoolId → else 404
 *   8. canAccessBranch(row.branchId) → 403
 */

const DEGREE_LEVELS = ["HSC", "DEGREE_PASS", "HONOURS", "MASTERS", "DIPLOMA"] as const;

function targetSchoolId(
  session: { role: string; schoolId: string | null },
  req: NextRequest
): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

function readString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function parseDuration(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  if (!can(session.role, "programs", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // Load by id, confined to the target tenant — a foreign id is NOT FOUND.
  const program = await prisma.program.findUnique({ where: { id } });
  if (!program || (program as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  if (!canAccessBranch(session, (program as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const data: Record<string, any> = {};

  if (body?.name !== undefined) {
    const name = readString(body.name);
    if (!name) return NextResponse.json({ error: "Program name cannot be empty." }, { status: 400 });
    data.name = name;
  }
  if (body?.code !== undefined) {
    const code = readString(body.code);
    if (!code) return NextResponse.json({ error: "Program code cannot be empty." }, { status: 400 });
    const clash = await prisma.program.findFirst({ where: { schoolId, code } });
    if (clash && clash.id !== id) {
      return NextResponse.json({ error: "A program with this code already exists." }, { status: 409 });
    }
    data.code = code;
  }
  if (body?.degreeLevel !== undefined) {
    const level = readString(body.degreeLevel);
    if (!DEGREE_LEVELS.includes(level as (typeof DEGREE_LEVELS)[number])) {
      return NextResponse.json(
        { error: `degreeLevel must be one of: ${DEGREE_LEVELS.join(", ")}.` },
        { status: 400 }
      );
    }
    data.degreeLevel = level;
  }
  if (body?.durationYears !== undefined) {
    const durationYears = parseDuration(body.durationYears);
    if (durationYears === null) {
      return NextResponse.json({ error: "durationYears must be a whole number from 1 to 6." }, { status: 400 });
    }
    data.durationYears = durationYears;
  }
  if (body?.status !== undefined) data.status = body.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";

  // Re-validate the department when it changes, and re-inherit its branch.
  if (body?.departmentId !== undefined) {
    const departmentId = readString(body.departmentId);
    if (!departmentId) {
      return NextResponse.json({ error: "A department is required." }, { status: 400 });
    }
    const department = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!department || (department as any).schoolId !== schoolId) {
      return NextResponse.json({ error: "Department not found in this school." }, { status: 400 });
    }
    if ((department as any).status && (department as any).status !== "ACTIVE") {
      return NextResponse.json({ error: "The department is not active." }, { status: 400 });
    }
    if (!canAccessBranch(session, (department as any).branchId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    data.departmentId = departmentId;
    data.branchId = (department as any).branchId || null;
  }
  // An explicit branch override (validated) wins over the inherited branch.
  if (body?.branchId !== undefined) {
    const branchId = readString(body.branchId) || null;
    if (!canAccessBranch(session, branchId)) {
      return NextResponse.json({ error: "You do not have access to this branch." }, { status: 403 });
    }
    data.branchId = branchId;
  }

  const updated = await prisma.program.update({ where: { id }, data });
  await audit("PROGRAM_UPDATE", "program", id, { schoolId, data });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: updated });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  if (!can(session.role, "programs", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const program = await prisma.program.findUnique({ where: { id } });
  if (!program || (program as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  if (!canAccessBranch(session, (program as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Hard delete for Phase 2. LATER PHASE: before deleting, block here when the
  // program has enrolled students or courses (e.g. count students with this
  // programId / course-registrations referencing it and return 400), the same
  // way a department is blocked while it still has programs.
  await prisma.program.delete({ where: { id } });
  await audit("PROGRAM_DELETE", "program", id, { schoolId });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: { ok: true } });
}
