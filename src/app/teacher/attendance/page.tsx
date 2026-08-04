"use client";

import { useEffect, useState } from "react";
import { ClipboardList, Save, Check } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Select, PageHeader, LoadingScreen, ErrorNote } from "@/components/ui";
import { todayISO, initials } from "@/lib/utils";

const STATUSES = ["PRESENT", "ABSENT", "LATE", "LEAVE"];

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
    const data = await api<RosterRow[]>(`/api/attendance?classId=${classId}&sectionId=${sectionId || undefined}&date=${date}`);
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
    <div>
      <PageHeader
        title="Attendance"
        subtitle={rows.length ? `${marked}/${rows.length} students marked` : "Select class and date to begin"}
        actions={
          <button className="btn btn-primary" onClick={save} disabled={saving || !rows.length || marked === 0}>
            {saved ? <Check size={15} /> : <Save size={15} />} {saved ? "Saved!" : saving ? "Saving…" : "Save attendance"}
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
            <button className="btn btn-secondary w-full" onClick={loadRoster}><ClipboardList size={15} /> Load roster</button>
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
                  <th className="th text-center">Present</th>
                  <th className="th text-center">Absent</th>
                  <th className="th text-center">Late</th>
                  <th className="th text-center">Leave</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="tr-hover">
                    <td className="td">
                      <div className="flex items-center gap-3">
                        {r.photoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={r.photoUrl} alt="" className="h-8 w-8 rounded-lg object-cover" />
                        ) : (
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-[10px] font-bold text-indigo-600">{initials(r.name)}</div>
                        )}
                        <div>
                          <div className="font-bold text-slate-800">{r.name}</div>
                          <div className="text-[11px] text-slate-400">{r.admissionNo}</div>
                        </div>
                      </div>
                    </td>
                    <td className="td font-semibold">{r.roll ?? "—"}</td>
                    {STATUSES.map((s) => (
                      <td key={s} className="td text-center">
                        <button
                          onClick={() => setStatus(r.id, s)}
                          className={`h-9 w-9 rounded-full border-2 text-xs font-black transition ${
                            r.status === s
                              ? s === "PRESENT" ? "border-emerald-500 bg-emerald-500 text-white"
                                : s === "ABSENT" ? "border-rose-500 bg-rose-500 text-white"
                                : s === "LATE" ? "border-amber-500 bg-amber-500 text-white"
                                : "border-sky-500 bg-sky-500 text-white"
                              : "border-slate-200 text-slate-400 hover:border-slate-300"
                          }`}
                        >
                          {s[0]}
                        </button>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-14 text-center text-sm text-slate-400">
            <ClipboardList className="mx-auto mb-2 text-slate-300" size={30} />
            Select a class and date, then load the roster.
          </div>
        )}
      </Card>
    </div>
  );
}
