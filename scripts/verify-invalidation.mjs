/**
 * verify-invalidation.mjs — prove the stats cache invalidates on submit:
 * read stats (attendanceToday) as the teacher → POST today's attendance for a
 * throwaway student → read stats again. The second read must reflect the new row
 * without waiting for the TTL.
 *
 * Deterministic by construction. It builds its own student fixture in the
 * teacher's first class instead of hunting for a student the seed happens to
 * have left UNMARKED — scripts/seed.mjs marks TODAY for every student
 * (offsets [-9 … 0]), so the old "find an unmarked student" search always came
 * up empty and the suite exited 0 having verified nothing.
 *
 * Idempotent across runs. The stats cache is process-wide and, once fresh, a
 * payload may keep being SERVED for STATS_CACHE_SERVE_MS (10 min by default)
 * even after it is stale (src/lib/stats-cache.ts). This run cleans up by
 * deleting its attendance row through the admin SDK, which bypasses the db
 * layer's write-generation bump, so WITHOUT a flush a previous run could leave
 * the server serving a post-submit payload — and the next run's baseline read
 * would start at 1 instead of 0, then its own submit would read 1 again and the
 * "+1" assertion would fail. To rule that out this suite flushes the cache with
 * an EMPTY save before it reads its baseline: an empty save changes no data but
 * still takes the same `audit(...)` + `invalidateStats(schoolId)` path a real
 * submit takes, so `before` is always recomputed from Firestore.
 *
 * Everything it writes — the student fixture, the attendance row the submit
 * creates, and the ATTENDANCE_SAVE auditLog rows the flush and the submit write
 * — is removed in a `finally`, so the emulator ends where it started and the
 * suite is safe to re-run on any date. (The suite's own login writes a LOGIN
 * auditLog row fire-and-forget — src/app/api/auth/login/route.ts — which belongs
 * to authenticating and is not this test's to delete, so the residue assertion
 * is scoped to the ATTENDANCE_SAVE rows this run alone owns rather than to the
 * whole collection.)
 *
 * Exit codes: 0 = the invalidation assertion ran and passed.
 *             1 = it ran and failed, or cleanup leaked.
 *             2 = SKIP — no fixture could be built, so nothing was verified.
 */
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { requireEmulator } from "./lib/guard.mjs";

requireEmulator();

// No loadEnv() on purpose: the guard above has already forced emulator mode, and
// the emulator needs no credentials — so there is nothing here worth reading out
// of .env, and loading it would pull the PRODUCTION project id into a script
// that talks to the demo namespace. FIREBASE_PROJECT_ID comes from the
// emulator-only environment (docs/TESTING.md). Credentials are never built.
if (!getApps().length) {
  initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
}
const db = getFirestore();

const BASE = process.env.BASE_URL || "http://localhost:3000";

const stamp = Date.now();
let failures = 0;
let skipped = 0;
const check = (label, cond, detail = "") => {
  console.log(`  ${cond ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!cond) failures++;
};
const skip = (label, why) => {
  console.log(`  SKIP  ${label} — ${why}`);
  skipped++;
};

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
  });
  if (!res.ok) throw new Error(`login: ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
const cookie = await login("teacher@sunrise.edu", "Teacher@123");
const H = { cookie };

const stats = async () => (await (await fetch(`${BASE}/api/stats`, { headers: H })).json()).data;

// The day the assertion rides is LOCAL midnight, both when the row is stored
// (`new Date(`${date}T00:00:00`)`, attendance/route.ts) and when stats counts it
// (`today.setHours(0,0,0,0)` then `where: { date: today }`, stats/route.ts). A
// UTC `toISOString()` slice names the PREVIOUS day between 00:00 and 06:00 at
// UTC+06:00, which would leave the row outside the counted bucket.
const midnight = new Date();
midnight.setHours(0, 0, 0, 0);
const date = midnight.toLocaleDateString("en-CA"); // YYYY-MM-DD, local calendar day

// Resolve the fixture's class/section from the payload BEFORE flushing. myClasses
// is stable across runs, so reading the ids from a possibly-stale payload is
// fine — and doing it first means a teacher with no class can SKIP without
// having written anything.
const probe = await stats();
const klass = (probe.myClasses || [])[0];
const section = (klass?.sections || [])[0];
if (!klass || !section || !klass.schoolId) {
  skip("a class and section to put the fixture in", "this teacher has no class/section assigned — nothing to verify");
  console.log(`\n⚠️ SKIPPED — the invalidation assertion never ran (${skipped} skip(s)).`);
  process.exit(2);
}

const schoolId = klass.schoolId;
const fixtureId = `st_zzinv${stamp}`;
const fixtureRows = () => db.collection("attendance").where("studentId", "==", fixtureId).get();
const count = async (collection) => (await db.collection(collection).where("schoolId", "==", schoolId).get()).size;
const saveAuditIds = async () =>
  new Set((await db.collection("auditLogs").where("action", "==", "ATTENDANCE_SAVE").get()).docs.map((d) => d.id));

// Audit rows already there before this run — only ids NOT in here are ours.
const auditBefore = await saveAuditIds();

// Flush the stats cache through the app's own invalidation path. An empty save
// changes no data but still runs `audit(...)` + `invalidateStats(schoolId)`, so
// any payload a previous run left in the serve window is dropped and the
// baseline read below is recomputed from Firestore.
const flush = await fetch(`${BASE}/api/attendance`, {
  method: "POST",
  headers: { ...H, "Content-Type": "application/json" },
  body: JSON.stringify({ date, rows: [] }),
});
console.log(`flush POST /api/attendance → ${flush.status} ${await flush.text()}`);
check("the cache-flush save is accepted", flush.status === 200, `HTTP ${flush.status}`);

const before = await stats();
console.log(`before: attendanceToday = ${before.attendanceToday} (count of rows this teacher marked today)`);

const baseline = { students: await count("students"), attendance: await count("attendance") };

try {
  // One minimal throwaway student, in the teacher's own class/section, so the
  // register really offers it. No guardian, no fees — nothing else to clean up.
  await db.collection("students").doc(fixtureId).set({
    id: fixtureId,
    schoolId,
    name: `ZZ Invalidation Probe ${stamp}`,
    admissionNo: `ZZINV-${stamp}`,
    classId: klass.id,
    sectionId: section.id,
    branchId: null,
    guardianUserId: null,
    roll: 9999,
    active: true,
    status: "ACTIVE",
    admissionDate: new Date(),
    createdAt: new Date(),
  });

  const roster =
    (await (await fetch(`${BASE}/api/attendance?classId=${klass.id}&sectionId=${section.id}&date=${date}`, { headers: H })).json()).data || [];
  check(
    "the throwaway student is on the teacher's register",
    roster.some((s) => s.id === fixtureId && s.status === "UNMARKED"),
    `${roster.length} row(s)`
  );

  const post = await fetch(`${BASE}/api/attendance`, {
    method: "POST",
    headers: { ...H, "Content-Type": "application/json" },
    body: JSON.stringify({
      date,
      rows: [{ studentId: fixtureId, classId: klass.id, sectionId: section.id, status: "PRESENT", remark: "cache-test" }],
    }),
  });
  console.log(`POST /api/attendance → ${post.status} ${await post.text()}`);
  check("the register accepts the submit", post.status === 200, `HTTP ${post.status}`);

  const after = await stats();
  console.log(`after:  attendanceToday = ${after.attendanceToday}`);
  check(
    "the stats cache invalidated on submit — attendanceToday +1 with no TTL wait",
    after.attendanceToday === before.attendanceToday + 1,
    `${before.attendanceToday} → ${after.attendanceToday}`
  );
} finally {
  // Runs even when an assertion above failed: delete exactly what this run
  // created — the fixture's attendance rows, the fixture student, and every
  // ATTENDANCE_SAVE auditLog row written since `auditBefore` (the flush's and
  // the submit's). Nothing pre-existing is touched: the fixture id is brand new
  // and the audit delete is a pure before/after id diff.
  await fixtureRows()
    .then((snap) => Promise.all(snap.docs.map((d) => d.ref.delete())))
    .catch(() => null);
  await db.collection("students").doc(fixtureId).delete().catch(() => null);
  await saveAuditIds()
    .then((ids) => Promise.all([...ids].filter((id) => !auditBefore.has(id)).map((id) => db.collection("auditLogs").doc(id).delete())))
    .catch(() => null);

  try {
    const attLeft = (await fixtureRows()).size;
    const studentLeft = (await db.collection("students").doc(fixtureId).get()).exists;
    const auditLeft = await saveAuditIds();
    const afterCounts = { students: await count("students"), attendance: await count("attendance") };
    check("the attendance row this run created is gone", attLeft === 0, `${attLeft} row(s)`);
    check("the throwaway student is gone", studentLeft === false);
    check(
      "the ATTENDANCE_SAVE auditLog rows this run created are gone",
      auditLeft.size === auditBefore.size,
      `${auditBefore.size} → ${auditLeft.size}`
    );
    check(
      "students and attendance are back to their pre-run counts",
      afterCounts.students === baseline.students && afterCounts.attendance === baseline.attendance,
      `students ${baseline.students}→${afterCounts.students} · attendance ${baseline.attendance}→${afterCounts.attendance}`
    );
  } catch (e) {
    check("cleanup could be verified", false, e?.message || String(e));
  }
}

console.log(
  failures === 0
    ? "\n✅ INVALIDATION VERIFIED — the dashboard reflected the submit immediately, and the fixture was removed."
    : `\n❌ ${failures} FAILURE(S)`
);
process.exit(failures ? 1 : 0);
