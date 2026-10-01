"use client";

import { useEffect, useMemo, useState } from "react";
import { CalendarDays, Save, Check, SlidersHorizontal, ChevronDown, Users, TriangleAlert } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Select, PageHeader, LoadingScreen, ErrorNote, Modal, Field, Badge } from "@/components/ui";
import { DAYS, DAYS_SHORT } from "@/lib/utils";

/**
 * The class routine.
 *
 * Two things are configurable here, because no two schools agree on them:
 *
 *  1. **The shape of the day** — how many periods, when each one runs, and which
 *     weekdays the school works. Set once per school in the Periods panel; the
 *     grid below follows it. Changing it re-times every existing lesson and drops
 *     any that fall outside the new shape.
 *  2. **The scope** — the whole class, or a single section. The class-wide week is
 *     the default every section follows; a section can have its own week instead,
 *     which is how "1A takes Maths while 1B takes Science" becomes possible.
 *
 * A cell is one subject, or empty for a free period. One scope is saved at a time
 * and only that scope is replaced, so editing Section A never touches Section B.
 */
interface ClassRow { id: string; name: string; sections?: { id: string; name: string }[] }
interface SubjectRow { id: string; name: string }
interface Routine {
  id: string;
  day: number;
  period: number;
  subjectId: string | null;
  startTime: string | null;
  endTime: string | null;
  sectionId: string | null;
}
interface PeriodDraft { start: string; end: string }
interface RoutineConfig { days: number[]; periods: { period: number; start: string | null; end: string | null }[] }

const cellKey = (day: number, period: number) => `${day}|${period}`;
const hhmm = (v: string | null | undefined) => (v || "").slice(0, 5);

export default function RoutinePage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [config, setConfig] = useState<RoutineConfig | null>(null);
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [cells, setCells] = useState<Record<string, string>>({});
  const [inherited, setInherited] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  // The shape editor: a draft the admin can experiment with before applying.
  const [shapeOpen, setShapeOpen] = useState(false);
  const [draft, setDraft] = useState<{ periods: PeriodDraft[]; days: number[] }>({ periods: [], days: [] });
  const [confirmShape, setConfirmShape] = useState(false);

  const periods = config?.periods || [];
  const days = config?.days || [];

  useEffect(() => {
    Promise.all([api<ClassRow[]>("/api/classes"), api<SubjectRow[]>("/api/subjects"), api<{ config: RoutineConfig }>("/api/routine-config")])
      .then(([c, s, cfg]) => {
        setClasses(c);
        setSubjects(s);
        setConfig(cfg.config);
        setDraft({
          days: cfg.config.days,
          periods: cfg.config.periods.map((p) => ({ start: hhmm(p.start), end: hhmm(p.end) })),
        });
      })
      .catch((e: any) => setError(e?.message || "Could not load the routine."))
      .finally(() => setLoading(false));
  }, []);

  const sections = useMemo(() => classes.find((c) => c.id === classId)?.sections || [], [classes, classId]);

  const loadScope = async (cid: string, sid: string) => {
    if (!cid) {
      setCells({});
      setInherited(false);
      return;
    }
    const mine = await api<Routine[]>(`/api/routines?classId=${encodeURIComponent(cid)}${sid ? `&sectionId=${encodeURIComponent(sid)}` : ""}`);
    const filled = (rows: Routine[]) => {
      const out: Record<string, string> = {};
      for (const r of rows) if (r.subjectId) out[cellKey(r.day, r.period)] = r.subjectId;
      return out;
    };
    if (mine.length || !sid) {
      setCells(filled(mine));
      setInherited(false);
      return;
    }
    // A section with no week of its own starts from the class-wide default.
    const wide = await api<Routine[]>(`/api/routines?classId=${encodeURIComponent(cid)}`);
    setCells(filled(wide));
    setInherited(wide.length > 0);
  };

  useEffect(() => {
    if (!config) return;
    loadScope(classId, sectionId).catch((e: any) => setError(e?.message || "Could not load that routine."));
    setNotice("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classId, sectionId, config]);

  const saveRoutine = async () => {
    if (!classId) return;
    setBusy(true);
    setSaved(false);
    setError("");
    try {
      const rows: any[] = [];
      for (const p of periods) {
        for (const d of days) {
          const subjectId = cells[cellKey(d, p.period)];
          if (subjectId) rows.push({ day: d, period: p.period, subjectId, startTime: p.start, endTime: p.end });
        }
      }
      await api("/api/routines", { method: "POST", body: JSON.stringify({ classId, sectionId: sectionId || null, rows }) });
      setInherited(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e?.message || "Could not save the routine.");
    } finally {
      setBusy(false);
    }
  };

  /** Drop a section's own week so it follows the class-wide default again. */
  const clearSection = async () => {
    if (!classId || !sectionId) return;
    setBusy(true);
    setError("");
    try {
      await api("/api/routines", { method: "POST", body: JSON.stringify({ classId, sectionId, rows: [] }) });
      await loadScope(classId, sectionId);
      setNotice("Section reset — it follows the class routine again.");
    } catch (e: any) {
      setError(e?.message || "Could not reset that section.");
    } finally {
      setBusy(false);
    }
  };

  const setPeriodCount = (count: number) => {
    const n = Math.max(1, Math.min(12, count));
    setDraft((d) => {
      const next = d.periods.slice(0, n);
      while (next.length < n) next.push({ start: "", end: "" });
      return { ...d, periods: next };
    });
  };

  const setPeriodTime = (index: number, key: "start" | "end", value: string) => {
    setDraft((d) => ({ ...d, periods: d.periods.map((p, i) => (i === index ? { ...p, [key]: value } : p)) }));
  };

  const toggleDay = (day: number) => {
    setDraft((d) => (d.days.includes(day) ? { ...d, days: d.days.filter((x) => x !== day) } : { ...d, days: [...d.days, day].sort((a, b) => a - b) }));
  };

  const shapeShrinks = useMemo(() => {
    if (!config) return false;
    const fewerPeriods = draft.periods.length < config.periods.length;
    const fewerDays = draft.days.length < config.days.length;
    const movedTimes = draft.periods.some((p, i) => hhmm(config.periods[i]?.start) !== p.start || hhmm(config.periods[i]?.end) !== p.end);
    return fewerPeriods || fewerDays || movedTimes;
  }, [config, draft]);

  const applyShape = async () => {
    setBusy(true);
    setError("");
    setConfirmShape(false);
    try {
      const res = await api<{ config: RoutineConfig; retimed: number; removed: number }>("/api/routine-config", {
        method: "PUT",
        body: JSON.stringify({
          config: {
            days: draft.days,
            periods: draft.periods.map((p, i) => ({ period: i + 1, start: p.start || null, end: p.end || null })),
          },
        }),
      });
      setConfig(res.config);
      setDraft({ days: res.config.days, periods: res.config.periods.map((p) => ({ start: hhmm(p.start), end: hhmm(p.end) })) });
      await loadScope(classId, sectionId);
      setNotice(`Day shape saved — ${res.retimed} lesson(s) re-timed${res.removed ? `, ${res.removed} removed` : ""}.`);
    } catch (e: any) {
      setError(e?.message || "Could not save the day shape.");
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <LoadingScreen />;

  const scopeLabel = !classId ? "" : sectionId ? `${classes.find((c) => c.id === classId)?.name} · Section ${sections.find((s) => s.id === sectionId)?.name}` : `${classes.find((c) => c.id === classId)?.name} (whole class)`;

  return (
    <div className="ss-routinepage">
      <PageHeader
        icon={CalendarDays}
        title="Class Routine"
        subtitle="Build the weekly timetable — per class, or per section"
        actions={
          <button className="btn btn-primary ss-routine-save" onClick={saveRoutine} disabled={busy || !classId}>
            {saved ? <Check size={15} /> : <Save size={15} />} {saved ? "Saved!" : busy ? "Saving…" : "Save routine"}
          </button>
        }
      />

      {error && <div className="ss-routine-error mb-4"><ErrorNote message={error} /></div>}
      {notice && <div className="ss-routine-notice mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-800">{notice}</div>}

      <Card className="ss-routine-toolbar mb-4 p-4">
        <div className="ss-routine-toolbar-row flex flex-wrap items-end gap-3">
          <div className="ss-routine-field">
            <label className="label ss-routine-label">Class</label>
            <Select value={classId} onChange={(e) => { setClassId(e.target.value); setSectionId(""); }} className="ss-routine-select !w-48">
              <option value="">Select class…</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div className="ss-routine-field">
            <label className="label ss-routine-label">Section</label>
            <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)} className="ss-routine-select !w-48" disabled={!classId || !sections.length}>
              <option value="">Whole class (default)</option>
              {sections.map((s) => <option key={s.id} value={s.id}>Section {s.name}</option>)}
            </Select>
          </div>
          <button className="btn btn-secondary ss-routine-shape-toggle" onClick={() => setShapeOpen((v) => !v)}>
            <SlidersHorizontal size={15} /> Periods &amp; days <ChevronDown size={14} className={shapeOpen ? "rotate-180 transition" : "transition"} />
          </button>
          <span className="ss-routine-hint ss-routine-hint-toolbar text-xs text-slate-400">
            {days.length} day(s) × {periods.length} period(s). Empty cells are free periods.
          </span>
        </div>

        {scopeLabel && (
          <p className="ss-routine-scope mt-3 flex items-center gap-1.5 text-xs text-slate-500">
            <Users size={13} /> Editing <span className="font-medium text-slate-700">{scopeLabel}</span>
          </p>
        )}
      </Card>

      {shapeOpen && (
        <Card className="ss-routine-shape mb-4">
          <CardHeader
            title={<><span className="ss-routine-section-icon"><SlidersHorizontal size={15} /></span>The school&apos;s day</>}
            subtitle="How many periods, when each runs, and which weekdays. Applies to every class."
          />
          <div className="ss-routine-shape-body p-5 pt-0">
            <div className="ss-routine-shape-top flex flex-wrap items-center gap-4">
              <Field label="Periods per day" className="!mb-0">
                <input
                  type="number"
                  min={1}
                  max={12}
                  className="ss-routine-count input !w-24"
                  value={draft.periods.length}
                  onChange={(e) => setPeriodCount(Number(e.target.value))}
                />
              </Field>
              <div className="ss-routine-days">
                <label className="label ss-routine-label">Working days</label>
                <div className="ss-routine-days-row flex flex-wrap gap-1.5">
                  {DAYS.map((label, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => toggleDay(i)}
                      title={label}
                      className={`ss-routine-day rounded-full border px-3 py-1 text-xs ${draft.days.includes(i) ? "is-on border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-500 hover:bg-slate-50"}`}
                    >
                      {DAYS_SHORT[i]}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="ss-routine-periods mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {draft.periods.map((p, i) => (
                <div key={i} className="ss-routine-period flex items-center gap-2 rounded-xl border border-slate-100 bg-slate-50/60 px-3 py-2">
                  <span className="ss-routine-period-no flex h-6 w-6 items-center justify-center rounded-lg bg-indigo-50 text-xs font-black text-indigo-600">{i + 1}</span>
                  <input type="time" className="ss-routine-time input !w-28 !px-2 !py-1 text-xs" value={p.start} onChange={(e) => setPeriodTime(i, "start", e.target.value)} />
                  <span className="ss-routine-dash text-slate-300">–</span>
                  <input type="time" className="ss-routine-time input !w-28 !px-2 !py-1 text-xs" value={p.end} onChange={(e) => setPeriodTime(i, "end", e.target.value)} />
                </div>
              ))}
            </div>

            <div className="ss-routine-shape-actions mt-4 flex flex-wrap items-center gap-3">
              <button
                className="btn btn-primary ss-routine-shape-save"
                disabled={busy || !draft.days.length || !draft.periods.length}
                onClick={() => (shapeShrinks ? setConfirmShape(true) : applyShape())}
              >
                <Check size={15} /> Save periods &amp; days
              </button>
              <span className="ss-routine-hint text-xs text-slate-400">Changing a period&apos;s time re-times every class&apos;s lessons in that period.</span>
            </div>
          </div>
        </Card>
      )}

      {inherited && (
        <div className="ss-routine-inherited mb-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <span>
            This section has no routine of its own — what you see is the <strong>class routine</strong>. Saving gives this section its own week.
          </span>
        </div>
      )}

      <Card className="ss-routine-grid overflow-hidden">
        <div className="ss-routine-scroll overflow-x-auto">
          <table className="ss-routine-table w-full">
            <thead>
              <tr className="ss-routine-thead bg-slate-50">
                <th className="th ss-routine-th-pin min-w-40">Period / Time</th>
                {days.map((d) => (
                  <th key={d} className="th ss-routine-th text-center">{DAYS[d]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.period} className="ss-routine-row">
                  <td className="td ss-routine-period-cell">
                    <div className="flex items-center gap-2">
                      <span className="ss-routine-period-no flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-xs font-black text-indigo-600">{p.period}</span>
                      <span className="ss-routine-period-time text-xs text-slate-500">
                        {p.start || p.end ? `${hhmm(p.start) || "—"}–${hhmm(p.end) || "—"}` : "no time set"}
                      </span>
                    </div>
                  </td>
                  {days.map((d) => (
                    <td key={d} className="td ss-routine-cell">
                      <select
                        className="ss-routine-cell-select input !px-2 !py-1.5 text-xs"
                        value={cells[cellKey(d, p.period)] || ""}
                        onChange={(e) => setCells((m) => ({ ...m, [cellKey(d, p.period)]: e.target.value }))}
                        disabled={!classId}
                      >
                        <option value="">—</option>
                        {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!classId && (
          <div className="ss-routine-empty flex flex-col items-center gap-2 py-10 text-slate-400">
            <CalendarDays size={28} />
            <p className="text-sm">Select a class to build its routine</p>
          </div>
        )}
      </Card>

      {classId && sectionId && (
        <div className="ss-routine-reset mt-4 flex items-center gap-3">
          <button className="btn btn-secondary btn-sm ss-routine-reset-btn" onClick={clearSection} disabled={busy}>
            Use the class routine instead
          </button>
          <span className="ss-routine-hint text-xs text-slate-400">Removes this section&apos;s own week; it goes back to following the class.</span>
        </div>
      )}

      <Modal open={confirmShape} onClose={() => setConfirmShape(false)} title="Change the school's day shape?">
        <p className="ss-routine-modal-note text-sm text-slate-600">
          Every class&apos;s lessons will be re-timed to match, and any lesson on a period or weekday you are removing will be
          <strong> deleted</strong>.
        </p>
        <p className="ss-routine-modal-chips mt-2 flex items-center gap-2 text-xs text-slate-500">
          <Badge tone="amber">{(draft.periods.length)} periods</Badge>
          <Badge tone="amber">{draft.days.map((d) => DAYS_SHORT[d]).join(" ")}</Badge>
        </p>
        <div className="ss-routine-modal-actions mt-5 flex justify-end gap-2">
          <button className="btn btn-secondary ss-routine-modal-cancel" onClick={() => setConfirmShape(false)} disabled={busy}>Cancel</button>
          <button className="btn btn-primary ss-routine-modal-cta" onClick={applyShape} disabled={busy}>{busy ? "Applying…" : "Apply to every class"}</button>
        </div>
      </Modal>
    </div>
  );
}
