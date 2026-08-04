"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, QrCode, IdCard, FileText, Pencil, Trash2, Save, X, KeyRound } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, Select, PageHeader, LoadingScreen, ErrorNote, Modal, statusTone, prettyStatus } from "@/components/ui";
import { initials, fmtMoney, fmtDate } from "@/lib/utils";

export default function StudentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [s, setS] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState(false);
  const [pinModal, setPinModal] = useState(false);
  const [newPin, setNewPin] = useState("");
  const [error, setError] = useState("");
  const [form, setForm] = useState<any>({});

  const load = () => api(`/api/students/${id}`).then((d: any) => { setS(d); setForm({ ...d, dob: d.dob ? d.dob.slice(0, 10) : "" }); }).finally(() => setLoading(false));
  useEffect(() => { load(); }, [id]);

  if (loading) return <LoadingScreen />;
  if (!s) return <div className="p-10 text-center">Student not found</div>;

  const attendance = s.attendance || [];
  const presentCount = attendance.filter((a: any) => a.status === "PRESENT" || a.status === "LATE").length;
  const attRate = attendance.length ? Math.round((presentCount / attendance.length) * 100) : 0;
  const debt = s.fees.reduce((a: number, f: any) => a + (Number(f.amount) - Number(f.paidAmount)), 0);

  const saveEdit = async () => {
    setError("");
    try {
      await api(`/api/students/${id}`, { method: "PATCH", body: JSON.stringify(form) });
      setEdit(false);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const savePin = async () => {
    await api(`/api/students/${id}`, { method: "PATCH", body: JSON.stringify({ qrPin: newPin }) });
    setPinModal(false);
    load();
  };

  const deactivate = async () => {
    await api(`/api/students/${id}`, { method: "PATCH", body: JSON.stringify({ active: !s.active }) });
    load();
  };

  const infoRows: [string, any][] = [
    ["Admission no.", s.admissionNo], ["Roll", s.roll], ["Registration", s.registrationNo],
    ["Date of birth", fmtDate(s.dob)], ["Gender", s.gender], ["Blood group", s.bloodGroup?.replace("_", "+")],
    ["Religion", s.religion], ["Admission date", fmtDate(s.admissionDate)],
    ["Guardian", s.guardianName], ["Relation", s.guardianRelation], ["Guardian phone", s.guardianPhone],
    ["Guardian email", s.guardianEmail], ["Emergency", s.emergencyContact], ["Address", s.address],
  ];

  return (
    <div>
      <PageHeader
        title={s.name}
        subtitle={`${s.school?.name} · ${s.classRoom?.name || "—"}${s.section ? ` · Section ${s.section.name}` : ""} · ${s.admissionNo}`}
        actions={
          <>
            <Link href="/dashboard/students" className="btn btn-secondary btn-sm"><ArrowLeft size={14} /> Students</Link>
            {!edit && <button className="btn btn-secondary btn-sm" onClick={() => setEdit(true)}><Pencil size={14} /> Edit</button>}
            <Link href={`/print/id-card/${s.id}`} className="btn btn-primary btn-sm"><IdCard size={14} /> ID Card</Link>
          </>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* left column */}
        <div className="space-y-6">
          <Card className="p-5 text-center">
            {s.photoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={s.photoUrl} alt="" className="mx-auto h-28 w-28 rounded-2xl object-cover ring-4 ring-indigo-50" />
            ) : (
              <div className="mx-auto flex h-28 w-28 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 text-4xl font-black text-white">{initials(s.name)}</div>
            )}
            <h3 className="mt-3 text-lg font-black text-slate-900">{s.name}</h3>
            <div className="mt-1 flex items-center justify-center gap-2 text-xs text-slate-500">
              <Badge tone={s.active ? "green" : "red"}>{s.active ? "Active" : "Inactive"}</Badge>
              <span>{s.classRoom?.name} {s.section?.name}</span>
            </div>
            <button onClick={deactivate} className="btn btn-ghost btn-sm mt-3 text-rose-500 hover:bg-rose-50">
              {s.active ? "Deactivate student" : "Activate student"}
            </button>
          </Card>

          {/* QR credentials */}
          <Card>
            <CardHeader title="QR Guardian Access" subtitle="Shown on the printed ID card" />
            <div className="space-y-3 p-5">
              <div className="flex items-start gap-3 rounded-xl bg-indigo-50 p-3">
                <QrCode size={17} className="mt-0.5 shrink-0 text-indigo-600" />
                <div className="min-w-0">
                  <div className="text-[11px] font-bold uppercase tracking-wide text-indigo-600">QR token</div>
                  <div className="break-all font-mono text-[11px] text-indigo-900">{s.qrToken}</div>
                </div>
              </div>
              <div className="flex items-center justify-between rounded-xl bg-violet-50 p-3">
                <div className="flex items-center gap-2.5">
                  <KeyRound size={17} className="text-violet-600" />
                  <div>
                    <div className="text-[11px] font-bold uppercase tracking-wide text-violet-600">Guardian PIN</div>
                    <div className="font-mono text-lg font-black tracking-[0.4em] text-violet-900">{s.qrPin}</div>
                  </div>
                </div>
                <button className="btn btn-secondary btn-sm" onClick={() => { setNewPin(""); setPinModal(true); }}>Reset</button>
              </div>
              <Link href={`/qr/${s.qrToken}`} className="btn btn-secondary btn-sm w-full">Open QR login page</Link>
            </div>
          </Card>

          {/* attendance card */}
          <Card>
            <CardHeader title="Attendance" subtitle="Last 30 records" action={<Badge tone={attRate >= 80 ? "green" : "amber"}>{attRate}%</Badge>} />
            <div className="grid grid-cols-3 gap-2 p-4">
              {["PRESENT", "ABSENT", "LATE", "LEAVE"].map((st) => {
                const count = attendance.filter((a: any) => a.status === st).length;
                return (
                  <div key={st} className="rounded-xl bg-slate-50 p-3 text-center">
                    <div className="text-lg font-black text-slate-800">{count}</div>
                    <div className="text-[10px] font-bold uppercase text-slate-400">{st}</div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>

        {/* right column */}
        <div className="space-y-6 lg:col-span-2">
          <Card>
            <CardHeader title="Profile" subtitle={edit ? "Editing…" : "Student & guardian details"} />
            {!edit ? (
              <div className="grid grid-cols-1 gap-x-8 gap-y-3 p-5 text-sm sm:grid-cols-2">
                {infoRows.map(([k, v]) => (
                  <div key={k}>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                    <div className="mt-0.5 font-semibold text-slate-700">{v || "—"}</div>
                  </div>
                ))}
                {s.medicalInfo && (
                  <div className="sm:col-span-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Medical info</div>
                    <div className="mt-0.5 font-semibold text-amber-700">{s.medicalInfo}</div>
                  </div>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-2">
                <Field label="Name"><TextInput value={form.name || ""} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
                <Field label="Admission no."><TextInput value={form.admissionNo || ""} onChange={(e) => setForm({ ...form, admissionNo: e.target.value })} /></Field>
                <Field label="Roll"><TextInput type="number" value={form.roll || ""} onChange={(e) => setForm({ ...form, roll: e.target.value })} /></Field>
                <Field label="DOB"><TextInput type="date" value={form.dob} onChange={(e) => setForm({ ...form, dob: e.target.value })} /></Field>
                <Field label="Gender">
                  <Select value={form.gender} onChange={(e) => setForm({ ...form, gender: e.target.value })}>
                    <option>MALE</option><option>FEMALE</option><option>OTHER</option>
                  </Select>
                </Field>
                <Field label="Blood group">
                  <Select value={form.bloodGroup || ""} onChange={(e) => setForm({ ...form, bloodGroup: e.target.value })}>
                    <option value="">—</option>
                    {["A_POS", "A_NEG", "B_POS", "B_NEG", "AB_POS", "AB_NEG", "O_POS", "O_NEG"].map((b) => <option key={b}>{b}</option>)}
                  </Select>
                </Field>
                <Field label="Guardian name"><TextInput value={form.guardianName || ""} onChange={(e) => setForm({ ...form, guardianName: e.target.value })} /></Field>
                <Field label="Guardian phone"><TextInput value={form.guardianPhone || ""} onChange={(e) => setForm({ ...form, guardianPhone: e.target.value })} /></Field>
                <Field label="Guardian email"><TextInput value={form.guardianEmail || ""} onChange={(e) => setForm({ ...form, guardianEmail: e.target.value })} /></Field>
                <Field label="Emergency"><TextInput value={form.emergencyContact || ""} onChange={(e) => setForm({ ...form, emergencyContact: e.target.value })} /></Field>
                <Field label="Address" className="sm:col-span-2"><TextInput value={form.address || ""} onChange={(e) => setForm({ ...form, address: e.target.value })} /></Field>
                <div className="flex justify-end gap-2 sm:col-span-2">
                  <button className="btn btn-secondary btn-sm" onClick={() => setEdit(false)}><X size={14} /> Cancel</button>
                  <button className="btn btn-primary btn-sm" onClick={saveEdit}><Save size={14} /> Save</button>
                </div>
              </div>
            )}
          </Card>

          {/* remarks */}
          <Card>
            <CardHeader title="Recent teacher remarks" subtitle="From the daily remark module" />
            <div className="divide-y divide-slate-100">
              {s.remarks?.length ? s.remarks.map((r: any) => (
                <div key={r.id} className="flex items-start justify-between gap-4 px-5 py-3">
                  <div>
                    <Badge tone={statusTone(r.rating)}>{prettyStatus(r.rating)}</Badge>
                    <p className="mt-1.5 text-sm text-slate-600">{r.note || "No note"}</p>
                    <p className="mt-0.5 text-[11px] text-slate-400">{r.teacher?.user?.name} · {fmtDate(r.date)}</p>
                  </div>
                </div>
              )) : <div className="px-5 py-6 text-center text-sm text-slate-400">No remarks yet.</div>}
            </div>
          </Card>

          {/* fees */}
          <Card>
            <CardHeader title="Fees" subtitle={`Total due: ${fmtMoney(debt)}`} action={<Link href="/dashboard/fees" className="btn btn-ghost btn-sm">All fees</Link>} />
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr><th className="th">Title</th><th className="th">Type</th><th className="th">Amount</th><th className="th">Paid</th><th className="th">Status</th></tr>
                </thead>
                <tbody>
                  {s.fees.map((f: any) => (
                    <tr key={f.id}>
                      <td className="td font-semibold text-slate-800">{f.title}</td>
                      <td className="td"><Badge tone="slate">{f.feeType}</Badge></td>
                      <td className="td font-semibold">{fmtMoney(f.amount)}</td>
                      <td className="td">{fmtMoney(f.paidAmount)}</td>
                      <td className="td"><Badge tone={statusTone(f.status)}>{prettyStatus(f.status)}</Badge></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      </div>

      <Modal open={pinModal} onClose={() => setPinModal(false)} title="Reset guardian PIN">
        <div className="space-y-4">
          <Field label="New 4–6 digit PIN">
            <TextInput value={newPin} onChange={(e) => setNewPin(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" placeholder="1234" />
          </Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary btn-sm" onClick={() => setPinModal(false)}>Cancel</button>
            <button className="btn btn-primary btn-sm" onClick={savePin} disabled={newPin.length < 4}>Save PIN</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
