"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Bell, BellOff, Check, CheckCheck, ChevronRight, Loader2, Search, Trash2 } from "lucide-react";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { Card, EmptyState } from "@/components/ui";
import { notificationMeta, relativeTime } from "@/components/notification-ui";

export interface NotificationRow {
  id: string;
  event: string;
  title: string;
  body: string | null;
  link: string | null;
  readAt: string | null;
  createdAt: string | null;
}

interface Payload {
  items: NotificationRow[];
  unread: number;
  total: number;
  hasMore?: boolean;
}

const PAGE = 30;
type Filter = "all" | "unread" | "read";

/**
 * The notification centre: every message addressed to the signed-in user, in
 * one place, with the actions a real inbox needs — filter, search, mark read,
 * mark unread, delete one, clear the read ones, open the screen it came from.
 *
 * Shared verbatim by all four portals (school, teacher, parent, platform), so a
 * teacher and a parent see the same tidy list with the same keyboard-free
 * controls. Reads bypass the client memo (`no-store`): a notification list that
 * lies about being fresh is worse than one that is slow.
 */
/**
 * The list surface. The portal's bordered `Card` by default; the Teacher App's
 * inset panel — a hairline ring instead of a border — when asked for. Purely a
 * wrapper: the children are identical either way.
 *
 * A separate element rather than a `className` on `Card`, because `.card` is an
 * unlayered global rule and would out-rank the utility overrides that would be
 * needed to strip its border and shadow.
 */
function CenterSurface({ teacher, children }: { teacher: boolean; children: React.ReactNode }) {
  if (teacher) return <div className="overflow-hidden rounded-2xl bg-white ring-1 ring-slate-900/5">{children}</div>;
  return <Card>{children}</Card>;
}

export function NotificationsCenter({ appearance = "default" }: { appearance?: "default" | "teacher" } = {}) {
  // Presentation only. The Teacher App renders the same centre on the app's inset
  // panel with a pill filter; every other portal keeps the default branch exactly
  // as it was, and no read, filter or action changes either way.
  const teacher = appearance === "teacher";
  const [items, setItems] = useState<NotificationRow[]>([]);
  const [unread, setUnread] = useState(0);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const query = useRef({ filter, q });

  const load = useCallback(async (f: Filter, term: string, append = false) => {
    if (!append) setLoading(true);
    try {
      const cursor = append && items.length ? items[items.length - 1].createdAt : "";
      const url = `/api/notifications?filter=${f}&take=${PAGE}&q=${encodeURIComponent(term)}${cursor ? `&before=${encodeURIComponent(cursor)}` : ""}`;
      const data = await api<Payload>(url, { cache: "no-store" });
      setItems((prev) => (append ? [...prev, ...data.items] : data.items));
      setUnread(data.unread);
      setTotal(data.total);
      setHasMore(!!data.hasMore);
      setError(null);
    } catch (e: any) {
      setError(e?.message || "Could not load notifications.");
    } finally {
      setLoading(false);
    }
    // `items` is read only for the paging cursor; listing it keeps the closure
    // honest without turning the callback into a new function on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  useEffect(() => {
    query.current = { filter, q };
  }, [filter, q]);

  // Initial load + a debounce so typing in the search box does not fire a query
  // per keystroke.
  useEffect(() => {
    const t = setTimeout(() => void load(filter, q), filter === "all" && !q ? 0 : 200);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, q]);

  // Live: poll the unread badge and prepend anything new, so a notice published
  // while the page is open appears without a manual refresh.
  useEffect(() => {
    const tick = async () => {
      const { filter: f, q: term } = query.current;
      try {
        const data = await api<Payload>("/api/notifications?countOnly=1", { cache: "no-store" });
        setUnread(data.unread);
        if (f === "all" && !term) {
          const top = items[0]?.createdAt;
          const since = top ? `&since=${encodeURIComponent(top)}` : "";
          if (since) {
            const fresh = await api<Payload>(`/api/notifications?take=20${since}`, { cache: "no-store" });
            if (fresh.items.length) {
              setItems((prev) => [...fresh.items, ...prev]);
              setTotal(data.total);
            }
          }
        }
      } catch {
        /* polling is best-effort */
      }
    };
    const t = setInterval(tick, 20000);
    const onFocus = () => void tick();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", onFocus);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const openRow = async (n: NotificationRow) => {
    if (!n.readAt) {
      void markOneRead(n.id);
    }
    if (n.link) router.push(n.link);
  };

  const markOneRead = async (id: string) => {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, readAt: x.readAt || new Date().toISOString() } : x)));
    setUnread((u) => Math.max(0, u - 1));
    await api("/api/notifications", { method: "POST", body: JSON.stringify({ id }) }).catch(() => null);
  };

  const markOneUnread = async (id: string) => {
    setItems((prev) => prev.map((x) => (x.id === id ? { ...x, readAt: null } : x)));
    setUnread((u) => u + 1);
    await api("/api/notifications", { method: "POST", body: JSON.stringify({ id, unread: true }) }).catch(() => null);
  };

  const markAll = async () => {
    setBusy(true);
    setItems((prev) => prev.map((x) => ({ ...x, readAt: x.readAt || new Date().toISOString() })));
    setUnread(0);
    await api("/api/notifications", { method: "POST", body: JSON.stringify({}) }).catch(() => null);
    setBusy(false);
    void load(filter, q);
  };

  const removeOne = async (id: string) => {
    const row = items.find((x) => x.id === id);
    setItems((prev) => prev.filter((x) => x.id !== id));
    setTotal((t) => Math.max(0, t - 1));
    if (row && !row.readAt) setUnread((u) => Math.max(0, u - 1));
    await api(`/api/notifications?id=${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => null);
  };

  const clearRead = async () => {
    setBusy(true);
    await api("/api/notifications?scope=read", { method: "DELETE" }).catch(() => null);
    setBusy(false);
    void load(filter, q);
  };

  const shown = useMemo(() => items, [items]);

  return (
    <div className="space-y-4">
      <CenterSurface teacher={teacher}>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3">
          <div className={cn("flex items-center gap-1 bg-slate-100 p-1", teacher ? "w-full rounded-full" : "rounded-xl")}>
            {(["all", "unread", "read"] as Filter[]).map((f) => (
              <button
                key={f}
                onClick={() => setFilter(f)}
                className={cn(
                  "font-bold capitalize transition",
                  teacher
                    ? cn(
                        "flex min-h-11 flex-1 items-center justify-center rounded-full px-3 text-[13px]",
                        filter === f ? "brand-bg text-white shadow-sm" : "text-slate-500"
                      )
                    : cn(
                        "rounded-lg px-3 py-1.5 text-xs",
                        filter === f ? "bg-white text-slate-800 shadow-sm" : "text-slate-500 hover:text-slate-700"
                      )
                )}
              >
                {f}
                {f === "unread" && unread > 0 && (
                  <span
                    className={cn(
                      "ml-1.5 rounded-full px-1.5 text-[10px] font-bold",
                      teacher && filter === f ? "bg-white/25 text-white" : "bg-rose-500 text-white"
                    )}
                  >
                    {unread > 99 ? "99+" : unread}
                  </span>
                )}
              </button>
            ))}
          </div>

          <div className="relative min-w-40 flex-1">
            <Search size={14} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search notifications…"
              className="input pl-8"
              aria-label="Search notifications"
            />
          </div>

          <button
            onClick={markAll}
            disabled={busy || unread === 0}
            className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <CheckCheck size={14} /> Mark all read
          </button>
          <button
            onClick={clearRead}
            disabled={busy}
            className="flex items-center gap-1.5 rounded-xl border border-slate-200 px-3 py-2 text-xs font-bold text-slate-600 transition hover:bg-slate-50 disabled:opacity-40"
          >
            <Trash2 size={14} /> Clear read
          </button>
        </div>
      </CenterSurface>

      {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}

      <CenterSurface teacher={teacher}>
        {loading ? (
          <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-slate-400">
            <Loader2 size={16} className="animate-spin" /> Loading notifications…
          </div>
        ) : shown.length === 0 ? (
          <EmptyState
            icon={BellOff}
            title={q ? "Nothing matches that search" : filter === "unread" ? "No unread notifications" : "No notifications yet"}
            description={
              q
                ? "Try a shorter word, or clear the search to see everything."
                : "Notices, results, fees and attendance will land here as they happen."
            }
          />
        ) : (
          <>
            <ul className="divide-y divide-slate-100">
              {shown.map((n) => {
                const meta = notificationMeta(n.event);
                const Icon = meta.icon;
                const unreadRow = !n.readAt;
                return (
                  <li
                    key={n.id}
                    className={cn("group flex items-start gap-3 px-4 py-3.5 transition", unreadRow ? "bg-indigo-50/40" : "hover:bg-slate-50")}
                  >
                    <button
                      onClick={() => void openRow(n)}
                      className="flex min-w-0 flex-1 items-start gap-3 text-left"
                      title={n.link ? "Open" : n.title}
                    >
                      <span className={cn("mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-xl", meta.tone)}>
                        <Icon size={17} />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          {unreadRow && <span className="h-2 w-2 shrink-0 rounded-full bg-rose-500" aria-label="Unread" />}
                          <span className={cn("truncate text-sm", unreadRow ? "font-bold text-slate-900" : "font-semibold text-slate-700")}>
                            {n.title}
                          </span>
                        </span>
                        {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-slate-500">{n.body}</span>}
                        <span className="mt-1 flex items-center gap-2 text-[11px] text-slate-400">
                          <span className="font-semibold uppercase tracking-wide">{meta.label}</span>
                          <span>·</span>
                          <span>{relativeTime(n.createdAt)}</span>
                          {n.link && (
                            <>
                              <span>·</span>
                              <span className="inline-flex items-center gap-0.5 font-semibold text-indigo-500">
                                Open <ChevronRight size={11} />
                              </span>
                            </>
                          )}
                        </span>
                      </span>
                    </button>

                    <div className="ss-notif-actions flex shrink-0 items-center gap-0.5">
                      {unreadRow ? (
                        <button
                          onClick={() => void markOneRead(n.id)}
                          title="Mark read"
                          aria-label="Mark read"
                          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-emerald-50 hover:text-emerald-600"
                        >
                          <Check size={15} />
                        </button>
                      ) : (
                        <button
                          onClick={() => void markOneUnread(n.id)}
                          title="Mark unread"
                          aria-label="Mark unread"
                          className="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
                        >
                          <Bell size={15} />
                        </button>
                      )}
                      <button
                        onClick={() => void removeOne(n.id)}
                        title="Delete"
                        aria-label="Delete notification"
                        className="rounded-lg p-1.5 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600"
                      >
                        <Trash2 size={15} />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-4 py-3 text-xs text-slate-400">
              <span>
                {shown.length} of {total} notification{total === 1 ? "" : "s"}
              </span>
              {hasMore && (
                <button
                  onClick={() => void load(filter, q, true)}
                  className="rounded-lg border border-slate-200 px-3 py-1.5 font-bold text-slate-600 transition hover:bg-slate-50"
                >
                  Load more
                </button>
              )}
            </div>
          </>
        )}
      </CenterSurface>
    </div>
  );
}
