"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarCheck } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen, statusTone, prettyStatus } from "@/components/ui";
import { useMe } from "@/components/Shell";
import { EmptyState, ErrorState, ListCard, ListRow, OverviewTile, SectionHeader } from "@/components/app-ui";

/** PRD §8 — Attendance history for the guardian's child (guardian view). */
export default function ParentAttendancePage() {
  const { me } = useMe();
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    if (!me?.student) return;
    setLoading(true);
    setError(null);
    api(`/api/students/${me.student.id}`)
      .then((d: any) => setRows([...d.attendance].reverse()))
      .catch((e: any) => setError(e?.message || "Couldn't load the attendance."))
      .finally(() => setLoading(false));
  }, [me]);
  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  const present = rows.filter((r) => r.status === "PRESENT" || r.status === "LATE").length;
  const rate = rows.length ? Math.round((present / rows.length) * 100) : 0;

  return (
    <div>
      <SectionHeader title={`${rate}% across ${rows.length} school days`} className="ss-flush-top" />

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
