"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Building2, Plus, Eye, Sparkles } from "lucide-react";
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

interface PlanRow {
  id: string;
  name: string;
  price: number | string;
  cycle: "MONTHLY" | "YEARLY";
  maxStudents: number | null;
  trialDays: number | null;
}

export default function SchoolsPage() {
  const [schools, setSchools] = useState<SchoolRow[]>([]);
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(0);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    address: "",
    schoolEmail: "",
    tagline: "",
    themeColor: "#4f46e5",
    logoUrl: "",
    adminName: "",
    adminEmail: "",
    adminPassword: "School@123",
    monthlyFee: "1500",
    admissionFee: "5000",
    planId: "",
    cycle: "MONTHLY",
  });

  const load = async () => {
    try {
      const [schoolsData, plansData] = await Promise.all([
        api<SchoolRow[]>("/api/schools"),
        api<PlanRow[]>("/api/plans").catch(() => [] as PlanRow[]),
      ]);
      setSchools(schoolsData);
      setPlans(plansData);
      if (plansData[0] && !form.planId) {
        setForm((prev) => ({ ...prev, planId: plansData[0].id }));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const selectedPlan = plans.find((p) => p.id === form.planId) || null;

  const stepTitles = ["School", "Admin", "Plan", "Review"];

  const canAdvance = () => {
    if (step === 0) return Boolean(form.name.trim() && form.address.trim());
    if (step === 1) return Boolean(form.adminName.trim() && form.adminEmail.trim() && form.adminPassword.trim());
    if (step === 2) return Boolean(form.planId);
    return true;
  };

  const create = async () => {
    setError("");
    try {
      await api("/api/schools", {
        method: "POST",
        body: JSON.stringify({
          ...form,
          monthlyFee: Number(form.monthlyFee),
          admissionFee: Number(form.admissionFee),
          admin: {
            name: form.adminName,
            email: form.adminEmail,
            password: form.adminPassword,
          },
        }),
      });
      setOpen(false);
      setStep(0);
      setForm({
        name: "",
        address: "",
        schoolEmail: "",
        tagline: "",
        themeColor: "#4f46e5",
        logoUrl: "",
        adminName: "",
        adminEmail: "",
        adminPassword: "School@123",
        monthlyFee: "1500",
        admissionFee: "5000",
        planId: plans[0]?.id || "",
        cycle: "MONTHLY",
      });
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
          <div className="flex items-center gap-2">
            <Link href="/onboarding" className="btn btn-secondary"><Sparkles size={15} /> Setup wizard</Link>
            <button className="btn btn-primary" onClick={() => { setOpen(true); setStep(0); }}>
              <Plus size={16} /> New School
            </button>
          </div>
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

          <div className="flex items-center gap-2">
            {stepTitles.map((title, index) => (
              <div key={title} className="flex flex-1 items-center gap-2">
                <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${index === step ? "bg-indigo-600 text-white" : index < step ? "bg-emerald-500 text-white" : "bg-slate-200 text-slate-500"}`}>
                  {index + 1}
                </div>
                <span className={`text-[11px] font-semibold ${index === step ? "text-indigo-600" : "text-slate-400"}`}>{title}</span>
              </div>
            ))}
          </div>

          {step === 0 && (
            <div className="space-y-4">
              <Field label="School name"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Green Valley Academy" /></Field>
              <Field label="Address"><TextInput value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} placeholder="Dhaka, Bangladesh" /></Field>
              <Field label="School email"><TextInput type="email" value={form.schoolEmail} onChange={(e) => setForm({ ...form, schoolEmail: e.target.value })} placeholder="hello@school.com" /></Field>
              <Field label="Tagline"><TextInput value={form.tagline} onChange={(e) => setForm({ ...form, tagline: e.target.value })} placeholder="Future-ready learning" /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Brand color"><TextInput type="color" value={form.themeColor} onChange={(e) => setForm({ ...form, themeColor: e.target.value })} className="h-11 p-2" /></Field>
                <Field label="Logo URL"><TextInput value={form.logoUrl} onChange={(e) => setForm({ ...form, logoUrl: e.target.value })} placeholder="https://..." /></Field>
              </div>
            </div>
          )}

          {step === 1 && (
            <div className="space-y-4">
              <Field label="Admin name"><TextInput value={form.adminName} onChange={(e) => setForm({ ...form, adminName: e.target.value })} placeholder="School Administrator" /></Field>
              <Field label="Admin email"><TextInput type="email" value={form.adminEmail} onChange={(e) => setForm({ ...form, adminEmail: e.target.value })} placeholder="admin@school.com" /></Field>
              <Field label="Admin password"><TextInput value={form.adminPassword} onChange={(e) => setForm({ ...form, adminPassword: e.target.value })} /></Field>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <Field label="Plan">
                <Select value={form.planId} onChange={(e) => setForm({ ...form, planId: e.target.value })}>
                  {!plans.length && <option value="">No plans yet</option>}
                  {plans.map((plan) => (
                    <option key={plan.id} value={plan.id}>{plan.name}</option>
                  ))}
                </Select>
              </Field>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Billing cycle">
                  <Select value={form.cycle} onChange={(e) => setForm({ ...form, cycle: e.target.value })}>
                    <option value="MONTHLY">Monthly</option>
                    <option value="YEARLY">Yearly</option>
                  </Select>
                </Field>
                <Field label="Trial / default">
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm font-semibold text-slate-600">
                    {selectedPlan ? `${selectedPlan.trialDays ?? 14} day trial` : "No plan selected"}
                  </div>
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Field label="Monthly fee (৳)"><TextInput type="number" value={form.monthlyFee} onChange={(e) => setForm({ ...form, monthlyFee: e.target.value })} /></Field>
                <Field label="Admission fee (৳)"><TextInput type="number" value={form.admissionFee} onChange={(e) => setForm({ ...form, admissionFee: e.target.value })} /></Field>
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between rounded-xl bg-white p-3 shadow-sm">
                <div>
                  <div className="text-xs font-bold uppercase tracking-wide text-slate-400">School</div>
                  <div className="text-lg font-black text-slate-800">{form.name || "Untitled school"}</div>
                </div>
                <div className="rounded-full bg-indigo-100 px-3 py-1 text-xs font-bold text-indigo-700">{form.cycle}</div>
              </div>
              <div className="grid grid-cols-2 gap-3 text-sm">
                <div><div className="text-xs uppercase text-slate-400">Address</div><div className="mt-1 font-semibold text-slate-700">{form.address || "—"}</div></div>
                <div><div className="text-xs uppercase text-slate-400">Email</div><div className="mt-1 font-semibold text-slate-700">{form.schoolEmail || "—"}</div></div>
                <div><div className="text-xs uppercase text-slate-400">Admin</div><div className="mt-1 font-semibold text-slate-700">{form.adminName || "—"}</div></div>
                <div><div className="text-xs uppercase text-slate-400">Plan</div><div className="mt-1 font-semibold text-slate-700">{selectedPlan?.name || "—"}</div></div>
                <div><div className="text-xs uppercase text-slate-400">Monthly fee</div><div className="mt-1 font-semibold text-slate-700">৳ {Number(form.monthlyFee || 0).toLocaleString()}</div></div>
                <div><div className="text-xs uppercase text-slate-400">Admission fee</div><div className="mt-1 font-semibold text-slate-700">৳ {Number(form.admissionFee || 0).toLocaleString()}</div></div>
              </div>
            </div>
          )}

          <div className="flex justify-between gap-2 pt-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <div className="flex gap-2">
              {step > 0 && <button className="btn btn-secondary" onClick={() => setStep((s) => Math.max(0, s - 1))}>Back</button>}
              {step < stepTitles.length - 1 ? (
                <button className="btn btn-primary" onClick={() => canAdvance() && setStep((s) => Math.min(stepTitles.length - 1, s + 1))} disabled={!canAdvance()}>
                  Next
                </button>
              ) : (
                <button className="btn btn-primary" onClick={create} disabled={!form.name || !form.adminEmail || !form.adminPassword || !form.planId}>Create school</button>
              )}
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
