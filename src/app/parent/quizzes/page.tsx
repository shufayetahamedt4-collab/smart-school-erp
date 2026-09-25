"use client";

import { useEffect, useState } from "react";
import { CheckCircle2, Timer, Award, ListChecks, Info } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Badge, PageHeader, LoadingScreen, EmptyState, ErrorNote } from "@/components/ui";

/**
 * Parents App — quizzes.
 *
 * There is no student app: the child does not carry a phone, so quizzes are
 * opened here on the guardian's device. Everything is scoped server-side to
 * this guardian's own child, and grading happens on the server — the answer key
 * is never sent to the browser.
 */

interface QuizCard {
  id: string;
  title: string;
  description: string | null;
  durationMin: number | null;
  subject: string | null;
  className: string | null;
  questionCount: number;
  attempt: { id: string; score: string | number; totalMarks: string | number; submittedAt: string } | null;
}

export default function ParentQuizzesPage() {
  const [quizzes, setQuizzes] = useState<QuizCard[] | null>(null);
  const [active, setActive] = useState<QuizCard | null>(null);
  const [error, setError] = useState("");

  const load = () => api<QuizCard[]>("/api/quizzes/available").then(setQuizzes).catch((e) => setError(e.message));
  useEffect(() => {
    load();
  }, []);

  if (!quizzes && !error) return <LoadingScreen label="Loading quizzes…" />;

  const pending = (quizzes || []).filter((q) => !q.attempt);
  const done = (quizzes || []).filter((q) => q.attempt);

  return (
    <div>
      <PageHeader
        title="Quizzes"
        subtitle="Online MCQ tests your child takes on this device — instant auto-graded results"
      />

      <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-sky-100 bg-sky-50 px-4 py-3 text-xs text-slate-600">
        <Info size={15} className="mt-0.5 shrink-0 text-sky-600" />
        <p>
          Hand the device to your child for the quiz itself. Answers are graded on the school&apos;s server and the
          result is recorded against your child&apos;s name.
        </p>
      </div>

      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {pending.map((q) => (
          <Card key={q.id} className="flex flex-col p-5">
            <div className="flex items-start justify-between">
              <Badge tone="emerald">{q.subject || "General"}</Badge>
              {q.durationMin ? (
                <span className="flex items-center gap-1 text-[11px] font-bold text-slate-400">
                  <Timer size={12} /> {q.durationMin} min
                </span>
              ) : null}
            </div>
            <h3 className="mt-2 font-extrabold text-slate-900">{q.title}</h3>
            <p className="mt-1 flex-1 text-xs text-slate-500">{q.description || "Answer all questions and submit."}</p>
            <div className="mt-2 text-[11px] font-bold text-slate-400">{q.questionCount} questions</div>
            <button className="btn btn-primary btn-sm mt-3" onClick={() => setActive(q)}>
              Start quiz
            </button>
          </Card>
        ))}

        {done.map((q) => {
          const pct =
            q.attempt && Number(q.attempt.totalMarks)
              ? Math.round((Number(q.attempt.score) / Number(q.attempt.totalMarks)) * 100)
              : 0;
          return (
            <Card key={q.id} className="flex flex-col p-5 opacity-90">
              <div className="flex items-start justify-between">
                <Badge tone="gray">{q.subject || "General"}</Badge>
                <Badge tone={pct >= 60 ? "green" : pct >= 40 ? "amber" : "red"}>
                  <Award size={12} /> {pct}%
                </Badge>
              </div>
              <h3 className="mt-2 font-extrabold text-slate-900">{q.title}</h3>
              <p className="mt-1 flex-1 text-xs text-slate-400">
                Completed — {q.attempt?.score}/{q.attempt?.totalMarks} marks
              </p>
              {q.attempt && (
                <button className="btn btn-secondary btn-sm mt-3" onClick={() => setActive(q)}>
                  Review answers
                </button>
              )}
            </Card>
          );
        })}

        {quizzes && !quizzes.length && (
          <Card className="md:col-span-2 xl:col-span-3">
            <EmptyState
              icon={ListChecks}
              title="No quizzes right now"
              description="Quizzes published by your child's teachers appear here."
            />
          </Card>
        )}
      </div>

      {active && (
        <TakeQuiz
          quiz={active}
          onClose={() => {
            setActive(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function TakeQuiz({ quiz, onClose }: { quiz: QuizCard; onClose: () => void }) {
  const [data, setData] = useState<any>(null);
  const [answers, setAnswers] = useState<Record<string, number>>({});
  const [result, setResult] = useState<any>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<any>(`/api/quizzes/${quiz.id}/attempt`)
      .then((d) => {
        if (d.quiz.previousScore) {
          // retake — prefill the result view with the previous score
          setResult({
            score: d.quiz.previousScore.score,
            totalMarks: d.quiz.previousScore.totalMarks,
            pct: null,
            review: null,
            retake: true,
          });
        }
        setData(d);
      })
      .catch((e) => setError(e.message));
  }, [quiz.id]);

  const submit = async () => {
    setBusy(true);
    setError("");
    try {
      const res = await api<any>(`/api/quizzes/${quiz.id}/attempt`, {
        method: "POST",
        body: JSON.stringify({ answers }),
      });
      setResult(res);
      window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 p-4 backdrop-blur-sm">
      <div className="mx-auto max-w-2xl rounded-2xl bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-black text-slate-900">{quiz.title}</h2>
            <p className="text-xs text-slate-400">
              {quiz.subject || "General"} · {quiz.questionCount} questions
            </p>
          </div>
          <button className="btn btn-ghost btn-sm" onClick={onClose}>
            ✕
          </button>
        </div>

        {error && (
          <div className="mt-3">
            <ErrorNote message={error} />
          </div>
        )}

        {result ? (
          <div className="mt-4">
            <div className="rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 p-5 text-white">
              <div className="text-xs font-bold uppercase tracking-widest text-emerald-100">
                {result.retake ? "Previous attempt" : "Quiz submitted"}
              </div>
              <div className="mt-1 text-3xl font-black">
                {result.pct !== null && result.pct !== undefined ? `${result.pct}%` : ""}
                {result.totalMarks ? ` ${result.score}/${result.totalMarks}` : ""}
              </div>
              {result.retake && <div className="mt-1 text-xs text-emerald-100">Submit again to record a new score.</div>}
            </div>
            {result.review && (
              <div className="mt-4 space-y-3">
                {result.review.map((r: any, i: number) => (
                  <div
                    key={r.questionId}
                    className={`rounded-xl border p-3 ${
                      r.correct ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"
                    }`}
                  >
                    <div className="text-sm font-bold text-slate-800">
                      Q{i + 1}. {r.text}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      Answer: {r.given !== null && r.given !== undefined ? r.options[r.given] : "—"}
                      {!r.correct && (
                        <>
                          {" "}
                          · Correct: <b>{r.options[r.correctIndex]}</b>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <button className="btn btn-secondary" onClick={onClose}>
                Close
              </button>
              {result.retake && (
                <button className="btn btn-primary" onClick={() => setResult(null)}>
                  Attempt again
                </button>
              )}
            </div>
          </div>
        ) : data ? (
          <div className="mt-4 space-y-4">
            {data.questions.map((q: any, i: number) => (
              <div key={q.id} className="rounded-xl border border-slate-200 p-4">
                <div className="text-sm font-bold text-slate-800">
                  Q{i + 1}. {q.text} <span className="text-[10px] font-bold text-slate-400">({q.marks} mk)</span>
                </div>
                <div className="mt-2 space-y-1.5">
                  {q.options.map((opt: string, oi: number) => (
                    <label
                      key={oi}
                      className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm transition ${
                        answers[q.id] === oi
                          ? "border-indigo-500 bg-indigo-50 font-bold text-indigo-700"
                          : "border-slate-200 hover:bg-slate-50"
                      }`}
                    >
                      <input
                        type="radio"
                        name={`q-${q.id}`}
                        checked={answers[q.id] === oi}
                        onChange={() => setAnswers({ ...answers, [q.id]: oi })}
                      />
                      {opt}
                    </label>
                  ))}
                </div>
              </div>
            ))}
            <div className="flex justify-end gap-2 pb-2">
              <button className="btn btn-secondary" onClick={onClose}>
                Cancel
              </button>
              <button className="btn btn-primary" onClick={submit} disabled={busy}>
                {busy ? (
                  "Submitting…"
                ) : (
                  <>
                    <CheckCircle2 size={15} /> Submit quiz
                  </>
                )}
              </button>
            </div>
          </div>
        ) : (
          <LoadingScreen label="Loading quiz…" />
        )}
      </div>
    </div>
  );
}
