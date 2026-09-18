"use client";

import { useEffect, useState } from "react";
import { Inbox } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Select, PageHeader, LoadingScreen, EmptyState, statusTone, prettyStatus } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §7.1 — Complaint/Feedback Box with tracking status (admin side). */
export default function ComplaintsPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = () => api<any[]>("/api/complaints").then(setItems).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const setStatus = async (id: string, status: string) => {
    await api("/api/complaints", { method: "PATCH", body: JSON.stringify({ id, status }) });
    await load();
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Feedback Box" subtitle="Complaints and opinions from guardians, with tracking (PRD §7.1)" />
      <Card>
        <CardHeader title="All feedback" subtitle={`${items.filter((i) => i.status !== "RESOLVED").length} unresolved`} />
        {items.length ? (
          <div className="divide-y divide-slate-100">
            {items.map((c) => (
              <div key={c.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-bold text-slate-800">{c.subject}</p>
                    <Badge tone={statusTone(c.status)}>{prettyStatus(c.status)}</Badge>
                  </div>
                  <Select className="!w-36" value={c.status} onChange={(e) => setStatus(c.id, e.target.value)}>
                    <option>OPEN</option><option>IN_REVIEW</option><option>RESOLVED</option><option>DISMISSED</option>
                  </Select>
                </div>
                <p className="mt-1 text-sm text-slate-600">{c.message}</p>
                <p className="mt-1 text-[11px] text-slate-400">
                  {c.guardian?.name || "Guardian"}{c.student ? ` · re: ${c.student.name}` : ""} · {fmtDate(c.createdAt, true)}
                  {c.resolution ? ` · Resolution: ${c.resolution}` : ""}
                </p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={Inbox} title="No feedback yet" description="Guardian complaints and opinions appear here." />
        )}
      </Card>
    </div>
  );
}
