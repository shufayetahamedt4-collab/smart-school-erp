import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";

/**
 * College support (Phase 3b) — update/delete one course.
 *
 * Guard order in EVERY handler:
 *   1. session                 → 401
 *   2. target tenant schoolId  → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId) → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "courses", "full") → 403
 *   5. id present              → 400
 *   6. writeGuard(schoolId)     → 402
 *   7. load row by id AND require row.schoolId === schoolId → else 404
 *      (a foreign/another-tenant id must behave as NOT FOUND, never as a 403
 *       oracle that confirms the row exists)
 *   8. canAccessBranch(row.branchId) → 403
 */

const COURSE_TYPES = ["THEORY", "PRACTICAL"] as const;
const MAX_CREDIT_HOURS = 30;

/** See `parseCreditHours` in ./route.ts — the same three-way result, kept local. */
const CREDIT_INVALID = Symbol("invalid-credits");
function parseCreditHours(v: unknown): number | null | undefined | typeof CREDIT_INVALID {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return CREDIT_INVALID;
  if (n <= 0) return CREDIT_INVALID;
  if (n > MAX_CREDIT_HOURS) return CREDIT_INVALID;
  if (Math.round(n * 100) / 100 !== n) return CREDIT_INVALID;
  return n;
}

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
  if (!can(session.role, "courses", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. load by id and confine to the target tenant — a foreign id is NOT FOUND.
  const course = await prisma.course.findUnique({ where: { id } });
  if (!course || (course as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, (course as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const data: Record<string, any> = {};

  if (body?.code !== undefined) {
    const code = readString(body.code);
    if (!code) return NextResponse.json({ error: "Course code cannot be empty." }, { status: 400 });
    const clash = await prisma.course.findFirst({ where: { schoolId, code } });
    if (clash && clash.id !== id) {
      return NextResponse.json({ error: "A course with this code already exists." }, { status: 409 });
    }
    data.code = code;
  }
  if (body?.title !== undefined) {
    const title = readString(body.title);
    if (!title) return NextResponse.json({ error: "Course title cannot be empty." }, { status: 400 });
    data.title = title;
  }
  if (body?.type !== undefined) {
    const type = readString(body.type);
    if (!COURSE_TYPES.includes(type as (typeof COURSE_TYPES)[number])) {
      return NextResponse.json(
        { error: `type must be one of: ${COURSE_TYPES.join(", ")}.` },
        { status: 400 }
      );
    }
    data.type = type;
  }
  if (body?.creditHours !== undefined) {
    const creditHours = parseCreditHours(body.creditHours);
    if (creditHours === CREDIT_INVALID) {
      return NextResponse.json(
        { error: `creditHours must be a positive number of at most ${MAX_CREDIT_HOURS} (or null).` },
        { status: 400 }
      );
    }
    data.creditHours = creditHours === undefined ? null : creditHours;
  }
  if (body?.status !== undefined) data.status = body.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";

  // Re-validate the department when it changes, and re-derive the branch from it
  // (the same rule a program follows): a course never keeps the old department's
  // branch after being moved.
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

  const updated = await prisma.course.update({ where: { id }, data });
  await audit("COURSE_UPDATE", "course", id, { schoolId, data });
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
  if (!can(session.role, "courses", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. id
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  // 6. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // 7. load by id and confine to the target tenant — a foreign id is NOT FOUND.
  const course = await prisma.course.findUnique({ where: { id } });
  if (!course || (course as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Course not found" }, { status: 404 });
  }
  // 8. branch confinement
  if (!canAccessBranch(session, (course as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Hard delete for Phase 3b. LATER PHASE (3c): before deleting, block here when
  // the course is mapped to a program — count `programCourse` rows with this
  // `courseId` and return 400, the same way a department is blocked while it
  // still has programs. Until that collection has rows, the delete is unguarded.
  await prisma.course.delete({ where: { id } });
  await audit("COURSE_DELETE", "course", id, { schoolId });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: { ok: true } });
}
