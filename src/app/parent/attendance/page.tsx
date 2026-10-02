"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarCheck } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen, statusTone, prettyStatus } from "@/components/ui";
import { useMe } from "@/components/Shell";
import { EmptyState, ErrorState, ListCard, ListRow, OverviewTile, SectionHeader } from "@/components/app-ui";

interface Sibling {
  id: string;
  name: string;
  classRoom?: { name: string } | null;
  section?: { name: string } | null;
}

/** PRD §8 — Attendance history for the guardian's child (guardian view). */
export default function ParentAttendancePage() {
  const { me } = useMe();
  const [siblings, setSiblings] = useState<Sibling[]>([]);
  const [childId, setChildId] = useState("");
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback((id: string) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    api(`/api/students/${id}`)
      .then((d: any) => setRows([...d.attendance].reverse()))
      .catch((e: any) => setError(e?.message || "Couldn't load the attendance."))
      .finally(() => setLoading(false));
  }, []);

  // One login covers the whole household (§5.4), so the child is chosen rather
  // than assumed. The default is the same child the portal has always opened on
  // (the session's own student), so a single-child family sees exactly what it
  // saw before — and a second child's attendance is reachable at all.
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
  const present = rows.filter((r) => r.status === "PRESENT" || r.status === "LATE").length;
  const rate = rows.length ? Math.round((present / rows.length) * 100) : 0;

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
        title={`${childName ? `${childName} · ` : ""}${rate}% across ${rows.length} school days`}
        className="ss-flush-top"
      />

      <div className="ss-tiles grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[
          { st: "PRESENT", tone: "emerald" as const },
          { st: "ABSENT", tone: "rose" as const },
          { st: "LATE", tone: "amber" as const },
          { st: "LEAVE", tone: "sky" as const },
        ].map(({ st, tone }) => (
          <OverviewTile key={st} icon={CalendarCheck} tone={tone} value={rows.filter((r) => r.status === st).length} label={st} />
        ))}
      </div>

      <SectionHeader title="History" />
      {rows.length ? (
        <ListCard>
          {rows.map((r) => (
            <ListRow
              key={r.id}
              icon={CalendarCheck}
              tone="slate"
              title={new Date(r.date).toLocaleDateString("en-GB", { weekday: "short", day: "2-digit", month: "short", year: "numeric" })}
              subtitle={r.remark || "—"}
              trailing={<Badge tone={statusTone(r.status)}>{prettyStatus(r.status)}</Badge>}
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState icon={CalendarCheck} title="No attendance records yet" />
      )}
    </div>
  );
}
