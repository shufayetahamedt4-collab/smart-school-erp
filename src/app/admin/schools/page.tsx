"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, Plus, Eye, Pencil, Trash2, Search } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, Modal, Field, TextInput, Select, PageHeader, EmptyState, LoadingScreen, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtDate, fmtMoney } from "@/lib/utils";

interface SchoolRow {
  id: string;
  name: string;
  slug: string;
  status: string;
  plan: string;
  createdAt: string;
  _count: { students: number; teachers: number; users: number };
  feeSetting?: { monthlyFee: number } | null;
}

export default function SchoolsPage() {
  const [schools, setSchools] = useState<SchoolRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", adminName: "", adminEmail: "", adminPassword: "School@123", monthlyFee: "1500", plan: "Pro" });

  const load = () => api<SchoolRow[]>("/api/schools").then(setSchools).finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);

  const create = async () => {
    setError("");
    try {
      await api("/api/schools", { method: "POST", body: JSON.stringify({ ...form, monthlyFee: Number(form.monthlyFee) }) });
      setOpen(false);
      setForm({ name: "", adminName: "", adminEmail: "", adminPassword: "School@123", monthlyFee: "1500", plan: "Pro" });
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const toggleStatus = async (s: SchoolRow) => {
    await api(`/api/schools/${s.id}`, { method: "PATCH", body: JSON.stringify({ status: s.status === "SUSPENDED" ? "ACTIVE" : "SUSPENDED" }) });
    load();
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader
        title="Schools"
        subtitle={`${schools.length} schools on the platform`}
        actions={
          <button className="btn btn-primary" onClick={() => setOpen(true)}>
            <Plus size={16} /> New School
          </button>
        }
      />

      <Card>
        {schools.length === 0 ? (
          <EmptyState icon={Building2} title="No schools yet" description="Create your first school to start onboarding." action={<button className="btn btn-primary" onClick={() => setOpen(true)}><Plus size={15} /> New School</button>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">School</th>
                  <th className="th">Plan</th>
                  <th className="th">Status</th>
                  <th className="th">Students</th>
                  <th className="th">Teachers</th>
                  <th className="th">Est. MRR</th>
                  <th className="th">Joined</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {schools.map((s) => (
                  <tr key={s.id} className="tr-hover">
                    <td className="td">
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-indigo-50 text-indigo-600"><Building2 size={16} /></div>
                        <div>
                          <div className="font-bold text-slate-800">{s.name}</div>
                          <div className="text-xs text-slate-400">/{s.slug || s.id}</div>
                        </div>
                      </div>
                    </td>
                    <td className="td"><span className="rounded-md bg-slate-100 px-2 py-0.5 text-[10px] font-bold text-slate-500">{s.plan}</span></td>
                    <td className="td"><Badge tone={statusTone(s.status)}>{prettyStatus(s.status)}</Badge></td>
                    <td className="td font-semibold">{s._count.students}</td>
                    <td className="td font-semibold">{s._count.teachers}</td>
                    <td className="td font-semibold">{fmtMoney(Number(s.feeSetting?.monthlyFee || 0) * s._count.students)}</td>
                    <td className="td text-xs text-slate-500">{fmtDate(s.createdAt)}</td>
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        <Link href={`/admin/schools/${s.id}`} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600"><Eye size={15} /></Link>
                        <button onClick={() => toggleStatus(s)} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-amber-600">
                          {s.status === "SUSPENDED" ? "Activate" : "Suspend"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Modal open={open} onClose={() => setOpen(false)} title="Onboard a new school">
        <div className="space-y-4">
          {error && <ErrorNote message={error} />}
          <Field label="School name"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Green Valley Academy" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Admin name"><TextInput value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} /></Field>
            <Field label="Plan">
              <Select value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
                <option>Pro</option><option>Plus</option><option>Basic</option>
              </Select>
            </Field>
          </div>
          <Field label="Admin email"><TextInput type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} placeholder="admin@school.com" /></Field>
          <Field label="Admin password"><TextInput value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} /></Field>
          <Field label="Monthly fee per student (৳)"><TextInput type="number" value={form.monthlyFee} onChange={(e) => setForm({ ...form, monthlyFee: e.target.value })} /></Field>
          <div className="flex justify-end gap-2 pt-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={create} disabled={!form.name || !form.adminEmail}>Create school</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
