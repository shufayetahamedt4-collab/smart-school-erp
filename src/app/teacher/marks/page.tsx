"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Save, Check, FileText, Award } from "lucide-react";
import { api } from "@/lib/client";
import { Select, LoadingScreen, ErrorNote } from "@/components/ui";
import { Surface, EmptyState } from "@/components/app-ui";
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
    <div className="ss-markspage">
      {/* header strip — the app bar owns the title; this carries the count and Save */}
      <div className="mb-3 flex items-center justify-between gap-3 px-1">
        <p className="min-w-0 text-[12px] font-semibold text-slate-500">
          {column
            ? `${entered}/${students.length} students entered for ${column.name} (out of ${fullMarks})`
            : "Select an exam to load its subject sheet"}
        </p>
        <button className="btn btn-primary btn-sm min-h-11 shrink-0" onClick={save} disabled={saving || !students.length || entered === 0 || locked}>
          {saved ? <Check size={15} /> : <Save size={15} />} {saved ? "Saved!" : saving ? "Saving…" : "Save marks"}
        </button>
      </div>

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Surface>
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
      </Surface>

      <div className="mt-4">
        {sheetLoading ? (
          <LoadingScreen label="Loading the exam sheet…" />
        ) : students.length && column ? (
          <ul className="divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-900/5">
            {students.map((s) => {
              const val = marks[`${s.studentId}|${subjectId}`] ?? "";
              const num = Number(val);
              const enteredRow = val !== "" && Number.isFinite(num);
              const res = enteredRow && scheme ? gradeForScheme(scheme, num, fullMarks) : null;
              return (
                <li key={s.studentId} className="ss-marks-row px-3.5 py-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-[11px] font-bold text-indigo-600">
                      {initials(s.name)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[14px] font-bold leading-snug text-slate-800">{s.name}</div>
                      <div className="mt-0.5 text-[11px] text-slate-400">Roll {s.roll ?? "—"}</div>
                    </div>
                    <span
                      className={`badge shrink-0 ring-1 ring-inset ${
                        !res
                          ? "bg-slate-100 text-slate-500 ring-slate-500/20"
                          : res.pass
                            ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                            : "bg-rose-50 text-rose-700 ring-rose-600/20"
                      }`}
                    >
                      {res ? res.grade : "—"}
                    </span>
                  </div>
                  <div className="mt-2.5 flex items-end gap-3">
                    <label className="min-w-0 flex-1">
                      <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.06em] text-slate-400">
                        Marks (out of {fullMarks})
                      </span>
                      <input
                        className={`input min-h-11 w-full text-center ${res && !res.pass ? "border-rose-300 text-rose-700" : ""}`}
                        type="number"
                        min={0}
                        max={fullMarks}
                        value={val}
                        placeholder="–"
                        onChange={(e) => setMarks((m) => ({ ...m, [`${s.studentId}|${subjectId}`]: e.target.value }))}
                        disabled={locked}
                      />
                    </label>
                    <div className="flex w-14 shrink-0 flex-col items-center">
                      <span className="text-[10px] font-bold uppercase tracking-[0.06em] text-slate-400">GPA</span>
                      <span className="text-sm font-bold text-slate-600">{res ? res.gpa.toFixed(2) : "—"}</span>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState
            icon={FileText}
            title="No sheet loaded"
            hint="Select an exam to load its subject sheet."
          />
        )}
      </div>
    </div>
  );
}
