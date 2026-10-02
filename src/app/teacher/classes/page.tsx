"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Play, Square, Radio, Clock, Check, X, CalendarClock } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, Select, Textarea, Field, LoadingScreen, ErrorNote, Modal } from "@/components/ui";
import { Surface, ListCard, ListRow, EmptyState } from "@/components/app-ui";

/**
 * A teacher's day, as a list. The timetable the office already built is the
 * roster: every period assigned to this teacher appears here with its class,
 * section, subject and time. The teacher makes one tap — Yes when they walk in,
 * and Finish class when the lesson ends. No class, section or subject picking.
 *
 * A teacher covering someone else's period can still start any class by hand
 * from the "Covering another class?" panel, which is the same start form as
 * before.
 *
 * No and Finish are the only other taps: No records that the period was not
 * taken (the office can see it), and it is undone by tapping Yes.
 */
interface RosterRow {
  routineId: string;
  classId: string;
  sectionId: string | null;
  subjectId: string | null;
  className: string;
  sectionName: string | null;
  subjectName: string | null;
  period: number;
  periodLabel: string;
  startTime: string | null;
  endTime: string | null;
  state: "upcoming" | "inClass" | "done" | "declined";
  sessionId: string | null;
  startedClock: string | null;
  endedClock: string | null;
  durationMin: number;
  isNow: boolean;
}
interface Session {
  id: string;
  className: string;
  sectionName: string | null;
  subjectName: string | null;
  periodLabel: string | null;
  note: string | null;
  status: string;
  autoEnded: boolean;
  startedClock: string | null;
  endedClock: string | null;
  durationMin: number;
}
interface Console {
  date: string;
  weekday: string | null;
  active: Session | null;
  sessions: Session[];
  roster: RosterRow[];
  otherSessions: Session[];
  todayKey: string;
  liveMaxMinutes: number;
}

interface ClassRow { id: string; name: string }
interface SectionRow { id: string; classId: string; name: string }
interface SubjectRow { id: string; name: string }

const POLL_MS = 25_000;

/** A panel title in the app's section voice, with the old header's subtitle. */
function PanelHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: React.ReactNode }) {
  return (
    <div className="mb-2 flex items-end justify-between gap-3 px-1">
      <div className="min-w-0">
        <h2 className="text-[13px] font-extrabold uppercase tracking-[0.05em] text-slate-500">{title}</h2>
        {subtitle ? <p className="mt-0.5 text-[11px] leading-snug text-slate-400">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export default function MyClassesPage() {
  const [data, setData] = useState<Console | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busyId, setBusyId] = useState("");
  const [confirmEnd, setConfirmEnd] = useState(false);

  // The "cover another class" fallback, loaded only when it is opened.
  const [coverOpen, setCoverOpen] = useState(false);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [sections, setSections] = useState<SectionRow[]>([]);
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [pickerLoaded, setPickerLoaded] = useState(false);
  const [pick, setPick] = useState({ classId: "", sectionId: "", subjectId: "", periodLabel: "", note: "" });

  const load = useCallback(async () => {
    const res = await api<Console>("/api/class-sessions?view=me", { cache: "no-store" });
    setData(res);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await load();
      } catch (e: any) {
        if (alive) setError(e?.message || "Could not load your classes.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [load]);

  // Keep the live panel honest while the page sits open.
  useEffect(() => {
    const t = setInterval(() => load().catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  // Load the picker's reference data the first time a teacher needs it.
  useEffect(() => {
    if (!coverOpen || pickerLoaded) return;
    let alive = true;
    Promise.all([api<ClassRow[]>("/api/classes"), api<SectionRow[]>("/api/sections"), api<SubjectRow[]>("/api/subjects")])
      .then(([c, s, sub]) => {
        if (!alive) return;
        setClasses(c);
        setSections(s);
        setSubjects(sub);
        setPickerLoaded(true);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [coverOpen, pickerLoaded]);

  const active = data?.active || null;
  const roster = data?.roster || [];
  const otherSessions = data?.otherSessions || [];
  const todayName = data?.weekday || "today";

  const classSections = useMemo(() => sections.filter((s) => s.classId === pick.classId), [sections, pick.classId]);
  const routineForPick = useMemo(() => {
    // The cover picker offers today's periods of the chosen class as labels.
    return (data?.roster || []).filter((r) => r.classId === pick.classId);
  }, [data?.roster, pick.classId]);

  /** Yes — I'm entering this scheduled class. */
  async function enter(r: RosterRow) {
    if (busyId) return;
    setBusyId(r.routineId);
    setError("");
    try {
      await api("/api/class-sessions", { method: "POST", body: JSON.stringify({ routineId: r.routineId }) });
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not start the class.");
      await load().catch(() => {});
    } finally {
      setBusyId("");
    }
  }

  /** No — I'm not taking this period. */
  async function decline(r: RosterRow) {
    if (busyId) return;
    setBusyId(r.routineId);
    setError("");
    try {
      await api("/api/class-sessions", { method: "POST", body: JSON.stringify({ action: "decline", routineId: r.routineId }) });
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not record that.");
      await load().catch(() => {});
    } finally {
      setBusyId("");
    }
  }

  async function finish() {
    if (!active || busyId) return;
    setBusyId(active.id);
    setError("");
    try {
      await api(`/api/class-sessions/${encodeURIComponent(active.id)}`, { method: "PATCH", body: JSON.stringify({}) });
      setConfirmEnd(false);
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not end the class.");
      await load().catch(() => {});
    } finally {
      setBusyId("");
    }
  }

  async function startCover() {
    if (!pick.classId || busyId) return;
    setBusyId("cover");
    setError("");
    try {
      await api("/api/class-sessions", {
        method: "POST",
        body: JSON.stringify({
          classId: pick.classId,
          sectionId: pick.sectionId || undefined,
          subjectId: pick.subjectId || undefined,
          periodLabel: pick.periodLabel || undefined,
          note: pick.note || undefined,
        }),
      });
      setPick({ classId: "", sectionId: "", subjectId: "", periodLabel: "", note: "" });
      await load();
    } catch (e: any) {
      setError(e?.message || "Could not start the class.");
      await load().catch(() => {});
    } finally {
      setBusyId("");
    }
  }

  if (loading) return <LoadingScreen />;

  return (
    <div className="ss-classespage space-y-5">
      <div className="px-1">
        <p className="text-[12px] leading-snug text-slate-500">
          Your classes for {todayName}. Tap Yes when you walk in and Finish class when it is over.
        </p>
      </div>

      {error && <ErrorNote message={error} />}

      {active && (
        <Surface className="ss-classes-live border border-emerald-200 bg-emerald-50/60 ring-0">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Badge tone="green">
                  <Radio className="mr-1 inline h-3 w-3" /> In class now
                </Badge>
                {active.periodLabel && <span className="text-xs text-slate-500">{active.periodLabel}</span>}
              </div>
              <h2 className="mt-2 text-lg font-semibold text-slate-900">
                {active.className}
                {active.sectionName ? ` · Section ${active.sectionName}` : ""}
              </h2>
              <p className="text-sm text-slate-600">{active.subjectName || "Subject not specified"}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                <Clock className="h-3.5 w-3.5" /> Started {active.startedClock} · running {active.durationMin} min
              </p>
            </div>
            <button className="btn btn-danger min-h-11" onClick={() => setConfirmEnd(true)} disabled={!!busyId}>
              <Square className="mr-1.5 h-4 w-4" /> Finish class
            </button>
          </div>
          <p className="mt-4 text-xs text-slate-500">
            If it is never finished, the office board closes it automatically after {Math.round((data?.liveMaxMinutes || 240) / 60)} hours.
          </p>
        </Surface>
      )}

      <div>
        <PanelHeader
          title="Today's classes"
          subtitle="From the school routine — tap Yes when you enter, Finish class when the lesson ends."
        />
        {roster.length === 0 ? (
          <EmptyState
            icon={CalendarClock}
            title="No classes on your timetable today"
            hint="If you are covering another teacher's class, use the panel below."
          />
        ) : (
          <ListCard className="ss-classes-roster">
            {roster.map((r) => {
              const busy = busyId === r.routineId;
              return (
                <li
                  key={r.routineId}
                  className={`ss-classes-row px-3.5 py-3 ${
                    r.state === "inClass" ? "bg-emerald-50/50" : r.isNow && r.state === "upcoming" ? "bg-amber-50/40" : ""
                  }`}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="min-w-0 truncate text-[14px] font-bold text-slate-900">{r.subjectName || r.className}</span>
                    {r.isNow && r.state === "upcoming" && <Badge tone="amber">now</Badge>}
                    {r.state === "inClass" && (
                      <Badge tone="green">
                        <Radio className="mr-1 inline h-3 w-3" /> In class
                      </Badge>
                    )}
                    {r.state === "done" && <Badge tone="slate">Done</Badge>}
                    {r.state === "declined" && <Badge tone="amber">Not taken</Badge>}
                  </div>
                  <p className="mt-0.5 truncate text-[12px] text-slate-500">
                    {r.className}
                    {r.sectionName ? ` · Section ${r.sectionName}` : ""} · {r.periodLabel}
                    {r.state === "done" && r.durationMin ? ` · ran ${r.durationMin} min` : ""}
                  </p>

                  <div className="mt-2.5 flex flex-wrap items-center gap-2">
                    {r.state === "upcoming" && (
                      <>
                        <button className="btn btn-primary btn-sm min-h-11" onClick={() => enter(r)} disabled={!!busyId || !!active}>
                          <Check className="mr-1 h-3.5 w-3.5" /> {busy ? "Starting…" : "Yes"}
                        </button>
                        <button className="btn btn-secondary btn-sm min-h-11" onClick={() => decline(r)} disabled={!!busyId}>
                          <X className="mr-1 h-3.5 w-3.5" /> No
                        </button>
                      </>
                    )}
                    {r.state === "inClass" && (
                      <button className="btn btn-danger btn-sm min-h-11" onClick={() => setConfirmEnd(true)} disabled={!!busyId}>
                        <Square className="mr-1 h-3.5 w-3.5" /> Finish class
                      </button>
                    )}
                    {r.state === "declined" && (
                      <>
                        <span className="text-xs text-slate-400">Not taken</span>
                        <button className="btn btn-secondary btn-sm min-h-11" onClick={() => enter(r)} disabled={!!busyId || !!active}>
                          <Check className="mr-1 h-3.5 w-3.5" /> {busy ? "Starting…" : "I am teaching it"}
                        </button>
                      </>
                    )}
                    {r.state === "done" && <span className="text-xs text-slate-400">{r.endedClock ? `ended ${r.endedClock}` : ""}</span>}
                  </div>
                </li>
              );
            })}
          </ListCard>
        )}
      </div>

      {otherSessions.length > 0 && (
        <div>
          <PanelHeader title="Other classes today" subtitle="Classes you started that are not on your timetable." />
          <ListCard className="ss-classes-other">
            {otherSessions.map((s) => (
              <ListRow
                key={s.id}
                icon={Clock}
                tone="slate"
                title={`${s.className}${s.sectionName ? ` · ${s.sectionName}` : ""}`}
                subtitle={`${s.subjectName || "—"} · ${s.startedClock || "—"}–${s.status === "OPEN" ? "—" : s.endedClock || "—"} · ${s.durationMin} min`}
                trailing={
                  s.status === "OPEN" ? (
                    <Badge tone="green">In class</Badge>
                  ) : s.autoEnded ? (
                    <Badge tone="amber">Auto-closed</Badge>
                  ) : (
                    <Badge tone="slate">Ended</Badge>
                  )
                }
              />
            ))}
          </ListCard>
        </div>
      )}

      <div>
        <PanelHeader
          title="Covering another class?"
          subtitle="Start a class that is not on your timetable — a relief period, or a class taught elsewhere."
          action={
            <button className="btn btn-secondary btn-sm min-h-11 shrink-0" onClick={() => setCoverOpen((v) => !v)}>
              {coverOpen ? "Hide" : "Show"}
            </button>
          }
        />
        {coverOpen && (
          <Surface className="ss-classes-cover">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <Field label="Class">
                <Select
                  value={pick.classId}
                  onChange={(e) => setPick({ ...pick, classId: e.target.value, sectionId: "", subjectId: "" })}
                >
                  <option value="">Select…</option>
                  {classes.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Section" hint={classSections.length ? undefined : "No sections for this class"}>
                <Select
                  value={pick.sectionId}
                  onChange={(e) => setPick({ ...pick, sectionId: e.target.value })}
                  disabled={!classSections.length}
                >
                  <option value="">All sections</option>
                  {classSections.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Subject">
                <Select value={pick.subjectId} onChange={(e) => setPick({ ...pick, subjectId: e.target.value })}>
                  <option value="">Not specified</option>
                  {subjects.map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Period" hint="Optional — e.g. Period 3">
                <Select value={pick.periodLabel} onChange={(e) => setPick({ ...pick, periodLabel: e.target.value })}>
                  <option value="">Not specified</option>
                  {routineForPick.map((r) => (
                    <option key={r.routineId} value={r.periodLabel}>
                      {`${r.periodLabel}${r.subjectName ? ` · ${r.subjectName}` : ""}`}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            <Field label="Note" className="mt-4" hint="Optional — what the class is covering today.">
              <Textarea
                value={pick.note}
                onChange={(e) => setPick({ ...pick, note: e.target.value })}
                placeholder="e.g. Chapter 4 — fractions"
              />
            </Field>
            <div className="mt-4 flex items-center gap-3">
              <button className="btn btn-primary min-h-11" onClick={startCover} disabled={!pick.classId || !!busyId}>
                <Play className="mr-1.5 h-4 w-4" /> {busyId === "cover" ? "Starting…" : "Start class"}
              </button>
              {!pick.classId && <span className="text-xs text-slate-400">Choose a class to begin.</span>}
            </div>
          </Surface>
        )}
      </div>

      <Modal open={confirmEnd} onClose={() => setConfirmEnd(false)} title="Finish this class?">
        <p className="text-sm text-slate-600">
          {active ? `${active.className}${active.sectionName ? ` · ${active.sectionName}` : ""} — ${active.durationMin} min so far.` : ""}{" "}
          The office board and parents will show the class as finished.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn btn-secondary min-h-11" onClick={() => setConfirmEnd(false)} disabled={!!busyId}>
            Cancel
          </button>
          <button className="btn btn-danger min-h-11" onClick={finish} disabled={!!busyId}>
            {busyId === active?.id ? "Finishing…" : "Finish class"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
