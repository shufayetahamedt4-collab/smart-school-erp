"use client";

import { useEffect, useState } from "react";
import { Award, CheckCircle2, Info, ListChecks } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, ErrorNote, LoadingScreen } from "@/components/ui";
import { EmptyState, ListCard, ListRow, SectionHeader } from "@/components/app-ui";
import { MobileSheet } from "@/components/MobileSheet";

/**
 * Parents App — quizzes.
 *
 * There is no student app: the child does not carry a phone, so quizzes are
 * opened here on the guardian's device. Everything is scoped server-side to
 * this guardian's own child, and grading happens on the server — the answer key
 * is never sent to the browser.
 *
 * Presentation only: the same reads and writes (available list, attempt GET/POST,
 * retake prefill, review) — the take-quiz dialog is now the app's bottom sheet,
 * matching the Teacher App.
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
      <div className="mb-3 flex items-start gap-2.5 rounded-2xl border border-sky-100 bg-sky-50 px-4 py-3 text-[12px] text-slate-600">
        <Info size={15} className="mt-0.5 shrink-0 text-sky-600" />
        <p>
          Hand the device to your child for the quiz itself. Answers are graded on the school&apos;s server and the
          result is recorded against your child&apos;s name.
        </p>
      </div>

      {error && (
        <div className="mb-3">
          <ErrorNote message={error} />
        </div>
      )}

      {quizzes && !quizzes.length ? (
        <EmptyState icon={ListChecks} title="No quizzes right now" hint="Quizzes published by your child's teachers appear here." />
      ) : null}

      {pending.length > 0 && (
        <>
          <SectionHeader title={`Available · ${pending.length}`} className="ss-flush-top" />
          <ListCard>
            {pending.map((q) => (
              <ListRow
                key={q.id}
                icon={ListChecks}
                tone="emerald"
                title={q.title}
                subtitle={`${q.subject || "General"} · ${q.questionCount} questions${q.durationMin ? ` · ${q.durationMin} min` : ""}`}
                trailing={
                  <button className="btn btn-primary btn-sm min-h-11 shrink-0" onClick={() => setActive(q)}>
                    Start quiz
                  </button>
                }
              />
            ))}
          </ListCard>
        </>
      )}

      {done.length > 0 && (
        <>
          <SectionHeader title={`Completed · ${done.length}`} />
          <ListCard>
            {done.map((q) => {
              const pct =
                q.attempt && Number(q.attempt.totalMarks)
                  ? Math.round((Number(q.attempt.score) / Number(q.attempt.totalMarks)) * 100)
                  : 0;
              return (
                <ListRow
                  key={q.id}
                  onClick={() => setActive(q)}
                  icon={Award}
                  tone={pct >= 60 ? "emerald" : pct >= 40 ? "amber" : "rose"}
                  title={q.title}
                  subtitle={`${q.subject || "General"} · ${q.attempt?.score}/${q.attempt?.totalMarks} marks`}
                  trailing={<Badge tone={pct >= 60 ? "green" : pct >= 40 ? "amber" : "red"}>{pct}%</Badge>}
                />
              );
            })}
          </ListCard>
        </>
      )}

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
    <MobileSheet open onClose={onClose} title={quiz.title}>
      <p className="-mt-2 mb-3 text-[12px] text-slate-400">
        {quiz.subject || "General"} · {quiz.questionCount} questions
      </p>

      {error && (
        <div className="mb-3">
          <ErrorNote message={error} />
        </div>
      )}

      {result ? (
        <div>
          <div className="rounded-2xl bg-gradient-to-r from-emerald-600 to-teal-600 p-5 text-white">
            <div className="text-[11px] font-bold uppercase tracking-widest text-emerald-100">
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
                <div key={r.questionId} className={`rounded-xl border p-3 ${r.correct ? "border-emerald-200 bg-emerald-50" : "border-rose-200 bg-rose-50"}`}>
                  <div className="text-[13px] font-bold text-slate-800">
                    Q{i + 1}. {r.text}
                  </div>
                  <div className="mt-1 text-[12px] text-slate-500">
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
            <button className="btn btn-secondary min-h-11" onClick={onClose}>
              Close
            </button>
            {result.retake && (
              <button className="btn btn-primary min-h-11" onClick={() => setResult(null)}>
                Attempt again
              </button>
            )}
          </div>
        </div>
      ) : data ? (
        <div className="space-y-4">
          {data.questions.map((q: any, i: number) => (
            <div key={q.id} className="rounded-xl border border-slate-200 p-4">
              <div className="text-[13px] font-bold text-slate-800">
                Q{i + 1}. {q.text} <span className="text-[10px] font-bold text-slate-400">({q.marks} mk)</span>
              </div>
              <div className="mt-2 space-y-1.5">
                {q.options.map((opt: string, oi: number) => (
                  <label
                    key={oi}
                    className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-[13px] transition ${
                      answers[q.id] === oi ? "border-sky-500 bg-sky-50 font-bold text-sky-700" : "border-slate-200 hover:bg-slate-50"
                    }`}
                  >
                    <input type="radio" name={`q-${q.id}`} checked={answers[q.id] === oi} onChange={() => setAnswers({ ...answers, [q.id]: oi })} />
                    {opt}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div className="flex justify-end gap-2 pb-2">
            <button className="btn btn-secondary min-h-11" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary min-h-11" onClick={submit} disabled={busy}>
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
    </MobileSheet>
  );
}
