"use client";

import { useEffect, useState } from "react";
import { Wallet, CreditCard, BadgeCheck, Receipt } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, Select, Modal, PageHeader, LoadingScreen, EmptyState, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate } from "@/lib/utils";

/**
 * PRD §2.1 (Guardian: Fee/Payment = View + Pay) + §7.1 Payment History & Live Due.
 * Pay via CASH/BANK (staff-assisted), or gateway intents (bKash/Nagad/Rocket/Card)
 * which complete in sandbox mode until merchant credentials are configured (§10.2).
 */

interface FeeRow {
  id: string; title: string; feeType: string; amount: string; paidAmount: string; status: string; dueDate: string | null;
  installments: { id: string; seq: number; amount: number; dueDate: string | null; status: string }[];
  payments: { id: string; amount: string; method: string; date: string; receiptNo: string | null }[];
}

const METHODS = [
  { value: "BKASH", label: "bKash" },
  { value: "NAGAD", label: "Nagad" },
  { value: "ROCKET", label: "Rocket" },
  { value: "CARD", label: "Card" },
];

export default function ParentFeesPage() {
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [payFor, setPayFor] = useState<FeeRow | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("BKASH");
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);

  const load = () => api<{ fees: FeeRow[] }>("/api/fees").then((d) => setFees(d.fees)).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const startPay = (fee: FeeRow) => {
    const due = Number(fee.amount) - Number(fee.paidAmount);
    setPayFor(fee);
    setAmount(String(due));
    setError("");
    setReceipt(null);
  };

  const pay = async () => {
    if (!payFor) return;
    setPaying(true);
    setError("");
    try {
      const intent = await api<any>("/api/payments", {
        method: "POST",
        body: JSON.stringify({ feeId: payFor.id, method, amount: Number(amount) }),
      });
      if (METHODS.some((m) => m.value === method)) {
        // Gateway flow — sandbox: complete the mock intent immediately (§10.2 mock).
        await api("/api/payments/mock-complete", { method: "POST", body: JSON.stringify({ intentId: intent.id }) });
      }
      const result = await api<any>("/api/payments", { method: "GET" });
      setReceipt(intent.id);
      setPayFor(null);
      await load();
      void result;
    } catch (e: any) {
      setError(e?.message || "Payment failed");
    } finally {
      setPaying(false);
    }
  };

  if (loading) return <LoadingScreen />;

  const due = fees.reduce((a, f) => a + (Number(f.amount) - Number(f.paidAmount)), 0);

  return (
    <div>
      <PageHeader title="Fees" subtitle="Live dues, installments and payment history (PRD §10)" />

      <div className="mb-4 grid grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Total billed</div>
          <div className="mt-1 text-2xl font-black text-slate-900">{fmtMoney(fees.reduce((a, f) => a + Number(f.amount), 0))}</div>
        </Card>
        <Card className="p-5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Outstanding due</div>
          <div className={`mt-1 text-2xl font-black ${due > 0 ? "text-rose-600" : "text-emerald-600"}`}>{fmtMoney(due)}</div>
        </Card>
      </div>

      {receipt && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          <BadgeCheck size={16} /> Payment confirmed — receipt {receipt}. Check notifications for details.
        </div>
      )}
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card>
        <CardHeader title="Fee records" subtitle="Breakdown, installments and receipts (§10.3)" />
        {fees.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr><th className="th">Fee</th><th className="th">Amount</th><th className="th">Paid</th><th className="th">Due date</th><th className="th">Installments</th><th className="th">Status</th><th className="th text-right">Pay</th></tr>
              </thead>
              <tbody>
                {fees.map((f) => {
                  const due = Number(f.amount) - Number(f.paidAmount);
                  return (
                    <tr key={f.id} className="tr-hover">
                      <td className="td">
                        <div className="font-bold text-slate-800">{f.title}</div>
                        <div className="text-[11px] text-slate-400">{f.feeType}</div>
                      </td>
                      <td className="td font-semibold">{fmtMoney(f.amount)}</td>
                      <td className="td font-semibold text-emerald-600">{fmtMoney(f.paidAmount)}</td>
                      <td className="td">{f.dueDate ? fmtDate(f.dueDate) : "—"}</td>
                      <td className="td">
                        {f.installments?.length ? (
                          <div className="space-y-0.5">
                            {f.installments.map((i) => (
                              <div key={i.id} className="text-[11px] text-slate-500">
                                #{i.seq}: {fmtMoney(i.amount)} {i.dueDate ? `· ${fmtDate(i.dueDate)}` : ""}
                              </div>
                            ))}
                          </div>
                        ) : "—"}
                      </td>
                      <td className="td">
                        <Badge tone={statusTone(f.status)}>{prettyStatus(f.status)}</Badge>
                        {f.payments[0] && (
                          <div className="mt-1 flex items-center gap-1 text-[10px] text-slate-400">
                            <Receipt size={10} /> {f.payments[0].receiptNo} · {f.payments[0].method}
                          </div>
                        )}
                      </td>
                      <td className="td">
                        <div className="flex justify-end">
                          {due > 0 && (
                            <button className="btn btn-primary btn-sm" onClick={() => startPay(f)}>
                              <Wallet size={13} /> Pay {fmtMoney(due)}
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
        ) : (
          <EmptyState icon={Wallet} title="No fee records" description="Fee records appear after admission." />
        )}
      </Card>

      <Modal open={!!payFor} onClose={() => setPayFor(null)} title="Pay fee">
        {payFor && (
          <div className="space-y-4">
            <div className="rounded-xl bg-slate-50 p-4 text-sm">
              <div className="font-bold text-slate-800">{payFor.title}</div>
              <div className="text-xs text-slate-500">
                {fmtMoney(payFor.amount)} total · {fmtMoney(payFor.paidAmount)} paid · {fmtMoney(Number(payFor.amount) - Number(payFor.paidAmount))} due
              </div>
            </div>
            <Field label="Amount (৳)">
              <TextInput type="number" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="Payment method" hint="bKash/Nagad/Rocket/Card run in sandbox mode until merchant credentials are configured.">
              <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                {METHODS.map((m) => (
                  <option key={m.value} value={m.value}>{m.label}</option>
                ))}
              </Select>
            </Field>
            <div className="flex justify-end gap-2">
              <button className="btn btn-secondary" onClick={() => setPayFor(null)}>Cancel</button>
              <button className="btn btn-primary" onClick={pay} disabled={paying || !Number(amount)}>
                {paying ? "Processing…" : <><CreditCard size={15} /> Pay now</>}
              </button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
