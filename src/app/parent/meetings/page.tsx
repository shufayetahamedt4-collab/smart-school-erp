"use client";

import { useEffect, useState } from "react";
import { CalendarCheck, CheckCircle } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen, EmptyState, ErrorNote } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/** PRD §7.1 — PTM slot booking (guardian side). */
export default function ParentMeetingsPage() {
  const [slots, setSlots] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [bookedMsg, setBookedMsg] = useState("");

  const load = () => api<any[]>("/api/meetings").then(setSlots).finally(() => setLoading(false));
  useEffect(() => { load(); }, []);

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

  return (
    <div>
      <PageHeader title="Book a Meeting" subtitle="Pick a slot with your child's teacher (PRD §7.1)" />
      {bookedMsg && <div className="mb-4 flex items-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700"><CheckCircle size={16} /> {bookedMsg}</div>}
      {error && <div className="mb-4"><ErrorNote message={error} /></div>}

      <Card>
        <CardHeader title="Available slots" subtitle={`${slots.filter((s) => !s.booked).length} open`} />
        {slots.length ? (
          <div className="divide-y divide-slate-100">
            {slots.map((s) => (
              <div key={s.id} className="flex items-center justify-between px-5 py-3">
                <div>
                  <p className="text-sm font-bold text-slate-800">{s.teacher || "Teacher"}</p>
                  <p className="text-xs text-slate-500">{fmtDate(s.startAt, true)} · {s.durationMin} min · {s.mode === "ONLINE" ? "Online" : "In person"}</p>
                </div>
                {s.booked ? (
                  <Badge tone="green">Booked</Badge>
                ) : (
                  <button className="btn btn-primary btn-sm" onClick={() => book(s.id)} disabled={busyId === s.id}>
                    {busyId === s.id ? "Booking…" : "Book"}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={CalendarCheck} title="No slots published" description="Teachers publish meeting slots here." />
        )}
      </Card>
    </div>
  );
}
