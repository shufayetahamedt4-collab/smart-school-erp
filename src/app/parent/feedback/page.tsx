"use client";

import { useEffect, useState } from "react";
import { Inbox, Send } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, Select, Textarea, PageHeader, LoadingScreen, EmptyState, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §7.1 — Complaint/Feedback Box (guardian side, with tracking status). */
export default function ParentFeedbackPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<any>({ category: "GENERAL" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = () => api<any[]>("/api/complaints").then(setItems).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/complaints", { method: "POST", body: JSON.stringify(form) });
      setForm({ category: "GENERAL" });
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not submit");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <div className="space-y-4">
      <PageHeader title="Complaints & Feedback" subtitle="Reach the school admin directly — track the status (PRD §7.1)" />

      <Card className="p-4">
        {error && <div className="mb-3"><ErrorNote message={error} /></div>}
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
          <Field label="Subject *"><TextInput value={form.subject || ""} onChange={(e) => setForm({ ...form, subject: e.target.value })} /></Field>
          <Field label="Category">
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="GENERAL">General</option><option value="ACADEMIC">Academic</option><option value="FEE">Fees</option><option value="TRANSPORT">Transport</option><option value="OTHER">Other</option>
            </Select>
          </Field>
          <div className="flex items-end">
            <button className="btn btn-primary w-full" onClick={submit} disabled={busy || !form.subject || !form.message}><Send size={15} /> Send</button>
          </div>
          <div className="sm:col-span-3">
            <Field label="Message *"><Textarea rows={3} value={form.message || ""} onChange={(e) => setForm({ ...form, message: e.target.value })} /></Field>
          </div>
        </div>
      </Card>

      <Card>
        <CardHeader title="My submissions" subtitle={`${items.length} total`} />
        {items.length ? (
          <div className="divide-y divide-slate-100">
            {items.map((c) => (
              <div key={c.id} className="px-5 py-3">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-bold text-slate-800">{c.subject}</p>
                  <Badge tone={statusTone(c.status)}>{prettyStatus(c.status)}</Badge>
                </div>
                <p className="mt-0.5 text-sm text-slate-600">{c.message}</p>
                <p className="mt-1 text-[11px] text-slate-400">{fmtDate(c.createdAt, true)}{c.resolution ? ` · Resolution: ${c.resolution}` : ""}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={Inbox} title="No submissions" description="Your complaints and feedback will appear here with status." />
        )}
      </Card>
    </div>
  );
}
