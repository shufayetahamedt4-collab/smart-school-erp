"use client";

import { useEffect, useState } from "react";
import { CalendarX2, Check, X } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen, EmptyState, statusTone, prettyStatus } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §9.2 — Leave Management: admin approval workflow. */
export default function LeavesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = () => api<any[]>("/api/leave-requests").then(setItems).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const decide = async (id: string, decision: "APPROVED" | "REJECTED") => {
    setBusy(true);
    try {
      await api("/api/leave-requests", { method: "PATCH", body: JSON.stringify({ id, decision }) });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Leave Requests" subtitle="Student (via guardian) and teacher leave — admin approval (PRD §9.2)" />
      <Card>
        <CardHeader title="All requests" subtitle={`${items.filter((i) => i.status === "PENDING").length} pending`} />
        {items.length ? (
          <div className="divide-y divide-slate-100">
            {items.map((l) => (
              <div key={l.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div>
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-slate-800">
                      {l.type === "TEACHER" ? l.teacher?.name || "Teacher" : l.student?.name || "Student"}
                    </p>
                    <Badge tone={l.type === "TEACHER" ? "violet" : "blue"}>{l.type}</Badge>
                    <Badge tone={statusTone(l.status)}>{prettyStatus(l.status)}</Badge>
                  </div>
                  <p className="mt-0.5 text-xs text-slate-500">
                    {fmtDate(l.fromDate)} → {fmtDate(l.toDate)} · {l.reason}
                  </p>
                  {l.approver && <p className="text-[11px] text-slate-400">Decided by {l.approver.name}</p>}
                </div>
                {l.status === "PENDING" && (
                  <div className="flex gap-2">
                    <button className="btn btn-primary btn-sm" onClick={() => decide(l.id, "APPROVED")} disabled={busy}><Check size={13} /> Approve</button>
                    <button className="btn btn-ghost btn-sm" onClick={() => decide(l.id, "REJECTED")} disabled={busy}><X size={13} /> Reject</button>
                  </div>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={CalendarX2} title="No leave requests" description="Teacher and student leave applications appear here." />
        )}
      </Card>
    </div>
  );
}
