"use client";

import { useEffect, useState } from "react";
import { FileText, IdCard } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, EmptyState, LoadingScreen } from "@/components/ui";
import { fmtMoney } from "@/lib/utils";

/**
 * PRD §7.2 — own results + report card + ID card download.
 * Data comes from /api/student/me (published exams only).
 */

export default function StudentResultsPage() {
  const [data, setData] = useState<any>(null);

  useEffect(() => {
    api<any>("/api/student/me").then(setData).catch(() => setData({}));
  }, []);

  if (!data) return <LoadingScreen label="Loading results…" />;

  const results: any[] = data.results || [];
  // group by exam
  const byExam = results.reduce<Record<string, { exam: string; rows: any[]; total: number; full: number }>>((acc, m) => {
    const key = m.exam?.id || "x";
    if (!acc[key]) acc[key] = { exam: m.exam?.name || "Exam", rows: [], total: 0, full: 0 };
    acc[key].rows.push(m);
    acc[key].total += Number(m.obtained || 0);
    acc[key].full += Number(m.fullMarks || 0);
    return acc;
  }, {});

  const studentId = data.student?.id;
  // most recent published exam id for the printable report card
  const latestExamId = results[0]?.exam?.id || null;

  return (
    <div>
      <PageHeader title="My Results" subtitle="Published exam results and report cards (PRD §7.2)" />

      <div className="mb-4 flex gap-2">
        {studentId && latestExamId && (
          <a href={`/print/report-card/${latestExamId}/${studentId}`} target="_blank" className="btn btn-secondary btn-sm">
            <FileText size={14} /> Report card
          </a>
        )}
        {studentId && (
          <a href={`/print/id-card/${studentId}`} target="_blank" className="btn btn-secondary btn-sm">
            <IdCard size={14} /> My ID card
          </a>
        )}
      </div>

      <Card>
        <CardHeader title="Exam results" subtitle="Only published exams are shown" />
        {Object.keys(byExam).length ? (
          <div className="space-y-5 p-5">
            {Object.entries(byExam).map(([examId, g]) => {
              const pct = g.full ? Math.round((g.total / g.full) * 100) : 0;
              return (
                <div key={examId}>
                  <div className="mb-2 flex items-center justify-between">
                    <div className="text-sm font-black text-slate-800">{g.exam}</div>
                    <Badge tone={pct >= 60 ? "green" : pct >= 40 ? "amber" : "red"}>{pct}%</Badge>
                  </div>
                  <div className="overflow-hidden rounded-xl border border-slate-200">
                    <table className="w-full">
                      <thead>
                        <tr><th className="th">Subject</th><th className="th">Obtained</th><th className="th">Full</th><th className="th">Grade</th></tr>
                      </thead>
                      <tbody>
                        {g.rows.map((m) => (
                          <tr key={m.id}>
                            <td className="td font-semibold">{m.subject?.name}</td>
                            <td className="td">{m.obtained}</td>
                            <td className="td">{m.fullMarks}</td>
                            <td className="td"><Badge tone={Number(m.gradePoint) >= 3.5 ? "green" : Number(m.gradePoint) >= 2 ? "amber" : "red"}>{m.grade}</Badge></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={FileText} title="No published results yet" description="Results appear here once your school publishes an exam." />
        )}
      </Card>
    </div>
  );
}
