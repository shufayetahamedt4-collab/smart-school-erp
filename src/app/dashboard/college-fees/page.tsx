"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Award, BadgeCheck, Layers, Plus, Receipt, Trash2, Wallet } from "lucide-react";
import { api, qs } from "@/lib/client";
import { useMe } from "@/components/Shell";
import { PAY_METHODS, newChannelId, type PaymentChannel } from "@/lib/fee-channels";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Field,
  LoadingScreen,
  Modal,
  PageHeader,
  Select,
  TextInput,
  Textarea,
} from "@/components/ui";
import {
  CHANNEL_KIND_OPTIONS,
  COLLEGE_FEE_TABS,
  HEAD_BUCKET_OPTIONS,
  HEAD_FREQUENCY_OPTIONS,
  PAGE_ERRORS,
  STRUCTURE_BASIS_OPTIONS,
  STRUCTURE_UNIT_OPTIONS,
  appliedAwardsText,
  awardButtonLabel,
  awardDecidable,
  awardKindText,
  awardProposeBlocked,
  awardScopeText,
  awardStateText,
  awardTone,
  basisLabel,
  bucketLabel,
  channelKindLabel,
  channelLine,
  channelsOf,
  chargeTotals,
  collegeFeesPageState,
  commitButtonLabel,
  configBlocked,
  configButtonLabel,
  countText,
  currencyOf,
  decideButtonLabel,
  duesScopeText,
  dueStatusText,
  formatMinor,
  formatMoney,
  frequencyLabel,
  generateBlocked,
  generationStudentText,
  generationSummaryText,
  headBlocked,
  headStateText,
  majorFromTyped,
  newPaymentKey,
  payBlocked,
  payButtonLabel,
  payDisabled,
  paymentDoneText,
  previewButtonLabel,
  programmeOptions,
  readMoneyField,
  readOnlyNote,
  refusalText,
  rowsForTerm,
  saveButtonLabel,
  structureBlocked,
  structureRowsText,
  structureTotalsText,
  tabFor,
  unitLabel,
  writeControlsFor,
  type CollegeFeeTab,
} from "@/lib/college-fees-view";

/**
 * College support (Phase 7d) — the college fee SCREENS
 * (docs/COLLEGE-DECISIONS.md §24, D-7-16), over the Phase 7c API.
 *
 * ONE route and ONE nav entry (`requires:"COLLEGE"`) carry all four screens of
 * D-7-16, as tabs: **Fee heads**, **Fee structure** (programme ▸ term ▸ heads ×
 * amount with a live term total), **Dues & generation** (the per-programme/term
 * dues read with the dry-run → commit flow, the payment form and the waiver
 * propose/approve flow) and **Payment config** (the college's own channels, D-7-3).
 *
 * The rules this page is built on, all of them enforced elsewhere too:
 *
 *  - **It reads and writes ONLY `/api/college-fees/*`** (the 7c API). There is no
 *    direct database access, no new route, and no school fee endpoint: the school
 *    `fee` surfaces and the school's own `/api/programs` are deliberately NOT
 *    used — and the ACCOUNTANT (a D-7-18 writer) holds no `programs` permission,
 *    so the programme picker comes from the college read that owns the programme
 *    dimension, `GET /api/college-fees/structure` (its additive `programmes`
 *    array). Nothing else served by that route changed.
 *  - **Money never becomes a float here.** Every amount is carried as whole minor
 *    units (paisa) and printed by the ONE helper (`formatMinor`), which the
 *    offline verifier pins: no `toFixed`, no `toLocaleString`, no `/ 100` and no
 *    `fmtMoney` may appear in this file.
 *  - **The v1 access rule decides the controls** (D-7-18): `writeControlsFor(role)`
 *    answers which write controls exist for the signed-in role, so a REGISTRAR —
 *    read-only in v1 — is shown no write control at all, and TEACHER, GUARDIAN and
 *    STUDENT get a refusal and issue NO request. The API remains the real guard
 *    (`requireCollege` → the allow-list in every handler).
 *  - **A refusal is shown verbatim** (`refusalText` → the server's own 400/409
 *    text) and a money form's button is disabled while its request is in flight,
 *    so a double-click cannot duplicate a payment and a refused request is never
 *    retried silently. No charge amount is ever typed: charges come from
 *    `/api/college-fees/generate` over the admin's own structure rows.
 */

/* ------------------------------------------------------------------ payloads */

interface Head {
  id: string;
  name: string;
  bucket: string;
  frequency: string;
  optional: boolean;
  active: boolean;
  dueDay: number | null;
  note: string | null;
}

interface StructureRow {
  id: string;
  programId: string;
  termNumber: number;
  headId: string;
  amount: number;
  required: boolean;
  unit: string;
  basis: string;
  note: string | null;
}

interface Programme {
  id: string;
  name: string;
  termSystem?: string | null;
  durationYears?: number | null;
  termCount?: number | null;
}

interface StructurePayload {
  rows: StructureRow[];
  heads: Head[];
  programmes?: Programme[];
  termNumber: number | null;
  programId: string | null;
  termSystem: string | null;
  termCount: number | null;
  rowsTotal: number;
  billTotal: number;
  rowCount: number;
}

interface Charge {
  id: string;
  studentId: string;
  studentName: string | null;
  studentAdmissionNo: string | null;
  programId: string;
  termNumber: number;
  headId: string;
  headName: string | null;
  title: string;
  amount: number;
  discount: number;
  paidAmount: number;
  due: number;
  status: string;
  sequence: number;
  unit: string;
  dueDate: string | null;
}

interface DuesScopePayload {
  students: {
    studentId: string;
    name: string | null;
    admissionNo: string | null;
    programId: string | null;
    termNumber: number | null;
    count: number;
    billed: number;
    discount: number;
    paid: number;
    due: number;
    status: string;
  }[];
  totals: { count: number; billed: number; discount: number; paid: number; due: number; students: number };
  currency: string;
}

interface DuesStudentPayload {
  student: { id: string; name: string; admissionNo: string | null; programId: string | null; termNumber: number | null };
  rows: Charge[];
  currency: string;
}

interface Award {
  id: string;
  kind: string;
  percent: number | null;
  amountPerHead: number | null;
  headIds: string[];
  programId: string | null;
  termNumber: number | null;
  status: string;
  proposedBy: string | null;
  approvedBy: string | null;
  note: string | null;
}

interface ConfigPayload {
  schoolId: string;
  channels: PaymentChannel[];
  paymentNote: string | null;
  currency: string;
}

/* ---------------------------------------------------------------------- page */

export default function CollegeFeesPage() {
  const { me, loading: meLoading, error: meError } = useMe();
  const institutionType = me?.school?.institutionType ?? me?.institutionType ?? null;
  const role = me?.user?.role;
  const state = collegeFeesPageState({ meLoading, meError, resolved: !!me, institutionType, role });
  // The tab is local state, seeded once from `?tab=` AFTER hydration so the
  // server-rendered markup and the first client render still agree.
  const [tab, setTab] = useState<CollegeFeeTab>("heads");

  useEffect(() => {
    if (typeof window === "undefined") return;
    const fromQuery = tabFor(new URLSearchParams(window.location.search).get("tab"));
    if (fromQuery !== "heads") setTab(fromQuery);
  }, []);

  if (state === "loading") return <LoadingScreen label="Loading college fees…" />;

  if (state === "error") {
    return (
      <div>
        <PageHeader icon={Wallet} title="College Fees" subtitle="Heads, structures, dues and payments" />
        <Card>
          <div className="px-6 py-8">
            <ErrorNote message={meError || PAGE_ERRORS.heads} />
          </div>
        </Card>
      </div>
    );
  }

  if (state === "no-college") {
    return (
      <div>
        <PageHeader icon={Wallet} title="College Fees" subtitle="Heads, structures, dues and payments" />
        <Card>
          <EmptyState
            icon={Wallet}
            title="Available to college institutions only"
            description="This institution runs the school curriculum. College fee heads, structures and dues are part of the college setup."
          />
        </Card>
      </div>
    );
  }

  if (state === "refused") {
    return (
      <div>
        <PageHeader icon={Wallet} title="College Fees" subtitle="Heads, structures, dues and payments" />
        <Card>
          <EmptyState
            icon={Wallet}
            title="Not available for your role"
            description="College fees are available to the school administration, the accounts office and the registrar."
          />
        </Card>
      </div>
    );
  }

  const controls = writeControlsFor(role);
  const canWrite = controls.heads || controls.structure || controls.generate || controls.pay || controls.config;

  return (
    <div>
      <PageHeader
        icon={Wallet}
        title="College Fees"
        subtitle="The college's own fee heads, its programme × term pricing, its dues and its payment channels"
      />

      <div className="mb-4 flex flex-wrap gap-2">
        {COLLEGE_FEE_TABS.map((t) => (
          <button
            key={t.key}
            className={`btn btn-sm ${tab === t.key ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setTab(t.key)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!canWrite && (
        <div className="mb-4 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-600">
          {readOnlyNote()}
        </div>
      )}

      {tab === "heads" && <HeadsTab controls={controls} />}
      {tab === "structure" && <StructureTab controls={controls} />}
      {tab === "dues" && <DuesTab controls={controls} role={role} actorId={me?.user?.id} />}
      {tab === "config" && <ConfigTab controls={controls} />}
    </div>
  );
}

/* --------------------------------------------------------------------- heads */

function HeadsTab({ controls }: { controls: ReturnType<typeof writeControlsFor> }) {
  const [heads, setHeads] = useState<Head[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState("");
  const [name, setName] = useState("");
  const [bucket, setBucket] = useState("TUITION");
  const [frequency, setFrequency] = useState("TERM");
  const [dueDay, setDueDay] = useState("");
  const [optional, setOptional] = useState(false);
  const [active, setActive] = useState(true);
  const [note, setNote] = useState("");

  const load = useCallback(async () => {
    try {
      const rows = await api<Head[]>("/api/college-fees/heads");
      setHeads(Array.isArray(rows) ? rows : []);
      setError("");
    } catch (e: any) {
      setHeads([]);
      setError(refusalText(e, PAGE_ERRORS.heads));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openCreate = () => {
    setEditingId("");
    setName("");
    setBucket("TUITION");
    setFrequency("TERM");
    setDueDay("");
    setOptional(false);
    setActive(true);
    setNote("");
    setOpen(true);
  };

  const openEdit = (head: Head) => {
    setEditingId(head.id);
    setName(head.name);
    setBucket(head.bucket);
    setFrequency(head.frequency);
    setDueDay(head.dueDay === null || head.dueDay === undefined ? "" : String(head.dueDay));
    setOptional(!!head.optional);
    setActive(head.active !== false);
    setNote(head.note || "");
    setOpen(true);
  };

  const submit = async () => {
    if (headBlocked({ name, busy })) return;
    setBusy(true);
    setError("");
    setNotice("");
    const payload = {
      ...(editingId ? { id: editingId } : {}),
      name,
      bucket,
      frequency,
      optional,
      active,
      dueDay: dueDay === "" ? null : Number(dueDay),
      note: note || null,
    };
    try {
      // The SERVER validates (7a): only the name is a hard rule, the bucket and
      // the cadence fall back and the due day clamps 1..28.
      await api("/api/college-fees/heads", { method: editingId ? "PATCH" : "POST", body: JSON.stringify(payload) });
      setOpen(false);
      setNotice(editingId ? `Updated ${name}.` : `Added ${name}.`);
      await load();
    } catch (e: any) {
      setError(refusalText(e, PAGE_ERRORS.save));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (head: Head) => {
    if (busy) return;
    if (typeof window !== "undefined" && !window.confirm(`Delete the fee head “${head.name}”?`)) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/college-fees/heads?id=${encodeURIComponent(head.id)}`, { method: "DELETE" });
      setNotice(`Deleted ${head.name}.`);
      await load();
    } catch (e: any) {
      setError(refusalText(e, PAGE_ERRORS.save));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <Card>
      <CardHeader
        title="Fee heads"
        subtitle="What this college charges for. The AMOUNT lives in the structure — the same head costs different money in different programmes and terms."
        action={
          controls.heads ? (
            <button className="btn btn-primary btn-sm" onClick={openCreate}>
              <Plus size={14} /> Add fee head
            </button>
          ) : undefined
        }
      />

      {notice && <div className="border-b border-emerald-100 bg-emerald-50 px-5 py-2 text-xs font-semibold text-emerald-700">{notice}</div>}
      {error && (
        <div className="border-b border-rose-100 bg-rose-50 px-5 py-3 text-sm text-rose-700">{error}</div>
      )}

      {heads.length === 0 ? (
        <EmptyState
          icon={Wallet}
          title="No fee heads yet"
          description="Add the heads this college bills — tuition, admission, exam, laboratory, transport — then price them per programme and term."
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr>
                <th className="th">Head</th>
                <th className="th">Bucket</th>
                <th className="th">Cadence</th>
                <th className="th">State</th>
                <th className="th text-center">Due day</th>
                {controls.heads && <th className="th text-right">Actions</th>}
              </tr>
            </thead>
            <tbody>
              {heads.map((h) => (
                <tr key={h.id} className="tr-hover">
                  <td className="td">
                    <div className="text-sm font-semibold text-slate-700">{h.name}</div>
                    {h.note && <div className="text-[11px] text-slate-400">{h.note}</div>}
                  </td>
                  <td className="td text-xs text-slate-600">{bucketLabel(h.bucket)}</td>
                  <td className="td text-xs text-slate-600">{frequencyLabel(h.frequency)}</td>
                  <td className="td text-xs">
                    <Badge tone={h.active === false ? "slate" : h.optional ? "amber" : "green"}>{headStateText(h.active, h.optional)}</Badge>
                  </td>
                  <td className="td text-center text-xs text-slate-500">{h.dueDay ?? "—"}</td>
                  {controls.heads && (
                    <td className="td text-right">
                      <div className="flex justify-end gap-1">
                        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => openEdit(h)}>
                          Edit
                        </button>
                        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => remove(h)}>
                          <Trash2 size={13} /> Delete
                        </button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <Modal open={open} onClose={() => setOpen(false)} title={editingId ? "Edit fee head" : "Add a fee head"}>
        <div className="space-y-3">
          <Field label="Name">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Tuition (per term)" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Bucket">
              <Select value={bucket} onChange={(e) => setBucket(e.target.value)}>
                {HEAD_BUCKET_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {bucketLabel(b)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Cadence" hint="How many times a term bills this row">
              <Select value={frequency} onChange={(e) => setFrequency(e.target.value)}>
                {HEAD_FREQUENCY_OPTIONS.map((f) => (
                  <option key={f} value={f}>
                    {frequencyLabel(f)}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Due day" hint="1–28 (blank = no fixed day)">
              <TextInput type="number" min={1} max={28} value={dueDay} onChange={(e) => setDueDay(e.target.value)} />
            </Field>
            <div className="flex items-end gap-4 pb-1">
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <input type="checkbox" checked={optional} onChange={(e) => setOptional(e.target.checked)} /> Optional
              </label>
              <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> Active
              </label>
            </div>
          </div>
          <Field label="Note">
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} placeholder="Shown with the head on the statement" />
          </Field>
          <div className="flex justify-end gap-2 pt-1">
            <button className="btn btn-secondary" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={submit} disabled={false}>
              {saveButtonLabel(busy, editingId ? "Save head" : "Add head")}
            </button>
          </div>
        </div>
      </Modal>
    </Card>
  );
}

/* ----------------------------------------------------------------- structure */

function StructureTab({ controls }: { controls: ReturnType<typeof writeControlsFor> }) {
  const [payload, setPayload] = useState<StructurePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [programId, setProgramId] = useState("");
  const [termNumber, setTermNumber] = useState("1");
  const [headId, setHeadId] = useState("");
  const [amount, setAmount] = useState("");
  const [unit, setUnit] = useState("STUDENT");
  const [basis, setBasis] = useState("FLAT");
  const [required, setRequired] = useState(true);
  const [rowNote, setRowNote] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await api<StructurePayload>(`/api/college-fees/structure${qs({ programId: programId || undefined, termNumber: termNumber || undefined })}`);
      setPayload(data);
      setError("");
    } catch (e: any) {
      setPayload(null);
      setError(refusalText(e, PAGE_ERRORS.structure));
    } finally {
      setLoading(false);
    }
  }, [programId, termNumber]);

  useEffect(() => {
    void load();
  }, [load]);

  const programmes = useMemo(() => programmeOptions(payload?.programmes), [payload]);
  const heads = payload?.heads ?? [];
  const rows = termNumber ? rowsForTerm(payload?.rows, termNumber) : payload?.rows ?? [];
  const currency = "BDT";
  const termCount = Math.max(1, Number(payload?.termCount ?? 1));

  const addRow = async () => {
    if (structureBlocked({ programId, headId, amount, termNumber, busy })) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // The typed amount is read into integer paisa and handed back as money —
      // never a float that could carry a third decimal into the row.
      await api("/api/college-fees/structure", {
        method: "POST",
        body: JSON.stringify({
          programId,
          termNumber: Number(termNumber),
          headId,
          amount: majorFromTyped(amount),
          unit,
          basis,
          required,
          note: rowNote || null,
        }),
      });
      setAmount("");
      setRowNote("");
      setNotice("Structure row added.");
      await load();
    } catch (e: any) {
      // A duplicate (programme, term, head) is the API's own visible 409.
      setError(refusalText(e, PAGE_ERRORS.save));
    } finally {
      setBusy(false);
    }
  };

  const removeRow = async (row: StructureRow) => {
    if (busy) return;
    if (typeof window !== "undefined" && !window.confirm("Delete this structure row?")) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/college-fees/structure?id=${encodeURIComponent(row.id)}`, { method: "DELETE" });
      setNotice("Structure row removed.");
      await load();
    } catch (e: any) {
      setError(refusalText(e, PAGE_ERRORS.save));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title="Programme and term"
          subtitle="The structure is one row per programme × term × head. The programme's own term shape bounds the term number."
        />
        <div className="grid grid-cols-1 items-end gap-3 p-5 sm:grid-cols-3">
          <Field label="Programme">
            <Select
              value={programId}
              onChange={(e) => {
                setProgramId(e.target.value);
                setTermNumber("1");
              }}
            >
              <option value="">All programmes</option>
              {programmes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Term">
            <Select value={termNumber} onChange={(e) => setTermNumber(e.target.value)}>
              {Array.from({ length: termCount }, (_, i) => i + 1).map((t) => (
                <option key={t} value={String(t)}>
                  Term {t}
                </option>
              ))}
            </Select>
          </Field>
          <div className="text-xs text-slate-500">
            <span className="font-semibold text-slate-600">{countText(rows.length, "row")}</span> ·{" "}
            {structureTotalsText(rows, payload?.billTotal, currency)}
          </div>
        </div>
      </Card>

      {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{notice}</div>}
      {error && <ErrorNote message={error} />}

      {controls.structure && (
        <Card>
          <CardHeader
            title="Price a head for this term"
            subtitle="One row = what ONE billing event charges. The head's cadence decides how many events the term produces."
          />
          <div className="grid grid-cols-1 items-end gap-3 p-5 sm:grid-cols-4">
            <Field label="Fee head" className="sm:col-span-2">
              <Select value={headId} onChange={(e) => setHeadId(e.target.value)}>
                <option value="">Choose a head…</option>
                {heads.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} ({frequencyLabel(h.frequency)})
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Amount">
              <TextInput value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="e.g. 4500" inputMode="decimal" />
            </Field>
            <Field label="Covers">
              <Select value={unit} onChange={(e) => setUnit(e.target.value)}>
                {STRUCTURE_UNIT_OPTIONS.map((u) => (
                  <option key={u} value={u}>
                    {unitLabel(u)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Basis" hint="Per-credit pricing is not in v1 and is refused by name">
              <Select value={basis} onChange={(e) => setBasis(e.target.value)}>
                {STRUCTURE_BASIS_OPTIONS.map((b) => (
                  <option key={b} value={b}>
                    {basisLabel(b)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Required">
              <Select value={required ? "yes" : "no"} onChange={(e) => setRequired(e.target.value === "yes")}>
                <option value="yes">Required</option>
                <option value="no">Optional</option>
              </Select>
            </Field>
            <Field label="Note" className="sm:col-span-2">
              <TextInput value={rowNote} onChange={(e) => setRowNote(e.target.value)} placeholder="Shown on the statement" />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
            <p className="text-xs text-slate-400">
              {programId ? "Adding to the selected programme and term." : "Choose a programme (and its term) before adding a row."}
            </p>
            <button className="btn btn-primary" onClick={addRow} disabled={structureBlocked({ programId, headId, amount, termNumber, busy })}>
              {saveButtonLabel(busy, "Add structure row")}
            </button>
          </div>
        </Card>
      )}

      <Card>
        <CardHeader
          title="Term pricing"
          subtitle={programId ? "What this programme's term charges, head by head" : "Every priced row this college holds"}
          action={<span className="text-xs text-slate-500">{structureRowsText(rows, currency)}</span>}
        />
        {rows.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="Nothing priced for this term yet"
            description="Add a row above: a head, an amount, and whether it applies to the student or to each approved course."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Head</th>
                  <th className="th text-center">Term</th>
                  <th className="th text-center">Covers</th>
                  <th className="th text-center">Basis</th>
                  <th className="th text-center">Required</th>
                  <th className="th text-right">Amount</th>
                  {controls.structure && <th className="th text-right">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const head = heads.find((h) => h.id === row.headId);
                  return (
                    <tr key={row.id} className="tr-hover">
                      <td className="td text-sm font-semibold text-slate-700">
                        {head?.name || "Head"}
                        {row.note && <div className="text-[11px] text-slate-400">{row.note}</div>}
                      </td>
                      <td className="td text-center text-xs text-slate-500">{row.termNumber}</td>
                      <td className="td text-center text-xs text-slate-600">{unitLabel(row.unit)}</td>
                      <td className="td text-center text-xs text-slate-600">{basisLabel(row.basis)}</td>
                      <td className="td text-center text-xs">
                        <Badge tone={row.required === false ? "amber" : "slate"}>{row.required === false ? "Optional" : "Required"}</Badge>
                      </td>
                      <td className="td text-right text-sm font-bold text-slate-800">{formatMoney(row.amount, currency)}</td>
                      {controls.structure && (
                        <td className="td text-right">
                          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => removeRow(row)}>
                            <Trash2 size={13} /> Delete
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">
          A row's term is frozen once it has been billed: raising history is never rewritten, so change the row for unbilled terms instead.
        </p>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------- dues + money */

function DuesTab({
  controls,
  role,
  actorId,
}: {
  controls: ReturnType<typeof writeControlsFor>;
  role: unknown;
  actorId: unknown;
}) {
  const [programmes, setProgrammes] = useState<Programme[]>([]);
  const [heads, setHeads] = useState<Head[]>([]);
  const [scope, setScope] = useState<DuesScopePayload | null>(null);
  const [student, setStudent] = useState<DuesStudentPayload | null>(null);
  const [awards, setAwards] = useState<Award[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const [programId, setProgramId] = useState("");
  const [termNumber, setTermNumber] = useState("1");
  const [dueDate, setDueDate] = useState("");
  const [preview, setPreview] = useState<any | null>(null);

  const [pickedStudent, setPickedStudent] = useState("");
  const [chargeId, setChargeId] = useState("");
  const [payAmount, setPayAmount] = useState("");
  const [method, setMethod] = useState("CASH");
  const [refNo, setRefNo] = useState("");
  const [payBusy, setPayBusy] = useState(false);

  /**
   * 7e-pre — ONE idempotency key per payment ATTEMPT, not per request.
   *
   * The ref holds the key of the attempt in flight: it is created when a submit
   * first needs it, KEPT across a retry or a failed request (so repeating the
   * request repeats the payment instead of adding to it), and thrown away only
   * after a success or when the user changes what is being paid — the charge, the
   * amount or the method. That is what makes two clicks in one task, a second tab
   * and a retried POST all carry the SAME key, and what makes the server able to
   * answer the repeats from the first payment.
   */
  const payKey = useRef("");
  useEffect(() => {
    payKey.current = "";
  }, [pickedStudent, chargeId, payAmount, method]);

  const [awardKind, setAwardKind] = useState("PERCENT");
  const [percent, setPercent] = useState("100");
  const [amountPerHead, setAmountPerHead] = useState("");
  const [awardHeads, setAwardHeads] = useState<string[]>([]);
  const [awardProgramId, setAwardProgramId] = useState("");
  const [awardTerm, setAwardTerm] = useState("");
  const [awardNote, setAwardNote] = useState("");
  const [awardBusy, setAwardBusy] = useState(false);
  const [decidingId, setDecidingId] = useState("");

  const currency = scope?.currency || student?.currency || "BDT";

  /** The programme list comes from the college read that owns it (never the school catalogue). */
  const loadPicker = useCallback(async () => {
    try {
      const data = await api<StructurePayload>("/api/college-fees/structure");
      setProgrammes(Array.isArray(data?.programmes) ? data.programmes : []);
      setHeads(Array.isArray(data?.heads) ? data.heads : []);
    } catch (e: any) {
      setError(refusalText(e, PAGE_ERRORS.programmes));
    }
  }, []);

  const loadScope = useCallback(async () => {
    try {
      const data = await api<DuesScopePayload>(
        `/api/college-fees/dues${qs({ programId: programId || undefined, termNumber: termNumber || undefined })}`
      );
      setScope(data);
      setError("");
    } catch (e: any) {
      setScope(null);
      setError(refusalText(e, PAGE_ERRORS.dues));
    }
  }, [programId, termNumber]);

  const loadStudent = useCallback(async (studentId: string) => {
    if (!studentId) {
      setStudent(null);
      return;
    }
    try {
      const data = await api<DuesStudentPayload>(`/api/college-fees/dues${qs({ studentId })}`);
      setStudent(data);
      const firstOpen = (data?.rows || []).find((r) => Number(r.due) > 0);
      setChargeId(firstOpen?.id || "");
    } catch (e: any) {
      setStudent(null);
      setError(refusalText(e, PAGE_ERRORS.charges));
    }
  }, []);

  const loadAwards = useCallback(async () => {
    try {
      const rows = await api<Award[]>("/api/college-fees/discounts");
      setAwards(Array.isArray(rows) ? rows : []);
    } catch (e: any) {
      setAwards([]);
      setError(refusalText(e, PAGE_ERRORS.discounts));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    void (async () => {
      await Promise.all([loadPicker(), loadScope(), loadAwards()]);
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void loadScope();
  }, [loadScope]);

  useEffect(() => {
    void loadStudent(pickedStudent);
  }, [pickedStudent, loadStudent]);

  const runGeneration = async (dryRun: boolean) => {
    if (generateBlocked({ programId, termNumber, busy })) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const outcome = await api<any>("/api/college-fees/generate", {
        method: "POST",
        body: JSON.stringify({
          programId,
          termNumber: Number(termNumber),
          dryRun,
          dueDate: dueDate || null,
        }),
      });
      setPreview(outcome);
      if (dryRun) setNotice("");
      else {
        setNotice(generationSummaryText(outcome));
        await Promise.all([loadScope(), loadStudent(pickedStudent), loadAwards()]);
      }
    } catch (e: any) {
      setError(refusalText(e, dryRun ? PAGE_ERRORS.generate : PAGE_ERRORS.save));
    } finally {
      setBusy(false);
    }
  };

  const pay = async () => {
    if (payBlocked({ chargeId, amount: payAmount, method, busy: payBusy })) return;
    const read = readMoneyField(payAmount);
    if (!read.ok) {
      setError(read.error);
      return;
    }
    // The key of THIS attempt: generated once, kept if the request fails so the
    // retry cannot become a second payment.
    const idempotencyKey = payKey.current || (payKey.current = newPaymentKey());
    setPayBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<any>("/api/college-fees/payments", {
        method: "POST",
        body: JSON.stringify({ chargeId, amountMinor: read.minor, method, refNo: refNo || null, idempotencyKey }),
      });
      payKey.current = ""; // this attempt is done — the next one is a new payment
      setPayAmount("");
      setRefNo("");
      setNotice(paymentDoneText(result, currency));
      await loadStudent(pickedStudent);
      await loadScope();
    } catch (e: any) {
      // A refusal — an over-payment, a key already spent on a different payment,
      // a charge that settled first — is the API's own 409, shown as written. The
      // key is deliberately KEPT: repeating this attempt can only replay the first
      // result, never pay twice.
      setError(refusalText(e, PAGE_ERRORS.pay));
    } finally {
      setPayBusy(false);
    }
  };

  const proposeAward = async () => {
    if (awardProposeBlocked({ kind: awardKind, percent, amountPerHead, headIds: awardHeads, busy: awardBusy })) return;
    setAwardBusy(true);
    setError("");
    setNotice("");
    try {
      await api("/api/college-fees/discounts", {
        method: "POST",
        body: JSON.stringify({
          kind: awardKind,
          ...(awardKind === "FIXED"
            ? { amountPerHead: majorFromTyped(amountPerHead), headIds: awardHeads }
            : { percent: Number(percent), headIds: [] }),
          programId: awardProgramId || null,
          termNumber: awardTerm ? Number(awardTerm) : null,
          note: awardNote || null,
        }),
      });
      setAwardNote("");
      setNotice("Award proposed — an administrator approves it, and it applies to charges raised after that.");
      await loadAwards();
    } catch (e: any) {
      setError(refusalText(e, PAGE_ERRORS.save));
    } finally {
      setAwardBusy(false);
    }
  };

  const decide = async (award: Award, state: "APPROVED" | "REJECTED") => {
    if (decidingId) return;
    setDecidingId(award.id);
    setError("");
    setNotice("");
    try {
      await api("/api/college-fees/discounts", {
        method: "PATCH",
        body: JSON.stringify({ id: award.id, state }),
      });
      setNotice(state === "APPROVED" ? "Award approved." : "Award rejected.");
      await loadAwards();
    } catch (e: any) {
      setError(refusalText(e, PAGE_ERRORS.decide));
    } finally {
      setDecidingId("");
    }
  };

  const openCharges = useMemo(() => (student?.rows || []).filter((r) => Number(r.due) > 0), [student]);
  const selectedCharge = openCharges.find((c) => c.id === chargeId) || null;

  if (loading) return <LoadingScreen />;

  return (
    <div className="space-y-4">
      {notice && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{notice}</div>}
      {error && <ErrorNote message={error} />}

      <Card>
        <CardHeader
          title="Charge generation"
          subtitle="Charges are DERIVED: a programme, a term, the structure priced for it and each student's approved registrations. No amount is typed here."
        />
        <div className="grid grid-cols-1 items-end gap-3 p-5 sm:grid-cols-4">
          <Field label="Programme">
            <Select
              value={programId}
              onChange={(e) => {
                setProgramId(e.target.value);
                setPreview(null);
              }}
            >
              <option value="">Choose a programme…</option>
              {programmes.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Term">
            <TextInput
              type="number"
              min={1}
              value={termNumber}
              onChange={(e) => {
                setTermNumber(e.target.value);
                setPreview(null);
              }}
            />
          </Field>
          <Field label="Due date" hint="Optional">
            <TextInput type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
          </Field>
          {controls.generate ? (
            <div className="flex gap-2">
              <button
                className="btn btn-secondary"
                disabled={generateBlocked({ programId, termNumber, busy })}
                onClick={() => runGeneration(true)}
              >
                {previewButtonLabel(busy)}
              </button>
              <button
                className="btn btn-primary"
                disabled={generateBlocked({ programId, termNumber, busy })}
                onClick={() => runGeneration(false)}
              >
                {commitButtonLabel(busy)}
              </button>
            </div>
          ) : (
            <p className="text-xs text-slate-400">Read-only: charges are generated by the administration and the accounts office.</p>
          )}
        </div>
        {preview && (
          <div className="border-t border-slate-100 px-5 py-3">
            <p className="text-sm font-semibold text-slate-700">
              {preview.dryRun ? "Preview (nothing written)" : "Committed"} — {preview.programName} {preview.termLabel}
            </p>
            <p className="mt-1 text-xs text-slate-500">{generationSummaryText(preview)}</p>
            {appliedAwardsText(preview) && <p className="mt-1 text-xs text-amber-700">{appliedAwardsText(preview)}</p>}
            <ul className="mt-2 space-y-0.5 text-xs text-slate-500">
              {(preview.students || []).slice(0, 8).map((s: any) => (
                <li key={s.studentId}>{generationStudentText(s, preview.currency || currency)}</li>
              ))}
            </ul>
            {(preview.students || []).length > 8 && (
              <p className="mt-1 text-[11px] text-slate-400">and {(preview.students as any[]).length - 8} more student(s)</p>
            )}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Dues"
          subtitle={duesScopeText(scope?.students || [], currency)}
        />
        {(scope?.students || []).length === 0 ? (
          <EmptyState
            icon={Receipt}
            title="No charges in this scope"
            description="Run a preview above to see exactly which rows a commit would raise, then commit it."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Student</th>
                  <th className="th text-center">Charges</th>
                  <th className="th text-right">Billed</th>
                  <th className="th text-right">Waived</th>
                  <th className="th text-right">Paid</th>
                  <th className="th text-right">Due</th>
                  <th className="th text-center">Status</th>
                </tr>
              </thead>
              <tbody>
                {(scope?.students || []).map((s) => (
                  <tr
                    key={s.studentId}
                    className={`tr-hover cursor-pointer ${pickedStudent === s.studentId ? "bg-slate-50" : ""}`}
                    onClick={() => setPickedStudent(s.studentId)}
                  >
                    <td className="td text-sm font-semibold text-slate-700">
                      {s.name || "Student"}
                      {s.admissionNo && <span className="ml-1 text-xs text-slate-400">{s.admissionNo}</span>}
                    </td>
                    <td className="td text-center text-xs text-slate-500">{s.count}</td>
                    <td className="td text-right text-xs text-slate-600">{formatMoney(s.billed, currency)}</td>
                    <td className="td text-right text-xs text-amber-700">{formatMoney(s.discount, currency)}</td>
                    <td className="td text-right text-xs text-emerald-700">{formatMoney(s.paid, currency)}</td>
                    <td className="td text-right text-sm font-bold text-slate-800">{formatMoney(s.due, currency)}</td>
                    <td className="td text-center">
                      <Badge tone={s.status === "PAID" ? "green" : s.status === "PARTIAL" ? "amber" : "red"}>{dueStatusText(s.status)}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {pickedStudent && (
        <Card>
          <CardHeader
            title={`${student?.student?.name || "Student"} — charges and payments`}
            subtitle={
              student
                ? `${countText(student.rows.length, "charge")} · still due ${formatMinor(
                    chargeTotals(student.rows).dueMinor,
                    currency
                  )}`
                : "Loading the student's charges…"
            }
            action={
              <button className="btn btn-secondary btn-sm" onClick={() => setPickedStudent("")}>
                Close
              </button>
            }
          />
          {(student?.rows || []).length ? (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className="th">Charge</th>
                    <th className="th text-center">Term</th>
                    <th className="th text-right">Amount</th>
                    <th className="th text-right">Waived</th>
                    <th className="th text-right">Paid</th>
                    <th className="th text-right">Due</th>
                    <th className="th text-center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {(student?.rows || []).map((row) => (
                    <tr key={row.id} className={`tr-hover ${chargeId === row.id ? "bg-slate-50" : ""}`} onClick={() => Number(row.due) > 0 && setChargeId(row.id)}>
                      <td className="td">
                        <div className="text-sm font-semibold text-slate-700">{row.title || row.headName || "Charge"}</div>
                        <div className="text-[11px] text-slate-400">{row.headName || ""}</div>
                      </td>
                      <td className="td text-center text-xs text-slate-500">{row.termNumber}</td>
                      <td className="td text-right text-xs text-slate-600">{formatMoney(row.amount, currency)}</td>
                      <td className="td text-right text-xs text-amber-700">{formatMoney(row.discount, currency)}</td>
                      <td className="td text-right text-xs text-emerald-700">{formatMoney(row.paidAmount, currency)}</td>
                      <td className="td text-right text-sm font-bold text-slate-800">{formatMoney(row.due, currency)}</td>
                      <td className="td text-center">
                        <Badge tone={row.status === "PAID" ? "green" : row.status === "PARTIAL" ? "amber" : "red"}>{dueStatusText(row.status)}</Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon={Receipt} title="Nothing billed to this student yet" description="Generate the term's charges, then record what the family pays." />
          )}

          {controls.pay && openCharges.length > 0 && (
            <div className="grid grid-cols-1 items-end gap-3 border-t border-slate-100 px-5 py-4 sm:grid-cols-5">
              <Field label="Charge" className="sm:col-span-2">
                <Select value={chargeId} onChange={(e) => setChargeId(e.target.value)}>
                  {openCharges.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.title || c.headName} — {formatMoney(c.due, currency)} due
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Amount" hint={selectedCharge ? `${formatMoney(selectedCharge.due, currency)} outstanding` : undefined}>
                <TextInput value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="e.g. 1500.50" inputMode="decimal" />
              </Field>
              <Field label="Method">
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  {PAY_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="flex flex-col gap-2">
                <TextInput value={refNo} onChange={(e) => setRefNo(e.target.value)} placeholder="Reference (optional)" />
                <button
                  className="btn btn-primary"
                  onClick={pay}
                  disabled={payDisabled({ chargeId, amount: payAmount, method, busy: payBusy })}
                >
                  {payButtonLabel(payBusy)}
                </button>
              </div>
            </div>
          )}
        </Card>
      )}

      <Card>
        <CardHeader
          title="Discounts and waivers"
          subtitle="A percentage of a term's charges, or a fixed amount per head. Anyone with write access proposes; an administrator approves, and never their own proposal."
          action={
            <span className="text-xs text-slate-500">{countText(awards.length, "award")}</span>
          }
        />

        {controls.awardPropose && (
          <div className="grid grid-cols-1 items-end gap-3 border-b border-slate-100 px-5 py-4 sm:grid-cols-5">
            <Field label="Shape">
              <Select value={awardKind} onChange={(e) => setAwardKind(e.target.value)}>
                <option value="PERCENT">Percentage of the term</option>
                <option value="FIXED">Fixed amount per head</option>
              </Select>
            </Field>
            {awardKind === "FIXED" ? (
              <Field label="Amount per head">
                <TextInput value={amountPerHead} onChange={(e) => setAmountPerHead(e.target.value)} placeholder="e.g. 500" inputMode="decimal" />
              </Field>
            ) : (
              <Field label="Percent">
                <TextInput type="number" min={1} max={100} value={percent} onChange={(e) => setPercent(e.target.value)} />
              </Field>
            )}
            <Field label="Programme" hint="Blank = the whole college">
              <Select value={awardProgramId} onChange={(e) => setAwardProgramId(e.target.value)}>
                <option value="">Whole college</option>
                {programmes.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Term" hint="Blank = every term">
              <TextInput type="number" min={1} value={awardTerm} onChange={(e) => setAwardTerm(e.target.value)} />
            </Field>
            <Field label="Note">
              <TextInput value={awardNote} onChange={(e) => setAwardNote(e.target.value)} placeholder="Why this award" />
            </Field>
            {awardKind === "FIXED" && (
              <div className="sm:col-span-5">
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Heads it waives</p>
                <div className="flex flex-wrap gap-3">
                  {heads.map((h) => (
                    <label key={h.id} className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                      <input
                        type="checkbox"
                        checked={awardHeads.includes(h.id)}
                        onChange={(e) =>
                          setAwardHeads((prev) => (e.target.checked ? [...prev, h.id] : prev.filter((id) => id !== h.id)))
                        }
                      />
                      {h.name}
                    </label>
                  ))}
                </div>
              </div>
            )}
            <div className="sm:col-span-5">
              <button
                className="btn btn-primary"
                disabled={awardProposeBlocked({ kind: awardKind, percent, amountPerHead, headIds: awardHeads, busy: awardBusy })}
                onClick={proposeAward}
              >
                <Award size={14} /> {awardButtonLabel(awardBusy)}
              </button>
            </div>
          </div>
        )}

        {awards.length === 0 ? (
          <EmptyState
            icon={BadgeCheck}
            title="No discounts or waivers yet"
            description="An award applies only to charges raised after it is approved — history is never rewritten."
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Award</th>
                  <th className="th">Scope</th>
                  <th className="th">State</th>
                  {controls.awardDecide && <th className="th text-right">Decision</th>}
                </tr>
              </thead>
              <tbody>
                {awards.map((a) => {
                  const programme = programmes.find((p) => p.id === a.programId);
                  const decidable = awardDecidable(a, role, actorId);
                  return (
                    <tr key={a.id} className="tr-hover">
                      <td className="td">
                        <div className="text-sm font-semibold text-slate-700">{awardKindText(a)}</div>
                        {a.note && <div className="text-[11px] text-slate-400">{a.note}</div>}
                      </td>
                      <td className="td text-xs text-slate-600">{awardScopeText(a, () => programme?.name || "Programme")}</td>
                      <td className="td text-xs">
                        <Badge tone={awardTone(a.status)}>{awardStateText(a.status)}</Badge>
                      </td>
                      {controls.awardDecide && (
                        <td className="td text-right">
                          {decidable ? (
                            <div className="flex justify-end gap-1">
                              <button
                                className="btn btn-primary btn-sm"
                                disabled={decidingId === a.id}
                                onClick={() => decide(a, "APPROVED")}
                              >
                                {decideButtonLabel(decidingId === a.id, "APPROVED")}
                              </button>
                              <button
                                className="btn btn-secondary btn-sm"
                                disabled={decidingId === a.id}
                                onClick={() => decide(a, "REJECTED")}
                              >
                                {decideButtonLabel(decidingId === a.id, "REJECTED")}
                              </button>
                            </div>
                          ) : (
                            <span className="text-[11px] text-slate-400">—</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">
          The money an approved award waives is posted to the shared ledger when the charges it discounted are raised, so the ledger and this list can never disagree.
        </p>
      </Card>

      <Card>
        <CardHeader title="Where the families pay" subtitle="The college's own channels — never the school's fee settings" />
        <div className="px-5 py-4">
          <ChannelsSummary />
        </div>
      </Card>
    </div>
  );
}

/* -------------------------------------------------------------------- config */

function ChannelsSummary() {
  const [config, setConfig] = useState<ConfigPayload | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    api<ConfigPayload>("/api/college-fees/config")
      .then(setConfig)
      .catch((e: any) => setError(refusalText(e, PAGE_ERRORS.config)));
  }, []);
  if (error) return <ErrorNote message={error} />;
  const channels = channelsOf(config);
  if (!config) return <p className="text-xs text-slate-400">Loading…</p>;
  if (!channels.length)
    return <p className="text-xs text-slate-400">No channel is configured yet — add one on the Payment config tab.</p>;
  return (
    <ul className="space-y-1 text-xs text-slate-600">
      {channels.map((c, i) => (
        <li key={String((c as any).id ?? i)}>{channelLine(c as any)}</li>
      ))}
      {config.paymentNote && <li className="pt-1 text-slate-500">{config.paymentNote}</li>}
    </ul>
  );
}

function ConfigTab({ controls }: { controls: ReturnType<typeof writeControlsFor> }) {
  const [config, setConfig] = useState<ConfigPayload | null>(null);
  const [currency, setCurrency] = useState("BDT");
  const [paymentNote, setPaymentNote] = useState("");
  const [channels, setChannels] = useState<PaymentChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const data = await api<ConfigPayload>("/api/college-fees/config");
      setConfig(data);
      setCurrency(currencyOf(data));
      setPaymentNote(data?.paymentNote || "");
      setChannels(
        channelsOf(data).map((c: any) => ({
          id: String(c.id ?? newChannelId()),
          enabled: c.enabled !== false,
          kind: (c.kind === "BANK" || c.kind === "CASH" ? c.kind : "MOBILE") as PaymentChannel["kind"],
          label: String(c.label ?? ""),
          methods: Array.isArray(c.methods) ? c.methods.map(String) : [],
          number: c.number ?? null,
          accountType: c.accountType ?? null,
          accountName: c.accountName ?? null,
          bankName: c.bankName ?? null,
          branch: c.branch ?? null,
          routingNumber: c.routingNumber ?? null,
          instructions: c.instructions ?? null,
        }))
      );
      setError("");
    } catch (e: any) {
      setConfig(null);
      setError(refusalText(e, PAGE_ERRORS.config));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const patch = (id: string, next: Partial<PaymentChannel>) =>
    setChannels((prev) => prev.map((c) => (c.id === id ? { ...c, ...next } : c)));

  const addChannel = () =>
    setChannels((prev) => [
      ...prev,
      {
        id: newChannelId(),
        enabled: true,
        kind: "MOBILE",
        label: "",
        methods: [],
        number: null,
        accountType: null,
        accountName: null,
        bankName: null,
        branch: null,
        routingNumber: null,
        instructions: null,
      },
    ]);

  const save = async () => {
    if (configBlocked({ busy })) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      // The server normalises: an array of channel objects, a bounded note and a
      // currency label that is never blank.
      const data = await api<ConfigPayload>("/api/college-fees/config", {
        method: "PATCH",
        body: JSON.stringify({
          channels,
          paymentNote: paymentNote || null,
          currency,
        }),
      });
      setConfig(data);
      setNotice("Payment config saved.");
    } catch (e: any) {
      setError(refusalText(e, PAGE_ERRORS.save));
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <Card>
      <CardHeader
        title="College payment config"
        subtitle="Where this college takes its money. It is the college's own row — the school's fee settings are neither read nor extended."
        action={
          controls.config ? (
            <button className="btn btn-primary btn-sm" onClick={save} disabled={configBlocked({ busy })}>
              {configButtonLabel(busy)}
            </button>
          ) : undefined
        }
      />

      {notice && <div className="border-b border-emerald-100 bg-emerald-50 px-5 py-2 text-xs font-semibold text-emerald-700">{notice}</div>}
      {error && <div className="border-b border-rose-100 bg-rose-50 px-5 py-3 text-sm text-rose-700">{error}</div>}

      <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2">
        <Field label="Currency label" hint="A label only — v1 bills in the tenant's own currency">
          <TextInput value={currency} onChange={(e) => setCurrency(e.target.value)} disabled={!controls.config} />
        </Field>
        <Field label="Payment note">
          <TextInput
            value={paymentNote}
            onChange={(e) => setPaymentNote(e.target.value)}
            placeholder="e.g. Bring the admission slip when paying at the office"
            disabled={!controls.config}
          />
        </Field>
      </div>

      <div className="border-t border-slate-100 px-5 py-4">
        <div className="mb-2 flex items-center justify-between">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-400">Channels</p>
          {controls.config && (
            <button className="btn btn-secondary btn-sm" onClick={addChannel}>
              <Plus size={13} /> Add channel
            </button>
          )}
        </div>

        {channels.length === 0 ? (
          <p className="text-xs text-slate-400">No channel yet. Add the bKash merchant number, the bank account, or “pay at the office”.</p>
        ) : (
          <div className="space-y-3">
            {channels.map((c) => (
              <div key={c.id} className="rounded-xl border border-slate-200 p-3">
                <div className="grid grid-cols-1 items-end gap-3 sm:grid-cols-4">
                  <Field label="Label">
                    <TextInput value={c.label} onChange={(e) => patch(c.id, { label: e.target.value })} disabled={!controls.config} />
                  </Field>
                  <Field label="Kind">
                    <Select
                      value={c.kind}
                      onChange={(e) => patch(c.id, { kind: e.target.value as PaymentChannel["kind"] })}
                      disabled={!controls.config}
                    >
                      {CHANNEL_KIND_OPTIONS.map((k) => (
                        <option key={k} value={k}>
                          {channelKindLabel(k)}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label={c.kind === "BANK" ? "Account number" : "Number"}>
                    <TextInput
                      value={c.number ?? ""}
                      onChange={(e) => patch(c.id, { number: e.target.value || null })}
                      disabled={!controls.config}
                    />
                  </Field>
                  <div className="flex items-center gap-3 pb-1">
                    <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                      <input
                        type="checkbox"
                        checked={c.enabled !== false}
                        disabled={!controls.config}
                        onChange={(e) => patch(c.id, { enabled: e.target.checked })}
                      />{" "}
                      Enabled
                    </label>
                    {controls.config && (
                      <button
                        className="btn btn-secondary btn-sm"
                        onClick={() => setChannels((prev) => prev.filter((x) => x.id !== c.id))}
                      >
                        <Trash2 size={13} /> Remove
                      </button>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-3">
                  {PAY_METHODS.map((m) => (
                    <label key={m} className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                      <input
                        type="checkbox"
                        checked={c.methods.includes(m)}
                        disabled={!controls.config}
                        onChange={(e) =>
                          patch(c.id, {
                            methods: e.target.checked ? [...c.methods, m] : c.methods.filter((x) => x !== m),
                          })
                        }
                      />
                      {m}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <p className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">
        Channels describe where money is SENT. A college payment still posts to the tenant's shared ledger, tagged as college money, and
        never to a school fee row.
      </p>
    </Card>
  );
}

