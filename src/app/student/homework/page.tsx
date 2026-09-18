"use client";

import { useEffect, useState } from "react";
import { BookOpen, CheckCircle2, Clock, Paperclip, Upload, Send } from "lucide-react";
import { api, upload } from "@/lib/client";
import { Card, Badge, PageHeader, LoadingScreen, EmptyState, ErrorNote } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/**
 * PRD §7.2 — homework submission (student self-service).
 * Students view their class homework and submit files (PDF/images) which
 * teachers review in the homework console.
 */

export default function StudentHomeworkPage() {
  const [items, setItems] = useState<any[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = () => api<any[]>("/api/homework").then(setItems).catch((e) => setError(e.message));
  useEffect(() => { load(); }, []);

  const submit = async (id: string, file: File | null) => {
    setBusyId(id);
    setError("");
    try {
      let fileUrl: string | undefined;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        const res = await upload("/api/uploads", fd);
        fileUrl = res.url;
      }
      await api(`/api/homework/${id}/submit`, {
        method: "POST",
        body: JSON.stringify({ status: "SUBMITTED", ...(fileUrl ? { fileUrl } : {}) }),
      });
      setItems((xs) => (xs || []).map((x) => (x.id === id ? { ...x, myStatus: "SUBMITTED", _fileUrl: fileUrl } : x)));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusyId(null);
    }
  };

  if (!items && !error) return <LoadingScreen label="Loading homework…" />;

  return (
    <div>
      <PageHeader title="Homework" subtitle="Assignments for my class — submit files (PRD §7.2)" />
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {(items || []).map((h) => {
          const overdue = h.dueDate && new Date(h.dueDate) < new Date() && h.myStatus !== "SUBMITTED";
          return (
            <Card key={h.id} className="flex flex-col p-5">
              <div className="flex items-start justify-between gap-2">
                <Badge tone="emerald">{h.subject?.name || "General"}</Badge>
                {h.myStatus === "SUBMITTED" ? (
                  <Badge tone="green"><CheckCircle2 size={12} /> Submitted</Badge>
                ) : overdue ? (
                  <Badge tone="red"><Clock size={12} /> Overdue</Badge>
                ) : (
                  <Badge tone="amber"><Clock size={12} /> Pending</Badge>
                )}
              </div>
              <h3 className="mt-2 text-base font-extrabold text-slate-900">{h.title}</h3>
              <p className="mt-1 flex-1 text-sm text-slate-500">{h.description || "No description"}</p>
              <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
                {h.dueDate && <span className={`ml-auto font-bold ${overdue ? "text-rose-600" : "text-amber-600"}`}>Due {fmtDate(h.dueDate)}</span>}
              </div>
              {h.attachmentUrl && (
                <a href={h.attachmentUrl} target="_blank" className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:underline">
                  <Paperclip size={13} /> View attachment
                </a>
              )}
              {h.myStatus === "SUBMITTED" && h._fileUrl && (
                <a href={h._fileUrl} target="_blank" className="mt-1 inline-flex items-center gap-1.5 text-xs font-semibold text-emerald-600 hover:underline">
                  <Paperclip size={13} /> My submitted file
                </a>
              )}
              {h.myStatus !== "SUBMITTED" && (
                <label className="btn btn-primary btn-sm mt-3 w-full cursor-pointer">
                  {busyId === h.id ? "Submitting…" : <><Upload size={14} /> Submit homework</>}
                  <input
                    type="file"
                    accept=".jpg,.jpeg,.png,.webp,.gif,.pdf,.doc,.docx,.txt"
                    className="hidden"
                    disabled={busyId === h.id}
                    onChange={(e) => e.target.files?.[0] && submit(h.id, e.target.files[0])}
                  />
                </label>
              )}
            </Card>
          );
        })}
        {items && !items.length && (
          <Card className="md:col-span-2 xl:col-span-3"><EmptyState icon={BookOpen} title="No homework assigned" description="Assignments for your class appear here." /></Card>
        )}
      </div>
    </div>
  );
}
