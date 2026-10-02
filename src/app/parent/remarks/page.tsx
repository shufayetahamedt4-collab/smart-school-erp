"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen, statusTone, prettyStatus } from "@/components/ui";
import { useMe } from "@/components/Shell";
import { EmptyState, ErrorState, ListCard, ListRow, SectionHeader } from "@/components/app-ui";

/**
 * Guardian → Teacher Remarks.
 *
 * Same read (`/api/students/:id` → `remarks`) and the same rating tones. Each
 * remark becomes a hairline-separated row carrying the rating pill and the
 * teacher's name; the note is the row's subtitle.
 */
export default function ParentRemarksPage() {
  const { me } = useMe();
  const [remarks, setRemarks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!me?.student) return;
    setLoading(true);
    setError(null);
    api(`/api/students/${me.student.id}`)
      .then((d: any) => setRemarks(d.remarks))
      .catch((e: any) => setError(e?.message || "Couldn't load the remarks."))
      .finally(() => setLoading(false));
  }, [me]);
  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div>
      <SectionHeader title="Daily feedback from teachers" className="ss-flush-top" />
      {remarks.length ? (
        <ListCard>
          {remarks.map((r) => (
            <ListRow
              key={r.id}
              icon={MessageSquare}
              tone={r.rating === "EXCELLENT" ? "emerald" : r.rating === "GOOD" ? "sky" : r.rating === "AVERAGE" ? "amber" : "rose"}
              title={r.note || "No note was added."}
              subtitle={`${r.teacher?.user?.name || "Teacher"} · ${new Date(r.date).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short" })}`}
              trailing={<Badge tone={statusTone(r.rating)}>{prettyStatus(r.rating)}</Badge>}
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState icon={MessageSquare} title="No remarks yet" hint="Teachers haven't posted remarks for your child yet." />
      )}
    </div>
  );
}
