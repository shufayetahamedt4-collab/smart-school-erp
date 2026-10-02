"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, BookUp, Undo2 } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen, statusTone, prettyStatus } from "@/components/ui";
import { EmptyState, ErrorState, ListCard, ListRow, SectionHeader } from "@/components/app-ui";
import { fmtDate, fmtMoney } from "@/lib/utils";

/**
 * PRD §7.1/§8 — Guardian visibility of the child's issued books/uniforms
 * and any library fines (fines themselves are payable under Fees).
 */

interface IssueRow {
  id: string;
  status: string;
  issuedAt: string;
  dueDate: string | null;
  returnedAt: string | null;
  fineAmount: number;
  book: { id: string; title: string; code: string | null; type: string };
}

export default function ParentBooksPage() {
  const [issues, setIssues] = useState<IssueRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<IssueRow[]>("/api/books/issues")
      .then(setIssues)
      .catch((e: any) => setError(e?.message || "Couldn't load the issued books."))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingScreen label="Loading issued books…" />;
  if (error || !issues) return <ErrorState message={error || undefined} onRetry={load} />;

  const active = issues.filter((i) => i.status === "ISSUED");
  const history = issues.filter((i) => i.status !== "ISSUED");

  return (
    <div>
      <SectionHeader title={`Currently issued · ${active.length}`} className="ss-flush-top" />
      {active.length ? (
        <ListCard>
          {active.map((i) => {
            const overdue = i.dueDate && new Date(i.dueDate) < new Date();
            return (
              <ListRow
                key={i.id}
                icon={BookUp}
                tone={overdue ? "rose" : "indigo"}
                title={i.book.title}
                subtitle={`Issued ${fmtDate(i.issuedAt)} · due ${i.dueDate ? fmtDate(i.dueDate) : "—"}${overdue ? " · OVERDUE" : ""}`}
              />
            );
          })}
        </ListCard>
      ) : (
        <EmptyState icon={BookOpen} title="Nothing issued yet" hint="Issued textbooks and library books will appear here." />
      )}

      <SectionHeader title="History & fines" />
      {history.length ? (
        <ListCard>
          {history.map((i) => (
            <ListRow
              key={i.id}
              icon={Undo2}
              tone="slate"
              title={i.book.title}
              subtitle={`Issued ${fmtDate(i.issuedAt)} · returned ${i.returnedAt ? fmtDate(i.returnedAt) : "—"}`}
              trailing={
                <div className="flex shrink-0 items-center gap-2">
                  <Badge tone={statusTone(i.status)}>{prettyStatus(i.status)}</Badge>
                  {i.fineAmount ? <span className="text-[12px] font-bold text-rose-600">{fmtMoney(i.fineAmount)}</span> : null}
                </div>
              }
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState icon={Undo2} title="No history yet" />
      )}
    </div>
  );
}
