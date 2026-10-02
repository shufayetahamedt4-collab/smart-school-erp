"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, Plus } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, Field, LoadingScreen, Select, TextInput } from "@/components/ui";
import { EmptyState, ErrorState, ListCard, ListRow, SectionHeader, Surface } from "@/components/app-ui";
import { fmtDate } from "@/lib/utils";

/**
 * PRD §7.1 — PTM slots (teacher view: publish + see bookings).
 *
 * Same read, same POST body, same gate on Publish. The form is an inset surface
 * and the slots are hairline-separated rows, with the Active/Hidden pill as the
 * row's trailing element.
 *
 * Also added: a read-failure state — a rejected GET previously left the page on
 * its spinner, because `load` had no `catch`. Retry repeats the same read.
 */
export default function TeacherMeetingsPage() {
  const [slots, setSlots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<any>({ title: "Parent-Teacher Meeting", durationMin: 15, mode: "IN_PERSON" });
  const [busy, setBusy] = useState(false);
  const [loadError, setLoadError] = useState("");

  const load = useCallback(
    () =>
      api<any[]>("/api/meetings")
        .then((rows) => {
          setSlots(rows);
          setLoadError("");
        })
        .catch((e: any) => setLoadError(e?.message || "Couldn't load your PTM slots."))
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

  const publish = async () => {
    if (!form.startAt) return;
    setBusy(true);
    try {
      await api("/api/meetings", { method: "POST", body: JSON.stringify({ ...form, startAt: new Date(form.startAt).toISOString() }) });
      setForm({ ...form, startAt: "" });
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;
  // Only when there is nothing on screen: a failed refresh after a successful
  // publish must not replace the list the user just added to.
  if (loadError && !slots.length) return <ErrorState message={loadError} onRetry={retry} />;

  return (
    <div className="ss-meetingspage">
      <SectionHeader title="Publish a slot" className="ss-flush-top" />
      <Surface>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Title">
            <TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="Starts at">
            <TextInput type="datetime-local" value={form.startAt || ""} onChange={(e) => setForm({ ...form, startAt: e.target.value })} />
          </Field>
          <Field label="Mode" className="sm:col-span-2">
            <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="IN_PERSON">In person</option>
              <option value="ONLINE">Online</option>
            </Select>
          </Field>
        </div>
        <button className="btn btn-primary mt-3 w-full" onClick={publish} disabled={busy || !form.startAt}>
          <Plus size={15} /> Publish
        </button>
      </Surface>

      <SectionHeader title="My slots" />
      {slots.length ? (
        <ListCard>
          {slots.map((s) => (
            <ListRow
              key={s.id}
              icon={CalendarCheck}
              tone="sky"
              title={fmtDate(s.startAt, true)}
              subtitle={
                s.bookings?.length
                  ? s.bookings.map((b: any) => `${b.student?.name || "?"} (${b.guardian?.name || "?"})`).join(", ")
                  : "No bookings yet"
              }
              trailing={<Badge tone={s.active ? "green" : "slate"}>{s.active ? "Active" : "Hidden"}</Badge>}
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState icon={CalendarCheck} title="No slots yet" hint="Publish a slot above." />
      )}
    </div>
  );
}
