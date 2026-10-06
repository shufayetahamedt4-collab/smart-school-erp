"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import * as XLSX from "xlsx";
import { Upload, Download, FileSpreadsheet, ArrowLeft, CheckCircle2, AlertTriangle, ChevronRight } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, Card, CardHeader, EmptyState, ErrorNote, Field, LoadingScreen, PageHeader, Select } from "@/components/ui";
import { IMPORT_FIELDS, detectMapping } from "@/lib/import/fields";

/**
 * Bulk Student Import (Phase 2).
 *
 * Read the spreadsheet in the browser, preview it server-side (zero writes),
 * then confirm — at which point the rows are committed in small chunks. Nothing
 * is written until the explicit Confirm, and the server re-validates every chunk.
 */

interface PlanMessage { field: string | null; level: "ERROR" | "WARNING" | "INFO"; code: string; message: string }
interface PlanValues {
  name: string; admissionNo: string | null; classId: string | null; className: string | null;
  sectionName: string | null; gender: string | null; guardianEmail: string | null; guardianPhone: string | null;
}
interface PlanRow { rowNumber: number; level: string; action: string; importable: boolean; messages: PlanMessage[]; values: PlanValues }
interface PreviewData {
  headers: string[]; detected: Record<string, number>; mapping: Record<string, number>;
  branchId: string | null; sessionId: string | null;
  summary: { total: number; importable: number; errors: number; warnings: number; duplicates: number; inFileDuplicates: number; reuseGuardian: number; missingGuardian: number; alreadyImported: number };
  rows: PlanRow[];
}
interface RawRow { rowNumber: number; cells: string[] }
interface Progress {
  batchId: string;
  totals: { processed: number; totalRows: number; created: number; skipped: number; errors: number; warnings: number; guardianReused: number; families: number };
}

const CHUNK_SIZE = 200;
const levelTone: Record<string, "green" | "red" | "amber" | "blue" | "slate"> = { OK: "green", ERROR: "red", WARNING: "amber", INFO: "blue" };

export default function BulkStudentImportPage() {
  const [step, setStep] = useState<"upload" | "map" | "preview" | "importing" | "done">("upload");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState<string[]>([]);
  const [rowsData, setRowsData] = useState<RawRow[]>([]);
  const [mapping, setMapping] = useState<Record<string, number>>({});
  const [preview, setPreview] = useState<PreviewData | null>(null);
  const [createFees, setCreateFees] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<Progress | null>(null);

  const cellByRow = useMemo(() => new Map(rowsData.map((r) => [r.rowNumber, r.cells])), [rowsData]);

  const readFile = async (file: File) => {
    setError("");
    setBusy(true);
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      if (!ws) throw new Error("The file has no readable sheet.");
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: "" }) as any[][];
      if (!aoa.length) throw new Error("The file is empty.");
      const head = (aoa[0] || []).map((h) => String(h ?? "").trim());
      const dataRows: RawRow[] = aoa
        .slice(1)
        .map((cells, i) => ({ rowNumber: i + 2, cells: head.map((_, idx) => String((cells || [])[idx] ?? "")) }))
        .filter((r) => r.cells.some((c) => c.trim()));
      if (!dataRows.length) throw new Error("No data rows were found below the header.");
      setFileName(file.name);
      setHeaders(head);
      setRowsData(dataRows);
      setMapping(detectMapping(head));
      setPreview(null);
      setReviewed(false);
      setStep("map");
    } catch (e: any) {
      setError(e?.message || "Could not read that file. Use an .xlsx or .csv file.");
    } finally {
      setBusy(false);
    }
  };

  const runPreview = async () => {
    setError("");
    setBusy(true);
    try {
      const data = await api<PreviewData>("/api/import/students/preview", {
        method: "POST",
        body: JSON.stringify({ fileName, headers, rows: rowsData, mapping }),
      });
      setPreview(data);
      setReviewed(false);
      setStep("preview");
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async () => {
    if (!preview) return;
    const importable = preview.rows.filter((r) => r.importable);
    if (!importable.length) return;
    setError("");
    setStep("importing");
    let batchId = "";
    let totals: Progress["totals"] | null = null;
    try {
      for (let i = 0; i < importable.length; i += CHUNK_SIZE) {
        const slice = importable.slice(i, i + CHUNK_SIZE);
        const rows = slice.map((r) => ({ rowNumber: r.rowNumber, cells: cellByRow.get(r.rowNumber) || [] }));
        const isLast = i + CHUNK_SIZE >= importable.length;
        const res = await api<Progress>("/api/import/students/commit", {
          method: "POST",
          body: JSON.stringify({
            batchId: batchId || undefined,
            fileName,
            headers,
            mapping,
            branchId: preview.branchId,
            createFees,
            allowWarnings: true,
            totalRows: importable.length,
            rows,
            final: isLast,
          }),
        });
        batchId = res.batchId;
        totals = res.totals;
        setProgress(res);
      }
      setResult(totals ? { batchId, totals } : null);
      setStep("done");
    } catch (e: any) {
      setError(e.message);
      // Fall back to the preview so the user can retry the failed chunk.
      setStep("preview");
    }
  };

  const restart = () => {
    setStep("upload");
    setFileName(""); setHeaders([]); setRowsData([]); setMapping({}); setPreview(null);
    setProgress(null); setResult(null); setReviewed(false); setError("");
  };

  if (step === "importing" && !progress) return <LoadingScreen label="Importing students…" />;

  return (
    <div>
      <PageHeader
        icon={Upload}
        title="Bulk Import Students"
        subtitle="Import an Excel or CSV roster — preview first, nothing is saved until you confirm"
        actions={<Link href="/dashboard/students" className="btn btn-secondary"><ArrowLeft size={16} /> Back to students</Link>}
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Steps step={step} />

      {step === "upload" && (
        <Card className="p-6">
          <div className="grid gap-6 lg:grid-cols-2">
            <div>
              <h3 className="text-sm font-bold text-slate-800">1. Download the template</h3>
              <p className="mt-1 text-xs text-slate-500">
                Columns for every student and guardian field. Name and Class are required; each row also needs an
                admission number, a roll number or a registration number.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <a className="btn btn-secondary btn-sm" href="/api/import/students/template?format=xlsx"><Download size={14} /> Excel template</a>
                <a className="btn btn-secondary btn-sm" href="/api/import/students/template?format=csv"><Download size={14} /> CSV template</a>
              </div>
            </div>
            <div>
              <h3 className="text-sm font-bold text-slate-800">2. Upload your filled file</h3>
              <p className="mt-1 text-xs text-slate-500">Accepts .xlsx, .xls or .csv. The first row must be the header row.</p>
              <label className="mt-3 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-slate-200 bg-slate-50/60 px-6 py-8 text-center hover:border-indigo-300 hover:bg-indigo-50/40">
                <FileSpreadsheet size={26} className="text-slate-400" />
                <span className="text-sm font-semibold text-slate-700">{busy ? "Reading…" : "Choose a file"}</span>
                <span className="text-xs text-slate-400">1,000–5,000 rows supported</span>
                <input
                  type="file"
                  className="hidden"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) readFile(f); }}
                />
              </label>
            </div>
          </div>
        </Card>
      )}

      {step === "map" && (
        <div className="space-y-4">
          <Card>
            <CardHeader title="Column mapping" subtitle={`${rowsData.length} data row(s) in ${fileName} — confirm which column feeds each field`} />
            <div className="grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
              {IMPORT_FIELDS.map((field) => (
                <Field
                  key={field.key}
                  label={`${field.label}${field.required ? " *" : ""}`}
                  hint={field.identifier ? "identifier" : field.required ? "required" : undefined}
                >
                  <Select
                    value={mapping[field.key] ?? ""}
                    onChange={(e) => {
                      const v = e.target.value;
                      setMapping((m) => {
                        const next = { ...m };
                        if (v === "") delete next[field.key];
                        else next[field.key] = Number(v);
                        return next;
                      });
                    }}
                  >
                    <option value="">— ignore —</option>
                    {headers.map((h, idx) => (
                      <option key={idx} value={idx}>{h || `Column ${idx + 1}`}</option>
                    ))}
                  </Select>
                </Field>
              ))}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4">
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input type="checkbox" checked={createFees} onChange={(e) => setCreateFees(e.target.checked)} />
                Also raise the default Admission &amp; Monthly fees for each imported student
              </label>
              <div className="flex gap-2">
                <button className="btn btn-secondary" onClick={restart}>Choose another file</button>
                <button className="btn btn-primary" onClick={runPreview} disabled={busy || mapping.name === undefined || mapping.class === undefined}>
                  {busy ? "Validating…" : "Preview import"} <ChevronRight size={16} />
                </button>
              </div>
            </div>
          </Card>
        </div>
      )}

      {step === "preview" && preview && (
        <PreviewStep
          preview={preview}
          reviewed={reviewed}
          setReviewed={setReviewed}
          onBack={() => setStep("map")}
          onConfirm={runImport}
          busy={busy}
        />
      )}

      {step === "importing" && progress && (
        <Card className="p-6">
          <h3 className="text-sm font-bold text-slate-800">Importing…</h3>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-slate-100">
            <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${pct(progress.totals.processed, progress.totals.totalRows)}%` }} />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {progress.totals.processed} / {progress.totals.totalRows} rows · {progress.totals.created} created · {progress.totals.skipped} skipped · {progress.totals.errors} errors
          </p>
        </Card>
      )}

      {step === "done" && result && (
        <Card className="p-6">
          <div className="flex items-center gap-3">
            <CheckCircle2 size={26} className="text-emerald-500" />
            <div>
              <h3 className="text-sm font-bold text-slate-800">Import finished</h3>
              <p className="text-xs text-slate-500">{fileName}</p>
            </div>
          </div>
          <ResultGrid totals={result.totals} />
          <div className="mt-4 flex flex-wrap gap-2">
            <Link className="btn btn-primary" href={`/dashboard/students/import/${result.batchId}`}>View result &amp; row errors</Link>
            <Link className="btn btn-secondary" href="/dashboard/students">Go to students</Link>
            <button className="btn btn-secondary" onClick={restart}>Import another file</button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Steps({ step }: { step: string }) {
  const order = ["upload", "map", "preview", "done"];
  const labels = { upload: "Upload", map: "Map columns", preview: "Preview", done: "Import" };
  const activeIndex = step === "importing" ? 2 : order.indexOf(step);
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 text-xs">
      {order.map((key, i) => (
        <div key={key} className="flex items-center gap-2">
          <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-bold ${i <= activeIndex ? "bg-indigo-600 text-white" : "bg-slate-200 text-slate-500"}`}>{i + 1}</span>
          <span className={i <= activeIndex ? "font-semibold text-slate-700" : "text-slate-400"}>{(labels as any)[key]}</span>
          {i < order.length - 1 && <ChevronRight size={12} className="text-slate-300" />}
        </div>
      ))}
    </div>
  );
}

function PreviewStep({
  preview, reviewed, setReviewed, onBack, onConfirm, busy,
}: {
  preview: PreviewData; reviewed: boolean; setReviewed: (v: boolean) => void;
  onBack: () => void; onConfirm: () => void; busy: boolean;
}) {
  const s = preview.summary;
  const importable = preview.rows.filter((r) => r.importable);
  const flagged = preview.rows.filter((r) => r.messages.length);
  const needsReview = s.warnings > 0;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Preview" subtitle="Nothing has been saved yet — review the plan, then confirm" />
        <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-4">
          <Fact label="Rows" value={s.total} />
          <Fact label="Ready to import" value={s.importable} tone="text-emerald-600" />
          <Fact label="Errors (skipped)" value={s.errors} tone="text-rose-600" />
          <Fact label="Warnings" value={s.warnings} tone="text-amber-600" />
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-4">
          <Fact label="Existing admission/reg." value={s.duplicates} />
          <Fact label="Duplicates in file" value={s.inFileDuplicates} />
          <Fact label="Guardian reused" value={s.reuseGuardian} />
          <Fact label="No guardian info" value={s.missingGuardian} />
          <Fact label="Already imported" value={s.alreadyImported} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-5 py-4">
          <div className="text-xs text-slate-500">
            {preview.sessionId ? "Rows will carry the school's current academic session." : "No current academic session is set (students will have none)."}
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={onBack}>Back to mapping</button>
            <button className="btn btn-primary" onClick={onConfirm} disabled={busy || !importable.length || (needsReview && !reviewed)}>
              Confirm import ({importable.length})
            </button>
          </div>
        </div>
        {needsReview && (
          <div className="flex items-start gap-2 border-t border-amber-100 bg-amber-50/60 px-5 py-3 text-xs text-amber-800">
            <AlertTriangle size={15} className="mt-0.5 shrink-0" />
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={reviewed} onChange={(e) => setReviewed(e.target.checked)} />
              {s.warnings} row(s) are flagged as possible duplicates or missing guardian info. I have reviewed them and want to import anyway.
            </label>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Row detail" subtitle={`${flagged.length} row(s) flagged`} />
        {flagged.length === 0 ? (
          <EmptyState icon={CheckCircle2} title="Every row is clean" description="No errors or warnings were found." />
        ) : (
          <div className="max-h-[28rem] overflow-y-auto">
            <table className="w-full text-left text-xs">
              <thead className="sticky top-0 bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-4 py-2 font-semibold">Row</th>
                  <th className="px-4 py-2 font-semibold">Name</th>
                  <th className="px-4 py-2 font-semibold">Class</th>
                  <th className="px-4 py-2 font-semibold">Admission No</th>
                  <th className="px-4 py-2 font-semibold">Status</th>
                  <th className="px-4 py-2 font-semibold">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {flagged.slice(0, 500).map((r) => (
                  <tr key={r.rowNumber} className="align-top">
                    <td className="px-4 py-2 text-slate-400">{r.rowNumber}</td>
                    <td className="px-4 py-2 font-medium text-slate-700">{r.values.name || "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{r.values.className || "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{r.values.admissionNo || "—"}</td>
                    <td className="px-4 py-2"><Badge tone={levelTone[r.level] || "slate"}>{r.level}</Badge></td>
                    <td className="px-4 py-2 text-slate-500">{r.messages.map((m) => m.message).join(" ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {flagged.length > 500 && <p className="px-4 py-3 text-xs text-slate-400">Showing the first 500 flagged rows.</p>}
          </div>
        )}
      </Card>
    </div>
  );
}

function Fact({ label, value, tone }: { label: string; value: number; tone?: string }) {
  return (
    <div className="bg-white p-4">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-extrabold ${tone || "text-slate-800"}`}>{value}</p>
    </div>
  );
}

function ResultGrid({ totals }: { totals: Progress["totals"] }) {
  return (
    <div className="mt-4 grid grid-cols-2 gap-px overflow-hidden rounded-xl bg-slate-100 sm:grid-cols-4">
      <Fact label="Created" value={totals.created} tone="text-emerald-600" />
      <Fact label="Skipped" value={totals.skipped} />
      <Fact label="Errors" value={totals.errors} tone="text-rose-600" />
      <Fact label="Guardians reused" value={totals.guardianReused} />
    </div>
  );
}

function pct(n: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, Math.round((n / total) * 100));
}
