"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarX2, Plus } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, ErrorNote, Field, LoadingScreen, TextInput, statusTone, prettyStatus } from "@/components/ui";
import { EmptyState, ErrorState, ListCard, ListRow, SectionHeader, Surface } from "@/components/app-ui";
import { fmtDate } from "@/lib/utils";

/** PRD §9.2 — Student leave application (submitted by the guardian). */
export default function ParentLeavePage() {
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [form, setForm] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    return api<any[]>("/api/leave-requests")
      .then(setItems)
      .catch((e: any) => setLoadError(e?.message || "Couldn't load your applications."))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

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
  if (loadError && !items.length) return <ErrorState message={loadError} onRetry={load} />;

  return (
    <div>
      <SectionHeader title="Apply for leave" className="ss-flush-top" />
      <Surface>
        {error && (
          <div className="mb-3">
            <ErrorNote message={error} />
          </div>
        )}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="From *">
            <TextInput type="date" value={form.fromDate || ""} onChange={(e) => setForm({ ...form, fromDate: e.target.value })} />
          </Field>
          <Field label="To (optional)">
            <TextInput type="date" value={form.toDate || ""} onChange={(e) => setForm({ ...form, toDate: e.target.value })} />
          </Field>
          <Field label="Reason *" className="sm:col-span-2">
            <TextInput value={form.reason || ""} onChange={(e) => setForm({ ...form, reason: e.target.value })} />
          </Field>
        </div>
        <button className="btn btn-primary mt-3 w-full min-h-11" onClick={apply} disabled={busy || !form.fromDate || !form.reason}>
          <Plus size={15} /> Submit
        </button>
      </Surface>

      <SectionHeader title="My applications" />
      {items.length ? (
        <ListCard>
          {items.map((l) => (
            <ListRow
              key={l.id}
              icon={CalendarX2}
              tone="amber"
              title={`${fmtDate(l.fromDate)} → ${fmtDate(l.toDate)}`}
              subtitle={l.reason}
              trailing={<Badge tone={statusTone(l.status)}>{prettyStatus(l.status)}</Badge>}
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState icon={CalendarX2} title="No applications" hint="Your leave requests will appear here." />
      )}
    </div>
  );
}
