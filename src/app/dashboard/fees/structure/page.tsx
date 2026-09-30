"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Pencil, Trash2, Calculator, Wallet, CircleAlert } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, TextInput, Select, Modal, PageHeader, LoadingScreen, ErrorNote, EmptyState } from "@/components/ui";
import { fmtMoney, money } from "@/lib/utils";

/**
 * PRD §10.3 — the school's own fee catalogue.
 *
 * The admin names their fee heads (Weekly Exam Fee, Monthly Exam Fee, Yearly
 * Exam Fee, Tuition, Transport…) and prices each one per class, because a
 * Class-5 exam fee is not a Class-1 exam fee. Nothing is hard-coded: the
 * catalogue is theirs to extend.
 *
 * The "Bill a month" panel then turns the catalogue into individual fee rows —
 * which is where the amounts become real. Those rows are ordinary fees, so they
 * appear in the Fees page, in each guardian's Parents App, in student dues and
 * in the ledger with no further work.
 */

const BUCKETS = ["TUITION", "ADMISSION", "EXAM", "TRANSPORT", "HOSTEL", "LIBRARY_FINE", "LATE_FEE", "OTHER"];
const FREQUENCIES = ["WEEKLY", "MONTHLY", "TERM", "YEARLY", "ONE_TIME"];

interface Category {
  id: string;
  name: string;
  bucket: string;
  frequency: string;
  optional: boolean;
  active: boolean;
  dueDay: number | null;
  note: string | null;
  branchId: string | null;
  amounts: Record<string, number>;
}
interface ClassLite { id: string; name: string; order: number }

const EMPTY_FORM = {
  name: "",
  bucket: "TUITION",
  frequency: "MONTHLY",
  optional: false,
  active: true,
  dueDay: "",
  note: "",
  amounts: {} as Record<string, string>,
};

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export default function FeeStructurePage() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [classes, setClasses] = useState<ClassLite[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // editor
  const [editOpen, setEditOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState<any>(EMPTY_FORM);

  // billing run
  const [billIds, setBillIds] = useState<string[]>([]);
  const [period, setPeriod] = useState(thisMonth());
  const [dueDate, setDueDate] = useState("");
  const [billClasses, setBillClasses] = useState<string[]>([]);
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);

  const load = () =>
    api<{ categories: Category[]; classes: ClassLite[] }>("/api/fee-categories")
      .then((d) => {
        setCategories(d.categories || []);
        setClasses(d.classes || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));

  useEffect(() => { load(); }, []);

  const classesById = useMemo(() => new Map(classes.map((c) => [c.id, c.name])), [classes]);

  const openCreate = () => {
    setError("");
    setEditId(null);
    setForm(EMPTY_FORM);
    setEditOpen(true);
  };

  const openEdit = (cat: Category) => {
    setError("");
    setEditId(cat.id);
    const amounts: Record<string, string> = {};
    for (const [classId, v] of Object.entries(cat.amounts || {})) amounts[classId] = String(money(v));
    setForm({
      name: cat.name,
      bucket: cat.bucket,
      frequency: cat.frequency,
      optional: !!cat.optional,
      active: cat.active !== false,
      dueDay: cat.dueDay ?? "",
      note: cat.note || "",
      amounts,
    });
    setEditOpen(true);
  };

  const pricedClasses = (amounts: Record<string, string>) =>
    Object.entries(amounts || {}).filter(([, v]) => money(v) > 0).length;

  const save = async () => {
    setError("");
    if (!form.name.trim()) { setError("Give the fee a name."); return; }
    if (pricedClasses(form.amounts) === 0) { setError("Price at least one class."); return; }
    setBusy(true);
    try {
      const payload = { ...form, dueDay: form.dueDay === "" ? null : Number(form.dueDay) };
      if (editId) await api("/api/fee-categories", { method: "PATCH", body: JSON.stringify({ id: editId, ...payload }) });
      else await api("/api/fee-categories", { method: "POST", body: JSON.stringify(payload) });
      setEditOpen(false);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const toggleActive = async (cat: Category) => {
    setError("");
    try {
      await api("/api/fee-categories", { method: "PATCH", body: JSON.stringify({ id: cat.id, active: cat.active === false }) });
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const remove = async (cat: Category) => {
    if (!window.confirm(`Delete "${cat.name}" from the fee catalogue? Fees already billed are not affected.`)) return;
    setError("");
    try {
      await api(`/api/fee-categories?id=${encodeURIComponent(cat.id)}`, { method: "DELETE" });
      setBillIds((ids) => ids.filter((i) => i !== cat.id));
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  const runBill = async (dryRun: boolean) => {
    setError("");
    if (!billIds.length) { setError("Choose at least one fee to bill."); return; }
    setBusy(true);
    try {
      const data = await api<any>("/api/fees/generate", {
        method: "POST",
        body: JSON.stringify({
          categoryIds: billIds,
          classIds: billClasses,
          period,
          dueDate: dueDate || undefined,
          dryRun,
        }),
      });
      if (dryRun) { setPreview(data); setResult(null); }
      else {
        setResult(data);
        setPreview(null);
        setBillIds([]);
        await load();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;

  const activeCount = categories.filter((c) => c.active !== false).length;

  return (
    <div>
      <PageHeader
        title="Fee structure"
        subtitle={`${categories.length} fee${categories.length === 1 ? "" : "s"} in your catalogue · ${activeCount} active`}
        actions={
          <button className="btn btn-primary btn-sm" onClick={openCreate}>
            <Plus size={14} /> New fee
          </button>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card className="mb-4">
        <CardHeader
          title="Fee catalogue"
          subtitle="Name your fee heads and price them class by class. Add as many as your school needs."
        />
        {categories.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Fee</th>
                  <th className="th">Type</th>
                  <th className="th">Recurs</th>
                  <th className="th">Class-wise amount</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c) => {
                  const priced = Object.entries(c.amounts || {}).sort(
                    (a, b) => (classesById.get(a[0]) || "").localeCompare(classesById.get(b[0]) || "")
                  );
                  return (
                    <tr key={c.id} className="tr-hover align-top">
                      <td className="td">
                        <div className="font-bold text-slate-800">{c.name}</div>
                        {c.note && <div className="text-xs text-slate-400">{c.note}</div>}
                        {c.optional && <div className="mt-1"><Badge tone="violet">Optional</Badge></div>}
                      </td>
                      <td className="td"><Badge tone="slate">{c.bucket.replace(/_/g, " ")}</Badge></td>
                      <td className="td text-xs text-slate-500">{c.frequency.replace(/_/g, " ").toLowerCase()}</td>
                      <td className="td">
                        <div className="flex flex-wrap gap-1.5">
                          {priced.map(([classId, amount]) => (
                            <span key={classId} className="inline-flex items-center gap-1 rounded-lg bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
                              {classesById.get(classId) || "—"} <span className="text-slate-800">{fmtMoney(amount)}</span>
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="td">
                        <Badge tone={c.active === false ? "slate" : "green"}>{c.active === false ? "Inactive" : "Active"}</Badge>
                      </td>
                      <td className="td">
                        <div className="flex justify-end gap-1.5">
                          <button className="btn btn-secondary btn-sm" onClick={() => toggleActive(c)}>
                            {c.active === false ? "Enable" : "Disable"}
                          </button>
                          <button className="btn btn-secondary btn-sm" onClick={() => openEdit(c)} title="Edit"><Pencil size={13} /></button>
                          <button className="btn btn-secondary btn-sm" onClick={() => remove(c)} title="Delete"><Trash2 size={13} /></button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon={Wallet}
            title="No fees defined yet"
            description="Add your first fee head — for example Monthly Exam Fee — and price it for each class."
            action={<button className="btn btn-primary btn-sm" onClick={openCreate}><Plus size={14} /> New fee</button>}
          />
        )}
      </Card>

      <Card>
        <CardHeader
          title="Bill a month"
          subtitle="Turn the catalogue into individual fee rows. Guardians see them instantly in the Parents App."
        />
        <div className="space-y-4 p-5">
          {!categories.length ? (
            <p className="text-sm text-slate-400">Define a fee above before billing.</p>
          ) : (
            <>
              <div>
                <label className="label">Fees to bill</label>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {categories.map((c) => {
                    const on = billIds.includes(c.id);
                    const disabled = c.active === false;
                    return (
                      <label
                        key={c.id}
                        className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-xs font-semibold ${
                          disabled ? "border-slate-100 bg-slate-50 text-slate-400" : "border-slate-200 text-slate-700"
                        }`}
                      >
                        <input
                          type="checkbox"
                          disabled={disabled}
                          className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          checked={on}
                          onChange={(e) =>
                            setBillIds((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((i) => i !== c.id)))
                          }
                        />
                        {c.name}
                        {disabled && <span className="ml-auto text-[10px] font-bold uppercase">inactive</span>}
                      </label>
                    );
                  })}
                </div>
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                <Field label="Billing month" hint="e.g. 2026-10. A student is never billed twice for the same fee and month.">
                  <TextInput value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="2026-10" />
                </Field>
                <Field label="Due date">
                  <TextInput type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
                </Field>
                <Field label="Only these classes" hint="Leave empty for every class the fee is priced for.">
                  <div className="max-h-28 space-y-1 overflow-y-auto rounded-xl border border-slate-200 p-2">
                    {classes.map((c) => (
                      <label key={c.id} className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                        <input
                          type="checkbox"
                          className="h-3.5 w-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                          checked={billClasses.includes(c.id)}
                          onChange={(e) =>
                            setBillClasses((ids) => (e.target.checked ? [...ids, c.id] : ids.filter((i) => i !== c.id)))
                          }
                        />
                        {c.name}
                      </label>
                    ))}
                    {!classes.length && <p className="text-xs text-slate-400">No classes yet.</p>}
                  </div>
                </Field>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <button className="btn btn-secondary" onClick={() => runBill(true)} disabled={busy || !billIds.length}>
                  <Calculator size={15} /> Preview
                </button>
                <button className="btn btn-primary" onClick={() => runBill(false)} disabled={busy || !billIds.length || !preview}>
                  Bill {preview ? `${preview.wouldBill} fee${preview.wouldBill === 1 ? "" : "s"}` : "now"}
                </button>
                {!preview && <span className="text-xs text-slate-400">Preview first — nothing is written until you bill.</span>}
              </div>

              {preview && (
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-bold text-slate-800">
                      {preview.wouldBill} fee{preview.wouldBill === 1 ? "" : "s"} · {fmtMoney(preview.total)} to bill for {preview.period}
                    </div>
                    {preview.skipped > 0 && (
                      <div className="text-xs text-slate-500">{preview.skipped} already billed — will be skipped</div>
                    )}
                  {!!preview.mismatched?.length && (
                    <div className="mt-1 text-xs text-amber-700">
                      Not billed for {preview.period}:{" "}
                      {preview.mismatched.map((m: any) => m.name).join(", ")} — a {preview.mismatched[0].frequency.toLowerCase()} fee is billed for a {preview.mismatched[0].frequency === "YEARLY" ? "year (e.g. 2026)" : "whole cadence"}, not for {preview.period}.
                    </div>
                  )}
                  </div>
                  {preview.plan?.length ? (
                    <div className="mt-3 max-h-56 overflow-y-auto">
                      <table className="w-full">
                        <thead>
                          <tr><th className="th">Student</th><th className="th">Class</th><th className="th">Fee</th><th className="th text-right">Amount</th></tr>
                        </thead>
                        <tbody>
                          {preview.plan.slice(0, 60).map((p: any, i: number) => (
                            <tr key={i}>
                              <td className="td text-xs">{p.studentName}</td>
                              <td className="td text-xs text-slate-500">{classesById.get(p.classId) || "—"}</td>
                              <td className="td text-xs">{p.categoryName}</td>
                              <td className="td text-right text-xs font-bold">{fmtMoney(p.amount)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {preview.plan.length > 60 && (
                        <p className="pt-2 text-xs text-slate-400">…and {preview.plan.length - 60} more.</p>
                      )}
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-slate-500">
                      {preview.mismatched?.length && !preview.wouldBill
                        ? `Nothing to bill — the selected fee${preview.mismatched.length === 1 ? "" : "s"} do${preview.mismatched.length === 1 ? "es" : ""} not bill for ${preview.period}.`
                        : `Nobody to bill — every priced student is already billed for ${preview.period}.`}
                    </p>
                  )}
                </div>
              )}

              {result && (
                <div className="flex items-start gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
                  <CircleAlert size={16} className="mt-0.5 shrink-0" />
                  <div>
                    Billed <strong>{result.created}</strong> fee{result.created === 1 ? "" : "s"} for {result.period}
                    {result.skipped > 0 && <> · {result.skipped} skipped (already billed)</>}. Guardians can see them now.
                    {!!result.mismatched?.length && (
                      <div className="mt-1 text-xs text-amber-700">
                        Not billed: {result.mismatched.map((m: any) => m.name).join(", ")} — their cadence does not match the period {result.mismatched[0].frequency === "YEARLY" ? "(a yearly fee is billed for a year, e.g. 2026)" : "shape"}.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

      {/* create / edit */}
      <Modal open={editOpen} onClose={() => { setEditOpen(false); setError(""); }} title={editId ? "Edit fee" : "New fee"} wide>
        <div className="space-y-4">
          {error && <ErrorNote message={error} />}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Field label="Fee name" hint="What the school calls it, e.g. Monthly Exam Fee">
              <TextInput value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </Field>
            <Field label="Ledger type" hint="The accounting line this money posts to.">
              <Select value={form.bucket} onChange={(e) => setForm({ ...form, bucket: e.target.value })}>
                {BUCKETS.map((b) => <option key={b} value={b}>{b.replace(/_/g, " ")}</option>)}
              </Select>
            </Field>
            <Field label="Recurs">
              <Select value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })}>
                {FREQUENCIES.map((f) => <option key={f} value={f}>{f.replace(/_/g, " ")}</option>)}
              </Select>
            </Field>
            <Field label="Due day (optional)" hint="Day of the month, 1–28.">
              <TextInput type="number" min="1" max="28" value={form.dueDay} onChange={(e) => setForm({ ...form, dueDay: e.target.value })} />
            </Field>
          </div>

          <Field label="Note (optional)">
            <TextInput value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          </Field>

          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                checked={form.optional}
                onChange={(e) => setForm({ ...form, optional: e.target.checked })}
              />
              Optional / elective (e.g. transport) — not billed unless chosen
            </label>
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                checked={form.active}
                onChange={(e) => setForm({ ...form, active: e.target.checked })}
              />
              Active — available when billing
            </label>
          </div>

          <div>
            <label className="label">Amount per class (৳)</label>
            <p className="mb-2 text-xs text-slate-400">
              Leave a class blank and it is not charged this fee. Fees vary class to class — that is the point.
            </p>
            {classes.length ? (
              <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto sm:grid-cols-2">
                {classes.map((c) => (
                  <div key={c.id} className="flex items-center gap-2">
                    <span className="w-28 shrink-0 truncate text-xs font-semibold text-slate-600" title={c.name}>{c.name}</span>
                    <TextInput
                      type="number"
                      min="0"
                      className="!py-1.5"
                      value={form.amounts[c.id] ?? ""}
                      onChange={(e) => setForm({ ...form, amounts: { ...form.amounts, [c.id]: e.target.value } })}
                    />
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400">No classes yet — create classes first, then price them here.</p>
            )}
          </div>

          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-slate-400">{pricedClasses(form.amounts)} class(es) priced</span>
            <div className="flex gap-2">
              <button className="btn btn-secondary" onClick={() => { setEditOpen(false); setError(""); }}>Cancel</button>
              <button className="btn btn-primary" onClick={save} disabled={busy}>
                {busy ? "Saving…" : editId ? "Save changes" : "Add fee"}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    </div>
  );
}
