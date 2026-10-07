import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";

/**
 * College support (Phase 2) — update/delete one department.
 *
 * Guard order in EVERY handler:
 *   1. session                 → 401
 *   2. target tenant schoolId  → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId) → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "departments", "full") → 403
 *   5. id present              → 400
 *   6. writeGuard(schoolId)     → 402
 *   7. load row by id AND require row.schoolId === schoolId → else 404
 *      (a foreign/another-tenant id must behave as NOT FOUND, never as a 403
 *       oracle that confirms the row exists)
 *   8. canAccessBranch(row.branchId) → 403
 *
 * `headStaffId`, when set, must reference a user of the SAME school.
 */

/** The tenant this request targets — the SUPER_ADMIN's `?schoolId=`, else the session's own. */
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

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission
  if (!can(session.role, "departments", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. load by id and confine to the target tenant — a foreign id is NOT FOUND.
  const department = await prisma.department.findUnique({ where: { id } });
  if (!department || (department as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Department not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, (department as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const data: Record<string, any> = {};
  if (body?.name !== undefined) {
    const name = readString(body.name);
    if (!name) return NextResponse.json({ error: "Department name cannot be empty." }, { status: 400 });
    data.name = name;
  }
  if (body?.code !== undefined) {
    const code = readString(body.code);
    if (!code) return NextResponse.json({ error: "Department code cannot be empty." }, { status: 400 });
    const clash = await prisma.department.findFirst({ where: { schoolId, code } });
    if (clash && clash.id !== id) {
      return NextResponse.json({ error: "A department with this code already exists." }, { status: 409 });
    }
    data.code = code;
  }
  if (body?.description !== undefined) data.description = readString(body.description) || null;
  if (body?.status !== undefined) data.status = body.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";
  if (body?.headStaffId !== undefined) {
    const headStaffId = readString(body.headStaffId) || null;
    if (headStaffId) {
      const head = await prisma.user.findUnique({ where: { id: headStaffId } });
      if (!head || (head as any).schoolId !== schoolId) {
        return NextResponse.json({ error: "Head staff must belong to this school." }, { status: 400 });
      }
    }
    data.headStaffId = headStaffId;
  }
  if (body?.branchId !== undefined) {
    const branchId = readString(body.branchId) || null;
    if (!canAccessBranch(session, branchId)) {
      return NextResponse.json({ error: "You do not have access to this branch." }, { status: 403 });
    }
    data.branchId = branchId;
  }

  const updated = await prisma.department.update({ where: { id }, data });
  await audit("DEPARTMENT_UPDATE", "department", id, { schoolId, data });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: updated });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission
  if (!can(session.role, "departments", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. load by id and confine to the target tenant — a foreign id is NOT FOUND.
  const department = await prisma.department.findUnique({ where: { id } });
  if (!department || (department as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Department not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, (department as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Hard delete, blocked while any program still hangs off this department.
  const programCount = await prisma.program.count({ where: { departmentId: id } });
  if (programCount > 0) {
    return NextResponse.json(
      { error: "Cannot delete a department that has programs." },
      { status: 400 }
    );
  }
  await prisma.department.delete({ where: { id } });
  await audit("DEPARTMENT_DELETE", "department", id, { schoolId });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: { ok: true } });
}
