"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowLeft, Save, QrCode, Check } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Field, TextInput, Textarea, Select, PageHeader, ErrorNote } from "@/components/ui";

interface ClassRow { id: string; name: string; sections: { id: string; name: string }[] }

const initial = {
  admissionNo: "", name: "", dob: "", gender: "MALE", bloodGroup: "A_POS", religion: "ISLAM",
  roll: "", registrationNo: "", classId: "", sectionId: "",
  guardianName: "", guardianPhone: "", guardianEmail: "", guardianRelation: "Father",
  emergencyContact: "", address: "", medicalInfo: "",
  createGuardian: true, guardianPassword: "Guardian@123",
};

export default function NewStudentPage() {
  const router = useRouter();
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [form, setForm] = useState(initial);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<any>(null);

  useEffect(() => {
    api<ClassRow[]>("/api/classes").then(setClasses);
  }, []);

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const cls = classes.find((c) => c.id === form.classId);

  const submit = async () => {
    setError("");
    setSaving(true);
    try {
      const res = await api("/api/students", { method: "POST", body: JSON.stringify(form) });
      setCreated(res);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (created) {
    return (
      <div className="mx-auto max-w-lg">
        <div className="card fade-up p-8 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 text-emerald-600"><Check size={26} /></div>
          <h2 className="mt-4 text-xl font-black text-slate-900">Student admitted!</h2>
          <p className="mt-1 text-sm text-slate-500">{created.name} · {created.admissionNo}</p>
          <div className="mt-5 grid grid-cols-2 gap-3">
            <div className="rounded-xl bg-indigo-50 p-4">
              <div className="flex items-center justify-center gap-1.5 text-xs font-bold text-indigo-600"><QrCode size={13} /> QR Token</div>
              <div className="mt-1 break-all font-mono text-[10px] text-indigo-800">{created.qrToken}</div>
            </div>
            <div className="rounded-xl bg-violet-50 p-4">
              <div className="text-xs font-bold text-violet-600">QR PIN (guardian verification)</div>
              <div className="mt-1 text-2xl font-black tracking-widest text-violet-800">{created.qrPin}</div>
            </div>
          </div>
          <div className="mt-6 flex gap-2">
            <button className="btn btn-secondary flex-1" onClick={() => { setCreated(null); setForm(initial); }}>Add another</button>
            <Link href={`/dashboard/students/${created.id}`} className="btn btn-primary flex-1">View profile</Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="New Admission"
        subtitle="Register a new student and generate their QR credentials"
        actions={<Link href="/dashboard/students" className="btn btn-secondary btn-sm"><ArrowLeft size={14} /> Students</Link>}
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card>
        <CardHeader title="Student information" />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <Field label="Full name *"><TextInput value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Admission number"><TextInput value={form.admissionNo} onChange={(e) => set("admissionNo", e.target.value)} placeholder="auto-generated if blank" /></Field>
          <Field label="Date of birth"><TextInput type="date" value={form.dob} onChange={(e) => set("dob", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Gender">
              <Select value={form.gender} onChange={(e) => set("gender", e.target.value)}>
                <option>MALE</option><option>FEMALE</option><option>OTHER</option>
              </Select>
            </Field>
            <Field label="Blood group">
              <Select value={form.bloodGroup} onChange={(e) => set("bloodGroup", e.target.value)}>
                {["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"].map((b) => <option key={b}>{b}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Religion">
            <Select value={form.religion} onChange={(e) => set("religion", e.target.value)}>
              <option>ISLAM</option><option>HINDU</option><option>CHRISTIAN</option><option>BUDDHIST</option><option>OTHERS</option>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Roll"><TextInput type="number" value={form.roll} onChange={(e) => set("roll", e.target.value)} /></Field>
            <Field label="Registration no."><TextInput value={form.registrationNo} onChange={(e) => set("registrationNo", e.target.value)} /></Field>
          </div>
          <Field label="Class">
            <Select value={form.classId} onChange={(e) => { set("classId", e.target.value); set("sectionId", ""); }}>
              <option value="">Select class…</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <Field label="Section">
            <Select value={form.sectionId} onChange={(e) => set("sectionId", e.target.value)} disabled={!form.classId}>
              <option value="">Select section…</option>
              {cls?.sections.map((s) => <option key={s.id} value={s.id}>Section {s.name}</option>)}
            </Select>
          </Field>
          <Field label="Address" className="sm:col-span-2"><Textarea value={form.address} onChange={(e) => set("address", e.target.value)} /></Field>
          <Field label="Medical information (optional)" className="sm:col-span-2"><Textarea value={form.medicalInfo} onChange={(e) => set("medicalInfo", e.target.value)} /></Field>
        </div>
      </Card>

      <Card className="mt-5">
        <CardHeader title="Guardian information" />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <Field label="Guardian name"><TextInput value={form.guardianName} onChange={(e) => set("guardianName", e.target.value)} /></Field>
          <Field label="Relation">
            <Select value={form.guardianRelation} onChange={(e) => set("guardianRelation", e.target.value)}>
              <option>Father</option><option>Mother</option><option>Guardian</option><option>Other</option>
            </Select>
          </Field>
          <Field label="Phone"><TextInput value={form.guardianPhone} onChange={(e) => set("guardianPhone", e.target.value)} placeholder="+880 1XXX-XXXXXX" /></Field>
          <Field label="Emergency contact"><TextInput value={form.emergencyContact} onChange={(e) => set("emergencyContact", e.target.value)} /></Field>
          <Field label="Email" className="sm:col-span-2" hint="Used for the guardian login account">
            <TextInput type="email" value={form.guardianEmail} onChange={(e) => set("guardianEmail", e.target.value)} placeholder="guardian@email.com" />
          </Field>
          <label className="flex items-center gap-2.5 text-sm text-slate-700 sm:col-span-2">
            <input type="checkbox" checked={form.createGuardian} onChange={(e) => set("createGuardian", e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
            Create a guardian login account (default password: Guardian@123)
          </label>
        </div>
      </Card>

      <div className="mt-6 flex justify-end gap-2">
        <Link href="/dashboard/students" className="btn btn-secondary">Cancel</Link>
        <button className="btn btn-primary !px-6" onClick={submit} disabled={saving || !form.name}>
          <Save size={15} /> {saving ? "Saving…" : "Admit student"}
        </button>
      </div>
    </div>
  );
}
