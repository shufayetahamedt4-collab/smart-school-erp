"use client";

import { use, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Save, Check, Send, FileText, FileSpreadsheet, Plus, Trash2, Award, TriangleAlert, ListChecks, ClipboardList } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen, ErrorNote } from "@/components/ui";
import { fmtDate } from "@/lib/utils";
import { gpaOfScheme, gradeForScheme, validateColumns, type GradingScheme } from "@/lib/grading";

interface Column {
  subjectId: string;
  fullMarks: number;
}

/**
 * One exam: the marks sheet it covers, and the marks themselves.
 *
 * The columns are editable (add a subject, set what it is out of, drop one),
 * which is what lets an exam be five subjects out of 100 plus a project out of
 * 50 instead of "every subject, always out of 100". Every letter and grade
 * point shown here comes from the school's grading scheme, so editing the
 * scale re-grades this sheet immediately (see /dashboard/grades).
 */
export default function ExamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // ---- columns editor ----
  const [draft, setDraft] = useState<Column[] | null>(null);
  const [savingColumns, setSavingColumns] = useState(false);
  const [columnsError, setColumnsError] = useState("");
  const [columnsNotice, setColumnsNotice] = useState("");

  const load = () =>
    api<any>(`/api/exams/${id}`)
      .then((d) => {
        setData(d);
        const m: Record<string, string> = {};
        for (const s of d.students) {
          for (const mk of s.marks) m[`${s.studentId}|${mk.subjectId}`] = String(mk.obtained);
        }
        setMarks(m);
        setDraft(
          Array.isArray(d.exam?.columns) && d.exam.columns.length
            ? d.exam.columns.map((c: any) => ({ subjectId: String(c.subjectId), fullMarks: Number(c.fullMarks) || 100 }))
            : (d.subjects as any[]).map((s) => ({ subjectId: s.id, fullMarks: s.fullMarks }))
        );
      })
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Declared ABOVE the early returns on purpose: a hook that only runs once the
  // exam has loaded changes the hook count between renders, which React rejects
  // outright ("Rendered more hooks than during the previous render").
  const columnDirty = useMemo(() => {
    if (!draft) return false;
    const saved: { id: string; fullMarks: number }[] = data?.subjects || [];
    const current = saved.map((s) => `${s.id}:${s.fullMarks}`).join("|");
    return current !== draft.map((c) => `${c.subjectId}:${c.fullMarks}`).join("|");
  }, [draft, data]);

  if (loading) return <LoadingScreen label="Loading exam…" />;
  if (!data) return <div className="p-10 text-center">Exam not found</div>;

  const { exam, subjects, allSubjects, scheme, students } = data as {
    exam: any;
    subjects: { id: string; name: string; fullMarks: number }[];
    allSubjects: { id: string; name: string }[];
    columnsDeclared: boolean;
    scheme: GradingScheme;
    students: any[];
  };
  const locked = !!exam.published;

  const setMark = (studentId: string, subjectId: string, val: string) => {
    const v = val.replace(/[^\d.]/g, "");
    setMarks((m) => ({ ...m, [`${studentId}|${subjectId}`]: v }));
  };

  const saveMarks = async () => {
    setSaving(true);
    setError("");
    try {
      const rows = students.flatMap((s: any) =>
        subjects.map((sub) => ({
          studentId: s.studentId,
          subjectId: sub.id,
          fullMarks: sub.fullMarks,
          obtained: marks[`${s.studentId}|${sub.id}`] ?? "",
        }))
      );
      await api("/api/marks", { method: "POST", body: JSON.stringify({ examId: id, rows }) });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const togglePublish = async () => {
    await api(`/api/exams/${id}`, { method: "PATCH", body: JSON.stringify({ published: !exam.published }) });
    load();
  };

  // ---- columns ----
  const columnsCheck = draft ? validateColumns(draft, allSubjects || []) : null;
  const columnsProblem = columnsCheck && !columnsCheck.ok ? columnsCheck.error : "";
  const marksForSubject = (subjectId: string) =>
    students.reduce((n: number, s: any) => n + (s.marks.some((m: any) => m.subjectId === subjectId) ? 1 : 0), 0);

  /**
   * Marks the server will clear, mirroring its rule exactly: a mark goes when
   * its column is removed, or when the column is now out of a different total
   * (85 out of 100 is not 85 out of 50).
   */
  const marksToClear = (next: Column[]) => {
    const newFull = new Map(next.map((c) => [c.subjectId, c.fullMarks]));
    return students.reduce(
      (n: number, s: any) =>
        n +
        s.marks.filter((m: any) => {
          const keep = newFull.get(String(m.subjectId));
          return keep === undefined || Number(m.fullMarks) !== keep;
        }).length,
      0
    );
  };

  const saveColumns = async () => {
    if (!draft || columnsProblem) return;
    const clearing = marksToClear(draft);
    if (
      clearing > 0 &&
      !confirm(
        `${clearing} saved mark(s) will be deleted — removing a column, or changing what it is out of, invalidates the marks already entered for it.\n\nContinue?`
      )
    ) {
      return;
    }
    setSavingColumns(true);
    setColumnsError("");
    setColumnsNotice("");
    try {
      const res = await api<{ clearedMarks: number }>(`/api/exams/${id}/columns`, {
        method: "PATCH",
        body: JSON.stringify({ columns: draft }),
      });
      setColumnsNotice(
        res.clearedMarks > 0
          ? `Columns saved — ${res.clearedMarks} mark(s) were cleared because their column was removed or changed.`
          : "Columns saved."
      );
      await load();
    } catch (e: any) {
      setColumnsError(e.message);
    } finally {
      setSavingColumns(false);
    }
  };

  const addColumn = () => {
    const used = new Set((draft || []).map((c) => c.subjectId));
    const next = (allSubjects || []).find((s) => !used.has(s.id));
    if (!next) return;
    setDraft((d) => [...(d || []), { subjectId: next.id, fullMarks: 100 }]);
  };

  /** Live per-student view of what has been typed, graded by the school scheme. */
  const liveRow = (studentId: string) => {
    const results = subjects.map((sub) => {
      const raw = marks[`${studentId}|${sub.id}`];
      if (raw === undefined || raw === "") return null;
      const n = Number(raw);
      if (!Number.isFinite(n)) return null;
      return gradeForScheme(scheme, n, sub.fullMarks);
    });
    const entered = results.filter(Boolean) as { grade: string; gpa: number; pass: boolean }[];
    return {
      gpa: entered.length ? gpaOfScheme(scheme, entered.map((r) => r.gpa)) : 0,
      fails: entered.filter((r) => !r.pass).length,
    };
  };

  return (
    <div className="ss-examdetailpage">
      <PageHeader
        icon={FileText}
        title={exam.name}
        subtitle={`${exam.classRoom.name}${exam.section ? ` · Section ${exam.section.name}` : ""} · ${exam.year} · ${fmtDate(exam.startDate)} → ${fmtDate(exam.endDate)}`}
        actions={
          <>
            <Link href="/dashboard/exams" className="btn btn-secondary btn-sm ss-exam-back"><ArrowLeft size={14} /> Exams</Link>
            <button onClick={saveMarks} disabled={saving || locked} className="btn btn-primary btn-sm ss-exam-save">
              {saved ? <Check size={14} /> : <Save size={14} />} {saved ? "Saved!" : saving ? "Saving…" : "Save marks"}
            </button>
            <button onClick={togglePublish} className={`btn btn-sm ss-exam-publish ${exam.published ? "btn-secondary" : "btn-primary"}`}>
              <Send size={14} /> {exam.published ? "Unpublish" : "Publish results"}
            </button>
          </>
        }
      />

      {error && <div className="ss-exam-error mb-4"><ErrorNote message={error} /></div>}

      {exam.published ? (
        <div className="ss-exam-banner ss-exam-banner-published mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          ✅ Results are <b>published</b> — guardians can now see this exam. Marks and columns are locked until unpublished.
        </div>
      ) : (
        <div className="ss-exam-banner ss-exam-banner-draft mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          ⏳ Draft mode — set the columns below, enter marks, then publish so guardians can view results.
        </div>
      )}

      {/* ---------------- subject columns ---------------- */}
      <Card className="ss-exam-section ss-es-columns mb-4">
        <CardHeader
          title={<><span className="ss-exam-section-icon"><ListChecks size={15} /></span>Subject columns</>}
          subtitle="Which subjects this exam is marked on, and what each is out of"
          action={
            <div className="ss-exam-columns-actions flex items-center gap-2">
              <Link href="/dashboard/grades" className="btn btn-ghost btn-sm ss-exam-grades-link">
                <Award size={14} /> Grading &amp; GPA
              </Link>
              <button className="btn btn-secondary btn-sm ss-exam-addcol" onClick={addColumn} disabled={locked || !draft}>
                <Plus size={14} /> Add column
              </button>
              <button
                className="btn btn-primary btn-sm ss-exam-savecol"
                onClick={saveColumns}
                disabled={locked || savingColumns || !!columnsProblem || !columnDirty}
              >
                {savingColumns ? "Saving…" : "Save columns"}
              </button>
            </div>
          }
        />

        <div className="ss-exam-section-body space-y-3 p-5">
          {!draft?.length && <p className="ss-exam-col-empty text-sm text-slate-400">Add at least one subject column.</p>}
          <div className="ss-exam-cols">
          {(draft || []).map((col, i) => {
            const used = new Set((draft || []).filter((_, j) => j !== i).map((c) => c.subjectId));
            return (
              <div key={i} className="ss-exam-column flex flex-wrap items-end gap-3 rounded-xl border border-slate-100 bg-slate-50/50 p-3">
                <div className="ss-exam-col-field ss-exam-col-subject min-w-52 flex-1">
                  <label className="label ss-exam-label">Subject</label>
                  <select
                    className="ss-exam-select input"
                    value={col.subjectId}
                    disabled={locked}
                    onChange={(e) =>
                      setDraft((d) => (d ? d.map((c, j) => (j === i ? { ...c, subjectId: e.target.value } : c)) : d))
                    }
                  >
                    {(allSubjects || [])
                      .filter((s) => !used.has(s.id))
                      .map((s) => (
                        <option key={s.id} value={s.id}>{s.name}</option>
                      ))}
                  </select>
                </div>
                <div className="ss-exam-col-field w-32">
                  <label className="label ss-exam-label">Full marks</label>
                  <input
                    className="ss-exam-fullmarks input"
                    type="number"
                    min={0.5}
                    max={1000}
                    step="1"
                    value={col.fullMarks}
                    disabled={locked}
                    onChange={(e) =>
                      setDraft((d) =>
                        d ? d.map((c, j) => (j === i ? { ...c, fullMarks: e.target.value === "" ? 0 : Number(e.target.value) } : c)) : d
                      )
                    }
                  />
                </div>
                {marksForSubject(col.subjectId) > 0 && (
                  <Badge tone="slate" className="ss-exam-col-badge">{marksForSubject(col.subjectId)} marks entered</Badge>
                )}
                <button
                  onClick={() => setDraft((d) => (d ? d.filter((_, j) => j !== i) : d))}
                  disabled={locked}
                  className="ss-exam-col-del rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600 disabled:opacity-40"
                  title="Remove this column"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })}
          </div>

          {columnsProblem && (
            <p className="ss-exam-problem flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs font-semibold text-amber-800">
              <TriangleAlert size={14} /> {columnsProblem}
            </p>
          )}
          {columnsError && <div className="ss-exam-note"><ErrorNote message={columnsError} /></div>}
          {columnsNotice && (
            <p className="ss-exam-notice rounded-lg bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700">{columnsNotice}</p>
          )}
          <p className="ss-exam-footnote text-xs text-slate-400">
            Removing a column also deletes the marks entered for it, so totals and positions stay correct. Grades are
            computed with the <Link href="/dashboard/grades" className="font-semibold text-indigo-600 hover:underline">{scheme.name}</Link> scale
            ({scheme.gpaScale.toFixed(2)} GPA{scheme.failCapsGpa ? ", a failure caps the GPA at 0" : ""}).
          </p>
        </div>
      </Card>

      {/* ---------------- marks ---------------- */}
      <Card className="ss-exam-section ss-es-marks overflow-hidden">
        <CardHeader
          title={<><span className="ss-exam-section-icon"><ClipboardList size={15} /></span>Marks entry</>}
          subtitle={`${students.length} students × ${subjects.length} columns · pass mark ${scheme.passPercent}%`}
        />
        <div className="ss-exam-scroll overflow-x-auto">
          <table className="ss-exam-table w-full">
            <thead>
              <tr className="ss-exam-thead bg-slate-50">
                <th className="th ss-exam-th-pin min-w-52">Student</th>
                {subjects.map((s) => (
                  <th key={s.id} className="th ss-exam-th min-w-24 text-center">
                    {s.name}
                    <div className="ss-exam-th-sub text-[10px] font-normal normal-case text-slate-400">out of {s.fullMarks}</div>
                  </th>
                ))}
                <th className="th ss-exam-th text-center">GPA</th>
                <th className="th ss-exam-th text-center">Pos.</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s: any) => {
                const live = liveRow(s.studentId);
                return (
                  <tr key={s.studentId} className="ss-exam-row tr-hover">
                    <td className="td ss-exam-student-cell">
                      <div className="ss-exam-student font-bold text-slate-800">{s.name}</div>
                      <div className="ss-exam-roll text-xs text-slate-400">Roll {s.roll ?? "—"} · {s.admissionNo}</div>
                    </td>
                    {subjects.map((sub) => {
                      const raw = marks[`${s.studentId}|${sub.id}`] ?? "";
                      const num = Number(raw);
                      const entered = raw !== "" && Number.isFinite(num);
                      const res = entered ? gradeForScheme(scheme, num, sub.fullMarks) : null;
                      return (
                        <td key={sub.id} className="td ss-exam-cell text-center">
                          <input
                            className={`ss-exam-mark input !w-16 !px-2 !py-1 text-center text-sm ${res && !res.pass ? "border-rose-300 text-rose-700" : ""}`}
                            value={raw}
                            onChange={(e) => setMark(s.studentId, sub.id, e.target.value)}
                            onBlur={() => {
                              // Guard against a mark above the column's own full marks.
                              if (entered && num > sub.fullMarks) setMark(s.studentId, sub.id, String(sub.fullMarks));
                            }}
                            disabled={locked}
                            placeholder="–"
                          />
                          {res && (
                            <div className={`ss-exam-grade mt-0.5 text-[10px] font-bold ${res.pass ? "text-emerald-600" : "text-rose-600"}`}>
                              {res.grade} · {res.gpa.toFixed(2)}
                            </div>
                          )}
                        </td>
                      );
                    })}
                    <td className="td ss-exam-gpa text-center font-black text-indigo-700">{s.gpa > 0 ? s.gpa.toFixed(2) : "—"}</td>
                    <td className="td ss-exam-pos text-center">
                      {s.position ? <Badge tone={s.position === 1 ? "green" : "slate"}>{s.position}</Badge> : "—"}
                      {live.gpa > 0 && live.gpa !== s.gpa && (
                        <div className="mt-0.5 text-[10px] text-slate-400">unsaved {live.gpa.toFixed(2)}</div>
                      )}
                      {live.fails > 0 && (
                        <div className="mt-0.5 text-[10px] font-bold text-rose-500">{live.fails} fail</div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {!students.length && <div className="ss-exam-empty py-10 text-center text-sm text-slate-400">No students in this class yet.</div>}
      </Card>

      {/* report cards */}
      <div className="ss-exam-reports mt-6">
        <h3 className="ss-exam-reports-title mb-3">
          <span className="ss-exam-section-icon"><Award size={15} /></span>
          Report cards
        </h3>
        <div className="ss-exam-reports-grid grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {students.filter((s: any) => s.marks.length).map((s: any) => (
            <Card key={s.studentId} className="ss-exam-reportcard flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <div className="ss-exam-report-avatar flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-600">
                  {s.name.split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase()}
                </div>
                <div>
                  <div className="ss-exam-report-name text-sm font-bold text-slate-800">{s.name}</div>
                  <div className="ss-exam-report-meta text-xs text-slate-400">GPA {s.gpa.toFixed(2)} · Pos {s.position || "—"}</div>
                </div>
              </div>
              <div className="ss-exam-report-actions flex gap-2">
                <Link href={`/print/report-card/${exam.id}/${s.studentId}`} className="btn btn-secondary btn-sm ss-exam-report-btn">
                  <FileText size={14} /> Report card
                </Link>
                {/* The year marksheet — every term side by side, not just this one. */}
                <Link href={`/print/marksheet/${s.studentId}`} className="btn btn-secondary btn-sm ss-exam-report-btn">
                  <FileSpreadsheet size={14} /> Marksheet
                </Link>
              </div>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
