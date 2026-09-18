import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { markRead } from "@/lib/notify";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const url = new URL(req.url);
  if (url.searchParams.get("countOnly")) {
    const unread = await prisma.notification.count({ where: { userId: session.id, readAt: null } });
    return NextResponse.json({ data: { unread } });
  }

  const take = Math.min(Number(url.searchParams.get("take") || 30), 100);
  const items = await prisma.notification.findMany({
    where: { userId: session.id },
    orderBy: { createdAt: "desc" },
    take,
  });
  const unread = await prisma.notification.count({ where: { userId: session.id, readAt: null } });
  return NextResponse.json({ data: { items, unread } });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  await markRead(session.id, body?.id ? String(body.id) : undefined);
  return NextResponse.json({ data: { ok: true } });
}
