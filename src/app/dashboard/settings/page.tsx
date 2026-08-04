"use client";

import { useEffect, useState } from "react";
import { Save, Check, Upload, School, Wallet } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Field, TextInput, Textarea, PageHeader, LoadingScreen, ErrorNote } from "@/components/ui";
import { useMe } from "@/components/Shell";
import { upload } from "@/lib/client";

export default function SchoolSettingsPage() {
  const { me } = useMe();
  const [form, setForm] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    if (!me?.school) return;
    api(`/api/schools/${me.school.id}`).then((d: any) =>
      setForm({
        name: d.name, tagline: d.tagline, address: d.address, phone: d.phone, email: d.email, website: d.website,
        monthlyFee: String(d.feeSetting?.monthlyFee || ""), admissionFee: String(d.feeSetting?.admissionFee || ""),
      })
    );
  }, [me]);

  if (!form) return <LoadingScreen label="Loading settings…" />;

  const save = async () => {
    setSaving(true);
    setError("");
    setDone(false);
    try {
      await api(`/api/schools/${me!.school!.id}`, {
        method: "PATCH",
        body: JSON.stringify({ ...form, monthlyFee: Number(form.monthlyFee || 0), admissionFee: Number(form.admissionFee || 0) }),
      });
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await upload("/api/uploads", fd);
      await api(`/api/schools/${me!.school!.id}`, { method: "PATCH", body: JSON.stringify({ logoUrl: res.url }) });
      setUploading(false);
    } catch (err: any) {
      setError(err.message);
      setUploading(false);
    }
  };

  return (
    <div className="max-w-3xl">
      <PageHeader title="School Settings" subtitle="Profile, branding and fee configuration" />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card>
        <CardHeader title="School profile" subtitle="Shown on ID cards, report cards and the parent portal" />
        <div className="space-y-4 p-5">
          <div className="flex items-center gap-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-indigo-50 text-indigo-600"><School size={24} /></div>
            <label className="btn btn-secondary btn-sm cursor-pointer">
              <Upload size={14} /> {uploading ? "Uploading…" : "Upload logo"}
              <input type="file" accept="image/*" className="hidden" onChange={onUpload} />
            </label>
          </div>
          <Field label="School name"><TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Tagline"><TextInput value={form.tagline || ""} onChange={(e) => setForm({ ...form, tagline: e.target.value })} /></Field>
          <Field label="Address"><Textarea value={form.address || ""} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Phone"><TextInput value={form.phone || ""} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></Field>
            <Field label="Email"><TextInput value={form.email || ""} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          </div>
          <Field label="Website"><TextInput value={form.website || ""} onChange={(e) => setForm({ ...form, website: e.target.value })} /></Field>
        </div>
      </Card>

      <Card className="mt-5">
        <CardHeader title="Fee defaults" subtitle="Applied to new admissions" />
        <div className="grid grid-cols-2 gap-4 p-5">
          <Field label="Monthly fee (৳)"><TextInput type="number" value={form.monthlyFee} onChange={(e) => setForm({ ...form, monthlyFee: e.target.value })} /></Field>
          <Field label="Admission fee (৳)"><TextInput type="number" value={form.admissionFee} onChange={(e) => setForm({ ...form, admissionFee: e.target.value })} /></Field>
        </div>
      </Card>

      <div className="mt-5 flex justify-end">
        <button className="btn btn-primary !px-6" onClick={save} disabled={saving}>
          {done ? <Check size={15} /> : <Save size={15} />} {done ? "Saved ✓" : saving ? "Saving…" : "Save settings"}
        </button>
      </div>
    </div>
  );
}
