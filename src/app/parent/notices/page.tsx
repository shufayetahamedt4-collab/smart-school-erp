"use client";

import { useCallback, useEffect, useState } from "react";
import { Megaphone } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, LoadingScreen } from "@/components/ui";
import { EmptyState, ErrorState, SectionHeader, Surface } from "@/components/app-ui";
import { fmtDate } from "@/lib/utils";

// "green" is the Badge tone key for the emerald shade — passing "emerald"
// silently renders an untinted badge (the primitive has no such class).
const TONES: Record<string, any> = { GENERAL: "slate", HOLIDAY: "red", EXAM: "violet", MEETING: "blue", EVENT: "green", PICNIC: "amber" };

/**
 * Guardian → Notice Board.
 *
 * Same read (`/api/notices`) and the same category tones. The bordered cards
 * become inset surfaces on the app plane, and the app bar names the screen.
 * Also added: a read-failure state instead of an endless "Loading…".
 */
export default function ParentNoticesPage() {
  const [notices, setNotices] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api<any[]>("/api/notices")
      .then(setNotices)
      .catch((e: any) => setError(e?.message || "Couldn't load the notices."))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  if (loading) return <LoadingScreen />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <div>
      <SectionHeader title="School announcements" className="ss-flush-top" />
      {notices.length ? (
        <div className="space-y-3">
          {notices.map((n) => (
            <Surface key={n.id}>
              <div className="flex flex-wrap items-center gap-2">
                <Badge tone={TONES[n.category] || "slate"}>{n.category}</Badge>
                <span className="text-[11px] text-slate-400">{fmtDate(n.date, true)}</span>
              </div>
              <h3 className="mt-2 text-[15px] font-extrabold text-slate-900">{n.title}</h3>
              <p className="mt-1 text-[13px] leading-relaxed text-slate-600">{n.body}</p>
            </Surface>
          ))}
        </div>
      ) : (
        <EmptyState icon={Megaphone} title="No notices yet" hint="School announcements will appear here." />
      )}
    </div>
  );
}
