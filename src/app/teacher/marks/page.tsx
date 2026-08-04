"use client";

import { useEffect, useState } from "react";
import { Save, Check, FileText } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Select, PageHeader, LoadingScreen, ErrorNote } from "@/components/ui";
import { initials } from "@/lib/utils";

interface Exam { id: string; name: string; published: boolean; classRoom: { name: string }; section: { name: string } | null }
interface Subject { id: string; name: string }

export default function TeacherMarksPage() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [subjects, setSubjects] = useState<Subject[]>([]);
  const [examId, setExamId] = useState("");
  const [subjectId, setSubjectId] = useState("");
  const [students, setStudents] = useState<any[]>([]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    Promise.all([api<Exam[]>("/api/exams"), api<Subject[]>("/api/subjects")]).then(([e, s]) => { setExams(e); setSubjects(s); }).finally(() => setLoading(false));
  }, []);

  const loadRoster = async () => {
    if (!examId || !subjectId) return;
    setLoading(true);
    setError("");
    try {
      const detail = await api<any>(`/api/exams/${examId}`);
      setStudents(detail.students);
      const m: Record<string, string> = {};
      for (const s of detail.students) {
        const mk = s.bySubject?.[subjectId];
        if (mk) m[s.studentId] = String(mk.obtained);
      }
      setMarks(m);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { if (examId && subjectId) loadRoster(); }, [examId, subjectId]);

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await api("/api/marks", {
        method: "POST",
        body: JSON.stringify({
          examId,
          rows: students.map((s) => ({ studentId: s.studentId, subjectId, fullMarks: 100, obtained: marks[s.studentId] ?? "" })),
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

  const activeExam = exams.find((e) => e.id === examId);
  const entered = Object.values(marks).filter((v) => v !== "" && v !== undefined).length;

  if (loading && exams.length === 0) return <LoadingScreen />;

  return (
    <div>
      <PageHeader
        title="Marks Entry"
        subtitle={students.length ? `${entered}/${students.length} students entered for ${subjects.find((s) => s.id === subjectId)?.name}` : "Select exam and subject"}
        actions={
          <button className="btn btn-primary" onClick={save} disabled={saving || !students.length || entered === 0 || activeExam?.published}>
            {saved ? <Check size={15} /> : <Save size={15} />} {saved ? "Saved!" : saving ? "Saving…" : "Save marks"}
          </button>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="label">Exam</label>
            <Select value={examId} onChange={(e) => setExamId(e.target.value)}>
              <option value="">Select exam…</option>
              {exams.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.classRoom.name}{e.published ? " (published)" : ""}</option>)}
            </Select>
          </div>
          <div>
            <label className="label">Subject</label>
            <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)}>
              <option value="">Select subject…</option>
              {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
          </div>
          <div className="flex items-end">
            <button className="btn btn-secondary w-full" onClick={loadRoster}><FileText size={15} /> Load students</button>
          </div>
        </div>
        {activeExam?.published && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
            ⚠ This exam is published — marks are locked. Unpublish it from the Exams module to edit.
          </p>
        )}
      </Card>

      <Card>
        {loading ? (
          <LoadingScreen label="Loading students…" />
        ) : students.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Student</th>
                  <th className="th">Roll</th>
                  <th className="th w-40 text-center">Marks (out of 100)</th>
                  <th className="th text-center">Grade</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => {
                  const val = marks[s.studentId] ?? "";
                  const num = Number(val);
                  const grade = !isNaN(num) && val !== "" ? (num >= 80 ? "A+" : num >= 70 ? "A" : num >= 60 ? "A-" : num >= 50 ? "B" : num >= 40 ? "C" : num >= 33 ? "D" : "F") : "—";
                  return (
                    <tr key={s.studentId} className="tr-hover">
                      <td className="td">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-[10px] font-bold text-indigo-600">{initials(s.name)}</div>
                          <div className="font-bold text-slate-800">{s.name}</div>
                        </div>
                      </td>
                      <td className="td font-semibold">{s.roll ?? "—"}</td>
                      <td className="td">
                        <input
                          className="input !w-28 !px-2 text-center"
                          type="number"
                          min={0}
                          max={100}
                          value={val}
                          placeholder="–"
                          onChange={(e) => setMarks((m) => ({ ...m, [s.studentId]: e.target.value }))}
                          disabled={activeExam?.published}
                        />
                      </td>
                      <td className="td text-center">
                        <span className={`badge ring-1 ring-inset ${grade === "F" ? "bg-rose-50 text-rose-700 ring-rose-600/20" : grade === "—" ? "bg-slate-100 text-slate-500 ring-slate-500/20" : "bg-emerald-50 text-emerald-700 ring-emerald-600/20"}`}>
                          {grade}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="py-14 text-center text-sm text-slate-400">
            <FileText className="mx-auto mb-2 text-slate-300" size={30} />
            Select an exam and subject, then load students.
          </div>
        )}
      </Card>
    </div>
  );
}
