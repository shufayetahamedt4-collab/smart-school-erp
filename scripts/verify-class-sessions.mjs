/**
 * Live class sessions — the teacher's Start/End taps become the school's live board.
 *
 * Verified here, against a running server:
 *   1. a teacher starts a class and it is immediately visible to the office
 *      board and to the parent of the child in that class;
 *   2. a teacher cannot start a second class while one is open (the office would
 *      otherwise show two rooms at once);
 *   3. ending closes it, the live board drops it, and the day's history keeps it
 *      with a duration; ending twice is refused;
 *   4. a session nobody ended is closed automatically after four hours, so "in
 *      class" can never mean "in class since Tuesday";
 *   5. an admin can end a stuck session; a guardian cannot start one, and an
 *      unknown class is refused.
 *
 * Everything it creates is removed again by document reference, reading each doc
 * back. Usage: node scripts/verify-class-sessions.mjs   (SMOKE_PORT, default 3000)
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

import { installHostFetch } from "./lib/hostfetch.mjs";

// Integration 5a — a `Host:` header on fetch is a fetch-spec forbidden name and
// was silently dropped, so every host-scoped request below reached the hub.
// Those requests now go through node:http, which delivers the header for real.
// This changes request DELIVERY only: no assertion, expectation or fixture moved.
installHostFetch();

loadEnv();
requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const SCHOOL_HOST = `school.localhost:${PORT}`;
const TEACHER_HOST = `teacher.localhost:${PORT}`;
const PARENTS_HOST = `parents.localhost:${PORT}`;

const ADMIN = { id: "principal@sunrise.edu", pw: "School@123" };
const TEACHER = { id: "teacher@sunrise.edu", pw: "Teacher@123" };
const GUARDIAN = { id: "guardian1@demo.com", pw: "Guardian@123" };

let failures = 0;
let skipped = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const skip = (label, why) => {
  console.log(`  SKIP  ${label} — ${why}`);
  skipped++;
};

/* ----------------------------------------------------------------- firebase */
function unescapeKey(k) {
  const BS = String.fromCharCode(92);
  return k.includes(BS + "n") ? k.split(BS + "n").join("\n") : k;
}

// Inside the emulator (FIRESTORE_EMULATOR_HOST — the guard above guarantees it is
// loopback) the emulator needs no credentials, so never build a cert() from
// possibly absent ones: initialise with the project id alone, exactly as
// scripts/seed.mjs does. Outside it, the credentials are used as before.
const emulatorMode = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

if (!getApps().length) {
  if (emulatorMode) {
    initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
  } else {
    initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID,
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: unescapeKey(process.env.FIREBASE_PRIVATE_KEY || ""),
      }),
    });
  }
}
const db = getFirestore();

/* --------------------------------------------------------------------- http */
async function req(host, path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Host: host,
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers || {}),
    },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null };
}

/** Login that keeps the raw set-cookie (the shared helper drops headers). */
async function signIn(host, { id, pw }) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { Host: host, "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: id, password: pw }),
    signal: AbortSignal.timeout(60000),
  });
  const jar = (res.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  return { status: res.status, cookie: jar };
}

const created = [];
const createdRoutines = [];
// Starting a class now notifies the families (PRD §13), so this run leaves real
// notifications behind unless it removes them again — and a stale "class in
// progress" in a parent's bell is worse than no notification at all.
const runStart = new Date();
const DEMO_SCHOOL = "s_54bf3dc2c4f98fabdf78b7216c0ae888455d009a";
async function cleanup() {
  for (const id of created) await db.collection("classSessions").doc(id).delete().catch(() => {});
  for (const id of createdRoutines) await db.collection("routines").doc(id).delete().catch(() => {});
  // Drop the class-start notifications this run raised (created after runStart).
  const notifRows = await db.collection("notifications").where("schoolId", "==", DEMO_SCHOOL).get();
  for (const d of notifRows.docs) {
    const ts = d.get("createdAt");
    if (ts && new Date(ts.toDate ? ts.toDate() : ts).getTime() >= runStart.getTime()) await d.ref.delete().catch(() => {});
  }
  const left = [];
  for (const id of created) {
    if ((await db.collection("classSessions").doc(id).get()).exists) left.push(`session ${id}`);
  }
  for (const id of createdRoutines) {
    if ((await db.collection("routines").doc(id).get()).exists) left.push(`routine ${id}`);
  }
  return left;
}

/* ============================================================ the sweep */
console.log(`\n=== live class sessions (http://127.0.0.1:${PORT}) ===\n`);

const admin = await signIn(SCHOOL_HOST, ADMIN);
const teacher = await signIn(TEACHER_HOST, TEACHER);
const guardian = await signIn(PARENTS_HOST, GUARDIAN);
check("three roles sign in", admin.status === 200 && teacher.status === 200 && guardian.status === 200, `admin ${admin.status} · teacher ${teacher.status} · guardian ${guardian.status}`);
if (admin.status !== 200 || teacher.status !== 200) {
  console.log("\nCannot continue without admin and teacher sessions.");
  process.exit(1);
}

/* --------------------------------------------- 0. pre-flight: clear a stuck class */
// A class left open by an earlier run (or a real teacher who forgot to finish)
// would block every start below, so the run begins from a clean console.
{
  const me = await req(TEACHER_HOST, "/api/class-sessions?view=me", { cookie: teacher.cookie });
  if (me.data?.active?.id) {
    const ended = await req(TEACHER_HOST, `/api/class-sessions/${me.data.active.id}`, { cookie: teacher.cookie, method: "PATCH", body: JSON.stringify({}) });
    check("a stuck open class from an earlier run was closed", ended.status === 200, `${me.data.active.id} → HTTP ${ended.status}`);
  } else {
    check("the teacher starts the run with no open class", true, "clean console");
  }
}

/* ------------------------------------------- 1. everything a class start needs */
{
  const anon = await req(SCHOOL_HOST, "/api/class-sessions");
  check("a signed-out visitor gets nothing", anon.status === 401, `HTTP ${anon.status}`);

  const guardianStart = await req(PARENTS_HOST, "/api/class-sessions", {
    cookie: guardian.cookie,
    method: "POST",
    body: JSON.stringify({ classId: "whatever" }),
  });
  check("a guardian cannot start a class", guardianStart.status === 403, `HTTP ${guardianStart.status} ${guardianStart.error || ""}`);

  const noClass = await req(TEACHER_HOST, "/api/class-sessions", {
    cookie: teacher.cookie,
    method: "POST",
    body: JSON.stringify({}),
  });
  check("a start with no class is refused", noClass.status === 400, `HTTP ${noClass.status} ${noClass.error || ""}`);

  const bogus = await req(TEACHER_HOST, "/api/class-sessions", {
    cookie: teacher.cookie,
    method: "POST",
    body: JSON.stringify({ classId: "zzcs-not-a-class" }),
  });
  check("a start against an unknown class is refused", bogus.status === 404, `HTTP ${bogus.status} ${bogus.error || ""}`);
}

/* ------------------------------------------------- 2. the teacher's own console */
const classes = (await req(SCHOOL_HOST, "/api/classes", { cookie: admin.cookie })).data || [];
const classList = Array.isArray(classes) ? classes : classes.classes || [];
const classId = classList[0]?.id;
if (!classId) {
  console.log("\nNo classes in the demo school — cannot continue.");
  process.exit(1);
}

{
  const me = await req(TEACHER_HOST, "/api/class-sessions?view=me", { cookie: teacher.cookie });
  check("the teacher's console loads", me.status === 200 && me.data && Array.isArray(me.data.sessions), `HTTP ${me.status}`);
  check("nothing is live at the start", !me.data?.active, me.data?.active ? `open: ${me.data.active.id}` : "no open session");
}

/* ------------------------------------------------------------ 3. start a class */
let session = null;
{
  const res = await req(TEACHER_HOST, "/api/class-sessions", {
    cookie: teacher.cookie,
    method: "POST",
    body: JSON.stringify({ classId }),
  });
  session = res.data;
  if (res.status === 201) created.push(session.id);
  check("the teacher starts a class", res.status === 201, `HTTP ${res.status} ${res.error || ""}`);
  check("the session is open and named", session?.status === "OPEN" && !!session?.className && !!session?.teacherName, `${session?.className || "?"} · ${session?.teacherName || "?"}`);
  check("the start carries a clock time", /^\d{2}:\d{2}$/.test(session?.startedClock || ""), session?.startedClock || "none");

  const dup = await req(TEACHER_HOST, "/api/class-sessions", {
    cookie: teacher.cookie,
    method: "POST",
    body: JSON.stringify({ classId }),
  });
  check("a second class cannot start while one is open", dup.status === 409, `HTTP ${dup.status} ${dup.error || ""}`);
  check("the refusal names the open session", dup.data?.id === session?.id, dup.data?.id || "none");

  const me = await req(TEACHER_HOST, "/api/class-sessions?view=me", { cookie: teacher.cookie });
  check("the console shows the live class", me.data?.active?.id === session?.id, me.data?.active?.className || "none");
}

/* ------------------------------------------- 4. the office board + the parent */
{
  const roster = await req(SCHOOL_HOST, "/api/class-sessions?view=roster", { cookie: admin.cookie });
  check("the office board loads", roster.status === 200 && !!roster.data?.counts, `HTTP ${roster.status}`);
  check("the live class is on the board", (roster.data?.live || []).some((s) => s.id === session.id), `${roster.data?.counts?.inClass ?? "?"} in class`);
  const row = (roster.data?.roster || []).find((r) => r.inClass?.id === session.id);
  check("the teacher is marked in class", !!row, row ? `${row.name} — ${row.inClass.className}` : "not found");
}

{
  const bare = await req(SCHOOL_HOST, "/api/class-sessions", { cookie: admin.cookie });
  check("the bare live list works for any staff role", bare.status === 200 && (bare.data?.live || []).some((s) => s.id === session.id), `HTTP ${bare.status}`);
}

{
  const siblings = (await req(PARENTS_HOST, "/api/parent/siblings", { cookie: guardian.cookie })).data || [];
  let seen = null;
  for (const kid of siblings) {
    const view = await req(PARENTS_HOST, `/api/class-sessions?view=parent&studentId=${encodeURIComponent(kid.id)}`, { cookie: guardian.cookie });
    if (view.data?.live?.some((s) => s.id === session.id)) {
      seen = { kid, view };
      break;
    }
  }
  if (seen) {
    check("a parent sees the class in progress", true, `${seen.kid.name} — ${seen.view.data.live[0].subjectName || seen.view.data.live[0].className}`);
    check("the parent view names the teacher", !!seen.view.data.live[0].teacherName, seen.view.data.live[0].teacherName);
  } else {
    skip("a parent sees the class in progress", `no demo child is in ${session.className}`);
  }
}

/* ---------------------------------------------------------------- 5. end it */
{
  const res = await req(TEACHER_HOST, `/api/class-sessions/${session.id}`, { cookie: teacher.cookie, method: "PATCH", body: JSON.stringify({}) });
  check("the teacher ends the class", res.status === 200 && res.data?.status === "CLOSED", `HTTP ${res.status} ${res.error || ""}`);
  check("the end carries a duration", typeof res.data?.durationMin === "number" && res.data.durationMin >= 0, `${res.data?.durationMin} min`);

  const again = await req(TEACHER_HOST, `/api/class-sessions/${session.id}`, { cookie: teacher.cookie, method: "PATCH", body: JSON.stringify({}) });
  check("ending twice is refused", again.status === 409, `HTTP ${again.status} ${again.error || ""}`);

  const me = await req(TEACHER_HOST, "/api/class-sessions?view=me", { cookie: teacher.cookie });
  check("the console shows nothing live", !me.data?.active, "no open session");
  check("the class is in today's history", (me.data?.sessions || []).some((s) => s.id === session.id && s.status === "CLOSED"), "recorded");

  const roster = await req(SCHOOL_HOST, "/api/class-sessions?view=roster", { cookie: admin.cookie });
  check("the board drops the finished class", !(roster.data?.live || []).some((s) => s.id === session.id), "not live");
  check("the day's log keeps it", (roster.data?.today || []).some((s) => s.id === session.id && s.status === "CLOSED"), "in the log");
}

/* ---------------------------------------- 6. a missed "End" cannot stay live */
{
  const staleId = `zzcs-stale-${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date(Date.now() - 5 * 60 * 60 * 1000);
  const p = (n) => String(n).padStart(2, "0");
  await db.collection("classSessions").doc(staleId).set({
    id: staleId,
    schoolId: session.schoolId,
    teacherId: session.teacherId,
    teacherUserId: session.teacherUserId,
    classId,
    sectionId: null,
    subjectId: null,
    startedAt,
    endedAt: null,
    status: "OPEN",
    dayKey: `${startedAt.getFullYear()}-${p(startedAt.getMonth() + 1)}-${p(startedAt.getDate())}`,
    autoEnded: false,
  });
  created.push(staleId);

  // The app memoizes school collection pulls for ~30s (DB_READ_CACHE_MS), and
  // this doc was written around the app, so the sweep only sees it once the memo
  // expires. Poll for the sweep instead of asserting on a stale snapshot.
  let doc = null;
  const began = Date.now();
  for (let tries = 0; tries < 18; tries++) {
    await req(SCHOOL_HOST, "/api/class-sessions?view=roster", { cookie: admin.cookie });
    doc = (await db.collection("classSessions").doc(staleId).get()).data();
    if (doc?.status === "CLOSED") break;
    await new Promise((r) => setTimeout(r, 5000));
  }
  const waited = Math.round((Date.now() - began) / 1000);
  check("a five-hour-old open class is closed automatically", doc?.status === "CLOSED", `status ${doc?.status} after ${waited}s`);
  check("the auto-close is flagged as such", doc?.autoEnded === true, String(doc?.autoEnded));

  const after = await req(SCHOOL_HOST, "/api/class-sessions?view=roster", { cookie: admin.cookie });
  check("a forgotten class is never shown live", !(after.data?.live || []).some((s) => s.id === staleId), "not live");
}

/* ------------------------------------- 7. an admin can end a stuck session */
{
  const start = await req(TEACHER_HOST, "/api/class-sessions", {
    cookie: teacher.cookie,
    method: "POST",
    body: JSON.stringify({ classId, subjectId: session.subjectId || undefined }),
  });
  const second = start.data;
  if (start.status === 201) created.push(second.id);
  check("the teacher starts another class", start.status === 201, `HTTP ${start.status} ${start.error || ""}`);

  const forced = await req(SCHOOL_HOST, `/api/class-sessions/${second.id}`, { cookie: admin.cookie, method: "PATCH", body: JSON.stringify({}) });
  check("an admin can end a stuck class", forced.status === 200 && forced.data?.status === "CLOSED", `HTTP ${forced.status} ${forced.error || ""}`);
  check("the admin end is recorded as the office", forced.data?.endedBy === "SCHOOL_ADMIN", String(forced.data?.endedBy));
}

/* ------------------------- 8. the timetable is the roster (Yes / No / undo) */
// A teacher's day is derived from the class routine: adding a period for the
// teacher today must make it appear on their console with no extra step, and a
// Yes/No tap must be the only input. To test this without disturbing the demo
// routine, we write a throwaway period for the demo teacher (period 99, timed
// around now) and remove it afterwards.
{
  const teacherId = session.teacherId;
  const schoolId = session.schoolId;
  const subjectSnap = await db.collection("subjects").where("schoolId", "==", schoolId).limit(1).get();
  const subjectId = subjectSnap.docs[0]?.id || null;
  const now = new Date();
  const hm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const routineId = `zzcs-routine-${Math.random().toString(36).slice(2, 8)}`;
  const start = new Date(now.getTime() - 5 * 60 * 1000);
  const end = new Date(now.getTime() + 30 * 60 * 1000);

  if (!subjectId) {
    skip("the timetable roster", "no subjects in the demo school");
  } else {
    await db.collection("routines").doc(routineId).set({
      id: routineId,
      schoolId,
      classId,
      sectionId: null,
      subjectId,
      teacherId,
      day: now.getDay(),
      period: 99,
      startTime: hm(start),
      endTime: hm(end),
    });
    createdRoutines.push(routineId);

    // The app memoizes routine pulls ~30s, and this row was written around the
    // app — poll until the console sees it instead of asserting on a stale read.
    let row = null;
    for (let tries = 0; tries < 18; tries++) {
      const me = await req(TEACHER_HOST, "/api/class-sessions?view=me", { cookie: teacher.cookie });
      row = (me.data?.roster || []).find((r) => r.routineId === routineId) || null;
      if (row) break;
      await new Promise((r) => setTimeout(r, 5000));
    }

    check("a period added to the routine appears on the teacher's console", !!row, row ? `${row.className} · ${row.periodLabel}` : "never appeared");
    check("the scheduled period carries its subject and is flagged as now", !!row?.subjectName && row?.isNow === true, `${row?.subjectName || "?"} · now=${row?.isNow}`);
    check("a period with no tap is waiting", row?.state === "upcoming", `state ${row?.state}`);

    // The office sees the timetable expectation before any tap happens.
    const before = await req(SCHOOL_HOST, "/api/class-sessions?view=roster", { cookie: admin.cookie });
    const beforeRow = (before.data?.roster || []).find((r) => r.teacherId === teacherId);
    check("the office board expects the teacher now", beforeRow?.expected?.routineId === routineId, beforeRow?.expected?.periodLabel || "no expectation");
    check("an untapped expected period is flagged not started", beforeRow?.missing === true && beforeRow?.declinedNow === false, `missing=${beforeRow?.missing}`);

    // Yes — one tap to start the scheduled class.
    const yes = await req(TEACHER_HOST, "/api/class-sessions", {
      cookie: teacher.cookie,
      method: "POST",
      body: JSON.stringify({ routineId }),
    });
    const yesSession = yes.data;
    if (yesSession?.id) created.push(yesSession.id);
    check("Yes starts the scheduled class", (yes.status === 201 || yes.status === 200) && yesSession?.status === "OPEN", `HTTP ${yes.status} ${yes.error || ""}`);
    check("the client only had to send the period id", yesSession?.classId === classId && !!yesSession?.subjectName, `${yesSession?.className || "?"} · ${yesSession?.subjectName || "?"}`);
    check("the started class is filed against the period", yesSession?.routineId === routineId, yesSession?.routineId || "none");

    const meLive = await req(TEACHER_HOST, "/api/class-sessions?view=me", { cookie: teacher.cookie });
    const liveRow = (meLive.data?.roster || []).find((r) => r.routineId === routineId);
    check("the console shows it running", liveRow?.state === "inClass", `state ${liveRow?.state}`);

    const boardLive = await req(SCHOOL_HOST, "/api/class-sessions?view=roster", { cookie: admin.cookie });
    const boardLiveRow = (boardLive.data?.roster || []).find((r) => r.teacherId === teacherId);
    check("the office board sees the teacher in class", boardLiveRow?.inClass?.id === yesSession?.id, boardLiveRow?.inClass?.className || "not in class");
    check("once started it is no longer 'not started'", boardLiveRow?.missing === false, `missing=${boardLiveRow?.missing}`);

    // Tapping Yes twice must not open a second class.
    const yesAgain = await req(TEACHER_HOST, "/api/class-sessions", {
      cookie: teacher.cookie,
      method: "POST",
      body: JSON.stringify({ routineId }),
    });
    check("tapping Yes again reuses the same class", yesAgain.data?.id === yesSession?.id && yesAgain.data?.status === "OPEN", `HTTP ${yesAgain.status}`);

    // No — the period was not taken, and the office can see it.
    const no = await req(TEACHER_HOST, "/api/class-sessions", {
      cookie: teacher.cookie,
      method: "POST",
      body: JSON.stringify({ action: "decline", routineId }),
    });
    check("No records the period as not taken", no.data?.status === "DECLINED" && no.data?.startedAt === null, `status ${no.data?.status}`);
    check("No keeps the same row (no duplicate)", no.data?.id === yesSession?.id, no.data?.id || "none");

    const meDeclined = await req(TEACHER_HOST, "/api/class-sessions?view=me", { cookie: teacher.cookie });
    const declinedRow = (meDeclined.data?.roster || []).find((r) => r.routineId === routineId);
    check("the console shows the period as not taken", declinedRow?.state === "declined", `state ${declinedRow?.state}`);
    check("nothing is live after No", !meDeclined.data?.active, "no open session");

    const boardDeclined = await req(SCHOOL_HOST, "/api/class-sessions?view=roster", { cookie: admin.cookie });
    const boardDeclinedRow = (boardDeclined.data?.roster || []).find((r) => r.teacherId === teacherId);
    check("the office board marks the period declined", boardDeclinedRow?.declinedNow === true, `declinedNow=${boardDeclinedRow?.declinedNow}`);

    const endDeclined = await req(TEACHER_HOST, `/api/class-sessions/${yesSession.id}`, { cookie: teacher.cookie, method: "PATCH", body: JSON.stringify({}) });
    check("a declined period cannot be ended", endDeclined.status === 409 && /not taken/i.test(endDeclined.error || ""), `HTTP ${endDeclined.status} ${endDeclined.error || ""}`);

    // Undo — Yes after No puts the class back on.
    const undo = await req(TEACHER_HOST, "/api/class-sessions", {
      cookie: teacher.cookie,
      method: "POST",
      body: JSON.stringify({ routineId }),
    });
    check("Yes after No reopens the class", undo.data?.status === "OPEN" && undo.data?.id === yesSession?.id, `status ${undo.data?.status}`);

    // Finish.
    const finished = await req(TEACHER_HOST, `/api/class-sessions/${yesSession.id}`, { cookie: teacher.cookie, method: "PATCH", body: JSON.stringify({}) });
    check("Finish closes the scheduled class", finished.status === 200 && finished.data?.status === "CLOSED", `HTTP ${finished.status} ${finished.error || ""}`);

    const doneBoard = await req(SCHOOL_HOST, "/api/class-sessions?view=roster", { cookie: admin.cookie });
    const doneRow = (doneBoard.data?.roster || []).find((r) => r.teacherId === teacherId);
    check("a finished period is no longer flagged missing", doneRow?.missing === false, `missing=${doneRow?.missing}`);
  }

  // A period that belongs to another teacher cannot be started by this one.
  const otherTeacher = (await db.collection("teachers").where("schoolId", "==", schoolId).get()).docs
    .map((d) => d.id)
    .find((id) => id !== teacherId);
  if (otherTeacher) {
    const foreignRoutineId = `zzcs-foreign-${Math.random().toString(36).slice(2, 8)}`;
    await db.collection("routines").doc(foreignRoutineId).set({
      id: foreignRoutineId,
      schoolId,
      classId,
      sectionId: null,
      subjectId: subjectId || "zzcs-none",
      teacherId: otherTeacher,
      day: now.getDay(),
      period: 98,
      startTime: hm(start),
      endTime: hm(end),
    });
    createdRoutines.push(foreignRoutineId);
    let forged = null;
    for (let tries = 0; tries < 18; tries++) {
      const res = await req(TEACHER_HOST, "/api/class-sessions", {
        cookie: teacher.cookie,
        method: "POST",
        body: JSON.stringify({ routineId: foreignRoutineId }),
      });
      forged = res;
      if (res.status === 404) break;
      if (res.status !== 201) break;
      // It resolved (memo had not yet seen the row); end it and retry once visible.
      if (res.data?.id) created.push(res.data.id);
      await req(TEACHER_HOST, `/api/class-sessions/${res.data.id}`, { cookie: teacher.cookie, method: "PATCH", body: JSON.stringify({}) });
      await new Promise((r) => setTimeout(r, 5000));
    }
    check("a period that is not yours cannot be started", forged?.status === 404, `HTTP ${forged?.status} ${forged?.error || ""}`);
  } else {
    skip("a period that is not yours cannot be started", "only one teacher in the demo school");
  }
}

/* ------------------------------------------------------------- 9. cleanup */
{
  const left = await cleanup();
  check("probe sessions and periods removed", left.length === 0, left.length ? left.join(", ") : `${created.length} session(s), ${createdRoutines.length} period(s) removed`);
}

console.log(failures ? `\n❌ verify-class-sessions: ${failures} failure(s)${skipped ? `, ${skipped} skipped` : ""}\n` : `\n✅ verify-class-sessions: ALL GREEN${skipped ? ` (${skipped} skipped)` : ""}\n`);
process.exit(failures ? 1 : 0);
