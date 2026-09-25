"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  ArrowLeft, Save, QrCode, Check, Users, Wallet, Package,
  TriangleAlert, Search, Receipt, IdCard, CircleAlert,
} from "lucide-react";
import { api, upload } from "@/lib/client";
import { Card, CardHeader, Field, TextInput, Textarea, Select, PageHeader, ErrorNote, Badge } from "@/components/ui";
import { fmtMoney } from "@/lib/utils";
import { useMe } from "@/components/Shell";

/**
 * PRD §4 — the desk's admission form (the "New Admission" intake form).
 *
 * ONE form, TWO entry points: the Students module (`/dashboard/students/new`,
 * button "New Admission") and the Admissions module (`/dashboard/admissions/new`,
 * button "New admission"). Both render THIS component, so the information fields
 * can never drift apart — the desk fills in exactly the same fields either way.
 * Only navigation is parameterised (see AdmissionIntakeFormProps); never a field.
 *
 * One walk-in, one action: the student, the guardian's login, the family a sibling
 * already belongs to, the fee, any discount, the money taken at the counter, and
 * the books/uniform handed over — all captured here and turned into records by
 * POST /api/admissions/intake. What could NOT be done (kit out of stock, a
 * discount that needs an admin, a fee left unpaid) comes back as a visible to-do
 * list rather than being swallowed.
 *
 * Fees and kit are priced from the school's own settings: the class's Fee Template
 * when it has one, else Fee Settings, and live stock for every catalogue item.
 */

interface ClassRow { id: string; name: string; sections: { id: string; name: string }[] }
interface KitItem {
  id: string; title: string; code: string | null; type: string;
  classId: string | null; className: string | null; price: number;
  total: number; issued: number; available: number;
}
interface FeeDefaults {
  admissionFee: number; monthlyFee: number;
  source: "class-template" | "school-settings" | "app-default";
  templateName?: string;
  extraLines: { title: string; type: string; amount: number }[];
}
interface SiblingRow {
  id: string; name: string; admissionNo: string;
  classRoom: { id: string; name: string } | null;
  section: { name: string } | null;
  guardianName: string | null; guardianPhone: string | null;
}

const BLOOD = ["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"];
const KIT_TYPES: { key: string; label: string }[] = [
  { key: "TEXTBOOK", label: "Textbooks" },
  { key: "UNIFORM", label: "Uniform" },
  { key: "ASSET", label: "Assets" },
  { key: "LIBRARY", label: "Library" },
];

const initial = {
  // student
  name: "", nameBn: "", admissionNo: "", dob: "", gender: "MALE", bloodGroup: "A_POS",
  religion: "ISLAM", roll: "", registrationNo: "", classId: "", sectionId: "", address: "",
  medicalInfo: "", birthCertificateNo: "", photoUrl: "", previousSchoolName: "", previousClass: "",
  previousSchoolAddress: "", leavingReason: "",
  // guardian
  guardianName: "", guardianPhone: "", guardianEmail: "", guardianRelation: "Father",
  emergencyContact: "", createGuardian: true, guardianPassword: "Guardian@123",
  // fees
  admissionFee: "", monthlyFee: "", createMonthly: true,
  discountOn: false, discountType: "PERCENT", discountValue: "", discountReason: "SIBLING", discountNote: "",
  // payment
  collect: true, method: "CASH", refNo: "",
  // kit
  uniformSize: "", idCardIssued: false,
};

export interface AdmissionIntakeFormProps {
  /** Where the "Cancel" button and the header's back link go. */
  cancelHref?: string;
  cancelLabel?: string;
  /** Optional extra button on the success screen (the Admissions module returns to its pipeline). */
  successHref?: string;
  successLabel?: string;
  /** Page heading — the same wording on every entry point unless overridden. */
  title?: string;
  subtitle?: string;
}

export default function AdmissionIntakeForm({
  cancelHref = "/dashboard/students",
  cancelLabel = "Students",
  successHref,
  successLabel,
  title = "New Admission",
  subtitle = "Everything the desk knows, captured once — student, guardian, fees, kit and QR credentials",
}: AdmissionIntakeFormProps = {}) {
  const { me } = useMe();
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [form, setForm] = useState(initial);
  const [defaults, setDefaults] = useState<FeeDefaults | null>(null);
  const [kit, setKit] = useState<KitItem[]>([]);
  const [kitNow, setKitNow] = useState<Record<string, boolean>>({});
  const [kitLater, setKitLater] = useState<Record<string, boolean>>({});
  const [siblingQuery, setSiblingQuery] = useState("");
  const [siblings, setSiblings] = useState<SiblingRow[]>([]);
  const [siblingId, setSiblingId] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState<any>(null);

  const set = (k: string, v: any) => setForm((f) => ({ ...f, [k]: v }));
  const cls = classes.find((c) => c.id === form.classId);

  useEffect(() => {
    api<ClassRow[]>("/api/classes").then(setClasses);
  }, []);

  /** Fee defaults + live kit for a class (called on mount and whenever it changes). */
  const loadIntake = useCallback(async (classId?: string) => {
    const data = await api<{ feeDefaults: FeeDefaults; kit: KitItem[] }>(
      `/api/admissions/intake${classId ? `?classId=${encodeURIComponent(classId)}` : ""}`
    ).catch(() => null);
    if (!data) return;
    setDefaults(data.feeDefaults);
    setKit(data.kit || []);
    setForm((f) => ({
      ...f,
      // Only overwrite a fee the desk has not typed into yet.
      admissionFee: f.admissionFee === "" || f.admissionFee === String(defaults?.admissionFee ?? "") ? String(data.feeDefaults.admissionFee) : f.admissionFee,
      monthlyFee: f.monthlyFee === "" || f.monthlyFee === String(defaults?.monthlyFee ?? "") ? String(data.feeDefaults.monthlyFee) : f.monthlyFee,
    }));
  }, [defaults?.admissionFee, defaults?.monthlyFee]);

  useEffect(() => {
    loadIntake();
  }, [loadIntake]);

  /** Sibling lookup: what the desk typed, plus anything the guardian phone implies. */
  useEffect(() => {
    const term = siblingQuery.trim();
    const phone = form.guardianPhone.trim();
    if (!term && !phone) {
      setSiblings([]);
      return;
    }
    const t = setTimeout(() => {
      const params = new URLSearchParams();
      if (term) params.set("q", term);
      if (phone) params.set("phone", phone);
      api<{ siblings: SiblingRow[] }>(`/api/admissions/intake?${params.toString()}`)
        .then((d) => setSiblings(d.siblings || []))
        .catch(() => null);
    }, 350);
    return () => clearTimeout(t);
  }, [siblingQuery, form.guardianPhone]);

  const chooseSibling = (s: SiblingRow) => {
    const next = siblingId === s.id ? "" : s.id;
    setSiblingId(next);
    if (next && !form.discountOn) {
      // A sibling is the usual reason for a discount, so offer it prefilled —
      // the percentage stays the school's call.
      setForm((f) => ({ ...f, discountOn: true, discountReason: "SIBLING" }));
    }
  };

  const toggleNow = (id: string) => {
    setKitNow((m) => ({ ...m, [id]: !m[id] }));
    setKitLater((m) => ({ ...m, [id]: false }));
  };
  const toggleLater = (id: string) => {
    setKitLater((m) => ({ ...m, [id]: !m[id] }));
    setKitNow((m) => ({ ...m, [id]: false }));
  };

  const payable = useMemo(() => {
    const fee = Number(form.admissionFee || 0) || 0;
    if (!form.discountOn) return fee;
    const value = Number(form.discountValue || 0) || 0;
    const off = form.discountType === "PERCENT" ? Math.round((fee * value) / 100) : Math.round(value);
    return Math.max(0, fee - Math.max(0, Math.min(off, fee)));
  }, [form.admissionFee, form.discountOn, form.discountType, form.discountValue]);

  const kitForClass = kit.filter((k) => k.classId === form.classId);
  const kitOther = kit.filter((k) => k.classId !== form.classId);
  const tickedNow = Object.values(kitNow).filter(Boolean).length;
  const tickedLater = Object.values(kitLater).filter(Boolean).length;

  const submit = async () => {
    setError("");
    if (!form.name.trim()) return setError("Student name is required.");
    if (!form.classId) return setError("Choose the class the student is joining.");
    if (form.createGuardian && !form.guardianEmail.trim()) return setError("A guardian email is needed to create the login.");
    if (form.discountOn && Number(form.discountValue) > 0 && form.discountType === "FIXED" && Number(form.discountValue) > Number(form.admissionFee)) {
      return setError("The discount is more than the admission fee.");
    }
    setSaving(true);
    try {
      const payload = {
        student: {
          name: form.name, nameBn: form.nameBn, admissionNo: form.admissionNo, dob: form.dob,
          gender: form.gender, bloodGroup: form.bloodGroup, religion: form.religion, roll: form.roll,
          registrationNo: form.registrationNo, classId: form.classId, sectionId: form.sectionId,
          address: form.address, medicalInfo: form.medicalInfo, photoUrl: form.photoUrl,
          birthCertificateNo: form.birthCertificateNo, previousSchoolName: form.previousSchoolName,
          previousClass: form.previousClass, previousSchoolAddress: form.previousSchoolAddress,
          leavingReason: form.leavingReason,
        },
        guardian: {
          name: form.guardianName, phone: form.guardianPhone, email: form.guardianEmail,
          relation: form.guardianRelation, emergencyContact: form.emergencyContact,
          createLogin: form.createGuardian, password: form.guardianPassword,
        },
        sibling: { siblingId: siblingId || null },
        fees: {
          admissionFee: Number(form.admissionFee || 0),
          monthlyFee: Number(form.monthlyFee || 0),
          createMonthly: form.createMonthly,
        },
        discount: form.discountOn && Number(form.discountValue) > 0
          ? { type: form.discountType, value: Number(form.discountValue), reason: form.discountReason, reasonNote: form.discountNote }
          : null,
        payment: { collect: form.collect, method: form.method, refNo: form.refNo },
        kit: {
          issue: Object.entries(kitNow).filter(([, on]) => on).map(([id]) => id),
          pending: Object.entries(kitLater).filter(([, on]) => on).map(([id]) => id),
          uniformSize: form.uniformSize,
          idCardIssued: form.idCardIssued,
        },
      };
      const res = await api("/api/admissions/intake", { method: "POST", body: JSON.stringify(payload) });
      setCreated(res);
    } catch (e: any) {
      setError(e?.message || "Admission failed");
    } finally {
      setSaving(false);
    }
  };

  // ------------------------------------------------------------------ success
  if (created) {
    return (
      <div className="mx-auto max-w-3xl">
        <div className="card fade-up p-7">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-emerald-100 text-emerald-600">
              <Check size={24} />
            </div>
            <div className="min-w-0">
              <h2 className="text-xl font-black text-slate-900">Student admitted</h2>
              <p className="text-sm text-slate-500">
                {form.name} · {created.admissionNo} · {created.classRoom?.name || "—"}
              </p>
            </div>
          </div>

          {/* what the system did */}
          <div className="mt-5 rounded-xl border border-emerald-100 bg-emerald-50 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-emerald-700">Done automatically</p>
            <ul className="mt-1.5 space-y-1 text-xs text-emerald-800">
              {(created.done || []).map((d: string) => (
                <li key={d} className="flex items-start gap-2"><Check size={13} className="mt-0.5 shrink-0" /> {d}</li>
              ))}
            </ul>
          </div>

          {(created.pending || []).length > 0 && (
            <div className="mt-3 rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-amber-700">
                <TriangleAlert size={13} /> Still to do
              </p>
              <ul className="mt-1.5 space-y-1 text-xs text-amber-800">
                {(created.pending || []).map((p: string) => <li key={p}>• {p}</li>)}
              </ul>
            </div>
          )}

          {/* money + kit at a glance */}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Admission fee</p>
              <p className="mt-0.5 text-sm font-bold text-slate-800">{fmtMoney(created.fees?.admissionFee || 0)}</p>
              {created.fees?.discountAmount > 0 && (
                <p className="text-[10px] font-semibold text-rose-600">− {fmtMoney(created.fees.discountAmount)} discount</p>
              )}
              <p className="mt-1 text-[11px] font-semibold text-slate-600">
                {created.payment ? `Paid ${fmtMoney(created.payment.amount)} · ${created.payment.method}` : "Not collected yet"}
              </p>
              {created.payment?.receiptNo && (
                <p className="mt-0.5 flex items-center gap-1 text-[10px] font-bold text-emerald-700">
                  <Receipt size={11} /> {created.payment.receiptNo}
                </p>
              )}
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Guardian login</p>
              <p className="mt-0.5 text-sm font-bold text-slate-800">
                {created.guardian?.linked ? (created.guardian.created ? "Created" : "Reused existing") : "Not created"}
              </p>
              {created.guardian?.email && <p className="text-[11px] text-slate-500">{created.guardian.email}</p>}
              {created.family && (
                <p className="mt-1 flex items-center gap-1 text-[11px] font-semibold text-indigo-600">
                  <Users size={11} /> Family with {created.family.siblingName}
                </p>
              )}
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <p className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Kit handed over</p>
              <p className="mt-0.5 text-sm font-bold text-slate-800">{(created.kit?.issued || []).length} item(s)</p>
              {(created.kit?.issued || []).length > 0 && (
                <p className="text-[11px] text-slate-500">{(created.kit.issued || []).map((k: any) => k.title).join(", ")}</p>
              )}
              {(created.kit?.unavailable || []).length > 0 && (
                <p className="mt-1 flex items-start gap-1 text-[11px] font-semibold text-rose-600">
                  <CircleAlert size={11} className="mt-0.5 shrink-0" />
                  Out of stock: {(created.kit.unavailable || []).map((k: any) => k.title).join(", ")}
                </p>
              )}
            </div>
          </div>

          {/* QR credentials */}
          <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-indigo-50 p-4">
              <div className="flex items-center justify-center gap-1.5 text-xs font-bold text-indigo-600"><QrCode size={13} /> QR token</div>
              <div className="mt-1 break-all font-mono text-[10px] text-indigo-800">{created.qrToken}</div>
            </div>
            <div className="rounded-xl bg-violet-50 p-4">
              <div className="text-xs font-bold text-violet-600">QR PIN (guardian verification)</div>
              <div className="mt-1 text-2xl font-black tracking-widest text-violet-800">{created.qrPin}</div>
            </div>
          </div>

          <div className="mt-6 flex flex-wrap gap-2">
            <Link href={`/print/admission-receipt/${created.admissionId}`} className="btn btn-primary">
              <Receipt size={15} /> Print receipt
            </Link>
            <Link href={`/print/id-card/${created.studentId}`} className="btn btn-secondary">
              <IdCard size={15} /> ID card
            </Link>
            <Link href={`/dashboard/students/${created.studentId}`} className="btn btn-secondary">View profile</Link>
            {successHref && <Link href={successHref} className="btn btn-secondary">{successLabel || "Back"}</Link>}
            <button
              className="btn btn-ghost"
              onClick={() => { setCreated(null); setForm(initial); setSiblingId(""); setKitNow({}); setKitLater({}); loadIntake(); }}
            >
              Admit another
            </button>
          </div>
        </div>
      </div>
    );
  }

  // --------------------------------------------------------------------- form
  const kitRow = (k: KitItem) => {
    const out = k.available <= 0;
    const now = !!kitNow[k.id];
    const later = !!kitLater[k.id];
    return (
      <div
        key={k.id}
        className={`flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-xs ${
          out ? "border-slate-200 bg-slate-50 opacity-70" : now ? "border-emerald-200 bg-emerald-50" : later ? "border-amber-200 bg-amber-50" : "border-slate-200"
        }`}
      >
        <span className="min-w-0 flex-1 truncate font-semibold text-slate-700">{k.title}</span>
        <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k.type}</span>
        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${out ? "bg-rose-100 text-rose-700" : "bg-emerald-100 text-emerald-700"}`}>
          {out ? "0 available — can't distribute" : `${k.available} available`}
        </span>
        <label className={`flex shrink-0 items-center gap-1.5 font-semibold ${out ? "text-slate-400" : "text-slate-600"}`}>
          <input type="checkbox" disabled={out} checked={now} onChange={() => toggleNow(k.id)} /> Hand over now
        </label>
        <label className="flex shrink-0 items-center gap-1.5 font-semibold text-slate-600">
          <input type="checkbox" checked={later} onChange={() => toggleLater(k.id)} /> Later
        </label>
      </div>
    );
  };

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={<Link href={cancelHref} className="btn btn-secondary btn-sm"><ArrowLeft size={14} /> {cancelLabel}</Link>}
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      {/* ------------------------------------------------------------- student */}
      <Card>
        <CardHeader title="Student information" />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <Field label="Full name *"><TextInput value={form.name} onChange={(e) => set("name", e.target.value)} /></Field>
          <Field label="Full name (Bangla)"><TextInput value={form.nameBn} onChange={(e) => set("nameBn", e.target.value)} /></Field>
          <Field label="Admission number"><TextInput value={form.admissionNo} onChange={(e) => set("admissionNo", e.target.value)} placeholder="auto-generated if blank" /></Field>
          <Field label="Registration no."><TextInput value={form.registrationNo} onChange={(e) => set("registrationNo", e.target.value)} /></Field>
          <Field label="Date of birth"><TextInput type="date" value={form.dob} onChange={(e) => set("dob", e.target.value)} /></Field>
          <Field label="Birth certificate no."><TextInput value={form.birthCertificateNo} onChange={(e) => set("birthCertificateNo", e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Gender">
              <Select value={form.gender} onChange={(e) => set("gender", e.target.value)}>
                <option>MALE</option><option>FEMALE</option><option>OTHER</option>
              </Select>
            </Field>
            <Field label="Blood group">
              <Select value={form.bloodGroup} onChange={(e) => set("bloodGroup", e.target.value)}>
                {BLOOD.map((b) => <option key={b}>{b}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Religion">
            <Select value={form.religion} onChange={(e) => set("religion", e.target.value)}>
              <option>ISLAM</option><option>HINDU</option><option>CHRISTIAN</option><option>BUDDHIST</option><option>OTHERS</option>
            </Select>
          </Field>
          <Field label="Class *" hint="Decides the fee defaults and the kit list">
            <Select value={form.classId} onChange={(e) => { set("classId", e.target.value); set("sectionId", ""); loadIntake(e.target.value); }}>
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
          <Field label="Roll"><TextInput type="number" value={form.roll} onChange={(e) => set("roll", e.target.value)} /></Field>
          <Field label="Address" className="sm:col-span-2"><Textarea value={form.address} onChange={(e) => set("address", e.target.value)} /></Field>
          <Field label="Medical information (optional)" className="sm:col-span-2"><Textarea value={form.medicalInfo} onChange={(e) => set("medicalInfo", e.target.value)} /></Field>
        </div>
      </Card>

      {/* ------------------------------------------------------- previous school */}
      <Card className="mt-5">
        <CardHeader title="Previous school" />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <Field label="School name"><TextInput value={form.previousSchoolName} onChange={(e) => set("previousSchoolName", e.target.value)} /></Field>
          <Field label="Last class attended"><TextInput value={form.previousClass} onChange={(e) => set("previousClass", e.target.value)} /></Field>
          <Field label="School address" className="sm:col-span-2"><TextInput value={form.previousSchoolAddress} onChange={(e) => set("previousSchoolAddress", e.target.value)} /></Field>
          <Field label="Reason for leaving" className="sm:col-span-2"><TextInput value={form.leavingReason} onChange={(e) => set("leavingReason", e.target.value)} /></Field>
        </div>
      </Card>

      {/* ------------------------------------------------------------ guardian */}
      <Card className="mt-5">
        <CardHeader title="Guardian information" />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <Field label="Guardian name"><TextInput value={form.guardianName} onChange={(e) => set("guardianName", e.target.value)} /></Field>
          <Field label="Relation">
            <Select value={form.guardianRelation} onChange={(e) => set("guardianRelation", e.target.value)}>
              <option>Father</option><option>Mother</option><option>Guardian</option><option>Other</option>
            </Select>
          </Field>
          <Field label="Phone" hint="Also used to spot an already-enrolled sibling"><TextInput value={form.guardianPhone} onChange={(e) => set("guardianPhone", e.target.value)} placeholder="+880 1XXX-XXXXXX" /></Field>
          <Field label="Emergency contact"><TextInput value={form.emergencyContact} onChange={(e) => set("emergencyContact", e.target.value)} /></Field>
          <Field label="Email" className="sm:col-span-2" hint="Used for the guardian login account">
            <TextInput type="email" value={form.guardianEmail} onChange={(e) => set("guardianEmail", e.target.value)} placeholder="guardian@email.com" />
          </Field>
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2.5 text-sm text-slate-700">
              <input type="checkbox" checked={form.createGuardian} onChange={(e) => set("createGuardian", e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              Create a guardian login account for the parents app
            </label>
            {form.createGuardian && (
              <div className="mt-3 max-w-xs">
                <Field label="Initial password"><TextInput value={form.guardianPassword} onChange={(e) => set("guardianPassword", e.target.value)} /></Field>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------------- sibling */}
      <Card className="mt-5">
        <CardHeader title="Sibling already studying here?" subtitle="Links the family so one login sees every child, and opens the sibling discount" />
        <div className="p-5">
          <div className="relative max-w-md">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <TextInput className="!pl-9" placeholder="Search by name, admission no or guardian phone…" value={siblingQuery} onChange={(e) => setSiblingQuery(e.target.value)} />
          </div>

          {siblings.length > 0 && (
            <div className="mt-3 space-y-2">
              {siblings.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => chooseSibling(s)}
                  className={`flex w-full flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-left text-xs ${
                    siblingId === s.id ? "border-indigo-300 bg-indigo-50" : "border-slate-200 hover:border-indigo-200"
                  }`}
                >
                  <Users size={14} className={siblingId === s.id ? "text-indigo-600" : "text-slate-400"} />
                  <span className="font-bold text-slate-800">{s.name}</span>
                  <span className="text-slate-500">{s.admissionNo}</span>
                  <span className="text-slate-500">{s.classRoom?.name || "—"}{s.section ? ` / ${s.section.name}` : ""}</span>
                  {s.guardianPhone && <span className="ml-auto text-slate-400">{s.guardianPhone}</span>}
                  {siblingId === s.id && <Badge tone="green">selected</Badge>}
                </button>
              ))}
            </div>
          )}
          {!siblings.length && (siblingQuery || form.guardianPhone) && (
            <p className="mt-3 text-xs text-slate-400">No matching student — this looks like a first admission for this family.</p>
          )}
        </div>
      </Card>

      {/* -------------------------------------------------------- fees & money */}
      <Card className="mt-5">
        <CardHeader title="Fees, discount & payment" />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
          <Field
            label="Admission fee (৳)"
            hint={
              defaults?.source === "class-template"
                ? `From the class's fee template${defaults.templateName ? ` — ${defaults.templateName}` : ""}`
                : defaults?.source === "school-settings"
                  ? "From the school's fee settings"
                  : "App default — set yours in Fees"
            }
          >
            <TextInput type="number" value={form.admissionFee} onChange={(e) => set("admissionFee", e.target.value)} />
          </Field>
          <Field label="Monthly fee (৳)" hint="Raised together with the admission fee">
            <TextInput type="number" value={form.monthlyFee} onChange={(e) => set("monthlyFee", e.target.value)} disabled={!form.createMonthly} />
          </Field>
          <div className="sm:col-span-2">
            <label className="flex items-center gap-2.5 text-sm text-slate-700">
              <input type="checkbox" checked={form.createMonthly} onChange={(e) => set("createMonthly", e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              Raise the first monthly fee as well
            </label>
          </div>

          {defaults?.extraLines?.length ? (
            <div className="sm:col-span-2 rounded-xl bg-slate-50 p-3 text-xs text-slate-600">
              <p className="font-bold uppercase tracking-wide text-slate-500">Also billed from the class template</p>
              <ul className="mt-1 space-y-0.5">
                {defaults.extraLines.map((l) => (
                  <li key={l.title} className="flex justify-between gap-3"><span>{l.title}</span><span className="font-semibold">{fmtMoney(l.amount)}</span></li>
                ))}
              </ul>
            </div>
          ) : null}

          {/* discount */}
          <div className="sm:col-span-2 rounded-xl border border-slate-200 p-4">
            <label className="flex items-center gap-2.5 text-sm font-semibold text-slate-700">
              <input type="checkbox" checked={form.discountOn} onChange={(e) => set("discountOn", e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              <Wallet size={15} /> Apply a discount / scholarship
            </label>
            {form.discountOn && (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-4">
                <Field label="Type">
                  <Select value={form.discountType} onChange={(e) => set("discountType", e.target.value)}>
                    <option value="PERCENT">Percent</option><option value="FIXED">Fixed (৳)</option>
                  </Select>
                </Field>
                <Field label="Value"><TextInput type="number" value={form.discountValue} onChange={(e) => set("discountValue", e.target.value)} /></Field>
                <Field label="Reason">
                  <Select value={form.discountReason} onChange={(e) => set("discountReason", e.target.value)}>
                    <option>SIBLING</option><option>MERIT</option><option>STAFF_CHILD</option><option>FINANCIAL_HARDSHIP</option><option>OTHER</option>
                  </Select>
                </Field>
                <Field label="Note (optional)"><TextInput value={form.discountNote} onChange={(e) => set("discountNote", e.target.value)} /></Field>
                <p className="sm:col-span-4 text-[11px] font-semibold text-slate-500">
                  {me?.user?.role === "SCHOOL_ADMIN" || me?.user?.role === "BRANCH_ADMIN"
                    ? "As an admin this discount is applied immediately."
                    : "This discount will be recorded as proposed — an admin or principal must approve it."}
                </p>
              </div>
            )}
          </div>

          {/* payment */}
          <div className="sm:col-span-2 rounded-xl border border-slate-200 p-4">
            <label className="flex items-center gap-2.5 text-sm font-semibold text-slate-700">
              <input type="checkbox" checked={form.collect} onChange={(e) => set("collect", e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
              Collect the admission fee now
            </label>
            {form.collect && (
              <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Method">
                  <Select value={form.method} onChange={(e) => set("method", e.target.value)}>
                    <option value="CASH">Cash</option><option value="BKASH">bKash</option><option value="NAGAD">Nagad</option>
                    <option value="ROCKET">Rocket</option><option value="BANK">Bank</option><option value="CARD">Card</option>
                  </Select>
                </Field>
                <Field label="Reference no. (optional)"><TextInput value={form.refNo} onChange={(e) => set("refNo", e.target.value)} /></Field>
                <div className="flex flex-col justify-center text-xs">
                  <span className="font-bold uppercase tracking-wide text-slate-400">Collecting</span>
                  <span className="text-lg font-black text-emerald-700">{fmtMoney(payable)}</span>
                  {form.discountOn && form.discountType === "FIXED" && Number(form.discountValue) > 0 && (
                    <span className="text-[10px] text-slate-400">a proposed discount needs approval before it counts</span>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </Card>

      {/* ------------------------------------------------------------------ kit */}
      <Card className="mt-5">
        <CardHeader
          title="Books, uniform & ID card"
          subtitle={
            kit.length
              ? `${tickedNow} to hand over now · ${tickedLater} kept pending · live stock shown per item`
              : "Nothing in the inventory catalogue yet — add books or uniforms in Library & Books"
          }
        />
        <div className="space-y-4 p-5">
          {kitForClass.length > 0 && (
            <div>
              <p className="mb-2 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-slate-500">
                <Package size={13} /> This class&apos;s kit{cls ? ` — ${cls.name}` : ""}
              </p>
              <div className="space-y-2">{kitForClass.map(kitRow)}</div>
            </div>
          )}
          {kitOther.length > 0 && (
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Other catalogue items</p>
              <div className="space-y-2">{kitOther.map(kitRow)}</div>
            </div>
          )}
          {kit.length > 0 && (
            <div className="flex flex-wrap items-end gap-3 border-t border-slate-100 pt-4">
              <Field label="Uniform size"><TextInput className="!w-32" placeholder="e.g. M / 32" value={form.uniformSize} onChange={(e) => set("uniformSize", e.target.value)} /></Field>
              <label className="flex items-center gap-2 pb-2 text-sm font-semibold text-slate-700">
                <input type="checkbox" checked={form.idCardIssued} onChange={(e) => set("idCardIssued", e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500" />
                ID card printed
              </label>
            </div>
          )}
        </div>
      </Card>

      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        <Link href={cancelHref} className="btn btn-secondary">Cancel</Link>
        <button className="btn btn-primary !px-6" onClick={submit} disabled={saving || !form.name || !form.classId}>
          <Save size={15} /> {saving ? "Admitting…" : "Admit student"}
        </button>
      </div>
      <p className="mt-2 text-right text-[11px] text-slate-400">
        Creates the student, the guardian login, the family link, the fees, the payment and the kit in one go.
      </p>
    </div>
  );
}
