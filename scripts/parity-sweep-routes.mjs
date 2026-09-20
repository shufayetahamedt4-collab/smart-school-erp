/**
 * parity-sweep-routes.mjs — element-by-element payload parity between the
 * pre-sweep code (commit 3ab64a0, expected on OLD_BASE) and the swept code
 * (expected on NEW_BASE) for /api/chat, /api/assignments and the routes
 * rewritten in the sweep. Deep diff: objects unordered, arrays ordered.
 * Credentials via env (GUARDIAN_EMAIL/GUARDIAN_PASSWORD optional).
 * Usage: node scripts/parity-sweep-routes.mjs
 */
const NEW_BASE = process.env.NEW_BASE || "http://localhost:3000";
const OLD_BASE = process.env.OLD_BASE || "http://localhost:3001";
const GUARDIAN_EMAIL = process.env.GUARDIAN_EMAIL || "guardian1@demo.com";
const GUARDIAN_PASSWORD = process.env.GUARDIAN_PASSWORD || "Guardian@123";
import { readFileSync, existsSync } from "node:fs";

const ACCOUNTS = [
  { label: "school-admin", email: "principal@sunrise.edu", password: "School@123" },
  { label: "teacher", email: "teacher@sunrise.edu", password: "Teacher@123" },
  { label: "guardian", email: GUARDIAN_EMAIL, password: GUARDIAN_PASSWORD },
];

// Optional role 1 — QR guardian (session carries studentId, the fast path).
// Credentials via env only (same convention as parity-diff-qr.mjs).
if (process.env.QR_TOKEN && process.env.QR_PIN) {
  ACCOUNTS.push({ label: "qr-guardian(studentId)", kind: "qr" });
} else {
  console.log("(QR_TOKEN/QR_PIN not set — skipping QR-guardian role)");
}
// Optional role 2 — STUDENT session, via the isolation fixture's demo-student
// user. Credentials live ONLY in the untracked .qa-fixtures.json track file.
const TRACK = new URL(".qa-fixtures.json", import.meta.url);
if (existsSync(TRACK)) {
  const track = JSON.parse(readFileSync(TRACK, "utf8"));
  if (track.creds?.demoStudent) {
    ACCOUNTS.push({ label: "student(fixture)", kind: "student", email: "zz-iso-demo-student@test.local", password: track.creds.demoStudent });
  } else {
    console.log("(fixture track lacks student creds — skipping student role)");
  }
} else {
  console.log("(no scripts/.qa-fixtures.json — skipping student role; run isolation-fixture.mjs create)");
}

async function login(base, email, password) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`login ${email}@${base}: ${res.status} ${await res.text()}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
/** Session cookie per role kind — QR guardians log in via /api/qr/verify. */
async function cookieFor(base, acc) {
  if (acc.kind === "qr") {
    const res = await fetch(`${base}/api/qr/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: process.env.QR_TOKEN, pin: process.env.QR_PIN }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw new Error(`qr login@${base}: ${res.status} ${await res.text()}`);
    return (res.headers.get("set-cookie") || "").split(";")[0];
  }
  return login(base, acc.email, acc.password);
}
async function getJSON(base, cookie, route) {
  const res = await fetch(`${base}${route}`, { headers: { cookie }, signal: AbortSignal.timeout(60000) });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { __raw: text.slice(0, 120) }; }
}

/* ---------- deep diff (objects unordered, arrays ordered) ---------- */
const isObj = (v) => v && typeof v === "object" && !(v instanceof Date);
const dateVal = (v) => (v instanceof Date ? v.toISOString() : v);
const diffs = [];
function diff(a, b, path) {
  if (a === b) return;
  const da = dateVal(a), db = dateVal(b);
  if (da === db) return;
  if (isObj(a) && isObj(b) && !Array.isArray(a) && !Array.isArray(b)) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if (!(k in a)) diffs.push(`${path}.${k}: MISSING in OLD`); else if (!(k in b)) diffs.push(`${path}.${k}: MISSING in NEW`); else diff(a[k], b[k], `${path}.${k}`);
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) diffs.push(`${path}: ARRAY LENGTH old=${a.length} new=${b.length}`);
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) diff(a[i], b[i], `${path}[${i}]`);
    return;
  }
  diffs.push(`${path}: old=${JSON.stringify(da)} new=${JSON.stringify(db)}`);
}

const today = new Date();
const TODAY = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

let mismatches = 0;
for (const acc of ACCOUNTS) {
  const [newCookie, oldCookie] = await Promise.all([
    cookieFor(NEW_BASE, acc),
    cookieFor(OLD_BASE, acc),
  ]);
  // Discover a classId from each server's own /api/classes (ids are stable).
  const clsNew = (await getJSON(NEW_BASE, newCookie, "/api/classes")).data || [];
  const clsOld = (await getJSON(OLD_BASE, oldCookie, "/api/classes")).data || [];
  const c1 = (clsNew[0]?.id && clsOld[0]?.id && clsNew[0].id === clsOld[0].id) ? clsNew[0].id : clsNew[0]?.id || "";

  const routes = [
    "/api/chat",
    "/api/chat?conversationId=__CONV__",
    "/api/assignments",
    "/api/homework",
    "/api/fees",
    "/api/meetings",
    "/api/exams",
    "/api/routines",
    `/api/attendance?classId=${c1}&date=${TODAY}`,
    "/api/stats",
  ];
  console.log(`\n### ${acc.label}`);
  for (let route of routes) {
    if (route.includes("__CONV__")) {
      const listNew = (await getJSON(NEW_BASE, newCookie, "/api/chat")).data || [];
      const listOld = (await getJSON(OLD_BASE, oldCookie, "/api/chat")).data || [];
      const conv = listNew[0]?.id && listNew[0].id === listOld[0]?.id ? listNew[0].id : null;
      if (!conv) { console.log(`  (no shared conversation — skipping thread view)`); continue; }
      route = route.replace("__CONV__", conv);
    }
    const [a, b] = await Promise.all([
      getJSON(OLD_BASE, oldCookie, route),
      getJSON(NEW_BASE, newCookie, route),
    ]);
    diffs.length = 0;
    diff(a, b, "$");
    if (diffs.length === 0) {
      console.log(`  ✅ IDENTICAL  ${route}`);
    } else {
      mismatches++;
      console.log(`  ❌ ${diffs.length} diff(s)  ${route}`);
      for (const d of diffs.slice(0, 12)) console.log(`       ${d}`);
      if (diffs.length > 12) console.log(`       … +${diffs.length - 12} more`);
    }
  }
}
console.log(mismatches === 0 ? "\n✅ PARITY CONFIRMED across all roles and routes" : `\n❌ ${mismatches} route(s) differ`);
process.exit(mismatches === 0 ? 0 : 1);
