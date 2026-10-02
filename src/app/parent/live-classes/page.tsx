"use client";

import { useCallback, useEffect, useState } from "react";
import { CalendarClock, Clock, Radio } from "lucide-react";
import { api } from "@/lib/client";
import { Badge, ErrorNote, LoadingScreen } from "@/components/ui";
import { useMe } from "@/components/Shell";
import { EmptyState, ListCard, ListRow, SectionHeader, Surface } from "@/components/app-ui";

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
interface Sibling {
  id: string;
  name: string;
  classRoom?: { name: string } | null;
  section?: { name: string } | null;
}

const POLL_MS = 20_000;

export default function ParentLiveClassesPage() {
  const { me } = useMe();
  const [siblings, setSiblings] = useState<Sibling[]>([]);
  const [childId, setChildId] = useState("");
  const [data, setData] = useState<{
    child: { id: string; name: string } | null;
    classId: string | null;
    className: string | null;
    live: Session[];
    today: Session[];
  } | null>(null);
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
    <div>
      {error && (
        <div className="mb-3">
          <ErrorNote message={error} />
        </div>
      )}

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

      <SectionHeader title="Right now" className="ss-flush-top" />
      <Surface className={now ? "!bg-emerald-50 !ring-emerald-200" : ""}>
        <p className="text-[13px] font-extrabold text-slate-800">{childName}{data?.className ? ` · ${data.className}` : ""}</p>
        {!data?.classId ? (
          <EmptyState icon={Radio} title="No class assigned yet" hint="Once the school puts your child in a class, its live status appears here." />
        ) : now ? (
          <div className="mt-2">
            <Badge tone="green">
              <Radio className="mr-1 inline h-3 w-3" /> Class in progress
            </Badge>
            <p className="mt-2 text-[17px] font-extrabold text-slate-900">{now.subjectName || now.className}</p>
            <p className="text-[13px] text-slate-600">Teacher: {now.teacherName}</p>
            <p className="mt-1 flex items-center gap-1.5 text-[11px] text-slate-500">
              <Clock className="h-3.5 w-3.5" /> started {now.startedClock}
              {now.periodLabel ? ` · ${now.periodLabel}` : ""} · running {now.durationMin} min
            </p>
          </div>
        ) : (
          <p className="mt-2 text-[13px] text-slate-500">
            No class is in progress right now for {childName}. Classes appear here the moment the teacher starts one.
          </p>
        )}
      </Surface>

      <SectionHeader title="Today's classes" />
      {!data?.today?.length ? (
        <EmptyState icon={CalendarClock} title="No classes yet today" hint="Nothing has been started for this class yet." />
      ) : (
        <ListCard>
          {data.today.map((s) => (
            <ListRow
              key={s.id}
              icon={CalendarClock}
              tone="slate"
              title={s.subjectName || "—"}
              subtitle={`${s.teacherName} · ${s.startedClock || "—"} → ${s.status === "OPEN" ? "now" : s.endedClock || "—"} · ${s.durationMin} min`}
              trailing={
                s.status === "OPEN" ? (
                  <Badge tone="green">In progress</Badge>
                ) : s.status === "DECLINED" ? (
                  <Badge tone="amber">Class not held</Badge>
                ) : (
                  <Badge tone="slate">Finished</Badge>
                )
              }
            />
          ))}
        </ListCard>
      )}
    </div>
  );
}
