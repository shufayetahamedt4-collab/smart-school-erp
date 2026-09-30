"use client";

import { useCallback, useEffect, useState } from "react";
import { Radio, Users, CalendarClock, Square, Clock, DoorOpen, TriangleAlert, XCircle } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, StatCard, LoadingScreen, ErrorNote, EmptyState, Modal, TextInput } from "@/components/ui";
import { initials } from "@/lib/utils";

/**
 * The school office's board: who is teaching right now, who is not, and what
 * happened today. A teacher's own Yes/No/Finish taps are the only input — every
 * green dot means a teacher said they were in that room.
 *
 * The timetable is shown next to those taps, never instead of them: a teacher
 * the routine expects in class right now who has not tapped anything is flagged
 * "Not started" (chase it), and a period the teacher marked as not taken is
 * flagged "Not taken"). So the board answers both "who is in class?" and "who
 * should be but isn't?".
 *
 * Admins can end a stuck session (a teacher who forgot, a class cut short) so
 * the board can be corrected without waiting for the teacher to log in.
 */
interface Expected {
  routineId: string;
  className: string;
  sectionName: string | null;
  subjectName: string | null;
  periodLabel: string;
  startTime: string | null;
  endTime: string | null;
}
interface Session {
  id: string;
  teacherId: string;
  teacherName: string;
  className: string;
  sectionName: string | null;
  subjectName: string | null;
  periodLabel: string | null;
  status: string;
  autoEnded: boolean;
  startedClock: string | null;
  endedClock: string | null;
  durationMin: number;
}
interface RosterRow {
  teacherId: string | null;
  userId: string;
  name: string;
  email: string | null;
  photoUrl: string | null;
  active: boolean;
  inClass: Session | null;
  expected: Expected | null;
  declinedNow: boolean;
  declinedToday: number;
  missing: boolean;
  onLeave: boolean;
  sessionsToday: number;
  minutesToday: number;
  lastEndedClock: string | null;
}
interface Board {
  date: string;
  todayKey: string;
  liveMaxMinutes: number;
  live: Session[];
  today: Session[];
  roster: RosterRow[];
  counts: { inClass: number; expected: number; missing: number; declined: number; free: number; onLeave: number; sessionsToday: number };
}

const POLL_MS = 15_000;
const todayISO = () => {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

export default function LiveClassesPage() {
  const [board, setBoard] = useState<Board | null>(null);
  const [date, setDate] = useState(todayISO());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [ending, setEnding] = useState<Session | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (forDate: string) => {
    const res = await api<Board>(`/api/class-sessions?view=roster&date=${encodeURIComponent(forDate)}`, { cache: "no-store" });
    setBoard(res);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await load(date);
      } catch (e: any) {
        if (alive) setError(e?.message || "Could not load the live board.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [date, load]);

  useEffect(() => {
    const t = setInterval(() => load(date).catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [date, load]);

  async function endNow() {
    if (!ending) return;
    setBusy(true);
    setError("");
    try {
      await api(`/api/class-sessions/${encodeURIComponent(ending.id)}`, { method: "PATCH", body: JSON.stringify({}) });
      setEnding(null);
      await load(date);
    } catch (e: any) {
      setError(e?.message || "Could not end that class.");
      await load(date).catch(() => {});
    } finally {
      setBusy(false);
    }
  }

  if (loading && !board) return <LoadingScreen />;

  const counts = board?.counts || { inClass: 0, expected: 0, missing: 0, declined: 0, free: 0, onLeave: 0, sessionsToday: 0 };
  const isToday = board?.date === board?.todayKey;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live Classes"
        subtitle={
          isToday
            ? "Every open class, every teacher's status, and today's log — updated every 15 seconds."
            : `Reviewing ${board?.date}. Switch back to today to see who is in class right now.`
        }
        actions={
          <div className="flex items-center gap-2">
            <TextInput type="date" value={date} onChange={(e) => setDate(e.target.value || todayISO())} className="!w-40" />
            {!isToday && (
              <button className="btn btn-secondary btn-sm" onClick={() => setDate(todayISO())}>
                Today
              </button>
            )}
          </div>
        }
      />

      {error && <ErrorNote message={error} />}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <StatCard icon={Radio} tone="emerald" label="In class now" value={counts.inClass} sub={isToday ? "teachers teaching right now" : "not a live day"} />
        <StatCard icon={TriangleAlert} tone="amber" label="Not started" value={counts.missing} sub={isToday ? "expected now, no tap yet" : "—"} />
        <StatCard icon={XCircle} tone="rose" label="Not taken" value={counts.declined} sub="periods declined by teachers" />
        <StatCard icon={DoorOpen} tone="sky" label="On leave" value={counts.onLeave} sub="approved leave this day" />
        <StatCard icon={CalendarClock} tone="indigo" label="Classes held" value={counts.sessionsToday} sub="classes recorded this day" />
      </div>

      <Card>
        <CardHeader title="In class now" subtitle="Live sessions — an admin can end a stuck one." />
        {!board?.live.length ? (
          <EmptyState icon={Radio} title="No class is running" description="Start taps from teachers appear here within seconds." />
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {board.live.map((s) => (
              <div key={s.id} className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <Badge tone="green">
                        <Radio className="mr-1 inline h-3 w-3" /> Live
                      </Badge>
                      <span className="truncate text-xs text-slate-500">{s.periodLabel || ""}</span>
                    </div>
                    <p className="mt-2 truncate font-semibold text-slate-900">{s.teacherName}</p>
                    <p className="truncate text-sm text-slate-600">
                      {s.className}
                      {s.sectionName ? ` · ${s.sectionName}` : ""}
                      {s.subjectName ? ` — ${s.subjectName}` : ""}
                    </p>
                    <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                      <Clock className="h-3.5 w-3.5" /> since {s.startedClock} · {s.durationMin} min
                    </p>
                  </div>
                  <button className="btn btn-secondary btn-sm shrink-0" onClick={() => setEnding(s)}>
                    <Square className="mr-1 h-3.5 w-3.5" /> End
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card>
        <CardHeader
          title="Every teacher"
          subtitle={`Who is in a class, who the timetable expects now, and who declined${counts.onLeave ? ", plus approved leave" : ""}.`}
        />
        {!board?.roster.length ? (
          <EmptyState icon={Users} title="No teachers yet" description="Add teachers and their status appears here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Teacher</th>
                  <th className="th">Status</th>
                  <th className="th">Where</th>
                  <th className="th">Classes today</th>
                  <th className="th">Minutes</th>
                </tr>
              </thead>
              <tbody>
                {board.roster.map((r) => (
                  <tr key={r.userId} className="tr-hover">
                    <td className="td">
                      <div className="flex items-center gap-2">
                        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">
                          {initials(r.name)}
                        </span>
                        <span>
                          <span className="block font-medium text-slate-800">{r.name}</span>
                          {r.email && <span className="block text-xs text-slate-400">{r.email}</span>}
                        </span>
                      </div>
                    </td>
                    <td className="td">
                      {r.inClass ? (
                        <Badge tone="green">In class</Badge>
                      ) : r.onLeave ? (
                        <Badge tone="amber">On leave</Badge>
                      ) : r.declinedNow ? (
                        <Badge tone="red">Not taken</Badge>
                      ) : r.missing ? (
                        <Badge tone="amber">Not started</Badge>
                      ) : (
                        <Badge tone="slate">Free</Badge>
                      )}
                      {r.active === false && <span className="ml-2 text-xs text-slate-400">(inactive)</span>}
                    </td>
                    <td className="td">
                      {r.inClass ? (
                        <span>
                          {r.inClass.className}
                          {r.inClass.sectionName ? ` · ${r.inClass.sectionName}` : ""}
                          {r.inClass.subjectName ? ` — ${r.inClass.subjectName}` : ""}
                          <span className="block text-xs text-slate-400">since {r.inClass.startedClock}</span>
                        </span>
                      ) : r.expected ? (
                        <span>
                          {r.expected.className}
                          {r.expected.sectionName ? ` · ${r.expected.sectionName}` : ""}
                          {r.expected.subjectName ? ` — ${r.expected.subjectName}` : ""}
                          <span className="block text-xs text-amber-600">
                            {r.declinedNow ? "declined this period" : "expected now"} · {r.expected.periodLabel}
                          </span>
                        </span>
                      ) : (
                        <span className="text-slate-400">{r.lastEndedClock ? `last class ended ${r.lastEndedClock}` : "—"}</span>
                      )}
                    </td>
                    <td className="td">{r.sessionsToday}</td>
                    <td className="td">{r.minutesToday}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title={isToday ? "Today's log" : `Log for ${board?.date}`} subtitle="Every class started and ended, with how long it ran." />
        {!board?.today.length ? (
          <EmptyState icon={CalendarClock} title="No classes recorded" description="Nothing was started on this day." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Class</th>
                  <th className="th">Teacher</th>
                  <th className="th">Subject</th>
                  <th className="th">Start</th>
                  <th className="th">End</th>
                  <th className="th">Duration</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {board.today.map((s) => (
                  <tr key={s.id} className="tr-hover">
                    <td className="td">
                      {s.className}
                      {s.sectionName ? ` · ${s.sectionName}` : ""}
                    </td>
                    <td className="td">{s.teacherName}</td>
                    <td className="td">{s.subjectName || "—"}</td>
                    <td className="td">{s.startedClock || "—"}</td>
                    <td className="td">{s.status === "OPEN" ? "—" : s.endedClock || "—"}</td>
                    <td className="td">{s.durationMin} min</td>
                    <td className="td">
                      {s.status === "OPEN" ? (
                        <Badge tone="green">In class</Badge>
                      ) : s.status === "DECLINED" ? (
                        <Badge tone="red">Not taken</Badge>
                      ) : s.autoEnded ? (
                        <Badge tone="amber">Auto-closed</Badge>
                      ) : (
                        <Badge tone="slate">Ended</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-3 text-xs text-slate-400">
          A class never ended is closed automatically after {Math.round((board?.liveMaxMinutes || 240) / 60)} hours so the board cannot show a
          teacher stuck in class.
        </p>
      </Card>

      <Modal open={!!ending} onClose={() => setEnding(null)} title="End this class?">
        <p className="text-sm text-slate-600">
          {ending
            ? `${ending.teacherName} — ${ending.className}${ending.sectionName ? ` · ${ending.sectionName}` : ""}${ending.subjectName ? ` — ${ending.subjectName}` : ""}, running ${ending.durationMin} min.`
            : ""}
        </p>
        <p className="mt-2 text-xs text-slate-500">The teacher and parents will see the class as finished.</p>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn btn-secondary" onClick={() => setEnding(null)} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-danger" onClick={endNow} disabled={busy}>
            {busy ? "Ending…" : "End class"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
