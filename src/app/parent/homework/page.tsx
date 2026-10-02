"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, CheckCircle2, Clock, Paperclip } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen } from "@/components/ui";
import { EmptyState, ErrorState, SectionHeader, Surface } from "@/components/app-ui";
import { fmtDate } from "@/lib/utils";

/**
 * Guardian → Homework.
 *
 * Same read (`/api/homework`) and the same `POST /api/homework/:id/submit` when
 * the guardian marks an item done. Presentation only: inset surfaces instead of
 * bordered cards, and the app bar names the screen.
 */
export default function ParentHomeworkPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<any[]>("/api/homework")
      .then(setItems)
      .catch((e: any) => setError(e?.message || "Couldn't load the homework."))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const markDone = async (id: string) => {
    await api(`/api/homework/${id}/submit`, { method: "POST", body: JSON.stringify({ status: "SUBMITTED" }) });
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, myStatus: "SUBMITTED" } : x)));
  };

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div>
      <SectionHeader title="Assignments for the class" className="ss-flush-top" />
      {items.length ? (
        <div className="space-y-3">
          {items.map((h) => {
            const overdue = h.dueDate && new Date(h.dueDate) < new Date() && h.myStatus !== "SUBMITTED";
            return (
              <Surface key={h.id}>
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
                <h3 className="mt-2 text-[15px] font-extrabold text-slate-900">{h.title}</h3>
                <p className="mt-1 text-[13px] text-slate-500">{h.description || "No description"}</p>
                <div className="mt-3 flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold">{h.classRoom?.name}</span>
                  {h.dueDate && (
                    <span className={`ml-auto font-bold ${overdue ? "text-rose-600" : "text-amber-600"}`}>Due {fmtDate(h.dueDate)}</span>
                  )}
                </div>
                {h.attachmentUrl && (
                  <a href={h.attachmentUrl} target="_blank" rel="noreferrer" className="mt-2 inline-flex items-center gap-1.5 text-[12px] font-semibold text-indigo-600 hover:underline">
                    <Paperclip size={13} /> View attachment
                  </a>
                )}
                {h.myStatus !== "SUBMITTED" && (
                  <button onClick={() => markDone(h.id)} className="btn btn-primary mt-3 w-full min-h-11">
                    <CheckCircle2 size={14} /> Mark as done
                  </button>
                )}
              </Surface>
            );
          })}
        </div>
      ) : (
        <EmptyState icon={BookOpen} title="No homework assigned" hint="Nothing to do — enjoy the free time!" />
      )}
    </div>
  );
}
