import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { slugify } from "@/lib/utils";

async function guard() {
  const session = await getSession();
  if (!session || session.role !== "SUPER_ADMIN") return null;
  return session;
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await guard())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const school = await prisma.school.findUnique({
    where: { id },
    include: {
      _count: { select: { students: true, teachers: true, classes: true, users: true, fees: true } },
      feeSetting: true,
      users: { where: { role: "SCHOOL_ADMIN" }, select: { id: true, name: true, email: true } },
    },
  });
  if (!school) return NextResponse.json({ error: "School not found" }, { status: 404 });
  return NextResponse.json({ data: school });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await guard())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const data: any = {};
  for (const key of ["name", "tagline", "address", "phone", "email", "website", "status", "plan", "logoUrl"]) {
    if (body[key] !== undefined) data[key] = body[key];
  }
  if (body.name) data.slug = slugify(body.name) || data.slug;

  const school = await prisma.school.update({ where: { id }, data });
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
  await audit("SCHOOL_UPDATE", "school", id, { ...data });
  return NextResponse.json({ data: school });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await guard())) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  await audit("SCHOOL_DELETE", "school", id);
  await prisma.school.delete({ where: { id } });
  return NextResponse.json({ data: { ok: true } });
}
