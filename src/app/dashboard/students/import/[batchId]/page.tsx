"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { ArrowLeft, ClipboardList, QrCode, RotateCcw, Upload } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Badge, Card, CardHeader, EmptyState, ErrorNote, LoadingScreen, PageHeader } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/**
 * Import result summary + row-level error reporting for one batch.
 *
 * The batch totals come from the batch record; the rows come from the per-row
 * records the commit wrote, filterable by status. Undo removes only the students
 * this batch created and never touches guardian accounts.
 */

interface BatchRow {
  rowNumber: number; name: string | null; admissionNo: string | null; className: string | null;
  level: string; action: string; status: string; note: string | null;
  messages: { field: string | null; level: string; code: string; message: string }[];
}
interface Batch {
  id: string; fileName: string; status: string; totalRows: number; processed: number;
  created: number; skipped: number; errors: number; warnings: number; guardianReused: number; families: number;
  createdAt: string; finishedAt: string | null;
}
interface Data { batch: Batch; counts: { total: number; ok: number; skipped: number; errors: number; warnings: number }; rows: BatchRow[]; filteredTotal: number }

const statusTone: Record<string, "green" | "red" | "amber" | "slate" | "blue"> = { OK: "green", ERROR: "red", SKIPPED: "slate" };
const levelTone: Record<string, "green" | "red" | "amber" | "blue" | "slate"> = { OK: "green", ERROR: "red", WARNING: "amber", INFO: "blue" };
const TABS = [
  { key: "", label: "All" },
  { key: "ERROR", label: "Errors" },
  { key: "WARNING", label: "Warnings" },
  { key: "OK", label: "Imported" },
  { key: "SKIPPED", label: "Skipped" },
];

export default function ImportBatchPage() {
  const params = useParams<{ batchId: string }>();
  const batchId = params?.batchId as string;
  const [data, setData] = useState<Data | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [level, setLevel] = useState("");

  const load = (filter: string) => {
    setLoading(true);
    api<Data>(`/api/import/students/${batchId}${qs({ level: filter || undefined, limit: 300 })}`)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (batchId) load(level); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [batchId, level]);

  const undo = async () => {
    if (!window.confirm("Undo this import? The students it created will be removed. Guardian accounts are kept.")) return;
    setError("");
    try {
      await api(`/api/import/students/${batchId}/undo`, { method: "POST" });
      load(level);
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (loading && !data) return <LoadingScreen />;
  if (!data) return (
    <div>
      <PageHeader icon={Upload} title="Import result" />
      <ErrorNote message={error || "Import batch not found."} />
    </div>
  );

  const b = data.batch;

  return (
    <div>
      <PageHeader
        icon={Upload}
        title="Import result"
        subtitle={`${b.fileName || "Import"} · ${fmtDate(b.createdAt, true)}`}
        actions={
          <div className="flex flex-wrap gap-2">
            {b.status !== "UNDONE" && b.created > 0 && (
              <Link href={`/print/guardian-credentials/${batchId}`} className="btn btn-primary"><QrCode size={16} /> Guardian access slips</Link>
            )}
            <Link href="/dashboard/students/import" className="btn btn-secondary"><Upload size={16} /> New import</Link>
            <Link href="/dashboard/students" className="btn btn-secondary"><ArrowLeft size={16} /> Students</Link>
          </div>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card className="mb-4">
        <CardHeader
          title="Summary"
          subtitle={`Status: ${b.status}${b.status === "UNDONE" ? " (rolled back)" : ""}`}
          action={
            b.status !== "UNDONE" && b.created > 0 ? (
              <button className="btn btn-secondary btn-sm" onClick={undo}><RotateCcw size={14} /> Undo import</button>
            ) : undefined
          }
        />
        <div className="grid grid-cols-2 gap-px bg-slate-100 sm:grid-cols-4">
          <Fact label="Created" value={b.created} tone="text-emerald-600" />
          <Fact label="Skipped (duplicates)" value={b.skipped} />
          <Fact label="Errors" value={b.errors} tone="text-rose-600" />
          <Fact label="Warnings" value={b.warnings} tone="text-amber-600" />
        </div>
        <div className="grid grid-cols-2 gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-4">
          <Fact label="Rows in file" value={b.totalRows} />
          <Fact label="Guardians reused" value={b.guardianReused} />
          <Fact label="Families linked" value={b.families} />
          <Fact label="Processed" value={b.processed} />
        </div>
      </Card>

      <Card>
        <CardHeader
          title="Row detail"
          subtitle={`${data.filteredTotal} row(s)`}
          action={
            <div className="flex flex-wrap gap-1">
              {TABS.map((t) => (
                <button
                  key={t.key}
                  onClick={() => setLevel(t.key)}
                  className={`rounded-lg px-3 py-1 text-xs font-semibold ${level === t.key ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-600 hover:bg-slate-200"}`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
        />
        {data.rows.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No rows in this view" />
        ) : (
          <div className="max-h-[32rem] overflow-y-auto">
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
                {data.rows.map((r) => (
                  <tr key={r.rowNumber} className="align-top">
                    <td className="px-4 py-2 text-slate-400">{r.rowNumber}</td>
                    <td className="px-4 py-2 font-medium text-slate-700">{r.name || "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{r.className || "—"}</td>
                    <td className="px-4 py-2 text-slate-500">{r.admissionNo || "—"}</td>
                    <td className="px-4 py-2">
                      <Badge tone={statusTone[r.status] || "slate"}>{r.status}</Badge>
                      {r.level === "WARNING" && <Badge tone={levelTone.WARNING} className="ml-1">W</Badge>}
                    </td>
                    <td className="px-4 py-2 text-slate-500">
                      {[r.note, ...r.messages.map((m) => m.message)].filter(Boolean).join(" ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data.filteredTotal > data.rows.length && <p className="px-4 py-3 text-xs text-slate-400">Showing the first {data.rows.length} of {data.filteredTotal} rows.</p>}
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
