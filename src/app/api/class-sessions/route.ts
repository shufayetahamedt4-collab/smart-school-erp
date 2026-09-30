import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit, guardianChildren, resolveActingStudent } from "@/lib/auth";
import { scopeWhere } from "@/lib/permissions";
import { queryId } from "@/lib/utils";
import { notifyGuardiansOfClass } from "@/lib/notify";

/**
 * Live class sessions — "who is teaching what, right now".
 *
 * The timetable *is* the roster. When the office puts a teacher on a period in
 * the class routine, that period is already the teacher's class: nothing has to
 * be created for them. The teacher portal renders their own periods for today
 * and the teacher makes one tap — Yes ("I'm entering") — then Finish class when
 * the lesson is over. Tapping No records that the period was not taken, so the
 * office can see a class nobody covered.
 *
 * A teacher can still start any class by hand (a relief teacher covering someone
 * else's period, or a class taught outside the routine); that path is unchanged
 * and works exactly as before.
 *
 * The school admin panel and the Parents App read these rows, so the teacher's
 * taps are the single source of truth. A session left open (the teacher forgot
 * to end it) is closed automatically — see LIVE_MAX_MS — so "in class" can never
 * mean "in class since Tuesday". The sweep runs on every read, which keeps a
 * scheduler out of the architecture.
 */

/** The longest a class can plausibly run; anything longer was a missed tap. */
const LIVE_MAX_MS = 4 * 60 * 60 * 1000;
const MANAGEMENT = ["SCHOOL_ADMIN", "BRANCH_ADMIN", "SUPER_ADMIN"];
const CAN_START = ["TEACHER"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const pad = (n: number) => String(n).padStart(2, "0");
const dayKeyOf = (d: Date = new Date()) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** Weekday (0=Sunday) of a YYYY-MM-DD key, parsed in local time. */
const weekdayOf = (dateKey: string) => {
  const [y, m, d] = dateKey.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
};
const clock = (d: Date | string | null | undefined): string | null => {
  if (!d) return null;
  const x = new Date(d);
  return `${pad(x.getHours())}:${pad(x.getMinutes())}`;
};
const minutes = (from: Date | string, to: Date | string) =>
  Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / 60000));

const periodLabelOf = (r: any): string =>
  `Period ${r.period}${r.startTime ? ` · ${r.startTime}–${r.endTime || ""}` : ""}`;

/**
 * Close sessions nobody ended. Called on every read so the board is honest even
 * though nothing schedules it: an open session older than LIVE_MAX_MS gets an
 * end time (now) and the `autoEnded` flag, so the history still shows it and the
 * live board stops claiming the teacher is in a 9-hour lesson.
 */
async function sweepStale(schoolId: string): Promise<number> {
  const cutoff = new Date(Date.now() - LIVE_MAX_MS);
  const stale = await prisma.classSession.findMany({
    where: { schoolId, status: "OPEN", startedAt: { lt: cutoff } },
    select: { id: true },
  });
  if (!stale.length) return 0;
  const now = new Date();
  await prisma.$transaction(
    stale.map((r: any) => prisma.classSession.update({ where: { id: r.id }, data: { status: "CLOSED", endedAt: now, autoEnded: true } }))
  );
  return stale.length;
}

/** Batched id→name lookups shared by sessions and roster rows. */
async function nameMaps(classIds: string[], sectionIds: string[], subjectIds: string[], userIds: string[]) {
  const [classes, sections, subjects, users] = await Promise.all([
    classIds.length ? prisma.classRoom.findMany({ where: { id: { in: classIds } }, select: { id: true, name: true } }) : [],
    sectionIds.length ? prisma.section.findMany({ where: { id: { in: sectionIds } }, select: { id: true, name: true } }) : [],
    subjectIds.length ? prisma.subject.findMany({ where: { id: { in: subjectIds } }, select: { id: true, name: true } }) : [],
    userIds.length ? prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
  ]);
  const by = (list: any[]) => new Map(list.map((r: any) => [r.id, r.name]));
  return { cMap: by(classes), sMap: by(sections), subMap: by(subjects), uMap: by(users) };
}

/** Attach the names every screen shows, in one round of batched reads. */
async function decorate(rows: any[]): Promise<any[]> {
  const ids = (pick: (r: any) => string | null | undefined) =>
    [...new Set(rows.map(pick).filter((v): v is string => !!v))];
  const { cMap, sMap, subMap, uMap } = await nameMaps(
    ids((r) => r.classId),
    ids((r) => r.sectionId),
    ids((r) => r.subjectId),
    ids((r) => r.teacherUserId)
  );

  return rows.map((r) => ({
    ...r,
    className: cMap.get(r.classId) || "—",
    sectionName: r.sectionId ? sMap.get(r.sectionId) || null : null,
    subjectName: r.subjectId ? subMap.get(r.subjectId) || null : null,
    teacherName: uMap.get(r.teacherUserId) || "—",
    startedClock: clock(r.startedAt),
    endedClock: clock(r.endedAt),
    // A declined row has no start; a running one has no end yet.
    durationMin: r.startedAt ? (r.endedAt ? minutes(r.startedAt, r.endedAt) : minutes(r.startedAt, new Date())) : 0,
  }));
}

/**
 * The routine rows that make up a teacher's day. A row is theirs when the
 * routine names them (`teacherId`), or — for schools whose routine editor does
 * not set a teacher per period — when it matches a class+subject they are
 * assigned to. This is the "invisible roster": derived on read, never stored, so
 * editing the routine or the assignments updates it instantly.
 *
 * A section routine overrides the class-wide one for that section, so a
 * class-wide lesson stops being anyone's period once every section of the class
 * has a lesson of its own in that slot.
 */
async function rostersFor(schoolId: string, day: number, teacherIds: string[]): Promise<Map<string, any[]>> {
  const wanted = new Set(teacherIds);
  const byTeacher = new Map<string, any[]>(teacherIds.map((id) => [id, []]));
  const [routines, assignments, sections] = await Promise.all([
    prisma.routine.findMany({ where: { schoolId, day } }),
    prisma.classAssignment.findMany({ where: { schoolId } }),
    prisma.section.findMany({ where: { schoolId }, select: { id: true, classId: true } }),
  ]);

  // A section routine replaces the class-wide one for that section. Once every
  // section of a class overrides a period, the class-wide lesson is nobody's and
  // must not keep a teacher on the board.
  const sectionsOf = new Map<string, string[]>();
  for (const s of sections as any[]) sectionsOf.set(s.classId, [...(sectionsOf.get(s.classId) || []), s.id]);
  const overridden = new Map<string, Set<string>>();
  for (const r of routines as any[]) {
    if (!r.sectionId) continue;
    const key = `${r.classId}|${r.period}`;
    overridden.set(key, (overridden.get(key) || new Set()).add(r.sectionId));
  }
  const classWideAlive = (r: any) => {
    const all = sectionsOf.get(r.classId) || [];
    if (!all.length) return true;
    const covered = overridden.get(`${r.classId}|${r.period}`);
    return !covered || all.some((id) => !covered.has(id));
  };

  const seen = new Set<string>();
  for (const r of routines as any[]) {
    if (!r.sectionId && !classWideAlive(r)) continue;
    const target = (teacherId: string) => {
      // One row per (class, section, period): a class-wide and a section lesson
      // for the same slot must not both appear on a teacher's day.
      const key = `${teacherId}|${r.classId}|${r.sectionId || ""}|${r.period}`;
      if (seen.has(key)) return;
      seen.add(key);
      byTeacher.get(teacherId)!.push(r);
    };
    if (r.teacherId) {
      if (wanted.has(r.teacherId)) target(r.teacherId);
      continue;
    }
    for (const a of assignments as any[]) {
      if (!wanted.has(a.teacherId)) continue;
      if (a.classId !== r.classId || a.subjectId !== r.subjectId) continue;
      // Section must be compatible: either side may be class-wide.
      if (r.sectionId && a.sectionId && r.sectionId !== a.sectionId) continue;
      target(a.teacherId);
    }
  }
  for (const list of byTeacher.values()) {
    list.sort((a: any, b: any) => String(a.startTime || "").localeCompare(String(b.startTime || "")) || (a.period ?? 0) - (b.period ?? 0));
  }
  return byTeacher;
}

/** The signed-in teacher's own profile, or null when the account has none. */
async function myTeacher(session: { id: string }) {
  return prisma.teacher.findUnique({ where: { userId: session.id } });
}

/** Names + period labels for a teacher's routine rows. */
async function decorateRoster(rows: any[]): Promise<any[]> {
  const ids = (pick: (r: any) => string | null | undefined) =>
    [...new Set(rows.map(pick).filter((v): v is string => !!v))];
  const { cMap, sMap, subMap } = await nameMaps(ids((r) => r.classId), ids((r) => r.sectionId), ids((r) => r.subjectId), []);
  return rows.map((r) => ({
    routineId: r.id,
    classId: r.classId,
    sectionId: r.sectionId || null,
    subjectId: r.subjectId || null,
    className: cMap.get(r.classId) || "—",
    sectionName: r.sectionId ? sMap.get(r.sectionId) || null : null,
    subjectName: r.subjectId ? subMap.get(r.subjectId) || null : null,
    period: r.period,
    periodLabel: periodLabelOf(r),
    startTime: r.startTime || null,
    endTime: r.endTime || null,
  }));
}

/** Which scheduled row a session belongs to — by routineId, or by its shape. */
function sessionForRoutine(sessions: any[], routine: any) {
  const byRoutine = sessions.find((s) => s.routineId && s.routineId === routine.routineId);
  if (byRoutine) return byRoutine;
  return sessions.find(
    (s) =>
      !s.routineId &&
      s.classId === routine.classId &&
      (s.sectionId || null) === (routine.sectionId || null) &&
      (s.subjectId || null) === (routine.subjectId || null) &&
      s.periodLabel === routine.periodLabel
  );
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !session.schoolId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId;
  const sp = req.nextUrl.searchParams;
  const view = sp.get("view") || "";
  const date = sp.get("date") && /^\d{4}-\d{2}-\d{2}$/.test(sp.get("date")!) ? sp.get("date")! : dayKeyOf();

  // Self-healing read: a missed "End class" must not keep a teacher "in class".
  await sweepStale(schoolId);

  /* ------------------------------------------------------ the teacher's console */
  if (view === "me") {
    if (session.role !== "TEACHER") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const teacher = await myTeacher(session);
    if (!teacher) return NextResponse.json({ error: "No teacher profile." }, { status: 404 });
    const [rows, rosterByTeacher] = await Promise.all([
      prisma.classSession.findMany({
        where: { schoolId, teacherId: teacher.id, dayKey: date },
        orderBy: { startedAt: "desc" },
        take: 200,
      }),
      rostersFor(schoolId, weekdayOf(date), [teacher.id]),
    ]);
    const decorated = await decorate(rows);
    const roster = await decorateRoster(rosterByTeacher.get(teacher.id) || []);

    // Each scheduled period knows whether it is running, finished, declined or
    // still waiting — the page renders a single row from this.
    const nowClock = clock(new Date()) || "";
    const isLive = date === dayKeyOf();
    const todayRoster = roster.map((r: any) => {
      const s = sessionForRoutine(decorated, r);
      const state = !s ? "upcoming" : s.status === "OPEN" ? "inClass" : s.status === "DECLINED" ? "declined" : "done";
      return {
        ...r,
        state,
        sessionId: s?.id || null,
        startedClock: s?.startedClock || null,
        endedClock: s?.endedClock || null,
        durationMin: s?.status === "CLOSED" ? s.durationMin : 0,
        isNow: isLive && !!r.startTime && !!r.endTime && r.startTime <= nowClock && nowClock <= r.endTime,
      };
    });

    return NextResponse.json({
      data: {
        date,
        weekday: DAYS[weekdayOf(date)] || null,
        active: decorated.find((r: any) => r.status === "OPEN") || null,
        sessions: decorated,
        roster: todayRoster,
        // Sessions with no scheduled period: a relief teacher covering a class,
        // or legacy rows started before the roster existed.
        otherSessions: decorated.filter((s: any) => !s.routineId),
        todayKey: dayKeyOf(),
        liveMaxMinutes: LIVE_MAX_MS / 60000,
      },
    });
  }

  /* --------------------------------------------------- everything "now" (all roles) */
  const open = await prisma.classSession.findMany({
    where: { ...scopeWhere(session), status: "OPEN" },
    orderBy: { startedAt: "asc" },
    take: 200,
  });
  const live = await decorate(open);

  /* --------------------------------------------------- the school admin's monitor */
  if (view === "roster") {
    if (!MANAGEMENT.includes(session.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const scoped = scopeWhere(session);
    const [teachers, teacherUsers, today, leaves] = await Promise.all([
      prisma.teacher.findMany({ where: scoped, select: { id: true, userId: true } }),
      prisma.user.findMany({ where: { ...scoped, role: "TEACHER" }, select: { id: true, name: true, email: true, active: true, photoUrl: true } }),
      prisma.classSession.findMany({ where: { ...scoped, dayKey: date }, orderBy: { startedAt: "desc" }, take: 500 }),
      prisma.leaveRequest.findMany({ where: { ...scoped, type: "TEACHER", status: "APPROVED" } }),
    ]);
    const decorated = await decorate(today);
    const rosterByTeacher = await rostersFor(schoolId, weekdayOf(date), teachers.map((t: any) => t.id));
    const decoratedRosters = new Map<string, any[]>();
    await Promise.all(
      [...rosterByTeacher.entries()].map(async ([tid, rows]) => {
        decoratedRosters.set(tid, await decorateRoster(rows));
      })
    );

    const startOfDay = new Date(`${date}T00:00:00`);
    const endOfDay = new Date(startOfDay.getTime() + 24 * 60 * 60 * 1000);
    const onLeave = new Set(
      leaves
        .filter((l: any) => l.fromDate && l.toDate && new Date(l.fromDate) < endOfDay && new Date(l.toDate) >= startOfDay)
        .map((l: any) => l.teacherId)
    );
    const liveByTeacher = new Map(live.map((s: any) => [s.teacherId, s]));
    const sessionsOf = new Map<string, any[]>();
    for (const s of decorated) sessionsOf.set(s.teacherId, [...(sessionsOf.get(s.teacherId) || []), s]);

    const nowClock = clock(new Date()) || "";
    const isLive = date === dayKeyOf();

    const roster = teacherUsers
      .map((u: any) => {
        const teacher = teachers.find((t: any) => t.userId === u.id);
        const teacherId = teacher?.id || null;
        const mine = teacherId ? sessionsOf.get(teacherId) || [] : [];
        const myRoster = (teacherId ? decoratedRosters.get(teacherId) || [] : []);
        const open = teacherId ? liveByTeacher.get(teacherId) || null : null;
        const closed = mine.filter((s: any) => s.status === "CLOSED");
        const last = (open || closed[0]) || null;
        // What the timetable says they should be teaching now (only timed rows).
        const expected = isLive
          ? myRoster.find((r: any) => r.startTime && r.endTime && r.startTime <= nowClock && nowClock <= r.endTime) || null
          : null;
        const expectedSession = expected ? sessionForRoutine(mine, expected) : null;
        const declinedNow = expectedSession?.status === "DECLINED";
        const declinedToday = mine.filter((s: any) => s.status === "DECLINED").length;
        return {
          teacherId,
          userId: u.id,
          name: u.name || u.email || "—",
          email: u.email || null,
          photoUrl: u.photoUrl || null,
          active: u.active !== false,
          inClass: open,
          expected,
          declinedNow,
          declinedToday,
          // Expected now and nothing recorded for the period: the office should
          // chase this. A period that was held (or declined) is not missing.
          missing: !!expected && !expectedSession && !(teacherId && onLeave.has(teacherId)),
          onLeave: teacherId ? onLeave.has(teacherId) : false,
          sessionsToday: mine.filter((s: any) => s.status !== "DECLINED").length,
          minutesToday: mine.reduce((n: number, s: any) => n + s.durationMin, 0),
          lastEndedClock: last ? last.endedClock || null : null,
        };
      })
      .sort((a: any, b: any) => Number(!!b.inClass) - Number(!!a.inClass) || String(a.name).localeCompare(String(b.name)));

    return NextResponse.json({
      data: {
        date,
        weekday: DAYS[weekdayOf(date)] || null,
        todayKey: dayKeyOf(),
        liveMaxMinutes: LIVE_MAX_MS / 60000,
        live,
        today: decorated,
        roster,
        counts: {
          inClass: roster.filter((r: any) => r.inClass).length,
          expected: roster.filter((r: any) => r.expected).length,
          missing: roster.filter((r: any) => r.missing).length,
          declined: roster.filter((r: any) => r.declinedNow).length,
          free: roster.filter((r: any) => !r.inClass && !r.onLeave).length,
          onLeave: roster.filter((r: any) => r.onLeave).length,
          sessionsToday: decorated.filter((s: any) => s.status !== "DECLINED").length,
        },
      },
    });
  }

  /* -------------------------------------------------------- a parent watching a class */
  if (view === "parent") {
    if (session.role !== "GUARDIAN" && session.role !== "STUDENT") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const requested = queryId(sp, "studentId");
    let child: any = null;
    let sectionId: string | null = null;
    if (session.role === "GUARDIAN") {
      const children = await guardianChildren(session);
      const pick = requested ? children.find((c) => c.id === requested) : children[0];
      child = pick ? { id: pick.id, name: pick.name, classId: pick.classId, sectionId: pick.sectionId } : null;
      sectionId = child?.sectionId ?? null;
    } else {
      const acting = await resolveActingStudent(session, requested);
      child = acting ? { ...acting, sectionId: null } : null;
    }
    if (!child?.classId) {
      return NextResponse.json({ data: { child: child ? { id: child.id, name: child.name } : null, classId: null, live: [], today: [] } });
    }
    const rows = await prisma.classSession.findMany({
      where: { schoolId, classId: child.classId, dayKey: date },
      orderBy: { startedAt: "desc" },
      take: 200,
    });
    const decorated = await decorate(rows);
    // A class's session is the child's class whether or not sections are tracked,
    // but when both sides know the section, honour it.
    const forChild = decorated.filter((s: any) => !sectionId || !s.sectionId || s.sectionId === sectionId);
    return NextResponse.json({
      data: {
        child: { id: child.id, name: child.name },
        classId: child.classId,
        className: forChild.find((s: any) => s.className !== "—")?.className || null,
        date,
        live: forChild.filter((s: any) => s.status === "OPEN"),
        today: forChild,
      },
    });
  }

  /* ------------------------------------------------------------- bare live list */
  return NextResponse.json({ data: { live, todayKey: dayKeyOf() } });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !session.schoolId) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!CAN_START.includes(session.role)) {
    return NextResponse.json({ error: "Only a teacher can start a class." }, { status: 403 });
  }
  const schoolId = session.schoolId;
  const body = await req.json().catch(() => null);
  const action = body?.action === "decline" ? "decline" : "start";
  const routineId = body?.routineId ? String(body.routineId) : null;
  const teacher = await myTeacher(session);
  if (!teacher) return NextResponse.json({ error: "No teacher profile." }, { status: 404 });

  // A scheduled period the teacher is acting on. Validating it first lets the
  // client send just its id — class, section, subject and label come from the
  // timetable, so a teacher cannot mis-file a class by mistake.
  let routine: any = null;
  if (routineId) {
    const today = dayKeyOf();
    const mine = (await rostersFor(schoolId, weekdayOf(today), [teacher.id])).get(teacher.id) || [];
    routine = mine.find((r: any) => r.id === routineId) || null;
    if (!routine) return NextResponse.json({ error: "That period is not on your timetable today." }, { status: 404 });
  }

  const classId = body?.classId ? String(body.classId) : routine?.classId ? String(routine.classId) : "";
  const subjectId = body?.subjectId ? String(body.subjectId) : routine?.subjectId || null;
  const requestedSection = body?.sectionId ? String(body.sectionId) : routine?.sectionId || null;
  const periodLabel = body?.periodLabel ? String(body.periodLabel).slice(0, 60) : routine ? periodLabelOf(routine) : null;
  const note = body?.note ? String(body.note).slice(0, 300) : null;
  if (!classId) return NextResponse.json({ error: "classId is required." }, { status: 400 });

  const now = new Date();
  const todayKey = dayKeyOf(now);

  // A teacher cannot be in two classes at once. Sweep first so a forgotten
  // session from this morning cannot block the afternoon's.
  await sweepStale(schoolId);
  const already = await prisma.classSession.findMany({
    where: { schoolId, teacherId: teacher.id, status: "OPEN", ...(routineId ? { routineId: { not: routineId } } : {}) },
    take: 1,
  });

  /* ----------------------------------------------------------- "No" — not taken */
  if (action === "decline") {
    const existing = await prisma.classSession.findFirst({
      where: { schoolId, teacherId: teacher.id, dayKey: todayKey, routineId },
    });
    // Declining never conflicts with a running class: a teacher may be in one
    // room and say they are not taking another period.
    if (existing) {
      const updated = await prisma.classSession.update({
        where: { id: existing.id },
        data: { status: "DECLINED", startedAt: null, endedAt: null, declinedAt: now, autoEnded: false, endedBy: null },
      });
      await audit("CLASS_DECLINE", "classSession", updated.id, { routineId, classId, status: "DECLINED" });
      return NextResponse.json({ data: (await decorate([updated]))[0] });
    }
    const created = await prisma.classSession.create({
      data: {
        schoolId,
        teacherId: teacher.id,
        teacherUserId: session.id,
        teacherName: session.name || teacher.name || null,
        classId,
        sectionId: requestedSection || null,
        subjectId: subjectId || null,
        periodLabel,
        routineId,
        note,
        startedAt: null,
        endedAt: null,
        declinedAt: now,
        status: "DECLINED",
        dayKey: todayKey,
        autoEnded: false,
      },
    });
    await audit("CLASS_DECLINE", "classSession", created.id, { routineId, classId, status: "DECLINED" });
    return NextResponse.json({ data: (await decorate([created]))[0] }, { status: 201 });
  }

  if (already.length) {
    return NextResponse.json(
      { error: "You already have a class in progress — end it before starting another.", data: (await decorate(already))[0] },
      { status: 409 }
    );
  }

  const [classRoom, subject] = await Promise.all([
    prisma.classRoom.findUnique({ where: { id: classId } }),
    subjectId ? prisma.subject.findUnique({ where: { id: subjectId } }) : Promise.resolve(null),
  ]);
  if (!classRoom || classRoom.schoolId !== schoolId) {
    return NextResponse.json({ error: "Class not found" }, { status: 404 });
  }
  if (subjectId && (!subject || subject.schoolId !== schoolId)) {
    return NextResponse.json({ error: "Subject not found" }, { status: 404 });
  }
  let sectionId = requestedSection;
  if (sectionId) {
    const section = await prisma.section.findUnique({ where: { id: sectionId } });
    if (!section || section.schoolId !== schoolId) {
      return NextResponse.json({ error: "Section not found" }, { status: 404 });
    }
  }

  // Starting a scheduled period reuses today's row for it, so a decline is
  // undone in one tap and a re-start does not leave two rows behind.
  if (routineId) {
    const existing = await prisma.classSession.findFirst({
      where: { schoolId, teacherId: teacher.id, dayKey: todayKey, routineId },
    });
    // Already running? Return it — tapping Yes again must not add a second row.
    if (existing && existing.status === "OPEN") {
      return NextResponse.json({ data: (await decorate([existing]))[0] });
    }
    if (existing && existing.status !== "OPEN") {
      const updated = await prisma.classSession.update({
        where: { id: existing.id },
        data: {
          status: "OPEN",
          classId,
          sectionId: sectionId || null,
          subjectId: subjectId || null,
          periodLabel,
          note,
          startedAt: now,
          endedAt: null,
          declinedAt: null,
          autoEnded: false,
          endedBy: null,
        },
      });
      await audit("CLASS_START", "classSession", updated.id, { classId, subjectId, sectionId: sectionId || null, routineId });
      await notifyClassStarted(schoolId, session.id, {
        classRoom,
        subjectName: subject?.name || null,
        sectionId: sectionId || null,
        periodLabel,
      });
      return NextResponse.json({ data: (await decorate([updated]))[0] });
    }
  }

  const created = await prisma.classSession.create({
    data: {
      schoolId,
      teacherId: teacher.id,
      teacherUserId: session.id,
      teacherName: session.name || teacher.name || null,
      classId,
      sectionId: sectionId || null,
      subjectId: subjectId || null,
      periodLabel,
      routineId,
      note,
      startedAt: now,
      endedAt: null,
      status: "OPEN",
      dayKey: todayKey,
      autoEnded: false,
    },
  });
  await audit("CLASS_START", "classSession", created.id, { classId, subjectId, sectionId: sectionId || null, routineId });
  await notifyClassStarted(schoolId, session.id, {
    classRoom,
    subjectName: subject?.name || null,
    sectionId: sectionId || null,
    periodLabel,
  });
  return NextResponse.json({ data: (await decorate([created]))[0] }, { status: 201 });
}

/**
 * Tell the families whose class just went live. Fire-and-forget — a classroom
 * tap must never fail because a notification could not be written.
 */
async function notifyClassStarted(
  schoolId: string,
  actorId: string,
  info: { classRoom: any; subjectName: string | null; sectionId: string | null; periodLabel: string | null }
) {
  const label = info.subjectName ? `${info.subjectName} — ${info.classRoom?.name || "class"}` : info.classRoom?.name || "class";
  await notifyGuardiansOfClass(
    schoolId,
    { classId: info.classRoom?.id, sectionId: info.sectionId },
    {
      event: "CLASS_STARTED",
      title: `${label} is in progress`,
      body: info.periodLabel ? `${info.periodLabel} — the class has started.` : "The class has started.",
      link: "/parent/live-classes",
      excludeUserId: actorId,
    }
  ).catch(() => null);
}
