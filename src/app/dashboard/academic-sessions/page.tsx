"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Plus, Check, Pencil } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, Field, TextInput, Modal, PageHeader, EmptyState, LoadingScreen, ErrorNote } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/**
 * Academic Sessions (Phase 1 foundation).
 *
 * Create/rename a session, set its dates, and mark exactly one as current. The
 * current session is what new admissions/imports and promotion read — it is
 * stored server-side, so nothing here needs to be trusted by the client.
 */
interface AcademicSession {
  id: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  isCurrent: boolean;
}

const emptyForm = { name: "", startDate: "", endDate: "" };
const toDateInput = (v: string | null) => (v ? String(v).slice(0, 10) : "");

export default function AcademicSessionsPage() {
  const [sessions, setSessions] = useState<AcademicSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<AcademicSession | null>(null);
  const [form, setForm] = useState(emptyForm);

  const load = () => api<AcademicSession[]>("/api/academic-sessions").then(setSessions).catch((e) => setError(e.message)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const openCreate = () => { setEditing(null); setForm(emptyForm); setError(""); setOpen(true); };
  const openEdit = (s: AcademicSession) => {
    setEditing(s);
    setForm({ name: s.name, startDate: toDateInput(s.startDate), endDate: toDateInput(s.endDate) });
    setError("");
    setOpen(true);
  };

  const save = async () => {
    setError("");
    try {
      const body = JSON.stringify({ name: form.name, startDate: form.startDate || null, endDate: form.endDate || null });
      if (editing) await api(`/api/academic-sessions/${editing.id}`, { method: "PATCH", body });
      else await api("/api/academic-sessions", { method: "POST", body });
      setOpen(false);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const setCurrent = async (s: AcademicSession) => {
    setError("");
    try {
      await api(`/api/academic-sessions/${s.id}/set-current`, { method: "POST" });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader
        icon={CalendarDays}
        title="Academic Sessions"
        subtitle="Define the school year and choose which session is current"
        actions={<button className="btn btn-primary" onClick={openCreate}><Plus size={16} /> New session</button>}
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card>
        {sessions.length === 0 ? (
          <EmptyState
            icon={CalendarDays}
            title="No academic sessions yet"
            description="Create a session (e.g. 2026) and set it current so new admissions and imports carry the right year."
            action={<button className="btn btn-primary btn-sm" onClick={openCreate}><Plus size={14} /> New session</button>}
          />
        ) : (
          <div className="divide-y divide-slate-100">
            {sessions.map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-3 p-4">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-slate-800">{s.name}</span>
                    {s.isCurrent && <Badge tone="green">Current</Badge>}
                  </div>
                  <div className="text-xs text-slate-400">
                    {s.startDate ? fmtDate(s.startDate) : "—"} → {s.endDate ? fmtDate(s.endDate) : "—"}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  {!s.isCurrent && (
                    <button className="btn btn-secondary btn-sm" onClick={() => setCurrent(s)}><Check size={14} /> Set current</button>
                  )}
                  <button className="btn btn-secondary btn-sm" onClick={() => openEdit(s)}><Pencil size={14} /> Edit</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title={editing ? "Edit session" : "New academic session"}>
        <div className="space-y-4">
          <Field label="Session name"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. 2026" /></Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Start date"><TextInput type="date" value={form.startDate} onChange={(e) => setForm({ ...form, startDate: e.target.value })} /></Field>
            <Field label="End date"><TextInput type="date" value={form.endDate} onChange={(e) => setForm({ ...form, endDate: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={save} disabled={!form.name.trim()}>{editing ? "Save" : "Create"}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
