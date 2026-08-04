"use client";

import { useEffect, useState } from "react";
import { Wallet, Plus, Search, Save, Receipt } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Card, Badge, Field, TextInput, Select, Modal, PageHeader, LoadingScreen, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate } from "@/lib/utils";

interface FeeRow {
  id: string; title: string; feeType: string; amount: string; paidAmount: string; status: string; dueDate: string | null;
  student: { id: string; name: string; admissionNo: string; classRoom: { name: string } | null; section: { name: string } | null };
  payments: { id: string; amount: string; method: string; date: string; receiptNo: string | null }[];
}

export default function FeesPage() {
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [settings, setSettings] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [payOpen, setPayOpen] = useState<string | null>(null);
  const [payAmount, setPayAmount] = useState("");
  const [payMethod, setPayMethod] = useState("CASH");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [error, setError] = useState("");

  const load = (filters = { status: status || undefined, q: q || undefined }) =>
    api<{ fees: FeeRow[]; settings: any }>(`/api/fees${qs(filters)}`).then((d) => { setFees(d.fees); setSettings(d.settings); }).finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const apply = () => { setLoading(true); load(); };

  const pay = async () => {
    setError("");
    try {
      await api(`/api/fees/${payOpen}/pay`, { method: "POST", body: JSON.stringify({ amount: Number(payAmount), method: payMethod }) });
      setPayOpen(null);
      setPayAmount("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading) return <LoadingScreen />;

  const dueTotal = fees.reduce((a, f) => a + (Number(f.amount) - Number(f.paidAmount)), 0);
  const collected = fees.reduce((a, f) => a + Number(f.paidAmount), 0);
  const paying = fees.find((f) => f.id === payOpen);

  return (
    <div>
      <PageHeader
        title="Fees"
        subtitle={`${fmtMoney(collected)} collected · ${fmtMoney(dueTotal)} outstanding`}
        actions={<button className="btn btn-secondary btn-sm" onClick={() => setSettingsOpen(true)}><Save size={14} /> Fee settings</button>}
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="relative sm:col-span-2">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <TextInput className="!pl-9" placeholder="Search by student…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} />
          </div>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All statuses</option>
            <option>UNPAID</option><option>PARTIAL</option><option>PAID</option>
          </Select>
          <button className="btn btn-primary" onClick={apply}>Filter</button>
        </div>
      </Card>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Student</th>
                <th className="th">Fee</th>
                <th className="th">Amount</th>
                <th className="th">Paid</th>
                <th className="th">Due</th>
                <th className="th">Status</th>
                <th className="th">Receipt</th>
                <th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {fees.map((f) => {
                const due = Number(f.amount) - Number(f.paidAmount);
                return (
                  <tr key={f.id} className="tr-hover">
                    <td className="td">
                      <div className="font-bold text-slate-800">{f.student.name}</div>
                      <div className="text-xs text-slate-400">{f.student.classRoom?.name} {f.student.section?.name ? `/ ${f.student.section.name}` : ""}</div>
                    </td>
                    <td className="td">
                      <div className="font-semibold text-slate-700">{f.title}</div>
                      <div className="text-[11px] text-slate-400">{f.feeType}</div>
                    </td>
                    <td className="td font-semibold">{fmtMoney(f.amount)}</td>
                    <td className="td">{fmtMoney(f.paidAmount)}</td>
                    <td className="td font-bold">{due > 0 ? <span className="text-rose-600">{fmtMoney(due)}</span> : <span className="text-emerald-600">—</span>}</td>
                    <td className="td"><Badge tone={statusTone(f.status)}>{prettyStatus(f.status)}</Badge></td>
                    <td className="td">
                      {f.payments[0] ? (
                        <span className="inline-flex items-center gap-1 text-xs text-slate-500"><Receipt size={12} /> {f.payments[0].receiptNo}</span>
                      ) : "—"}
                    </td>
                    <td className="td">
                      <div className="flex justify-end">
                        {due > 0 && (
                          <button className="btn btn-primary btn-sm" onClick={() => { setPayOpen(f.id); setPayAmount(String(due)); }}>
                            <Wallet size={13} /> Collect
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!fees.length && <div className="py-10 text-center text-sm text-slate-400">No fee records.</div>}
      </Card>

      {/* payment modal */}
      <Modal open={!!payOpen} onClose={() => setPayOpen(null)} title="Collect payment">
        {paying && (
          <div className="space-y-4">
            <div className="rounded-xl bg-slate-50 p-4 text-sm">
              <div className="font-bold text-slate-800">{paying.student.name}</div>
              <div className="text-xs text-slate-500">{paying.title} · {fmtMoney(paying.amount)} total · {fmtMoney(paying.paidAmount)} paid</div>
            </div>
            <Field label="Amount (৳)"><TextInput type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} /></Field>
            <Field label="Method">
              <Select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                <option>CASH</option><option>BANK</option><option>bKASH</option><option>NAGAD</option><option>CARD</option>
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <button className="btn btn-secondary" onClick={() => setPayOpen(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={pay} disabled={!Number(payAmount) || Number(payAmount) <= 0}>Record payment</button>
            </div>
          </div>
        )}
      </Modal>

      {/* settings modal */}
      <Modal open={settingsOpen} onClose={() => setSettingsOpen(false)} title="Fee settings">
        <div className="space-y-4">
          <Field label="Monthly fee (৳)">
            <TextInput type="number" value={settings?.monthlyFee ?? ""} onChange={(e) => setSettings({ ...settings, monthlyFee: e.target.value })} />
          </Field>
          <Field label="Admission fee (৳)">
            <TextInput type="number" value={settings?.admissionFee ?? ""} onChange={(e) => setSettings({ ...settings, admissionFee: e.target.value })} />
          </Field>
          <p className="text-xs text-slate-400">These defaults apply to new fee records created at admission.</p>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setSettingsOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={async () => { await api("/api/fees/settings", { method: "POST", body: JSON.stringify(settings) }); setSettingsOpen(false); load(); }}>
              Save settings
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
