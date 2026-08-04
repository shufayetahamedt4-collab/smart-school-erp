"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { Building2, GraduationCap, Users, Wallet, ArrowLeft, Pencil, Check, X } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, StatCard, Field, TextInput, Textarea, Select, PageHeader, LoadingScreen, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtDate, fmtMoney } from "@/lib/utils";

export default function SchoolDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState<any>({});

  const load = () => api(`/api/schools/${id}`).then((d: any) => { setData(d); setForm({ ...d, monthlyFee: String(d.feeSetting?.monthlyFee || ""), admissionFee: String(d.feeSetting?.admissionFee || "") }); }).finally(() => setLoading(false));
  useEffect(() => { load(); }, [id]);

  if (loading) return <LoadingScreen />;
  if (!data) return <div className="p-10 text-center">School not found</div>;

  const mrr = (Number(data.feeSetting?.monthlyFee || 0) * data._count.students).toLocaleString();

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api(`/api/schools/${id}`, { method: "PATCH", body: JSON.stringify({
        name: form.name, tagline: form.tagline, address: form.address, phone: form.phone, email: form.email,
        website: form.website, plan: form.plan, status: form.status,
        monthlyFee: form.monthlyFee, admissionFee: form.admissionFee,
      }) });
      setEdit(false);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <PageHeader
        title={data.name}
        subtitle={`/${data.slug} · joined ${fmtDate(data.createdAt)}`}
        actions={
          <>
            <Link href="/admin/schools" className="btn btn-secondary btn-sm"><ArrowLeft size={14} /> Schools</Link>
            {!edit && <button className="btn btn-primary btn-sm" onClick={() => setEdit(true)}><Pencil size={14} /> Edit</button>}
          </>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={GraduationCap} label="Students" value={data._count.students} tone="indigo" />
        <StatCard icon={Users} label="Teachers" value={data._count.teachers} tone="sky" />
        <StatCard icon={Wallet} label="Est. MRR" value={fmtMoney(mrr)} sub={`monthly fee ${fmtMoney(data.feeSetting?.monthlyFee)}`} tone="emerald" />
        <StatCard icon={Building2} label="Status" value={<Badge tone={statusTone(data.status)} className="!text-sm">{prettyStatus(data.status)}</Badge>} tone={data.status === "SUSPENDED" ? "rose" : "violet"} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="School profile" subtitle={edit ? "Editing…" : "Contact & billing information"} />
          {!edit ? (
            <div className="grid grid-cols-1 gap-x-8 gap-y-3 p-5 text-sm sm:grid-cols-2">
              {[
                ["Tagline", data.tagline], ["Address", data.address], ["Phone", data.phone], ["Email", data.email],
                ["Website", data.website], ["Plan", data.plan], ["Monthly fee", fmtMoney(data.feeSetting?.monthlyFee)],
                ["Admission fee", fmtMoney(data.feeSetting?.admissionFee)],
              ].map(([k, v]) => (
                <div key={k}>
                  <div className="text-xs font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                  <div className="mt-0.5 font-semibold text-slate-700">{v || "—"}</div>
                </div>
              ))}
            </div>
          ) : (
            <div className="space-y-4 p-5">
              <Field label="Name"><TextInput value={form.name || ""} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field label="Tagline"><TextInput value={form.tagline || ""} onChange={(e) => setForm({ ...form, tagline: e.target.value })} /></Field>
              <Field label="Address"><Textarea value={form.address || ""} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Phone"><TextInput value={form.phone || ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
                <Field label="Email"><TextInput value={form.email || ""} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Plan">
                  <Select value={form.plan} onChange={(e) => setForm({ ...form, plan: e.target.value })}>
                    <option>Basic</option><option>Plus</option><option>Pro</option>
                  </Select>
                </Field>
                <Field label="Status">
                  <Select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                    <option>ACTIVE</option><option>TRIAL</option><option>SUSPENDED</option>
                  </Select>
                </Field>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Monthly fee (৳)"><TextInput type="number" value={form.monthlyFee} onChange={(e) => setForm({ ...form, monthlyFee: e.target.value })} /></Field>
                <Field label="Admission fee (৳)"><TextInput type="number" value={form.admissionFee} onChange={(e) => setForm({ ...form, admissionFee: e.target.value })} /></Field>
              </div>
              <div className="flex justify-end gap-2">
                <button className="btn btn-secondary btn-sm" onClick={() => setEdit(false)}><X size={14} /> Cancel</button>
                <button className="btn btn-primary btn-sm" onClick={save} disabled={saving}><Check size={14} /> {saving ? "Saving…" : "Save changes"}</button>
              </div>
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="School administrators" />
          <div className="divide-y divide-slate-100">
            {data.users?.map((u: any) => (
              <div key={u.id} className="flex items-center gap-3 px-5 py-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-full bg-violet-50 text-xs font-bold text-violet-600">
                  {u.name.split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase()}
                </div>
                <div>
                  <div className="text-sm font-bold text-slate-800">{u.name}</div>
                  <div className="text-xs text-slate-400">{u.email}</div>
                </div>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}
