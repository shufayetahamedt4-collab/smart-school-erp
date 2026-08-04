"use client";

import { useEffect, useState } from "react";
import { Plus, BookOpen, Trash2 } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Field, TextInput, Modal, PageHeader, EmptyState, LoadingScreen, ErrorNote } from "@/components/ui";

interface ClassRow {
  id: string; name: string; order: number;
  _count: { students: number };
  sections: { id: string; name: string; _count: { students: number } }[];
}

export default function ClassesPage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [secOpen, setSecOpen] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [secName, setSecName] = useState("");

  const load = () => api<ClassRow[]>("/api/classes").then(setClasses).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const createClass = async () => {
    setError("");
    try {
      await api("/api/classes", { method: "POST", body: JSON.stringify({ name }) });
      setOpen(false);
      setName("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const createSection = async (classId: string) => {
    setError("");
    try {
      await api("/api/sections", { method: "POST", body: JSON.stringify({ classId, name: secName }) });
      setSecOpen(null);
      setSecName("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Classes & Sections" subtitle="Academic structure of your school" actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> New Class</button>} />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {classes.map((c) => (
          <Card key={c.id} className="overflow-hidden">
            <div className="flex items-center justify-between bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-3.5 text-white">
              <div className="flex items-center gap-2.5">
                <BookOpen size={17} />
                <span className="font-extrabold">{c.name}</span>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <span className="rounded-full bg-white/20 px-2 py-0.5 font-bold">{c._count.students} students</span>
                <button className="rounded p-1 hover:bg-white/20" onClick={() => { if (confirm(`Delete ${c.name}?`)) api(`/api/classes?id=${c.id}`, { method: "DELETE" }).then(load).catch((e) => setError(e.message)); }}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            <div className="divide-y divide-slate-100">
              {c.sections.map((s) => (
                <div key={s.id} className="flex items-center justify-between px-5 py-3 text-sm">
                  <div>
                    <span className="font-bold text-slate-700">Section {s.name}</span>
                    <span className="ml-2 text-xs text-slate-400">{s._count.students} students</span>
                  </div>
                  <button
                    className="rounded-lg p-1 text-slate-300 hover:bg-rose-50 hover:text-rose-500"
                    onClick={() => { if (confirm(`Delete section ${s.name}?`)) api(`/api/sections?id=${s.id}`, { method: "DELETE" }).then(load).catch((e) => setError(e.message)); }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button className="w-full px-5 py-2.5 text-left text-xs font-bold text-indigo-600 hover:bg-indigo-50" onClick={() => setSecOpen(c.id)}>
                + Add section
              </button>
            </div>
          </Card>
        ))}
        {!classes.length && <Card><EmptyState icon={BookOpen} title="No classes yet" description="Create your first class to start structuring the school." /></Card>}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New class">
        <div className="space-y-4">
          <Field label="Class name"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Class 6" /></Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createClass} disabled={!name}>Create</button>
          </div>
        </div>
      </Modal>

      <Modal open={!!secOpen} onClose={() => setSecOpen(null)} title="Add section">
        <div className="space-y-4">
          <Field label="Section name"><TextInput value={secName} onChange={(e) => setSecName(e.target.value)} placeholder="e.g. A" /></Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setSecOpen(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => createSection(secOpen!)} disabled={!secName}>Add</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
