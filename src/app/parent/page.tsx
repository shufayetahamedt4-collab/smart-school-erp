"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarCheck, BookOpen, Wallet, MessageSquare, QrCode, FileText, ArrowRight } from "lucide-react";
import { api } from "@/lib/client";
import { StatCard, Card, CardHeader, Badge, PageHeader, LoadingScreen } from "@/components/ui";
import { fmtMoney, initials } from "@/lib/utils";
import { useMe } from "@/components/Shell";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, BarChart, Bar, Cell } from "recharts";

export default function ParentDashboard() {
  const { me } = useMe();
  const [stats, setStats] = useState<any>(null);
  const [notices, setNotices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!me) return;
    Promise.all([api<any>("/api/stats"), api<any[]>("/api/notices?limit=3")])
      .then(([s, n]) => { setStats(s); setNotices(n); })
      .finally(() => setLoading(false));
  }, [me]);

  if (loading || !stats || !me) return <LoadingScreen label="Loading parent dashboard…" />;
  const student = me.student;

  const BAR_COLORS = ["#4f46e5", "#7c3aed", "#0ea5e9", "#10b981", "#f59e0b", "#ef4444"];

  return (
    <div>
      <PageHeader
        title="Parent Dashboard"
        subtitle={student ? `${student.name} · ${student.classRoom?.name || ""}${student.section ? ` / ${student.section.name}` : ""}` : "Guardian view"}
        actions={
          <Link href="/parent/results" className="btn btn-primary btn-sm">
            <FileText size={14} /> Report cards
          </Link>
        }
      />

      {/* student banner */}
      <Card className="mb-6 overflow-hidden">
        <div className="flex flex-wrap items-center gap-5 bg-gradient-to-r from-indigo-600 to-violet-600 p-6 text-white">
          {student?.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={student.photoUrl} alt="" className="h-16 w-16 rounded-2xl object-cover ring-4 ring-white/20" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/15 text-xl font-black">{student ? initials(student.name) : "?"}</div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-bold uppercase tracking-widest text-indigo-200">Today&apos;s status</div>
            <h2 className="text-xl font-black">{student?.name || "Your child"}</h2>
            <div className="mt-0.5 text-xs text-indigo-200">
              {student?.admissionNo} · {stats.attendance.total ? `${stats.attendance.rate}% attendance · ${stats.attendance.present}/${stats.attendance.total} days present` : "No attendance recorded yet"}
            </div>
          </div>
          <div className="flex gap-2">
            <Link href="/parent/homework" className="btn bg-white/15 text-white hover:bg-white/25"><BookOpen size={15} /> Homework</Link>
            <Link href="/parent/fees" className="btn bg-white/15 text-white hover:bg-white/25"><Wallet size={15} /> Fees</Link>
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={CalendarCheck} label="Attendance" value={`${stats.attendance.rate}%`} sub={`${stats.attendance.present} of ${stats.attendance.total} days`} tone="emerald" />
        <StatCard icon={BookOpen} label="Homework" value={stats.homeworks} sub="assigned to your child's class" tone="indigo" />
        <StatCard icon={Wallet} label="Fees due" value={fmtMoney(stats.fees.due)} sub={`${stats.fees.total} fee records`} tone={stats.fees.due > 0 ? "rose" : "emerald"} />
        <StatCard icon={MessageSquare} label="Teacher remarks" value={stats.remarks} sub="daily remarks received" tone="violet" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Attendance trend" subtitle="Monthly attendance rate (last 6 months)" />
          <div className="h-56 p-4">
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
                <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(v: any) => [`${v}%`, "Attendance"]} />
                <Area type="monotone" dataKey="rate" stroke="#10b981" strokeWidth={2.5} fill="url(#att)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        <Card>
          <CardHeader title="Subject performance" subtitle="From published exam results" />
          <div className="h-56 p-4">
            {stats.subjectPerf?.length ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={stats.subjectPerf} margin={{ top: 5, right: 10, left: -25, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                  <XAxis dataKey="subject" tick={{ fontSize: 10, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                  <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }} formatter={(v: any) => [`${v}%`, "Score"]} />
                  <Bar dataKey="pct" radius={[6, 6, 0, 0]}>
                    {stats.subjectPerf.map((_: any, i: number) => <Cell key={i} fill={BAR_COLORS[i % BAR_COLORS.length]} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-slate-400">No published results yet.</div>
            )}
          </div>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Notice board" subtitle="Latest from school" action={<Link href="/parent/notices" className="btn btn-ghost btn-sm">All</Link>} />
          <div className="space-y-3 p-4">
            {notices.map((n) => (
              <div key={n.id} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                <div className="flex items-center justify-between">
                  <Badge tone="indigo">{n.category}</Badge>
                  <span className="text-[10px] text-slate-400">{new Date(n.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}</span>
                </div>
                <div className="mt-1.5 text-sm font-bold text-slate-800">{n.title}</div>
              </div>
            ))}
            {!notices.length && <p className="py-4 text-center text-sm text-slate-400">No notices yet.</p>}
          </div>
        </Card>

        <Card>
          <CardHeader title="Quick actions" />
          <div className="grid grid-cols-1 gap-2 p-4">
            {[
              { href: "/parent/attendance", icon: CalendarCheck, label: "View attendance history" },
              { href: "/parent/remarks", icon: MessageSquare, label: "Teacher remarks" },
              { href: "/parent/results", icon: FileText, label: "Exam results & report cards" },
              { href: "/parent/messages", icon: MessageSquare, label: "Message a teacher" },
            ].map((a) => (
              <Link key={a.href} href={a.href} className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50">
                <a.icon size={16} className="text-indigo-600" /> {a.label}
                <ArrowRight size={14} className="ml-auto text-slate-300" />
              </Link>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
