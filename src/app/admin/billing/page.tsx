"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  CreditCard, Plus, RefreshCw, Check, X, Building2, CalendarClock, BadgeDollarSign, Layers,
} from "lucide-react";
import { api } from "@/lib/client";
import {
  Card, CardHeader, Badge, StatCard, Field, TextInput, Select, Modal, PageHeader,
  LoadingScreen, ErrorNote, statusTone, prettyStatus,
} from "@/components/ui";
import { fmtMoney, fmtDate } from "@/lib/utils";

/**
 * PRD §12.1 — Subscription & Billing console (Super Admin).
 * - Plan management (Trial/Basic/Premium with student limits)
 * - Assign/switch school plans → auto-invoice per cycle
 * - Renewals, mark-invoice-paid (bank/cash), real MRR from subscriptions
 */

interface PlanRow {
  id: string; name: string; price: string | number; cycle: string;
  maxStudents: number | null; trialDays: number | null; features: string[];
}
interface SubRow {
  id: string; status: string; cycle: string; currentPeriodEnd: string | null; startedAt: string;
  /** null for a subscription whose school was deleted — the row still bills history. */
  school: { id: string; name: string; slug: string; status: string } | null;
  plan: { id: string; name: string; price: string | number; maxStudents: number | null } | null;
}
interface InvoiceRow {
  id: string; invoiceNo: string; amount: string | number; status: string; issueDate: string;
  dueDate: string; method?: string | null; refNo?: string | null;
  school: { id: string; name: string } | null;
}

const CYCLES = ["MONTHLY", "YEARLY"];

export default function AdminBillingPage() {
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [subs, setSubs] = useState<SubRow[]>([]);
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [schools, setSchools] = useState<{ id: string; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // modals
  const [planOpen, setPlanOpen] = useState(false);
  const [assignOpen, setAssignOpen] = useState<{ schoolId?: string } | null>(null);
  const [payOpen, setPayOpen] = useState<InvoiceRow | null>(null);

  const [planForm, setPlanForm] = useState<any>({ name: "", price: "", cycle: "MONTHLY", maxStudents: "", trialDays: "" });
  const [assignForm, setAssignForm] = useState<any>({ schoolId: "", planId: "", cycle: "MONTHLY" });
  const [payForm, setPayForm] = useState<any>({ method: "BANK", refNo: "" });
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([
      api<PlanRow[]>("/api/plans"),
      api<{ subscriptions: SubRow[]; invoices: InvoiceRow[] }>("/api/subscriptions"),
      api<{ id: string; name: string }[]>("/api/schools"),
    ])
      .then(([p, s, sc]) => {
        setPlans(p || []);
        setSubs(s?.subscriptions || []);
        setInvoices(s?.invoices || []);
        setSchools(sc || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const mrr = useMemo(
    () =>
      subs
        .filter((s) => s.status === "ACTIVE" || s.status === "TRIAL")
        .reduce((a, s) => a + (Number(s.plan?.price || 0) / (s.cycle === "YEARLY" ? 12 : 1)), 0),
    [subs]
  );
  const unpaid = invoices.filter((i) => i.status !== "PAID");
  const collected = invoices.filter((i) => i.status === "PAID").reduce((a, i) => a + Number(i.amount), 0);

  const createPlan = async () => {
    setBusy(true); setError("");
    try {
      await api("/api/plans", { method: "POST", body: JSON.stringify(planForm) });
      setPlanOpen(false);
      setPlanForm({ name: "", price: "", cycle: "MONTHLY", maxStudents: "", trialDays: "" });
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const assign = async () => {
    setBusy(true); setError("");
    try {
      await api("/api/subscriptions", { method: "POST", body: JSON.stringify(assignForm) });
      setAssignOpen(null);
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const renew = async (schoolId: string) => {
    setError("");
    try {
      await api("/api/subscriptions", { method: "PATCH", body: JSON.stringify({ schoolId }) });
      load();
    } catch (e: any) { setError(e.message); }
  };

  const markPaid = async () => {
    if (!payOpen) return;
    setBusy(true); setError("");
    try {
      await api("/api/subscriptions", {
        method: "PATCH",
        body: JSON.stringify({ invoiceId: payOpen.id, ...payForm }),
      });
      setPayOpen(null);
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  if (loading) return <LoadingScreen label="Loading billing…" />;

  return (
    <div>
      <PageHeader
        title="Subscription & Billing"
        subtitle="Plans, school subscriptions and platform invoices (PRD §12.1)"
        actions={<button className="btn btn-primary" onClick={() => setPlanOpen(true)}><Plus size={16} /> New plan</button>}
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard icon={BadgeDollarSign} label="MRR (subscriptions)" value={fmtMoney(mrr)} sub="plan price / cycle month" tone="emerald" />
        <StatCard icon={Building2} label="Subscribed schools" value={subs.length} sub={`${subs.filter((s) => s.status === "ACTIVE").length} active`} tone="indigo" />
        <StatCard icon={CalendarClock} label="Unpaid invoices" value={unpaid.length} sub="awaiting payment" tone={unpaid.length ? "amber" : "emerald"} />
        <StatCard icon={CreditCard} label="Collected (invoices)" value={fmtMoney(collected)} sub="marked paid" tone="violet" />
      </div>

      {/* Plans */}
      <Card className="mt-6">
        <CardHeader title="Plans" subtitle="Feature-based limits — Trial, Basic, Premium" />
        <div className="grid grid-cols-1 gap-4 p-5 md:grid-cols-3">
          {plans.map((p) => (
            <div key={p.id} className="rounded-2xl border border-slate-200 p-4">
              <div className="flex items-center justify-between">
                <div className="text-sm font-black text-slate-800">{p.name}</div>
                <Badge tone={Number(p.price) > 0 ? "green" : "amber"}>{Number(p.price) > 0 ? "Paid" : "Free"}</Badge>
              </div>
              <div className="mt-2 text-2xl font-black text-slate-900">
                {fmtMoney(p.price)}<span className="text-xs font-semibold text-slate-400">/{p.cycle === "YEARLY" ? "yr" : "mo"}</span>
              </div>
              <div className="mt-2 space-y-1 text-xs text-slate-500">
                <div>Limit: {p.maxStudents ? `${p.maxStudents} students` : "Unlimited students"}</div>
                {p.trialDays ? <div>Trial: {p.trialDays} days</div> : null}
                {p.features?.map((f, i) => <div key={i}>· {f}</div>)}
              </div>
            </div>
          ))}
          {!plans.length && <div className="text-sm text-slate-400">No plans yet — create your first plan.</div>}
        </div>
      </Card>

      {/* School subscriptions */}
      <Card className="mt-6">
        <CardHeader
          title="School subscriptions"
          subtitle="Assign plans, renew cycles"
          action={<button className="btn btn-secondary btn-sm" onClick={() => { setAssignForm({ schoolId: "", planId: "", cycle: "MONTHLY" }); setAssignOpen({}); }}><Layers size={14} /> Assign plan</button>}
        />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">School</th><th className="th">Plan</th><th className="th">Status</th>
                <th className="th">Cycle</th><th className="th">Period ends</th><th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {subs.map((s) => (
                <tr key={s.id} className="tr-hover">
                  <td className="td">
                    {/* A subscription can outlive its school; reading `.id` off a null
                        school used to crash this whole console. */}
                    {s.school ? (
                      <Link href={`/admin/schools/${s.school.id}`} className="font-bold text-slate-800 hover:text-indigo-600">{s.school.name}</Link>
                    ) : (
                      <span className="text-slate-400" title="This school record no longer exists">Deleted school</span>
                    )}
                  </td>
                  <td className="td">{s.plan?.name || "—"} <span className="text-xs text-slate-400">({fmtMoney(s.plan?.price || 0)})</span></td>
                  <td className="td"><Badge tone={statusTone(s.status)}>{prettyStatus(s.status)}</Badge></td>
                  <td className="td text-xs">{s.cycle}</td>
                  <td className="td">{s.currentPeriodEnd ? fmtDate(s.currentPeriodEnd) : "—"}</td>
                  <td className="td">
                    <div className="flex justify-end gap-1.5">
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={!s.school}
                        onClick={() => s.school && renew(s.school.id)}
                      >
                        <RefreshCw size={12} /> Renew
                      </button>
                      <button
                        className="btn btn-secondary btn-sm"
                        disabled={!s.school}
                        onClick={() => {
                          if (!s.school) return;
                          setAssignForm({ schoolId: s.school.id, planId: s.plan?.id || "", cycle: s.cycle || "MONTHLY" });
                          setAssignOpen({});
                        }}
                      >
                        Switch
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {!subs.length && (
                <tr><td colSpan={6} className="td text-center text-sm text-slate-400">No subscriptions yet — assign a plan to a school.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* Invoices */}
      <Card className="mt-6">
        <CardHeader title="Invoices" subtitle="Platform billing — mark paid after bank/cash confirmation" />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Invoice</th><th className="th">School</th><th className="th">Amount</th>
                <th className="th">Issued</th><th className="th">Due</th><th className="th">Status</th><th className="th text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {invoices.map((inv) => (
                <tr key={inv.id} className="tr-hover">
                  <td className="td font-mono text-xs font-bold">{inv.invoiceNo}</td>
                  <td className="td">{inv.school?.name || <span className="text-slate-400">Deleted school</span>}</td>
                  <td className="td font-semibold">{fmtMoney(inv.amount)}</td>
                  <td className="td">{fmtDate(inv.issueDate)}</td>
                  <td className="td">{fmtDate(inv.dueDate)}</td>
                  <td className="td">
                    <Badge tone={statusTone(inv.status)}>{prettyStatus(inv.status)}</Badge>
                    {inv.method && <div className="text-[10px] text-slate-400">{inv.method}{inv.refNo ? ` · ${inv.refNo}` : ""}</div>}
                  </td>
                  <td className="td">
                    <div className="flex justify-end gap-1.5">
                      <Link href={`/print/invoice/${inv.id}`} target="_blank" className="btn btn-secondary btn-sm">PDF</Link>
                      {inv.status !== "PAID" && (
                        <button className="btn btn-primary btn-sm" onClick={() => { setPayForm({ method: "BANK", refNo: "" }); setPayOpen(inv); }}>
                          <Check size={12} /> Mark paid
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {!invoices.length && (
                <tr><td colSpan={7} className="td text-center text-sm text-slate-400">No invoices yet.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      {/* New plan modal */}
      <Modal open={planOpen} onClose={() => setPlanOpen(false)} title="New plan">
        <div className="space-y-4">
          <Field label="Plan name"><TextInput value={planForm.name} onChange={(e) => setPlanForm({ ...planForm, name: e.target.value })} placeholder="e.g. Premium" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Price (৳)"><TextInput type="number" value={planForm.price} onChange={(e) => setPlanForm({ ...planForm, price: e.target.value })} /></Field>
            <Field label="Cycle">
              <Select value={planForm.cycle} onChange={(e) => setPlanForm({ ...planForm, cycle: e.target.value })}>
                {CYCLES.map((c) => <option key={c}>{c}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Max students (blank = unlimited)"><TextInput type="number" value={planForm.maxStudents} onChange={(e) => setPlanForm({ ...planForm, maxStudents: e.target.value })} /></Field>
            <Field label="Trial days"><TextInput type="number" value={planForm.trialDays} onChange={(e) => setPlanForm({ ...planForm, trialDays: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setPlanOpen(false)}><X size={14} /> Cancel</button>
            <button className="btn btn-primary" onClick={createPlan} disabled={busy || !planForm.name}><Check size={14} /> Create</button>
          </div>
        </div>
      </Modal>

      {/* Assign plan modal */}
      <Modal open={!!assignOpen} onClose={() => setAssignOpen(null)} title="Assign plan to school">
        <div className="space-y-4">
          <Field label="School">
            <Select value={assignForm.schoolId} onChange={(e) => setAssignForm({ ...assignForm, schoolId: e.target.value })}>
              <option value="">Select school…</option>
              {schools.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </Field>
          <Field label="Plan">
            <Select value={assignForm.planId} onChange={(e) => setAssignForm({ ...assignForm, planId: e.target.value })}>
              <option value="">Select plan…</option>
              {plans.map((p) => <option key={p.id} value={p.id}>{p.name} — {fmtMoney(p.price)}/{p.cycle === "YEARLY" ? "yr" : "mo"}</option>)}
            </Select>
          </Field>
          <Field label="Cycle">
            <Select value={assignForm.cycle} onChange={(e) => setAssignForm({ ...assignForm, cycle: e.target.value })}>
              {CYCLES.map((c) => <option key={c}>{c}</option>)}
            </Select>
          </Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setAssignOpen(null)}><X size={14} /> Cancel</button>
            <button className="btn btn-primary" onClick={assign} disabled={busy || !assignForm.schoolId || !assignForm.planId}><Check size={14} /> Assign & invoice</button>
          </div>
        </div>
      </Modal>

      {/* Mark paid modal */}
      <Modal open={!!payOpen} onClose={() => setPayOpen(null)} title={`Mark ${payOpen?.invoiceNo || ""} paid`}>
        <div className="space-y-4">
          <div className="rounded-xl bg-slate-50 p-4 text-sm">
            <div className="font-bold text-slate-800">{payOpen?.school?.name}</div>
            <div className="text-xs text-slate-500">{fmtMoney(payOpen?.amount || 0)} · issued {payOpen ? fmtDate(payOpen.issueDate) : ""}</div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Method">
              <Select value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
                <option>BANK</option><option>CASH</option><option>BKASH</option><option>CARD</option>
              </Select>
            </Field>
            <Field label="Reference / TXN"><TextInput value={payForm.refNo} onChange={(e) => setPayForm({ ...payForm, refNo: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setPayOpen(null)}><X size={14} /> Cancel</button>
            <button className="btn btn-primary" onClick={markPaid} disabled={busy}><Check size={14} /> Confirm payment</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
