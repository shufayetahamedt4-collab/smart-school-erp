/**
 * verify-tenant-isolation.mjs — pre-push cross-school isolation check.
 *
 * Logs in as the THROWAWAY fixture school's admin/teacher/student (created by
 * isolation-fixture.mjs) and calls the 10 swept routes. Asserts:
 *   1. fixture rows ARE visible (pulls genuinely work, not just empty), and
 *   2. NO name or id belonging to any other school in the DB appears in any
 *      payload (names/ids collected from Firestore across all other schools).
 *
 * Usage: node scripts/verify-tenant-isolation.mjs [BASE=http://localhost:58497]
 * Cleanup afterwards: node scripts/isolation-fixture.mjs clean
 */
import { initializeApp, applicationDefault, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";

const BASE = process.env.BASE || "http://localhost:58497";
const P = "zziso-";

/** Fixture credentials live ONLY in the untracked track file — never committed. */
const TRACK = new URL(".qa-fixtures.json", import.meta.url);
if (!existsSync(TRACK)) {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(1);
}
const track = JSON.parse(readFileSync(TRACK, "utf8"));
const CRED = track.creds || {};
if (!CRED.admin || !CRED.teacher || !CRED.student) {
  console.error("❌ Track file lacks credentials — re-run: node scripts/isolation-fixture.mjs clean && node scripts/isolation-fixture.mjs create");
  process.exit(1);
}

let sa = null;
try {
  sa = JSON.parse(readFileSync(new URL("../service-account.json", import.meta.url), "utf8"));
} catch {}
initializeApp(sa ? { credential: cert(sa), projectId: sa.project_id } : { credential: applicationDefault() });
// FIRESTORE_DB_ID selects the database (migration cutover switch); unset = (default).
const db = getFirestore(undefined, process.env.FIRESTORE_DB_ID || "(default)");

/* ---------- foreign names + ids from every other school ---------- */
const foreignNames = new Set();
const foreignIds = new Set();
const schools = await db.collection("schools").get();
for (const s of schools.docs) {
  if (s.id === `${P}school`) continue;
  foreignIds.add(s.id);
  foreignNames.add(String(s.data().name || ""));
  for (const [col, nameField] of [
    ["students", "name"], ["classes", "name"], ["sections", "name"],
    ["subjects", "name"], ["teachers", "name"], ["homeworks", "title"],
    ["fees", "title"], ["exams", "name"], ["users", "name"],
  ]) {
    const snap = await db.collection(col).where("schoolId", "==", s.id).get();
    for (const d of snap.docs) {
      foreignIds.add(d.id);
      const n = d.data()[nameField];
      if (n) foreignNames.add(String(n));
    }
  }
}
console.log(`foreign reference data: ${foreignNames.size} names, ${foreignIds.size} ids from ${schools.size - 1} other school(s)`);

/* ---------- helper ---------- */
async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status} ${await res.text()}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
async function getJSON(cookie, route) {
  const res = await fetch(`${BASE}${route}`, { headers: { cookie }, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { __raw: text.slice(0, 120) }; }
  return { status: res.status, body };
}

/** Walk a payload; return every string value (bounded). */
function walkStrings(v, out, depth = 0) {
  if (depth > 12 || out.size > 20000) return;
  if (typeof v === "string") { out.add(v); return; }
  if (Array.isArray(v)) { for (const x of v) walkStrings(x, out, depth + 1); return; }
  if (v && typeof v === "object") { for (const k of Object.keys(v)) { out.add(k); walkStrings(v[k], out, depth + 1); } }
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✅ ${msg}`);
  else { failures++; console.log(`  ❌ ${msg}`); }
}

const SESSIONS = [
  { label: "school2-admin", email: "zz-iso-admin@test.local", password: CRED.admin },
  { label: "school2-teacher", email: "zz-iso-teacher@test.local", password: CRED.teacher },
  { label: "school2-student", email: "zz-iso-student@test.local", password: CRED.student },
];

for (const acc of SESSIONS) {
  console.log(`\n### ${acc.label}`);
  const cookie = await login(acc.email, acc.password);
  const routes = [
    "/api/chat",
    "/api/assignments",
    "/api/homework",
    "/api/fees",
    "/api/meetings",
    "/api/exams",
    "/api/routines",
    "/api/attendance?classId=zziso-class&date=2026-09-11",
    "/api/classes",
    "/api/stats",
  ];
  for (const route of routes) {
    const { status, body } = await getJSON(cookie, route);
    if (status === 403) { console.log(`  ⛔ 403 (expected for role)  ${route}`); continue; }
    if (status !== 200) { failures++; console.log(`  ❌ HTTP ${status}  ${route}  ${JSON.stringify(body).slice(0, 150)}`); continue; }
    const strings = new Set();
    walkStrings(body, strings);
    const leakedNames = [...foreignNames].filter((n) => n && strings.has(n));
    const leakedIds = [...foreignIds].filter((id) => strings.has(id));
    check(leakedNames.length === 0 && leakedIds.length === 0,
      `${route} — no foreign data${leakedNames.length ? ` (NAMES: ${leakedNames.slice(0, 3).join(", ")})` : ""}${leakedIds.length ? ` (IDS: ${leakedIds.slice(0, 3).join(", ")})` : ""}`);
  }
}

/* ---------- fixture visibility (pulls genuinely work) ---------- */
console.log("\n### fixture visibility (school2 teacher)");
const tCookie = await login("zz-iso-teacher@test.local", CRED.teacher);
const hw = await getJSON(tCookie, "/api/homework");
const hwList = hw.body.data || [];
check(hw.status === 200 && hwList.some((h) => h.title === "ZZ Iso Homework"), "homework list contains the fixture homework");
const exams = await getJSON(tCookie, "/api/exams");
check(exams.status === 200 && (exams.body.data || []).some((e) => e.name === "ZZ Iso Exam"), "exam list contains the fixture exam");
const rout = await getJSON(tCookie, "/api/routines");
const rrows = rout.body.data || [];
check(rout.status === 200 && rrows.length >= 1 && JSON.stringify(rrows).includes("ZZ Iso"), "routines contain fixture rows with resolved names");
const att = await getJSON(tCookie, "/api/attendance?classId=zziso-class&date=2026-09-11");
check(att.status === 200 && (att.body.data || []).some((a) => a.id === "zziso-student" && a.status === "PRESENT"), "attendance returns the fixture student row (PRESENT)");

console.log("\n### fixture visibility (school2 teacher chat thread)");
const chat = await getJSON(tCookie, "/api/chat");
const convs = chat.body.data || [];
check(chat.status === 200 && convs.some((c) => c.id === "zziso-conv"), "chat lists the fixture conversation");

console.log("\n### userNamesFor school-scoping (school2 admin sees only ZZ names in routines/homework)");
const aCookie = await login("zz-iso-admin@test.local", CRED.admin);
const r2 = await getJSON(aCookie, "/api/routines");
const names = new Set();
walkStrings(r2.body, names);
const zzNames = [...names].filter((n) => typeof n === "string" && n.startsWith("ZZ Iso"));
check(zzNames.includes("ZZ Iso Teacher"), "routines resolve the fixture teacher name");
check(![...names].some((n) => /^s_[0-9a-f]{40}$/.test(n)), "no foreign school ids anywhere in routines payload");

console.log(failures === 0 ? "\n✅ ISOLATION CONFIRMED — no cross-school data in any of the 10 routes" : `\n❌ ${failures} isolation failure(s)`);
process.exit(failures === 0 ? 0 : 1);
