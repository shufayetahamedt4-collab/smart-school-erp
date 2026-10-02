"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, BookOpen, Trash2, Paperclip, Check } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, Field, TextInput, Textarea, Select, LoadingScreen, ErrorNote } from "@/components/ui";
import { EmptyState, ErrorState, IconTile, ListCard } from "@/components/app-ui";
import { MobileSheet } from "@/components/MobileSheet";
import { upload } from "@/lib/client";
import { fmtDate } from "@/lib/utils";

interface HW {
  id: string; title: string; description: string | null; attachmentUrl: string | null; dueDate: string | null; createdAt: string;
  subject: { name: string } | null; classRoom: { name: string }; section: { name: string } | null;
  submittedCount: number; totalStudents: number;
}

/**
 * Teacher homework.
 *
 * Same three reads, same POST body, same DELETE, same upload, and the same
 * create sheet with the same gates. The card grid became hairline-separated rows
 * on one surface, and the delete control — previously `opacity-0` with no `group`
 * parent, so it was invisible AND unhoverable on a phone — is now a real,
 * permanently visible 44px target.
 *
 * Also added: a read-failure state; `load` previously had no `catch`.
 */
export default function TeacherHomeworkPage() {
  const [items, setItems] = useState<HW[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [subjects, setSubjects] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({ classId: "", sectionId: "", subjectId: "", title: "", description: "", dueDate: "", attachmentUrl: "" });

  const load = useCallback(
    () =>
      Promise.all([api<HW[]>("/api/homework?mine=1"), api<any[]>("/api/classes"), api<any[]>("/api/subjects")])
        .then(([h, c, s]) => {
          setItems(h);
          setClasses(c);
          setSubjects(s);
          setLoadError("");
        })
        .catch((e: any) => setLoadError(e?.message || "Couldn't load your homework."))
        .finally(() => setLoading(false)),
    [],
  );

  useEffect(() => {
    load();
  }, [load]);

  const retry = () => {
    setLoading(true);
    load();
  };

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
  // Only when there is nothing on screen to show: a failed refresh after a
  // successful create must not replace the list the user just added to.
  if (loadError && !items.length) return <ErrorState message={loadError} onRetry={retry} />;
  const cls = classes.find((c) => c.id === form.classId);

  return (
    <div className="ss-hwpage">
      {/* First block: no leading mt — the app's own top padding is the rhythm. */}
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2 className="text-[13px] font-extrabold uppercase tracking-[0.05em] text-slate-500">
          {items.length} posted
        </h2>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <Plus size={15} /> New homework
        </button>
      </div>

      {error && (
        <div className="mb-3">
          <ErrorNote message={error} />
        </div>
      )}

      {items.length ? (
        <ListCard>
          {items.map((h) => (
            <li key={h.id} className="px-3.5 py-3">
              <div className="flex items-start gap-3">
                <IconTile icon={BookOpen} tone="violet" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="break-words text-[14px] font-bold leading-snug text-slate-800">{h.title}</span>
                    <Badge tone="indigo">{h.subject?.name || "General"}</Badge>
                  </div>
                  <p className="mt-0.5 line-clamp-2 text-[12px] leading-snug text-slate-400">{h.description || "No description"}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11.5px] text-slate-400">
                    <span>{h.classRoom.name}</span>
                    {h.section && <span>· Section {h.section.name}</span>}
                    {h.dueDate && <span className="font-bold text-amber-600">Due {fmtDate(h.dueDate)}</span>}
                  </div>
                  {h.attachmentUrl && (
                    <a
                      href={h.attachmentUrl}
                      target="_blank"
                      className="mt-1.5 inline-flex items-center gap-1.5 py-1 text-[12px] font-semibold text-indigo-600"
                    >
                      <Paperclip size={13} /> Attachment
                    </a>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-[11.5px] text-slate-400">
                    <span className="inline-flex items-center gap-1 font-semibold text-emerald-600">
                      <Check size={13} /> {h.submittedCount} submissions
                    </span>
                    <span>· {fmtDate(h.createdAt)}</span>
                  </div>
                </div>
                <button
                  className="ss-hwdel flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                  aria-label="Delete homework"
                  title="Delete"
                  onClick={() => {
                    if (confirm("Delete this homework?")) api(`/api/homework/${h.id}`, { method: "DELETE" }).then(load);
                  }}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            </li>
          ))}
        </ListCard>
      ) : (
        <EmptyState
          icon={BookOpen}
          title="No homework yet"
          hint="Post homework with deadlines and attachments for your classes."
        />
      )}

      <MobileSheet open={open} onClose={() => setOpen(false)} title="New homework" wide>
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
      </MobileSheet>
    </div>
  );
}
