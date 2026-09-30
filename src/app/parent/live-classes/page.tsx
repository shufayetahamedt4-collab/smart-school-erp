"use client";

import { useCallback, useEffect, useState } from "react";
import { Radio, Clock, CalendarClock } from "lucide-react";
import { api } from "@/lib/client";
import { Card, CardHeader, Badge, PageHeader, LoadingScreen, ErrorNote, EmptyState } from "@/components/ui";
import { useMe } from "@/components/Shell";

/**
 * A parent's window into the school day: which class is in progress for their
 * child right now, and with which teacher. The teacher's own Start/End taps are
 * the source — the page never shows a timetable guess as if it were happening.
 */
interface Session {
  id: string;
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
interface Sibling { id: string; name: string; classRoom?: { name: string } | null; section?: { name: string } | null }

const POLL_MS = 20_000;

export default function ParentLiveClassesPage() {
  const { me } = useMe();
  const [siblings, setSiblings] = useState<Sibling[]>([]);
  const [childId, setChildId] = useState("");
  const [data, setData] = useState<{ child: { id: string; name: string } | null; classId: string | null; className: string | null; live: Session[]; today: Session[] } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (id: string) => {
    const res = await api<any>(`/api/class-sessions?view=parent${id ? `&studentId=${encodeURIComponent(id)}` : ""}`, { cache: "no-store" });
    setData(res);
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const kids = await api<Sibling[]>("/api/parent/siblings").catch(() => []);
        if (!alive) return;
        setSiblings(kids);
        const first = kids[0]?.id || (me?.student as any)?.id || "";
        setChildId(first);
        await load(first);
      } catch (e: any) {
        if (alive) setError(e?.message || "Could not load the class board.");
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [load, me]);

  useEffect(() => {
    if (!childId) return;
    const t = setInterval(() => load(childId).catch(() => {}), POLL_MS);
    return () => clearInterval(t);
  }, [childId, load]);

  function pickChild(id: string) {
    setChildId(id);
    load(id).catch(() => {});
  }

  if (loading) return <LoadingScreen />;

  const live = data?.live || [];
  const now = live[0];
  const childName = data?.child?.name || "your child";

  return (
    <div className="space-y-5">
      <PageHeader
        title="Live Classes"
        subtitle="Which class is going on now, and which teacher is taking it."
      />

      {error && <ErrorNote message={error} />}

      {siblings.length > 1 && (
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-medium text-slate-500">Child:</span>
          {siblings.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pickChild(s.id)}
              className={`rounded-full border px-3 py-1 text-xs ${s.id === childId ? "border-indigo-300 bg-indigo-50 text-indigo-700" : "border-slate-200 text-slate-600 hover:bg-slate-50"}`}
            >
              {s.name}
              {s.classRoom?.name ? ` · ${s.classRoom.name}` : ""}
            </button>
          ))}
        </div>
      )}

      <Card className={now ? "border-emerald-200 bg-emerald-50/60" : ""}>
        <CardHeader title="Right now" subtitle={`${childName}${data?.className ? ` · ${data.className}` : ""}`} />
        {!data?.classId ? (
          <EmptyState icon={Radio} title="No class assigned yet" description="Once the school puts your child in a class, its live status appears here." />
        ) : now ? (
          <div className="flex flex-wrap items-start justify-between gap-4 p-5">
            <div>
              <Badge tone="green">
                <Radio className="mr-1 inline h-3 w-3" /> Class in progress
              </Badge>
              <p className="mt-2 text-lg font-semibold text-slate-900">{now.subjectName || now.className}</p>
              <p className="text-sm text-slate-600">Teacher: {now.teacherName}</p>
              <p className="mt-1 flex items-center gap-1.5 text-xs text-slate-500">
                <Clock className="h-3.5 w-3.5" /> started {now.startedClock}
                {now.periodLabel ? ` · ${now.periodLabel}` : ""} · running {now.durationMin} min
              </p>
            </div>
          </div>
        ) : (
          <div className="p-5 text-sm text-slate-500">
            No class is in progress right now for {childName}. Classes appear here the moment the teacher starts one.
          </div>
        )}
      </Card>

      <Card>
        <CardHeader title="Today's classes" subtitle="What has been taught, with the teacher and how long it ran." />
        {!data?.today?.length ? (
          <EmptyState icon={CalendarClock} title="No classes yet today" description="Nothing has been started for this class yet." />
        ) : (
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Subject</th>
                  <th className="th">Teacher</th>
                  <th className="th">Start</th>
                  <th className="th">End</th>
                  <th className="th">Duration</th>
                  <th className="th">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.today.map((s) => (
                  <tr key={s.id} className="tr-hover">
                    <td className="td">{s.subjectName || "—"}</td>
                    <td className="td">{s.teacherName}</td>
                    <td className="td">{s.startedClock || "—"}</td>
                    <td className="td">{s.status === "OPEN" ? "—" : s.endedClock || "—"}</td>
                    <td className="td">{s.durationMin} min</td>
                    <td className="td">
                      {s.status === "OPEN" ? (
                        <Badge tone="green">In progress</Badge>
                      ) : s.status === "DECLINED" ? (
                        <Badge tone="amber">Class not held</Badge>
                      ) : (
                        <Badge tone="slate">Finished</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
