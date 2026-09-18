import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";

/**
 * PRD §12.1 — Plan Management (Super Admin).
 * Plans: Trial / Basic / Premium with feature-based limits (maxStudents).
 */

export async function GET() {
  const session = await getSession();
  if (!session || !can(session.role, "platformBilling", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const plans = await prisma.plan.findMany({ orderBy: { price: "asc" } });
  return NextResponse.json({ data: plans });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "platformBilling", "billing")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  if (!name) return NextResponse.json({ error: "Plan name is required." }, { status: 400 });

  const plan = await prisma.plan.create({
    data: {
      name,
      price: Number(body?.price || 0),
      cycle: body?.cycle === "YEARLY" ? "YEARLY" : "MONTHLY",
      maxStudents: body?.maxStudents ? Number(body.maxStudents) : null,
      trialDays: body?.trialDays ? Number(body.trialDays) : null,
      features: Array.isArray(body?.features) ? body.features : [],
    },
  });
  await audit("PLAN_CREATE", "plan", plan.id, { name });
  return NextResponse.json({ data: plan }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "platformBilling", "billing")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const plan = await prisma.plan.findUnique({ where: { id } });
  if (!plan) return NextResponse.json({ error: "Plan not found" }, { status: 404 });

  const data: any = {};
  if (body.name !== undefined) data.name = String(body.name);
  if (body.price !== undefined) data.price = Number(body.price);
  if (body.cycle !== undefined) data.cycle = body.cycle === "YEARLY" ? "YEARLY" : "MONTHLY";
  if (body.maxStudents !== undefined) data.maxStudents = body.maxStudents ? Number(body.maxStudents) : null;
  if (body.trialDays !== undefined) data.trialDays = body.trialDays ? Number(body.trialDays) : null;
  if (body.features !== undefined) data.features = Array.isArray(body.features) ? body.features : [];

  const updated = await prisma.plan.update({ where: { id }, data });
  await audit("PLAN_UPDATE", "plan", id, data);
  return NextResponse.json({ data: updated });
}
