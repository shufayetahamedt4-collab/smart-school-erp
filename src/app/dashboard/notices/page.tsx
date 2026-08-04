"use client";

import { useEffect, useState } from "react";
import { Plus, Megaphone, Trash2 } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, Field, TextInput, Textarea, Select, Modal, PageHeader, EmptyState, LoadingScreen, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

interface Notice { id: string; title: string; body: string; category: string; date: string; school: { name: string } }

const CATEGORIES = ["GENERAL", "HOLIDAY", "EXAM", "MEETING", "EVENT", "PICNIC"];
const CATEGORY_TONES: Record<string, any> = { GENERAL: "slate", HOLIDAY: "red", EXAM: "violet", MEETING: "blue", EVENT: "emerald", PICNIC: "amber" };

export default function NoticesPage() {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ title: "", body: "", category: "GENERAL", date: new Date().toISOString().slice(0, 10) });

  const load = () => api<Notice[]>("/api/notices").then(setNotices).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const create = async () => {
    setError("");
    try {
      await api("/api/notices", { method: "POST", body: JSON.stringify(form) });
      setOpen(false);
      setForm({ title: "", body: "", category: "GENERAL", date: new Date().toISOString().slice(0, 10) });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Notice Board" subtitle="Publish updates for guardians" actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> New Notice</button>} />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="space-y-4">
        {notices.map((n) => (
          <Card key={n.id} className="p-5">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={CATEGORY_TONES[n.category] || "slate"}>{prettyStatus(n.category)}</Badge>
                  <span className="text-[11px] text-slate-400">{fmtDate(n.date, true)}</span>
                </div>
                <h3 className="mt-2 text-base font-extrabold text-slate-900">{n.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-slate-600">{n.body}</p>
              </div>
              <button
                className="rounded-lg p-2 text-slate-300 transition hover:bg-rose-50 hover:text-rose-500"
                onClick={() => { if (confirm("Delete this notice?")) api(`/api/notices?id=${n.id}`, { method: "DELETE" }).then(load); }}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </Card>
        ))}
        {!notices.length && <Card><EmptyState icon={Megaphone} title="No notices yet" description="Publish holidays, exam routines, meetings and events." action={<button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}><Plus size={14} /> New notice</button>} /></Card>}
      </div>

      <Modal open={open} onClose={() => setOpen(false)} title="New notice">
        <div className="space-y-4">
          <Field label="Title *"><TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Winter vacation starts 24 Dec" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Category">
              <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map((c) => <option key={c}>{c}</option>)}
              </Select>
            </Field>
            <Field label="Date"><TextInput type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></Field>
          </div>
          <Field label="Details"><Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={4} /></Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={create} disabled={!form.title}>Publish</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
