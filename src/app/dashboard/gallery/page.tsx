"use client";

import { useEffect, useState } from "react";
import { Images, Plus, Trash2, ExternalLink } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Field, TextInput, Select, PageHeader, LoadingScreen, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §7.1 — Photo/Video Gallery (emotional-connect feature). */
export default function GalleryPage() {
  const [items, setItems] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<any>({ kind: "PHOTO" });
  const [busy, setBusy] = useState(false);

  const load = () => api<any[]>("/api/gallery").then(setItems).finally(() => setLoading(false));
  useEffect(() => {
    load();
    api<any[]>("/api/classes").then(setClasses).catch(() => null);
  }, []);

  const add = async () => {
    if (!form.title || !form.url) return;
    setBusy(true);
    try {
      await api("/api/gallery", { method: "POST", body: JSON.stringify(form) });
      setForm({ kind: "PHOTO" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Remove this item?")) return;
    await api(`/api/gallery?id=${id}`, { method: "DELETE" });
    await load();
  };

  if (loading) return <LoadingScreen />;

  return (
    <div className="space-y-4">
      <PageHeader title="Gallery" subtitle="School events & class activities shared with guardians (PRD §7.1)" />

      <Card className="p-4">
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-5">
          <Field label="Title"><TextInput value={form.title || ""} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Type"><Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}><option value="PHOTO">Photo</option><option value="VIDEO">Video</option></Select></Field>
          <Field label="Image/video URL"><TextInput value={form.url || ""} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" /></Field>
          <Field label="Class (optional)"><Select value={form.classId || ""} onChange={(e) => setForm({ ...form, classId: e.target.value || undefined })}><option value="">Whole school</option>{classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <button className="btn btn-primary" onClick={add} disabled={busy || !form.title || !form.url}><Plus size={15} /> Add</button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Gallery items" subtitle={`${items.length} items`} />
        {items.length ? (
          <div className="grid grid-cols-1 gap-4 p-4 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((g) => (
              <div key={g.id} className="overflow-hidden rounded-xl border border-slate-200">
                {g.kind === "PHOTO" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={g.url} alt={g.title} className="h-40 w-full object-cover" />
                ) : (
                  <div className="flex h-40 items-center justify-center bg-slate-900 text-white"><ExternalLink size={28} /></div>
                )}
                <div className="flex items-center justify-between px-3 py-2">
                  <div>
                    <p className="text-xs font-bold text-slate-800">{g.title}</p>
                    <p className="text-[10px] text-slate-400">{g.classRoom?.name || "All classes"} · {fmtDate(g.date)}</p>
                  </div>
                  <button onClick={() => remove(g.id)} className="rounded-lg p-1.5 text-slate-300 hover:bg-rose-50 hover:text-rose-600"><Trash2 size={15} /></button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={Images} title="No gallery items" description="Add photos and videos of school events." />
        )}
      </Card>
    </div>
  );
}
