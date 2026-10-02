"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Download, FileSpreadsheet, FileText } from "lucide-react";
import { api } from "@/lib/client";
import { LoadingScreen } from "@/components/ui";
import { useMe } from "@/components/Shell";
import { EmptyState, ErrorState, ListCard, ListRow, SectionHeader } from "@/components/app-ui";

interface Sibling {
  id: string;
  name: string;
  classRoom?: { name: string } | null;
  section?: { name: string } | null;
}

/** PRD §7.2 — Published exam results + report cards (guardian view). */
export default function ParentResultsPage() {
  const { me } = useMe();
  const [siblings, setSiblings] = useState<Sibling[]>([]);
  const [childId, setChildId] = useState("");
  const [exams, setExams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((id: string) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    Promise.all([api("/api/exams"), api(`/api/students/${id}`)])
      .then(([ex, st]: any) => {
        const published = ex.filter((e: any) => e.published && e.classId === st.classId);
        setExams(published);
      })
      .catch((e: any) => setError(e?.message || "Couldn't load the results."))
      .finally(() => setLoading(false));
  }, []);

  // One login covers the whole household (§5.4): the results and the report cards
  // belong to a chosen child, not to an assumed one. The default stays the
  // session's own student, so nothing changes for a single-child family.
  useEffect(() => {
    let alive = true;
    (async () => {
      const kids = await api<Sibling[]>("/api/parent/siblings").catch(() => [] as Sibling[]);
      if (!alive) return;
      setSiblings(kids);
      const fallback =
        me?.student && kids.some((k) => k.id === me.student!.id) ? me.student.id : kids[0]?.id || "";
      setChildId(fallback);
      if (fallback) load(fallback);
      else setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [load, me]);

  const pickChild = (id: string) => {
    setChildId(id);
    load(id);
  };

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorState message={error} onRetry={() => load(childId)} />;

  const childName = siblings.find((s) => s.id === childId)?.name || me?.student?.name || "";

  return (
    <div>
      {siblings.length > 1 && (
        <div className="mb-3 flex flex-wrap items-center gap-2">
          <span className="text-[12px] font-medium text-slate-500">Child:</span>
          {siblings.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pickChild(s.id)}
              className={`min-h-9 rounded-full border px-3 text-[12px] ${
                s.id === childId ? "border-sky-300 bg-sky-50 text-sky-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"
              }`}
            >
              {s.name}
              {s.classRoom?.name ? ` · ${s.classRoom.name}` : ""}
            </button>
          ))}
        </div>
      )}

      <SectionHeader
        title={childName ? `${childName} · Published results` : "Published results"}
        className="ss-flush-top"
      />
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
                <Link href={`/print/report-card/${e.id}/${childId}`} className="btn btn-primary btn-sm min-h-11 shrink-0">
                  <Download size={14} /> Report card
                </Link>
              }
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState icon={FileText} title="No published results yet" hint="Results appear here once the school publishes them." />
      )}

      {childId && (
        <>
          <SectionHeader title="Year marksheet" />
          <ListCard>
            {/* The marksheet spans every published term, so it belongs to the
                page rather than to one exam's row. */}
            <ListRow
              href={`/print/marksheet/${childId}`}
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
