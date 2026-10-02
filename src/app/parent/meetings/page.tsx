"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarCheck, CheckCircle } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, ErrorNote, LoadingScreen } from "@/components/ui";
import { EmptyState, ErrorState, ListCard, ListRow, SectionHeader } from "@/components/app-ui";
import { fmtDate } from "@/lib/utils";

/** PRD §7.1 — PTM slot booking (guardian side). */
export default function ParentMeetingsPage() {
  const [slots, setSlots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [bookedMsg, setBookedMsg] = useState("");

  const load = useCallback(() => {
    setLoading(true);
    setLoadError(null);
    return api<any[]>("/api/meetings")
      .then(setSlots)
      .catch((e: any) => setLoadError(e?.message || "Couldn't load the slots."))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  const book = async (slotId: string) => {
    setBusyId(slotId);
    setError("");
    setBookedMsg("");
    try {
      await api("/api/meetings", { method: "POST", body: JSON.stringify({ slotId }) });
      setBookedMsg("Slot booked — you'll get a reminder before the meeting.");
      await load();
    } catch (e: any) {
      setError(e?.message || "Booking failed");
    } finally {
      setBusyId(null);
    }
  };

  if (loading) return <LoadingScreen />;
  if (loadError) return <ErrorState message={loadError} onRetry={load} />;

  return (
    <div>
      {bookedMsg && (
        <div className="mb-3 flex items-center gap-2 rounded-2xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-[13px] font-semibold text-emerald-700">
          <CheckCircle size={16} /> {bookedMsg}
        </div>
      )}
      {error && (
        <div className="mb-3">
          <ErrorNote message={error} />
        </div>
      )}

      <SectionHeader title={`Available slots · ${slots.filter((s) => !s.booked).length} open`} className="ss-flush-top" />
      {slots.length ? (
        <ListCard>
          {slots.map((s) => (
            <ListRow
              key={s.id}
              icon={CalendarCheck}
              tone="sky"
              title={s.teacher || "Teacher"}
              subtitle={`${fmtDate(s.startAt, true)} · ${s.durationMin} min · ${s.mode === "ONLINE" ? "Online" : "In person"}`}
              trailing={
                s.booked ? (
                  <Badge tone="green">Booked</Badge>
                ) : (
                  <button className="btn btn-primary btn-sm min-h-11 shrink-0" onClick={() => book(s.id)} disabled={busyId === s.id}>
                    {busyId === s.id ? "Booking…" : "Book"}
                  </button>
                )
              }
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState icon={CalendarCheck} title="No slots published" hint="Teachers publish meeting slots here." />
      )}
    </div>
  );
}
