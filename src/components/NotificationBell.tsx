"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, CheckCheck } from "lucide-react";
import { api } from "@/lib/client";
import { cn, fmtDate } from "@/lib/utils";

interface NotificationItem {
  id: string;
  event: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string;
}

/** PRD §13 — in-app notification center (bell) used in the Shell header. */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [unread, setUnread] = useState(0);
  const router = useRouter();
  const boxRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const data = await api<{ items: NotificationItem[]; unread: number }>("/api/notifications?take=15");
      setItems(data.items);
      setUnread(data.unread);
    } catch {
      /* silent — bell is non-critical */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000); // light polling; FCM push arrives out-of-band
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const markAll = async () => {
    await api("/api/notifications", { method: "POST", body: JSON.stringify({}) }).catch(() => null);
    setUnread(0);
    setItems((prev) => prev.map((i) => ({ ...i, readAt: i.readAt || new Date().toISOString() })));
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="relative rounded-lg p-2 text-slate-500 transition hover:bg-slate-100"
        title="Notifications"
        aria-label="Notifications"
      >
        <Bell size={18} />
        {unread > 0 && (
          <span className="absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-rose-500 px-1 text-[10px] font-bold text-white">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-11 z-50 w-80 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
            <p className="text-sm font-bold text-slate-800">Notifications</p>
            <button onClick={markAll} className="flex items-center gap-1 text-xs font-semibold text-indigo-600 hover:underline">
              <CheckCheck size={14} /> Mark all read
            </button>
          </div>
          <div className="max-h-96 overflow-y-auto">
            {items.length === 0 ? (
              <p className="px-4 py-8 text-center text-xs text-slate-400">No notifications yet</p>
            ) : (
              items.map((n) => (
                <button
                  key={n.id}
                  onClick={() => {
                    api("/api/notifications", { method: "POST", body: JSON.stringify({ id: n.id }) }).catch(() => null);
                    setUnread((u) => Math.max(0, u - (n.readAt ? 0 : 1)));
                    if (n.link) router.push(n.link);
                    setOpen(false);
                  }}
                  className={cn(
                    "block w-full border-b border-slate-50 px-4 py-3 text-left transition hover:bg-slate-50",
                    !n.readAt && "bg-indigo-50/60"
                  )}
                >
                  <p className={cn("text-xs font-bold", !n.readAt ? "text-indigo-700" : "text-slate-700")}>{n.title}</p>
                  {n.body && <p className="mt-0.5 line-clamp-2 text-[11px] text-slate-500">{n.body}</p>}
                  <p className="mt-1 text-[10px] text-slate-400">{fmtDate(n.createdAt, true)}</p>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
