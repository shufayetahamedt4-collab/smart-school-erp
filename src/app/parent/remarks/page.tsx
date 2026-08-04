"use client";

import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, PageHeader, LoadingScreen, EmptyState, statusTone, prettyStatus } from "@/components/ui";
import { useMe } from "@/components/Shell";

export default function ParentRemarksPage() {
  const { me } = useMe();
  const [remarks, setRemarks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!me?.student) return;
    api(`/api/students/${me.student.id}`)
      .then((d: any) => setRemarks(d.remarks))
      .finally(() => setLoading(false));
  }, [me]);

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Teacher Remarks" subtitle="Daily feedback from teachers" />

      <div className="space-y-4">
        {remarks.length ? remarks.map((r) => (
          <Card key={r.id} className="flex items-start gap-4 p-5">
            <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl text-white ${r.rating === "EXCELLENT" ? "bg-emerald-500" : r.rating === "GOOD" ? "bg-sky-500" : r.rating === "AVERAGE" ? "bg-amber-500" : "bg-rose-500"}`}>
              <MessageSquare size={17} />
            </div>
            <div className="flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={statusTone(r.rating)}>{prettyStatus(r.rating)}</Badge>
                <span className="text-xs text-slate-400">{new Date(r.date).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })}</span>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{r.note || "No note was added."}</p>
              <p className="mt-1 text-[11px] font-semibold text-slate-400">— {r.teacher?.user?.name}</p>
            </div>
          </Card>
        )) : (
          <Card><EmptyState icon={MessageSquare} title="No remarks yet" description="Teachers haven't posted remarks for your child yet." /></Card>
        )}
      </div>
    </div>
  );
}
