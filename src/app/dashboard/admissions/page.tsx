"use client";

import { useCallback, useEffect, useState } from "react";
import { ClipboardList, Plus, Search, FileUp, Tag, CheckCircle, XCircle, GraduationCap } from "lucide-react";
import { api, qs, upload } from "@/lib/client";
import { Card, Badge, Field, TextInput, Select, Textarea, Modal, PageHeader, LoadingScreen, EmptyState, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate } from "@/lib/utils";

/**
 * PRD §4 — Admission pipeline (Admin + Front Desk + Accountant views).
 * Enquiry → Applied → Docs/Test → Seat confirmed → Fee payment → Enrolled.
 * Discounts: propose (Accountant/Front Desk) → approve/reject (Admin) §4.2.
 */

interface AdmissionRow {
  id: string;
  fullName: string;
  fullNameBn: string | null;
  guardianName: string | null;
  guardianPhone: string;
  guardianEmail: string | null;
  previousSchoolName: string | null;
  previousClass: string | null;
  status: string;
  admissionNo: string | null;
  admissionFee: number | null;
  payableAmount: number | null;
  testDate: string | null;
  testResult: string | null;
  classId: string | null;
  sectionId: string | null;
  createdAt: string;
  classRoom: { id: string; name: string } | null;
  section: { id: string; name: string } | null;
  documents: { id: string; kind: string; url: string }[];
  discounts: { id: string; type: string; amount: number; originalValue: number; reason: string; status: string }[];
  convertedStudent: { id: string; name: string; admissionNo: string } | null;
}

const STATUS_STEPS = ["ENQUIRY", "APPLIED", "DOCS_PENDING", "TEST_SCHEDULED", "SEAT_CONFIRMED", "ENROLLED", "REJECTED"];

const DOC_KINDS = ["BIRTH_CERTIFICATE", "PHOTO", "TC", "MARKSHEET", "OTHER"];

export default function AdmissionsPage() {
  const [items, setItems] = useState<AdmissionRow[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [sections, setSections] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const [q, setQ] = useState("");
  const [error, setError] = useState("");
  const [active, setActive] = useState<AdmissionRow | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [form, setForm] = useState<any>({});
  const [docFile, setDocFile] = useState<File | null>(null);
  const [docKind, setDocKind] = useState("BIRTH_CERTIFICATE");
  const [discountForm, setDiscountForm] = useState<any>({ type: "PERCENT", value: "", reason: "SIBLING" });
  const [payForm, setPayForm] = useState<any>({ method: "CASH" });
  const [siblings, setSiblings] = useState<any[]>([]);
  const [books, setBooks] = useState<any[]>([]);
  const [checklist, setChecklist] = useState<Record<string, boolean>>({});
  const [uniformSize, setUniformSize] = useState("");
  const [idCardIssued, setIdCardIssued] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (filters?: { status?: string; q?: string }) => {
    try {
      const data = await api<AdmissionRow[]>(`/api/admissions${qs(filters || {})}`);
      setItems(data);
      setError("");
    } catch (e: any) {
      setError(e?.message || "Failed to load admissions");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    api<any[]>("/api/classes").then(setClasses).catch(() => null);
    api<any[]>("/api/sections").then(setSections).catch(() => null);
    api<any[]>("/api/books").then(setBooks).catch(() => null); // §8.1 checklist options
  }, [load]);

  const refresh = () => load({ status: statusFilter || undefined, q: q || undefined });

  const openDetail = (a: AdmissionRow) => {
    setActive(a);
    setSiblings([]);
    if (a.guardianPhone || a.guardianEmail) {
      api<any[]>(`/api/admissions/siblings?phone=${encodeURIComponent(a.guardianPhone || "")}&email=${encodeURIComponent(a.guardianEmail || "")}`)
        .then(setSiblings)
        .catch(() => null);
    }
  };

  const createEnquiry = async () => {
    setBusy(true);
    setError("");
    try {
      await api("/api/admissions", { method: "POST", body: JSON.stringify(form) });
      setNewOpen(false);
      setForm({});
      refresh();
    } catch (e: any) {
      setError(e?.message || "Failed to create");
    } finally {
      setBusy(false);
    }
  };

  const transition = async (to: string, extra: Record<string, unknown> = {}) => {
    if (!active) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/admissions?action=transition", {
        method: "POST",
        body: JSON.stringify({ id: active.id, status: to, ...extra }),
      });
      const updated = await api<AdmissionRow[]>(`/api/admissions?id=x`).catch(() => null);
      void updated;
      await load({ status: statusFilter || undefined, q: q || undefined });
      setActive(null);
    } catch (e: any) {
      setError(e?.message || "Transition failed");
    } finally {
      setBusy(false);
    }
  };

  const uploadDoc = async () => {
    if (!active || !docFile) return;
    setBusy(true);
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", docFile);
      const up = await upload("/api/uploads", fd);
      await api("/api/admissions/documents", {
        method: "POST",
        body: JSON.stringify({ admissionId: active.id, kind: docKind, url: up.url || up.downloadUrl || up }),
      });
      setDocFile(null);
      await load({ status: statusFilter || undefined, q: q || undefined });
      setActive(null);
    } catch (e: any) {
      setError(e?.message || "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const proposeDiscount = async () => {
    if (!active) return;
    setBusy(true);
    try {
      await api("/api/admissions?action=discount", {
        method: "POST",
        body: JSON.stringify({ admissionId: active.id, ...discountForm, value: Number(discountForm.value) }),
      });
      setDiscountForm({ type: "PERCENT", value: "", reason: "SIBLING" });
      await load({ status: statusFilter || undefined, q: q || undefined });
      setActive(null);
    } catch (e: any) {
      setError(e?.message || "Failed to propose discount");
    } finally {
      setBusy(false);
    }
  };

  const decideDiscount = async (discountId: string, decision: "APPROVED" | "REJECTED") => {
    if (!active) return;
    setBusy(true);
    try {
      await api("/api/admissions?action=discount", {
        method: "PATCH",
        body: JSON.stringify({ admissionId: active.id, discountId, decision }),
      });
      await load({ status: statusFilter || undefined, q: q || undefined });
      setActive(null);
    } catch (e: any) {
      setError(e?.message || "Failed to record decision");
    } finally {
      setBusy(false);
    }
  };

  const enroll = async () => {
    if (!active) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ admissionNo: string; studentId: string; issuedItems?: string[] }>("/api/admissions?action=enroll", {
        method: "POST",
        body: JSON.stringify({
          admissionId: active.id,
          ...payForm,
          checklist: Object.entries(checklist).filter(([, on]) => on).map(([bookId]) => ({ bookId })),
          uniformSize: uniformSize || undefined,
          idCardIssued,
        }),
      });
      alert(
        `Enrolled! Admission no: ${result.admissionNo}` +
          (result.issuedItems?.length ? `\nIssued: ${result.issuedItems.join(", ")}` : "")
      );
      await load({ status: statusFilter || undefined, q: q || undefined });
      setActive(null);
    } catch (e: any) {
      setError(e?.message || "Enrollment failed");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader
        title="Admissions"
        subtitle="Complete admission workflow (PRD §4) — enquiry to enrollment"
        actions={
          <button className="btn btn-primary btn-sm" onClick={() => setNewOpen(true)}>
            <Plus size={14} /> New applicant
          </button>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="relative sm:col-span-2">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <TextInput className="!pl-9" placeholder="Search name / phone / admission no…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && refresh()} />
          </div>
          <Select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); load({ status: e.target.value || undefined, q: q || undefined }); }}>
            <option value="">All statuses</option>
            {STATUS_STEPS.map((s) => <option key={s}>{s}</option>)}
          </Select>
          <button className="btn btn-primary" onClick={refresh}>Filter</button>
        </div>
      </Card>

      <Card>
        {items.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Applicant</th>
                  <th className="th">Guardian</th>
                  <th className="th">Previous school</th>
                  <th className="th">Class</th>
                  <th className="th">Status</th>
                  <th className="th">Discounts</th>
                  <th className="th text-right">Payable</th>
                </tr>
              </thead>
              <tbody>
                {items.map((a) => (
                  <tr key={a.id} className="tr-hover cursor-pointer" onClick={() => openDetail(a)}>
                    <td className="td">
                      <div className="font-bold text-slate-800">{a.fullName}</div>
                      <div className="text-[11px] text-slate-400">{a.fullNameBn || ""} {a.admissionNo ? `· ${a.admissionNo}` : ""}</div>
                    </td>
                    <td className="td">
                      <div className="text-xs font-semibold text-slate-700">{a.guardianName || "—"}</div>
                      <div className="text-[11px] text-slate-400">{a.guardianPhone}</div>
                    </td>
                    <td className="td text-xs text-slate-600">{a.previousSchoolName || "—"}{a.previousClass ? ` (${a.previousClass})` : ""}</td>
                    <td className="td text-xs">{a.classRoom?.name || "TBD"}</td>
                    <td className="td"><Badge tone={a.status === "REJECTED" ? "red" : a.status === "ENROLLED" ? "green" : "amber"}>{prettyStatus(a.status)}</Badge></td>
                    <td className="td text-xs">
                      {a.discounts.length ? a.discounts.map((d) => (
                        <Badge key={d.id} tone={d.status === "APPROVED" ? "green" : d.status === "REJECTED" ? "red" : "amber"} className="mr-1">
                          {d.reason} {d.status === "APPROVED" ? fmtMoney(d.amount) : `(${prettyStatus(d.status)})`}
                        </Badge>
                      )) : "—"}
                    </td>
                    <td className="td text-right font-bold">{a.payableAmount != null ? fmtMoney(a.payableAmount) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={ClipboardList} title="No admissions yet" description="New enquiries from the public form and walk-ins appear here." />
        )}
      </Card>

      {/* new applicant / enquiry modal */}
      <Modal open={newOpen} onClose={() => setNewOpen(false)} title="New applicant (walk-in / enquiry)" wide>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Full name (English) *"><TextInput value={form.fullName || ""} onChange={(e) => setForm({ ...form, fullName: e.target.value })} /></Field>
          <Field label="Full name (Bangla)"><TextInput value={form.fullNameBn || ""} onChange={(e) => setForm({ ...form, fullNameBn: e.target.value })} /></Field>
          <Field label="Guardian name"><TextInput value={form.guardianName || ""} onChange={(e) => setForm({ ...form, guardianName: e.target.value })} /></Field>
          <Field label="Guardian phone *"><TextInput value={form.guardianPhone || ""} onChange={(e) => setForm({ ...form, guardianPhone: e.target.value })} /></Field>
          <Field label="Guardian email"><TextInput type="email" value={form.guardianEmail || ""} onChange={(e) => setForm({ ...form, guardianEmail: e.target.value })} /></Field>
          <Field label="Previous school"><TextInput value={form.previousSchoolName || ""} onChange={(e) => setForm({ ...form, previousSchoolName: e.target.value })} /></Field>
          <Field label="Previous class" hint="Used to auto-suggest admission class (§4.2)"><TextInput value={form.previousClass || ""} onChange={(e) => setForm({ ...form, previousClass: e.target.value })} /></Field>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={() => setNewOpen(false)}>Cancel</button>
          <button className="btn btn-primary" onClick={createEnquiry} disabled={busy || !form.fullName || !form.guardianPhone}>Create applicant</button>
        </div>
      </Modal>

      {/* detail modal */}
      <Modal open={!!active} onClose={() => setActive(null)} title={active ? `Applicant: ${active.fullName}` : ""} wide>
        {active && (
          <div className="space-y-5">
            <div className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-3">
              <div><p className="text-[10px] font-bold uppercase text-slate-400">Status</p><Badge tone={active.status === "REJECTED" ? "red" : active.status === "ENROLLED" ? "green" : "amber"}>{prettyStatus(active.status)}</Badge></div>
              <div><p className="text-[10px] font-bold uppercase text-slate-400">Guardian</p><p className="font-semibold text-slate-700">{active.guardianName || "—"} · {active.guardianPhone}</p></div>
              <div><p className="text-[10px] font-bold uppercase text-slate-400">Admission No</p><p className="font-semibold text-slate-700">{active.admissionNo || "—"}</p></div>
              {active.testDate && <div><p className="text-[10px] font-bold uppercase text-slate-400">Test</p><p className="font-semibold text-slate-700">{fmtDate(active.testDate)} {active.testResult ? `· ${active.testResult}` : ""}</p></div>}
              <div><p className="text-[10px] font-bold uppercase text-slate-400">Created</p><p className="font-semibold text-slate-700">{fmtDate(active.createdAt)}</p></div>
              {active.convertedStudent && <div><p className="text-[10px] font-bold uppercase text-slate-400">Enrolled as</p><p className="font-semibold text-emerald-700">{active.convertedStudent.name} ({active.convertedStudent.admissionNo})</p></div>}
            </div>

            {/* sibling suggestions */}
            {siblings.length > 0 && (
              <div className="rounded-xl border border-indigo-100 bg-indigo-50 p-3 text-xs text-indigo-800">
                <p className="font-bold">Possible siblings already enrolled (§5.4 auto-suggest):</p>
                <ul className="mt-1 list-inside list-disc">
                  {siblings.map((s) => <li key={s.id}>{s.name} · {s.classRoom?.name || "—"}</li>)}
                </ul>
              </div>
            )}

            {/* documents */}
            <div>
              <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Documents (§4.1 step 2)</p>
              <div className="mb-2 flex flex-wrap gap-2">
                {active.documents.length ? active.documents.map((d) => (
                  <a key={d.id} href={d.url} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-200 px-2.5 py-1 text-[11px] font-semibold text-slate-600 hover:border-indigo-300">
                    {d.kind}
                  </a>
                )) : <p className="text-xs text-slate-400">No documents uploaded.</p>}
              </div>
              {active.status !== "ENROLLED" && (
                <div className="flex flex-wrap items-center gap-2">
                  <Select className="!w-44" value={docKind} onChange={(e) => setDocKind(e.target.value)}>
                    {DOC_KINDS.map((k) => <option key={k}>{k}</option>)}
                  </Select>
                  <input type="file" className="text-xs" onChange={(e) => setDocFile(e.target.files?.[0] || null)} />
                  <button className="btn btn-secondary btn-sm" onClick={uploadDoc} disabled={busy || !docFile}>
                    <FileUp size={13} /> Upload
                  </button>
                </div>
              )}
            </div>

            {/* class assignment + transitions */}
            {active.status !== "ENROLLED" && active.status !== "REJECTED" && (
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Pipeline actions</p>
                <div className="flex flex-wrap gap-2">
                  {active.status === "ENQUIRY" && (
                    <button className="btn btn-primary btn-sm" onClick={() => transition("APPLIED")} disabled={busy}>Mark applied</button>
                  )}
                  {(active.status === "APPLIED" || active.status === "DOCS_PENDING") && (
                    <>
                      <button className="btn btn-secondary btn-sm" onClick={() => transition("DOCS_PENDING")} disabled={busy}>Awaiting docs</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => transition("TEST_SCHEDULED", { testDate: new Date(Date.now() + 3 * 86400000).toISOString() })} disabled={busy}>
                        Schedule test (+3d)
                      </button>
                    </>
                  )}
                  {(active.status === "TEST_SCHEDULED" || active.status === "DOCS_PENDING" || active.status === "APPLIED") && (
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => transition("SEAT_CONFIRMED", { admissionFee: 5000, classId: active.classId || classes[0]?.id })}
                      disabled={busy}
                    >
                      <CheckCircle size={13} /> Confirm seat (fee ৳5000)
                    </button>
                  )}
                  {active.status !== "ENQUIRY" && (
                    <button className="btn btn-danger btn-sm" onClick={() => transition("REJECTED")} disabled={busy}>
                      <XCircle size={13} /> Reject
                    </button>
                  )}
                </div>
                {active.status === "SEAT_CONFIRMED" && (
                  <div className="mt-3 rounded-xl border border-emerald-100 bg-emerald-50 p-3">
                    <p className="text-xs font-bold text-emerald-800">Seat confirmed — collect admission fee to enroll (§4.1 step 5)</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Select className="!w-36" value={payForm.method} onChange={(e) => setPayForm({ ...payForm, method: e.target.value })}>
                        <option value="CASH">Cash</option><option value="BANK">Bank</option><option value="BKASH">bKash</option><option value="NAGAD">Nagad</option>
                      </Select>

                      {/* §8.1 — Book/Uniform receipt checklist at admission */}
                      <div className="mt-3">
                        <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-emerald-700">Received items checklist (§8.1)</p>
                        {books.length ? (
                          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                            {books.map((b) => (
                              <label key={b.id} className="flex items-center gap-2 rounded-lg border border-emerald-100 bg-white px-2.5 py-1.5 text-xs font-semibold text-slate-600">
                                <input
                                  type="checkbox"
                                  checked={!!checklist[b.id]}
                                  onChange={(e) => setChecklist({ ...checklist, [b.id]: e.target.checked })}
                                />
                                <span className="min-w-0 flex-1 truncate">{b.title}</span>
                                <span className="text-[10px] text-slate-400">{b.available} left</span>
                              </label>
                            ))}
                          </div>
                        ) : (
                          <p className="text-xs text-slate-400">No catalog items — add books/uniforms in Library & Books.</p>
                        )}
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <TextInput className="!w-32" placeholder="Uniform size" value={uniformSize} onChange={(e) => setUniformSize(e.target.value)} />
                          <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600">
                            <input type="checkbox" checked={idCardIssued} onChange={(e) => setIdCardIssued(e.target.checked)} /> ID card issued
                          </label>
                        </div>
                      </div>

                      <button className="btn btn-primary btn-sm mt-3" onClick={enroll} disabled={busy}>
                        <GraduationCap size={13} /> Pay {fmtMoney(active.payableAmount || active.admissionFee || 0)} & enroll
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* discounts */}
            {active.status !== "ENROLLED" && (
              <div>
                <p className="mb-2 text-xs font-bold uppercase tracking-wide text-slate-500">Discount / Scholarship (§4.2 approval workflow)</p>
                <div className="flex flex-wrap items-end gap-2">
                  <Field label="Type"><Select className="!w-32" value={discountForm.type} onChange={(e) => setDiscountForm({ ...discountForm, type: e.target.value })}><option value="PERCENT">Percent</option><option value="FIXED">Fixed</option></Select></Field>
                  <Field label="Value"><TextInput className="!w-24" type="number" value={discountForm.value} onChange={(e) => setDiscountForm({ ...discountForm, value: e.target.value })} /></Field>
                  <Field label="Reason"><Select className="!w-44" value={discountForm.reason} onChange={(e) => setDiscountForm({ ...discountForm, reason: e.target.value })}><option>SIBLING</option><option>MERIT</option><option>STAFF_CHILD</option><option>FINANCIAL_HARDSHIP</option><option>OTHER</option></Select></Field>
                  <button className="btn btn-secondary btn-sm" onClick={proposeDiscount} disabled={busy || !Number(discountForm.value)}>
                    <Tag size={13} /> Propose
                  </button>
                </div>
                {active.discounts.length > 0 && (
                  <div className="mt-2 space-y-2">
                    {active.discounts.map((d) => (
                      <div key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs">
                        <span className="font-semibold text-slate-700">{d.reason} · {d.type === "PERCENT" ? `${d.originalValue}%` : fmtMoney(d.originalValue)} = {fmtMoney(d.amount)}</span>
                        {d.status === "PROPOSED" ? (
                          <span className="flex gap-1">
                            <button className="btn btn-primary btn-sm" onClick={() => decideDiscount(d.id, "APPROVED")} disabled={busy}>Approve</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => decideDiscount(d.id, "REJECTED")} disabled={busy}>Reject</button>
                          </span>
                        ) : (
                          <Badge tone={d.status === "APPROVED" ? "green" : "red"}>{prettyStatus(d.status)}</Badge>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
