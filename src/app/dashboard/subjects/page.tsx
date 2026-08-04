"use client";

import { useEffect, useState } from "react";
import { Plus, BookOpen, Trash2 } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Field, TextInput, Modal, PageHeader, EmptyState, LoadingScreen, ErrorNote } from "@/components/ui";

interface Subject { id: string; name: string; code: string | null; _count: { assignments: number; homeworks: number } }

export default function SubjectsPage() {
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");

  const load = () => api<Subject[]>("/api/subjects").then(setSubjects).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setError("");
    try {
      await api("/api/subjects", { method: "POST", body: JSON.stringify({ name, code }) });
      setOpen(false);
      setName("");
      setCode("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Subjects" subtitle={`${subjects.length} subjects`} actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> New Subject</button>} />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {subjects.map((s) => (
          <Card key={s.id} className="group p-5">
            <div className="flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><BookOpen size={18} /></div>
              <button
                className="rounded-lg p-1.5 text-slate-300 opacity-0 transition group-hover:opacity-100 hover:bg-rose-50 hover:text-rose-500"
                onClick={() => { if (confirm(`Delete subject ${s.name}?`)) api(`/api/subjects?id=${s.id}`, { method: "DELETE" }).then(load).catch((e) => setError(e.message)); }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="mt-3 font-bold text-slate-800">{s.name}</div>
            <div className="text-xs text-slate-400">Code: {s.code || "—"}</div>
            <div className="mt-2 flex gap-3 text-[11px] text-slate-400">
              <span>{s._count.assignments} assignments</span>
              <span>{s._count.homeworks} homeworks</span>
            </div>
          </Card>
        ))}
        {!subjects.length && <Card><EmptyState icon={BookOpen} title="No subjects yet" description="Add subjects to start building routines and exams." /></Card>}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New subject">
        <div className="space-y-4">
          <Field label="Subject name *"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Mathematics" /></Field>
          <Field label="Code"><TextInput value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. MATH" /></Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={create} disabled={!name}>Create</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
