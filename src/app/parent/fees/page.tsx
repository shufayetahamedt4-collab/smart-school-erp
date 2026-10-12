"use client";

import { useEffect, useState } from "react";
import { Wallet, Smartphone, Landmark, HandCoins, CircleAlert } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen, statusTone, prettyStatus } from "@/components/ui";
import { EmptyState, ListCard, ListRow, OverviewTile, SectionHeader, Surface } from "@/components/app-ui";
import { fmtMoney, fmtDate, feeDue, sumMoney } from "@/lib/utils";
import { usableChannels, channelDestination, type PaymentChannel } from "@/lib/fee-channels";

/**
 * PRD §2.1 (Guardian: Fee/Payment = View) + §7.1 Payment History & Live Due.
 *
 * pilot-fix-1 item 3 — THIS SCREEN IS READ-ONLY. Pilot schools take fees at the
 * office only, so a family can no longer start a payment here: the Pay button,
 * the amount/method checkout and the whole intent + mock-complete call are gone.
 * The old path let a guardian "pay" with CASH (which confirmed instantly, with no
 * money handled) or through a sandbox gateway, and it created a PENDING intent
 * for a payment that could never complete. The server refuses the same calls for a
 * GUARDIAN or STUDENT session (`POST /api/payments`, `/api/payments/mock-complete`),
 * so removing the button is a courtesy, not the enforcement.
 *
 * What remains is what a family actually needs: every child's fee records, what is
 * billed, what is paid and what is still due, plus WHERE to pay — the school's own
 * published channels (bKash/Nagad/bank/counter), which the admin maintains (§10.2).
 */

interface FeeRow {
  id: string; title: string; feeType: string; amount: string; paidAmount: string; status: string; dueDate: string | null;
  installments: { id: string; seq: number; amount: number; dueDate: string | null; status: string }[];
  payments: { id: string; amount: string; method: string; date: string; receiptNo: string | null }[];
  /** Every child of the household, so one login shows the whole family's fees. */
  student: { id: string; name: string; admissionNo?: string | null; classRoom?: { name: string } | null; section?: { name: string } | null } | null;
}

const KIND_ICON = { MOBILE: Smartphone, BANK: Landmark, CASH: HandCoins } as const;

export default function ParentFeesPage() {
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [channels, setChannels] = useState<PaymentChannel[]>([]);
  const [paymentNote, setPaymentNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [childFilter, setChildFilter] = useState<string>("ALL");

  const load = () =>
    api<{ fees: FeeRow[]; settings: any }>("/api/fees")
      .then((d) => {
        setFees(d.fees);
        setChannels(usableChannels(d.settings?.channels));
        setPaymentNote(d.settings?.paymentNote || "");
      })
      .finally(() => setLoading(false));
  useEffect(() => {
    load();
  }, []);

  // A filter can outlive its child (the rows reload after a payment). Fall back
  // to "All" rather than showing an empty table for a child that has no rows.
  useEffect(() => {
    if (childFilter !== "ALL" && fees.length && !fees.some((f) => f.student?.id === childFilter)) setChildFilter("ALL");
  }, [fees, childFilter]);

  if (loading) return <LoadingScreen />;

  /**
   * One login covers the whole household (§5.4), so these rows may span several
   * children — a second child's dues used to be missing from this screen
   * entirely. Group them by child, label every row, and let the family or one
   * child be filtered: nothing owed is invisible, and nothing looks payable only
   * from an admin screen.
   */
  const childGroups = (() => {
    const byId = new Map<string, { id: string; name: string; klass: string }>();
    for (const f of fees) {
      if (!f.student || byId.has(f.student.id)) continue;
      byId.set(f.student.id, {
        id: f.student.id,
        name: f.student.name,
        klass: [f.student.classRoom?.name, f.student.section?.name].filter(Boolean).join(" / "),
      });
    }
    return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  })();
  const manyChildren = childGroups.length > 1;
  const visibleFees = childFilter === "ALL" ? fees : fees.filter((f) => f.student?.id === childFilter);
  const childLabel = childFilter === "ALL" ? "" : childGroups.find((c) => c.id === childFilter)?.name || "";
  const billed = sumMoney(visibleFees, (f) => f.amount);
  const due = sumMoney(visibleFees, (f) => feeDue(f));

  return (
    <div>
      <SectionHeader title="Summary" className="ss-flush-top" />
      <div className="ss-tiles grid grid-cols-2 gap-3">
        <OverviewTile
          icon={Wallet}
          tone="indigo"
          value={fmtMoney(billed)}
          label="Total billed"
          sub={manyChildren ? (childFilter === "ALL" ? `all ${childGroups.length} children` : childLabel) : undefined}
        />
        <OverviewTile
          icon={Wallet}
          tone={due > 0 ? "rose" : "emerald"}
          value={fmtMoney(due)}
          label="Outstanding due"
          sub={manyChildren ? (childFilter === "ALL" ? "across all your children" : childLabel) : undefined}
        />
      </div>

      {/*
        pilot-fix-1 item 3 — the pilot takes fees at the office. This is the
        standing answer, not an error state: it replaces the old "Payment
        confirmed" banner and the checkout's error line, both of which belonged to
        a payment flow this screen no longer has.
      */}
      <div className="mt-3 flex items-start gap-2 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3 text-[13px] text-sky-900">
        <CircleAlert size={16} className="mt-0.5 shrink-0 text-sky-500" />
        <span>
          <span className="font-bold">Online payment is not available.</span> Please pay at the school office — a receipt is
          issued there, and this page shows it as soon as it is recorded.
        </span>
      </div>

      {channels.length > 0 && (
        <>
          <SectionHeader title="How to pay" />
          <Surface>
            {paymentNote && (
              <p className="mb-3 flex items-start gap-2 rounded-xl bg-slate-50 px-4 py-3 text-[13px] text-slate-600">
                <CircleAlert size={15} className="mt-0.5 shrink-0 text-slate-400" /> {paymentNote}
              </p>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {channels.map((c) => {
                const Icon = KIND_ICON[c.kind] || Wallet;
                return (
                  <div key={c.id} className="flex items-start gap-3 rounded-xl border border-slate-200 p-3.5">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-sky-50 text-sky-600">
                      <Icon size={16} />
                    </span>
                    <div className="min-w-0">
                      <div className="text-[13px] font-bold text-slate-800">{c.label}</div>
                      <div className="mt-0.5 text-[12px] font-semibold text-slate-600">{channelDestination(c) || "At the school office"}</div>
                      {c.instructions && <div className="mt-1 text-[11px] text-slate-400">{c.instructions}</div>}
                    </div>
                  </div>
                );
              })}
            </div>
          </Surface>
        </>
      )}

      {manyChildren && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button className={`btn btn-sm min-h-11 ${childFilter === "ALL" ? "btn-primary" : "btn-secondary"}`} onClick={() => setChildFilter("ALL")}>
            All children · {fmtMoney(sumMoney(fees, (f) => feeDue(f)))} due
          </button>
          {childGroups.map((c) => (
            <button
              key={c.id}
              className={`btn btn-sm min-h-11 ${childFilter === c.id ? "btn-primary" : "btn-secondary"}`}
              onClick={() => setChildFilter(c.id)}
            >
              {c.name}
              {c.klass ? ` · ${c.klass}` : ""} · {fmtMoney(sumMoney(fees.filter((f) => f.student?.id === c.id), (f) => feeDue(f)))} due
            </button>
          ))}
        </div>
      )}

      <SectionHeader title={childFilter === "ALL" ? "Fee records" : `${childLabel} — fee records`} />
      {visibleFees.length ? (
        <ListCard>
          {visibleFees.map((f) => {
            const rowDue = feeDue(f);
            return (
              <ListRow
                key={f.id}
                icon={Wallet}
                tone={rowDue > 0 ? "rose" : "emerald"}
                title={f.title}
                subtitle={
                  <span>
                    {manyChildren && f.student ? `${f.student.name} · ` : ""}
                    {fmtMoney(f.amount)} total · {fmtMoney(f.paidAmount)} paid
                    {f.dueDate ? ` · due ${fmtDate(f.dueDate)}` : ""}
                    {f.installments?.length
                      ? ` · ${f.installments.map((i) => `#${i.seq} ${fmtMoney(i.amount)}${i.dueDate ? ` (${fmtDate(i.dueDate)})` : ""}`).join(", ")}`
                      : ""}
                    {f.payments[0] ? ` · receipt ${f.payments[0].receiptNo} (${f.payments[0].method})` : ""}
                  </span>
                }
                trailing={
                  <div className="flex shrink-0 flex-col items-end gap-1.5">
                    <Badge tone={statusTone(f.status)}>{prettyStatus(f.status)}</Badge>
                    {/* Read-only (pilot-fix-1 item 3): show what is owed and where to pay it,
                        never a control that would try to collect it here. */}
                    {rowDue > 0 && (
                      <span className="text-[11px] font-semibold text-slate-500">{fmtMoney(rowDue)} due · pay at the office</span>
                    )}
                  </div>
                }
              />
            );
          })}
        </ListCard>
      ) : (
        <EmptyState
          icon={Wallet}
          title={childFilter === "ALL" ? "No fee records" : "No fee records for this child"}
          hint="Fee records appear after admission."
        />
      )}

    </div>
  );
}
