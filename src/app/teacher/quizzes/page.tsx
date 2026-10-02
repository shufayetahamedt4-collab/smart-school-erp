"use client";

import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2, Send, BarChart3, HelpCircle } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, Field, TextInput, Select, Textarea, LoadingScreen, ErrorNote } from "@/components/ui";
import { EmptyState, ErrorState, IconTile, ListCard } from "@/components/app-ui";
import { MobileSheet } from "@/components/MobileSheet";
import { fmtDate } from "@/lib/utils";

/**
 * PRD §7.2 — MCQ quiz authoring (teacher): build questions with options and
 * the correct answer, publish to the class, watch attempts + averages.
 *
 * Same read, same POST/PATCH/DELETE calls and bodies, same create sheet, same
 * gates. The card grid became hairline-separated rows with a full-width action
 * line, so Publish and Delete stay thumb-sized instead of crowding the title.
 *
 * Also added: a read-failure state with retry. A failed GET previously fell
 * through to an error note above an empty grid, with no way to try again.
 */
interface QuizRow {
  id: string; title: string; description: string | null; published: boolean; allowRetake: boolean;
  durationMin: number | null; createdAt: string;
  classRoom?: { name: string } | null;
  subject?: { name: string } | null;
  questions: { id: string }[];
  attempts: { id: string; score?: string | number; totalMarks?: string | number }[];
}

interface QDraft {
  text: string; options: string[]; correctIndex: number; marks: number;
}

export default function TeacherQuizzesPage() {
  const [quizzes, setQuizzes] = useState<QuizRow[] | null>(null);
  const [classes, setClasses] = useState<any[]>([]);
  const [subjects, setSubjects] = useState<any[]>([]);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);

  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<any>({ title: "", description: "", classId: "", subjectId: "", durationMin: "10", allowRetake: false });
  const [questions, setQuestions] = useState<QDraft[]>([{ text: "", options: ["", "", "", ""], correctIndex: 0, marks: 1 }]);

  const load = useCallback(
    () =>
      api<QuizRow[]>("/api/quizzes?mine=1")
        .then((rows) => {
          setQuizzes(rows);
          setLoadError("");
        })
        .catch((e: any) => setLoadError(e?.message || "Couldn't load your quizzes.")),
    [],
  );

  useEffect(() => {
    load();
    api<any[]>("/api/classes").then(setClasses).catch(() => null);
    api<any[]>("/api/subjects").then(setSubjects).catch(() => null);
  }, [load]);

  const retry = () => {
    // Clearing the read error puts the page back on its loading state; the read
    // itself is the same call as before.
    setLoadError("");
    load();
  };

  const create = async () => {
    setBusy(true); setError("");
    try {
      await api("/api/quizzes", { method: "POST", body: JSON.stringify({ ...form, questions }) });
      setOpen(false);
      setForm({ title: "", description: "", classId: "", subjectId: "", durationMin: "10", allowRetake: false });
      setQuestions([{ text: "", options: ["", "", "", ""], correctIndex: 0, marks: 1 }]);
      load();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  };

  const togglePublish = async (q: QuizRow) => {
    try {
      await api("/api/quizzes", { method: "PATCH", body: JSON.stringify({ id: q.id, published: !q.published }) });
      load();
    } catch (e: any) { setError(e.message); }
  };

  const del = async (q: QuizRow) => {
    if (!confirm(`Delete "${q.title}" and its attempts?`)) return;
    try {
      await api(`/api/quizzes?id=${q.id}`, { method: "DELETE" });
      load();
    } catch (e: any) { setError(e.message); }
  };

  const updQ = (i: number, patch: Partial<QDraft>) =>
    setQuestions((qs) => qs.map((q, idx) => (idx === i ? { ...q, ...patch } : q)));

  if (!quizzes && !loadError) return <LoadingScreen label="Loading quizzes…" />;
  // Only for the initial read: a failed refresh after a successful mutation keeps
  // the list the user is looking at, and never replaces it with an error screen.
  if (!quizzes && loadError) return <ErrorState message={loadError} onRetry={retry} />;

  return (
    <div className="ss-quizpage">
      {/* First block: no leading mt — the app's own top padding is the rhythm. */}
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2 className="text-[13px] font-extrabold uppercase tracking-[0.05em] text-slate-500">
          {(quizzes || []).length} quizzes
        </h2>
        <button className="btn btn-primary btn-sm" onClick={() => setOpen(true)}>
          <Plus size={15} /> New quiz
        </button>
      </div>
      {error && (
        <div className="mb-3">
          <ErrorNote message={error} />
        </div>
      )}

      {(quizzes || []).length ? (
        <ListCard>
          {(quizzes || []).map((q) => {
            const taken = q.attempts.length;
            const avg = taken
              ? Math.round(
                  q.attempts.reduce((a, x) => a + (Number(x.totalMarks) ? (Number(x.score) / Number(x.totalMarks)) * 100 : 0), 0) / taken
                )
              : null;
            return (
              <li key={q.id} className="px-3.5 py-3">
                <div className="flex items-start gap-3">
                  <IconTile icon={HelpCircle} tone="indigo" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="break-words text-[14px] font-bold leading-snug text-slate-800">{q.title}</span>
                      <Badge tone={q.published ? "green" : "amber"}>{q.published ? "Published" : "Draft"}</Badge>
                      {q.allowRetake && <Badge tone="slate">retakes on</Badge>}
                    </div>
                    <p className="mt-0.5 break-words text-[12px] leading-snug text-slate-400">
                      {q.classRoom?.name || "All classes"}{q.subject ? ` · ${q.subject.name}` : ""} · {q.questions.length} Qs
                      {q.durationMin ? ` · ${q.durationMin} min` : ""} · created {fmtDate(q.createdAt)}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-[11.5px]">
                      <span className="flex items-center gap-1 font-bold text-slate-600"><BarChart3 size={13} /> {taken} attempt(s)</span>
                      {avg !== null && <span className="font-bold text-indigo-600">avg {avg}%</span>}
                    </div>
                  </div>
                </div>
                <div className="mt-2.5 flex gap-2">
                  <button className="btn btn-secondary btn-sm flex-1" onClick={() => togglePublish(q)}>
                    <Send size={12} /> {q.published ? "Unpublish" : "Publish"}
                  </button>
                  <button className="btn btn-danger btn-sm" onClick={() => del(q)} aria-label="Delete quiz">
                    <Trash2 size={12} /> Delete
                  </button>
                </div>
              </li>
            );
          })}
        </ListCard>
      ) : (
        <EmptyState icon={HelpCircle} title="No quizzes yet" hint="Create an auto-graded MCQ quiz for your class." />
      )}

      <MobileSheet open={open} onClose={() => setOpen(false)} title="New MCQ quiz">
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <Field label="Title"><TextInput value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Chapter 3 quick test" /></Field>
            <Field label="Duration (minutes, 0 = none)"><TextInput type="number" value={form.durationMin} onChange={(e) => setForm({ ...form, durationMin: e.target.value })} /></Field>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Class">
              <Select value={form.classId} onChange={(e) => setForm({ ...form, classId: e.target.value })}>
                <option value="">Select…</option>
                {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Subject">
              <Select value={form.subjectId} onChange={(e) => setForm({ ...form, subjectId: e.target.value })}>
                <option value="">—</option>
                {subjects.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="Description"><Textarea rows={2} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></Field>
          <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
            <input type="checkbox" checked={form.allowRetake} onChange={(e) => setForm({ ...form, allowRetake: e.target.checked })} />
            Allow retakes (students can attempt more than once)
          </label>

          <div>
            <div className="mb-2 flex items-center justify-between">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Questions (auto-graded)</p>
              <button className="btn btn-ghost btn-sm" onClick={() => setQuestions((qs) => [...qs, { text: "", options: ["", "", "", ""], correctIndex: 0, marks: 1 }])}>
                <Plus size={13} /> Add question
              </button>
            </div>
            <div className="space-y-3">
              {questions.map((q, i) => (
                <div key={i} className="rounded-xl border border-slate-200 p-3">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-black text-slate-400">Q{i + 1}</span>
                    <TextInput value={q.text} onChange={(e) => updQ(i, { text: e.target.value })} placeholder="Question text" />
                    <TextInput className="!w-16" type="number" min={1} value={q.marks} onChange={(e) => updQ(i, { marks: Number(e.target.value) })} title="Marks" />
                    <button className="btn btn-ghost btn-sm" onClick={() => setQuestions((qs) => qs.filter((_, idx) => idx !== i))} disabled={questions.length === 1}>
                      <Trash2 size={13} />
                    </button>
                  </div>
                  <div className="mt-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                    {q.options.map((opt, oi) => (
                      <label key={oi} className="flex items-center gap-2 text-xs">
                        <input
                          type="radio"
                          name={`correct-${i}`}
                          checked={q.correctIndex === oi}
                          onChange={() => updQ(i, { correctIndex: oi })}
                          title="Mark as correct answer"
                        />
                        <TextInput
                          value={opt}
                          onChange={(e) => updQ(i, { options: q.options.map((o, x) => (x === oi ? e.target.value : o)) })}
                          placeholder={`Option ${oi + 1}`}
                        />
                      </label>
                    ))}
                  </div>
                  <p className="mt-1 text-[10px] text-slate-400">Select the radio button of the correct answer. Students never see this.</p>
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2">
            <button className="btn btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={create} disabled={busy || !form.title || !form.classId}>Create draft</button>
          </div>
        </div>
      </MobileSheet>
    </div>
  );
}
