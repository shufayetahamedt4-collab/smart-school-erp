"use client";

import { useEffect, useMemo, useState } from "react";
import { Wallet, CreditCard, BadgeCheck, Smartphone, Landmark, HandCoins, CircleAlert } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, ErrorNote, Field, LoadingScreen, Select, TextInput, statusTone, prettyStatus } from "@/components/ui";
import { EmptyState, ListCard, ListRow, OverviewTile, SectionHeader, Surface } from "@/components/app-ui";
import { MobileSheet } from "@/components/MobileSheet";
import { fmtMoney, fmtDate, feeDue, sumMoney } from "@/lib/utils";
import { usableChannels, channelForMethod, channelDestination, type PaymentChannel } from "@/lib/fee-channels";

/**
 * PRD §2.1 (Guardian: Fee/Payment = View + Pay) + §7.1 Payment History & Live Due.
 * Pay via CASH/BANK (staff-assisted), or gateway intents (bKash/Nagad/Rocket/Card)
 * which complete in sandbox mode until merchant credentials are configured (§10.2).
 *
 * Two things this screen must make obvious:
 *  - WHERE the money goes. The school's own channels (bKash/Nagad/bank/counter)
 *    are published by the admin and shown here (§10.2).
 *  - That a PARTIAL payment is fine. Part-payment is the norm in Bangladesh:
 *    against a ৳500 fee the guardian may pay ৳200 today and owe ৳300. That is a
 *    first-class button, not a number they have to work out themselves.
 *
 * Presentation only: the reads, the payment intent + mock-complete calls, the
 * amount validation, the child filter and every computed figure are unchanged.
 * The table becomes hairline-separated rows and the checkout becomes the app's
 * bottom sheet.
 */

interface FeeRow {
  id: string; title: string; feeType: string; amount: string; paidAmount: string; status: string; dueDate: string | null;
  installments: { id: string; seq: number; amount: number; dueDate: string | null; status: string }[];
  payments: { id: string; amount: string; method: string; date: string; receiptNo: string | null }[];
  /** Every child of the household, so one login shows the whole family's fees. */
  student: { id: string; name: string; admissionNo?: string | null; classRoom?: { name: string } | null; section?: { name: string } | null } | null;
}

const METHODS = [
  { value: "BKASH", label: "bKash", icon: Smartphone },
  { value: "NAGAD", label: "Nagad", icon: Smartphone },
  { value: "ROCKET", label: "Rocket", icon: Smartphone },
  { value: "CARD", label: "Card", icon: CreditCard },
  { value: "BANK", label: "Bank transfer", icon: Landmark },
];

const KIND_ICON = { MOBILE: Smartphone, BANK: Landmark, CASH: HandCoins } as const;

export default function ParentFeesPage() {
  const [fees, setFees] = useState<FeeRow[]>([]);
  const [channels, setChannels] = useState<PaymentChannel[]>([]);
  const [paymentNote, setPaymentNote] = useState("");
  const [loading, setLoading] = useState(true);
  const [payFor, setPayFor] = useState<FeeRow | null>(null);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("BKASH");
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState("");
  const [receipt, setReceipt] = useState<string | null>(null);
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

  /**
   * Only offer the methods the school has actually published a channel for.
   * Before anything is configured we fall back to the built-in list so the
   * sandbox checkout still works.
   */
  const methodOptions = useMemo(() => {
    const offered = new Set<string>();
    for (const c of channels) for (const m of c.methods) offered.add(m);
    const configured = METHODS.filter((m) => offered.has(m.value));
    return configured.length ? configured : METHODS;
  }, [channels]);

  useEffect(() => {
    if (methodOptions.length && !methodOptions.some((m) => m.value === method)) setMethod(methodOptions[0].value);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [methodOptions]);

  const startPay = (fee: FeeRow, preset?: number) => {
    const due = feeDue(fee);
    setPayFor(fee);
    setAmount(String(preset ?? due));
    setError("");
    setReceipt(null);
  };

  const pay = async () => {
    if (!payFor) return;
    const due = feeDue(payFor);
    const amt = Number(amount) || 0;
    if (amt <= 0) {
      setError("Enter the amount you are paying.");
      return;
    }
    if (amt > due) {
      setError(`That is more than the ${fmtMoney(due)} still due on this fee.`);
      return;
    }
    setPaying(true);
    setError("");
    try {
      const intent = await api<any>("/api/payments", {
        method: "POST",
        body: JSON.stringify({ feeId: payFor.id, method, amount: amt }),
      });
      await api("/api/payments/mock-complete", { method: "POST", body: JSON.stringify({ intentId: intent.id }) });
      setReceipt(intent.id);
      setPayFor(null);
      await load();
    } catch (e: any) {
      setError(e?.message || "Payment failed");
    } finally {
      setPaying(false);
    }
  };

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

      {receipt && (
        <div className="mt-3 flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] font-semibold text-emerald-700">
          <BadgeCheck size={16} /> Payment confirmed — receipt {receipt}. Check notifications for details.
        </div>
      )}
      {error && (
        <div className="mt-3">
          <ErrorNote message={error} />
        </div>
      )}

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
                    {rowDue > 0 && (
                      <>
                        <button className="btn btn-primary btn-sm min-h-11" onClick={() => startPay(f)}>
                          <Wallet size={13} /> Pay {fmtMoney(rowDue)}
                        </button>
                        {/* Part-payment is the norm — offer the split without arithmetic. */}
                        {rowDue > 1 && (
                          <button className="text-[11px] font-semibold text-sky-600 hover:underline" onClick={() => startPay(f, Math.ceil(rowDue / 2))}>
                            Pay half ({fmtMoney(Math.ceil(rowDue / 2))})
                          </button>
                        )}
                      </>
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

      <MobileSheet open={!!payFor} onClose={() => setPayFor(null)} title="Pay fee">
        {payFor &&
          (() => {
            const rowDue = feeDue(payFor);
            const amt = Number(amount) || 0;
            const over = amt > rowDue;
            const remaining = Math.max(0, rowDue - amt);
            const partial = amt > 0 && amt < rowDue;
            const channel = channelForMethod(channels, method);
            return (
              <div className="space-y-4">
                <div className="rounded-xl bg-slate-50 p-4 text-[13px]">
                  <div className="font-bold text-slate-800">{payFor.title}</div>
                  {manyChildren && payFor.student && <div className="text-[12px] font-semibold text-sky-600">{payFor.student.name}</div>}
                  <div className="text-[12px] text-slate-500">
                    {fmtMoney(payFor.amount)} total · {fmtMoney(payFor.paidAmount)} paid ·{" "}
                    <span className="font-semibold text-slate-700">{fmtMoney(rowDue)} due</span>
                  </div>
                </div>

                <Field label="Amount (৳)" hint="Part-payment is allowed — pay what you can now, the rest stays due.">
                  <TextInput type="number" min="1" max={rowDue} value={amount} onChange={(e) => setAmount(e.target.value)} />
                </Field>

                <div className="flex flex-wrap gap-2">
                  <button className="btn btn-secondary btn-sm min-h-11" onClick={() => setAmount(String(rowDue))}>Full {fmtMoney(rowDue)}</button>
                  <button className="btn btn-secondary btn-sm min-h-11" onClick={() => setAmount(String(Math.ceil(rowDue / 2)))}>Half {fmtMoney(Math.ceil(rowDue / 2))}</button>
                  <button className="btn btn-secondary btn-sm min-h-11" onClick={() => setAmount("")}>Other amount</button>
                </div>

                <Field label="Payment method">
                  <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                    {methodOptions.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </Select>
                </Field>

                {channel ? (
                  <div className="rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-[12px] text-sky-900">
                    <div className="font-bold">Send to: {channel.label}</div>
                    <div className="mt-0.5 font-semibold">{channelDestination(channel) || "See the school office"}</div>
                    {channel.instructions && <div className="mt-1 text-sky-700/80">{channel.instructions}</div>}
                  </div>
                ) : (
                  <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-[12px] text-slate-500">
                    Your school has not published a number for this method yet — pay at the office, or ask the school to add it.
                  </div>
                )}

                {over && <p className="text-[12px] font-semibold text-rose-600">That is more than the {fmtMoney(rowDue)} still due.</p>}
                {partial && !over && (
                  <p className="text-[12px] font-semibold text-amber-600">
                    Part-payment: {fmtMoney(amt)} now, {fmtMoney(remaining)} stays due on this fee.
                  </p>
                )}

                <div className="flex justify-end gap-2">
                  <button className="btn btn-secondary min-h-11" onClick={() => setPayFor(null)}>Cancel</button>
                  <button className="btn btn-primary min-h-11" onClick={pay} disabled={paying || amt <= 0 || over}>
                    {paying ? (
                      "Processing…"
                    ) : (
                      <>
                        <CreditCard size={15} /> Pay {amt > 0 ? fmtMoney(amt) : "now"}
                      </>
                    )}
                  </button>
                </div>
              </div>
            );
          })()}
      </MobileSheet>
    </div>
  );
}
