"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { BookOpen, CalendarCheck, FileText, GraduationCap, LayoutGrid, MessageSquare, Wallet } from "lucide-react";
import { api } from "@/lib/client";
import { LoadingScreen } from "@/components/ui";
import { useMe } from "@/components/Shell";
import {
  EmptyState,
  ErrorState,
  ListCard,
  ListRow,
  OverviewTile,
  QuickAction,
  SectionHeader,
  Surface,
} from "@/components/app-ui";
import { fmtDate, fmtMoney, initials } from "@/lib/utils";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  BarChart,
  Bar,
  Cell,
} from "recharts";

/**
 * Guardian Home.
 *
 * Same reads as before — one `/api/stats` and the latest three notices — and the
 * same destinations (each quick action and notice opens the page it always did).
 * What changed is the shape: a greeting header, a pastel overview grid, inset
 * list rows and quick actions, matching the Teacher App. The two charts and the
 * child banner are unchanged in substance. Also added: an error state, so a
 * failed read no longer leaves the page on a spinner that never resolves.
 */
export default function ParentDashboard() {
  const { me } = useMe();
  const [stats, setStats] = useState<any>(null);
  const [notices, setNotices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError(null);
    Promise.all([api<any>("/api/stats"), api<any[]>("/api/notices?limit=3")])
      .then(([s, n]) => {
        setStats(s);
        setNotices(n);
      })
      .catch((e: any) => setError(e?.message || "Couldn't load your dashboard."))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (me) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me]);

  if (loading) return <LoadingScreen label="Loading parent dashboard…" />;
  if (error || !stats || !me) return <ErrorState message={error || undefined} onRetry={load} />;

  const student = me.student;
  const BAR_COLORS = ["#4f46e5", "#7c3aed", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444"];

  return (
    <div>
      {/* ------------------------------- greeting ------------------------------- */}
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-sky-50 text-[13px] font-extrabold text-sky-700">
          {student?.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={student.photoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(me.user?.name || student?.name || "") || <GraduationCap size={18} />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] text-slate-500">Welcome back</p>
          <p className="truncate text-[17px] font-extrabold leading-tight text-slate-900">
            {me.user?.name || "Guardian"}
          </p>
          <p className="truncate text-[12px] text-slate-400">
            {student ? `${student.name} · ${student.classRoom?.name || ""}${student.section ? ` / ${student.section.name}` : ""}` : "Guardian view"}
          </p>
        </div>
      </div>

      {/* --------------------------- today's overview --------------------------- */}
      <SectionHeader title="Today's Overview" />
      <div className="ss-tiles grid grid-cols-2 gap-3">
        <OverviewTile
          icon={CalendarCheck}
          tone="emerald"
          value={`${stats.attendance.rate}%`}
          label="Attendance"
          sub={`${stats.attendance.present} of ${stats.attendance.total} days`}
        />
        <OverviewTile
          icon={BookOpen}
          tone="indigo"
          value={stats.homeworks}
          label="Homework"
          sub="assigned to the class"
        />
        {/* One login covers the whole household (§5.4), so this figure is the
            family's — exactly the rows /parent/fees lists, for every child. */}
        <OverviewTile
          icon={Wallet}
          tone={stats.fees.due > 0 ? "rose" : "emerald"}
          value={fmtMoney(stats.fees.due)}
          label="Fees due"
          sub={`across all children · ${stats.fees.total} records`}
        />
        <OverviewTile
          icon={MessageSquare}
          tone="violet"
          value={stats.remarks}
          label="Teacher remarks"
          sub="daily remarks received"
        />
      </div>

      {/* ---------------------------- quick actions ---------------------------- */}
      <SectionHeader title="Quick Actions" />
      <div className="ss-quick grid grid-cols-4 gap-2.5">
        <QuickAction href="/parent/attendance" icon={CalendarCheck} tone="indigo" label="Attendance" />
        <QuickAction href="/parent/homework" icon={BookOpen} tone="emerald" label="Homework" />
        <QuickAction href="/parent/fees" icon={Wallet} tone="amber" label="Fees" />
        <QuickAction href="/parent/results" icon={FileText} tone="violet" label="Results" />
      </div>

      {/* ------------------------------- charts -------------------------------- */}
      <SectionHeader title="Progress" />
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Surface>
          <div className="mb-2">
            <p className="text-[13px] font-extrabold text-slate-800">Attendance trend</p>
            <p className="text-[11px] text-slate-400">Monthly attendance rate (last 6 months)</p>
          </div>
          <div className="h-52">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.trend} margin={{ top: 5, right: 10, left: -25, bottom: 0 }}>
                <defs>
                  <linearGradient id="att" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <Tooltip
                  contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
                  formatter={(v: any) => [`${v}%`, "Attendance"]}
                />
                <Area type="monotone" dataKey="rate" stroke="#10b981" strokeWidth={2.5} fill="url(#att)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Surface>

        <Surface>
          <div className="mb-2">
            <p className="text-[13px] font-extrabold text-slate-800">Subject performance</p>
            <p className="text-[11px] text-slate-400">From published exam results</p>
          </div>
          <div className="h-52">
            {stats.subjectPerf?.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.subjectPerf} margin={{ top: 5, right: 10, left: -25, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="subject" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }}
                    formatter={(v: any) => [`${v}%`, "Score"]}
                  />
                  <Bar dataKey="pct" radius={[6, 6, 0, 0]}>
                    {stats.subjectPerf.map((_: any, i: number) => (
                      <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">No published results yet.</div>
            )}
          </div>
        </Surface>
      </div>

      {/* ------------------------------ notice board --------------------------- */}
      <SectionHeader title="Notice Board" actionHref="/parent/notices" actionLabel="View all" />
      {notices.length ? (
        <ListCard>
          {notices.map((n) => (
            <ListRow
              key={n.id}
              href="/parent/notices"
              icon={LayoutGrid}
              tone="sky"
              title={n.title}
              subtitle={`${n.category || "General"} · ${fmtDate(n.date, true)}`}
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState icon={LayoutGrid} title="No notices yet" hint="School announcements will appear here." />
      )}

      {/* Clears the fixed phone tab bar so the last row is never tapped by accident. */}
      <div className="h-2" aria-hidden />
    </div>
  );
}
