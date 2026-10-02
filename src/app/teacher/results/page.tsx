"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BarChart3, Eye, Send } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen } from "@/components/ui";
import { EmptyState, ErrorState, IconTile, ListCard, Segmented, SectionHeader } from "@/components/app-ui";
import { cn } from "@/lib/utils";

interface Exam {
  id: string;
  name: string;
  published: boolean;
  year: number;
  classRoom: { name: string };
  section: { name: string } | null;
  _count: { marks: number };
}

type Filter = "all" | "draft" | "published";

/**
 * Teacher Results.
 *
 * Same data and the same two actions as before: one `api("/api/exams")` read, the
 * publish toggle PATCHing `/api/exams/:id`, and the same rule that a sheet with
 * no marks cannot be published. The segment control only filters the rows that
 * were already fetched — it issues no request.
 *
 * Added: an error state (a failed read used to leave the page on its loader).
 */
export default function TeacherResultsPage() {
  const [exams, setExams] = useState<Exam[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>("all");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<Exam[]>("/api/exams")
      .then(setExams)
      .catch((e: any) => setError(e?.message || "Couldn't load your exams."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  const togglePublish = async (e: Exam) => {
    await api(`/api/exams/${e.id}`, { method: "PATCH", body: JSON.stringify({ published: !e.published }) });
    setExams((xs) => xs.map((x) => (x.id === e.id ? { ...x, published: !x.published } : x)));
  };

  const counts = useMemo(
    () => ({
      all: exams.length,
      draft: exams.filter((e) => !e.published).length,
      published: exams.filter((e) => e.published).length,
    }),
    [exams],
  );

  const rows = useMemo(
    () => exams.filter((e) => (filter === "all" ? true : filter === "published" ? e.published : !e.published)),
    [exams, filter],
  );

  if (loading) return <LoadingScreen label="Loading results…" />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div className="ss-resultspage">
      <Segmented<Filter>
        label="Filter exams"
        value={filter}
        onChange={setFilter}
        options={[
          { value: "all", label: `All (${counts.all})` },
          { value: "draft", label: `Draft (${counts.draft})` },
          { value: "published", label: `Published (${counts.published})` },
        ]}
      />

      <SectionHeader title="Exam sheets" />

      {rows.length ? (
        <ListCard>
          {rows.map((e) => (
            <li key={e.id} className="px-3.5 py-3">
              {/* Row body: the meta column takes the whole width minus the icon,
                  so a long exam name can never be squeezed into a sliver — which
                  is exactly what broke here before. */}
              <div className="flex items-start gap-3">
                <IconTile icon={BarChart3} tone="violet" />
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="break-words text-[14px] font-bold leading-snug text-slate-800">{e.name}</span>
                    <Badge tone={e.published ? "green" : "amber"}>{e.published ? "Published" : "Draft"}</Badge>
                  </div>
                  <div className="mt-0.5 break-words text-[12px] leading-snug text-slate-400">
                    {e.classRoom.name}
                    {e.section ? ` · Section ${e.section.name}` : ""} · {e._count.marks} marks entered
                  </div>
                </div>
              </div>

              {/* Actions keep their own full-width line, so they never crowd the
                  title and stay thumb-sized on a phone. */}
              <div className="mt-2.5 flex gap-2">
                {/* This app is its own host: the admin exam sheet lives at
                    /dashboard/…, which the teacher host refuses (and which
                    prefetched as a cross-origin redirect, so the button did
                    nothing). Open the teacher's own sheet for this exam. */}
                <Link href={`/teacher/marks?examId=${e.id}`} className="btn btn-secondary btn-sm flex-1">
                  <Eye size={14} /> Open sheet
                </Link>
                <button
                  onClick={() => togglePublish(e)}
                  disabled={e._count.marks === 0}
                  className={cn("btn btn-sm flex-1", e.published ? "btn-secondary" : "btn-primary")}
                >
                  <Send size={14} /> {e.published ? "Unpublish" : "Publish"}
                </button>
              </div>
            </li>
          ))}
        </ListCard>
      ) : (
        <EmptyState
          icon={BarChart3}
          title={exams.length ? "Nothing in this filter" : "No exams yet"}
          hint={
            exams.length
              ? "Try another segment to see the other exam sheets."
              : "Exam sheets appear here once your school creates an exam for your classes."
          }
        />
      )}
    </div>
  );
}
