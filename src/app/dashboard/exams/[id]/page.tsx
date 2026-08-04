"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Save, Check, Send, FileText, Printer } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

export default function ExamDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [marks, setMarks] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  const load = () =>
    api(`/api/exams/${id}`).then((d: any) => {
      setData(d);
      const m: Record<string, string> = {};
      for (const s of d.students) {
        for (const mk of s.marks) {
          m[`${s.studentId}|${mk.subjectId}`] = String(mk.obtained);
        }
      }
      setMarks(m);
    }).finally(() => setLoading(false));

  useEffect(() => { load(); }, [id]);

  if (loading) return <LoadingScreen label="Loading exam…" />;
  if (!data) return <div className="p-10 text-center">Exam not found</div>;

  const { exam, subjects, students } = data;

  const setMark = (studentId: string, subjectId: string, val: string) => {
    const v = val.replace(/[^\d.]/g, "");
    setMarks((m) => ({ ...m, [`${studentId}|${subjectId}`]: v }));
  };

  const saveMarks = async () => {
    setSaving(true);
    setError("");
    try {
      const rows = students.flatMap((s: any) =>
        subjects.map((sub: any) => ({
          studentId: s.studentId,
          subjectId: sub.id,
          fullMarks: 100,
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

  return (
    <div>
      <PageHeader
        title={exam.name}
        subtitle={`${exam.classRoom.name}${exam.section ? ` · Section ${exam.section.name}` : ""} · ${exam.year} · ${fmtDate(exam.startDate)} → ${fmtDate(exam.endDate)}`}
        actions={
          <>
            <Link href="/dashboard/exams" className="btn btn-secondary btn-sm"><ArrowLeft size={14} /> Exams</Link>
            <button onClick={saveMarks} disabled={saving || exam.published} className="btn btn-primary btn-sm">
              {saved ? <Check size={14} /> : <Save size={14} />} {saved ? "Saved!" : saving ? "Saving…" : "Save marks"}
            </button>
            <button onClick={togglePublish} className={`btn btn-sm ${exam.published ? "btn-secondary" : "btn-primary"}`}>
              <Send size={14} /> {exam.published ? "Unpublish" : "Publish results"}
            </button>
          </>
        }
      />

      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      {exam.published ? (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          ✅ Results are <b>published</b> — guardians can now see this exam. Marks are locked until unpublished.
        </div>
      ) : (
        <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          ⏳ Draft mode — enter marks below, then publish so guardians can view results.
        </div>
      )}

      <Card className="overflow-hidden">
        <CardHeader title="Marks entry" subtitle={`${students.length} students × ${subjects.length} subjects (full marks 100)`} />
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="bg-slate-50">
                <th className="th min-w-52">Student</th>
                {subjects.map((s: any) => (
                  <th key={s.id} className="th min-w-20 text-center">{s.name}</th>
                ))}
                <th className="th text-center">GPA</th>
                <th className="th text-center">Pos.</th>
              </tr>
            </thead>
            <tbody>
              {students.map((s: any) => (
                <tr key={s.studentId} className="tr-hover">
                  <td className="td">
                    <div className="font-bold text-slate-800">{s.name}</div>
                    <div className="text-xs text-slate-400">Roll {s.roll ?? "—"} · {s.admissionNo}</div>
                  </td>
                  {subjects.map((sub: any) => (
                    <td key={sub.id} className="td text-center">
                      <input
                        className="input !w-16 !px-2 !py-1 text-center text-sm"
                        value={marks[`${s.studentId}|${sub.id}`] ?? ""}
                        onChange={(e) => setMark(s.studentId, sub.id, e.target.value)}
                        disabled={exam.published}
                        placeholder="–"
                      />
                    </td>
                  ))}
                  <td className="td text-center font-black text-indigo-700">{s.gpa > 0 ? s.gpa.toFixed(2) : "—"}</td>
                  <td className="td text-center">
                    {s.position ? <Badge tone={s.position === 1 ? "green" : "slate"}>{s.position}</Badge> : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!students.length && <div className="py-10 text-center text-sm text-slate-400">No students in this class yet.</div>}
      </Card>

      {/* report cards */}
      <div className="mt-6">
        <h3 className="mb-3 text-sm font-bold text-slate-700">Report cards</h3>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {students.filter((s: any) => s.marks.length).map((s: any) => (
            <Card key={s.studentId} className="flex items-center justify-between p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-600">
                  {s.name.split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase()}
                </div>
                <div>
                  <div className="text-sm font-bold text-slate-800">{s.name}</div>
                  <div className="text-xs text-slate-400">GPA {s.gpa.toFixed(2)} · Pos {s.position || "—"}</div>
                </div>
              </div>
              <Link href={`/print/report-card/${exam.id}/${s.studentId}`} className="btn btn-secondary btn-sm">
                <FileText size={14} /> Report card
              </Link>
            </Card>
          ))}
        </div>
      </div>
    </div>
  );
}
