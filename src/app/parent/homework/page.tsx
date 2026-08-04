"use client";

import { useEffect, useState } from "react";
import { BookOpen, CheckCircle2, Clock, Paperclip } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, PageHeader, LoadingScreen, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

export default function ParentHomeworkPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<any[]>("/api/homework").then(setItems).finally(() => setLoading(false));
  }, []);

  const markDone = async (id: string) => {
    await api(`/api/homework/${id}/submit`, { method: "POST", body: JSON.stringify({ status: "SUBMITTED" }) });
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, myStatus: "SUBMITTED" } : x)));
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Homework" subtitle="Assignments for your child's class" />

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((h) => {
          const overdue = h.dueDate && new Date(h.dueDate) < new Date() && h.myStatus !== "SUBMITTED";
          return (
            <Card key={h.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <Badge tone="indigo">{h.subject?.name || "General"}</Badge>
                {h.myStatus === "SUBMITTED" ? (
                  <Badge tone="green"><CheckCircle2 size={12} /> Completed</Badge>
                ) : overdue ? (
                  <Badge tone="red"><Clock size={12} /> Overdue</Badge>
                ) : (
                  <Badge tone="amber"><Clock size={12} /> Pending</Badge>
                )}
              </div>
              <h3 className="mt-2 text-base font-extrabold text-slate-900">{h.title}</h3>
              <p className="mt-1 flex-1 text-sm text-slate-500">{h.description || "No description"}</p>
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
                <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold">{h.classRoom.name}</span>
                {h.dueDate && <span className={`ml-auto font-bold ${overdue ? "text-rose-600" : "text-amber-600"}`}>Due {fmtDate(h.dueDate)}</span>}
              </div>
              {h.attachmentUrl && (
                <a href={h.attachmentUrl} target="_blank" className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:underline">
                  <Paperclip size={13} /> View attachment
                </a>
              )}
              {h.myStatus !== "SUBMITTED" && (
                <button onClick={() => markDone(h.id)} className="btn btn-primary btn-sm mt-3 w-full">
                  <CheckCircle2 size={14} /> Mark as done
                </button>
              )}
            </Card>
          );
        })}
        {!items.length && <Card className="md:col-span-2 xl:col-span-3"><EmptyState icon={BookOpen} title="No homework assigned" description="Nothing to do — enjoy the free time!" /></Card>}
      </div>
    </div>
  );
}
