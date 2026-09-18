"use client";

import { useEffect, useState } from "react";
import { CalendarCheck, Plus } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, Select, PageHeader, LoadingScreen, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §7.1 — PTM slots (teacher view: publish + see bookings). */
export default function TeacherMeetingsPage() {
  const [slots, setSlots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<any>({ title: "Parent-Teacher Meeting", durationMin: 15, mode: "IN_PERSON" });
  const [busy, setBusy] = useState(false);

  const load = () => api<any[]>("/api/meetings").then(setSlots).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

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

  return (
    <div className="space-y-4">
      <PageHeader title="PTM Slots" subtitle="Publish meeting slots — guardians book and you get notified (PRD §7.1)" />

      <Card className="p-4">
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
          <Field label="Title"><TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Starts at"><TextInput type="datetime-local" value={form.startAt || ""} onChange={(e) => setForm({ ...form, startAt: e.target.value })} /></Field>
          <Field label="Mode">
            <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="IN_PERSON">In person</option><option value="ONLINE">Online</option>
            </Select>
          </Field>
          <button className="btn btn-primary" onClick={publish} disabled={busy || !form.startAt}><Plus size={15} /> Publish</button>
        </div>
      </Card>

      <Card>
        <CardHeader title="My slots" subtitle={`${slots.length} published`} />
        {slots.length ? (
          <div className="divide-y divide-slate-100">
            {slots.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-sm font-bold text-slate-800">{fmtDate(s.startAt, true)}</p>
                  <p className="text-xs text-slate-500">
                    {s.bookings?.length
                      ? s.bookings.map((b: any) => `${b.student?.name || "?"} (${b.guardian?.name || "?"})`).join(", ")
                      : "No bookings yet"}
                  </p>
                </div>
                <Badge tone={s.active ? "green" : "slate"}>{s.active ? "Active" : "Hidden"}</Badge>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={CalendarCheck} title="No slots yet" description="Publish a slot above." />
        )}
      </Card>
    </div>
  );
}
