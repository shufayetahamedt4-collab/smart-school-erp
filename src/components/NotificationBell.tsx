"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Bell, BellOff, Check, CheckCheck, Loader2, Trash2 } from "lucide-react";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { notificationMeta, relativeTime } from "@/components/notification-ui";
import type { NotificationRow } from "@/components/NotificationsCenter";

/**
 * PRD §13 — the header bell: the last few notifications, with the actions worth
 * having without leaving the page (open, mark read/unread, delete, mark all).
 * "View all" hands off to the portal's full notification centre.
 *
 * The count is polled every 30s and refreshed the moment the window regains
 * focus (a tab left open all day must still be right when the user looks back),
 * while the list itself is re-read only when the panel opens.
 */
export function NotificationBell({
  viewAllHref = "/dashboard/notifications",
  appearance = "light",
}: {
  viewAllHref?: string;
  /**
   * Visual variant of the TRIGGER only, and opt-in.
   *
   * The default, "light", is exactly what this component has always rendered, so
   * every existing caller — the School Admin and Super Admin shells — is byte-for-
   * byte unchanged. "dark" exists solely for the Teacher App's dark navy app bar,
   * where the light trigger would sit at slate-500 on a near-black surface.
   *
   * The panel is deliberately NOT variant-ed: it is a menu that floats over the
   * page rather than part of the bar, so it stays light and readable in both.
   */
  appearance?: "light" | "dark";
}) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      // no-store: the bell is an explicit freshness read (opened on demand).
      const data = await api<{ items: NotificationRow[]; unread: number }>("/api/notifications?take=12", { cache: "no-store" });
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      /* silent — bell is non-critical */
    }
    setLoading(false);
  }, []);

  const loadCount = useCallback(async () => {
    try {
      const data = await api<{ unread: number }>("/api/notifications?countOnly=1", { cache: "no-store" });
      setUnread(data.unread);
    } catch {
      /* silent — bell is non-critical */
    }
  }, []);

  useEffect(() => {
    loadCount();
    const t = setInterval(loadCount, 30000); // light polling; FCM push arrives out-of-band
    const onFocus = () => void loadCount();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
  }, [loadCount]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const markAll = async () => {
    setUnread(0);
    setItems((prev) => prev.map((i) => ({ ...i, readAt: i.readAt || new Date().toISOString() })));
    await api("/api/notifications", { method: "POST", body: JSON.stringify({}) }).catch(() => null);
  };

  const markOne = async (id: string, unreadFlag: boolean) => {
    setItems((prev) => prev.map((i) => (i.id === id ? { ...i, readAt: unreadFlag ? null : i.readAt || new Date().toISOString() } : i)));
    setUnread((u) => Math.max(0, u + (unreadFlag ? 1 : -1)));
    await api("/api/notifications", { method: "POST", body: JSON.stringify(unreadFlag ? { id, unread: true } : { id }) }).catch(() => null);
  };

  const removeOne = async (id: string) => {
    const row = items.find((i) => i.id === id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    if (row && !row.readAt) setUnread((u) => Math.max(0, u - 1));
    await api(`/api/notifications?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
  };

  const openItem = (n: NotificationRow) => {
    if (!n.readAt) void markOne(n.id, false);
    setOpen(false);
    if (n.link) router.push(n.link);
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => {
          const nextOpen = !open;
          setOpen(nextOpen);
          if (nextOpen) void load();
        }}
        className={cn(
          "relative rounded-lg p-2 transition",
          appearance === "dark"
            ? "text-slate-300 hover:bg-white/10 hover:text-white"
            : "text-slate-500 hover:bg-slate-100",
        )}
        title="Notifications"
        aria-label="Notifications"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-11 z-50 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl fade-up">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-bold text-slate-800">
              Notifications
              {unread > 0 && <span className="ml-2 rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-bold text-rose-600">{unread} new</span>}
            </p>
            <button onClick={markAll} disabled={unread === 0} className="flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:underline disabled:opacity-40">
              <CheckCheck size={14} /> Mark all read
            </button>
          </div>

          <div className="max-h-96 overflow-y-auto">
            {loading && items.length === 0 ? (
              <p className="flex items-center justify-center gap-2 px-4 py-8 text-xs text-slate-400">
                <Loader2 size={14} className="animate-spin" /> Loading…
              </p>
            ) : items.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
                <BellOff size={20} className="text-slate-300" />
                <p className="text-xs text-slate-400">No notifications yet</p>
              </div>
            ) : (
              items.map((n) => {
                const meta = notificationMeta(n.event);
                const Icon = meta.icon;
                return (
                  <div key={n.id} className={cn("group relative border-b border-slate-50", !n.readAt && "bg-indigo-50/50")}>
                    <button onClick={() => openItem(n)} className="flex w-full items-start gap-2.5 px-4 py-3 pr-16 text-left transition hover:bg-slate-50/80">
                      <span className={cn("mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", meta.tone)}>
                        <Icon size={15} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className={cn("block truncate text-xs", !n.readAt ? "font-bold text-indigo-700" : "font-semibold text-slate-700")}>{n.title}</span>
                        {n.body && <span className="mt-0.5 line-clamp-2 block text-[11px] text-slate-500">{n.body}</span>}
                        <span className="mt-0.5 block text-[10px] text-slate-400">{relativeTime(n.createdAt)}</span>
                      </span>
                    </button>
                    <div className="ss-bell-actions absolute right-2 top-2.5 hidden items-center gap-0.5 group-hover:flex">
                      <button
                        onClick={() => void markOne(n.id, !n.readAt)}
                        title={n.readAt ? "Mark unread" : "Mark read"}
                        aria-label={n.readAt ? "Mark unread" : "Mark read"}
                        className="rounded-md bg-white/80 p-1 text-slate-400 transition hover:bg-white hover:text-slate-700"
                      >
                        {n.readAt ? <Bell size={13} /> : <Check size={13} />}
                      </button>
                      <button
                        onClick={() => void removeOne(n.id)}
                        title="Delete"
                        aria-label="Delete notification"
                        className="rounded-md bg-white/80 p-1 text-slate-400 transition hover:bg-white hover:text-rose-600"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          <Link
            href={viewAllHref}
            onClick={() => setOpen(false)}
            className="block border-t border-slate-100 px-4 py-3 text-center text-xs font-bold text-indigo-600 transition hover:bg-indigo-50"
          >
            View all notifications
          </Link>
        </div>
      )}
    </div>
  );
}
