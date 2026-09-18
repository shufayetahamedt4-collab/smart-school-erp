"use client";

import { useEffect, useState } from "react";
import { FolderOpen, Upload, Eye, Download, GitBranch, ExternalLink, Trash2 } from "lucide-react";
import { api, upload } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, Select, Textarea, PageHeader, LoadingScreen, EmptyState, ErrorNote } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §6.2 — Teacher panel "Resources": upload with mandatory Class→Subject→Section→Semester tagging. */
export default function TeacherResourcesPage() {
  const [items, setItems] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [subjects, setSubjects] = useState<any[]>([]);
  const [sections, setSections] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<any>({ kind: "PDF", semester: "" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = () => api<any[]>("/api/resources").then(setItems).finally(() => setLoading(false));
  useEffect(() => {
    load();
    api<any[]>("/api/classes").then(setClasses).catch(() => null);
    api<any[]>("/api/subjects").then(setSubjects).catch(() => null);
    api<any[]>("/api/sections").then(setSections).catch(() => null);
  }, []);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      let url: string | undefined;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        const up = await upload("/api/uploads", fd);
        url = up.url || up.downloadUrl || up;
      }
      await api("/api/resources", {
        method: "POST",
        body: JSON.stringify({ ...form, url, kind: url ? form.kind : "LINK", linkUrl: form.linkUrl }),
      });
      setForm({ kind: "PDF", semester: "" });
      setFile(null);
      await load();
    } catch (e: any) {
      setError(e?.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const track = async (id: string, action: "view" | "download") => {
    await api("/api/resources", { method: "PATCH", body: JSON.stringify({ id, action }) });
  };

  const newVersion = async (r: any) => {
    const url = prompt("New file/video link URL (leave empty to reuse current file):", r.linkUrl || "");
    if (url === null) return;
    await api("/api/resources", { method: "PUT", body: JSON.stringify({ supersedeId: r.id, linkUrl: url || undefined }) });
    await load();
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this resource?")) return;
    await api(`/api/resources?id=${id}`, { method: "DELETE" });
    await load();
  };

  if (loading) return <LoadingScreen />;

  return (
    <div className="space-y-4">
      <PageHeader title="My Materials" subtitle="Upload tagged resources — auto-shared with the right class (PRD §6.2)" />

      <Card className="p-4">
        <p className="mb-3 text-xs font-bold uppercase tracking-wide text-slate-400">New upload — tagging is mandatory (§6.2)</p>
        {error && <div className="mb-3"><ErrorNote message={error} /></div>}
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <Field label="Title *"><TextInput value={form.title || ""} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Class *">
            <Select value={form.classId || ""} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
              <option value="">Select…</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Subject *">
            <Select value={form.subjectId || ""} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
              <option value="">Select…</option>
              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Section">
            <Select value={form.sectionId || ""} onChange={(e) => setForm({ ...form, sectionId: e.target.value || undefined })}>
              <option value="">All sections</option>
              {sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Semester"><TextInput value={form.semester || ""} onChange={(e) => setForm({ ...form, semester: e.target.value })} placeholder="e.g. 1st" /></Field>
          <Field label="Type">
            <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
              <option value="PDF">PDF notes</option><option value="EBOOK">E-book</option><option value="COMIC">Comic/manga</option>
              <option value="VIDEO">Video</option><option value="SLIDES">Slides</option><option value="WORKSHEET">Worksheet</option><option value="LINK">Link only</option>
            </Select>
          </Field>
          <Field label="Video link (YouTube/Vimeo)" className="sm:col-span-2">
            <TextInput value={form.linkUrl || ""} onChange={(e) => setForm({ ...form, linkUrl: e.target.value })} placeholder="https://youtube.com/…" />
          </Field>
          <Field label="File" hint="Max 10 MB, validated by the uploads route">
            <input type="file" className="text-xs" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </Field>
        </div>
        <div className="mt-3 flex justify-end">
          <button className="btn btn-primary" onClick={submit} disabled={busy || !form.title || !form.classId || !form.subjectId || (!file && !form.linkUrl)}>
            <Upload size={15} /> {busy ? "Uploading…" : "Upload resource"}
          </button>
        </div>
      </Card>

      <Card>
        <CardHeader title="My uploads" subtitle={`${items.length} resources`} />
        {items.length ? (
          <div className="divide-y divide-slate-100">
            {items.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div>
                  <p className="text-sm font-bold text-slate-800">{r.title} <Badge tone="slate" className="ml-1">v{r.version}</Badge></p>
                  <p className="text-xs text-slate-500">{r.classRoom?.name} · {r.subject?.name}{r.semester ? ` · ${r.semester}` : ""} · {fmtDate(r.createdAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <span className="flex items-center gap-1 text-xs text-slate-500"><Eye size={12} /> {r.views || 0}</span>
                  <span className="flex items-center gap-1 text-xs text-slate-500"><Download size={12} /> {r.downloads || 0}</span>
                  {r.linkUrl && <a href={r.linkUrl} target="_blank" rel="noreferrer" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><ExternalLink size={14} /></a>}
                  <button onClick={() => newVersion(r)} title="Upload new version" className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100"><GitBranch size={14} /></button>
                  <button onClick={() => remove(r.id)} title="Delete" className="rounded-lg p-1.5 text-slate-400 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={14} /></button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={FolderOpen} title="No uploads yet" description="Your tagged materials will appear here with view/download analytics." />
        )}
      </Card>
    </div>
  );
}
