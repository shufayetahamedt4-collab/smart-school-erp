"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, Users, GraduationCap, Wallet, TrendingUp, ArrowRight, School } from "lucide-react";
import { api, qs } from "@/lib/client";
import { StatCard, Card, CardHeader, Badge, LoadingScreen, PageHeader, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate } from "@/lib/utils";

interface SchoolRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  createdAt: string;
  _count: { students: number; teachers: number; users: number };
  feeSetting?: { monthlyFee: number } | null;
}

export default function AdminDashboard() {
  const [schools, setSchools] = useState<SchoolRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<SchoolRow[]>("/api/schools").then(setSchools).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingScreen label="Loading platform…" />;

  const active = schools.filter((s) => s.status !== "SUSPENDED");
  const totalStudents = schools.reduce((a, s) => a + s._count.students, 0);
  const totalTeachers = schools.reduce((a, s) => a + s._count.teachers, 0);
  const monthlyRevenue = active.reduce((a, s) => a + (Number(s.feeSetting?.monthlyFee || 0) * s._count.students), 0);

  return (
    <div>
      <PageHeader title="Platform Dashboard" subtitle="Multi-tenant overview, revenue and school health" />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={Building2} label="Total Schools" value={schools.length} sub={`${active.length} active · ${schools.length - active.length} suspended`} tone="indigo" />
        <StatCard icon={GraduationCap} label="Students" value={totalStudents.toLocaleString()} sub="across all schools" tone="sky" />
        <StatCard icon={Users} label="Teachers" value={totalTeachers.toLocaleString()} sub="across all schools" tone="violet" />
        <StatCard icon={Wallet} label="Est. MRR" value={fmtMoney(monthlyRevenue)} sub="based on monthly fees × students" tone="emerald" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader
            title="Schools"
            subtitle="Manage subscriptions and school accounts"
            action={
              <Link href="/admin/schools" className="btn btn-secondary btn-sm">
                Manage <ArrowRight size={13} />
              </Link>
            }
          />
          <div className="divide-y divide-slate-100">
            {schools.slice(0, 6).map((s) => (
              <Link key={s.id} href={`/admin/schools/${s.id}`} className="flex items-center gap-4 px-5 py-3.5 transition hover:bg-slate-50">
                <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600">
                  <School size={18} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-bold text-slate-800">{s.name}</div>
                  <div className="text-xs text-slate-400">
                    {s._count.students} students · {s._count.teachers} teachers · joined {fmtDate(s.createdAt)}
                  </div>
                </div>
                <Badge tone={s.status === "SUSPENDED" ? "red" : s.status === "TRIAL" ? "amber" : "green"}>{prettyStatus(s.status)}</Badge>
                <span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{s.plan}</span>
              </Link>
            ))}
            {!schools.length && <div className="px-5 py-10 text-center text-sm text-slate-400">No schools yet — create your first one.</div>}
          </div>
        </Card>

        <Card>
          <CardHeader title="Quick Actions" />
          <div className="space-y-2 p-4">
            <Link href="/admin/schools" className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50">
              <Building2 size={16} className="text-indigo-600" /> Onboard a new school
            </Link>
            <Link href="/admin/settings" className="flex items-center gap-3 rounded-xl border border-slate-200 px-4 py-3 text-sm font-semibold text-slate-700 transition hover:border-indigo-300 hover:bg-indigo-50">
              <TrendingUp size={16} className="text-indigo-600" /> Global settings
            </Link>
          </div>
        </Card>
      </div>
    </div>
  );
}
