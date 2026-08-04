"use client";

import { useEffect, useState } from "react";
import { CalendarDays, Save, Check } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Select, PageHeader, LoadingScreen, ErrorNote } from "@/components/ui";
import { DAYS } from "@/lib/utils";

interface ClassRow { id: string; name: string }
interface SubjectRow { id: string; name: string }
interface Routine { id: string; day: number; period: number; subjectId: string | null; startTime: string | null; endTime: string | null }

const PERIODS = 8;
const DAY_COUNT = 5; // Sun – Thu

export default function RoutinePage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [subjects, setSubjects] = useState<SubjectRow[]>([]);
  const [classId, setClassId] = useState("");
  const [matrix, setMatrix] = useState<(string | "")[][]>([]);
  const [times, setTimes] = useState<{ start: string; end: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api<ClassRow[]>("/api/classes"), api<SubjectRow[]>("/api/subjects")])
      .then(([c, s]) => { setClasses(c); setSubjects(s); })
      .finally(() => setLoading(false));
  }, []);

  const emptyMatrix = () => Array.from({ length: PERIODS }, () => Array<string | "">(DAY_COUNT).fill(""));
  const emptyTimes = () => Array.from({ length: PERIODS }, () => ({ start: "", end: "" }));

  const selectClass = async (cid: string) => {
    setClassId(cid);
    const m = emptyMatrix();
    const t = emptyTimes();
    if (cid) {
      const routines = await api<Routine[]>(`/api/routines?classId=${cid}`);
      for (const r of routines) {
        if (r.subjectId && r.period >= 1 && r.period <= PERIODS && r.day >= 0 && r.day < DAY_COUNT) {
          m[r.period - 1][r.day] = r.subjectId;
        }
        if (r.period >= 1 && r.period <= PERIODS) {
          if (r.startTime) t[r.period - 1].start = r.startTime;
          if (r.endTime) t[r.period - 1].end = r.endTime;
        }
      }
    }
    setMatrix(m);
    setTimes(t);
  };

  const save = async () => {
    setSaving(true);
    setSaved(false);
    setError("");
    try {
      const rows: any[] = [];
      for (let p = 0; p < PERIODS; p++) {
        for (let d = 0; d < DAY_COUNT; d++) {
          const subjectId = matrix[p][d];
          if (subjectId) {
            rows.push({ day: d, period: p + 1, subjectId, startTime: times[p].start || null, endTime: times[p].end || null });
          }
        }
      }
      await api("/api/routines", { method: "POST", body: JSON.stringify({ classId, rows }) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader
        title="Class Routine"
        subtitle="Build the weekly timetable"
        actions={
          <button className="btn btn-primary" onClick={save} disabled={saving || !classId}>
            {saved ? <Check size={15} /> : <Save size={15} />} {saved ? "Saved!" : saving ? "Saving…" : "Save routine"}
          </button>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="label !mb-0">Class:</label>
          <Select value={classId} onChange={(e) => selectClass(e.target.value)} className="!w-56">
            <option value="">Select class…</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <span className="text-xs text-slate-400">Tip: empty cells are free periods. Times apply per period.</span>
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50">
                <th className="th min-w-40">Period / Time</th>
                {DAYS.slice(0, DAY_COUNT).map((d) => (
                  <th key={d} className="th text-center">{d}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: PERIODS }, (_, p) => (
                <tr key={p}>
                  <td className="td">
                    <div className="flex items-center gap-2">
                      <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-indigo-50 text-xs font-black text-indigo-600">{p + 1}</span>
                      <div className="flex items-center gap-1">
                        <input type="time" className="input !w-24 !px-2 !py-1 text-xs" value={times[p]?.start || ""} onChange={(e) => setTimes((t) => t.map((x, i) => (i === p ? { ...x, start: e.target.value } : x)))} />
                        <span className="text-slate-300">–</span>
                        <input type="time" className="input !w-24 !px-2 !py-1 text-xs" value={times[p]?.end || ""} onChange={(e) => setTimes((t) => t.map((x, i) => (i === p ? { ...x, end: e.target.value } : x)))} />
                      </div>
                    </div>
                  </td>
                  {Array.from({ length: DAY_COUNT }, (_, d) => (
                    <td key={d} className="td">
                      <select
                        className="input !px-2 !py-1.5 text-xs"
                        value={matrix[p]?.[d] || ""}
                        onChange={(e) => setMatrix((m) => m.map((row, i) => (i === p ? row.map((cell, j) => (j === d ? e.target.value : cell)) : row)))}
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
        {!classId && <div className="flex flex-col items-center gap-2 py-10 text-slate-400"><CalendarDays size={28} /><p className="text-sm">Select a class to build its routine</p></div>}
      </Card>
    </div>
  );
}
