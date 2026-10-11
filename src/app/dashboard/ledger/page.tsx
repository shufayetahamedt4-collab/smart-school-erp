"use client";

import { useEffect, useMemo, useState } from "react";
import { Scale, TrendingUp } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Card, CardHeader, Badge, Select, PageHeader, LoadingScreen, EmptyState, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate, money } from "@/lib/utils";
import {
  COLLEGE_LEDGER_BADGE,
  LEDGER_MODE_OPTIONS,
  collegeLedgerAmountText,
  collegeLedgerNote,
  filterLedgerEntries,
  formatMinor,
  hasCollegeMoney,
  isCollegeLedgerEntry,
  ledgerTotals,
} from "@/lib/college-fees-view";

/** PRD §10.1/§10.5 — Central Ledger view: school-wise, method breakdown. */
export default function LedgerPage() {
  const [entries, setEntries] = useState<any[]>([]);
  const [kind, setKind] = useState("");
  // Phase 7d (docs/COLLEGE-DECISIONS.md §24, D-7-12/Q3): the college's payments
  // and waivers post to this SAME ledger, TAGGED (`feeId: null` + `meta.college*`).
  // They stay visible — hiding them would be a different lie — but they carry a
  // College badge, a mode filter can isolate them, and no total on this page adds
  // the two halves' money together (the school cards below are computed over
  // school rows only, and the college cards are their own separate figures).
  const [mode, setMode] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<any[]>(`/api/ledger${qs({ kind: kind || undefined })}`).then(setEntries).finally(() => setLoading(false));
  }, [kind]);

  const collegeMoney = useMemo(() => hasCollegeMoney(entries), [entries]);
  const visible = useMemo(() => filterLedgerEntries(entries, mode), [entries, mode]);

  if (loading) return <LoadingScreen />;

  // The school half, exactly as this page has always computed it — college rows
  // are the only ones excluded, so a school-only tenant's figures and markup are
  // unchanged.
  const confirmed = visible
    .filter((e) => !isCollegeLedgerEntry(e))
    .filter((e) => e.status === "CONFIRMED");
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

  // The college half — integer minor units, printed by the one college formatter.
  const college = ledgerTotals(visible).college;

  return (
    <div>
      <PageHeader
        title="Central Ledger"
        subtitle="Every financial event, immutable and queryable (PRD §10.1)"
        actions={
          <div className="flex items-center gap-2">
            {collegeMoney && (
              <Select className="!w-40" value={mode} onChange={(e) => setMode(e.target.value)}>
                {LEDGER_MODE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
            <Select className="!w-44" value={kind} onChange={(e) => setKind(e.target.value)}>
              <option value="">All kinds</option>
              <option value="FEE">Fee created</option>
              <option value="PAYMENT">Payments</option>
              <option value="DISCOUNT">Discounts</option>
              <option value="LATE_FEE">Late fees</option>
            </Select>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card className="p-5">
          <p className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
            {collegeMoney ? "School collected (payments)" : "Collected (payments)"}
          </p>
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

      {collegeMoney && (
        <>
          <div className="mb-2 flex items-center gap-2">
            <Badge tone="indigo">{COLLEGE_LEDGER_BADGE}</Badge>
            <p className="text-xs text-slate-500">{collegeLedgerNote()}</p>
          </div>
          <div className="mb-4 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Card className="p-5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-400">College collected (payments)</p>
              <p className="mt-1 text-2xl font-black text-indigo-600">{formatMinor(college.collectedMinor)}</p>
            </Card>
            <Card className="p-5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-400">College waivers</p>
              <p className="mt-1 text-2xl font-black text-indigo-600">{formatMinor(college.discountsMinor)}</p>
            </Card>
            <Card className="p-5">
              <p className="text-[11px] font-bold uppercase tracking-wide text-indigo-400">College late fees</p>
              <p className="mt-1 text-2xl font-black text-indigo-600">{formatMinor(college.lateFeesMinor)}</p>
            </Card>
            <Card className="p-5">
              <p className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wide text-indigo-400"><TrendingUp size={12} /> By method</p>
              <div className="mt-2 space-y-1">
                {Object.entries(college.byMethodMinor).map(([m, v]) => (
                  <div key={m} className="flex justify-between text-xs">
                    <span className="font-semibold text-slate-600">{m}</span>
                    <span className="font-bold text-slate-800">{formatMinor(v)}</span>
                  </div>
                ))}
                {!Object.keys(college.byMethodMinor).length && <p className="text-xs text-slate-400">No college payments yet</p>}
              </div>
            </Card>
          </div>
        </>
      )}

      <Card>
        <CardHeader title="Ledger entries" subtitle={`${visible.length} entries (latest first)`} />
        {visible.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr><th className="th">Date</th><th className="th">Kind</th><th className="th">Description</th><th className="th">Student</th><th className="th">Method</th><th className="th">Ref</th><th className="th">By</th><th className="th text-right">Amount</th><th className="th">Status</th></tr>
              </thead>
              <tbody>
                {visible.map((e) => {
                  const collegeRow = isCollegeLedgerEntry(e);
                  // The college's own rows print with the college money helper
                  // (paisa included); school rows keep the school formatter, so a
                  // school-only tenant's ledger output is literally unchanged.
                  const collegeAmount = collegeLedgerAmountText(e);
                  return (
                    <tr key={e.id} className="tr-hover">
                      <td className="td text-xs">{fmtDate(e.createdAt, true)}</td>
                      <td className="td">
                        <div className="flex items-center gap-1.5">
                          <Badge tone={e.kind === "PAYMENT" ? "green" : e.kind === "DISCOUNT" ? "amber" : e.kind === "LATE_FEE" ? "red" : "slate"}>{e.kind.replace("_", " ")}</Badge>
                          {collegeRow && <Badge tone="indigo">{COLLEGE_LEDGER_BADGE}</Badge>}
                        </div>
                      </td>
                      <td className="td text-xs">{e.description || "—"}</td>
                      <td className="td text-xs">{e.student?.name || "—"}</td>
                      <td className="td text-xs">{e.method || "—"}</td>
                      <td className="td text-[11px] text-slate-400">{e.refNo || "—"}</td>
                      <td className="td text-xs">{e.actor?.name || "system"}</td>
                      <td className={`td text-right font-bold ${collegeRow ? "text-indigo-700" : e.kind === "PAYMENT" ? "text-emerald-600" : e.kind === "LATE_FEE" ? "text-rose-600" : "text-slate-800"}`}>{collegeAmount ?? fmtMoney(e.amount)}</td>
                      <td className="td"><Badge tone={statusTone(e.status)}>{prettyStatus(e.status)}</Badge></td>
                    </tr>
                  );
                })}
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
