"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus, FileText, Eye, Trash2 } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, Field, TextInput, Select, Modal, PageHeader, EmptyState, LoadingScreen, ErrorNote } from "@/components/ui";
import { fmtDate, todayISO } from "@/lib/utils";

interface Exam { id: string; name: string; year: number; published: boolean; startDate: string | null; endDate: string | null; classRoom: { name: string }; section: { name: string } | null; _count: { marks: number } }
interface ClassRow { id: string; name: string; sections: { id: string; name: string }[] }

export default function ExamsPage() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", classId: "", sectionId: "", startDate: "", endDate: "" });

  const load = () => Promise.all([api<Exam[]>("/api/exams"), api<ClassRow[]>("/api/classes")]).then(([e, c]) => { setExams(e); setClasses(c); }).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setError("");
    try {
      await api("/api/exams", { method: "POST", body: JSON.stringify({ ...form, year: new Date().getFullYear() }) });
      setOpen(false);
      setForm({ name: "", classId: "", sectionId: "", startDate: "", endDate: "" });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading) return <LoadingScreen />;
  const selClass = classes.find((c) => c.id === form.classId);

  return (
    <div>
      <PageHeader title="Exams & Results" subtitle={`${exams.length} exams`} actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> New Exam</button>} />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {exams.map((e) => (
          <Card key={e.id} className="overflow-hidden">
            <div className="border-b border-slate-100 p-5">
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-violet-50 text-violet-600"><FileText size={18} /></div>
                  <div>
                    <div className="font-extrabold text-slate-800">{e.name}</div>
                    <div className="text-xs text-slate-400">{e.classRoom.name}{e.section ? ` · Section ${e.section.name}` : ""} · {e.year}</div>
                  </div>
                </div>
                <Badge tone={e.published ? "green" : "amber"}>{e.published ? "Published" : "Draft"}</Badge>
              </div>
              <div className="mt-3 flex items-center gap-4 text-xs text-slate-400">
                <span>{e._count.marks} marks entered</span>
                {e.startDate && <span>{fmtDate(e.startDate)} → {fmtDate(e.endDate)}</span>}
              </div>
            </div>
            <div className="flex gap-2 px-5 py-3">
              <Link href={`/dashboard/exams/${e.id}`} className="btn btn-primary btn-sm flex-1"><Eye size={14} /> Open</Link>
              <button
                className="btn btn-ghost btn-sm text-rose-500 hover:bg-rose-50"
                onClick={() => { if (confirm(`Delete exam ${e.name}? This removes all its marks.`)) api(`/api/exams/${e.id}`, { method: "DELETE" }).then(load); }}
              >
                <Trash2 size={14} />
              </button>
            </div>
          </Card>
        ))}
        {!exams.length && <Card><EmptyState icon={FileText} title="No exams yet" description="Create an exam to start entering marks and publishing results." /></Card>}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New exam">
        <div className="space-y-4">
          <Field label="Exam name *"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. First Term Examination 2026" /></Field>
          <Field label="Class">
            <Select value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value, sectionId: "" })}>
              <option value="">Select…</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Section">
            <Select value={form.sectionId} onChange={(e) => setForm({ ...form, sectionId: e.target.value })}>
              <option value="">All sections</option>
              {selClass?.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start date"><TextInput type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label="End date"><TextInput type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={create} disabled={!form.name || !form.classId}>Create exam</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
