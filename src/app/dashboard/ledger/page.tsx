"use client";

import { useEffect, useState } from "react";
import { Scale, TrendingUp } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Card, CardHeader, Badge, Select, PageHeader, LoadingScreen, EmptyState, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate, money } from "@/lib/utils";

/** PRD §10.1/§10.5 — Central Ledger view: school-wise, method breakdown. */
export default function LedgerPage() {
  const [entries, setEntries] = useState<any[]>([]);
  const [kind, setKind] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<any[]>(`/api/ledger${qs({ kind: kind || undefined })}`).then(setEntries).finally(() => setLoading(false));
  }, [kind]);

  if (loading) return <LoadingScreen />;

  const confirmed = entries.filter((e) => e.status === "CONFIRMED");
  // money() everywhere: one entry without an amount must not zero the column.
  const inflow = confirmed.filter((e) => ["PAYMENT"].includes(e.kind)).reduce((a, e) => a + money(e.amount), 0);
  const discounts = confirmed.filter((e) => e.kind === "DISCOUNT").reduce((a, e) => a + money(e.amount), 0);
  const lateFees = confirmed.filter((e) => e.kind === "LATE_FEE").reduce((a, e) => a + money(e.amount), 0);
  const byMethod = confirmed
    .filter((e) => e.kind === "PAYMENT")
    .reduce<Record<string, number>>((acc, e) => {
      const m = e.method || "OTHER";
      acc[m] = (acc[m] || 0) + money(e.amount);
      return acc;
    }, {});

  return (
    <div>
      <PageHeader
        title="Central Ledger"
        subtitle="Every financial event, immutable and queryable (PRD §10.1)"
        actions={
          <Select className="!w-44" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            <option value="FEE">Fee created</option>
            <option value="PAYMENT">Payments</option>
            <option value="DISCOUNT">Discounts</option>
            <option value="LATE_FEE">Late fees</option>
          </Select>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Collected (payments)</p>
          <p className="mt-1 text-2xl font-black text-emerald-600">{fmtMoney(inflow)}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Discounts given</p>
          <p className="mt-1 text-2xl font-black text-amber-600">{fmtMoney(discounts)}</p>
        </Card>
        <Card className="p-5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Late fees</p>
          <p className="mt-1 text-2xl font-black text-slate-900">{fmtMoney(lateFees)}</p>
        </Card>
        <Card className="p-5">
          <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-slate-400"><TrendingUp size={12} /> By method</p>
          <div className="mt-2 space-y-1">
            {Object.entries(byMethod).map(([m, v]) => (
              <div key={m} className="flex justify-between text-xs">
                <span className="font-semibold text-slate-600">{m}</span>
                <span className="font-bold text-slate-800">{fmtMoney(v)}</span>
              </div>
            ))}
            {!Object.keys(byMethod).length && <p className="text-xs text-slate-400">No payments yet</p>}
          </div>
        </Card>
      </div>

      <Card>
        <CardHeader title="Ledger entries" subtitle={`${entries.length} entries (latest first)`} />
        {entries.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr><th className="th">Date</th><th className="th">Kind</th><th className="th">Description</th><th className="th">Student</th><th className="th">Method</th><th className="th">Ref</th><th className="th">By</th><th className="th text-right">Amount</th><th className="th">Status</th></tr>
              </thead>
              <tbody>
                {entries.map((e) => (
                  <tr key={e.id} className="tr-hover">
                    <td className="td text-xs">{fmtDate(e.createdAt, true)}</td>
                    <td className="td"><Badge tone={e.kind === "PAYMENT" ? "green" : e.kind === "DISCOUNT" ? "amber" : e.kind === "LATE_FEE" ? "red" : "slate"}>{e.kind.replace("_", " ")}</Badge></td>
                    <td className="td text-xs">{e.description || "—"}</td>
                    <td className="td text-xs">{e.student?.name || "—"}</td>
                    <td className="td text-xs">{e.method || "—"}</td>
                    <td className="td text-[11px] text-slate-400">{e.refNo || "—"}</td>
                    <td className="td text-xs">{e.actor?.name || "system"}</td>
                    <td className={`td text-right font-bold ${e.kind === "PAYMENT" ? "text-emerald-600" : e.kind === "LATE_FEE" ? "text-rose-600" : "text-slate-800"}`}>{fmtMoney(e.amount)}</td>
                    <td className="td"><Badge tone={statusTone(e.status)}>{prettyStatus(e.status)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={Scale} title="No ledger entries" description="Fee creations, payments and discounts all appear here." />
        )}
      </Card>
    </div>
  );
}
