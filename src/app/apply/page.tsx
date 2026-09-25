"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { GraduationCap, Send, CheckCircle } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Field, TextInput, Select, Spinner, ErrorNote } from "@/components/ui";

/**
 * PRD §4.1 step 1 — Online Enquiry/Application (public form).
 * Creates an ENQUIRY admission for Front Desk review.
 */
export default function ApplyPage() {
  const [schools, setSchools] = useState<{ id: string; name: string }[]>([]);
  const [form, setForm] = useState<any>({});
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/public/schools")
      .then((r) => r.json())
      .then((d) => setSchools(d?.data || []))
      .catch(() => null);
  }, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/admissions", { method: "POST", body: JSON.stringify(form) });
      setDone(true);
    } catch (err: any) {
      setError(err?.message || "Could not submit enquiry");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen bg-white">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-3xl items-center gap-2.5 px-4 py-4">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-white">
            <GraduationCap size={18} />
          </div>
          <span className="text-base font-extrabold tracking-tight text-slate-900">Amar E School</span>
          <Link href="/" className="ml-auto text-xs font-semibold text-indigo-600 hover:underline">← Home</Link>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-10">
        <h1 className="text-2xl font-black tracking-tight text-slate-900">Admission Enquiry</h1>
        <p className="mt-1 text-sm text-slate-500">
          Fill in the form and our front desk will contact you for the next steps (documents, test scheduling, seat confirmation).
        </p>

        {done ? (
          <Card className="mt-6 p-8 text-center">
            <CheckCircle size={40} className="mx-auto text-emerald-500" />
            <h2 className="mt-3 text-lg font-black text-slate-900">Enquiry received!</h2>
            <p className="mt-1 text-sm text-slate-500">
              Thank you. Our front desk will review your application and contact you at {form.guardianPhone}.
            </p>
            <Link href="/" className="btn btn-primary mt-5">Back to home</Link>
          </Card>
        ) : (
          <Card className="mt-6 p-6">
            <form onSubmit={submit} className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              {error && <div className="sm:col-span-2"><ErrorNote message={error} /></div>}
              <Field label="School *">
                <Select value={form.schoolId || ""} onChange={(e) => setForm({ ...form, schoolId: e.target.value })} required>
                  <option value="">Select school…</option>
                  {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </Select>
              </Field>
              <Field label="Student full name (English) *">
                <TextInput value={form.fullName || ""} onChange={(e) => setForm({ ...form, fullName: e.target.value })} required />
              </Field>
              <Field label="Student full name (Bangla)">
                <TextInput value={form.fullNameBn || ""} onChange={(e) => setForm({ ...form, fullNameBn: e.target.value })} />
              </Field>
              <Field label="Guardian name">
                <TextInput value={form.guardianName || ""} onChange={(e) => setForm({ ...form, guardianName: e.target.value })} />
              </Field>
              <Field label="Guardian phone *">
                <TextInput value={form.guardianPhone || ""} onChange={(e) => setForm({ ...form, guardianPhone: e.target.value })} required />
              </Field>
              <Field label="Guardian email">
                <TextInput type="email" value={form.guardianEmail || ""} onChange={(e) => setForm({ ...form, guardianEmail: e.target.value })} />
              </Field>
              <Field label="Previous school">
                <TextInput value={form.previousSchoolName || ""} onChange={(e) => setForm({ ...form, previousSchoolName: e.target.value })} />
              </Field>
              <Field label="Last class attended" hint="We use this to suggest the right class (§4.2)">
                <TextInput value={form.previousClass || ""} onChange={(e) => setForm({ ...form, previousClass: e.target.value })} />
              </Field>
              <div className="sm:col-span-2">
                <button className="btn btn-primary w-full !py-3" disabled={busy}>
                  {busy ? <Spinner className="h-4 w-4 border-white/40 border-t-white" /> : <Send size={16} />}
                  {busy ? "Submitting…" : "Submit enquiry"}
                </button>
              </div>
            </form>
          </Card>
        )}
      </main>
    </div>
  );
}
