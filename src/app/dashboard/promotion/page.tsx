"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, GraduationCap, Archive, AlertTriangle, UserMinus, Undo2 } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Card, CardHeader, Badge, Field, Select, TextInput, Modal, PageHeader, LoadingScreen, EmptyState, ErrorNote } from "@/components/ui";

/**
 * PRD §5.2 — Class Promotion Workflow (preview → confirm), §5.3 — Alumni archive,
 * and Phase 6 session rollover + transfer/withdrawal.
 *
 * Promotion is reviewable: pick a target session, preview the per-class mapping
 * and counts, then confirm. Nothing sets the current academic session here — that
 * stays an explicit action on the Academic Sessions page. Re-running a promotion
 * is safe (already-processed students are skipped).
 */

export default function PromotionPage() {
  const [classes, setClasses] = useState<any[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [toSessionId, setToSessionId] = useState("");
  const [fromClassId, setFromClassId] = useState("");
  const [preview, setPreview] = useState<any>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [q, setQ] = useState("");
  const [alumni, setAlumni] = useState<any[]>([]);
  const [offRoll, setOffRoll] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [lifecycle, setLifecycle] = useState<{ student: any; action: string } | null>(null);
  const [lifecycleReason, setLifecycleReason] = useState("");

  const loadAlumni = () => api<any[]>("/api/students/alumni").then(setAlumni).catch(() => null);
  const loadOffRoll = () => api<any[]>("/api/students/alumni?status=TRANSFERRED").then(setOffRoll).catch(() => null);

  useEffect(() => {
    api<any[]>("/api/classes")
      .then((cs) => {
        setClasses(cs);
        if (cs.length) setFromClassId(cs[0].id);
      })
      .finally(() => setLoading(false));
    api<any[]>("/api/academic-sessions")
      .then((ss) => {
        setSessions(ss);
        const current = ss.find((s) => s.isCurrent);
        if (current) setToSessionId(current.id);
      })
      .catch(() => null);
    loadAlumni();
    loadOffRoll();
  }, []);

  const loadPreview = async (classId: string, sessionId = toSessionId) => {
    if (!classId) return;
    setPreview(null);
    setExcluded(new Set());
    setError("");
    try {
      setPreview(await api<any>(`/api/students/promote${qs({ fromClassId: classId, toSessionId: sessionId || undefined })}`));
    } catch (e: any) {
      setError(e?.message || "Preview failed");
    }
  };

  useEffect(() => {
    if (fromClassId) loadPreview(fromClassId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromClassId, toSessionId]);

  const promote = async () => {
    if (!preview) return;
    const willPromote = preview.count - excluded.size - (preview.counts?.already || 0);
    if (!confirm(`Promote ${willPromote} student(s)${preview.toClass ? ` to ${preview.toClass.name}` : " (graduate)"}? Retained: ${excluded.size}. Already processed (skipped): ${preview.counts?.already || 0}.`)) return;
    setBusy(true);
    setError("");
    try {
      const result = await api<any>("/api/students/promote", {
        method: "POST",
        body: JSON.stringify({ fromClassId, toSessionId: toSessionId || undefined, excludeIds: [...excluded] }),
      });
      setMessage(
        `Promoted ${result.promoted}, retained ${result.retained}, graduated ${result.graduated}, skipped ${result.skipped}${result.failed ? `, failed ${result.failed}` : ""}.`
      );
      await loadPreview(fromClassId);
      loadAlumni();
      loadOffRoll();
    } catch (e: any) {
      setError(e?.message || "Promotion failed");
    } finally {
      setBusy(false);
    }
  };

  const runLifecycle = async () => {
    if (!lifecycle) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/students/${lifecycle.student.id}/lifecycle`, {
        method: "POST",
        body: JSON.stringify({ action: lifecycle.action, reason: lifecycleReason || undefined }),
      });
      setLifecycle(null);
      setLifecycleReason("");
      await loadPreview(fromClassId);
      loadOffRoll();
    } catch (e: any) {
      setError(e?.message || "Lifecycle action failed");
    } finally {
      setBusy(false);
    }
  };

  const restore = async (studentId: string) => {
    await api("/api/students/alumni", { method: "POST", body: JSON.stringify({ studentId, restore: true }) });
    loadAlumni();
  };

  const restoreOffRoll = async (studentId: string) => {
    await api(`/api/students/${studentId}/lifecycle`, { method: "POST", body: JSON.stringify({ action: "RESTORE" }) });
    loadOffRoll();
  };

  if (loading) return <LoadingScreen />;

  const visibleStudents = preview?.students?.filter((s: any) => !q || s.name.toLowerCase().includes(q.toLowerCase())) || [];
  const sectionWarnings = (preview?.students || []).filter((s: any) => s.sectionWarning).length;

  return (
    <div className="space-y-4">
      <PageHeader title="Promotion & Alumni" subtitle="Year-end promotion, session rollover and alumni / off-roll records (PRD §5.2, §5.3)" />

      {message && <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">{message}</div>}
      {error && <ErrorNote message={error} />}

      <Card>
        <CardHeader title="Class promotion (§5.2)" subtitle="Select a target session, preview, exclude repeaters, then confirm — re-running is safe" />
        <div className="grid grid-cols-1 items-end gap-3 p-4 sm:grid-cols-4">
          <Field label="Target session">
            <Select value={toSessionId} onChange={(e) => setToSessionId(e.target.value)}>
              <option value="">Current session (default)</option>
              {sessions.map((s) => <option key={s.id} value={s.id}>{s.name}{s.isCurrent ? " (current)" : ""}</option>)}
            </Select>
          </Field>
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
                <p className="text-xs text-slate-400">Session: {preview.targetSession?.name || "current"}</p>
              </>
            ) : (
              <p className="text-slate-400">Loading preview…</p>
            )}
          </div>
          {preview && (
            <button className="btn btn-primary" onClick={promote} disabled={busy || preview.count === excluded.size}>
              <ArrowUpRight size={15} /> Promote {preview.count - excluded.size - (preview.counts?.already || 0)} students
            </button>
          )}
        </div>

        {preview && (
          <div className="grid grid-cols-2 gap-px border-t border-slate-100 bg-slate-100 sm:grid-cols-4">
            <Fact label="To promote" value={preview.count - excluded.size - (preview.counts?.already || 0)} tone="text-emerald-600" />
            <Fact label="Retained (excluded)" value={excluded.size} tone="text-amber-600" />
            <Fact label="Graduating" value={preview.counts?.graduate || 0} tone="text-indigo-600" />
            <Fact label="Already processed" value={preview.counts?.already || 0} tone="text-slate-500" />
          </div>
        )}

        {sectionWarnings > 0 && (
          <div className="flex items-start gap-2 border-t border-amber-100 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            <AlertTriangle size={14} className="mt-0.5 shrink-0" />
            <span>{sectionWarnings} student(s) have a section that does not belong to the target class. Their section will be kept as-is — no automatic remap.</span>
          </div>
        )}

        {preview && (
          <div className="max-h-80 overflow-y-auto border-t border-slate-100">
            <div className="p-3">
              <TextInput placeholder="Filter students…" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <table className="w-full">
              <thead><tr><th className="th">Student</th><th className="th">Roll</th><th className="th">Status</th><th className="th text-right">Action</th></tr></thead>
              <tbody>
                {visibleStudents.map((s: any) => (
                  <tr key={s.id} className="tr-hover">
                    <td className="td text-sm font-semibold text-slate-700">
                      {s.name}
                      {s.sectionWarning && <div className="text-[11px] font-normal text-amber-600">{s.sectionWarning}</div>}
                    </td>
                    <td className="td text-xs">{s.roll || "—"}</td>
                    <td className="td text-xs">
                      {s.action === "already" ? <Badge tone="slate">Already processed</Badge> : s.action === "graduate" ? <Badge tone="indigo">Graduating</Badge> : <Badge tone="green">Promote</Badge>}
                    </td>
                    <td className="td text-right">
                      <div className="flex items-center justify-end gap-3">
                        {s.action !== "already" && (
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
                            retain (repeating)
                          </label>
                        )}
                        {s.action !== "already" && (
                          <button className="btn btn-ghost btn-sm" onClick={() => { setLifecycle({ student: s, action: "TRANSFER" }); setLifecycleReason(""); }}><UserMinus size={13} /> Transfer</button>
                        )}
                      </div>
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

      <Card>
        <CardHeader title="Off-roll (transferred / withdrawn)" subtitle={`${offRoll.length} student(s) — left the school, records and guardian access kept`} />
        {offRoll.length ? (
          <div className="max-h-96 overflow-y-auto">
            <table className="w-full">
              <thead><tr><th className="th">Name</th><th className="th">Admission No</th><th className="th">Reason</th><th className="th text-right">Action</th></tr></thead>
              <tbody>
                {offRoll.map((a) => (
                  <tr key={a.id} className="tr-hover">
                    <td className="td text-sm font-semibold text-slate-700">{a.name}</td>
                    <td className="td text-xs">{a.admissionNo}</td>
                    <td className="td text-xs">{a.lifecycleReason || a.lifecycleAction || "—"}</td>
                    <td className="td text-right">
                      <button className="btn btn-ghost btn-sm" onClick={() => restoreOffRoll(a.id)}><Undo2 size={13} /> Restore</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={UserMinus} title="No off-roll students" description="Transferred or withdrawn students appear here." />
        )}
      </Card>

      <Modal open={!!lifecycle} onClose={() => setLifecycle(null)} title={`${lifecycle?.action === "WITHDRAW" ? "Withdraw" : "Transfer"} student`}>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            {lifecycle?.student?.name} will be marked <span className="font-semibold">TRANSFERRED</span> and leave on-roll lists. Historical records and the guardian account are kept.
          </p>
          <Field label="Action">
            <Select value={lifecycle?.action || "TRANSFER"} onChange={(e) => setLifecycle((l) => (l ? { ...l, action: e.target.value } : l))}>
              <option value="TRANSFER">Transfer</option>
              <option value="WITHDRAW">Withdraw</option>
            </Select>
          </Field>
          <Field label="Reason (optional)"><TextInput value={lifecycleReason} onChange={(e) => setLifecycleReason(e.target.value)} placeholder="e.g. moved city" /></Field>
          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setLifecycle(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={runLifecycle} disabled={busy}>Confirm</button>
          </div>
        </div>
      </Modal>
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
