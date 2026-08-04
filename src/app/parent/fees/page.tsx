"use client";

import { useEffect, useState } from "react";
import { Wallet } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen, EmptyState, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate } from "@/lib/utils";

interface FeeRow {
  id: string; title: string; feeType: string; amount: string; paidAmount: string; status: string; dueDate: string | null;
  payments: { id: string; amount: string; method: string; date: string; receiptNo: string | null }[];
}

export default function ParentFeesPage() {
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<{ fees: FeeRow[] }>("/api/fees").then((d) => setFees(d.fees)).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingScreen />;

  const due = fees.reduce((a, f) => a + (Number(f.amount) - Number(f.paidAmount)), 0);
  const paid = fees.reduce((a, f) => a + Number(f.paidAmount), 0);

  return (
    <div>
      <PageHeader title="Fees" subtitle="Payment status for your child" />

      <div className="mb-4 grid grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Total billed</div>
          <div className="mt-1 text-2xl font-black text-slate-900">{fmtMoney(fees.reduce((a, f) => a + Number(f.amount), 0))}</div>
        </Card>
        <Card className="p-5">
          <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Outstanding</div>
          <div className={`mt-1 text-2xl font-black ${due > 0 ? "text-rose-600" : "text-emerald-600"}`}>{fmtMoney(due)}</div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Payment history" subtitle={`${fmtMoney(paid)} paid so far`} />
        {fees.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr><th className="th">Fee</th><th className="th">Amount</th><th className="th">Paid</th><th className="th">Due date</th><th className="th">Status</th><th className="th">Receipts</th></tr>
              </thead>
              <tbody>
                {fees.map((f) => (
                  <tr key={f.id} className="tr-hover">
                    <td className="td">
                      <div className="font-bold text-slate-800">{f.title}</div>
                      <div className="text-[11px] text-slate-400">{f.feeType}</div>
                    </td>
                    <td className="td font-semibold">{fmtMoney(f.amount)}</td>
                    <td className="td font-semibold text-emerald-600">{fmtMoney(f.paidAmount)}</td>
                    <td className="td">{f.dueDate ? fmtDate(f.dueDate) : "—"}</td>
                    <td className="td"><Badge tone={statusTone(f.status)}>{prettyStatus(f.status)}</Badge></td>
                    <td className="td">
                      {f.payments.length ? (
                        <div className="space-y-1">
                          {f.payments.map((p) => (
                            <div key={p.id} className="text-[11px] text-slate-500">
                              {fmtMoney(p.amount)} via {p.method} · {p.receiptNo || "no receipt"}
                            </div>
                          ))}
                        </div>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={Wallet} title="No fee records" description="Fee records appear after admission." />
        )}
      </Card>
    </div>
  );
}
