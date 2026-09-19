import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { slugify } from "@/lib/utils";
import { writeGuard } from "@/lib/subscription";

/**
 * School detail API.
 * - SUPER_ADMIN: full access (platform management).
 * - SCHOOL_ADMIN/sub-roles of that school: read own school + self-service
 *   profile/branding updates (PRD §12.2) — but never plan/status/slug.
 */
async function authorize(id: string, selfEdit: boolean) {
  const session = await getSession();
  if (!session) return { session: null, allowed: false as const };
  if (session.role === "SUPER_ADMIN") return { session, allowed: true as const };
  if (session.schoolId === id && can(session.role, "systemSettings", selfEdit ? "full" : "view")) {
    return { session, allowed: true as const };
  }
  return { session, allowed: false as const };
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { session, allowed } = await authorize(await params.then((p) => p.id), false);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;

  const isPlatform = session.role === "SUPER_ADMIN";
  const school = await prisma.school.findUnique({
    where: { id },
    include: {
      _count: { select: { students: true, teachers: true, classes: true, users: true, fees: true } },
      feeSetting: true,
      users: { where: { role: "SCHOOL_ADMIN" }, select: { id: true, name: true, email: true } },
    },
  });
  if (!school) return NextResponse.json({ error: "School not found" }, { status: 404 });

  if (!isPlatform) {
    // School-scoped view: hide platform-managed fields.
    const { plan: _plan, status: _status, slug: _slug, ...rest } = school;
    void _plan; void _status; void _slug;
    return NextResponse.json({ data: { ...rest, plan: null, status: null, slug: null } });
  }
  return NextResponse.json({ data: school });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { session, allowed } = await authorize(id, true);
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!allowed) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const isPlatform = session.role === "SUPER_ADMIN";

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const writeBlocked = await writeGuard(session.schoolId ?? id);
  if (writeBlocked) return writeBlocked;

  const data: any = {};
  // Self-service editable fields (school admin): profile + branding only.
  for (const key of ["tagline", "address", "phone", "email", "website", "logoUrl", "themeColor"]) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  // Platform-only fields (super admin): name (regenerates slug), plan, status.
  if (isPlatform) {
    for (const key of ["name", "status", "plan"]) {
      if (body[key] !== undefined) data[key] = body[key];
    }
  }
  if (body.themeColor !== undefined) {
    // PRD §12.2 — brand color must be a strict 6-digit hex.
    const hex = String(body.themeColor || "").trim();
    if (hex && !/^#[0-9a-fA-F]{6}$/.test(hex)) {
      return NextResponse.json({ error: "themeColor must be a 6-digit hex color like #4f46e5." }, { status: 400 });
    }
    data.themeColor = hex || null;
  }
  if (isPlatform && body.name) data.slug = slugify(body.name) || undefined;

  const school = await prisma.school.update({ where: { id }, data });
  // Fee defaults are school-level settings (PRD §2.1 System Settings row) —
  // both platform and the school's own admins may set them.
  if (body.monthlyFee !== undefined || body.admissionFee !== undefined) {
    await prisma.feeSetting.upsert({
      where: { schoolId: id },
      update: {
        monthlyFee: body.monthlyFee !== undefined ? Number(body.monthlyFee) : undefined,
        admissionFee: body.admissionFee !== undefined ? Number(body.admissionFee) : undefined,
      },
      create: { schoolId: id, monthlyFee: Number(body.monthlyFee || 1500), admissionFee: Number(body.admissionFee || 5000) },
    });
  }
  await audit("SCHOOL_UPDATE", "school", id, { ...data, by: session.role });
  return NextResponse.json({ data: school });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SUPER_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  await audit("SCHOOL_DELETE", "school", id);
  await prisma.school.delete({ where: { id } });
  return NextResponse.json({ data: { ok: true } });
}
