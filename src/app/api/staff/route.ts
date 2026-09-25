import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can, MANAGEMENT_ROLES, STAFF_ROLES, isBranchScoped } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import type { Role } from "@/lib/db";

/**
 * PRD §2 note + §12.3 — staff & role assignment under a school admin.
 *
 * The main School Admin creates back-office accounts (Registrar, Accountant,
 * Librarian, Front Desk, Branch Admin), gives each an optional branch scope,
 * resets passwords and freezes accounts. A BRANCH_ADMIN can only manage the
 * staff of their own branch — never school-wide staff and never other branches.
 */

function schoolIdOf(session: { role: string; schoolId: string | null }, req: NextRequest): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "staff", "full") && !can(session.role, "staff", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = schoolIdOf(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const where: Record<string, any> = { schoolId, role: { in: STAFF_ROLES } };
  if (isBranchScoped(session)) where.branchId = session.branchId;

  const staff = await prisma.user.findMany({
    where,
    include: { branch: { select: { id: true, name: true, code: true } } },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ data: staff });
}

async function resolveTargetUser(session: any, id: string, schoolId: string) {
  const target = await prisma.user.findUnique({ where: { id } });
  if (!target) return { error: NextResponse.json({ error: "Staff account not found." }, { status: 404 }), target: null };
  if (target.schoolId !== schoolId) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }), target: null };
  }
  if (!STAFF_ROLES.includes(target.role as Role)) {
    return { error: NextResponse.json({ error: "This account is not managed from Staff & Roles." }, { status: 403 }), target: null };
  }
  if (target.role === "SCHOOL_ADMIN") {
    // The onboarding main-admin account is protected from this endpoint.
    return { error: NextResponse.json({ error: "The main school admin account is managed separately." }, { status: 403 }), target: null };
  }
  if (isBranchScoped(session) && target.branchId !== session.branchId) {
    return { error: NextResponse.json({ error: "Forbidden" }, { status: 403 }), target: null };
  }
  return { error: null, target };
}
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "staff", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = schoolIdOf(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  const role = String(body?.role || "") as Role;
  const scope = body?.scope === "BRANCH" ? "BRANCH" : "SCHOOL";
  const branchId = body?.branchId ? String(body.branchId) : null;

  if (!name || !email || !password) {
    return NextResponse.json({ error: "Name, email and password are required." }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
  }
  if (!MANAGEMENT_ROLES.includes(role)) {
    return NextResponse.json({ error: "Role must be one of the management roles." }, { status: 400 });
  }

  // A branch admin may only add staff to their own branch.
  if (isBranchScoped(session)) {
    if (scope !== "BRANCH" || branchId !== session.branchId) {
      return NextResponse.json({ error: "Branch admins can only create staff for their own branch." }, { status: 403 });
    }
  }
  if (role === "BRANCH_ADMIN" && isBranchScoped(session)) {
    return NextResponse.json({ error: "Only the main school admin can create a branch admin." }, { status: 403 });
  }

  if (scope === "BRANCH") {
    if (!branchId) return NextResponse.json({ error: "Choose the branch for this staff member." }, { status: 400 });
    const branch = await prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch || branch.schoolId !== schoolId) {
      return NextResponse.json({ error: "Branch not found." }, { status: 404 });
    }
    if (branch.enabled === false) {
      return NextResponse.json({ error: "This branch's ERP access is turned off. Enable it first." }, { status: 400 });
    }
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "A user with that email already exists." }, { status: 400 });
  }

  const user = await prisma.user.create({
    data: {
      name,
      email,
      role,
      schoolId,
      scope,
      branchId: scope === "BRANCH" ? branchId : null,
      passwordHash: bcrypt.hashSync(password, 10),
    },
  });
  await audit("STAFF_CREATE", "user", user.id, { name, email, role, scope, branchId });
  return NextResponse.json({ data: user }, { status: 201 });
}
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "staff", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = schoolIdOf(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const { error, target } = await resolveTargetUser(session, id, schoolId);
  if (error) return error;
  if (!target) return NextResponse.json({ error: "Staff member not found" }, { status: 404 });

  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);

  const data: Record<string, any> = {};
  if (body?.name !== undefined) data.name = String(body.name).trim() || target.name;

  let scope: "SCHOOL" | "BRANCH" | null = null;
  if (body?.scope !== undefined) scope = body.scope === "BRANCH" ? "BRANCH" : "SCHOOL";
  let branchId: string | null | undefined = undefined;
  if (body?.branchId !== undefined) branchId = body.branchId ? String(body.branchId) : null;

  if (body?.role !== undefined) {
    const role = String(body.role) as Role;
    if (!MANAGEMENT_ROLES.includes(role)) {
      return NextResponse.json({ error: "Role must be one of the management roles." }, { status: 400 });
    }
    if (isBranchScoped(session) && role === "BRANCH_ADMIN") {
      return NextResponse.json({ error: "Only the main school admin can assign a branch admin." }, { status: 403 });
    }
    data.role = role;
  }

  // Branch scoping rules for the (maybe changed) scope/branch.
  const finalScope = scope ?? (body?.scope === undefined ? (target.scope === "BRANCH" ? "BRANCH" : "SCHOOL") : null);
  const finalBranchId = branchId !== undefined ? branchId : target.branchId || null;
  if (scope !== null) data.scope = scope;
  if (branchId !== undefined) data.branchId = scope === "SCHOOL" ? null : branchId;

  if (isBranchScoped(session)) {
    // A branch admin cannot move staff out of their branch or change scope.
    if (scope === "SCHOOL" || (branchId !== undefined && branchId !== session.branchId) || target.branchId !== session.branchId) {
      return NextResponse.json({ error: "Branch admins can only manage staff in their own branch." }, { status: 403 });
    }
  }
  if (finalScope === "BRANCH") {
    if (!finalBranchId) return NextResponse.json({ error: "Choose the branch for this staff member." }, { status: 400 });
    const branch = await prisma.branch.findUnique({ where: { id: finalBranchId } });
    if (!branch || branch.schoolId !== schoolId) {
      return NextResponse.json({ error: "Branch not found." }, { status: 404 });
    }
    if (branch.enabled === false && data.active !== false) {
      return NextResponse.json({ error: "This branch's ERP access is turned off. Enable it first." }, { status: 400 });
    }
  }

  if (body?.password) {
    if (String(body.password).length < 6) {
      return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
    }
    data.passwordHash = bcrypt.hashSync(String(body.password), 10);
  }
  if (body?.active !== undefined) data.active = body.active === true;

  const updated = await prisma.user.update({ where: { id }, data });
  await audit("STAFF_UPDATE", "user", id, { schoolId, data: Object.keys(data) });
  return NextResponse.json({ data: updated });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "staff", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = schoolIdOf(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const { error, target } = await resolveTargetUser(session, id, schoolId);
  if (error) return error;
  if (!target) return NextResponse.json({ error: "Staff member not found" }, { status: 404 });
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // Soft-delete: freeze the account (keeps history/audit intact).
  await prisma.user.update({ where: { id }, data: { active: false } });
  await audit("STAFF_DEACTIVATE", "user", id, { schoolId });
  return NextResponse.json({ data: { ok: true } });
}