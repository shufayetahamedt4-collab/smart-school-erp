"use client";

import { useCallback, useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen, statusTone, prettyStatus } from "@/components/ui";
import { useMe } from "@/components/Shell";
import { EmptyState, ErrorState, ListCard, ListRow, SectionHeader } from "@/components/app-ui";

interface Sibling {
  id: string;
  name: string;
  classRoom?: { name: string } | null;
  section?: { name: string } | null;
}

/**
 * Guardian → Teacher Remarks.
 *
 * Same read (`/api/students/:id` → `remarks`) and the same rating tones. Each
 * remark becomes a hairline-separated row carrying the rating pill and the
 * teacher's name; the note is the row's subtitle.
 *
 * One login covers the whole household (§5.4), so the child is chosen rather
 * than assumed: the default is the session's own student, which is the child
 * this screen has always shown.
 */
export default function ParentRemarksPage() {
  const { me } = useMe();
  const [siblings, setSiblings] = useState<Sibling[]>([]);
  const [childId, setChildId] = useState("");
  const [remarks, setRemarks] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((id: string) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    api(`/api/students/${id}`)
      .then((d: any) => setRemarks(d.remarks))
      .catch((e: any) => setError(e?.message || "Couldn't load the remarks."))
      .finally(() => setLoading(false));
  }, []);

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
        title={`${childName ? `${childName} · ` : ""}Daily feedback from teachers`}
        className="ss-flush-top"
      />
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
