"use client";

import { useEffect, useState } from "react";
import { CalendarCheck } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen, EmptyState, statusTone, prettyStatus } from "@/components/ui";
import { useMe } from "@/components/Shell";

export default function ParentAttendancePage() {
  const { me } = useMe();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!me?.student) return;
    api(`/api/students/${me.student.id}`)
      .then((d: any) => setRows([...d.attendance].reverse()))
      .finally(() => setLoading(false));
  }, [me]);

  if (loading) return <LoadingScreen />;

  const present = rows.filter((r) => r.status === "PRESENT" || r.status === "LATE").length;
  const rate = rows.length ? Math.round((present / rows.length) * 100) : 0;

  return (
    <div>
      <PageHeader title="Attendance" subtitle={`${rate}% attendance across ${rows.length} school days`} />

      <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {["PRESENT", "ABSENT", "LATE", "LEAVE"].map((st) => {
          const count = rows.filter((r) => r.status === st).length;
          return (
            <Card key={st} className="p-4 text-center">
              <div className="text-2xl font-black text-slate-800">{count}</div>
              <div className="text-[11px] font-bold uppercase text-slate-400">{st}</div>
            </Card>
          );
        })}
      </div>

      <Card>
        <CardHeader title="History" subtitle="Most recent first" />
        {rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr><th className="th">Date</th><th className="th">Status</th><th className="th">Remark</th></tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="tr-hover">
                    <td className="td font-semibold">{new Date(r.date).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}</td>
                    <td className="td"><Badge tone={statusTone(r.status)}>{prettyStatus(r.status)}</Badge></td>
                    <td className="td">{r.remark || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={CalendarCheck} title="No attendance records yet" />
        )}
      </Card>
    </div>
  );
}
