"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  GraduationCap, Users, BookOpen, Wallet, Scale, Megaphone, ArrowUpRight, ArrowRight,
  ClipboardList, Radio, CalendarX2, CalendarCheck, Inbox, Bell,
} from "lucide-react";
import { api } from "@/lib/client";
import { useMe } from "@/components/Shell";
import {
  LoadingScreen, PageHeader, EmptyState,
  KpiCard, PulseFact, AttentionRow,
} from "@/components/ui";
import { notificationMeta, relativeTime } from "@/components/notification-ui";
import { fmtMoney, fmtDate } from "@/lib/utils";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

/**
 * The School Command Center.
 *
 * Same data, same endpoints as before — this only re-arranges the screen into
 * the questions a school office actually asks at 8am: is attendance healthy,
 * what is running now, what needs action, what is coming. Every figure is read
 * from a field the API already returned (KPI cards read /api/stats exclusively);
 * nothing here computes a new business value, and every source degrades to
 * hidden when the signed-in role cannot read it.
 *
 * Composition (Pass 3): the workspace is grouped into four surfaces instead of a
 * stack of independent cards —
 *   L1  page context + primary action
 *   L2  "Today"        the operational pulse (a flat, tinted status strip)
 *   L3  "Today"        the school's standing totals (a divided white KPI row)
 *   L4  attendance trend | needs your attention
 *   L5  today's schedule | recent activity
 *   L6  notices | PTM | parent engagement — deliberately quieter
 * Each surface is border-defined and shadow-free; separators are hairlines.
 */

interface Stats {
  counts: { students: number; teachers: number; classes: number; exams: number; notices: number; marksCount: number };
  fees: { totalFees: number; paidFees: number; dueFees: number; unpaidCount: number };
  attendanceToday: { present: number; absent: number; total: number };
  trend: { label: string; present: number; absent: number; total: number }[];
}

interface Notice {
  id: string; title: string; body: string; category: string; date: string;
}

interface NotificationRow {
  id: string; event: string; title: string; body: string | null; link: string | null; readAt: string | null; createdAt: string | null;
}

interface StatusRow { id: string; status: string }
interface MeetingSlot { id: string; startAt: string; title?: string | null; bookings?: { id: string; status: string }[] }
interface RosterData {
  counts: { inClass: number; expected: number; missing: number; declined: number; free: number; onLeave: number; sessionsToday: number };
  live: { id: string; teacherName: string; className: string; sectionName: string | null; subjectName: string | null; periodLabel: string | null; startedClock: string | null }[];
}

/** One "needs attention" figure; null means the role could not read the source. */
interface Attention {
  leaves: number | null;
  admissions: number | null;
  complaints: number | null;
  ptm: number | null;
  unread: number | null;
}

export default function SchoolDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);

  const [attention, setAttention] = useState<Attention>({ leaves: null, admissions: null, complaints: null, ptm: null, unread: null });
  const [roster, setRoster] = useState<RosterData | null>(null);
  const [activity, setActivity] = useState<NotificationRow[]>([]);
  const [meetings, setMeetings] = useState<MeetingSlot[]>([]);
  const [attentionLoading, setAttentionLoading] = useState(true);

  // The page's own context line. Computed after mount (never during render) so
  // the server-rendered HTML and the client cannot disagree about "today".
  const [todayLabel, setTodayLabel] = useState("");
  useEffect(() => {
    setTodayLabel(new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }));
  }, []);

  const { me } = useMe();
  const role = me?.user?.role || "";

  // First paint is exactly what it was: the stats read and the notices read.
  // Everything else loads in the second wave below, so the command center never
  // becomes slower to appear than the dashboard it replaces.
  useEffect(() => {
    // Notices are optional for back-office roles (the permission matrix gives
    // e.g. the accountant no communication access) — the dashboard must still
    // render, so a 403 on notices degrades to an empty board.
    const noticesP = api<Notice[]>("/api/notices?limit=5").catch(() => [] as Notice[]);
    Promise.all([api<Stats>("/api/stats"), noticesP])
      .then(([s, n]) => { setStats(s); setNotices(Array.isArray(n) ? n : []); })
      .finally(() => setLoading(false));
  }, []);

  // The attention / schedule / activity wave. Each source is optional: a role
  // that may not read it (or an empty school) simply yields null and the row or
  // panel is omitted, never rendered with a fabricated number.
  useEffect(() => {
    if (!role) return;
    let cancelled = false;
    const safe = <T,>(p: Promise<T>) => p.catch(() => null);
    // The live-class roster is the heaviest read and only the two admin roles
    // may take it; every other role skips it entirely.
    const canRoster = role === "SCHOOL_ADMIN" || role === "BRANCH_ADMIN";

    Promise.all([
      safe(api<StatusRow[]>("/api/leave-requests")),
      safe(api<StatusRow[]>("/api/admissions")),
      safe(api<StatusRow[]>("/api/complaints")),
      safe(api<MeetingSlot[]>("/api/meetings")),
      safe(api<{ unread: number; total: number }>("/api/notifications?countOnly=1")),
      safe(api<{ items: NotificationRow[] }>("/api/notifications?take=5")),
      canRoster ? safe(api<RosterData>("/api/class-sessions?view=roster")) : Promise.resolve(null),
    ])
      .then(([leaves, admissions, complaints, meetingSlots, notif, recent, rosterData]) => {
        if (cancelled) return;
        setAttention({
          leaves: leaves ? leaves.filter((l) => l.status === "PENDING").length : null,
          admissions: admissions ? admissions.filter((a) => a.status !== "ENROLLED" && a.status !== "REJECTED").length : null,
          complaints: complaints ? complaints.filter((c) => c.status !== "RESOLVED").length : null,
          ptm: meetingSlots
            ? meetingSlots.reduce((n, s) => n + (s.bookings || []).filter((b) => b.status === "BOOKED").length, 0)
            : null,
          unread: notif ? notif.unread : null,
        });
        setRoster(rosterData || null);
        setMeetings(meetingSlots ? meetingSlots.filter((s) => s.startAt && new Date(s.startAt).getTime() >= Date.now()).slice(0, 4) : []);
        setActivity(recent?.items || []);
      })
      .finally(() => { if (!cancelled) setAttentionLoading(false); });

    return () => { cancelled = true; };
  }, [role]);

  const attPct = stats?.attendanceToday.total
    ? Math.round((stats.attendanceToday.present / stats.attendanceToday.total) * 100)
    : 0;

  if (loading || !stats) return <LoadingScreen label="Loading dashboard…" />;

  // Quick actions follow the session's permissions (PRD §2.1) — sub-roles only
  // get shortcuts to modules they can actually open.
  const adminOnly = !role || role === "SCHOOL_ADMIN" || role === "BRANCH_ADMIN";
  const quickActions = [
    { href: "/dashboard/students", icon: GraduationCap, label: "New admission", show: adminOnly },
    { href: "/dashboard/exams", icon: ClipboardList, label: "Exams & results", show: adminOnly },
    { href: "/dashboard/fees", icon: Wallet, label: "Fee collection", show: adminOnly || role === "ACCOUNTANT" || role === "REGISTRAR" },
    { href: "/dashboard/id-cards", icon: BookOpen, label: "Print ID cards", show: adminOnly },
  ].filter((q) => q.show);

  // "Needs your attention" — one line per outstanding item that actually exists.
  // Colour restraint: only the three rows that genuinely need acting on carry a
  // tone (amber). The informational ones stay neutral, so the queue reads as a
  // calm to-do list instead of a row of alarms.
  const attentionRows = [
    { key: "fees", icon: Wallet, label: "Unpaid fees", count: stats.fees.unpaidCount, href: "/dashboard/fees", tone: "amber" as const },
    { key: "leaves", icon: CalendarX2, label: "Leave requests to review", count: attention.leaves, href: "/dashboard/leaves", tone: "slate" as const },
    { key: "periods", icon: Radio, label: "Periods not taken today", count: roster?.counts?.missing ?? null, href: "/dashboard/live-classes", tone: "amber" as const },
    { key: "admissions", icon: ClipboardList, label: "Admissions in progress", count: attention.admissions, href: "/dashboard/admissions", tone: "slate" as const },
    { key: "feedback", icon: Inbox, label: "Feedback to resolve", count: attention.complaints, href: "/dashboard/complaints", tone: "amber" as const },
    { key: "unread", icon: Bell, label: "Unread notifications", count: attention.unread, href: "/dashboard/notifications", tone: "slate" as const },
    { key: "ptm", icon: CalendarCheck, label: "PTM slots booked", count: attention.ptm, href: "/dashboard/meetings", tone: "slate" as const },
  ].filter((row) => typeof row.count === "number" && row.count > 0);

  // L2 — the operational pulse. Time-bound facts only; outstanding dues live in
  // the KPI row (L3) so the same figure is never emphasised twice.
  const pulse = [
    { key: "live", label: "Classes live now", value: roster ? roster.counts.inClass : "—", tone: "rose" as const },
    {
      key: "missing",
      label: "Periods not taken",
      value: roster ? roster.counts.missing : "—",
      tone: (roster && roster.counts.missing > 0 ? "amber" : "slate") as "amber" | "slate",
    },
    { key: "held", label: "Periods held", value: roster ? roster.counts.sessionsToday : "—", tone: "slate" as const },
    {
      key: "marked",
      label: "Attendance marked",
      value: stats.attendanceToday.total ? `${stats.attendanceToday.present}/${stats.attendanceToday.total}` : "—",
      tone: "slate" as const,
    },
  ];

  const kpis = [
    { key: "students", icon: GraduationCap, label: "Students", value: stats.counts.students, sub: `${stats.counts.marksCount} exam marks recorded`, tone: "slate" as const },
    { key: "teachers", icon: Users, label: "Teachers", value: stats.counts.teachers, sub: `${stats.counts.classes} classes`, tone: "slate" as const },
    { key: "classes", icon: BookOpen, label: "Classes", value: stats.counts.classes, sub: `${stats.counts.exams} exams`, tone: "slate" as const },
    { key: "collected", icon: Wallet, label: "Fees collected", value: fmtMoney(stats.fees.paidFees), sub: `of ${fmtMoney(stats.fees.totalFees)} billed`, tone: "emerald" as const },
    { key: "dues", icon: Scale, label: "Dues outstanding", value: fmtMoney(stats.fees.dueFees), sub: `${stats.fees.unpaidCount} unpaid`, tone: "amber" as const },
  ];

  return (
    <div>
      <PageHeader
        title="School Dashboard"
        subtitle={todayLabel ? `${todayLabel} · Operations overview` : "Operations overview"}
        actions={
          adminOnly ? (
            <Link href="/dashboard/admissions/new" className="btn btn-primary btn-sm">
              <ClipboardList size={15} /> New admission
            </Link>
          ) : undefined
        }
      />

      <div className="space-y-8">
        {/* L2 + L3 — one "Today" surface: a flat operational pulse over the
            school's standing totals, divided by hairlines. */}
        <section className="ss-surface">
          <div className="ss-section">
            <div className="min-w-0">
              <h3 className="ss-section-title">Today</h3>
              <p className="ss-section-sub">Live status and school totals</p>
            </div>
            <Link href="/dashboard/live-classes" className="btn btn-ghost btn-sm">
              <ArrowUpRight size={14} />
            </Link>
          </div>

          {/* the pulse: tinted, inline facts — not four KPI clones */}
          <div className="grid grid-cols-2 gap-px border-b border-slate-200 bg-slate-200 lg:grid-cols-4">
            {pulse.map((f) => (
              <div key={f.key} className="bg-slate-50">
                <PulseFact label={f.label} value={f.value} tone={f.tone} />
              </div>
            ))}
          </div>

          {/* the totals: one divided white row (reads /api/stats only) */}
          <div className="grid grid-cols-2 gap-px bg-slate-100 lg:grid-cols-5">
            {kpis.map((k) => (
              <div key={k.key} className="bg-white">
                <KpiCard bare icon={k.icon} label={k.label} value={k.value} sub={k.sub} tone={k.tone} />
              </div>
            ))}
            {/* keeps the last row from leaving a tinted gap below 5 columns */}
            <div aria-hidden className="bg-white lg:hidden" />
          </div>
        </section>

        {/* L4 — what needs attention + attendance, in one surface: the chart is
            the story, the queue is a tinted rail beside it. The tint is what
            keeps a short queue from reading as an unfinished white gap. */}
        <section className="ss-surface">
          <div className="grid gap-px bg-slate-200 lg:grid-cols-5">
            <div className="bg-white lg:col-span-3">
              <div className="ss-section">
                <div className="min-w-0">
                  <h3 className="ss-section-title">Attendance trend</h3>
                  <p className="ss-section-sub">Present per day, last 7 days</p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="text-[11px] font-medium text-slate-400">Today</span>
                  <span className="text-[13px] font-semibold tabular-nums text-slate-900">
                    {stats.attendanceToday.total ? `${attPct}%` : "—"}
                  </span>
                  <span className="hidden items-center gap-1.5 text-[11px] font-medium text-slate-500 sm:flex">
                    <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: "rgb(var(--brand))" }} /> Present
                  </span>
                </div>
              </div>
              {/* the line inherits currentColor, which is the tenant's brand — so
                  a green or pink school gets its own chart with no hardcoded hue */}
              <div className="h-56 px-2 py-3" style={{ color: "rgb(var(--brand))" }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={stats.trend} margin={{ top: 6, right: 12, left: -22, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" vertical={false} />
                    <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fontSize: 11, fill: "#94a3b8" }} axisLine={false} tickLine={false} allowDecimals={false} />
                    <Tooltip
                      cursor={{ stroke: "#e2e8f0" }}
                      contentStyle={{ borderRadius: 10, border: "1px solid #e2e8f0", fontSize: 12, boxShadow: "0 4px 12px rgb(15 23 42 / 0.06)" }}
                    />
                    <Area type="monotone" dataKey="present" name="Present" stroke="currentColor" strokeWidth={2} fill="currentColor" fillOpacity={0.1} />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="ss-rail bg-slate-50 lg:col-span-2">
              <div className="ss-section">
                <div className="min-w-0">
                  <h3 className="ss-section-title">Needs your attention</h3>
                  <p className="ss-section-sub">
                    {attentionLoading && !attentionRows.length
                      ? "Checking…"
                      : `${attentionRows.length} open item${attentionRows.length === 1 ? "" : "s"}`}
                  </p>
                </div>
              </div>
              {attentionRows.length ? (
                <div className="divide-y divide-slate-200/70">
                  {attentionRows.map((row) => (
                    <AttentionRow key={row.key} icon={row.icon} label={row.label} count={row.count as number} href={row.href} tone={row.tone} />
                  ))}
                </div>
              ) : (
                !attentionLoading && (
                  <EmptyState icon={CalendarCheck} title="Nothing needs your attention" description="No unpaid fees, pending reviews or uncovered periods right now." />
                )
              )}
            </div>
          </div>
        </section>

        {/* L5 — the operational feeds, in one surface */}
        <section className="ss-surface">
          <div className="grid gap-px bg-slate-100 lg:grid-cols-2">
            <div className="bg-white">
              <div className="ss-section">
                <div className="min-w-0">
                  <h3 className="ss-section-title">Today&apos;s schedule</h3>
                  <p className="ss-section-sub">
                    {roster ? `${roster.counts.sessionsToday} periods held · ${roster.counts.inClass} live now` : "Live classes"}
                  </p>
                </div>
                <Link href="/dashboard/live-classes" className="btn btn-ghost btn-sm"><ArrowUpRight size={14} /></Link>
              </div>
              {roster?.live?.length ? (
                <div className="divide-y divide-slate-100">
                  {roster.live.map((s) => (
                    <div key={s.id} className="ss-row">
                      <span className="ss-row-time w-11 shrink-0">{s.startedClock || "live"}</span>
                      <span aria-hidden className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-rose-500" />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-slate-800">
                          {s.subjectName ? `${s.subjectName} — ` : ""}{s.className}{s.sectionName ? ` / ${s.sectionName}` : ""}
                        </div>
                        <div className="truncate text-[11px] text-slate-500">
                          {s.teacherName}{s.periodLabel ? ` · ${s.periodLabel}` : ""}
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : roster ? (
                <p className="px-4 py-8 text-center text-sm text-slate-400">No class is in progress right now.</p>
              ) : (
                <p className="px-4 py-8 text-center text-sm text-slate-400">
                  Open <Link href="/dashboard/live-classes" className="font-semibold" style={{ color: "rgb(var(--brand))" }}>Live Classes</Link> to see who is teaching.
                </p>
              )}
            </div>

            <div className="bg-white">
              <div className="ss-section">
                <div className="min-w-0">
                  <h3 className="ss-section-title">Recent activity</h3>
                  <p className="ss-section-sub">Latest notifications</p>
                </div>
                <Link href="/dashboard/notifications" className="btn btn-ghost btn-sm"><ArrowUpRight size={14} /></Link>
              </div>
              {activity.length ? (
                <div className="divide-y divide-slate-100">
                  {activity.map((n) => {
                    const meta = notificationMeta(n.event);
                    const Icon = meta.icon;
                    const inner = (
                      <>
                        <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${meta.tone}`}><Icon size={13} /></span>
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold text-slate-800">{n.title}</div>
                          <div className="truncate text-[11px] text-slate-500">{n.body || meta.label}</div>
                        </div>
                        <span className="shrink-0 text-[10.5px] font-medium text-slate-400">{relativeTime(n.createdAt)}</span>
                      </>
                    );
                    return n.link ? (
                      <Link key={n.id} href={n.link} className="ss-row ss-row-hover">{inner}</Link>
                    ) : (
                      <div key={n.id} className="ss-row">{inner}</div>
                    );
                  })}
                </div>
              ) : (
                <p className="px-4 py-8 text-center text-sm text-slate-400">No notifications yet.</p>
              )}
            </div>
          </div>
        </section>

        {/* L6 — supporting information: quieter surfaces, smaller type. Each hugs
            its own content (items-start) so an empty panel never stretches into a
            void beside a full one. */}
        <div className="grid items-start gap-5 lg:grid-cols-3">
          <section className="ss-surface-quiet">
            <div className="ss-section ss-section-quiet">
              <h3 className="ss-section-title">Notice Board</h3>
              <Link href="/dashboard/notices" className="btn btn-ghost btn-sm"><ArrowUpRight size={14} /></Link>
            </div>
            {notices.length ? (
              <div className="divide-y divide-slate-100">
                {notices.map((n) => (
                  <div key={n.id} className="px-4 py-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="rounded px-1.5 py-px text-[10px] font-semibold uppercase tracking-[0.05em] text-slate-500 ring-1 ring-inset ring-slate-200">
                        {n.category}
                      </span>
                      <span className="text-[10.5px] text-slate-400">{fmtDate(n.date)}</span>
                    </div>
                    <div className="mt-1.5 text-[13px] font-medium text-slate-800">{n.title}</div>
                    <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-slate-500">{n.body}</p>
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-slate-400">No notices yet.</p>
            )}
          </section>

          <section className="ss-surface-quiet">
            <div className="ss-section ss-section-quiet">
              <h3 className="ss-section-title">Upcoming PTM</h3>
              <Link href="/dashboard/meetings" className="btn btn-ghost btn-sm"><ArrowUpRight size={14} /></Link>
            </div>
            {meetings.length ? (
              <div className="divide-y divide-slate-100">
                {meetings.map((s) => {
                  const booked = (s.bookings || []).filter((b) => b.status === "BOOKED").length;
                  const d = new Date(s.startAt);
                  const day = d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
                  const time = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
                  return (
                    <div key={s.id} className="ss-row">
                      <div className="w-14 shrink-0">
                        <div className="text-[11.5px] font-semibold leading-tight text-slate-700">{day}</div>
                        <div className="text-[10.5px] tabular-nums text-slate-400">{time}</div>
                      </div>
                      <span aria-hidden className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-slate-100 text-slate-500">
                        <CalendarCheck size={13} />
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-medium text-slate-800">{s.title || "Parent-teacher meeting"}</div>
                        <div className="truncate text-[11px] text-slate-500">{booked} booked</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="px-4 py-8 text-center text-sm text-slate-400">No upcoming slots.</p>
            )}
          </section>

          <section className="ss-surface-quiet">
            <div className="ss-section ss-section-quiet">
              <h3 className="ss-section-title">Parent engagement</h3>
              <span className="text-[10.5px] font-medium uppercase tracking-[0.08em] text-slate-400">Parents App</span>
            </div>
            <div className="p-4">
              <div className="flex items-center gap-2 text-[13px] font-medium text-slate-800">
                <Megaphone size={15} strokeWidth={1.75} style={{ color: "rgb(var(--brand))" }} /> Get families on the app
              </div>
              <p className="mt-1.5 text-[11.5px] leading-snug text-slate-500">
                Print the invite link or scan a child&apos;s ID card QR to sign a guardian in — no password needed.
              </p>
              <Link href="/dashboard/guardian-app" className="btn btn-secondary btn-sm mt-3.5">
                Open Parents App tools <ArrowRight size={14} />
              </Link>
            </div>
          </section>
        </div>

        {/* shortcuts (kept from the previous dashboard, now flat) */}
        {quickActions.length > 0 && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            {quickActions.map((q) => (
              <Link
                key={q.href}
                href={q.href}
                className="group flex items-center gap-2.5 rounded-lg border border-slate-200 bg-white px-3.5 py-3 text-slate-700 transition hover:border-slate-300 hover:bg-slate-50"
              >
                <q.icon size={16} strokeWidth={1.75} className="shrink-0" style={{ color: "rgb(var(--brand))" }} />
                <span className="text-[13px] font-medium">{q.label}</span>
                <ArrowRight size={15} className="ml-auto text-slate-300 transition group-hover:translate-x-0.5 group-hover:text-slate-500" />
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
