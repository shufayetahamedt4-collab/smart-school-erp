import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { markRead, markUnread, deleteNotifications } from "@/lib/notify";

/**
 * PRD §13 — the notification centre API.
 *
 * Every sector shares this one endpoint: a notification is addressed to a user
 * (never a role or a device), so the only rule that matters is "you may only
 * ever read or change your OWN rows". That is enforced here by scoping every
 * query to `session.id` — a guardian cannot reach a teacher's bell even by
 * guessing an id.
 *
 *   GET    ?countOnly=1            → { unread, total }        (the bell badge)
 *   GET    ?take=30&filter=unread  → { items, unread, total, hasMore }
 *   GET    ?since=<ISO>            → rows newer than the cursor (live polling)
 *   POST   { id? ids? unread? }    → mark read (default: all) / mark unread
 *   DELETE ?id=<id> | ?scope=read|all → remove rows
 */

/** Newest first. Rows written before timestamps existed have no `createdAt`;
 *  they sort last rather than jumping to the top of the list. */
function byNewest(a: any, b: any): number {
  const ta = a.createdAt ? new Date(a.createdAt).getTime() : NaN;
  const tb = b.createdAt ? new Date(b.createdAt).getTime() : NaN;
  if (Number.isNaN(ta) || Number.isNaN(tb)) {
    if (Number.isNaN(ta) && Number.isNaN(tb)) return 0;
    return Number.isNaN(ta) ? 1 : -1;
  }
  return tb - ta;
}

const timeOf = (n: any): number => (n.createdAt ? new Date(n.createdAt).getTime() : NaN);

async function mine(userId: string): Promise<any[]> {
  const items: any[] = await prisma.notification.findMany({ where: { userId } });
  return items;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const sp = req.nextUrl.searchParams;
  const all = await mine(session.id);
  const unread = all.filter((n) => !n.readAt).length;

  if (sp.get("countOnly")) {
    return NextResponse.json({ data: { unread, total: all.length } });
  }

  // Incremental read for the live poll: only what changed since the last look.
  const since = sp.get("since");
  if (since) {
    const t = Date.parse(since);
    const fresh = Number.isNaN(t) ? [] : all.filter((n) => timeOf(n) > t);
    return NextResponse.json({ data: { items: fresh.sort(byNewest), unread, total: all.length } });
  }

  const filter = (sp.get("filter") || "all").toLowerCase();
  const event = sp.get("event") || "";
  const q = (sp.get("q") || "").trim().toLowerCase();
  const take = Math.min(Math.max(Number(sp.get("take") || 30) || 30, 1), 100);
  const before = sp.get("before") ? Date.parse(sp.get("before")!) : NaN;

  let items = all.slice();
  if (filter === "unread") items = items.filter((n) => !n.readAt);
  else if (filter === "read") items = items.filter((n) => !!n.readAt);
  if (event) items = items.filter((n) => n.event === event);
  if (q) {
    items = items.filter((n) =>
      `${n.title || ""} ${n.body || ""}`.toLowerCase().includes(q)
    );
  }
  items.sort(byNewest);
  // A paging cursor is the previous page's last timestamp (strictly older next).
  if (!Number.isNaN(before)) items = items.filter((n) => timeOf(n) < before);

  const page = items.slice(0, take);
  return NextResponse.json({
    data: { items: page, unread, total: all.length, hasMore: items.length > take },
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);

  // Mark-unread is the one way a row leaves the read state again.
  if (body?.unread === true || body?.op === "unread") {
    const id = body?.id ? String(body.id) : "";
    if (!id) return NextResponse.json({ error: "id is required." }, { status: 400 });
    const changed = await markUnread(session.id, id);
    return NextResponse.json({ data: { ok: true, changed } });
  }

  // Explicit id list, a single id, or everything (the original bell contract).
  const ids: string[] = Array.isArray(body?.ids)
    ? body.ids.map((x: any) => String(x)).filter(Boolean)
    : body?.id
      ? [String(body.id)]
      : [];
  let changed = 0;
  if (ids.length) {
    for (const id of ids) changed += await markRead(session.id, id);
  } else {
    changed = await markRead(session.id);
  }
  return NextResponse.json({ data: { ok: true, changed } });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const id = sp.get("id") || "";
  const scope = (sp.get("scope") || "").toLowerCase();

  if (id) {
    const removed = await deleteNotifications(session.id, { id });
    return NextResponse.json({ data: { ok: true, removed } });
  }
  if (scope === "read") {
    const removed = await deleteNotifications(session.id, { readOnly: true });
    return NextResponse.json({ data: { ok: true, removed } });
  }
  if (scope === "all") {
    const removed = await deleteNotifications(session.id, {});
    return NextResponse.json({ data: { ok: true, removed } });
  }
  return NextResponse.json({ error: "id or scope=read|all is required." }, { status: 400 });
}
