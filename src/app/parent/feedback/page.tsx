"use client";

import { useCallback, useEffect, useState } from "react";
import { Inbox, Send } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, ErrorNote, Field, LoadingScreen, Select, TextInput, Textarea, statusTone, prettyStatus } from "@/components/ui";
import { EmptyState, ErrorState, SectionHeader, Surface } from "@/components/app-ui";
import { fmtDate } from "@/lib/utils";

/** PRD §7.1 — Complaint/Feedback Box (guardian side, with tracking status). */
export default function ParentFeedbackPage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<any>({ category: "GENERAL" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    return api<any[]>("/api/complaints")
      .then(setItems)
      .catch((e: any) => setLoadError(e?.message || "Couldn't load your submissions."))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

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
  if (loadError && !items.length) return <ErrorState message={loadError} onRetry={load} />;

  return (
    <div>
      <SectionHeader title="Reach the school" className="ss-flush-top" />
      <Surface>
        {error && (
          <div className="mb-3">
            <ErrorNote message={error} />
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Subject *">
            <TextInput value={form.subject || ""} onChange={(e) => setForm({ ...form, subject: e.target.value })} />
          </Field>
          <Field label="Category">
            <Select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="GENERAL">General</option>
              <option value="ACADEMIC">Academic</option>
              <option value="FEE">Fees</option>
              <option value="TRANSPORT">Transport</option>
              <option value="OTHER">Other</option>
            </Select>
          </Field>
          <Field label="Message *" className="sm:col-span-2">
            <Textarea rows={3} value={form.message || ""} onChange={(e) => setForm({ ...form, message: e.target.value })} />
          </Field>
        </div>
        <button className="btn btn-primary mt-3 w-full min-h-11" onClick={submit} disabled={busy || !form.subject || !form.message}>
          <Send size={15} /> Send
        </button>
      </Surface>

      <SectionHeader title={`My submissions · ${items.length}`} />
      {items.length ? (
        <div className="space-y-3">
          {items.map((c) => (
            <Surface key={c.id}>
              <div className="flex items-center justify-between gap-2">
                <p className="text-[14px] font-bold text-slate-800">{c.subject}</p>
                <Badge tone={statusTone(c.status)}>{prettyStatus(c.status)}</Badge>
              </div>
              <p className="mt-1 text-[13px] text-slate-600">{c.message}</p>
              <p className="mt-1 text-[11px] text-slate-400">
                {fmtDate(c.createdAt, true)}
                {c.resolution ? ` · Resolution: ${c.resolution}` : ""}
              </p>
            </Surface>
          ))}
        </div>
      ) : (
        <EmptyState icon={Inbox} title="No submissions" hint="Your complaints and feedback will appear here with status." />
      )}
    </div>
  );
}
