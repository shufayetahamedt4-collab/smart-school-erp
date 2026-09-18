import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { createHash } from "node:crypto";

/** PRD §7.1/§13 — register (or refresh) a device token for FCM web push. */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const token = String(body?.token || "");
  if (!token) return NextResponse.json({ error: "Token is required." }, { status: 400 });

  const platform = String(body?.platform || "web");
  await prisma.device.upsert({
    where: { token },
    create: { token, userId: session.id, schoolId: session.schoolId, platform, active: true },
    update: { userId: session.id, schoolId: session.schoolId, active: true },
  });
  return NextResponse.json({ data: { ok: true, hash: createHash("sha1").update(token).digest("hex").slice(0, 10) } });
}

/** Deactivate a token (logout / uninstalled). */
export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const token = new URL(req.url).searchParams.get("token") || "";
  if (token) {
    await prisma.device.updateMany({ where: { token, userId: session.id }, data: { active: false } });
  }
  return NextResponse.json({ data: { ok: true } });
}
