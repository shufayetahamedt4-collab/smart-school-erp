"use client";

import { useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, PageHeader, LoadingScreen, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

const TONES: Record<string, any> = { GENERAL: "slate", HOLIDAY: "red", EXAM: "violet", MEETING: "blue", EVENT: "emerald", PICNIC: "amber" };

export default function ParentNoticesPage() {
  const [notices, setNotices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<any[]>("/api/notices").then(setNotices).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Notice Board" subtitle="School announcements" />

      <div className="space-y-4">
        {notices.length ? notices.map((n) => (
          <Card key={n.id} className="border-l-4 p-5" >
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={TONES[n.category] || "slate"}>{n.category}</Badge>
              <span className="text-[11px] text-slate-400">{fmtDate(n.date, true)}</span>
            </div>
            <h3 className="mt-2 text-base font-extrabold text-slate-900">{n.title}</h3>
            <p className="mt-1 text-sm leading-relaxed text-slate-600">{n.body}</p>
          </Card>
        )) : (
          <Card><EmptyState icon={Megaphone} title="No notices yet" /></Card>
        )}
      </div>
    </div>
  );
}
