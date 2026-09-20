"use client";

import { useRef, useState } from "react";
import {
  Upload, Download, FileSpreadsheet, CheckCircle2, XCircle, SkipForward,
  FileText, GraduationCap, Users, ArrowUpDown,
} from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, PageHeader, ErrorNote, Modal } from "@/components/ui";

/**
 * PRD §12.4 — CSV Import & Export console (school admin).
 * Import: template download → paste/upload CSV → dry-run preview with
 * per-row status → commit. Export: one-click CSVs for students, teachers,
 * fees, ledger and attendance.
 */

type Kind = "students" | "teachers";

interface RowResult {
  row: number; name: string; admissionNo?: string; email?: string;
  className?: string; status: "OK" | "ERROR" | "SKIP"; error?: string;
}
interface Preview {
  dryRun: boolean; total: number; ok: number; errors: number; skipped: number;
  guardianLoginsToCreate?: number; results: RowResult[];
}
interface CommitResult extends Preview {
  created: number; guardianLoginsCreated?: number; defaultGuardianPassword?: string; defaultPassword?: string;
}

const EXPORTS = [
  { type: "students", label: "Students", icon: GraduationCap, desc: "All students with class, section, guardian contacts" },
  { type: "teachers", label: "Teachers", icon: Users, desc: "All teachers with designation and contacts" },
  { type: "fees", label: "Fees", icon: FileText, desc: "Fee records with amounts, status and due dates" },
  { type: "ledger", label: "Ledger", icon: ArrowUpDown, desc: "Central ledger — fees, payments, discounts, expenses" },
  { type: "attendance", label: "Attendance", icon: CheckCircle2, desc: "Daily attendance (optional date range)" },
];

export default function ImportExportPage() {
  const [kind, setKind] = useState<Kind>("students");
  const [csv, setCsv] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [commit, setCommit] = useState<CommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [attOpen, setAttOpen] = useState(false);
  const [attRange, setAttRange] = useState({ from: "", to: "" });
  const fileRef = useRef<HTMLInputElement>(null);

  const onFile = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => setCsv(String(reader.result || ""));
    reader.readAsText(file);
  };

  const runPreview = async () => {
    setBusy(true); setError(""); setCommit(null);
    try {
      const res = await api<Preview>(`/api/import/${kind}`, { method: "POST", body: JSON.stringify({ csv, dryRun: true }) });
      setPreview(res);
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const runCommit = async () => {
    setBusy(true); setError("");
    try {
      const res = await api<CommitResult>(`/api/import/${kind}`, { method: "POST", body: JSON.stringify({ csv, dryRun: false }) });
      setCommit(res);
      setPreview(null);
      setCsv("");
      if (fileRef.current) fileRef.current.value = "";
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const exportCsv = (type: string) => {
    const qs = type === "attendance" && (attRange.from || attRange.to)
      ? `?from=${attRange.from}&to=${attRange.to}`
      : "";
    window.open(`/api/export?type=${type}${qs}`, "_blank");
    setAttOpen(false);
  };

  return (
    <div>
      <PageHeader title="Import & Export" subtitle="Bulk CSV tools (PRD §12.4)" />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      {/* ------------------------------ EXPORT ------------------------------ */}
      <Card>
        <CardHeader title="Export data" subtitle="Download CSV files of your school's data" />
        <div className="grid grid-cols-1 gap-3 p-5 sm:grid-cols-2 lg:grid-cols-3">
          {EXPORTS.map((x) => (
            <button key={x.type}
              onClick={() => (x.type === "attendance" ? setAttOpen(true) : exportCsv(x.type))}
              className="flex items-start gap-3 rounded-2xl border border-slate-200 p-4 text-left transition hover:border-indigo-300 hover:bg-indigo-50/40">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-indigo-600"><x.icon size={18} /></div>
              <div>
                <div className="text-sm font-bold text-slate-800">{x.label}</div>
                <div className="text-xs text-slate-400">{x.desc}</div>
              </div>
              <Download size={15} className="ml-auto mt-1 text-slate-300" />
            </button>
          ))}
        </div>
      </Card>

      {/* ------------------------------ IMPORT ------------------------------ */}
      <Card className="mt-6">
        <CardHeader title="Import data" subtitle="Bulk-create students or teachers from a CSV file" />
        <div className="space-y-5 p-5">
          {/* kind toggle */}
          <div className="flex gap-2">
            {(["students", "teachers"] as Kind[]).map((k) => (
              <button key={k}
                onClick={() => { setKind(k); setPreview(null); setCommit(null); setError(""); }}
                className={`rounded-xl px-4 py-2 text-sm font-bold capitalize transition ${kind === k ? "brand-bg text-white" : "bg-slate-100 text-slate-500 hover:bg-slate-200"}`}>
                {k}
              </button>
            ))}
          </div>

          {/* template + upload */}
          <div className="flex flex-wrap items-center gap-3">
            <a href={`/api/import/${kind}`} className="btn btn-secondary" download>
              <FileSpreadsheet size={14} /> Download {kind} template
            </a>
            <label className="btn btn-secondary cursor-pointer">
              <Upload size={14} /> Upload CSV
              <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden"
                onChange={(e) => { const f = e.target.files?.[0]; if (f) onFile(f); }} />
            </label>
            <span className="text-xs text-slate-400">…or paste CSV below</span>
          </div>

          <Field label="CSV content">
            <textarea
              value={csv}
              onChange={(e) => setCsv(e.target.value)}
              rows={8}
              spellCheck={false}
              placeholder={"admissionNo,name,class,section,roll\nSTU-1001,Ayesha Rahman,Class 1,A,1"}
              className="w-full rounded-xl border border-slate-200 p-3 font-mono text-xs outline-none focus:border-indigo-300"
            />
          </Field>

          <div className="flex gap-2">
            <button className="btn btn-primary" onClick={runPreview} disabled={busy || !csv.trim()}>
              <ArrowUpDown size={14} /> {busy ? "Checking…" : "Preview & validate"}
            </button>
            {preview && preview.errors === 0 && (
              <button className="btn btn-primary" onClick={runCommit} disabled={busy || !preview.ok}>
                <CheckCircle2 size={14} /> Import {preview.ok} row(s)
              </button>
            )}
          </div>

          {/* preview results */}
          {preview && (
            <div className="rounded-2xl border border-slate-200">
              <div className="flex flex-wrap items-center gap-3 border-b border-slate-100 px-4 py-3 text-sm">
                <span className="font-black text-slate-800">Preview</span>
                <Badge tone="green">{preview.ok} ready</Badge>
                {preview.errors > 0 && <Badge tone="rose">{preview.errors} error(s)</Badge>}
                {preview.skipped > 0 && <Badge tone="amber">{preview.skipped} skipped</Badge>}
                {preview.guardianLoginsToCreate ? <Badge tone="indigo">{preview.guardianLoginsToCreate} guardian login(s) will be created</Badge> : null}
              </div>
              <div className="max-h-72 overflow-auto">
                <table className="w-full">
                  <thead className="sticky top-0 bg-white">
                    <tr><th className="th">Row</th><th className="th">Name</th><th className="th">Detail</th><th className="th">Status</th></tr>
                  </thead>
                  <tbody>
                    {preview.results.map((r) => (
                      <tr key={r.row} className="tr-hover">
                        <td className="td text-xs text-slate-400">{r.row}</td>
                        <td className="td font-semibold">{r.name || "—"}</td>
                        <td className="td text-xs text-slate-500">{r.error || r.className || r.email || ""}</td>
                        <td className="td">
                          {r.status === "OK" && <Badge tone="green"><CheckCircle2 size={11} className="mr-1 inline" />Ready</Badge>}
                          {r.status === "ERROR" && <Badge tone="rose"><XCircle size={11} className="mr-1 inline" />Error</Badge>}
                          {r.status === "SKIP" && <Badge tone="amber"><SkipForward size={11} className="mr-1 inline" />Skip</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* commit result */}
          {commit && (
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm">
              <div className="font-black text-emerald-800">Import complete — {commit.created} created</div>
              <div className="text-xs text-emerald-700">
                {commit.errors} error(s) · {commit.skipped} skipped
                {commit.guardianLoginsCreated ? ` · ${commit.guardianLoginsCreated} guardian login(s) created (default password: ${commit.defaultGuardianPassword})` : ""}
                {commit.defaultPassword ? ` · Teacher default password: ${commit.defaultPassword}` : ""}
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* attendance range modal */}
      <Modal open={attOpen} onClose={() => setAttOpen(false)} title="Export attendance">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="From"><input type="date" value={attRange.from} onChange={(e) => setAttRange({ ...attRange, from: e.target.value })} className="input" /></Field>
            <Field label="To"><input type="date" value={attRange.to} onChange={(e) => setAttRange({ ...attRange, to: e.target.value })} className="input" /></Field>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setAttOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => exportCsv("attendance")}><Download size={14} /> Export CSV</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
