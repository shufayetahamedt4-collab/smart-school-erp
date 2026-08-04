"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ClipboardList, BookOpen, FileText, Users, ArrowRight, GraduationCap } from "lucide-react";
import { api } from "@/lib/client";
import { StatCard, Card, PageHeader, LoadingScreen } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

export default function TeacherDashboard() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api("/api/stats").then(setStats).finally(() => setLoading(false));
  }, []);

  if (loading || !stats) return <LoadingScreen label="Loading teacher dashboard…" />;

  const totalStudents = stats.myClasses.reduce((a: number, c: any) => a + c._count.students, 0);

  return (
    <div>
      <PageHeader title="Teacher Dashboard" subtitle="Your classes, homework and today's work" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={GraduationCap} label="My classes" value={stats.myClasses.length} sub={`${totalStudents} students`} tone="indigo" />
        <StatCard icon={Users} label="Assignments" value={stats.assignments.length} sub="class & subject duties" tone="sky" />
        <StatCard icon={BookOpen} label="Homeworks" value={stats.homeworks.length} sub="posted this term" tone="violet" />
        <StatCard icon={ClipboardList} label="Today's marks" value={stats.attendanceToday} sub="attendance records submitted" tone="emerald" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card className="p-5">
          <h3 className="text-sm font-bold text-slate-800">My classes</h3>
          <div className="mt-3 space-y-3">
            {stats.myClasses.map((c: any) => (
              <div key={c.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
                <div>
                  <div className="text-sm font-bold text-slate-800">{c.name}</div>
                  <div className="text-xs text-slate-400">
                    {c._count.students} students · sections {c.sections.map((s: any) => s.name).join(", ") || "—"}
                  </div>
                </div>
                <Link href="/teacher/attendance" className="btn btn-secondary btn-sm">
                  Attendance <ArrowRight size={13} />
                </Link>
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-5">
          <h3 className="text-sm font-bold text-slate-800">Recent homework</h3>
          <div className="mt-3 space-y-3">
            {stats.homeworks.length ? stats.homeworks.map((h: any) => (
              <div key={h.id} className="flex items-center justify-between rounded-xl border border-slate-100 bg-slate-50/60 px-4 py-3">
                <div>
                  <div className="text-sm font-bold text-slate-800">{h.title}</div>
                  <div className="text-xs text-slate-400">Due {fmtDate(h.dueDate)}</div>
                </div>
                <Link href="/teacher/homework" className="btn btn-ghost btn-sm text-indigo-600">Manage</Link>
              </div>
            )) : <p className="text-sm text-slate-400">No homework posted yet.</p>}
          </div>
        </Card>
      </div>

      <div className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-4">
        {[
          { href: "/teacher/attendance", icon: ClipboardList, label: "Take Attendance", tone: "from-indigo-500 to-indigo-600" },
          { href: "/teacher/remarks", icon: FileText, label: "Daily Remarks", tone: "from-violet-500 to-violet-600" },
          { href: "/teacher/homework", icon: BookOpen, label: "Homework", tone: "from-emerald-500 to-emerald-600" },
          { href: "/teacher/marks", icon: GraduationCap, label: "Enter Marks", tone: "from-amber-500 to-amber-600" },
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
