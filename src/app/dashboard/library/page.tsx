"use client";

import { useEffect, useMemo, useState } from "react";
import { Plus, Package, BookUp, Undo2, CircleAlert, Search } from "lucide-react";
import { api } from "@/lib/client";
import {
  Card, CardHeader, Badge, Field, TextInput, Select, Modal, PageHeader, EmptyState,
  LoadingScreen, ErrorNote, statusTone, prettyStatus,
} from "@/components/ui";
import { fmtMoney, fmtDate } from "@/lib/utils";

/**
 * PRD §8 — Book/Asset & Inventory Management UI.
 * Tabs: Catalog & Stock · Issues. Lost/late returns create fines that flow
 * to the student's fees (§8.2 → §10). Serves SCHOOL_ADMIN + LIBRARIAN.
 */

interface BookRow {
  id: string; title: string; code: string | null; type: string; className: string | null; price: number;
  stock: { total: number; lowStockThreshold: number } | null;
  issued: number; available: number;
}
interface IssueRow {
  id: string; status: string; issuedAt: string; dueDate: string | null; returnedAt: string | null; fineAmount: number;
  book: { id: string; title: string; code: string | null };
  student: { id: string; name: string; admissionNo: string; classRoom?: { name: string } | null };
}
interface StudentLite { id: string; name: string; admissionNo: string; classRoom?: { name: string } | null }

const TYPES = ["LIBRARY", "TEXTBOOK", "UNIFORM", "ASSET"];

export default function LibraryPage() {
  const [tab, setTab] = useState<"catalog" | "issues">("catalog");
  const [books, setBooks] = useState<BookRow[]>([]);
  const [issues, setIssues] = useState<IssueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [q, setQ] = useState("");

  // modals
  const [bookOpen, setBookOpen] = useState(false);
  const [issueOpen, setIssueOpen] = useState<BookRow | null>(null);
  const [returnOpen, setReturnOpen] = useState<IssueRow | null>(null);
  const [lostOpen, setLostOpen] = useState<IssueRow | null>(null);

  const [bookForm, setBookForm] = useState<any>({ title: "", code: "", type: "LIBRARY", className: "", price: "", stock: "", lowStockThreshold: "3" });
  const [issueForm, setIssueForm] = useState<any>({ studentId: "", dueDays: 14 });
  const [returnForm, setReturnForm] = useState<any>({ lateFinePerDay: 0 });
  const [lostForm, setLostForm] = useState<any>({ fineAmount: 200 });
  const [students, setStudents] = useState<StudentLite[]>([]);
  const [busy, setBusy] = useState(false);

  const load = () =>
    Promise.all([api<BookRow[]>("/api/books"), api<IssueRow[]>("/api/books/issues")])
      .then(([b, i]) => {
        setBooks(b || []);
        setIssues(i || []);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

  const openIssue = async (book: BookRow) => {
    setIssueOpen(book);
    setIssueForm({ studentId: "", dueDays: 14 });
    if (!students.length) {
      const list = await api<StudentLite[]>("/api/students").catch(() => []);
      setStudents(list || []);
    }
  };

  const createBook = async () => {
    setBusy(true); setError("");
    try {
      await api("/api/books", { method: "POST", body: JSON.stringify(bookForm) });
      setBookOpen(false);
      setBookForm({ title: "", code: "", type: "LIBRARY", className: "", price: "", stock: "", lowStockThreshold: "3" });
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const issue = async () => {
    if (!issueOpen) return;
    setBusy(true); setError("");
    try {
      await api("/api/books/issues", {
        method: "POST",
        body: JSON.stringify({ bookId: issueOpen.id, studentId: issueForm.studentId, dueDays: Number(issueForm.dueDays || 14) }),
      });
      setIssueOpen(null);
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const doReturn = async () => {
    if (!returnOpen) return;
    setBusy(true); setError("");
    try {
      await api("/api/books/issues", {
        method: "PATCH",
        body: JSON.stringify({ id: returnOpen.id, action: "RETURN", lateFinePerDay: Number(returnForm.lateFinePerDay || 0) }),
      });
      setReturnOpen(null);
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const markLost = async () => {
    if (!lostOpen) return;
    setBusy(true); setError("");
    try {
      await api("/api/books/issues", {
        method: "PATCH",
        body: JSON.stringify({ id: lostOpen.id, action: "LOST", fineAmount: Number(lostForm.fineAmount || 0) }),
      });
      setLostOpen(null);
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const lowStock = useMemo(() => books.filter((b) => b.stock && b.stock.total > 0 && b.stock.total - b.issued <= b.stock.lowStockThreshold), [books]);
  const filteredBooks = books.filter((b) => !q || b.title.toLowerCase().includes(q.toLowerCase()) || (b.code || "").toLowerCase().includes(q.toLowerCase()));
  const activeIssues = issues.filter((i) => i.status === "ISSUED");

  if (loading) return <LoadingScreen label="Loading library…" />;

  return (
    <div>
      <PageHeader
        title="Library & Books"
        subtitle="Catalog, stock, issue/return and fines (PRD §8)"
        actions={<button className="btn btn-primary" onClick={() => setBookOpen(true)}><Plus size={16} /> Add item</button>}
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      {lowStock.length > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-2.5 text-xs font-semibold text-amber-700">
          <CircleAlert size={15} /> {lowStock.length} item(s) at or below low-stock threshold: {lowStock.map((b) => b.title).join(", ")}
        </div>
      )}

      <div className="mb-4 flex gap-2">
        <button className={`btn btn-sm ${tab === "catalog" ? "btn-primary" : "btn-secondary"}`} onClick={() => setTab("catalog")}>
          <Package size={14} /> Catalog & Stock
        </button>
        <button className={`btn btn-sm ${tab === "issues" ? "btn-primary" : "btn-secondary"}`} onClick={() => setTab("issues")}>
          <BookUp size={14} /> Issues ({activeIssues.length} active)
        </button>
      </div>

      {tab === "catalog" && (
        <Card>
          <CardHeader
            title="Catalog & stock"
            subtitle="Textbooks, library books, uniforms and assets"
            action={
              <div className="relative">
                <Search size={14} className="absolute left-2.5 top-2.5 text-slate-400" />
                <TextInput value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="!w-56 !pl-8" />
              </div>
            }
          />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Item</th><th className="th">Type</th><th className="th">Class</th>
                  <th className="th">Stock</th><th className="th">Issued</th><th className="th">Available</th>
                  <th className="th">Price</th><th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredBooks.map((b) => (
                  <tr key={b.id} className="tr-hover">
                    <td className="td">
                      <div className="font-bold text-slate-800">{b.title}</div>
                      {b.code && <div className="font-mono text-[11px] text-slate-400">{b.code}</div>}
                    </td>
                    <td className="td"><Badge tone="gray">{prettyType(b.type)}</Badge></td>
                    <td className="td">{b.className || "—"}</td>
                    <td className="td">{b.stock?.total ?? 0}</td>
                    <td className="td">{b.issued}</td>
                    <td className="td">
                      <span className={b.available <= 0 ? "font-bold text-rose-600" : "font-bold text-emerald-600"}>{b.available}</span>
                      {b.stock && b.available <= b.stock.lowStockThreshold && b.available > 0 && <span className="ml-1 text-[10px] font-bold text-amber-600">LOW</span>}
                    </td>
                    <td className="td">{fmtMoney(b.price)}</td>
                    <td className="td">
                      <div className="flex justify-end gap-1.5">
                        <button className="btn btn-primary btn-sm" onClick={() => openIssue(b)} disabled={b.available <= 0}>
                          <BookUp size={12} /> Issue
                        </button>
                        <button
                          className="btn btn-danger btn-sm"
                          onClick={() => { if (confirm(`Delete ${b.title}?`)) api(`/api/books?id=${b.id}`, { method: "DELETE" }).then(load).catch((e) => setError(e.message)); }}
                        >
                          Del
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!filteredBooks.length && (
                  <tr><td colSpan={8} className="td text-center text-sm text-slate-400">No items yet — add your first catalog item.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === "issues" && (
        <Card>
          <CardHeader title="Issue / return records" subtitle="Lost or late returns create fine fees on the student's account (§8.2)" />
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Book</th><th className="th">Student</th><th className="th">Issued</th>
                  <th className="th">Due</th><th className="th">Status</th><th className="th">Fine</th><th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {issues.map((i) => {
                  const overdue = i.status === "ISSUED" && i.dueDate && new Date(i.dueDate) < new Date();
                  return (
                    <tr key={i.id} className="tr-hover">
                      <td className="td font-semibold">{i.book.title}</td>
                      <td className="td">
                        <div className="font-semibold">{i.student?.name}</div>
                        <div className="text-[11px] text-slate-400">{i.student?.admissionNo}{i.student?.classRoom ? ` · ${i.student.classRoom.name}` : ""}</div>
                      </td>
                      <td className="td">{fmtDate(i.issuedAt)}</td>
                      <td className="td">
                        {i.dueDate ? fmtDate(i.dueDate) : "—"}
                        {overdue && <span className="ml-1 text-[10px] font-bold text-rose-600">OVERDUE</span>}
                      </td>
                      <td className="td"><Badge tone={statusTone(i.status)}>{prettyStatus(i.status)}</Badge></td>
                      <td className="td">{i.fineAmount ? fmtMoney(i.fineAmount) : "—"}</td>
                      <td className="td">
                        <div className="flex justify-end gap-1.5">
                          {i.status === "ISSUED" && (
                            <>
                              <button className="btn btn-secondary btn-sm" onClick={() => { setReturnForm({ lateFinePerDay: 0 }); setReturnOpen(i); }}><Undo2 size={12} /> Return</button>
                              <button className="btn btn-danger btn-sm" onClick={() => { setLostForm({ fineAmount: 200 }); setLostOpen(i); }}>Lost</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {!issues.length && (
                  <tr><td colSpan={7} className="td text-center text-sm text-slate-400">No issue records yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* Add book modal */}
      <Modal open={bookOpen} onClose={() => setBookOpen(false)} title="Add catalog item">
        <div className="space-y-4">
          <Field label="Title"><TextInput value={bookForm.title} onChange={(e) => setBookForm({ ...bookForm, title: e.target.value })} placeholder="e.g. Bangla Grammar — Class 5" /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Code / ISBN"><TextInput value={bookForm.code} onChange={(e) => setBookForm({ ...bookForm, code: e.target.value })} /></Field>
            <Field label="Type">
              <Select value={bookForm.type} onChange={(e) => setBookForm({ ...bookForm, type: e.target.value })}>
                {TYPES.map((t) => <option key={t}>{t}</option>)}
              </Select>
            </Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Class (optional)"><TextInput value={bookForm.className} onChange={(e) => setBookForm({ ...bookForm, className: e.target.value })} placeholder="e.g. Class 5" /></Field>
            <Field label="Price (৳)"><TextInput type="number" value={bookForm.price} onChange={(e) => setBookForm({ ...bookForm, price: e.target.value })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Stock quantity"><TextInput type="number" value={bookForm.stock} onChange={(e) => setBookForm({ ...bookForm, stock: e.target.value })} /></Field>
            <Field label="Low-stock threshold"><TextInput type="number" value={bookForm.lowStockThreshold} onChange={(e) => setBookForm({ ...bookForm, lowStockThreshold: e.target.value })} /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setBookOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={createBook} disabled={busy || !bookForm.title}>Add</button>
          </div>
        </div>
      </Modal>

      {/* Issue modal */}
      <Modal open={!!issueOpen} onClose={() => setIssueOpen(null)} title={`Issue "${issueOpen?.title || ""}"`}>
        <div className="space-y-4">
          <Field label="Student">
            <Select value={issueForm.studentId} onChange={(e) => setIssueForm({ ...issueForm, studentId: e.target.value })}>
              <option value="">Select student…</option>
              {students.map((s) => <option key={s.id} value={s.id}>{s.name} — {s.admissionNo}{s.classRoom ? ` (${s.classRoom.name})` : ""}</option>)}
            </Select>
          </Field>
          <Field label="Due in (days)"><TextInput type="number" value={issueForm.dueDays} onChange={(e) => setIssueForm({ ...issueForm, dueDays: e.target.value })} /></Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setIssueOpen(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={issue} disabled={busy || !issueForm.studentId}>Issue book</button>
          </div>
        </div>
      </Modal>

      {/* Return modal */}
      <Modal open={!!returnOpen} onClose={() => setReturnOpen(null)} title={`Return "${returnOpen?.book.title || ""}"`}>
        <div className="space-y-4">
          <Field label="Late fine per day (৳, 0 = none)" hint="Applies only if the book is past its due date. The fine is added to the student's fees.">
            <TextInput type="number" value={returnForm.lateFinePerDay} onChange={(e) => setReturnForm({ ...returnForm, lateFinePerDay: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setReturnOpen(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={doReturn} disabled={busy}>Confirm return</button>
          </div>
        </div>
      </Modal>

      {/* Lost modal */}
      <Modal open={!!lostOpen} onClose={() => setLostOpen(null)} title={`Mark lost — ${lostOpen?.book.title || ""}`}>
        <div className="space-y-4">
          <Field label="Fine amount (৳)" hint="A fine fee is added to the student's account; the guardian can pay it from the parent portal.">
            <TextInput type="number" value={lostForm.fineAmount} onChange={(e) => setLostForm({ ...lostForm, fineAmount: e.target.value })} />
          </Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setLostOpen(null)}>Cancel</button>
            <button className="btn btn-danger" onClick={markLost} disabled={busy}>Mark lost & fine</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

function prettyType(t: string): string {
  return { LIBRARY: "Library", TEXTBOOK: "Textbook", UNIFORM: "Uniform", ASSET: "Asset" }[t] || t;
}
