#!/usr/bin/env node
/**
 * smoke-all.mjs — whole-project smoke test.
 *
 * Logs in once per role on the role's OWN host (session cookies are host-only),
 * then GETs every page route and every GET API route, checking for non-200
 * responses and Next.js error markers in the HTML. Read-only: no writes.
 *
 * Local:      SMOKE_PORT=3123 node scripts/smoke-all.mjs
 * Deployed:   SMOKE_ORIGIN=https://<backend>--<project>.<region>.hosted.app node scripts/smoke-all.mjs
 *
 * SMOKE_ORIGIN may also carry `{app}`, filled per role, once the deployment has
 * APP_DOMAIN + the four app subdomains live — the same sweep, then against the
 * real hosts (and the hub for /welcome, /login, /qr, /s/[slug], /apply):
 *   SMOKE_ORIGIN=https://{app}.example.com node scripts/smoke-all.mjs
 * Every app is reachable on ONE host too (the hub serves each area to its own
 * role), so a plain origin sweeps a deployment that has no subdomains yet.
 */
// NB: this shell exports PORT=0, so never read process.env.PORT here.
const PORT = process.env.SMOKE_PORT || "3000";
const LOCAL_BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = (process.env.SMOKE_ORIGIN || "").trim().replace(/\/+$/, "");
/** App label per role — the first label of the host the app answers on. */
const APP_LABEL = { "super-admin": "admin", "school-admin": "school", teacher: "teacher", guardian: "parents" };

/** Where a virtual host lives on this run: the local port, or the deployment. */
function originFor(host) {
  if (!ORIGIN) return LOCAL_BASE;
  if (!ORIGIN.includes("{app}")) return ORIGIN;
  const first = String(host || "").split(":")[0].split(".")[0];
  const label = Object.keys(APP_LABEL).find((k) => APP_LABEL[k] === first);
  return label ? ORIGIN.replace("{app}", label) : ORIGIN.replace("{app}.", "");
}

const ROLES = [
  { label: "super-admin", host: `admin.localhost:${PORT}`, id: "admin@smartschool.com", pw: "Admin@123" },
  { label: "school-admin", host: `school.localhost:${PORT}`, id: "principal@sunrise.edu", pw: "School@123" },
  { label: "teacher", host: `teacher.localhost:${PORT}`, id: "teacher@sunrise.edu", pw: "Teacher@123" },
  { label: "guardian", host: `parents.localhost:${PORT}`, id: "guardian1@demo.com", pw: "Guardian@123" },
];

// Page routes per host. Dynamic segments are filled where a value is known.
const PAGES = {
  "super-admin": ["/admin", "/admin/schools", "/admin/billing", "/admin/settings"],
  "school-admin": [
    "/dashboard", "/dashboard/admissions", "/dashboard/admissions/new", "/dashboard/branches", "/dashboard/classes",
    "/dashboard/complaints", "/dashboard/exams", "/dashboard/fees", "/dashboard/gallery",
    "/dashboard/grades",
    "/dashboard/guardian-app", "/dashboard/guardians", "/dashboard/id-cards", "/dashboard/leaves",
    "/dashboard/ledger", "/dashboard/library", "/dashboard/meetings", "/dashboard/messages",
    "/dashboard/notices", "/dashboard/promotion", "/dashboard/reports", "/dashboard/resources",
    "/dashboard/routine", "/dashboard/settings", "/dashboard/staff", "/dashboard/students",
    "/dashboard/students/new", "/dashboard/subjects", "/dashboard/teachers",
  ],
  teacher: [
    "/teacher", "/teacher/attendance", "/teacher/grades", "/teacher/homework", "/teacher/leaves", "/teacher/marks",
    "/teacher/meetings", "/teacher/messages", "/teacher/quizzes", "/teacher/remarks",
    "/teacher/resources", "/teacher/results",
  ],
  guardian: [
    "/parent", "/parent/attendance", "/parent/books", "/parent/feedback", "/parent/fees",
    "/parent/gallery", "/parent/homework", "/parent/leave", "/parent/meetings", "/parent/messages",
    "/parent/notices", "/parent/profile", "/parent/quizzes", "/parent/remarks", "/parent/resources",
    "/parent/results",
  ],
};

// GET API routes (no params).
const APIS = {
  "super-admin": ["/api/schools", "/api/stats", "/api/settings"],
  "school-admin": ["/api/students", "/api/teachers", "/api/classes", "/api/sections", "/api/subjects",
    "/api/fees", "/api/exams", "/api/homework", "/api/attendance", "/api/notices",
    "/api/meetings", "/api/guardians", "/api/messages", "/api/chat", "/api/stats", "/api/settings"],
  teacher: ["/api/students", "/api/classes", "/api/sections", "/api/subjects", "/api/fees",
    "/api/exams", "/api/homework", "/api/attendance", "/api/notices", "/api/meetings",
    "/api/messages", "/api/chat", "/api/stats"],
  guardian: ["/api/fees", "/api/homework", "/api/attendance", "/api/exams", "/api/notices",
    "/api/meetings", "/api/messages", "/api/chat", "/api/stats"],
};

const HUB_PAGES = ["/login", "/welcome", "/qr", "/s/sunrise", "/apply"];
const ERROR_MARKERS = ["Application error", "Unhandled Runtime Error", "Internal Server Error", "digest="];

// Print pages carry ids in the URL, so each entry is [path, marker the finished
// document must contain] — a 200 is not enough when the page can also render its
// own "not found" notice. The demo tenant's ids are stable; point the env vars
// at another tenant to check a different one.
const DEMO = {
  studentId: process.env.SMOKE_STUDENT_ID || "st_ba99122920f48693f156f2b16e57ef66",
  examId: process.env.SMOKE_EXAM_ID || "Z1lw7KL79rR0Wv22MfU9",
};
const PRINT_PAGES = {
  "school-admin": [
    [`/print/marksheet/${DEMO.studentId}`, "Academic Marksheet"],
    [`/print/report-card/${DEMO.examId}/${DEMO.studentId}`, "Grading scale"],
  ],
  guardian: [[`/print/marksheet/${DEMO.studentId}`, "Academic Marksheet"]],
};

const fails = [];
function bad(role, route, detail) {
  fails.push(`${role} ${route}: ${detail}`);
  console.log(`  ❌ ${route} — ${detail}`);
}

// Node cannot resolve *.localhost on Windows, so connect to the loopback IP and
// carry the virtual host in the Host header (what the browser would send).
async function req(host, path, opts = {}) {
  const base = originFor(host);
  // Node cannot resolve *.localhost on Windows locally, so the virtual host
  // travels in the Host header; against a deployment the host is in the URL.
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { ...(ORIGIN ? {} : { Host: host }), ...(opts.headers || {}) },
    redirect: "manual",
    signal: AbortSignal.timeout(45000),
  });
  const body = await res.text();
  return { status: res.status, body, location: res.headers.get("location") || "", setCookie: res.headers.get("set-cookie") || "" };
}

async function login(host, id, pw) {
  const res = await req(host, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: id, password: pw }),
  });
  const cookie = res.setCookie.split(";")[0];
  return { status: res.status, cookie };
}

const get = (host, path, cookie) => req(host, path, cookie ? { headers: { cookie } } : {});

const su = process.env.SUPERADMIN_EMAIL, sp = process.env.SUPERADMIN_PASSWORD;
if (su) { ROLES[0].id = su; ROLES[0].pw = sp; }

console.log("=== hub ===");
for (const p of HUB_PAGES) {
  const r = await get(`localhost:${PORT}`, p, "");
  if (r.status !== 200) bad("hub", p, `HTTP ${r.status}${r.location ? " → " + r.location : ""}`);
  else if (!["/qr", "/s/sunrise"].includes(p) && ERROR_MARKERS.some((m) => r.body.includes(m))) bad("hub", p, "error marker in HTML");
  else console.log(`  ✅ ${p}`);
}

/*
 * The platform address: a host that has no app subdomains — a bare IP, or a
 * single-URL deployment such as <site>.netlify.app. That host already serves
 * every app, so /login there must be a real sign-in screen (the account decides
 * which app opens), never a directory of links that go nowhere.
 */
if (!ORIGIN) {
  console.log("\n=== platform address (no app subdomains) ===");
  const host = `127.0.0.1:${PORT}`;
  const page = await get(host, "/login", "");
  if (page.status !== 200) bad("platform", "/login", `HTTP ${page.status}`);
  else if (!page.body.includes('name="identifier"') || !page.body.includes("Demo account"))
    bad("platform", "/login", "no sign-in form (a directory of dead links?)");
  else console.log("  ✅ /login is a sign-in form");

  const staff = ROLES.find((r) => r.host.startsWith("school."));
  const guardian = ROLES.find((r) => r.host.startsWith("parents."));
  const staffLogin = await login(host, staff.id, staff.pw);
  if (staffLogin.status !== 200 || !staffLogin.cookie) {
    bad("platform", "/api/auth/login", `HTTP ${staffLogin.status}, cookie=${!!staffLogin.cookie}`);
  } else {
    console.log(`  ✅ sign-in accepted (${staff.label} on the platform address)`);
    const home = await get(host, "/dashboard", staffLogin.cookie);
    if (home.status !== 200) bad("platform", "/dashboard", `HTTP ${home.status}${home.location ? " → " + home.location : ""}`);
    else if (ERROR_MARKERS.some((m) => home.body.includes(m))) bad("platform", "/dashboard", "error marker in HTML");
    else console.log("  ✅ /dashboard after sign-in");
  }
  // One address, four apps: the ACCOUNT picks the app, and it must pick right.
  const guardianBody = await req(host, "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: guardian.id, password: guardian.pw }),
  });
  const redirect = (() => {
    try {
      return JSON.parse(guardianBody.body)?.data?.redirect;
    } catch {
      return null;
    }
  })();
  if (redirect !== "/parent") bad("platform", "/api/auth/login (guardian)", `redirect=${redirect}`);
  else console.log("  ✅ a guardian lands in /parent");
}

for (const role of ROLES) {
  console.log(`\n=== ${role.label} (${role.host}) ===`);
  const { status, cookie } = await login(role.host, role.id, role.pw);
  if (status !== 200 || !cookie) { bad(role.label, "/api/auth/login", `HTTP ${status}, cookie=${!!cookie}`); continue; }
  console.log(`  ✅ login (cookie ok)`);

  for (const p of PAGES[role.label] || []) {
    const r = await get(role.host, p, cookie);
    if (r.status !== 200) bad(role.label, p, `HTTP ${r.status}${r.location ? " → " + r.location : ""}`);
    else if (ERROR_MARKERS.some((m) => r.body.includes(m))) bad(role.label, p, "error marker in HTML");
    else console.log(`  ✅ ${p}`);
  }
  for (const [p, marker] of PRINT_PAGES[role.label] || []) {
    const r = await get(role.host, p, cookie);
    if (r.status !== 200) bad(role.label, p, `HTTP ${r.status}${r.location ? " → " + r.location : ""}`);
    else if (ERROR_MARKERS.some((m) => r.body.includes(m))) bad(role.label, p, "error marker in HTML");
    else if (!r.body.includes(marker)) bad(role.label, p, `rendered but missing "${marker}"`);
    else console.log(`  ✅ ${p} (${marker})`);
  }
  for (const a of APIS[role.label] || []) {
    const r = await get(role.host, a, cookie, true);
    // Documented, intentional non-200s:
    //   /api/attendance without classId+date → 400 (caller must supply both)
    //   /api/stats for SUPER_ADMIN without ?schoolId → 400 (needs a school)
    //   guardian /api/attendance → 403 (guardians read their child via
    //     /api/students/<id>, which the Attendance page actually uses)
    const EXPECTED = {
      "/api/attendance": role.label === "guardian" ? 403 : 400,
      "/api/stats": 400,
    };
    const want = EXPECTED[a];
    if (r.status !== 200 && r.status !== want) bad(role.label, a, `HTTP ${r.status}`);
    else if (r.status === 200) {
      try { JSON.parse(r.body); console.log(`  ✅ ${a}`); }
      catch { bad(role.label, a, `non-JSON body (${r.body.slice(0, 60)}…)`); }
    } else console.log(`  ✅ ${a} (intentional ${r.status})`);
  }
}

console.log(`\n${fails.length ? `❌ ${fails.length} FAILURE(S)` : "✅ ALL GREEN"}`);
for (const f of fails) console.log("  - " + f);
process.exit(fails.length ? 1 : 0);
