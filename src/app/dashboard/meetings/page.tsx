"use client";

import { useEffect, useState } from "react";
import { CalendarCheck, Plus, Trash2 } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, Select, PageHeader, LoadingScreen, EmptyState } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §7.1 — Parent-Teacher Meeting scheduling (staff side: publish slots). */
export default function MeetingsPage() {
  const [slots, setSlots] = useState<any[]>([]);
  const [teachers, setTeachers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState<any>({ title: "Parent-Teacher Meeting", durationMin: 15, mode: "IN_PERSON" });
  const [busy, setBusy] = useState(false);

  const load = () => api<any[]>("/api/meetings").then(setSlots).finally(() => setLoading(false));
  useEffect(() => {
    load();
    api<any[]>("/api/teachers").then((ts) => setTeachers(ts.filter((t) => t.user).map((t) => ({ id: t.id, name: t.user.name })))).catch(() => null);
  }, []);

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

  const toggle = async (slotId: string, active: boolean) => {
    await api("/api/meetings", { method: "PATCH", body: JSON.stringify({ slotId, active }) });
    await load();
  };

  if (loading) return <LoadingScreen />;

  return (
    <div className="space-y-4">
      <PageHeader title="PTM Slots" subtitle="Publish meeting slots for guardians to book (PRD §7.1)" />

      <Card className="p-4">
        <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-5">
          <Field label="Title"><TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} /></Field>
          <Field label="Teacher">
            <Select value={form.teacherId || ""} onChange={(e) => setForm({ ...form, teacherId: e.target.value || undefined })}>
              <option value="">Me / unassigned</option>
              {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
            </Select>
          </Field>
          <Field label="Starts at"><TextInput type="datetime-local" value={form.startAt || ""} onChange={(e) => setForm({ ...form, startAt: e.target.value })} /></Field>
          <Field label="Mode">
            <Select value={form.mode} onChange={(e) => setForm({ ...form, mode: e.target.value })}>
              <option value="IN_PERSON">In person</option>
              <option value="ONLINE">Online</option>
            </Select>
          </Field>
          <button className="btn btn-primary" onClick={publish} disabled={busy || !form.startAt}><Plus size={15} /> Publish slot</button>
        </div>
      </Card>

      <Card>
        <CardHeader title="Published slots" subtitle={`${slots.length} total`} />
        {slots.length ? (
          <div className="divide-y divide-slate-100">
            {slots.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-5 py-3">
                <div>
                  <p className="text-sm font-bold text-slate-800">{s.title} · {s.teacher?.name || "Unassigned"}</p>
                  <p className="text-xs text-slate-500">{fmtDate(s.startAt, true)} · {s.durationMin} min · {s.mode}</p>
                  <p className="mt-0.5 text-[11px] text-slate-400">
                    {s.bookings?.length
                      ? s.bookings.map((b: any) => `${b.student?.name || "?"} (${b.guardian?.name || "?"})`).join(", ")
                      : "No bookings yet"}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge tone={s.active ? "green" : "slate"}>{s.active ? "Active" : "Hidden"}</Badge>
                  <button className="btn btn-ghost btn-sm" onClick={() => toggle(s.id, !s.active)}>{s.active ? "Hide" : "Show"}</button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={CalendarCheck} title="No slots yet" description="Publish a slot above so guardians can book meetings." />
        )}
      </Card>
    </div>
  );
}
