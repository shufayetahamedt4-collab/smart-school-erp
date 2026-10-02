"use client";

import { useEffect, useState } from "react";
import { MessageSquare, Save, Check } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Select, LoadingScreen, ErrorNote } from "@/components/ui";
import { Surface, EmptyState } from "@/components/app-ui";
import { todayISO, initials } from "@/lib/utils";

const RATINGS = ["EXCELLENT", "GOOD", "AVERAGE", "NEEDS_IMPROVEMENT"];
const RATING_STYLES: Record<string, string> = {
  EXCELLENT: "bg-emerald-500 border-emerald-500 text-white",
  GOOD: "bg-sky-500 border-sky-500 text-white",
  AVERAGE: "bg-amber-500 border-amber-500 text-white",
  NEEDS_IMPROVEMENT: "bg-rose-500 border-rose-500 text-white",
};

/**
 * Readable names for the rating controls, shown as each control's accessible
 * name: the roster is a stack of cards, so the single-letter buttons need
 * naming. Presentation only — the values POSTed to the server are the RATINGS
 * above, unchanged.
 */
const RATING_LABELS: Record<string, string> = {
  EXCELLENT: "Excellent",
  GOOD: "Good",
  AVERAGE: "Average",
  NEEDS_IMPROVEMENT: "Needs improvement",
};

const RATING_GLYPH: Record<string, string> = {
  EXCELLENT: "E",
  GOOD: "G",
  AVERAGE: "A",
  NEEDS_IMPROVEMENT: "N",
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
    // qs() drops the section filter entirely when "All" is selected — the old
    // template literal sent the literal string "sectionId=undefined", which
    // the server (rightly) treated as a section named "undefined": zero rows,
    // an empty sheet until a section was hand-picked.
    const data = await api<Row[]>(`/api/remarks${qs({ classId, sectionId: sectionId || undefined, date })}`);
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
    <div className="ss-rmkpage">
      {/* header strip — the app bar owns the title; this carries the count and Save */}
      <div className="mb-3 flex items-center justify-between gap-3 px-1">
        <p className="min-w-0 text-[12px] font-semibold text-slate-500">
          {rows.length ? `${marked}/${rows.length} students rated` : "Select class and date to begin"}
        </p>
        <button className="btn btn-primary btn-sm min-h-11 shrink-0" onClick={save} disabled={saving || marked === 0}>
          {saved ? <Check size={15} /> : <Save size={15} />} {saved ? "Saved!" : saving ? "Saving…" : "Save remarks"}
        </button>
      </div>

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Surface>
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
      </Surface>

      <div className="mt-4">
        {loading ? (
          <LoadingScreen label="Loading roster…" />
        ) : rows.length ? (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-900/5">
            {rows.map((r) => (
              <li key={r.id} className="ss-rmk-row px-3.5 py-3">
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-[11px] font-bold text-indigo-600">{initials(r.name)}</div>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-bold leading-snug text-slate-800">{r.name}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">Roll {r.roll ?? "—"}</div>
                  </div>
                </div>
                <div className="mt-2.5 grid grid-cols-4 gap-1.5" role="group" aria-label={`Rating for ${r.name}`}>
                  {RATINGS.map((rating) => (
                    <button
                      key={rating}
                      onClick={() => setRating(r.id, rating)}
                      aria-pressed={r.rating === rating}
                      aria-label={RATING_LABELS[rating]}
                      title={RATING_LABELS[rating]}
                      className={`min-h-11 rounded-xl border-2 text-[13px] font-black transition ${r.rating === rating ? RATING_STYLES[rating] : "border-slate-200 text-slate-400 hover:border-slate-300"}`}
                    >
                      {RATING_GLYPH[rating]}
                    </button>
                  ))}
                </div>
                <input
                  className="input mt-2.5 min-h-11 text-xs"
                  placeholder='e.g. "Completed all tasks"'
                  aria-label={`Note for ${r.name}`}
                  value={r.note}
                  onChange={(e) => setNote(r.id, e.target.value)}
                />
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={MessageSquare}
            title="No roster loaded"
            hint="Select a class and date, then load the roster."
          />
        )}
      </div>
    </div>
  );
}
