"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Save, Check } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Select, PageHeader, LoadingScreen, ErrorNote } from "@/components/ui";
import { todayISO, initials } from "@/lib/utils";

const RATINGS = ["EXCELLENT", "GOOD", "AVERAGE", "NEEDS_IMPROVEMENT"];
const RATING_STYLES: Record<string, string> = {
  EXCELLENT: "bg-emerald-500 border-emerald-500 text-white",
  GOOD: "bg-sky-500 border-sky-500 text-white",
  AVERAGE: "bg-amber-500 border-amber-500 text-white",
  NEEDS_IMPROVEMENT: "bg-rose-500 border-rose-500 text-white",
};

interface Row { id: string; name: string; roll: number | null; rating: string; note: string }

export default function RemarksPage() {
  const [classes, setClasses] = useState<any[]>([]);
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [date, setDate] = useState(todayISO());
  const [rows, setRows] = useState<Row[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<any[]>("/api/classes").then(setClasses).finally(() => setLoading(false));
  }, []);

  const loadRoster = async () => {
    if (!classId || !date) return;
    setLoading(true);
    const data = await api<Row[]>(`/api/remarks?classId=${classId}&sectionId=${sectionId || undefined}&date=${date}`);
    setRows(data);
    setLoading(false);
  };

  useEffect(() => { if (classId) loadRoster(); }, [classId, sectionId]);

  const setRating = (id: string, rating: string) => setRows((r) => r.map((x) => (x.id === id ? { ...x, rating } : x)));
  const setNote = (id: string, note: string) => setRows((r) => r.map((x) => (x.id === id ? { ...x, note } : x)));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api("/api/remarks", {
        method: "POST",
        body: JSON.stringify({ date, rows: rows.map((r) => ({ studentId: r.id, rating: r.rating, note: r.note })) }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      loadRoster();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const cls = classes.find((c) => c.id === classId);
  const marked = rows.filter((r) => r.rating !== "UNMARKED").length;

  return (
    <div>
      <PageHeader
        title="Daily Remarks"
        subtitle={rows.length ? `${marked}/${rows.length} students rated` : "Select class and date to begin"}
        actions={
          <button className="btn btn-primary" onClick={save} disabled={saving || marked === 0}>
            {saved ? <Check size={15} /> : <Save size={15} />} {saved ? "Saved!" : saving ? "Saving…" : "Save remarks"}
          </button>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div>
            <label className="label">Class</label>
            <Select value={classId} onChange={(e) => { setClassId(e.target.value); setSectionId(""); }}>
              <option value="">Select…</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="label">Section</label>
            <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">All</option>
              {cls?.sections.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
          <div>
            <label className="label">Date</label>
            <input type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
          <div className="flex items-end">
            <button className="btn btn-secondary w-full" onClick={loadRoster}><MessageSquare size={15} /> Load roster</button>
          </div>
        </div>
      </Card>

      <Card>
        {loading ? (
          <LoadingScreen label="Loading roster…" />
        ) : rows.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Student</th>
                  <th className="th">Roll</th>
                  {RATINGS.map((r) => <th key={r} className="th text-center">{r.replace("_", " ")}</th>)}
                  <th className="th min-w-52">Optional note</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="tr-hover">
                    <td className="td">
                      <div className="flex items-center gap-3">
                        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-[10px] font-bold text-indigo-600">{initials(r.name)}</div>
                        <div className="font-bold text-slate-800">{r.name}</div>
                      </div>
                    </td>
                    <td className="td font-semibold">{r.roll ?? "—"}</td>
                    {RATINGS.map((rating) => (
                      <td key={rating} className="td text-center">
                        <button
                          onClick={() => setRating(r.id, rating)}
                          className={`h-8 w-8 rounded-full border-2 text-xs font-black transition ${r.rating === rating ? RATING_STYLES[rating] : "border-slate-200 text-slate-400 hover:border-slate-300"}`}
                          title={rating}
                        >
                          {rating === "EXCELLENT" ? "E" : rating === "GOOD" ? "G" : rating === "AVERAGE" ? "A" : "N"}
                        </button>
                      </td>
                    ))}
                    <td className="td">
                      <input
                        className="input !py-1.5 text-xs"
                        placeholder='e.g. "Completed all tasks"'
                        value={r.note}
                        onChange={(e) => setNote(r.id, e.target.value)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-14 text-center text-sm text-slate-400">
            <MessageSquare className="mx-auto mb-2 text-slate-300" size={30} />
            Select a class and date, then load the roster.
          </div>
        )}
      </Card>
    </div>
  );
}
