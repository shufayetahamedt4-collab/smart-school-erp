"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Save, Check, FileText, Award } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Select, PageHeader, LoadingScreen, ErrorNote } from "@/components/ui";
import { initials } from "@/lib/utils";
import { gradeForScheme, type GradingScheme } from "@/lib/grading";

interface Exam {
  id: string;
  name: string;
  published: boolean;
  classRoom: { name: string };
  section: { name: string } | null;
}

interface Column {
  id: string;
  name: string;
  fullMarks: number;
}

/**
 * Teacher marks entry — one exam, one of ITS subjects at a time.
 *
 * The subject list IS the exam's own sheet (set on the exam page), and each
 * subject carries its own full marks, so a project column out of 50 is marked
 * out of 50 rather than silently out of 100. Grades shown while typing come
 * from the school's grading scheme, the same scale the report card prints.
 */
export default function TeacherMarksPage() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [examId, setExamId] = useState("");
  const [columns, setColumns] = useState<Column[]>([]);
  const [scheme, setScheme] = useState<GradingScheme | null>(null);
  const [subjectId, setSubjectId] = useState("");
  const [students, setStudents] = useState<any[]>([]);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [sheetLoading, setSheetLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api<Exam[]>("/api/exams")
      .then(setExams)
      .catch((e: any) => setError(e?.message || "Could not load exams"))
      .finally(() => setLoading(false));
  }, []);

  const column = columns.find((c) => c.id === subjectId);
  const fullMarks = column?.fullMarks ?? 100;

  /** Load the exam's sheet + roster; pick the first column if none is chosen. */
  const loadExam = async (id: string) => {
    if (!id) {
      setColumns([]);
      setStudents([]);
      setSubjectId("");
      return;
    }
    setSheetLoading(true);
    setError("");
    try {
      const detail = await api<any>(`/api/exams/${id}`);
      const cols: Column[] = detail.subjects || [];
      setColumns(cols);
      setScheme(detail.scheme ?? null);
      setStudents(detail.students || []);
      setSubjectId((prev) => (cols.some((c) => c.id === prev) ? prev : cols[0]?.id || ""));
      const m: Record<string, string> = {};
      for (const s of detail.students || []) {
        for (const mk of s.marks) m[`${s.studentId}|${mk.subjectId}`] = String(mk.obtained);
      }
      setMarks(m);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSheetLoading(false);
    }
  };

  /**
   * Deep link from the Results screen ("Open sheet"): land on that exam's
   * sheet instead of an empty picker. The query string is read on the client
   * so this screen keeps prerendering as static content.
   */
  useEffect(() => {
    if (!exams.length) return;
    const wanted = new URLSearchParams(window.location.search).get("examId");
    if (!wanted || !exams.some((e) => e.id === wanted)) return;
    setExamId(wanted);
    loadExam(wanted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exams]);

  const save = async () => {
    if (!subjectId) return;
    setSaving(true);
    setError("");
    try {
      await api("/api/marks", {
        method: "POST",
        body: JSON.stringify({
          examId,
          rows: students.map((s) => ({
            studentId: s.studentId,
            subjectId,
            fullMarks,
            obtained: marks[`${s.studentId}|${subjectId}`] ?? "",
          })),
        }),
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      await loadExam(examId);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const activeExam = exams.find((e) => e.id === examId);
  const locked = !!activeExam?.published;
  const entered = students.filter((s) => {
    const v = marks[`${s.studentId}|${subjectId}`];
    return v !== undefined && v !== "";
  }).length;

  if (loading && exams.length === 0) return <LoadingScreen />;

  return (
    <div>
      <PageHeader
        title="Marks Entry"
        subtitle={
          column
            ? `${entered}/${students.length} students entered for ${column.name} (out of ${fullMarks})`
            : "Select an exam to load its subject sheet"
        }
        actions={
          <button className="btn btn-primary" onClick={save} disabled={saving || !students.length || entered === 0 || locked}>
            {saved ? <Check size={15} /> : <Save size={15} />} {saved ? "Saved!" : saving ? "Saving…" : "Save marks"}
          </button>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="sm:col-span-2">
            <label className="label">Exam</label>
            <Select value={examId} onChange={(e) => { setExamId(e.target.value); loadExam(e.target.value); }}>
              <option value="">Select exam…</option>
              {exams.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name} — {e.classRoom.name}{e.published ? " (published)" : ""}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <label className="label">Subject</label>
            <Select value={subjectId} onChange={(e) => setSubjectId(e.target.value)} disabled={!columns.length}>
              {columns.map((c) => (
                <option key={c.id} value={c.id}>{c.name} (out of {c.fullMarks})</option>
              ))}
            </Select>
          </div>
          <div className="flex items-end">
            <Link href="/teacher/grades" className="btn btn-secondary w-full">
              <Award size={15} /> Grading &amp; GPA
            </Link>
          </div>
        </div>
        {activeExam?.published && (
          <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-700">
            ⚠ This exam is published — marks are locked. Unpublish it from the Exams module to edit.
          </p>
        )}
        {scheme && columns.length > 0 && (
          <p className="mt-3 text-xs text-slate-400">
            Graded with the <span className="font-semibold text-slate-500">{scheme.name}</span> scale · pass mark{" "}
            {scheme.passPercent}% · GPA out of {scheme.gpaScale.toFixed(2)}
          </p>
        )}
      </Card>

      <Card>
        {sheetLoading ? (
          <LoadingScreen label="Loading the exam sheet…" />
        ) : students.length && column ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Student</th>
                  <th className="th">Roll</th>
                  <th className="th w-40 text-center">Marks (out of {fullMarks})</th>
                  <th className="th text-center">Grade</th>
                  <th className="th text-center">GPA</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => {
                  const val = marks[`${s.studentId}|${subjectId}`] ?? "";
                  const num = Number(val);
                  const enteredRow = val !== "" && Number.isFinite(num);
                  const res = enteredRow && scheme ? gradeForScheme(scheme, num, fullMarks) : null;
                  return (
                    <tr key={s.studentId} className="tr-hover">
                      <td className="td">
                        <div className="flex items-center gap-3">
                          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-indigo-50 text-[10px] font-bold text-indigo-600">
                            {initials(s.name)}
                          </div>
                          <div className="font-bold text-slate-800">{s.name}</div>
                        </div>
                      </td>
                      <td className="td font-semibold">{s.roll ?? "—"}</td>
                      <td className="td">
                        <input
                          className={`input !w-28 !px-2 text-center ${res && !res.pass ? "border-rose-300 text-rose-700" : ""}`}
                          type="number"
                          min={0}
                          max={fullMarks}
                          value={val}
                          placeholder="–"
                          onChange={(e) => setMarks((m) => ({ ...m, [`${s.studentId}|${subjectId}`]: e.target.value }))}
                          disabled={locked}
                        />
                      </td>
                      <td className="td text-center">
                        <span
                          className={`badge ring-1 ring-inset ${
                            !res
                              ? "bg-slate-100 text-slate-500 ring-slate-500/20"
                              : res.pass
                                ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                                : "bg-rose-50 text-rose-700 ring-rose-600/20"
                          }`}
                        >
                          {res ? res.grade : "—"}
                        </span>
                      </td>
                      <td className="td text-center font-semibold text-slate-600">
                        {res ? res.gpa.toFixed(2) : "—"}
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
            Select an exam to load its subject sheet.
          </div>
        )}
      </Card>
    </div>
  );
}
