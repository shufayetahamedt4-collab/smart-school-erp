"use client";

import { use, useEffect, useState } from "react";
import { api } from "@/lib/client";
import { PrintActions } from "@/components/PrintActions";
import { fmtMoney, fmtDate } from "@/lib/utils";
import { LoadingScreen } from "@/components/ui";

/**
 * PRD §12.1 — platform invoice for a school's subscription.
 * Rendered print-ready (A5-friendly) with paid/unpaid stamp.
 */

interface InvoiceData {
  invoice: {
    id: string; invoiceNo: string; amount: string | number; status: string;
    issueDate: string; dueDate: string; periodStart: string; periodEnd: string;
    method?: string | null; refNo?: string | null; paidAt?: string | null; note?: string | null;
  };
  school: { id: string; name: string; address?: string | null; phone?: string | null; email?: string | null; logoUrl?: string | null };
  plan: { id: string; name: string; price: string | number; cycle: string } | null;
}

export default function InvoicePrintPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<InvoiceData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<InvoiceData>(`/api/subscriptions/invoice/${id}`)
      .then(setData)
      .catch(() => null)
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <LoadingScreen label="Loading invoice…" />;
  if (!data) return <div className="p-10 text-center text-sm text-slate-500">Invoice not found.</div>;

  const { invoice, school, plan } = data;
  const paid = invoice.status === "PAID";

  return (
    <div className="mx-auto max-w-2xl bg-white p-8 text-slate-800 print:p-0">
      <PrintActions targetId="invoice-print" fileName={`invoice-${invoice.invoiceNo}`} />

      <div id="invoice-print">
        {/* header */}
        <div className="flex items-start justify-between border-b-2 border-slate-800 pb-4">
          <div className="flex items-center gap-3">
            {school.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={school.logoUrl} alt="" className="h-12 w-12 rounded-lg object-contain" />
            ) : (
              <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-800 text-lg font-black text-white">
                {school.name.slice(0, 1)}
              </div>
            )}
            <div>
              <div className="text-xs font-bold uppercase tracking-widest text-slate-400">Amar E School Platform</div>
              <h1 className="text-xl font-black">{school.name}</h1>
              <div className="text-xs text-slate-500">{school.address || ""}{school.phone ? ` · ${school.phone}` : ""}</div>
            </div>
          </div>
          <div className="text-right">
            <div className="text-2xl font-black tracking-tight">INVOICE</div>
            <div className="mt-1 font-mono text-sm font-bold text-slate-600">{invoice.invoiceNo}</div>
            <div
              className={`mt-2 inline-block rounded-full px-3 py-1 text-[11px] font-black uppercase tracking-wider ${
                paid ? "bg-emerald-100 text-emerald-700" : "bg-rose-100 text-rose-700"
              }`}
            >
              {paid ? "Paid" : "Unpaid"}
            </div>
          </div>
        </div>

        {/* meta */}
        <div className="mt-5 grid grid-cols-2 gap-6 text-sm">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Billing period</div>
            <div className="mt-1 font-semibold">{fmtDate(invoice.periodStart)} → {fmtDate(invoice.periodEnd)}</div>
            {invoice.note && <div className="mt-1 text-xs text-slate-500">{invoice.note}</div>}
          </div>
          <div className="text-right">
            <div className="text-[11px] font-bold uppercase tracking-wide text-slate-400">Issued / Due</div>
            <div className="mt-1 font-semibold">Issued {fmtDate(invoice.issueDate)}</div>
            <div className="text-xs text-slate-500">Due {fmtDate(invoice.dueDate)}</div>
          </div>
        </div>

        {/* line items */}
        <table className="mt-6 w-full text-sm">
          <thead>
            <tr className="border-b border-slate-300 text-left text-[11px] uppercase tracking-wide text-slate-400">
              <th className="py-2">Description</th>
              <th className="py-2">Cycle</th>
              <th className="py-2 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-slate-100">
              <td className="py-3 font-semibold">
                {plan?.name || "Subscription"} plan — school subscription fee
              </td>
              <td className="py-3 text-slate-500">{plan?.cycle || "MONTHLY"}</td>
              <td className="py-3 text-right font-semibold">{fmtMoney(invoice.amount)}</td>
            </tr>
            <tr>
              <td colSpan={2} className="pt-4 text-right font-bold uppercase tracking-wide text-slate-500">Total</td>
              <td className="pt-4 text-right text-lg font-black">{fmtMoney(invoice.amount)}</td>
            </tr>
          </tbody>
        </table>

        {/* payment info */}
        {paid && (
          <div className="mt-6 rounded-xl bg-slate-50 p-4 text-xs text-slate-600">
            <b>Paid via</b> {invoice.method || "—"} {invoice.refNo ? `· Ref ${invoice.refNo}` : ""}
            {invoice.paidAt ? ` · ${fmtDate(invoice.paidAt, true)}` : ""}
          </div>
        )}

        <div className="mt-10 flex items-end justify-between">
          <div className="text-[10px] leading-relaxed text-slate-400">
            Generated by Amar E School platform billing (PRD §12.1).<br />
            This is a system-generated invoice — no signature required.
          </div>
          <div className="text-center">
            <div className="h-14 w-40 border-b border-slate-400" />
            <div className="mt-1 text-[10px] uppercase tracking-widest text-slate-400">Authorised signature</div>
          </div>
        </div>
      </div>
    </div>
  );
}
