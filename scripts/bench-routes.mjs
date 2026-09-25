/**
 * bench-routes.mjs — sweep baseline: time the main GET routes per role.
 * Login → warm the page's core endpoints → best-of-N per route.
 * Usage: node scripts/bench-routes.mjs [N=2]
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";
const N = Number(process.argv[2] || 2);

const ROLES = [
  { label: "admin", email: "principal@sunrise.edu", password: "School@123" },
  { label: "teacher", email: "teacher@sunrise.edu", password: "Teacher@123" },
  { label: "guardian", email: "guardian1@demo.com", password: "Guardian@123" },
];

const ROUTES = {
  admin: ["/api/stats", "/api/notices?limit=5", "/api/classes", "/api/students", "/api/teachers", "/api/fees", "/api/exams", "/api/attendance?classId=__C1__&date=__TODAY__", "/api/admissions", "/api/ledger", "/api/meetings", "/api/notifications?countOnly=1", "/api/leave-requests", "/api/routines", "/api/subjects", "/api/sections", "/api/fee-templates", "/api/gallery", "/api/complaints", "/api/resources"],
  teacher: ["/api/stats", "/api/notifications?countOnly=1", "/api/attendance?classId=__C1__&date=__TODAY__", "/api/homework", "/api/remarks", "/api/classes", "/api/students", "/api/exams", "/api/leave-requests", "/api/meetings", "/api/resources"],
  guardian: ["/api/stats", "/api/notifications?countOnly=1", "/api/homework", "/api/fees", "/api/remarks", "/api/exams", "/api/meetings", "/api/leave-requests", "/api/parent/siblings"],
};

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
  });
  if (!res.ok) throw new Error(`login ${email}: ${res.status}`);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error("no cookie");
  return cookie;
}

async function timeGet(cookie, route) {
  const t0 = performance.now();
  let status = 0, len = 0;
  try {
    const res = await fetch(`${BASE}${route}`, { headers: { cookie }, signal: AbortSignal.timeout(20000) });
    status = res.status;
    const text = await res.text();
    len = text.length;
  } catch (e) {
    return { ms: Math.round(performance.now() - t0), status: 0, len: 0, err: String(e).slice(0, 60) };
  }
  return { ms: Math.round(performance.now() - t0), status, len };
}

const today = new Date();
const TODAY = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

for (const role of ROLES) {
  let cookie;
  try {
    cookie = await login(role.email, role.password);
  } catch (e) {
    console.log(`\n### ${role.label}: LOGIN FAILED — ${e.message}`);
    continue;
  }
  console.log(`\n### ${role.label}`);
  const routes = [...ROUTES[role.label]];
  // Resolve per-role placeholders (a real class id + today's date) so the
  // harness measures the route instead of a 404/400. `/api/classes` is the one
  // source every role that has a class filter can read.
  for (let i = 0; i < routes.length; i++) {
    let r = routes[i].replace("__TODAY__", TODAY);
    if (r.includes("__C1__")) {
      const st = await (await fetch(`${BASE}/api/stats`, { headers: { cookie } })).json();
      let c1 = st?.data?.myClasses?.[0]?.id || st?.data?.assignments?.[0]?.classId || "";
      if (!c1) {
        const cls = await (await fetch(`${BASE}/api/classes`, { headers: { cookie } })).json().catch(() => null);
        c1 = cls?.data?.[0]?.id || "";
      }
      r = r.replace("__C1__", c1);
    }
    routes[i] = r;
  }
  // warm pass (also compiles routes) then measure
  for (const r of routes) await timeGet(cookie, r);
  const rows = [];
  for (const r of routes) {
    let best = { ms: Infinity, status: 0, len: 0 };
    for (let i = 0; i < N; i++) {
      const s = await timeGet(cookie, r);
      if (s.ms < best.ms) best = s;
    }
    rows.push({ route: r, ...best });
  }
  rows.sort((a, b) => b.ms - a.ms);
  for (const { route, ms, status, len, err } of rows) {
    const flag = ms > 2000 ? " 🔴" : ms > 800 ? " 🟡" : "";
    console.log(`${String(ms).padStart(6)}ms ${status}${err ? " ERR:" + err : ""} ${String(len).padStart(7)}B  ${route}${flag}`);
  }
}
