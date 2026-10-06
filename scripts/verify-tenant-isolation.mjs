/**
 * verify-tenant-isolation.mjs — pre-push cross-school isolation check.
 *
 * Logs in as the THROWAWAY fixture school's admin/teacher/student (created by
 * isolation-fixture.mjs) and calls the 10 swept routes. Asserts:
 *   1. fixture rows ARE visible (pulls genuinely work, not just empty), and
 *   2. NO name or id belonging to any other school in the DB appears in any
 *      payload (names/ids collected from Firestore across all other schools).
 *
 * Usage: node scripts/verify-tenant-isolation.mjs   (BASE, default http://localhost:3000)
 * Cleanup afterwards: node scripts/isolation-fixture.mjs clean
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";

import { requireEmulator } from "./lib/guard.mjs";

requireEmulator();

const BASE = process.env.BASE || "http://localhost:3000";
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

// Emulator-only, credential-free init with the SAME project id as seed.mjs, so
// the fixture and the seeded tenants share one emulator namespace. No
// service-account.json, no cert(), no applicationDefault().
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

/* ---------- foreign names + ids from every other school ---------- */
const foreignNames = new Set();
const foreignIds = new Set();
let foreignClassId = null; // one real foreign class id, used by the read probe
const schools = await db.collection("schools").get();
for (const s of schools.docs) {
  if (s.id === `${P}school`) continue;
  foreignIds.add(s.id);
  if (s.data().name) foreignNames.add(String(s.data().name));
  for (const [col, nameField] of [
    ["students", "name"], ["classes", "name"], ["sections", "name"],
    ["subjects", "name"], ["teachers", "name"], ["homeworks", "title"],
    ["fees", "title"], ["exams", "name"], ["users", "name"],
  ]) {
    const snap = await db.collection(col).where("schoolId", "==", s.id).get();
    for (const d of snap.docs) {
      foreignIds.add(d.id);
      if (col === "classes" && !foreignClassId) foreignClassId = d.id;
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
  if (v && typeof v === "object") { for (const k of Object.keys(v)) walkStrings(v[k], out, depth + 1); }
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✅ ${msg}`);
  else { failures++; console.log(`  ❌ ${msg}`); }
}

// A cross-school isolation test is only meaningful when a genuine foreign tenant
// exists to be excluded. Fail (never pass) on an empty foreign set.
console.log("\n### foreign tenant availability");
check(foreignIds.size > 0 && foreignNames.size > 0,
  `a real foreign tenant exists — ${foreignNames.size} name(s), ${foreignIds.size} id(s) from ${schools.size - 1} other school(s)`);

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
  let inspected = 0;
  for (const route of routes) {
    const { status, body } = await getJSON(cookie, route);
    if (status === 403) { console.log(`  ⛔ 403 (no access for this role)  ${route}`); continue; }
    if (status !== 200) { failures++; console.log(`  ❌ HTTP ${status}  ${route}  ${JSON.stringify(body).slice(0, 150)}`); continue; }
    inspected++;
    const strings = new Set();
    walkStrings(body, strings);
    const leakedNames = [...foreignNames].filter((n) => n && strings.has(n));
    const leakedIds = [...foreignIds].filter((id) => strings.has(id));
    check(leakedNames.length === 0 && leakedIds.length === 0,
      `${route} — no foreign data${leakedNames.length ? ` (NAMES: ${leakedNames.slice(0, 3).join(", ")})` : ""}${leakedIds.length ? ` (IDS: ${leakedIds.slice(0, 3).join(", ")})` : ""}`);
  }
  // A wall of 403s must not read as a clean isolation result: require that this
  // role actually had an accessible route whose payload was inspected.
  check(inspected > 0, `${acc.label}: at least one accessible route inspected (${inspected} of ${routes.length})`);
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

console.log("\n### cross-tenant read by explicit foreign id");
if (!foreignClassId) {
  check(false, "a foreign class id is available for the read probe");
} else {
  const probe = await getJSON(tCookie, `/api/attendance?classId=${encodeURIComponent(foreignClassId)}&date=2026-09-11`);
  const rows = probe.body?.data || [];
  check(rows.length === 0,
    `supplying another tenant's class id returns no rows — status=${probe.status} rows=${rows.length} (${foreignClassId})`);
}

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
