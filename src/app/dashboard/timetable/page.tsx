"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CalendarRange, Plus, Trash2, RefreshCw, UserCheck, AlertTriangle, X, Printer,
} from "lucide-react";
import { api } from "@/lib/client";
import {
  Card, CardHeader, Badge, Select, Modal, PageHeader, LoadingScreen, ErrorNote, EmptyState,
} from "@/components/ui";
import { DAYS_SHORT, todayISO } from "@/lib/utils";

/**
 * PRD §9.2 — Timetable builder UI (slots model: day × period).
 * - Class (+optional section) weekly grid with subject/teacher per cell
 * - Teacher double-booking is blocked with a clear error
 * - Substitution finder: pick a date → slots affected by approved teacher
 *   leaves + free teachers suggested per slot (§9.2 automation)
 */

interface ClassRow { id: string; name: string; sections?: { id: string; name: string }[] }
interface SubjectRow { id: string; name: string }
interface TeacherRow { id: string; name: string }
interface Slot {
  id: string; classId: string; sectionId: string | null; subjectId: string | null;
  teacherId: string | null; dayOfWeek: number; period: number;
  startTime?: string | null; endTime?: string | null;
  subject?: { name: string } | null; teacher?: { id: string; name: string } | null;
  classRoom?: { name: string } | null; section?: { name: string } | null;
}

const DAY_COUNT = 6; // Sun – Fri
const PERIODS = 8;

export default function TimetablePage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [teachers, setTeachers] = useState<TeacherRow[]>([]);
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [slots, setSlots] = useState<Slot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [cell, setCell] = useState<{ day: number; period: number; slot?: Slot } | null>(null);
  const [subOpen, setSubOpen] = useState(false);

  const loadSlots = async (cid: string, sid: string) => {
    if (!cid) { setSlots([]); return; }
    const qs = new URLSearchParams({ classId: cid });
    if (sid) qs.set("sectionId", sid);
    try {
      const data = await api<Slot[]>(`/api/timetable-slots?${qs}`);
      setSlots(data);
      setError("");
    } catch (e: any) { setError(e.message); }
  };

  useEffect(() => {
    Promise.all([
      api<ClassRow[]>("/api/classes"),
      api<SubjectRow[]>("/api/subjects"),
      api<any[]>("/api/teachers"),
    ])
      .then(([c, s, t]) => {
        setClasses(c);
        setSubjects(s);
        setTeachers(t.map((x) => ({ id: x.id, name: x.user?.name || x.name || x.id })));
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const selectedClass = classes.find((c) => c.id === classId);
  const grid = useMemo(() => {
    const g = new Map<string, Slot>();
    for (const s of slots) g.set(`${s.dayOfWeek}:${s.period}`, s);
    return g;
  }, [slots]);

  const openCell = (day: number, period: number) => {
    if (!classId) return;
    setCell({ day, period, slot: grid.get(`${day}:${period}`) });
  };

  const saveCell = async (subjectId: string, teacherId: string) => {
    if (!cell) return;
    setSaving(true); setError("");
    try {
      // replace whatever occupies the cell (server keeps the old slot out of
      // the double-booking check via replaceId, so swapping rooms is allowed)
      if (cell.slot) {
        await api(`/api/timetable-slots?id=${cell.slot.id}`, { method: "DELETE" });
      }
      await api("/api/timetable-slots", {
        method: "POST",
        body: JSON.stringify({
          classId, sectionId: sectionId || null, subjectId, teacherId,
          dayOfWeek: cell.day, period: cell.period,
          replaceId: cell.slot?.id || null,
        }),
      });
      setCell(null);
      await loadSlots(classId, sectionId);
    } catch (e: any) {
      // Refresh the grid first — loadSlots clears the error banner on
      // success, so the failure message must be set AFTER it.
      await loadSlots(classId, sectionId);
      setError(e.message); // e.g. double-booking surfaced from the API
    } finally { setSaving(false); }
  };

  const clearCell = async () => {
    if (!cell?.slot) { setCell(null); return; }
    setSaving(true); setError("");
    try {
      await api(`/api/timetable-slots?id=${cell.slot.id}`, { method: "DELETE" });
      setCell(null);
      await loadSlots(classId, sectionId);
    } catch (e: any) { setError(e.message); } finally { setSaving(false); }
  };

  if (loading) return <LoadingScreen label="Loading timetable…" />;

  return (
    <div>
      <PageHeader
        title="Timetable Builder"
        subtitle="Weekly slot grid per class — subjects, teachers and substitutions (PRD §9.2)"
        actions={
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={() => setSubOpen(true)} disabled={!teachers.length}>
              <UserCheck size={15} /> Substitutions
            </button>
            <button className="btn btn-secondary" onClick={() => window.print()} disabled={!classId}>
              <Printer size={15} /> Print
            </button>
          </div>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card className="mb-4 p-4 print:hidden">
        <div className="flex flex-wrap items-center gap-3">
          <Select value={classId} onChange={(e) => { setClassId(e.target.value); setSectionId(""); loadSlots(e.target.value, ""); }} className="!w-52">
            <option value="">Select class…</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {!!selectedClass?.sections?.length && (
            <Select value={sectionId} onChange={(e) => { setSectionId(e.target.value); loadSlots(classId, e.target.value); }} className="!w-44">
              <option value="">All sections</option>
              {selectedClass.sections.map((s) => <option key={s.id} value={s.id}>Section {s.name}</option>)}
            </Select>
          )}
          <button className="btn btn-secondary btn-sm" onClick={() => loadSlots(classId, sectionId)} disabled={!classId}>
            <RefreshCw size={13} /> Reload
          </button>
          <span className="text-xs text-slate-400">Click a cell to assign a subject + teacher. Double-booking a teacher is blocked.</span>
        </div>
      </Card>

      {!classId ? (
        <Card><EmptyState icon={CalendarRange} title="No class selected" description="Choose a class above to view or edit its weekly timetable." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div id="timetable-print" className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-slate-50">
                  <th className="th w-16 print:hidden">Period</th>
                  {DAYS_SHORT.slice(0, DAY_COUNT).map((d) => <th key={d} className="th text-center">{d}</th>)}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: PERIODS }, (_, p) => (
                  <tr key={p}>
                    <td className="td text-center print:hidden">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-xs font-black text-indigo-600">{p + 1}</span>
                    </td>
                    {Array.from({ length: DAY_COUNT }, (_, d) => {
                      const slot = grid.get(`${d}:${p + 1}`);
                      return (
                        <td key={d} className="td !p-1">
                          <button
                            onClick={() => openCell(d, p + 1)}
                            className={`h-full min-h-16 w-full rounded-xl border px-2 py-2 text-left transition ${
                              slot ? "border-indigo-200 bg-indigo-50/60 hover:bg-indigo-100" : "border-dashed border-slate-200 text-slate-300 hover:border-indigo-300 hover:bg-slate-50"
                            }`}
                          >
                            {slot ? (
                              <>
                                <div className="text-xs font-black text-slate-800">{slot.subject?.name || "—"}</div>
                                <div className="text-[10px] font-semibold text-slate-500">{slot.teacher?.name || "No teacher"}</div>
                                {slot.startTime && <div className="text-[10px] text-slate-400">{slot.startTime}{slot.endTime ? `–${slot.endTime}` : ""}</div>}
                              </>
                            ) : (
                              <div className="flex h-full min-h-12 items-center justify-center text-lg text-slate-300"><Plus size={16} /></div>
                            )}
                          </button>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* slot editor */}
      <SlotModal
        cell={cell}
        subjects={subjects}
        teachers={teachers}
        saving={saving}
        onClose={() => setCell(null)}
        onSave={saveCell}
        onClear={clearCell}
      />

      <SubstitutionModal open={subOpen} onClose={() => setSubOpen(false)} />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function SlotModal({
  cell, subjects, teachers, saving, onClose, onSave, onClear,
}: {
  cell: { day: number; period: number; slot?: Slot } | null;
  subjects: SubjectRow[]; teachers: TeacherRow[]; saving: boolean;
  onClose: () => void; onSave: (subjectId: string, teacherId: string) => void; onClear: () => void;
}) {
  const [subjectId, setSubjectId] = useState("");
  const [teacherId, setTeacherId] = useState("");

  useEffect(() => {
    setSubjectId(cell?.slot?.subjectId || "");
    setTeacherId(cell?.slot?.teacherId || "");
  }, [cell]);

  if (!cell) return null;
  return (
    <Modal open onClose={onClose} title={`${DAYS_SHORT[cell.day]} · Period ${cell.period}`}>
      <div className="space-y-4">
        {cell.slot && (
          <div className="rounded-xl bg-slate-50 px-4 py-2 text-xs font-semibold text-slate-500">
            Current: {cell.slot.subject?.name || "—"} · {cell.slot.teacher?.name || "No teacher"}
          </div>
        )}
        <div>
          <label className="label">Subject *</label>
          <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
            <option value="">Select subject…</option>
            {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </div>
        <div>
          <label className="label">Teacher *</label>
          <Select value={teacherId} onChange={(e) => setTeacherId(e.target.value)}>
            <option value="">Select teacher…</option>
            {teachers.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </div>
        <div className="flex justify-between gap-2 pt-1">
          <div>
            {cell.slot && (
              <button className="btn btn-danger btn-sm" onClick={onClear} disabled={saving}><Trash2 size={13} /> Remove slot</button>
            )}
          </div>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={onClose}><X size={14} /> Cancel</button>
            <button className="btn btn-primary" onClick={() => onSave(subjectId, teacherId)} disabled={saving || !subjectId || !teacherId}>
              {cell.slot ? "Update" : "Assign"}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ------------------------------------------------------------------ */

interface SubData {
  date: string;
  affected: (Slot & { teacher?: { name: string } | null; classRoom?: { name: string } | null; section?: { name: string } | null })[];
  suggestions: { id: string; name: string; isOnLeave: boolean }[];
}

function SubstitutionModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [date, setDate] = useState(todayISO());
  const [data, setData] = useState<SubData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const load = async (d: string) => {
    setLoading(true); setError("");
    try {
      setData(await api<SubData>("/api/timetable-slots", { method: "PUT", body: JSON.stringify({ date: d }) }));
    } catch (e: any) { setError(e.message); } finally { setLoading(false); }
  };

  useEffect(() => { if (open) load(date); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [open]);

  if (!open) return null;
  return (
    <Modal open onClose={onClose} title="Substitution finder">
      <div className="space-y-4">
        <div className="flex items-end gap-2">
          <div className="flex-1">
            <label className="label">Date</label>
            <input type="date" className="input" value={date} onChange={(e) => { setDate(e.target.value); load(e.target.value); }} />
          </div>
        </div>
        {error && <ErrorNote message={error} />}
        {loading && <LoadingScreen label="Checking leaves…" />}

        {data && !loading && (
          <>
            {data.affected.length === 0 ? (
              <div className="rounded-xl bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
                No teacher is on approved leave on this date — no substitutions needed. 🎉
              </div>
            ) : (
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-sm font-black text-slate-800">
                  <AlertTriangle size={15} className="text-amber-500" />
                  {data.affected.length} slot(s) affected by approved leave
                </div>
                {data.affected.map((s) => (
                  <div key={s.id} className="rounded-xl border border-slate-200 p-3">
                    <div className="text-xs font-black text-slate-800">
                      {DAYS_SHORT[s.dayOfWeek]} · Period {s.period} — {s.classRoom?.name || "Class"}{s.section ? ` (${s.section.name})` : ""} · {s.subject?.name || "—"}
                    </div>
                    <div className="mt-0.5 text-xs text-slate-500">Absent: {s.teacher?.name || "teacher"}</div>
                    <div className="mt-2">
                      <div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">Free teachers</div>
                      <div className="flex flex-wrap gap-1.5">
                        {data.suggestions.map((t) => (
                          <span key={t.id} className={`inline-flex items-center gap-1 rounded-lg px-2 py-1 text-[11px] font-bold ${t.isOnLeave ? "bg-rose-50 text-rose-400 line-through" : "bg-emerald-50 text-emerald-700"}`}>
                            <Badge tone={t.isOnLeave ? "rose" : "green"}>{t.isOnLeave ? "on leave" : "free"}</Badge>
                            {t.name}
                          </span>
                        ))}
                        {!data.suggestions.length && <span className="text-xs text-slate-400">No free teachers — arrange manual cover.</span>}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
