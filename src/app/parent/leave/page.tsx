"use client";

import { useEffect, useState } from "react";
import { CalendarX2, Plus } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, PageHeader, LoadingScreen, EmptyState, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §9.2 — Student leave application (submitted by the guardian). */
export default function ParentLeavePage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = () => api<any[]>("/api/leave-requests").then(setItems).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const apply = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/leave-requests", {
        method: "POST",
        body: JSON.stringify({ fromDate: form.fromDate, toDate: form.toDate || form.fromDate, reason: form.reason }),
      });
      setForm({});
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
      <PageHeader title="Apply for Leave" subtitle="Submit your child's absence request for admin approval (PRD §9.2)" />

      <Card className="p-4">
        {error && <div className="mb-3"><ErrorNote message={error} /></div>}
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
          <Field label="From *"><TextInput type="date" value={form.fromDate || ""} onChange={(e) => setForm({ ...form, fromDate: e.target.value })} /></Field>
          <Field label="To (optional)"><TextInput type="date" value={form.toDate || ""} onChange={(e) => setForm({ ...form, toDate: e.target.value })} /></Field>
          <Field label="Reason *"><TextInput value={form.reason || ""} onChange={(e) => setForm({ ...form, reason: e.target.value })} /></Field>
          <button className="btn btn-primary" onClick={apply} disabled={busy || !form.fromDate || !form.reason}><Plus size={15} /> Submit</button>
        </div>
      </Card>

      <Card>
        <CardHeader title="My applications" subtitle={`${items.length} total`} />
        {items.length ? (
          <div className="divide-y divide-slate-100">
            {items.map((l) => (
              <div key={l.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-sm font-semibold text-slate-700">{fmtDate(l.fromDate)} → {fmtDate(l.toDate)}</p>
                  <p className="text-xs text-slate-500">{l.reason}</p>
                </div>
                <Badge tone={statusTone(l.status)}>{prettyStatus(l.status)}</Badge>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={CalendarX2} title="No applications" description="Your leave requests will appear here." />
        )}
      </Card>
    </div>
  );
}
