/**
 * verify-read-cache.mjs — prove the read cache turns a repeat click from
 * ~550ms of Firestore round trip into ~2ms.
 *
 * For each route it calls the endpoint twice back-to-back and reports both
 * timings. The first call may pay the real Firestore cost (a cold pull); the
 * second must be served from the in-process pull cache and be dramatically
 * faster. A "worst pair" that shows no gap means that route bypasses the
 * cache — which is the bug this harness exists to catch.
 *
 * Usage: node scripts/verify-read-cache.mjs [port]
 */
const PORT = Number(process.argv[2] || process.env.SMOKE_PORT || 3000);
const BASE = `http://127.0.0.1:${PORT}`;

const ROLES = [
  { label: "school-admin", host: `school.localhost:${PORT}`, id: "principal@sunrise.edu", pw: "School@123" },
  { label: "teacher", host: `teacher.localhost:${PORT}`, id: "teacher@sunrise.edu", pw: "Teacher@123" },
  { label: "guardian", host: `parents.localhost:${PORT}`, id: "guardian1@demo.com", pw: "Guardian@123" },
];

const ROUTES = [
  "/api/stats",
  "/api/students",
  "/api/sections",
  "/api/classes",
  "/api/subjects",
  "/api/teachers",
  "/api/fees",
  "/api/exams",
  "/api/notices?limit=5",
  "/api/ledger",
  "/api/admissions",
  "/api/routines",
  "/api/meetings",
  "/api/resources",
  "/api/gallery",
  "/api/complaints",
  "/api/notifications?countOnly=1",
];

async function login(host, id, pw) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Host: host },
    body: JSON.stringify({ identifier: id, password: pw }),
  });
  if (!res.ok) throw new Error(`login ${id}: ${res.status}`);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("no cookie");
  return cookie;
}

async function hit(host, cookie, route) {
  const t0 = performance.now();
  let status = 0;
  try {
    const res = await fetch(`${BASE}${route}`, { headers: { cookie, Host: host }, signal: AbortSignal.timeout(20000) });
    status = res.status;
    await res.text();
  } catch {
    /* timeouts count as the elapsed time we measured */
  }
  return { ms: Math.round(performance.now() - t0), status };
}

let failures = 0;
for (const role of ROLES) {
  let cookie;
  try {
    cookie = await login(role.host, role.id, role.pw);
  } catch (e) {
    console.log(`\n### ${role.label}: LOGIN FAILED — ${e.message}`);
    failures++;
    continue;
  }
  console.log(`\n### ${role.label}`);
  // Warm every route once first, so the pair below measures repeats, not
  // first-ever traffic.
  for (const r of ROUTES) await hit(role.host, cookie, r);

  for (const r of ROUTES) {
    const a = await hit(role.host, cookie, r);
    const b = await hit(role.host, cookie, r);
    const ok = b.ms <= 50 || b.ms * 3 < a.ms;
    if (!ok) failures++;
    console.log(
      `${ok ? "ok  " : "SLOW"}  cold ${String(a.ms).padStart(5)}ms → warm ${String(b.ms).padStart(5)}ms  ${a.status}  ${r}`
    );
  }
}

console.log(
  failures === 0
    ? "\nPASS — every route serves a repeat read from cache."
    : `\nFAIL — ${failures} route(s) still pay full latency on a repeat read.`
);
process.exit(failures === 0 ? 0 : 1);
