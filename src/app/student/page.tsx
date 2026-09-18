"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarCheck, BookOpen, Wallet, FileText, IdCard, ClipboardList } from "lucide-react";
import { api } from "@/lib/client";
import { StatCard, Card, CardHeader, Badge, PageHeader, LoadingScreen, EmptyState, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate, initials } from "@/lib/utils";
import { useMe } from "@/components/Shell";

/**
 * PRD §7.2 — Student self-service panel (new console, limited permissions).
 * Own attendance/results/homework, homework submission, class materials.
 * The school decides which classes get login access (user.active flag).
 */
export default function StudentDashboard() {
  const { me } = useMe();
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!me) return;
    api<any>("/api/student/me").then(setData).catch(() => null).finally(() => setLoading(false));
  }, [me]);

  if (loading || !me) return <LoadingScreen label="Loading student dashboard…" />;

  if (!data) {
    return (
      <div>
        <PageHeader title="Student Portal" />
        <EmptyState
          icon={IdCard}
          title="No student profile linked"
          description="Your school must link your login to a student profile. Ask at the front desk."
        />
      </div>
    );
  }

  const s = data.student;

  return (
    <div>
      <PageHeader title="Student Portal" subtitle={`${s.name} · ${s.admissionNo}`} />

      <Card className="mb-6 overflow-hidden">
        <div className="flex flex-wrap items-center gap-5 bg-gradient-to-r from-emerald-600 to-teal-600 p-6 text-white">
          {s.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={s.photoUrl} alt="" className="h-16 w-16 rounded-2xl object-cover ring-4 ring-white/20" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-white/15 text-xl font-black">{initials(s.name)}</div>
          )}
          <div className="min-w-0 flex-1">
            <div className="text-xs font-bold uppercase tracking-widest text-emerald-200">My dashboard</div>
            <h2 className="text-xl font-black">{s.name}</h2>
            <div className="mt-0.5 text-xs text-emerald-200">
              {data.attendance.total ? `${data.attendance.rate}% attendance · ${data.attendance.present}/${data.attendance.total} days` : "No attendance yet"} · Due {fmtMoney(data.fees.due)}
            </div>
          </div>
          <Link href="/print/id-card/[id]" as={`/print/id-card/${s.id}`} className="btn bg-white/15 text-white hover:bg-white/25">
            <IdCard size={15} /> My ID card
          </Link>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={CalendarCheck} label="Attendance" value={`${data.attendance.rate}%`} sub={`${data.attendance.present} of ${data.attendance.total} days`} tone="emerald" />
        <StatCard icon={BookOpen} label="Homework" value={data.homeworks.length} sub="assigned to my class" tone="indigo" />
        <StatCard icon={Wallet} label="Fees due" value={fmtMoney(data.fees.due)} sub={`${data.fees.items.length} records`} tone={data.fees.due > 0 ? "rose" : "emerald"} />
        <StatCard icon={FileText} label="Remarks" value={data.remarks.length} sub="teacher remarks" tone="violet" />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Recent homework" subtitle="Submit files from the homework page" />
          {data.homeworks.length ? (
            <div className="divide-y divide-slate-100">
              {data.homeworks.slice(0, 6).map((h: any) => (
                <div key={h.id} className="flex items-center justify-between px-5 py-3">
                  <div>
                    <p className="text-sm font-bold text-slate-800">{h.title}</p>
                    <p className="text-xs text-slate-500">{h.subject?.name || "—"} · {h.dueDate ? fmtDate(h.dueDate) : "no due date"}</p>
                  </div>
                  <ClipboardList size={15} className="text-slate-300" />
                </div>
              ))}
            </div>
          ) : (
            <EmptyState icon={BookOpen} title="No homework" description="Assignments for your class appear here." />
          )}
        </Card>

        <Card>
          <CardHeader title="Recent attendance" />
          {data.attendance.recent.length ? (
            <div className="flex flex-wrap gap-2 p-4">
              {data.attendance.recent.map((a: any) => (
                <Badge key={a.id} tone={statusTone(a.status)}>
                  {new Date(a.date).toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} · {prettyStatus(a.status)}
                </Badge>
              ))}
            </div>
          ) : (
            <EmptyState icon={CalendarCheck} title="No attendance records" />
          )}
        </Card>
      </div>
    </div>
  );
}
