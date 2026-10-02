"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { api } from "@/lib/client";
import { LoadingScreen } from "@/components/ui";
import { useMe } from "@/components/Shell";
import { EmptyState, ErrorState, ListCard, ListRow, SectionHeader } from "@/components/app-ui";

/** PRD §7.2 — Published exam results + report cards (guardian view). */
export default function ParentResultsPage() {
  const { me } = useMe();
  const [exams, setExams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!me?.student) return;
    setLoading(true);
    setError(null);
    Promise.all([api("/api/exams"), api(`/api/students/${me.student.id}`)])
      .then(([ex, st]: any) => {
        const published = ex.filter((e: any) => e.published && e.classId === st.classId);
        setExams(published);
      })
      .catch((e: any) => setError(e?.message || "Couldn't load the results."))
      .finally(() => setLoading(false));
  }, [me]);
  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div>
      <SectionHeader title="Published results" className="ss-flush-top" />
      {exams.length ? (
        <ListCard>
          {exams.map((e) => (
            <ListRow
              key={e.id}
              icon={FileText}
              tone="indigo"
              title={e.name}
              subtitle={`${e.classRoom?.name || ""}${e.section ? ` · Section ${e.section.name}` : ""} · ${e.year}`}
              trailing={
                <Link href={`/print/report-card/${e.id}/${me!.student!.id}`} className="btn btn-primary btn-sm min-h-11 shrink-0">
                  <Download size={14} /> Report card
                </Link>
              }
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState icon={FileText} title="No published results yet" hint="Results appear here once the school publishes them." />
      )}

      {me?.student && (
        <>
          <SectionHeader title="Year marksheet" />
          <ListCard>
            {/* The marksheet spans every published term, so it belongs to the
                page rather than to one exam's row. */}
            <ListRow
              href={`/print/marksheet/${me.student.id}`}
              icon={FileSpreadsheet}
              tone="violet"
              title="Full year marksheet"
              subtitle="Every published term in one sheet"
            />
          </ListCard>
        </>
      )}
    </div>
  );
}
