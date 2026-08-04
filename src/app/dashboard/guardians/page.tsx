"use client";

import { useEffect, useState } from "react";
import { Plus, ShieldCheck } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, Field, TextInput, Select, Modal, PageHeader, EmptyState, LoadingScreen, ErrorNote } from "@/components/ui";
import { initials } from "@/lib/utils";

interface Guardian {
  id: string; name: string; email: string; phone: string | null; active: boolean; createdAt: string;
  studentOf: { id: string; name: string; admissionNo: string; roll: number | null; classRoom: { name: string } | null; section: { name: string } | null } | null;
}

export default function GuardiansPage() {
  const [guardians, setGuardians] = useState<Guardian[]>([]);
  const [students, setStudents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", email: "", password: "Guardian@123", studentId: "" });

  const load = () =>
    Promise.all([api<Guardian[]>("/api/guardians"), api<any[]>("/api/students")])
      .then(([g, s]) => { setGuardians(g); setStudents(s.filter((st) => !st.guardianUser)); })
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const create = async () => {
    setError("");
    try {
      await api("/api/guardians", { method: "POST", body: JSON.stringify(form) });
      setOpen(false);
      setForm({ name: "", email: "", password: "Guardian@123", studentId: "" });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="Guardians" subtitle="Parent login accounts & linked students" actions={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={16} /> Link guardian</button>} />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card>
        {guardians.length === 0 ? (
          <EmptyState icon={ShieldCheck} title="No guardian accounts yet" description="Guardian accounts give parents a login to see their child's reports." action={<button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}><Plus size={14} /> Link guardian</button>} />
        ) : (
          <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2 xl:grid-cols-3">
            {guardians.map((g) => (
              <div key={g.id} className="rounded-2xl border border-slate-200 p-4">
                <div className="flex items-center gap-3">
                  <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-violet-50 text-sm font-black text-violet-600">{initials(g.name)}</div>
                  <div className="min-w-0">
                    <div className="truncate font-bold text-slate-800">{g.name}</div>
                    <div className="truncate text-xs text-slate-400">{g.email}</div>
                  </div>
                  <Badge tone={g.active ? "green" : "red"}>{g.active ? "Active" : "Inactive"}</Badge>
                </div>
                <div className="mt-3 rounded-xl bg-slate-50 p-3 text-xs">
                  {g.studentOf ? (
                    <>
                      <div className="font-bold text-slate-700">Linked student: {g.studentOf.name}</div>
                      <div className="text-slate-400">{g.studentOf.classRoom?.name} {g.studentOf.section?.name ? `/ ${g.studentOf.section.name}` : ""} · {g.studentOf.admissionNo}</div>
                    </>
                  ) : (
                    <div className="text-slate-400">No student linked</div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Link guardian account">
        <div className="space-y-4">
          <Field label="Guardian name *"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Email *"><TextInput type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Password"><TextInput value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></Field>
          <Field label="Link to student">
            <Select value={form.studentId} onChange={(e) => setForm({ ...form, studentId: e.target.value })}>
              <option value="">Select student without a guardian…</option>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.classRoom?.name || "No class"}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={create} disabled={!form.name || !form.email || !form.studentId}>Link account</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
