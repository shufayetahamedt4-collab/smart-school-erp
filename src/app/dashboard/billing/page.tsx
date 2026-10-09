"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CreditCard, Wallet, Users, CalendarClock, ReceiptText, RefreshCcw } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, StatCard, PageHeader, LoadingScreen, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate } from "@/lib/utils";

/**
 * PRD §12.1 — school-side billing view.
 * The school sees its plan, renewal date, usage vs. the plan's student cap
 * and its platform invoices (read-only — invoicing stays platform-level).
 */

interface Billing {
  status: string;
  daysLeft: number | null;
  usage: { used: number; limit: number | null };
  subscription: {
    id: string;
    cycle: string;
    currentPeriodEnd: string | null;
    plan: { id: string; name: string; price: number | string; cycle: string; maxStudents: number | null; features: string[] } | null;
  } | null;
  invoices: {
    id: string; invoiceNo: string; amount: number | string; status: string;
    issueDate: string; dueDate: string; paidAt?: string | null; method?: string | null; refNo?: string | null; note?: string | null;
  }[];
}

export default function SchoolBillingPage() {
  const [data, setData] = useState<Billing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = () =>
    api<Billing>("/api/subscription/billing")
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  if (loading) return <LoadingScreen label="Loading billing…" />;
  if (error) return <ErrorNote message={error} />;
  if (!data) return null;

  const { usage, subscription, invoices, status, daysLeft } = data;
  const plan = subscription?.plan;
  const unpaid = invoices.filter((i) => i.status !== "PAID");
  const pctUsed = usage.limit ? Math.min(100, Math.round((usage.used / usage.limit) * 100)) : 0;

  return (
    <div>
      <PageHeader
        title="Billing & Subscription"
        subtitle="Your plan, usage and platform invoices (PRD §12.1)"
        actions={
          <Link href="/dashboard/settings" className="btn btn-secondary">
            <RefreshCcw size={14} /> School settings
          </Link>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={CreditCard} label="Current plan" value={plan?.name || "No plan"} sub={plan ? `${fmtMoney(plan.price)} / ${plan.cycle === "YEARLY" ? "year" : "month"}` : "Contact platform admin"} tone="indigo" />
        <StatCard icon={CalendarClock} label="Status" value={prettyStatus(status)} sub={daysLeft !== null ? (daysLeft >= 0 ? `${daysLeft} day(s) left` : `${-daysLeft} day(s) overdue`) : "—"} tone={status === "ACTIVE" || status === "TRIAL" ? "emerald" : "amber"} />
        <StatCard icon={Users} label="Students" value={usage.limit ? `${usage.used} / ${usage.limit}` : String(usage.used)} sub={usage.limit ? `${pctUsed}% of plan cap` : "Unlimited plan"} tone="violet" />
        <StatCard icon={Wallet} label="Unpaid invoices" value={unpaid.length} sub={unpaid.length ? `Oldest due ${fmtDate(unpaid[unpaid.length - 1]?.dueDate)}` : "All settled"} tone={unpaid.length ? "amber" : "emerald"} />
      </div>

      {usage.limit !== null && (
        <Card className="mt-6">
          <CardHeader title="Student capacity" subtitle={`Plan limit: ${usage.limit} students`} />
          <div className="p-5">
            <div className="h-3 w-full overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full ${pctUsed >= 100 ? "bg-rose-500" : pctUsed >= 80 ? "bg-amber-500" : "bg-emerald-500"}`}
                style={{ width: `${pctUsed}%` }}
              />
            </div>
            <div className="mt-2 flex justify-between text-xs font-semibold text-slate-500">
              <span>{usage.used} enrolled</span>
              <span>{usage.limit - usage.used > 0 ? `${usage.limit - usage.used} remaining` : "Limit reached — upgrade to add more"}</span>
            </div>
          </div>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader title="Platform invoices" subtitle="Bank/cash billing handled by the platform admin — records shown here for reference" />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Invoice</th><th className="th">Amount</th><th className="th">Issued</th>
                <th className="th">Due</th><th className="th">Status</th><th className="th text-right">PDF</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="tr-hover">
                  <td className="td">
                    <div className="font-mono text-xs font-bold">{inv.invoiceNo}</div>
                    {inv.note && <div className="text-[10px] text-slate-400">{inv.note}</div>}
                  </td>
                  <td className="td font-semibold">{fmtMoney(inv.amount)}</td>
                  <td className="td">{fmtDate(inv.issueDate)}</td>
                  <td className="td">{fmtDate(inv.dueDate)}</td>
                  <td className="td">
                    <Badge tone={statusTone(inv.status)}>{prettyStatus(inv.status)}</Badge>
                    {inv.paidAt && <div className="text-[10px] text-slate-400">paid {fmtDate(inv.paidAt)}</div>}
                  </td>
                  <td className="td text-right">
                    <Link href={`/print/invoice/${inv.id}`} target="_blank" className="btn btn-secondary btn-sm">
                      <ReceiptText size={12} /> Open
                    </Link>
                  </td>
                </tr>
              ))}
              {!invoices.length && (
                <tr><td colSpan={6} className="td text-center text-sm text-slate-400">No invoices yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
