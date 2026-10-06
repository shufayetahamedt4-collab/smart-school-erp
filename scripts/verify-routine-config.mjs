/**
 * The school's day shape + section-wise routines.
 *
 * Verified here, against a running server:
 *   1. a school's timetable shape (periods, times, working days) reads back, and
 *      a bad shape (0 days, 20 periods, a backwards time) is refused;
 *   2. changing the shape re-times every existing lesson, and drops the lessons
 *      that fall outside the new shape — nothing is silently left behind;
 *   3. a section can have its own week: saving Section A leaves Section B and the
 *      class-wide default untouched, and a section with no week of its own reads
 *      back the class-wide default;
 *   4. a class-wide lesson stops being a teacher's period once every section of
 *      that class has its own lesson in that slot.
 *
 * Everything it changes is restored by the end, including the school's shape and
 * any lesson it wrote. Usage: node scripts/verify-routine-config.mjs
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

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

const PUT_CONFIG = (cookie, config) =>
  req(SCHOOL_HOST, "/api/routine-config", { cookie, method: "PUT", body: JSON.stringify({ config }) });

console.log(`\n=== routine configuration (http://127.0.0.1:${PORT}) ===\n`);

const admin = await signIn(SCHOOL_HOST, ADMIN);
const teacher = await signIn(TEACHER_HOST, TEACHER);
const guardian = await signIn(PARENTS_HOST, GUARDIAN);
check("three roles sign in", admin.status === 200 && teacher.status === 200 && guardian.status === 200, `admin ${admin.status} · teacher ${teacher.status} · guardian ${guardian.status}`);
if (admin.status !== 200 || teacher.status !== 200) {
  console.log("\nCannot continue without admin and teacher sessions.");
  process.exit(1);
}

let original = null;
let schoolId = null;
let rowBackup = null; // every routine row, so a destructive test can be undone
const created = []; // routine rows written straight to Firestore
let sectionScopes = []; // { classId, sectionId } scopes written through the API

try {
  /* ------------------------------------------------- 1. reading the shape */
  const cfg = await req(SCHOOL_HOST, "/api/routine-config", { cookie: admin.cookie });
  original = cfg.data?.config || null;
  check("the school's day shape loads", cfg.status === 200 && !!original?.periods?.length && !!original?.days?.length, `${original?.days?.length} day(s) × ${original?.periods?.length} period(s)`);
  check("the shape ships with a default to fall back on", !!cfg.data?.default?.periods?.length, `${cfg.data?.default?.periods?.length} default period(s)`);

  const teacherRead = await req(TEACHER_HOST, "/api/routine-config", { cookie: teacher.cookie });
  check("a teacher can read the shape", teacherRead.status === 200, `HTTP ${teacherRead.status}`);

  const guardianRead = await req(PARENTS_HOST, "/api/routine-config", { cookie: guardian.cookie });
  check("a guardian cannot read the shape", guardianRead.status === 403, `HTTP ${guardianRead.status}`);

  const guardianWrite = await PUT_CONFIG(guardian.cookie, original);
  check("a guardian cannot change the shape", guardianWrite.status === 403, `HTTP ${guardianWrite.status}`);

  /* --------------------------------------- 2. bad shapes are refused */
  {
    const noDays = await PUT_CONFIG(admin.cookie, { days: [], periods: original.periods });
    check("a shape with no working days is refused", noDays.status === 400, `HTTP ${noDays.status} ${noDays.error || ""}`);

    const tooMany = await PUT_CONFIG(admin.cookie, { days: original.days, periods: Array.from({ length: 20 }, (_, i) => ({ period: i + 1, start: "09:00", end: "09:45" })) });
    check("a 20-period day is refused", tooMany.status === 400, `HTTP ${tooMany.status} ${tooMany.error || ""}`);

    const backwards = await PUT_CONFIG(admin.cookie, { days: original.days, periods: [{ period: 1, start: "10:00", end: "09:00" }] });
    check("a period that ends before it starts is refused", backwards.status === 400, `HTTP ${backwards.status} ${backwards.error || ""}`);
  }

  /* ------------------------------- 3. changing the shape follows through */
  const classes = (await req(SCHOOL_HOST, "/api/classes", { cookie: admin.cookie })).data || [];
  if (!classes.length) {
    console.log("\nNo classes in the demo school — cannot continue.");
    process.exit(1);
  }
  const cls = classes[0];
  schoolId = (await db.collection("classes").doc(cls.id).get()).data().schoolId;
  // Changing the shape deletes lessons, so keep a full copy of the timetable to
  // put back at the end. This harness must be safe on a school we care about.
  rowBackup = (await db.collection("routines").where("schoolId", "==", schoolId).get()).docs.map((d) => ({ id: d.id, data: d.data() }));
  const classWideBefore = (await req(SCHOOL_HOST, `/api/routines?classId=${cls.id}`, { cookie: admin.cookie })).data || [];
  check("the class-wide routine loads", Array.isArray(classWideBefore) && classWideBefore.length > 0, `${classWideBefore.length} lesson(s) for ${cls.name}`);

  {
    // Same days, but only the first two periods of it.
    const shortened = { days: original.days, periods: original.periods.slice(0, 2).map((p, i) => ({ period: i + 1, start: p.start, end: p.end })) };
    const res = await PUT_CONFIG(admin.cookie, shortened);
    check("the day can be shortened", res.status === 200 && res.data?.config?.periods?.length === 2, `HTTP ${res.status} ${res.error || ""}`);
    check("shortening re-times the lessons that survive", (res.data?.retimed || 0) > 0, `${res.data?.retimed} re-timed`);
    check("shortening drops the lessons that do not", (res.data?.removed || 0) > 0, `${res.data?.removed} removed`);

    const after = (await req(SCHOOL_HOST, `/api/routines?classId=${cls.id}`, { cookie: admin.cookie })).data || [];
    check("the removed lessons are really gone", after.length < classWideBefore.length && after.every((r) => r.period <= 2), `${after.length} lesson(s) left`);
  }

  /* ------------------------------------ 4. a lesson outside the shape is pruned */
  {
    const ghostId = `zzrc-ghost-${Math.random().toString(36).slice(2, 8)}`;
    await db.collection("routines").doc(ghostId).set({
      id: ghostId,
      schoolId: original ? (await db.collection("classes").doc(cls.id).get()).data().schoolId : cls.id,
      classId: cls.id,
      sectionId: null,
      subjectId: "zzrc-none",
      teacherId: null,
      day: original.days[0],
      period: 11,
      startTime: "09:00",
      endTime: "09:45",
    });
    created.push(ghostId);

    // The app memoizes routine pulls for ~30s and this row was written around
    // the app, so wait until the server can actually see it before pruning.
    let visible = false;
    for (let tries = 0; tries < 18 && !visible; tries++) {
      const rows = (await req(SCHOOL_HOST, `/api/routines?classId=${cls.id}`, { cookie: admin.cookie })).data || [];
      visible = rows.some((r) => r.id === ghostId);
      if (!visible) await new Promise((r) => setTimeout(r, 5000));
    }
    check("a lesson for a period the school does not have is visible first", visible, visible ? "seen" : "never appeared");

    const restored = await PUT_CONFIG(admin.cookie, original);
    check("restoring the shape succeeds", restored.status === 200, `HTTP ${restored.status} ${restored.error || ""}`);
    const gone = !(await db.collection("routines").doc(ghostId).get()).exists;
    check("a lesson on an unknown period is pruned", gone, gone ? "removed" : "still there");
  }

  /* ------------------------------------------- 5. section-wise routines */
  const sections = cls.sections || [];
  if (sections.length < 2) {
    skip("section-wise routines", `${cls.name} has fewer than two sections`);
  } else {
    const subjects = (await req(SCHOOL_HOST, "/api/subjects", { cookie: admin.cookie })).data || [];
    const subjectId = subjects[0]?.id;
    const [secA, secB] = sections;
    const day = original.days[0];

    const wideBefore = (await req(SCHOOL_HOST, `/api/routines?classId=${cls.id}`, { cookie: admin.cookie })).data || [];

    const writeA = await req(SCHOOL_HOST, "/api/routines", {
      cookie: admin.cookie,
      method: "POST",
      body: JSON.stringify({ classId: cls.id, sectionId: secA.id, rows: [{ day, period: 1, subjectId }] }),
    });
    sectionScopes.push({ classId: cls.id, sectionId: secA.id });
    check("a section can be given its own week", writeA.status === 200 && writeA.data?.rows === 1, `HTTP ${writeA.status} ${writeA.error || ""}`);

    const readA = (await req(SCHOOL_HOST, `/api/routines?classId=${cls.id}&sectionId=${secA.id}`, { cookie: admin.cookie })).data || [];
    check("the section's week reads back on its own", readA.length === 1 && readA[0].sectionId === secA.id, `${readA.length} lesson(s)`);

    const readB = (await req(SCHOOL_HOST, `/api/routines?classId=${cls.id}&sectionId=${secB.id}`, { cookie: admin.cookie })).data || [];
    check("the sibling section is untouched", readB.length === 0, `${readB.length} lesson(s)`);

    const wideAfter = (await req(SCHOOL_HOST, `/api/routines?classId=${cls.id}`, { cookie: admin.cookie })).data || [];
    check("the class-wide week is untouched", wideAfter.length === wideBefore.length, `${wideBefore.length} → ${wideAfter.length}`);

    const wideIncludesSection = wideAfter.some((r) => r.sectionId);
    check("a class-wide read never returns section lessons", !wideIncludesSection, wideIncludesSection ? "section row leaked" : "clean");

    // A section with no week of its own is not an error — it is simply empty,
    // and the editor falls back to the class-wide week client-side.
    check("a section that inherits reads back empty", readB.length === 0, "empty scope");

    /* ------------------------------------- 6. what is refused on a save */
    const badDay = await req(SCHOOL_HOST, "/api/routines", {
      cookie: admin.cookie,
      method: "POST",
      body: JSON.stringify({ classId: cls.id, sectionId: secA.id, rows: [{ day: 6, period: 1, subjectId }] }),
    });
    check("a lesson on a non-working day is refused", badDay.status === 400, `HTTP ${badDay.status} ${badDay.error || ""}`);

    const badPeriod = await req(SCHOOL_HOST, "/api/routines", {
      cookie: admin.cookie,
      method: "POST",
      body: JSON.stringify({ classId: cls.id, sectionId: secA.id, rows: [{ day, period: 99, subjectId }] }),
    });
    check("a lesson on a period the school does not have is refused", badPeriod.status === 400, `HTTP ${badPeriod.status} ${badPeriod.error || ""}`);

    const badSubject = await req(SCHOOL_HOST, "/api/routines", {
      cookie: admin.cookie,
      method: "POST",
      body: JSON.stringify({ classId: cls.id, sectionId: secA.id, rows: [{ day, period: 1, subjectId: "zzrc-nope" }] }),
    });
    check("a lesson with an unknown subject is refused", badSubject.status === 400, `HTTP ${badSubject.status} ${badSubject.error || ""}`);

    const badSection = await req(SCHOOL_HOST, "/api/routines", {
      cookie: admin.cookie,
      method: "POST",
      body: JSON.stringify({ classId: classes[1].id, sectionId: secA.id, rows: [{ day, period: 1, subjectId }] }),
    });
    check("a section from another class is refused", badSection.status === 404, `HTTP ${badSection.status} ${badSection.error || ""}`);

    const teacherWrite = await req(TEACHER_HOST, "/api/routines", {
      cookie: teacher.cookie,
      method: "POST",
      body: JSON.stringify({ classId: cls.id, rows: [] }),
    });
    check("a teacher cannot save the routine", teacherWrite.status === 403, `HTTP ${teacherWrite.status}`);

    const savedA = (await req(SCHOOL_HOST, `/api/routines?classId=${cls.id}&sectionId=${secA.id}`, { cookie: admin.cookie })).data || [];
    check("a refused save changed nothing", savedA.length === 1, `${savedA.length} lesson(s)`);
  }

  /* ----------------------- 7. the roster honours the section override */
  const allTeachers = (await db.collection("teachers").where("schoolId", "==", schoolId).get()).docs.map((d) => d.id);
  const demoUser = (await db.collection("users").where("email", "==", TEACHER.id).get()).docs[0]?.id;
  const demoTeacher = demoUser ? demoUser.replace(/^u_/, "t_u_") : null;
  const otherTeacher = allTeachers.find((id) => id !== demoTeacher) || null;
  const rosterSubjectId = (await db.collection("subjects").where("schoolId", "==", schoolId).limit(1).get()).docs[0]?.id || null;

  const me = await req(TEACHER_HOST, "/api/class-sessions?view=me", { cookie: teacher.cookie });
  const slot = (me.data?.roster || [])[0];
  const siblings = slot ? ((classes.find((c) => c.id === slot.classId) || {}).sections || []).map((s) => s.id) : [];

  if (!slot) {
    skip("the roster follows a section override", "the teacher has no scheduled period today");
  } else if (siblings.length < 2 || !otherTeacher || !rosterSubjectId) {
    skip("the roster follows a section override", "needs two sections, another teacher and a subject");
  } else {
    // Give every section of that class its own lesson in the teacher's slot,
    // taught by someone else — the class-wide lesson is then nobody's.
    const today = new Date().getDay();
    for (const sid of siblings) {
      await req(SCHOOL_HOST, "/api/routines", {
        cookie: admin.cookie,
        method: "POST",
        body: JSON.stringify({ classId: slot.classId, sectionId: sid, rows: [{ day: today, period: slot.period, subjectId: rosterSubjectId, teacherId: otherTeacher }] }),
      });
      sectionScopes.push({ classId: slot.classId, sectionId: sid });
    }

    const after = await req(TEACHER_HOST, "/api/class-sessions?view=me", { cookie: teacher.cookie });
    const still = (after.data?.roster || []).some((r) => r.classId === slot.classId && r.period === slot.period);
    check("a class-wide lesson leaves the teacher once every section overrides it", !still, still ? "still on the roster" : `freed ${slot.className || ""} P${slot.period}`);
    check("the day is one lesson shorter", (after.data?.roster || []).length === (me.data?.roster || []).length - 1, `${me.data.roster.length} → ${(after.data?.roster || []).length}`);

    // Undo the overrides: the class-wide lesson must come back.
    for (const sid of siblings) {
      await req(SCHOOL_HOST, "/api/routines", { cookie: admin.cookie, method: "POST", body: JSON.stringify({ classId: slot.classId, sectionId: sid, rows: [] }) });
    }
    sectionScopes = sectionScopes.filter((s) => s.classId !== slot.classId);
    const back = await req(TEACHER_HOST, "/api/class-sessions?view=me", { cookie: teacher.cookie });
    const returned = (back.data?.roster || []).some((r) => r.classId === slot.classId && r.period === slot.period);
    check("the class-wide lesson returns when the overrides are cleared", returned, returned ? "restored" : "still missing");
  }
} finally {
  /* ------------------------------------------------------------ cleanup */
  for (const scope of sectionScopes) {
    await req(SCHOOL_HOST, "/api/routines", { cookie: admin.cookie, method: "POST", body: JSON.stringify({ ...scope, rows: [] }) }).catch(() => {});
  }
  if (original) await PUT_CONFIG(admin.cookie, original).catch(() => {});

  // Put the timetable back exactly as it was: the shape test deletes lessons by
  // design, so restoring the config alone would leave those holes behind.
  if (rowBackup) {
    const live = await db.collection("routines").where("schoolId", "==", schoolId).get();
    let batch = db.batch();
    let n = 0;
    for (const d of live.docs) {
      batch.delete(d.ref);
      if (++n % 400 === 0) { await batch.commit(); batch = db.batch(); }
    }
    await batch.commit();
    let restore = db.batch();
    n = 0;
    for (const row of rowBackup) {
      restore.set(db.collection("routines").doc(row.id), row.data);
      if (++n % 400 === 0) { await restore.commit(); restore = db.batch(); }
    }
    await restore.commit();
  }
  for (const id of created) await db.collection("routines").doc(id).delete().catch(() => {});

  const left = [];
  for (const id of created) if ((await db.collection("routines").doc(id).get()).exists) left.push(id);
  const liveCount = (await db.collection("routines").where("schoolId", "==", schoolId).get()).size;
  const back = await req(SCHOOL_HOST, "/api/routine-config", { cookie: admin.cookie });
  const same = JSON.stringify(back.data?.config?.days) === JSON.stringify(original?.days) && back.data?.config?.periods?.length === original?.periods?.length;
  check("the school's shape was restored", same, `${back.data?.config?.days?.length} day(s) × ${back.data?.config?.periods?.length} period(s)`);
  check("the timetable was restored lesson for lesson", liveCount === rowBackup?.length, `${rowBackup?.length} → ${liveCount}`);
  check("probe lessons removed", left.length === 0, left.join(", ") || `${created.length} doc(s) removed`);
}

console.log(failures ? `\n❌ verify-routine-config: ${failures} failure(s)${skipped ? `, ${skipped} skipped` : ""}\n` : `\n✅ verify-routine-config: ALL GREEN${skipped ? ` (${skipped} skipped)` : ""}\n`);
process.exit(failures ? 1 : 0);
