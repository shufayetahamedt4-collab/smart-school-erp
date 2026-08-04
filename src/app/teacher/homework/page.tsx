"use client";

import { useEffect, useState } from "react";
import { Plus, BookOpen, Trash2, Paperclip, Check } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, Field, TextInput, Textarea, Select, Modal, PageHeader, EmptyState, LoadingScreen, ErrorNote } from "@/components/ui";
import { upload } from "@/lib/client";
import { fmtDate } from "@/lib/utils";

interface HW {
  id: string; title: string; description: string | null; attachmentUrl: string | null; dueDate: string | null; createdAt: string;
  subject: { name: string } | null; classRoom: { name: string }; section: { name: string } | null;
  submittedCount: number; totalStudents: number;
}

export default function TeacherHomeworkPage() {
  const [items, setItems] = useState<HW[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [subjects, setSubjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ classId: "", sectionId: "", subjectId: "", title: "", description: "", dueDate: "", attachmentUrl: "" });

  const load = () =>
    Promise.all([api<HW[]>("/api/homework?mine=1"), api<any[]>("/api/classes"), api<any[]>("/api/subjects")])
      .then(([h, c, s]) => { setItems(h); setClasses(c); setSubjects(s); })
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const create = async () => {
    setError("");
    try {
      await api("/api/homework", { method: "POST", body: JSON.stringify(form) });
      setOpen(false);
      setForm({ classId: "", sectionId: "", subjectId: "", title: "", description: "", dueDate: "", attachmentUrl: "" });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await upload("/api/uploads", fd);
      setForm((f) => ({ ...f, attachmentUrl: res.url }));
    } catch (err: any) {
      setError(err.message);
    } finally {
      setUploading(false);
    }
  };

  if (loading) return <LoadingScreen />;
  const cls = classes.find((c) => c.id === form.classId);

  return (
    <div>
      <PageHeader title="Homework" subtitle={`${items.length} assignments posted`} actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> New homework</button>} />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {items.map((h) => (
          <Card key={h.id} className="flex flex-col p-5">
            <div className="flex items-start justify-between gap-2">
              <Badge tone="indigo">{h.subject?.name || "General"}</Badge>
              <button
                className="rounded-lg p-1 text-slate-300 opacity-0 transition hover:bg-rose-50 hover:text-rose-500 group-hover:opacity-100"
                onClick={() => { if (confirm("Delete this homework?")) api(`/api/homework/${h.id}`, { method: "DELETE" }).then(load); }}
              >
                <Trash2 size={14} />
              </button>
            </div>
            <h3 className="mt-2 text-base font-extrabold text-slate-900">{h.title}</h3>
            <p className="mt-1 line-clamp-2 flex-1 text-sm text-slate-500">{h.description || "No description"}</p>
            <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
              <span className="rounded-md bg-slate-100 px-2 py-0.5 font-semibold">{h.classRoom.name}</span>
              {h.section && <span>Section {h.section.name}</span>}
              {h.dueDate && <span className="ml-auto font-bold text-amber-600">Due {fmtDate(h.dueDate)}</span>}
            </div>
            {h.attachmentUrl && (
              <a href={h.attachmentUrl} target="_blank" className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:underline">
                <Paperclip size={13} /> Attachment
              </a>
            )}
            <div className="mt-3 border-t border-slate-100 pt-3 text-xs text-slate-500">
              <span className="inline-flex items-center gap-1 font-semibold text-emerald-600"><Check size={13} /> {h.submittedCount} submissions</span>
              <span className="float-right">{fmtDate(h.createdAt)}</span>
            </div>
          </Card>
        ))}
        {!items.length && <Card className="md:col-span-2 xl:col-span-3"><EmptyState icon={BookOpen} title="No homework yet" description="Post homework with deadlines and attachments for your classes." /></Card>}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New homework" wide>
        <div className="space-y-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Class">
              <Select value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value, sectionId: "" })}>
                <option value="">Select…</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Section">
              <Select value={form.sectionId} onChange={(e) => setForm({ ...form, sectionId: e.target.value })}>
                <option value="">All sections</option>
                {cls?.sections.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
            <Field label="Subject">
              <Select value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
                <option value="">General</option>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Title *"><TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Description"><Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Field label="Deadline"><TextInput type="date" value={form.dueDate} onChange={(e) => setForm({ ...form, dueDate: e.target.value })} /></Field>
            <Field label="Attachment">
              <div className="flex items-center gap-2">
                <label className="btn btn-secondary cursor-pointer">
                  <Paperclip size={14} /> {uploading ? "Uploading…" : "Attach file"}
                  <input type="file" className="hidden" onChange={onFile} />
                </label>
                {form.attachmentUrl && <span className="truncate text-xs font-semibold text-indigo-600">{form.attachmentUrl.split("/").pop()}</span>}
              </div>
            </Field>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={create} disabled={!form.title || !form.classId}>Publish</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
