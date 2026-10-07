import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, scopeWhere } from "@/lib/permissions";
import { resolveBranchId } from "@/lib/branches";
import { writeGuard } from "@/lib/subscription";

/**
 * College support (Phase 2) — departments (collection `departments`).
 *
 * A department is tenant-owned (schoolId), may be tied to one branch
 * (branchId) and may name a staff head (`headStaffId` → a user of the SAME
 * school). `(schoolId, code)` is unique, enforced in-code with `findFirst`
 * (the Firestore store has no DB unique index) — the same rule as a branch.
 *
 * Guard order in EVERY handler:
 *   1. session                 → 401
 *   2. target tenant schoolId  → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId) → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "departments", …) → 403
 *   5. writeGuard(schoolId)     → 402   (mutations only)
 *
 * The Edge middleware (`src/middleware.ts`) gates by host and role only and
 * cannot see `institutionType`, so step 3 is the sole thing that keeps a school
 * tenant out of this route.
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

export async function GET(req: NextRequest) {
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST — the target tenant, before can() and every read.
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission
  if (!can(session.role, "departments", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Branch scoping (PRD §12.3): a branch admin sees only their own branch's rows.
  const scoped = session.role === "SUPER_ADMIN" ? { schoolId } : scopeWhere(session);
  const [departments, programs, users] = await Promise.all([
    prisma.department.findMany({ where: scoped }),
    prisma.program.findMany({ where: { schoolId }, select: { id: true, departmentId: true } }),
    prisma.user.findMany({ where: { schoolId }, select: { id: true, name: true } }),
  ]);

  const programCount = new Map<string, number>();
  for (const p of programs as any[]) {
    programCount.set(p.departmentId, (programCount.get(p.departmentId) || 0) + 1);
  }
  const userName = new Map<string, string>((users as any[]).map((u) => [u.id, u.name]));

  const data = (departments as any[])
    .map((d) => ({
      ...d,
      headName: d.headStaffId ? userName.get(d.headStaffId) || null : null,
      _count: { programs: programCount.get(d.id) || 0 },
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
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
  // 5. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const name = readString(body?.name);
  const code = readString(body?.code);
  if (!name) return NextResponse.json({ error: "Department name is required." }, { status: 400 });
  if (!code) return NextResponse.json({ error: "Department code is required." }, { status: 400 });

  // (schoolId, code) uniqueness — enforced in-code, per tenant.
  const exists = await prisma.department.findFirst({ where: { schoolId, code } });
  if (exists) {
    return NextResponse.json({ error: "A department with this code already exists." }, { status: 409 });
  }

  // A head, when named, must be a user of THIS school.
  const headStaffId = readString(body?.headStaffId) || null;
  if (headStaffId) {
    const head = await prisma.user.findUnique({ where: { id: headStaffId } });
    if (!head || (head as any).schoolId !== schoolId) {
      return NextResponse.json({ error: "Head staff must belong to this school." }, { status: 400 });
    }
  }

  // A branch admin is confined to their own branch; a school admin picks one or
  // defaults to the first branch (`resolveBranchId`).
  const branchId = await resolveBranchId(session, readString(body?.branchId) || null);
  const status = body?.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";

  const department = await prisma.department.create({
    data: {
      schoolId,
      name,
      code,
      branchId,
      headStaffId,
      description: readString(body?.description) || null,
      status,
    },
  });
  await audit("DEPARTMENT_CREATE", "department", department.id, { schoolId, name, code, branchId });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: department }, { status: 201 });
}
