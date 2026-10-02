"use client";

import { useEffect, useState } from "react";
import { ClipboardList, Save, Check } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Select, LoadingScreen, ErrorNote } from "@/components/ui";
import { Surface, EmptyState } from "@/components/app-ui";
import { todayISO, initials } from "@/lib/utils";

const STATUSES = ["PRESENT", "ABSENT", "LATE", "LEAVE"];

/**
 * The status names, shown on each student's own control: the roster is a stack
 * of cards, so the buttons need naming. Presentation only — the values POSTed to
 * the server are the STATUSES above, unchanged.
 */
const STATUS_LABELS: Record<string, string> = { PRESENT: "Present", ABSENT: "Absent", LATE: "Late", LEAVE: "Leave" };

/** The fill each status takes when chosen — the same four tones as before. */
const STATUS_TONE: Record<string, string> = {
  PRESENT: "border-emerald-500 bg-emerald-500 text-white",
  ABSENT: "border-rose-500 bg-rose-500 text-white",
  LATE: "border-amber-500 bg-amber-500 text-white",
  LEAVE: "border-sky-500 bg-sky-500 text-white",
};

interface RosterRow { id: string; name: string; roll: number | null; admissionNo: string; photoUrl: string | null; status: string; remark: string }

export default function AttendancePage() {
  const [classes, setClasses] = useState<any[]>([]);
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");
  const [date, setDate] = useState(todayISO());
  const [rows, setRows] = useState<RosterRow[]>([]);
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
    // qs() drops empty params — "All" must not send sectionId=undefined
    const data = await api<RosterRow[]>(`/api/attendance${qs({ classId, sectionId: sectionId || undefined, date })}`);
    setRows(data);
    setLoading(false);
  };

  useEffect(() => { if (classId) loadRoster(); }, [classId, sectionId]);

  const setStatus = (id: string, status: string) => setRows((r) => r.map((x) => (x.id === id ? { ...x, status } : x)));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const res = await api<{ count: number }>("/api/attendance", {
        method: "POST",
        body: JSON.stringify({
          date,
          classId,
          // sectionId: only a real id — undefined keys are dropped by
          // JSON.stringify, so the server never sees the string "undefined".
          rows: rows.map((r) => ({ studentId: r.id, classId, sectionId: sectionId || undefined, status: r.status, remark: r.remark })),
        }),
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
  const marked = rows.filter((r) => r.status !== "UNMARKED").length;

  return (
    <div className="ss-attpage">
      {/* header strip — the app bar owns the title; this carries the count and Save */}
      <div className="mb-3 flex items-center justify-between gap-3 px-1">
        <p className="min-w-0 text-[12px] font-semibold text-slate-500">
          {rows.length ? `${marked}/${rows.length} students marked` : "Select class and date to begin"}
        </p>
        <button className="btn btn-primary btn-sm min-h-11 shrink-0" onClick={save} disabled={saving || !rows.length || marked === 0}>
          {saved ? <Check size={15} /> : <Save size={15} />} {saved ? "Saved!" : saving ? "Saving…" : "Save attendance"}
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
            <button className="btn btn-secondary w-full" onClick={loadRoster}><ClipboardList size={15} /> Load roster</button>
          </div>
        </div>
      </Surface>

      <div className="mt-4">
        {loading ? (
          <LoadingScreen label="Loading roster…" />
        ) : rows.length ? (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-900/5">
            {rows.map((r) => (
              <li key={r.id} className="ss-att-row px-3.5 py-3">
                <div className="flex items-center gap-3">
                  {r.photoUrl ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={r.photoUrl} alt="" className="h-10 w-10 shrink-0 rounded-xl object-cover" />
                  ) : (
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-[11px] font-bold text-indigo-600">{initials(r.name)}</div>
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[14px] font-bold leading-snug text-slate-800">{r.name}</div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{r.admissionNo} · Roll {r.roll ?? "—"}</div>
                  </div>
                </div>
                <div className="mt-2.5 grid grid-cols-4 gap-1.5" role="group" aria-label={`Attendance for ${r.name}`}>
                  {STATUSES.map((s) => (
                    <button
                      key={s}
                      onClick={() => setStatus(r.id, s)}
                      aria-pressed={r.status === s}
                      className={`min-h-11 rounded-xl border-2 text-[11px] font-bold transition ${
                        r.status === s ? STATUS_TONE[s] : "border-slate-200 text-slate-400 hover:border-slate-300"
                      }`}
                    >
                      {STATUS_LABELS[s]}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState
            icon={ClipboardList}
            title="No roster loaded"
            hint="Select a class and date, then load the roster."
          />
        )}
      </div>
    </div>
  );
}
