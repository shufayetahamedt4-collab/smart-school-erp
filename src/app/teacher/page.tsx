"use client";

import { useCallback, useEffect, useState } from "react";
import { BookOpen, ClipboardList, FileText, GraduationCap, LayoutGrid, Users } from "lucide-react";
import { api } from "@/lib/client";
import { LoadingScreen } from "@/components/ui";
import { useMe } from "@/components/Shell";
import {
  EmptyState,
  ErrorState,
  ListCard,
  ListRow,
  OverviewTile,
  QuickAction,
  SectionHeader,
} from "@/components/app-ui";
import { fmtDate, initials } from "@/lib/utils";

/**
 * Teacher Home.
 *
 * Same data as before — one `api("/api/stats")` read, the same four stat values,
 * the same class and homework lists, and the same destinations (each class row
 * still opens Attendance, each homework row still opens Homework). What changed
 * is the shape: a greeting, a 2×2 tile overview, and inset list rows instead of
 * bordered cards with buttons in them.
 *
 * Also added: an error state. Previously a failed read left `stats` null, so the
 * page showed "Loading teacher dashboard…" forever.
 */
export default function TeacherDashboard() {
  const [stats, setStats] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { me } = useMe();
  // Time-based greeting is computed after mount so the server and client frames
  // cannot disagree about what time it is.
  const [greeting, setGreeting] = useState("Welcome");

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api("/api/stats")
      .then(setStats)
      .catch((e: any) => setError(e?.message || "Couldn't load your dashboard."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(load, [load]);

  useEffect(() => {
    const h = new Date().getHours();
    setGreeting(h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening");
  }, []);

  if (loading) return <LoadingScreen label="Loading teacher dashboard…" />;
  if (error || !stats) return <ErrorState message={error || undefined} onRetry={load} />;

  const totalStudents = stats.myClasses.reduce((a: number, c: any) => a + c._count.students, 0);
  const name = me?.user?.name || "";

  return (
    <div className="ss-home">
      {/* ------------------------------- greeting ------------------------------- */}
      <div className="flex items-center gap-3">
        <span className="flex h-11 w-11 shrink-0 items-center justify-center overflow-hidden rounded-full bg-indigo-50 text-[13px] font-extrabold text-indigo-700">
          {me?.user?.photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={me.user.photoUrl} alt="" className="h-full w-full object-cover" />
          ) : (
            initials(name) || <GraduationCap size={18} />
          )}
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13px] text-slate-500">{greeting}</p>
          <p className="truncate text-[17px] font-extrabold leading-tight text-slate-900">{name || "Teacher"}</p>
          <p className="truncate text-[12px] text-slate-400">Teacher{me?.school?.name ? ` · ${me.school.name}` : ""}</p>
        </div>
      </div>

      {/* --------------------------- today's overview --------------------------- */}
      <SectionHeader title="Today's Overview" />
      <div className="ss-tiles grid grid-cols-2 gap-3">
        <OverviewTile
          icon={GraduationCap}
          tone="indigo"
          value={stats.myClasses.length}
          label="My classes"
          sub={`${totalStudents} students`}
        />
        <OverviewTile
          icon={Users}
          tone="sky"
          value={stats.assignments.length}
          label="Assignments"
          sub="class & subject duties"
        />
        <OverviewTile
          icon={BookOpen}
          tone="violet"
          value={stats.homeworks.length}
          label="Homeworks"
          sub="posted this term"
        />
        <OverviewTile
          icon={ClipboardList}
          tone="emerald"
          value={stats.attendanceToday}
          label="Today's marks"
          sub="attendance records submitted"
        />
      </div>

      {/* ---------------------------- quick actions ---------------------------- */}
      <SectionHeader title="Quick Actions" />
      <div className="ss-quick grid grid-cols-4 gap-2.5">
        <QuickAction href="/teacher/attendance" icon={ClipboardList} tone="indigo" label="Attendance" />
        <QuickAction href="/teacher/remarks" icon={FileText} tone="violet" label="Remarks" />
        <QuickAction href="/teacher/homework" icon={BookOpen} tone="emerald" label="Homework" />
        <QuickAction href="/teacher/marks" icon={GraduationCap} tone="amber" label="Marks" />
      </div>

      {/* --------------------------- today's classes --------------------------- */}
      <SectionHeader title="My Classes" actionHref="/teacher/classes" actionLabel="View all" />
      {stats.myClasses.length ? (
        <ListCard>
          {stats.myClasses.map((c: any) => (
            <ListRow
              key={c.id}
              href="/teacher/attendance"
              icon={LayoutGrid}
              tone="indigo"
              title={c.name}
              subtitle={`${c._count.students} students · sections ${c.sections.map((s: any) => s.name).join(", ") || "—"}`}
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState
          icon={LayoutGrid}
          title="No classes assigned yet"
          hint="Once your school assigns you a class it will show up here."
        />
      )}

      {/* --------------------------- recent homework --------------------------- */}
      <SectionHeader title="Recent Homework" actionHref="/teacher/homework" actionLabel="View all" />
      {stats.homeworks.length ? (
        <ListCard>
          {stats.homeworks.map((h: any) => (
            <ListRow
              key={h.id}
              href="/teacher/homework"
              icon={BookOpen}
              tone="violet"
              title={h.title}
              subtitle={`Due ${fmtDate(h.dueDate)}`}
            />
          ))}
        </ListCard>
      ) : (
        <EmptyState
          icon={BookOpen}
          title="No homework posted yet"
          hint="Homework you set for your classes will appear here."
          actionHref="/teacher/homework"
          actionLabel="Create homework"
        />
      )}

      {/* Clears the fixed phone tab bar so the last row is never tapped by accident. */}
      <div className="h-2" aria-hidden />
    </div>
  );
}
