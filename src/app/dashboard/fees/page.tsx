"use client";

import { useEffect, useState } from "react";
import { Wallet, Plus, Search, Save, Receipt, Scale, Coins } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Badge, Field, TextInput, Select, Modal, PageHeader, LoadingScreen, ErrorNote, KpiCard, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate, money, feeDue, sumMoney } from "@/lib/utils";

interface FeeRow {
  id: string; title: string; feeType: string; amount: string; paidAmount: string; status: string; dueDate: string | null;
  student: { id: string; name: string; admissionNo: string; classRoom: { name: string } | null; section: { name: string } | null };
  payments: { id: string; amount: string; method: string; date: string; receiptNo: string | null }[];
}

interface StudentLite { id: string; name: string; admissionNo: string; classRoom?: { name: string } | null }

const EMPTY_ADD = { studentId: "", title: "", feeType: "MONTHLY", amount: "", dueDate: "", installments: "1" };

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
  const [branchId, setBranchId] = useState("");
  const [branches, setBranches] = useState<{ id: string; name: string }[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addForm, setAddForm] = useState<any>(EMPTY_ADD);
  const [students, setStudents] = useState<StudentLite[]>([]);
  const [busy, setBusy] = useState(false);

  const load = (filters = { status: status || undefined, q: q || undefined, branchId: branchId || undefined }) =>
    api<{ fees: FeeRow[]; settings: any }>(`/api/fees${qs(filters)}`).then((d) => { setFees(d.fees); setSettings(d.settings); }).finally(() => setLoading(false));

  useEffect(() => {
    // Deep link from the branch monitoring panel (?branchId=…).
    const b = new URLSearchParams(window.location.search).get("branchId") || "";
    setBranchId(b);
    load({ status: "", q: "", branchId: b || undefined });
    // Branch filter only resolves for the main admin.
    api<{ id: string; name: string }[]>("/api/branches").then(setBranches).catch(() => null);
  }, []);

  const apply = () => { setLoading(true); load(); };

  const pay = async () => {
    setError("");
    const amt = Number(payAmount) || 0;
    const rowDoc = fees.find((f) => f.id === payOpen);
    const rowDue = rowDoc ? feeDue(rowDoc) : 0;
    if (amt <= 0) { setError("Enter the amount collected."); return; }
    // Part-payment is normal (৳200 against a ৳500 fee); over-paying is not, and
    // the ledger must never record more than the school billed.
    if (amt > rowDue) { setError(`That is more than the ${fmtMoney(rowDue)} still due on this fee.`); return; }
    try {
      await api(`/api/fees/${payOpen}/pay`, { method: "POST", body: JSON.stringify({ amount: amt, method: payMethod }) });
      setPayOpen(null);
      setPayAmount("");
      load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  // The student list is only needed when the create dialog opens (same lazy
  // pattern as the library page) so the fees table stays a single request.
  const openAdd = async () => {
    setError("");
    setAddForm(EMPTY_ADD);
    setAddOpen(true);
    if (!students.length) {
      const list = await api<StudentLite[]>("/api/students").catch(() => []);
      setStudents(list || []);
    }
  };

  const createFee = async () => {
    setError("");
    const amount = Number(addForm.amount);
    if (!addForm.studentId || !addForm.title.trim() || !(amount > 0)) {
      setError("Pick a student, give the fee a title and an amount greater than zero.");
      return;
    }
    setBusy(true);
    try {
      const count = Math.max(1, Math.min(24, Math.floor(Number(addForm.installments) || 1)));
      const body: any = {
        studentId: addForm.studentId,
        title: addForm.title.trim(),
        amount,
        feeType: addForm.feeType,
        dueDate: addForm.dueDate || undefined,
      };
      if (count > 1) {
        // Even split with the rounding remainder on the last installment, so
        // the installment amounts still sum to exactly `amount`.
        const base = Math.floor(amount / count);
        const start = addForm.dueDate ? new Date(addForm.dueDate) : new Date();
        body.installments = Array.from({ length: count }, (_, i) => {
          const d = new Date(start);
          d.setMonth(d.getMonth() + i);
          return { seq: i + 1, amount: i === count - 1 ? amount - base * (count - 1) : base, dueDate: d.toISOString() };
        });
      }
      await api("/api/fees", { method: "POST", body: JSON.stringify(body) });
      setAddOpen(false);
      setAddForm(EMPTY_ADD);
      setLoading(true);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;

  // Sums go through money()/feeDue(): a legacy row with a missing paidAmount is
  // 0, not NaN. One NaN here used to zero the whole header.
  const dueTotal = sumMoney(fees, (f) => feeDue(f));
  const collected = sumMoney(fees, (f) => f.paidAmount);
  const paying = fees.find((f) => f.id === payOpen);
  const payingDue = paying ? feeDue(paying) : 0;
  const payAmt = Number(payAmount) || 0;
  const payOver = payAmt > payingDue;
  const payRemaining = Math.max(0, payingDue - payAmt);

  // Standing figures for the loaded view — presentational sums over the rows
  // already in memory, so no extra read and no changed endpoint.
  const billed = sumMoney(fees, (f) => f.amount);
  const unpaidRows = fees.filter((f) => feeDue(f) > 0).length;
  const metrics = [
    { key: "billed", icon: Receipt, label: "Billed", value: fmtMoney(billed), sub: `${fees.length} records`, tone: "slate" as const },
    { key: "collected", icon: Wallet, label: "Collected", value: fmtMoney(collected), sub: "received to date", tone: "emerald" as const },
    { key: "outstanding", icon: Scale, label: "Outstanding", value: fmtMoney(dueTotal), sub: `${unpaidRows} unpaid records`, tone: "amber" as const },
    { key: "unpaid", icon: Coins, label: "Unpaid rows", value: unpaidRows, sub: "need collection", tone: "amber" as const },
  ];

  return (
    <div>
      <PageHeader
        title="Fees"
        subtitle="Billing, collection and outstanding balances"
        actions={
          <>
            <button className="btn btn-primary btn-sm" onClick={openAdd}><Plus size={14} /> Add fee</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setSettingsOpen(true)}><Save size={14} /> Fee settings</button>
          </>
        }
      />

      {/* standing figures — numbers first, one divided surface */}
      <section className="ss-surface mb-8">
        <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-3 xl:grid-cols-4">
          {metrics.map((m) => (
            <div key={m.key} className="bg-white">
              <KpiCard bare icon={m.icon} label={m.label} value={m.value} sub={m.sub} tone={m.tone} />
            </div>
          ))}
          {/* below four columns an odd cell would show the divider grey, not a figure */}
          <div aria-hidden className="hidden bg-white sm:block xl:hidden" />
          <div aria-hidden className="hidden bg-white sm:block xl:hidden" />
        </div>
      </section>

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      {/* records: one surface — heading, a flat filter toolbar, the table */}
      <section className="ss-surface">
        <div className="ss-section">
          <div className="min-w-0">
            <h3 className="ss-section-title">Fee records</h3>
            <p className="ss-section-sub">{fees.length} in this view</p>
          </div>
        </div>

        <div className="ss-toolbar">
          {branches.length > 0 && (
            <div className="flex w-full items-center gap-3">
              <span className="ss-toolbar-label">Branch</span>
              <Select
                className="max-w-xs"
                value={branchId}
                onChange={(e) => {
                  const v = e.target.value;
                  setBranchId(v);
                  setLoading(true);
                  load({ status: status || undefined, q: q || undefined, branchId: v || undefined });
                }}
              >
                <option value="">All branches (whole school)</option>
                {branches.map((br) => <option key={br.id} value={br.id}>{br.name}</option>)}
              </Select>
            </div>
          )}

          <div className="grid w-full grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="relative sm:col-span-2">
              <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
              <TextInput className="!pl-9" placeholder="Search by student…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && apply()} />
            </div>
            {/* the control and the CTA share the last cells, so the button keeps
                its own width instead of stretching across a grid column */}
            <div className="flex gap-2 sm:col-span-2">
              <Select value={status} onChange={(e) => setStatus(e.target.value)}>
                <option value="">All statuses</option>
                <option>UNPAID</option><option>PARTIAL</option><option>PAID</option>
              </Select>
              <button className="btn btn-primary" onClick={apply}>Filter</button>
            </div>
          </div>
        </div>

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
                const due = feeDue(f);
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
      </section>

      {/* create fee modal */}
      <Modal open={addOpen} onClose={() => { setAddOpen(false); setError(""); }} title="Add a fee">
        <div className="space-y-4">
          {error && <ErrorNote message={error} />}
          <Field label="Student">
            <Select value={addForm.studentId} onChange={(e) => setAddForm({ ...addForm, studentId: e.target.value })}>
              <option value="">Select a student…</option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}{s.classRoom?.name ? ` — ${s.classRoom.name}` : ""}{s.admissionNo ? ` (${s.admissionNo})` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Title">
              <TextInput placeholder="e.g. Monthly Fee — October" value={addForm.title} onChange={(e) => setAddForm({ ...addForm, title: e.target.value })} />
            </Field>
            <Field label="Type">
              <Select value={addForm.feeType} onChange={(e) => setAddForm({ ...addForm, feeType: e.target.value })}>
                <option>MONTHLY</option><option>ADMISSION</option><option>EXAM</option><option>TRANSPORT</option><option>LIBRARY</option><option>OTHER</option>
              </Select>
            </Field>
            <Field label="Amount (৳)"><TextInput type="number" min="1" value={addForm.amount} onChange={(e) => setAddForm({ ...addForm, amount: e.target.value })} /></Field>
            <Field label="Due date"><TextInput type="date" value={addForm.dueDate} onChange={(e) => setAddForm({ ...addForm, dueDate: e.target.value })} /></Field>
          </div>
          <Field label="Installments" hint="Split the amount into monthly installments. Leave at 1 to bill it in one go.">
            <TextInput type="number" min="1" max="24" value={addForm.installments} onChange={(e) => setAddForm({ ...addForm, installments: e.target.value })} />
          </Field>
          <p className="text-xs text-slate-400">The new fee starts as UNPAID and posts a FEE entry to the central ledger.</p>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => { setAddOpen(false); setError(""); }}>Cancel</button>
            <button className="btn btn-primary" onClick={createFee} disabled={busy || !addForm.studentId || !addForm.title.trim() || !(Number(addForm.amount) > 0)}>
              {busy ? "Adding…" : "Add fee"}
            </button>
          </div>
        </div>
      </Modal>

      {/* payment modal */}
      <Modal open={!!payOpen} onClose={() => setPayOpen(null)} title="Collect payment">
        {paying && (
          <div className="space-y-4">
            {error && <ErrorNote message={error} />}
            <div className="rounded-xl bg-slate-50 p-4 text-sm">
              <div className="font-bold text-slate-800">{paying.student.name}</div>
              <div className="text-xs text-slate-500">
                {paying.title} · {fmtMoney(paying.amount)} total · {fmtMoney(paying.paidAmount)} paid ·{" "}
                <span className="font-semibold text-slate-700">{fmtMoney(payingDue)} due</span>
              </div>
            </div>
            <Field label="Amount (৳)" hint="Part-payment is fine — collect what the family hands over; the rest stays due.">
              <TextInput type="number" min="1" max={payingDue} value={payAmount} onChange={(e) => setPayAmount(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <button className="btn btn-secondary btn-sm" onClick={() => setPayAmount(String(payingDue))}>Full {fmtMoney(payingDue)}</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setPayAmount(String(Math.ceil(payingDue / 2)))}>Half {fmtMoney(Math.ceil(payingDue / 2))}</button>
              <button className="btn btn-secondary btn-sm" onClick={() => setPayAmount("")}>Other amount</button>
            </div>
            <Field label="Method">
              <Select value={payMethod} onChange={(e) => setPayMethod(e.target.value)}>
                <option>CASH</option><option>BANK</option><option>bKASH</option><option>NAGAD</option><option>CARD</option>
              </Select>
            </Field>
            {payOver && <p className="text-xs font-semibold text-rose-600">That is more than the {fmtMoney(payingDue)} still due.</p>}
            {payAmt > 0 && !payOver && payRemaining > 0 && (
              <p className="text-xs font-semibold text-amber-600">
                Part-payment: {fmtMoney(payAmt)} now, {fmtMoney(payRemaining)} stays due on this fee.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button className="btn btn-secondary" onClick={() => { setPayOpen(null); setError(""); }}>Cancel</button>
              <button className="btn btn-primary" onClick={pay} disabled={payAmt <= 0 || payOver}>
                Record {payAmt > 0 ? fmtMoney(payAmt) : "payment"}
              </button>
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
