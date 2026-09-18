"use client";

import { useEffect, useState } from "react";
import { BookOpen, BookUp, Undo2 } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, EmptyState, LoadingScreen, ErrorNote, statusTone, prettyStatus } from "@/components/ui";
import { fmtDate, fmtMoney } from "@/lib/utils";

/**
 * PRD §7.1/§8 — Guardian visibility of the child's issued books/uniforms
 * and any library fines (fines themselves are payable under Fees).
 */

interface IssueRow {
  id: string; status: string; issuedAt: string; dueDate: string | null; returnedAt: string | null; fineAmount: number;
  book: { id: string; title: string; code: string | null; type: string };
}

export default function ParentBooksPage() {
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    api<IssueRow[]>("/api/books/issues").then(setIssues).catch((e) => setError(e.message));
  }, []);

  if (error) return <div><PageHeader title="My Books" /><div className="mb-4"><ErrorNote message={error} /></div></div>;
  if (!issues) return <LoadingScreen label="Loading issued books…" />;

  const active = issues.filter((i) => i.status === "ISSUED");
  const history = issues.filter((i) => i.status !== "ISSUED");

  return (
    <div>
      <PageHeader title="My Books" subtitle="Issued books, uniforms and library fines (PRD §8)" />

      <Card className="mb-6">
        <CardHeader title="Currently issued" subtitle={`${active.length} item(s) with your child`} />
        {active.length ? (
          <div className="divide-y divide-slate-100">
            {active.map((i) => {
              const overdue = i.dueDate && new Date(i.dueDate) < new Date();
              return (
                <div key={i.id} className="flex items-center justify-between px-5 py-3.5">
                  <div className="min-w-0">
                    <div className="text-sm font-bold text-slate-800">{i.book.title}</div>
                    <div className="text-xs text-slate-400">
                      Issued {fmtDate(i.issuedAt)} · due {i.dueDate ? fmtDate(i.dueDate) : "—"}
                      {overdue && <span className="ml-1 font-bold text-rose-600">OVERDUE</span>}
                    </div>
                  </div>
                  <BookUp size={16} className="text-slate-300" />
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState icon={BookOpen} title="Nothing issued yet" description="Issued textbooks and library books will appear here." />
        )}
      </Card>

      <Card>
        <CardHeader title="History & fines" subtitle="Returned / lost items" />
        {history.length ? (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr><th className="th">Item</th><th className="th">Issued</th><th className="th">Returned</th><th className="th">Status</th><th className="th">Fine</th></tr>
              </thead>
              <tbody>
                {history.map((i) => (
                  <tr key={i.id} className="tr-hover">
                    <td className="td font-semibold">{i.book.title}</td>
                    <td className="td">{fmtDate(i.issuedAt)}</td>
                    <td className="td">{i.returnedAt ? fmtDate(i.returnedAt) : "—"}</td>
                    <td className="td"><Badge tone={statusTone(i.status)}>{prettyStatus(i.status)}</Badge></td>
                    <td className="td">{i.fineAmount ? <span className="font-bold text-rose-600">{fmtMoney(i.fineAmount)}</span> : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState icon={Undo2} title="No history yet" />
        )}
      </Card>
    </div>
  );
}
