"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, GraduationCap, Archive } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, Field, Select, TextInput, PageHeader, LoadingScreen, EmptyState, ErrorNote } from "@/components/ui";

/**
 * PRD §5.2 — Class Promotion Workflow (preview → confirm) and
 * §5.3 — Alumni tracking (archive, never delete).
 */
export default function PromotionPage() {
  const [classes, setClasses] = useState<any[]>([]);
  const [fromClassId, setFromClassId] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [alumni, setAlumni] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const loadAlumni = () => api<any[]>("/api/students/alumni").then(setAlumni).catch(() => null);

  useEffect(() => {
    api<any[]>("/api/classes")
      .then((cs) => {
        setClasses(cs);
        if (cs.length) setFromClassId(cs[0].id);
      })
      .finally(() => setLoading(false));
    loadAlumni();
  }, []);

  const loadPreview = async (classId: string) => {
    if (!classId) return;
    setPreview(null);
    setExcluded(new Set());
    setError("");
    try {
      setPreview(await api<any>(`/api/students/promote?fromClassId=${encodeURIComponent(classId)}`));
    } catch (e: any) {
      setError(e?.message || "Preview failed");
    }
  };

  useEffect(() => {
    if (fromClassId) loadPreview(fromClassId);
  }, [fromClassId]);

  const promote = async () => {
    if (!preview) return;
    if (!confirm(`Promote ${preview.count - excluded.size} students${preview.toClass ? ` to ${preview.toClass.name}` : " (graduate)"}? Excluded: ${excluded.size}.`)) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<any>("/api/students/promote", {
        method: "POST",
        body: JSON.stringify({ fromClassId, excludeIds: [...excluded] }),
      });
      setMessage(`Promoted ${result.promoted}, graduated ${result.graduated}, excluded ${result.excluded}.`);
      await loadPreview(fromClassId);
      loadAlumni();
    } catch (e: any) {
      setError(e?.message || "Promotion failed");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (studentId: string) => {
    await api("/api/students/alumni", { method: "POST", body: JSON.stringify({ studentId, restore: true }) });
    loadAlumni();
  };

  if (loading) return <LoadingScreen />;

  const visibleStudents = preview?.students?.filter((s: any) => !q || s.name.toLowerCase().includes(q.toLowerCase())) || [];

  return (
    <div className="space-y-4">
      <PageHeader title="Promotion & Alumni" subtitle="Year-end class promotion and alumni archive (PRD §5.2, §5.3)" />

      {message && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{message}</div>}
      {error && <ErrorNote message={error} />}

      <Card>
        <CardHeader title="Class promotion (§5.2)" subtitle="Preview, exclude failures, then confirm — old records stay archived" />
        <div className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-3">
          <Field label="From class">
            <Select value={fromClassId} onChange={(e) => setFromClassId(e.target.value)}>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </Field>
          <div className="text-sm text-slate-600">
            {preview ? (
              <>
                <p><span className="font-bold">{preview.count}</span> active students</p>
                <p>Target: <span className="font-bold">{preview.toClass ? preview.toClass.name : "Graduate → Alumni (§5.3)"}</span></p>
              </>
            ) : (
              <p className="text-slate-400">Loading preview…</p>
            )}
          </div>
          {preview && (
            <button className="btn btn-primary" onClick={promote} disabled={busy || preview.count === excluded.size}>
              <ArrowUpRight size={15} /> Promote {preview.count - excluded.size} students
            </button>
          )}
        </div>
        {preview && (
          <div className="max-h-80 overflow-y-auto border-t border-slate-100">
            <div className="p-3">
              <TextInput placeholder="Filter students…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <table className="w-full">
              <thead><tr><th className="th">Student</th><th className="th">Roll</th><th className="th">Section</th><th className="th text-right">Exclude</th></tr></thead>
              <tbody>
                {visibleStudents.map((s: any) => (
                  <tr key={s.id} className="tr-hover">
                    <td className="td text-sm font-semibold text-slate-700">{s.name}</td>
                    <td className="td text-xs">{s.roll || "—"}</td>
                    <td className="td text-xs">{s.section || "—"}</td>
                    <td className="td text-right">
                      <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-500">
                        <input
                          type="checkbox"
                          checked={excluded.has(s.id)}
                          onChange={(e) => {
                            const next = new Set(excluded);
                            if (e.target.checked) next.add(s.id);
                            else next.delete(s.id);
                            setExcluded(next);
                          }}
                        />
                        exclude (failed / repeating)
                      </label>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Alumni (§5.3)" subtitle={`${alumni.length} archived students — records preserved, deletable never`} />
        {alumni.length ? (
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full">
              <thead><tr><th className="th">Name</th><th className="th">Admission No</th><th className="th">Last class</th><th className="th text-right">Action</th></tr></thead>
              <tbody>
                {alumni.map((a) => (
                  <tr key={a.id} className="tr-hover">
                    <td className="td text-sm font-semibold text-slate-700">{a.name}</td>
                    <td className="td text-xs">{a.admissionNo}</td>
                    <td className="td text-xs">{a.classRoom?.name || "—"}</td>
                    <td className="td text-right">
                      <button className="btn btn-ghost btn-sm" onClick={() => restore(a.id)}><Archive size={13} /> Re-enroll</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={GraduationCap} title="No alumni yet" description="Graduating or TC-taken students are archived here." />
        )}
      </Card>
    </div>
  );
}
