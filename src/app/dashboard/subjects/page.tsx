"use client";

import { useEffect, useState } from "react";
import { Plus, BookOpen, Trash2 } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Field, TextInput, Modal, PageHeader, EmptyState, LoadingScreen, ErrorNote } from "@/components/ui";

interface Subject { id: string; name: string; code: string | null; _count: { assignments: number; homeworks: number } }

/* Presentation only: a fixed accent rotation so the subject grid reads as a set
   (indigo, violet, sky, emerald, amber, rose, then repeat). Keyed off the array
   index, so no data, order or expression changes. */
const TONE_CYCLE = ["indigo", "violet", "sky", "emerald", "amber", "rose"] as const;

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
    <div className="ss-subjectpage">
      <PageHeader icon={BookOpen} title="Subjects" subtitle={`${subjects.length} subjects`} actions={<button className="btn btn-primary ss-subject-cta" onClick={() => setOpen(true)}><Plus size={16} /> New Subject</button>} />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {subjects.map((s, i) => {
          const tone = TONE_CYCLE[i % TONE_CYCLE.length];
          return (
          <Card key={s.id} className={`group ss-subjectcard ss-st-${tone}`}>
            <div className="flex items-start justify-between">
              <div className="ss-subject-tile"><BookOpen size={18} /></div>
              <button
                className="ss-subject-del opacity-0 transition group-hover:opacity-100"
                onClick={() => { if (confirm(`Delete subject ${s.name}?`)) api(`/api/subjects?id=${s.id}`, { method: "DELETE" }).then(load).catch((e) => setError(e.message)); }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <div className="ss-subject-name">{s.name}</div>
            <div className="ss-subject-code">Code: {s.code || "—"}</div>
            <div className="ss-subject-meta">
              <span className="ss-subject-pill ss-subject-pill-a">{s._count.assignments} assignments</span>
              <span className="ss-subject-pill ss-subject-pill-h">{s._count.homeworks} homeworks</span>
            </div>
          </Card>
          );
        })}
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
