/**
 * Notifications — one centre, every sector, real events.
 *
 * Verified here, against a running server:
 *   1. every notification a user reads carries a real `createdAt` (the fix for
 *      the bell that showed a blank "—" and could not sort);
 *   2. publishing a notice reaches the office, the teachers and the families;
 *   3. posting homework, marking a child absent, publishing results and starting
 *      a class each raise a notification for that child's guardian — and a
 *      re-saved register does NOT mail the family a second time;
 *   4. read/unread/delete behave, including "mark all read" and "clear read";
 *   5. one user can never read, change or delete another user's rows;
 *   6. filter, search and paging narrow the list without leaking anything.
 *
 * Everything it creates is removed again by document reference. Usage:
 *   node scripts/verify-notifications.mjs    (SMOKE_PORT, default 3000)
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const SUPER_HOST = `admin.localhost:${PORT}`;
const SCHOOL_HOST = `school.localhost:${PORT}`;
const TEACHER_HOST = `teacher.localhost:${PORT}`;
const PARENTS_HOST = `parents.localhost:${PORT}`;

const ADMIN = { id: "principal@sunrise.edu", pw: "School@123" };
const TEACHER = { id: "teacher@sunrise.edu", pw: "Teacher@123" };
const GUARDIAN = { id: "guardian1@demo.com", pw: "Guardian@123" };
const SUPER = { id: process.env.SUPERADMIN_EMAIL || "admin@smartschool.com", pw: process.env.SUPERADMIN_PASSWORD || "Admin@123" };
const SCHOOL = "s_54bf3dc2c4f98fabdf78b7216c0ae888455d009a";

const startedAt = new Date();
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
if (!getApps().length) {
  initializeApp({
    projectId: process.env.FIREBASE_PROJECT_ID,
    credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: unescapeKey(process.env.FIREBASE_PRIVATE_KEY || ""),
    }),
  });
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
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  return { status: res.status, cookie };
}

const GET = (host, path, cookie) => req(host, path, { cookie });
const POST = (host, path, cookie, body) => req(host, path, { cookie, method: "POST", body: JSON.stringify(body || {}) });
const PATCH = (host, path, cookie, body) => req(host, path, { cookie, method: "PATCH", body: JSON.stringify(body || {}) });
const DEL = (host, path, cookie) => req(host, path, { cookie, method: "DELETE" });

/** Poll an async predicate — the DB read memo can serve a pre-write pull briefly. */
async function until(fn, tries = 8, waitMs = 2500) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, waitMs));
  }
  return null;
}

const unreadOf = async (host, cookie) => (await GET(host, "/api/notifications?countOnly=1", cookie)).data?.unread ?? -1;
const listOf = async (host, cookie, extra = "?take=100") => (await GET(host, `/api/notifications${extra}`, cookie)).data || {};
const findNotif = (data, contains, event) =>
  (data.items || []).find((n) => String(n.title || "").includes(contains) && (!event || n.event === event));

/* --------------------------------------------------------------------- main */
const admin = await signIn(SCHOOL_HOST, ADMIN);
const teacher = await signIn(TEACHER_HOST, TEACHER);
const guardian = await signIn(PARENTS_HOST, GUARDIAN);
const sup = await signIn(SUPER_HOST, SUPER);

check("sessions: school admin / teacher / guardian / super admin", [admin, teacher, guardian, sup].every((s) => s.status === 200), `statuses ${[admin, teacher, guardian, sup].map((s) => s.status).join("/")}`);
if (guardian.status !== 200) {
  console.log("guardian session failed — cannot continue");
  process.exit(1);
}

// The child to run every per-student event against, and that child's guardian.
const guardianUser = (await db.collection("users").where("email", "==", GUARDIAN.id.toLowerCase()).limit(1).get()).docs[0];
const guardianUserId = guardianUser?.id;
const childDocs = await db.collection("students").where("schoolId", "==", SCHOOL).get();
const child = childDocs.docs.map((d) => ({ id: d.id, ...d.data() })).find((s) => s.guardianUserId === guardianUserId && s.classId);
check("demo guardian has a linked child with a class", !!child, child ? `${child.name} (${child.classId})` : "none found");
if (!child) process.exit(1);

const cleanups = [];
const note = (collection, id) => cleanups.push({ collection, id });

/* ---------------------------------------------------------------- 1. baseline */
console.log("\n== baseline ==");
const base = await listOf(PARENTS_HOST, guardian.cookie);
check("guardian list answers", Array.isArray(base.items), `status items=${base.items?.length}`);
check("unread count answers", typeof base.unread === "number", `unread=${base.unread}`);
const anyUndated = (base.items || []).filter((n) => !n.createdAt);
check("no notification is missing a timestamp", anyUndated.length === 0, `${anyUndated.length} undated of ${base.items?.length}`);
const supList = await GET(SUPER_HOST, "/api/notifications", sup.cookie);
check("platform console can read its own notifications", supList.status === 200, `status=${supList.status}`);

/* ------------------------------------------------------------- 2. notice fan-out */
console.log("\n== notice reaches every sector ==");
const noticeTitle = `QA notice ${Date.now()}`;
const noticeRes = await POST(SCHOOL_HOST, "/api/notices", admin.cookie, {
  title: noticeTitle,
  body: "Automated verification notice — safe to ignore.",
  category: "GENERAL",
});
check("admin publishes a notice", noticeRes.status === 201 && noticeRes.data?.id, `status=${noticeRes.status}`);
if (noticeRes.data?.id) note("notices", noticeRes.data.id);

const teacherNotice = await until(async () => findNotif(await listOf(TEACHER_HOST, teacher.cookie), noticeTitle, "NOTICE_PUBLISHED"));
check("teacher receives the notice", !!teacherNotice, teacherNotice ? teacherNotice.title : "not found");
check("teacher's notice has a timestamp", !!teacherNotice?.createdAt, teacherNotice?.createdAt || "missing");

const guardianNotice = await until(async () => findNotif(await listOf(PARENTS_HOST, guardian.cookie), noticeTitle, "NOTICE_PUBLISHED"));
check("guardian receives the notice", !!guardianNotice, guardianNotice ? guardianNotice.title : "not found");
check("notice links to the family's notices page", guardianNotice?.link === "/parent/notices", guardianNotice?.link || "none");

/* ------------------------------------------------------------ 3. homework */
console.log("\n== homework reaches the family ==");
const hwTitle = `QA homework ${Date.now()}`;
const hwRes = await POST(TEACHER_HOST, "/api/homework", teacher.cookie, {
  classId: child.classId,
  sectionId: child.sectionId || null,
  title: hwTitle,
  description: "Automated verification homework.",
  dueDate: new Date(Date.now() + 86400000).toISOString(),
});
check("teacher posts homework", hwRes.status === 201 && hwRes.data?.id, `status=${hwRes.status}`);
if (hwRes.data?.id) note("homework", hwRes.data.id);

const hwNotif = await until(async () => findNotif(await listOf(PARENTS_HOST, guardian.cookie), hwTitle, "HOMEWORK_POSTED"));
check("guardian is told about the homework", !!hwNotif, hwNotif?.title || "not found");
check("homework notification has a timestamp", !!hwNotif?.createdAt, hwNotif?.createdAt || "missing");

/* ------------------------------------------------------------ 4. attendance */
console.log("\n== an absence reaches the guardian, once ==");
// A fixed old date so the probe can never collide with a real register.
const probeDate = "2001-02-03";
const probeDay = new Date(`${probeDate}T00:00:00`).toDateString();
const sameProbeDay = (ts) => !!ts && new Date(ts.toDate ? ts.toDate() : ts).toDateString() === probeDay;

// Pre-flight: an interrupted earlier run could have left a probe row behind,
// which would (correctly) suppress the "newly absent" notification.
const attExisting = await db.collection("attendance").where("schoolId", "==", SCHOOL).get();
for (const d of attExisting.docs) {
  if (d.get("studentId") === child.id && sameProbeDay(d.get("date"))) await d.ref.delete();
}
const markBody = { date: probeDate, rows: [{ studentId: child.id, classId: child.classId, sectionId: child.sectionId || null, status: "ABSENT" }] };
const att1 = await POST(TEACHER_HOST, "/api/attendance", teacher.cookie, markBody);
check("teacher marks the child absent", att1.status === 200, `status=${att1.status}${att1.error ? ` ${att1.error}` : ""}`);

const absentNotif = await until(async () => findNotif(await listOf(PARENTS_HOST, guardian.cookie), "marked absent", "ATTENDANCE_PUBLISHED"));
check("guardian is told the child was absent", !!absentNotif, absentNotif?.title || "not found");

// Re-saving the same register must not notify again.
const before = (await listOf(PARENTS_HOST, guardian.cookie, "?take=100&filter=all&q=marked%20absent")).items?.length ?? 0;
await POST(TEACHER_HOST, "/api/attendance", teacher.cookie, markBody);
await new Promise((r) => setTimeout(r, 1500));
const after = (await listOf(PARENTS_HOST, guardian.cookie, "?take=100&filter=all&q=marked%20absent")).items?.length ?? 0;
check("re-saving the register does not notify twice", after === before, `before=${before} after=${after}`);

/* --------------------------------------------------------- 5. results publish */
console.log("\n== publishing results reaches the family ==");
const examName = `QA exam ${Date.now()}`;
const examRes = await POST(SCHOOL_HOST, "/api/exams", admin.cookie, {
  name: examName,
  classId: child.classId,
  sectionId: child.sectionId || null,
  year: new Date().getFullYear(),
});
check("admin creates a draft exam", examRes.status === 201 && examRes.data?.id, `status=${examRes.status}`);
const examId = examRes.data?.id;
if (examId) note("exams", examId);
if (examId) {
  const pub = await PATCH(SCHOOL_HOST, `/api/exams/${examId}`, admin.cookie, { published: true });
  check("admin publishes the exam", pub.status === 200 && pub.data?.published === true, `status=${pub.status}`);
  const resNotif = await until(async () => findNotif(await listOf(PARENTS_HOST, guardian.cookie), examName, "RESULT_PUBLISHED"));
  check("guardian is told results are out", !!resNotif, resNotif?.title || "not found");
  check("results notification links to the results page", resNotif?.link === "/parent/results", resNotif?.link || "none");
  // Publishing an already-published exam must NOT notify again (only false→true does).
  await PATCH(SCHOOL_HOST, `/api/exams/${examId}`, admin.cookie, { published: true });
  await new Promise((r) => setTimeout(r, 1200));
  const count2 = (await listOf(PARENTS_HOST, guardian.cookie, `?take=100&q=${encodeURIComponent(examName)}`)).items?.length ?? 0;
  check("publishing an already-published exam does not notify again", count2 === 1, `matches=${count2}`);
} else {
  skip("publish results", "exam was not created");
}

/* ------------------------------------------------------------ 6. class started */
console.log("\n== a class starting reaches the family ==");
// Pre-flight: a teacher can only be in one class at a time, so close anything
// left open by an interrupted run before starting the probe class.
const teacherUser = (await db.collection("users").where("email", "==", TEACHER.id.toLowerCase()).limit(1).get()).docs[0];
if (teacherUser) {
  const openRows = (await db.collection("classSessions").where("schoolId", "==", SCHOOL).get()).docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => s.teacherUserId === teacherUser.id && s.status === "OPEN");
  for (const s of openRows) await PATCH(TEACHER_HOST, `/api/class-sessions/${s.id}`, teacher.cookie, {});
  if (openRows.length) console.log(`  (closed ${openRows.length} leftover open class session(s))`);
}
const startRes = await POST(TEACHER_HOST, "/api/class-sessions", teacher.cookie, { classId: child.classId, sectionId: child.sectionId || null, note: "QA notification probe" });
check("teacher starts a class", startRes.status === 201 || startRes.status === 200, `status=${startRes.status}${startRes.error ? ` ${startRes.error}` : ""}`);
if (startRes.data?.id) {
  note("classSessions", startRes.data.id);
  const startNotif = await until(async () => findNotif(await listOf(PARENTS_HOST, guardian.cookie), "in progress", "CLASS_STARTED"));
  check("guardian is told the class started", !!startNotif, startNotif?.title || "not found");
  await PATCH(TEACHER_HOST, `/api/class-sessions/${startRes.data.id}`, teacher.cookie, {});
} else {
  skip("class started notification", "no session created");
}

/* ----------------------------------------------------------- 7. read / unread */
console.log("\n== read, unread, delete ==");
const beforeUnread = await unreadOf(PARENTS_HOST, guardian.cookie);
check("guardian has unread notifications to work with", beforeUnread > 0, `unread=${beforeUnread}`);

const target = findNotif(await listOf(PARENTS_HOST, guardian.cookie), hwTitle);
check("found the homework notification to mark read", !!target);
if (target) {
  const mark = await POST(PARENTS_HOST, "/api/notifications", guardian.cookie, { id: target.id });
  check("marking one read succeeds", mark.status === 200 && mark.data?.changed >= 1, `changed=${mark.data?.changed}`);
  const afterMark = await unreadOf(PARENTS_HOST, guardian.cookie);
  check("unread count drops by one", afterMark === beforeUnread - 1, `${beforeUnread} → ${afterMark}`);
  const row = (await listOf(PARENTS_HOST, guardian.cookie)).items.find((n) => n.id === target.id);
  check("the row now reads as read", !!row?.readAt, row?.readAt || "still unread");

  const unmark = await POST(PARENTS_HOST, "/api/notifications", guardian.cookie, { id: target.id, unread: true });
  check("marking unread succeeds", unmark.status === 200 && unmark.data?.changed === 1, `changed=${unmark.data?.changed}`);
  check("unread count returns", (await unreadOf(PARENTS_HOST, guardian.cookie)) === beforeUnread, `expected ${beforeUnread}`);

  const del = await DEL(PARENTS_HOST, `/api/notifications?id=${encodeURIComponent(target.id)}`, guardian.cookie);
  check("deleting one notification succeeds", del.status === 200 && del.data?.removed === 1, `removed=${del.data?.removed}`);
  const gone = (await listOf(PARENTS_HOST, guardian.cookie)).items.find((n) => n.id === target.id);
  check("the deleted notification is gone", !gone);
}

/* ------------------------------------------------------------- 8. isolation */
console.log("\n== one user cannot touch another's rows ==");
const teacherUnread = (await listOf(TEACHER_HOST, teacher.cookie)).items.find((n) => n.event === "NOTICE_PUBLISHED");
check("teacher has a notice row to defend", !!teacherUnread);
if (teacherUnread) {
  await POST(PARENTS_HOST, "/api/notifications", guardian.cookie, { id: teacherUnread.id });
  await DEL(PARENTS_HOST, `/api/notifications?id=${encodeURIComponent(teacherUnread.id)}`, guardian.cookie);
  const still = (await listOf(TEACHER_HOST, teacher.cookie)).items.find((n) => n.id === teacherUnread.id);
  check("guardian could not mark the teacher's notification", still && !still.readAt, still?.readAt ? "it was changed" : "unchanged");
  check("guardian could not delete the teacher's notification", !!still);
}

const other = findNotif(await listOf(TEACHER_HOST, teacher.cookie), noticeTitle);
check("a notice reaches the teacher and not only the guardian", !!other);

/* --------------------------------------------------------- 9. filter / search */
console.log("\n== filter, search, paging ==");
const unreadOnly = await listOf(PARENTS_HOST, guardian.cookie, "?take=100&filter=unread");
check("filter=unread returns only unread rows", unreadOnly.items?.length > 0 && unreadOnly.items.every((n) => !n.readAt), `rows=${unreadOnly.items?.length}`);
const readOnly = await listOf(PARENTS_HOST, guardian.cookie, "?take=100&filter=read");
check("filter=read returns only read rows", readOnly.items?.every((n) => !!n.readAt), `rows=${readOnly.items?.length}`);
const searched = await listOf(PARENTS_HOST, guardian.cookie, `?take=100&q=${encodeURIComponent(noticeTitle)}`);
check("search narrows to matching rows", searched.items?.length >= 1 && searched.items.every((n) => `${n.title} ${n.body}`.includes(noticeTitle)), `rows=${searched.items?.length}`);
const page1 = await listOf(PARENTS_HOST, guardian.cookie, "?take=1");
check("take=1 returns a single row and reports more", page1.items?.length === 1 && page1.hasMore === true, `items=${page1.items?.length} hasMore=${page1.hasMore}`);
if (page1.items?.[0]?.createdAt) {
  const page2 = await listOf(PARENTS_HOST, guardian.cookie, `?take=5&before=${encodeURIComponent(page1.items[0].createdAt)}`);
  const strictlyOlder = (page2.items || []).every((n) => new Date(n.createdAt).getTime() < new Date(page1.items[0].createdAt).getTime());
  check("the paging cursor returns strictly older rows", page2.items?.length > 0 && strictlyOlder, `rows=${page2.items?.length}`);
} else {
  skip("paging cursor", "first page row has no timestamp");
}

/* -------------------------------------------------------------- 10. mark all */
console.log("\n== mark all read ==");
const all = await POST(PARENTS_HOST, "/api/notifications", guardian.cookie, {});
check("mark all read succeeds", all.status === 200, `status=${all.status}`);
check("unread is zero afterwards", (await unreadOf(PARENTS_HOST, guardian.cookie)) === 0, `unread=${await unreadOf(PARENTS_HOST, guardian.cookie)}`);

/* ------------------------------------------------------------------ cleanup */
console.log("\n== cleanup ==");
// Remove every notification this run created, plus the probe records.
const schoolRows = await db.collection("notifications").where("schoolId", "==", SCHOOL).get();
let removed = 0;
for (let i = 0; i < schoolRows.docs.length; i += 450) {
  const batch = db.batch();
  let n = 0;
  for (const d of schoolRows.docs.slice(i, i + 450)) {
    const ts = d.get("createdAt");
    if (ts && new Date(ts.toDate ? ts.toDate() : ts).getTime() >= startedAt.getTime()) {
      batch.delete(d.ref);
      n++;
    }
  }
  if (n) {
    await batch.commit();
    removed += n;
  }
}
for (const { collection, id } of cleanups.filter((c) => c.id)) {
  await db.collection(collection).doc(id).delete().catch(() => null);
}
// Attendance probe rows (upserted, so delete by shape rather than by id). The
// stored timestamp is UTC midnight of a LOCAL date, so compare local dates —
// an ISO date-string comparison silently misses it east/west of UTC.
const attRows = await db.collection("attendance").where("schoolId", "==", SCHOOL).get();
for (const d of attRows.docs) {
  if (d.get("studentId") === child.id && sameProbeDay(d.get("date"))) await d.ref.delete();
}
// The exam's marks (none written, but be thorough) — exam doc already removed.
console.log(`  removed ${removed} notification(s) and ${cleanups.length} probe record(s)`);
const leftover = (await db.collection("notifications").where("schoolId", "==", SCHOOL).get()).docs.filter((d) => {
  const ts = d.get("createdAt");
  return ts && new Date(ts.toDate ? ts.toDate() : ts).getTime() >= startedAt.getTime();
});
check("probe notifications cleaned up", leftover.length === 0, `left=${leftover.length}`);

console.log(`\n${failures === 0 ? "ALL GREEN" : `${failures} FAILURE(S)`}${skipped ? ` · ${skipped} skipped` : ""}`);
process.exit(failures ? 1 : 0);
