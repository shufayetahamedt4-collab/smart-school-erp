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

/* Presentation only: a fixed accent rotation so neighbouring class cards read as
   a set (1 indigo, 2 violet, 3 sky, 4 emerald, then repeat). Keyed off the array
   index, so no data, order or expression changes. */
const TONE_CYCLE = ["indigo", "violet", "sky", "emerald"] as const;

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
    <div className="ss-classpage">
      <PageHeader icon={BookOpen} title="Classes & Sections" subtitle="Academic structure of your school" actions={<button className="btn btn-primary ss-class-cta" onClick={() => setOpen(true)}><Plus size={16} /> New Class</button>} />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {classes.map((c, i) => {
          const tone = TONE_CYCLE[i % TONE_CYCLE.length];
          return (
          <Card key={c.id} className={`ss-classcard ss-ct-${tone}`}>
            <div className="ss-classhead">
              <div className="ss-class-id">
                <span className="ss-class-tile"><BookOpen size={17} /></span>
                <span className="ss-class-name">{c.name}</span>
              </div>
              <div className="ss-class-meta">
                <span className="ss-class-pill">{c._count.students} students</span>
                <button className="ss-class-del" onClick={() => { if (confirm(`Delete ${c.name}?`)) api(`/api/classes?id=${c.id}`, { method: "DELETE" }).then(load).catch((e) => setError(e.message)); }}>
                  <Trash2 size={13} />
                </button>
              </div>
            </div>
            <div className="ss-sectlist">
              {c.sections.map((s) => (
                <div key={s.id} className="ss-sectrow">
                  <div className="ss-sect-left">
                    <span className="ss-sect-dot" aria-hidden />
                    <span className="ss-sect-name">Section {s.name}</span>
                    <span className="ss-sect-count">{s._count.students} students</span>
                  </div>
                  <button
                    className="ss-sect-del"
                    onClick={() => { if (confirm(`Delete section ${s.name}?`)) api(`/api/sections?id=${s.id}`, { method: "DELETE" }).then(load).catch((e) => setError(e.message)); }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              ))}
              <button className="ss-add-sect" onClick={() => setSecOpen(c.id)}>
                <span className="ss-add-sect-plus">+</span> Add section
              </button>
            </div>
          </Card>
          );
        })}
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
