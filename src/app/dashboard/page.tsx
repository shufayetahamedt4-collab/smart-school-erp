"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  GraduationCap, Users, BookOpen, Wallet, TrendingUp, Megaphone, FileText,
  ArrowRight, ArrowUpRight, ClipboardList,
} from "lucide-react";
import { api } from "@/lib/client";
import { StatCard, Card, CardHeader, Badge, LoadingScreen, PageHeader } from "@/components/ui";
import { fmtMoney, fmtDate } from "@/lib/utils";
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";

interface Stats {
  counts: { students: number; teachers: number; classes: number; exams: number; notices: number; marksCount: number };
  fees: { totalFees: number; paidFees: number; dueFees: number; unpaidCount: number };
  attendanceToday: { present: number; absent: number; total: number };
  trend: { label: string; present: number; absent: number; total: number }[];
}

interface Notice {
  id: string; title: string; body: string; category: string; date: string;
}

export default function SchoolDashboard() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([api<Stats>("/api/stats"), api<Notice[]>("/api/notices?limit=5")])
      .then(([s, n]) => { setStats(s); setNotices(n); })
      .finally(() => setLoading(false));
  }, []);

  if (loading || !stats) return <LoadingScreen label="Loading dashboard…" />;

  const attPct = stats.attendanceToday.total ? Math.round((stats.attendanceToday.present / stats.attendanceToday.total) * 100) : 0;

  return (
    <div>
      <PageHeader title="School Dashboard" subtitle="Overview of your school at a glance" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={GraduationCap} label="Students" value={stats.counts.students} sub={`${stats.counts.marksCount} exam marks recorded`} tone="indigo" />
        <StatCard icon={Users} label="Teachers" value={stats.counts.teachers} sub={`${stats.counts.classes} classes`} tone="sky" />
        <StatCard icon={ClipboardList} label="Today's attendance" value={stats.attendanceToday.total ? `${attPct}%` : "—"} sub={`${stats.attendanceToday.present} present · ${stats.attendanceToday.absent} absent`} tone={attPct >= 80 ? "emerald" : "amber"} />
        <StatCard icon={Wallet} label="Fees collected" value={fmtMoney(stats.fees.paidFees)} sub={`${fmtMoney(stats.fees.dueFees)} still due`} tone="violet" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* attendance trend */}
        <Card className="lg:col-span-2">
          <CardHeader title="Attendance trend" subtitle="Last 7 days" action={<Badge tone="green">PRESENT</Badge>} />
          <div className="h-64 p-4">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={stats.trend} margin={{ top: 5, right: 10, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="present" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#4f46e5" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#4f46e5" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" vertical={false} />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 11, fill: "#64748b" }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ borderRadius: 12, border: "1px solid #e2e8f0", fontSize: 12 }} />
                <Area type="monotone" dataKey="present" name="Present" stroke="#4f46e5" strokeWidth={2.5} fill="url(#present)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </Card>

        {/* notices */}
        <Card>
          <CardHeader
            title="Notice Board"
            subtitle="Latest updates"
            action={<Link href="/dashboard/notices" className="btn btn-ghost btn-sm"><ArrowUpRight size={14} /></Link>}
          />
          <div className="max-h-72 space-y-3 overflow-y-auto p-4">
            {notices.map((n) => (
              <div key={n.id} className="rounded-xl border border-slate-100 bg-slate-50/60 p-3">
                <div className="flex items-center justify-between gap-2">
                  <span className="badge ring-1 ring-inset ring-indigo-600/20 bg-indigo-50 text-indigo-700">{n.category}</span>
                  <span className="text-[10px] text-slate-400">{fmtDate(n.date)}</span>
                </div>
                <div className="mt-1.5 text-sm font-bold text-slate-800">{n.title}</div>
                <p className="mt-0.5 line-clamp-2 text-xs text-slate-500">{n.body}</p>
              </div>
            ))}
            {!notices.length && <p className="py-6 text-center text-sm text-slate-400">No notices yet.</p>}
          </div>
        </Card>
      </div>

      {/* quick actions */}
      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { href: "/dashboard/students", icon: GraduationCap, label: "New Admission", tone: "from-indigo-500 to-indigo-600" },
          { href: "/dashboard/exams", icon: FileText, label: "Exams & Results", tone: "from-violet-500 to-violet-600" },
          { href: "/dashboard/fees", icon: Wallet, label: "Fee Collection", tone: "from-emerald-500 to-emerald-600" },
          { href: "/dashboard/id-cards", icon: BookOpen, label: "Print ID Cards", tone: "from-amber-500 to-amber-600" },
        ].map((q) => (
          <Link key={q.href} href={q.href} className={`group flex items-center gap-3 rounded-2xl bg-gradient-to-br ${q.tone} px-4 py-4 text-white shadow-lg transition hover:-translate-y-0.5`}>
            <q.icon size={20} />
            <div className="text-sm font-bold">{q.label}</div>
            <ArrowRight size={15} className="ml-auto opacity-60 transition group-hover:translate-x-0.5 group-hover:opacity-100" />
          </Link>
        ))}
      </div>
    </div>
  );
}
