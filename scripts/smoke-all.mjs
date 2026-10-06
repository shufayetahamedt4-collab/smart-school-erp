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
 *
 * The final section additionally locks the Teacher App's mobile bottom bar: its
 * server HTML must stay tab-bar-free, and the tab / "More" split must stay a
 * partition of the role's nav. That half imports the TypeScript nav module, so
 * on a runner that cannot load .ts (plain node) it reports as SKIPPED rather
 * than failing — run this script with bun to exercise it.
 *
 * And a second closing section lays the Teacher App out in a real headless
 * browser to measure its PHONE layout (see the note there); it also skips, never
 * fails, when no browser can be driven or SMOKE_HEADLESS=0.
 *
 * Two checks SKIP rather than fail when this data cannot satisfy them, because
 * both depend on the seeded state rather than on the code: the print pages (their
 * ids are resolved from the app's own API — set SMOKE_STUDENT_ID /
 * SMOKE_EXAM_ID to pin a pair) and the marks-entry field (which the page locks
 * by design while its exam is published).
 */
// NB: this shell exports PORT=0, so never read process.env.PORT here.
import { requireEmulator } from "./lib/guard.mjs";

const PORT = process.env.SMOKE_PORT || "3000";
requireEmulator();
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
  "super-admin": ["/admin", "/admin/notifications", "/admin/schools", "/admin/billing", "/admin/settings"],
  "school-admin": [
    "/dashboard", "/dashboard/admissions", "/dashboard/admissions/new", "/dashboard/branches", "/dashboard/classes",
    "/dashboard/complaints", "/dashboard/exams", "/dashboard/fees", "/dashboard/fees/structure",
    "/dashboard/fees/payments", "/dashboard/gallery",
    "/dashboard/grades",
    "/dashboard/guardian-app", "/dashboard/guardians", "/dashboard/id-cards", "/dashboard/leaves",
    "/dashboard/ledger", "/dashboard/library", "/dashboard/live-classes", "/dashboard/meetings", "/dashboard/messages",
    "/dashboard/notices", "/dashboard/notifications", "/dashboard/promotion", "/dashboard/reports", "/dashboard/resources",
    "/dashboard/routine", "/dashboard/settings", "/dashboard/staff", "/dashboard/students",
    "/dashboard/students/new", "/dashboard/subjects", "/dashboard/teachers",
  ],
  teacher: [
    "/teacher", "/teacher/ai", "/teacher/attendance", "/teacher/classes", "/teacher/grades", "/teacher/homework", "/teacher/leaves", "/teacher/marks",
    "/teacher/meetings", "/teacher/messages", "/teacher/notifications", "/teacher/quizzes", "/teacher/remarks",
    "/teacher/resources", "/teacher/results",
  ],
  guardian: [
    "/parent", "/parent/ai", "/parent/attendance", "/parent/books", "/parent/feedback", "/parent/fees",
    "/parent/gallery", "/parent/homework", "/parent/leave", "/parent/live-classes", "/parent/meetings", "/parent/messages",
    "/parent/notices", "/parent/notifications", "/parent/profile", "/parent/quizzes", "/parent/remarks", "/parent/resources",
    "/parent/results",
  ],
};

// GET API routes (no params).
const APIS = {
  "super-admin": ["/api/schools", "/api/stats", "/api/settings", "/api/notifications", "/api/notifications?countOnly=1"],
  "school-admin": ["/api/students", "/api/teachers", "/api/classes", "/api/sections", "/api/subjects",
    "/api/fees", "/api/fee-categories", "/api/fees/settings", "/api/exams", "/api/homework", "/api/attendance", "/api/notices",
    "/api/meetings", "/api/guardians", "/api/messages", "/api/chat", "/api/stats", "/api/settings",
    "/api/notifications", "/api/notifications?countOnly=1", "/api/notifications?filter=unread"],
  teacher: ["/api/students", "/api/classes", "/api/sections", "/api/subjects", "/api/fees",
    "/api/exams", "/api/homework", "/api/attendance", "/api/notices", "/api/meetings",
    "/api/messages", "/api/chat", "/api/stats", "/api/notifications", "/api/notifications?countOnly=1"],
  guardian: ["/api/fees", "/api/homework", "/api/attendance", "/api/exams", "/api/notices",
    "/api/meetings", "/api/messages", "/api/chat", "/api/stats",
    "/api/notifications", "/api/notifications?countOnly=1", "/api/notifications?filter=unread"],
};

const HUB_PAGES = ["/login", "/welcome", "/qr", "/s/sunrise", "/apply"];
const ERROR_MARKERS = ["Application error", "Unhandled Runtime Error", "Internal Server Error", "digest="];

// Print pages carry ids in the URL, so each entry is [path template, marker the
// finished document must contain, the ids that page needs] — a 200 is not enough
// when the page can also render its own "not found" notice.
//
// The ids are NOT hard-coded: a fresh seed mints a new random student id
// (`st_<32 hex>`, crypto.randomBytes) and a new `exams` auto-id, so a literal
// captured from an earlier database points at documents that no longer exist and
// the page answers with its own "not found" notice — a false failure. They are
// resolved at run time from the app's own read-only API (see the lookup below);
// SMOKE_STUDENT_ID / SMOKE_EXAM_ID pin a value when set, and an id that cannot
// be resolved SKIPS the check it feeds instead of failing it.
//
// The guardian page prints the guardian's OWN child and refuses anyone else's,
// so it carries its own id: reusing the school-admin pair there would fail the
// ownership check on every tenant whose marked student is not that guardian's.
const PINNED = {
  studentId: (process.env.SMOKE_STUDENT_ID || "").trim(),
  examId: (process.env.SMOKE_EXAM_ID || "").trim(),
};
const DEMO_ID = {
  studentId: PINNED.studentId,
  examId: PINNED.examId,
  guardianStudentId: PINNED.studentId,
};
/** id key → why that id is missing, for the SKIP lines below. */
const idWhy = {};
const needWhy = (k) => idWhy[k] || "not resolved";
const PRINT_PAGES = {
  "school-admin": [
    ["/print/marksheet/{studentId}", "Academic Marksheet", ["studentId"]],
    ["/print/report-card/{examId}/{studentId}", "Grading scale", ["examId", "studentId"]],
  ],
  guardian: [["/print/marksheet/{guardianStudentId}", "Academic Marksheet", ["guardianStudentId"]]],
};
/** Fill a path template with whatever ids are known (placeholders stay put). */
const printPath = (tpl) => tpl.replace(/\{(\w+)\}/g, (m, k) => DEMO_ID[k] || m);

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
  // /qr (a child's ID-card code) and /s/<slug> (a school's printed invite link)
  // are the credential-free entries into the Parents App. On a host that HAS a
  // guardian address — localhost in development, or APP_DOMAIN on a deployment —
  // the middleware deliberately hands them to that address, so a 307 to
  // parents.<host> is the CORRECT answer there; a single-address deployment with
  // no subdomains serves them directly (200). Both are a pass.
  const guardianHandoff =
    ["/qr", "/s/sunrise"].includes(p) && [307, 308].includes(r.status) && /\/\/parents\./.test(r.location);
  if (r.status !== 200 && !guardianHandoff) bad("hub", p, `HTTP ${r.status}${r.location ? " → " + r.location : ""}`);
  else if (guardianHandoff) console.log(`  ✅ ${p} (handed to the Parents App → ${r.location})`);
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

/*
 * Resolve the print-page ids from the app's own API — read-only.
 *
 * A fresh seed replaces the documents those pages print (random `st_<hex>`
 * students, auto-id exams), so the literal pair this suite used to carry pointed
 * at rows that no longer existed and the print checks read as failures. Instead:
 *
 *   • SMOKE_STUDENT_ID / SMOKE_EXAM_ID pin a value — a pair to print, or another
 *     tenant;
 *   • anything unpinned is resolved from the running app: as the school admin,
 *     an exam somebody has actually been marked on (the marksheet prints nothing
 *     without marks) and one of its seated students — the one pair that
 *     satisfies BOTH admin pages; and as the guardian, that guardian's own
 *     default child;
 *   • an id that cannot be resolved SKIPS the check that needs it, with the
 *     reason, rather than reporting a false failure.
 */
console.log("\n=== print-page ids ===");
{
  const school = ROLES.find((r) => r.label === "school-admin");
  const guardian = ROLES.find((r) => r.label === "guardian");

  if (!DEMO_ID.studentId || !DEMO_ID.examId) {
    const session = await login(school.host, school.id, school.pw);
    if (session.status !== 200 || !session.cookie) {
      idWhy.studentId = idWhy.examId = `school-admin login failed (HTTP ${session.status})`;
    } else {
      const res = await get(school.host, "/api/exams", session.cookie);
      let exams = [];
      if (res.status !== 200) {
        idWhy.studentId = idWhy.examId = `/api/exams answered HTTP ${res.status}`;
      } else {
        try {
          exams = JSON.parse(res.body)?.data || [];
        } catch {
          idWhy.studentId = idWhy.examId = "/api/exams returned a non-JSON body";
        }
      }
      // A pinned exam is tried first (so a pinned pair is never re-paired), then
      // the exam with the most marks: the one that is most likely to seat
      // somebody. An exam nobody has been marked on could only supply a report
      // card, and only a few candidates are worth a round trip each.
      const ranked = [...exams].sort((a, b) => {
        if (a.id === DEMO_ID.examId) return -1;
        if (b.id === DEMO_ID.examId) return 1;
        return (b._count?.marks ?? 0) - (a._count?.marks ?? 0);
      });
      for (const exam of ranked.slice(0, 5)) {
        const detail = await get(school.host, `/api/exams/${exam.id}`, session.cookie);
        if (detail.status !== 200) continue;
        let rows = [];
        try {
          rows = JSON.parse(detail.body)?.data?.students || [];
        } catch {
          rows = [];
        }
        const seated = rows.find((s) => s.studentId && !s.absent && (s.marks || []).length);
        if (seated) {
          DEMO_ID.examId = DEMO_ID.examId || exam.id;
          DEMO_ID.studentId = DEMO_ID.studentId || seated.studentId;
          break;
        }
      }
      if (!DEMO_ID.studentId || !DEMO_ID.examId) {
        const why = exams.length
          ? "no exam of this school has a marked student yet"
          : "this school has no exams";
        if (!DEMO_ID.studentId) idWhy.studentId = why;
        if (!DEMO_ID.examId) idWhy.examId = why;
      }
    }
  }

  // The guardian's own child, from the guardian's own session. A pinned
  // SMOKE_STUDENT_ID stays the fallback when that lookup cannot run.
  if (guardian) {
    const session = await login(guardian.host, guardian.id, guardian.pw);
    if (session.status !== 200 || !session.cookie) {
      if (!DEMO_ID.guardianStudentId) idWhy.guardianStudentId = `guardian login failed (HTTP ${session.status})`;
    } else {
      const me = await get(guardian.host, "/api/auth/me", session.cookie);
      let child = "";
      try {
        child = JSON.parse(me.body)?.data?.student?.id || "";
      } catch {
        child = "";
      }
      if (child) DEMO_ID.guardianStudentId = child;
      else if (!DEMO_ID.guardianStudentId) idWhy.guardianStudentId = `the guardian account (${guardian.id}) has no linked child`;
    }
  }

  const unset = Object.keys(DEMO_ID).filter((k) => !DEMO_ID[k]);
  if (!unset.length) {
    console.log(
      `  ✅ student ${DEMO_ID.studentId} · exam ${DEMO_ID.examId} · guardian child ${DEMO_ID.guardianStudentId}`,
    );
  } else {
    console.log(`  ⏭️  unresolved: ${unset.join(", ")}`);
    for (const k of unset) console.log(`     ${k}: ${needWhy(k)}`);
    console.log("     (set SMOKE_STUDENT_ID / SMOKE_EXAM_ID to pin a pair)");
  }
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
  for (const [tpl, marker, needs] of PRINT_PAGES[role.label] || []) {
    const p = printPath(tpl);
    const missing = needs.filter((k) => !DEMO_ID[k]);
    if (missing.length) {
      // No id, no page to judge: an unresolved half means the document the URL
      // names cannot be known to exist, so this is a SKIP, not a failure.
      console.log(`  ⏭️  SKIPPED ${p} — no ${missing.join(" or ")} (${missing.map(needWhy).join("; ")})`);
      continue;
    }
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

/*
 * Teacher App / Parents App app-shell chrome.
 *
 * The app shell replaced the desktop sidebar for the two phone-first apps. The
 * rail and the phone tab bar are CLIENT-ONLY (the server does not know the
 * session, so it renders the shell skeleton), the phone bar mounts only below
 * 1024px, and the rail shows from 1024px up. The admin/dashboard sectors still
 * render the shared Shell, so they are untouched.
 *
 * An HTTP fetch cannot see a viewport, so this section checks the halves it can:
 *   • the server HTML of /teacher carries no sidebar and no tab-bar markup —
 *     the desktop-parity guarantee;
 *   • the tab / "More" split is a true partition of each app role's own nav
 *     array, with the AI tab the only destination that is not already in it;
 *   • the shell is scoped to the two app roles, never to the admin panel.
 */
console.log("\n=== teacher app chrome ===");
{
  const teacher = ROLES.find((r) => r.label === "teacher");
  const session = await login(teacher.host, teacher.id, teacher.pw);
  if (session.status !== 200 || !session.cookie) {
    bad("teacher", "/teacher (app chrome)", `login HTTP ${session.status}`);
  } else {
    const page = await get(teacher.host, "/teacher", session.cookie);
    const strays = ["ss-chrome", "ss-app-tabbar", 'aria-label="Teacher App tabs"'].filter((m) => page.body.includes(m));
    if (page.status !== 200) bad("teacher", "/teacher (app chrome)", `HTTP ${page.status}`);
    else if (!page.body.includes('data-sector="teacher"')) bad("teacher", "/teacher (app chrome)", "shell did not render");
    else if (strays.length) bad("teacher", "/teacher (app chrome)", `sidebar/tab-bar markup in the server HTML (${strays.join(", ")})`);
    else console.log("  ✅ /teacher server HTML has no sidebar and no tab-bar markup (desktop parity)");
  }

  // The partition check needs the real modules, not copies of their rules.
  let appNav = null;
  let registry = null;
  try {
    appNav = await import("../src/components/app-nav.ts");
    registry = await import("../src/components/nav.ts");
  } catch {
    appNav = null;
    registry = null;
  }

  if (!appNav || !registry) {
    console.log("  ⚠️  SKIPPED app-nav partition — this runner cannot import TypeScript (run with bun)");
  } else {
    let problem = null;
    for (const role of ["TEACHER", "GUARDIAN"]) {
      const tabs = appNav.appTabsFor(role);
      const unionAll = [...tabs, ...appNav.appMoreItemsFor(role)].map((n) => n.href);
      const union = unionAll.filter((h) => !h.endsWith("/ai"));
      const want = registry.NAVS[role].map((n) => n.href);
      const once = new Set(unionAll);
      if (once.size !== unionAll.length) { problem = `${role}: a destination is reachable twice`; break; }
      if (union.length !== want.length || want.some((h) => !once.has(h))) { problem = `${role}: ${union.length} existing reachable, ${want.length} exist`; break; }
      const existing = tabs.filter((t) => !t.href.endsWith("/ai"));
      if (existing.some((t) => !want.includes(t.href))) { problem = `${role}: a tab is not a nav destination`; break; }
    }
    if (problem) bad("teacher", "app-nav partition", problem);
    else console.log("  ✅ app tabs + More partition every app role's nav (each destination once, AI the only addition)");

    const tTabs = appNav.appTabsFor("TEACHER");
    const gTabs = appNav.appTabsFor("GUARDIAN");
    const tAi = tTabs.some((t) => t.href === "/teacher/ai");
    const gAi = gTabs.some((t) => t.href === "/parent/ai");
    if (tTabs.length !== 4 || !tAi) bad("teacher", "app-nav teacher tabs", `tabs=${tTabs.length} ai=${tAi}, want 4 + AI`);
    else if (gTabs.length !== 4 || !gAi) bad("teacher", "app-nav guardian tabs", `tabs=${gTabs.length} ai=${gAi}, want 4 + AI`);
    else console.log(`  ✅ TEACHER ${tTabs.length} tabs + More (incl. AI) · GUARDIAN ${gTabs.length} tabs + More (incl. AI)`);

    const leaked = ["SCHOOL_ADMIN", "SUPER_ADMIN", "ACCOUNTANT", "LIBRARIAN", "not-a-role"].filter((r) => appNav.isAppRole(r));
    if (leaked.length) bad("teacher", "app shell scope", `the app shell would apply to ${leaked.join(", ")}`);
    else console.log("  ✅ app shell applies to TEACHER + GUARDIAN only (admin panel keeps its sidebar)");
  }

  // The phone bar must stay JS-gated on the same 1024px edge as the rail.
  try {
    const { readFile } = await import("node:fs/promises");
    const shell = await readFile(new URL("../src/components/AppShell.tsx", import.meta.url), "utf8");
    const gated = /min-width:\s*1024px/.test(shell);
    const rail = /ss-app-rail/.test(shell) && /lg:flex/.test(shell);
    const bar = /ss-app-tabbar/.test(shell);
    if (!gated || !rail || !bar) bad("teacher", "app shell gate", "the phone-bar gate or the rail/bar hooks are missing");
    else console.log("  ✅ phone bar is JS-gated at 1024px; rail + bar hooks present");
  } catch (e) {
    console.log(`  ⚠️  SKIPPED app shell gate lock — ${e && e.message ? e.message : e}`);
  }

  // ---- phone-only CSS: every app phone rule is scoped, and scoped off ----
  //
  // Two properties, checked against the CSS the build actually SERVED rather
  // than the source it came from, so a build-time change cannot slip past:
  //
  //   1. every rule inside a <768px block must name an APP sector — the Teacher
  //      App or the Parents App (both are phone-first apps). A rule that names
  //      neither would restyle /admin, /dashboard and the login page at the same
  //      width;
  //   2. a class that a phone rule styles is phone-only BY CONSTRUCTION, so
  //      none of those classes may be referenced outside those blocks. That is
  //      exactly what keeps desktop byte-identical to the T0 baseline.
  //
  // Before the Guardian mobile app redesign this asserted TEACHER only; the
  // Parents App now owns its own phone CSS too, so both app sectors are valid.
  //
  // The class set is DERIVED from the served CSS instead of listed, so a new
  // phone-only class is covered the day it is written. `.ss-sheet-in` is
  // deliberately not one of them: its rules are global by design and the sheet
  // element only ever mounts below 768px (the bar's JS gate), so it cannot leak.
  try {
    const { readFile } = await import("node:fs/promises");
    const att = await get(teacher.host, "/teacher/attendance", session.cookie);
    const hrefs = [...new Set([...att.body.matchAll(/href="([^"]+\.css[^"]*)"/g)].map((m) => m[1]))];
    let css = "";
    for (const href of hrefs) {
      const path = href.startsWith("http") ? new URL(href).pathname : href;
      const sheet = await req(teacher.host, path, { headers: { cookie: session.cookie } });
      if (sheet.status === 200) css += sheet.body;
    }

    // Brace-match every `max-width: 767.98px` block. The minifier MERGES the
    // hand-written ones (the live build serves two), so this collects ranges
    // rather than assuming a single block.
    const ranges = [];
    const reMedia = /@media[^{]*max-width:\s*767\.98px[^{]*\{/g;
    let med;
    while ((med = reMedia.exec(css))) {
      let depth = 1;
      let i = med.index + med[0].length;
      while (i < css.length && depth > 0) {
        const ch = css[i++];
        if (ch === "{") depth++;
        else if (ch === "}") depth--;
      }
      ranges.push({ start: med.index + med[0].length, end: i - 1 });
    }

    // Split each range into its rules, taking only the top level of the block.
    const selectors = [];
    for (const range of ranges) {
      const block = css.slice(range.start, range.end);
      let depth = 0;
      let from = 0;
      for (let i = 0; i < block.length; i++) {
        const ch = block[i];
        if (ch === "{") {
          if (depth === 0) selectors.push(block.slice(from, i).trim());
          depth++;
        } else if (ch === "}") {
          depth--;
          if (depth === 0) from = i + 1;
        }
      }
    }

    // Every class a phone rule styles, versus every class referenced elsewhere.
    const inRange = (i) => ranges.some((r) => i >= r.start && i < r.end);
    const phoneClasses = new Set();
    const otherClasses = new Set();
    const reCls = /\.ss-[a-z0-9-]+/g;
    let cls;
    while ((cls = reCls.exec(css))) (inRange(cls.index) ? phoneClasses : otherClasses).add(cls[0]);

    // A <768px rule is scoped when it names either phone-first app sector; a
    // rule that names neither would restyle the console or the login page.
    const appScoped = /\[data-sector=["']?(teacher|guardian)/;
    const unscoped = selectors.filter((s) => !appScoped.test(s));
    const leaking = [...phoneClasses].filter((c) => otherClasses.has(c));

    // ...and that the roster is still ONE list rendered from ONE array with no
    // table left behind, so the "one DOM, one state" property holds. (Counting
    // `rows.map(` would not do: the save payload maps the same array too, which
    // is fine — it renders nothing.)
    const src = await readFile(new URL("../src/app/teacher/attendance/page.tsx", import.meta.url), "utf8");
    const tables = (src.match(/<table/g) || []).length;
    const rowTemplates = (src.match(/<li key=/g) || []).length;

    if (att.status !== 200) bad("teacher", "teacher phone CSS", `HTTP ${att.status}`);
    else if (!hrefs.length || !css) bad("teacher", "teacher phone CSS", "no stylesheet was served — update this check");
    else if (!ranges.length) bad("teacher", "teacher phone CSS", "no <768px media query in the served CSS");
    else if (!selectors.length) bad("teacher", "teacher phone CSS", "could not parse a rule out of the <768px blocks");
    else if (!phoneClasses.size) bad("teacher", "teacher phone CSS", "no phone-only class found — has the parse moved?");
    else if (unscoped.length) bad("teacher", "teacher phone CSS", `${unscoped.length} phone rule(s) name neither app sector (teacher/guardian) and would restyle the console or the login page: ${unscoped[0].slice(0, 70)}`);
    else if (leaking.length) bad("teacher", "teacher phone CSS", `${leaking.join(", ")} styled for phones but referenced outside the <768px block — desktop at risk`);
    else if (tables !== 0 || rowTemplates !== 1) bad("teacher", "teacher phone CSS", `expected no <table> and one roster row template, found ${tables} and ${rowTemplates}`);
    else {
      console.log(`  ✅ teacher phone CSS: ${selectors.length} rules over ${phoneClasses.size} classes, all scoped to an app sector (teacher/guardian) in <768px and none outside it`);
      console.log(`       ${[...phoneClasses].sort().join(", ")}`);
    }

    // ---- the marks field is a real, editable, thumb-sized input at every width ----
    //
    // The sheet is now the app's inset card list, so the field fills its row
    // structurally (it is a flex child) instead of via a <768px width override.
    // Three things must still hold: it is a REAL bound <input type="number">
    // (never decorative text), it carries the app's 44px touch height, and no
    // <table> is left behind.
    const marksSrc = await readFile(new URL("../src/app/teacher/marks/page.tsx", import.meta.url), "utf8");
    const marksTables = (marksSrc.match(/<table/g) || []).length;
    const markInput = (marksSrc.match(/<input[\s\S]*?type="number"[\s\S]*?\/>/) || [""])[0];
    const bound = /type="number"/.test(markInput) && /onChange=/.test(markInput) && /value=\{val\}/.test(markInput);
    const thumbSized = /min-h-11/.test(markInput);
    const fillsRow = /w-full/.test(markInput) || /flex-1/.test(markInput);

    if (marksTables !== 0) bad("teacher", "teacher marks field", `${marksTables} <table> left in the marks page — the sheet should be a card list`);
    else if (!bound) bad("teacher", "teacher marks field", 'the mark field is missing or is no longer a bound <input type="number">');
    else if (!thumbSized) bad("teacher", "teacher marks field", "the mark field lost its 44px (min-h-11) touch height");
    else if (!fillsRow) bad("teacher", "teacher marks field", "the mark field no longer fills its card row (no w-full/flex-1)");
    else console.log("  ✅ teacher marks field is a real bound <input type=\"number\">, 44px tall and filling its card row, with no table left behind");
  } catch (e) {
    bad("teacher", "teacher phone CSS", `check failed — ${e && e.message ? e.message : e}`);
  }
}

/*
 * Teacher App phone LAYOUT — measured in a real headless browser.
 *
 * The phone-CSS check above proves a rule is SERVED; it cannot prove the rule
 * APPLIES. T8's bug lived exactly in that gap: the mark field's override was
 * present and correct in the stylesheet and still lost the cascade, so the field
 * stayed 112px wide on a 390px phone with no other symptom. This section lays
 * the page out in a real engine and measures it.
 *
 * No dependency and no package.json change: scripts/lib/headless.mjs drives the
 * already-installed Chrome/Edge over the DevTools Protocol, using Bun's built-in
 * fetch + WebSocket. It SKIPS loudly — never silently — when there is no browser
 * to drive, when a deployment origin is set (the layout pass is a localhost
 * concern), or when SMOKE_HEADLESS=0, so a runner without a browser still gets
 * the full HTTP sweep.
 *
 * NOTE: measured heights can differ from a headed browser by a pixel (font
 * metrics), so nothing here asserts an exact row height — only CSS lengths
 * (7rem = 112px), display modes, and the "field fills its row" relation, which
 * are deterministic.
 */
console.log("\n=== app assistant (grounded, no external AI) ===");
{
  const teacher = ROLES.find((r) => r.label === "teacher");
  const guardian = ROLES.find((r) => r.label === "guardian");
  const school = ROLES.find((r) => r.label === "school-admin");

  async function ask(role, cookie, message) {
    const res = await fetch(`${LOCAL_BASE}/api/assistant`, {
      method: "POST",
      headers: { Host: role.host, "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ message }),
      signal: AbortSignal.timeout(45000),
    });
    const json = await res.json().catch(() => null);
    return { status: res.status, data: json && json.data };
  }

  const [t, g, s] = await Promise.all([
    login(teacher.host, teacher.id, teacher.pw),
    login(guardian.host, guardian.id, guardian.pw),
    login(school.host, school.id, school.pw),
  ]);

  if (t.status !== 200 || g.status !== 200 || s.status !== 200) {
    bad("app", "assistant login", `teacher ${t.status} guardian ${g.status} school ${s.status}`);
  } else {
    const [tAtt, tHw, gFees, sAsk] = await Promise.all([
      ask(teacher, t.cookie, "Who is absent today?"),
      ask(teacher, t.cookie, "Create homework: Fractions worksheet, due tomorrow"),
      ask(guardian, g.cookie, "Are there any fees due?"),
      ask(school, s.cookie, "Who is absent today?"),
    ]);

    if (tAtt.status !== 200 || !tAtt.data || typeof tAtt.data.answer !== "string")
      bad("app", "assistant teacher", `status ${tAtt.status}, no grounded answer`);
    else console.log(`  ✅ assistant (teacher) answered from live data: "${String(tAtt.data.answer).slice(0, 90)}"`);

    if (tHw.status !== 200 || !tHw.data || !tHw.data.action || tHw.data.action.endpoint !== "/api/homework")
      bad("app", "assistant propose", `no confirm-to-act proposal (status ${tHw.status})`);
    else console.log("  ✅ assistant proposes homework create — confirm-to-act, nothing written yet");

    if (gFees.status !== 200 || !gFees.data || typeof gFees.data.answer !== "string")
      bad("app", "assistant guardian", `status ${gFees.status}, no grounded answer`);
    else console.log(`  ✅ assistant (guardian) answered from live data: "${String(gFees.data.answer).slice(0, 90)}"`);

    if (sAsk.status !== 403) bad("app", "assistant scope", `a non-app role got ${sAsk.status}, want 403`);
    else console.log("  ✅ assistant refuses non-app roles (admin panel cannot use it)");
  }
}

console.log("\n=== teacher phone layout (headless browser) ===");
{
  const teacher = ROLES.find((r) => r.label === "teacher");

  /**
   * The exam whose marks sheet is still OPEN, or null with the reason.
   *
   * `/teacher/marks` disables every mark input while its exam is published (the
   * page locks a published sheet by design), so a tenant whose exams are all
   * published has nothing editable to measure. The two marks checks below then
   * SKIP with this reason instead of failing on a field that is locked on
   * purpose. The list is the page's own source (`/api/exams`), so the id is
   * always one the picker offers.
   */
  async function openExam(host, cookie) {
    const res = await get(host, "/api/exams", cookie);
    if (res.status !== 200) return { id: null, why: `/api/exams answered HTTP ${res.status}` };
    let exams = [];
    try {
      exams = JSON.parse(res.body)?.data || [];
    } catch {
      return { id: null, why: "/api/exams returned a non-JSON body" };
    }
    if (!exams.length) return { id: null, why: "this school has no exams" };
    const open = exams.find((e) => !e.published);
    return open
      ? { id: open.id, why: "" }
      : { id: null, why: `all ${exams.length} exam(s) are published — a locked sheet is expected` };
  }
  const reason =
    process.env.SMOKE_HEADLESS === "0"
      ? "SMOKE_HEADLESS=0"
      : ORIGIN
        ? "a deployment origin is set — the layout pass runs against localhost"
        : null;
  let HL = null;
  if (!reason) {
    try {
      HL = await import(new URL("./lib/headless.mjs", import.meta.url));
    } catch {
      HL = null;
    }
  }

  if (reason) {
    console.log(`  ⏭️  SKIPPED — ${reason}`);
  } else if (!HL) {
    console.log("  ⚠️  SKIPPED — could not load scripts/lib/headless.mjs (run with bun)");
  } else {
    const session = await login(teacher.host, teacher.id, teacher.pw);
    if (session.status !== 200 || !session.cookie) {
      bad("teacher", "/teacher (headless layout)", `login HTTP ${session.status}`);
    } else {
      // Resolve an exam whose sheet is still open before the browser work starts
      // (read-only), so the marks checks below can skip rather than measure a
      // sheet the app deliberately locks.
      const openEx = await openExam(teacher.host, session.cookie);
      const browser = await HL.launch();
      if (!browser) {
        console.log("  ⏭️  SKIPPED — no Chrome/Edge found (set SMOKE_BROWSER to one)");
      } else {
        try {
          const page = await browser.newPage();
          const [cname, ...cval] = session.cookie.split("=");
          await page.setCookie({ name: cname, value: cval.join("="), url: `http://${teacher.host}/` });
          const origin = `http://${teacher.host}`;

          // The sheet is client state: choose the OPEN exam, by the id the API
          // reported — not "the first option", which is how this check used to
          // land on a published exam and then measure a locked field.
          const pickExam = (id) => `(() => {
            const s = document.querySelectorAll('select')[0];
            const o = s && [...s.options].find((x) => x.value === ${JSON.stringify(id)});
            if (!o) return false;
            Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
            s.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
          })()`;

          // --- 1. /teacher at phone width: app bar, overview tiles, quick actions ---
          //
          // Home was rebuilt this pass: the old horizontally-scrolling stat row
          // and gradient quick chips are gone, replaced by a 2×2 tile grid and a
          // 4-up action grid. What still has to hold is the chrome (fixed, full
          // width, flush) plus a real touch target per tile and per action — and
          // that the last thing in `main` is not sitting behind the bar.
          await page.setViewport({ width: 390, height: 844, mobile: true });
          await page.goto(`${origin}/teacher`);
          await page.waitFor("document.querySelector('.ss-home')", 12000);
          const home = await page.evaluate(`(async () => {
            const bar = document.querySelector('.ss-app-tabbar');
            const tiles = [...document.querySelectorAll('.ss-tiles > *')];
            const quick = [...document.querySelectorAll('.ss-quick > *')];
            const main = document.querySelector('main');
            const br = bar && bar.getBoundingClientRect();
            // Two things are read straight off the rendered page: the Teacher App
            // must NOT show the floating install banner (found here by its own
            // dismiss control), and its app bar must be the dark navy variant —
            // asserted on the PAINTED background, not just the class.
            const banner = !!document.querySelector('[aria-label="Dismiss"]');
            const hdr = document.querySelector('header');
            const bell = document.querySelector('[aria-label="Notifications"]');
            // The painted background comes back raw and is judged on the runner:
            // a regex written in here would have to be escaped twice over.
            const minH = (xs) => (xs.length ? Math.min(...xs.map((e) => Math.round(e.getBoundingClientRect().height))) : null);
            // "Behind the bar" only means anything at the end of the scroll:
            // mid-page the last child is legitimately below the fold.
            window.scrollTo(0, document.documentElement.scrollHeight);
            await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
            const last = main && main.lastElementChild;
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              vw: window.innerWidth, bar: !!bar, pos: bar && getComputedStyle(bar).position,
              h: br && Math.round(br.height), w: br && Math.round(br.width),
              bottom: br && Math.round(window.innerHeight - br.bottom),
              tiles: tiles.length, tileMin: minH(tiles),
              quick: quick.length, quickMin: minH(quick),
              covered: !!(last && br) && last.getBoundingClientRect().bottom > br.top + 1,
              banner,
              headerClass: hdr ? hdr.className : null,
              headerBg: hdr ? getComputedStyle(hdr).backgroundColor : null,
              bellClass: bell ? bell.className : null,
              darkNodes: document.querySelectorAll('[class*="0F172A"]').length,
            };
          })()`);
          const homeBad = [];
          if (home.overflow !== 0) homeBad.push(`page overflows ${home.overflow}px`);
          if (!home.bar) homeBad.push("no bottom bar mounted at 390px");
          else {
            if (home.pos !== "fixed") homeBad.push(`bar is ${home.pos}, not fixed`);
            if (home.w !== home.vw) homeBad.push(`bar is ${home.w}px wide, viewport ${home.vw}`);
            if (home.h < 56) homeBad.push(`bar is only ${home.h}px tall`);
            if (home.bottom !== 0) homeBad.push(`bar sits ${home.bottom}px off the bottom`);
          }
          if (home.tiles !== 4) homeBad.push(`${home.tiles} overview tiles, want 4`);
          if (home.tileMin === null || home.tileMin < 44) homeBad.push(`overview tile ${home.tileMin}px tall, want >= 44`);
          if (home.quick !== 4) homeBad.push(`${home.quick} quick actions, want 4`);
          if (home.quickMin === null || home.quickMin < 44) homeBad.push(`quick action ${home.quickMin}px tall, want >= 44`);
          if (home.covered) homeBad.push("the last element in main sits behind the fixed tab bar");
          // The Teacher App shows no install banner at all, so there is nothing
          // left to cover a list row, a button or the bottom bar.
          if (home.banner) homeBad.push("the floating install banner is on screen (the Teacher App must not show one)");
          // ...and the bar is the dark navy Teacher variant, painted rather than
          // merely classed, so a stray utility cannot satisfy this on its own.
          if (!home.darkNodes) homeBad.push("no element carries the Teacher dark-bar token");
          if (!home.headerClass || !home.headerClass.includes("bg-[#0F172A]"))
            homeBad.push(`the app bar is not the dark variant (class: ${home.headerClass})`);
          const barRgb = String(home.headerBg || "").match(/[0-9]+/g) || [];
          const barLum =
            barRgb.length >= 3 ? 0.2126 * +barRgb[0] + 0.7152 * +barRgb[1] + 0.0722 * +barRgb[2] : null;
          if (barLum === null || barLum >= 60)
            homeBad.push(`the app bar is painted ${home.headerBg}, not dark navy`);
          if (!home.bellClass || !home.bellClass.includes("text-slate-300"))
            homeBad.push(`the bell trigger is not using the dark variant (class: ${home.bellClass})`);
          if (homeBad.length) bad("teacher", "/teacher @390 (headless)", homeBad.join("; "));
          else
            console.log(
              `  ✅ /teacher @390: bar fixed ${home.h}px × ${home.w}px flush to the bottom, ${home.tiles} overview tiles + ${home.quick} quick actions >= ${Math.min(home.tileMin, home.quickMin)}px, nothing behind the bar, dark app bar with the dark bell, no install banner anywhere`,
            );

          // --- /teacher/attendance at phone width: the roster really becomes cards ---
          //
          // Picking a class fires the page's own `useEffect([classId, sectionId])`
          // -> loadRoster(); the "Load roster" button is not needed. Classes are
          // tried in order because a class with no students would otherwise read
          // as a broken check rather than an empty roster.
          await page.goto(`${origin}/teacher/attendance`);
          const pickerReady = await page.waitFor(
            "document.querySelectorAll('select')[0] && document.querySelectorAll('select')[0].options.length > 1",
            12000,
          );
          let attLoaded = false;
          if (pickerReady) {
            for (let i = 1; i <= 4 && !attLoaded; i++) {
              const picked = await page.evaluate(`(() => {
                const s = document.querySelectorAll('select')[0];
                const o = s && s.options[${i}];
                if (!o || !o.value) return false;
                Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
                s.dispatchEvent(new Event('change', { bubbles: true }));
                return true;
              })()`);
              if (!picked) break;
              attLoaded = await page.waitFor("document.querySelector('.ss-att-row')", 4000);
            }
          }
          const attGeom = attLoaded
            ? await page.evaluate(`(() => {
                const rows = [...document.querySelectorAll('.ss-att-row')];
                const r0 = rows[0];
                const btns = r0 ? [...r0.querySelectorAll('button')] : [];
                const sizes = btns.map((b) => {
                  const r = b.getBoundingClientRect();
                  return Math.round(r.width) + 'x' + Math.round(r.height);
                });
                const bigEnough = btns.every((b) => {
                  const r = b.getBoundingClientRect();
                  return r.width >= 44 && r.height >= 44;
                });
                return {
                  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                  rows: rows.length, buttons: btns.length,
                  tables: document.querySelectorAll('table').length,
                  sizes, bigEnough,
                  labels: btns.map((b) => (b.textContent || '').trim()),
                  tabbar: document.querySelectorAll('.ss-app-tabbar').length,
                };
              })()`)
            : null;
          const attBad = [];
          if (!attLoaded) attBad.push("the roster never rendered for any of the first 4 classes");
          else {
            if (attGeom.tables !== 0) attBad.push(`${attGeom.tables} <table> still on the roster page`);
            if (attGeom.buttons !== 4) attBad.push(`${attGeom.buttons} status controls in row 1, want 4`);
            if (!attGeom.bigEnough) attBad.push(`status controls are ${attGeom.sizes.join(", ")}, want >= 44x44`);
            if (attGeom.labels.join(",") !== "Present,Absent,Late,Leave")
              attBad.push(`the controls are ${attGeom.labels.join("/")}, want Present/Absent/Late/Leave`);
          }
          if (attGeom) {
            if (attGeom.overflow !== 0) attBad.push(`page overflows ${attGeom.overflow}px`);
            if (attGeom.tabbar < 1) attBad.push("no bottom bar on the attendance page");
          }
          if (attBad.length) bad("teacher", "/teacher/attendance @390 (headless)", attBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/attendance @390: ${attGeom.rows} roster cards (no table), ${attGeom.buttons} status controls at ${attGeom.sizes[0]} per row, page overflow 0`,
            );

          // --- /teacher/attendance tap: the header and the cards read ONE state ---
          if (!attLoaded) {
            console.log("  ⏭️  SKIPPED /teacher/attendance tap — no roster to tap");
          } else {
            // Nothing here hardcodes or parses a colour. Tailwind v4 paints
            // `bg-emerald-500` as oklch() — a first draft compared against
            // rgb(16,185,129) and false-FAILED, and a second draft string-compared
            // "transparent" and false-PASSED on oklab(0 0 0 / 0), which is alpha 0
            // too. So "is this status filled?" is read from the class the render
            // chose (`bg-<tone>-500` is added only when r.status === s), and the
            // real assertions are on STATE: the header's marked count.
            //
            // Target = the first row with NO status filled, so one tap must raise
            // the count by exactly 1. If every row is already marked, tap a
            // DIFFERENT status on row 1 instead, and the count must hold steady.
            const attTone = `['emerald', 'rose', 'amber', 'sky'].some((t) => b.className.includes('bg-' + t + '-500'))`;
            const attPre = await page.evaluate(`(() => {
              const rows = [...document.querySelectorAll('.ss-att-row')];
              const of = (r) => [...r.querySelectorAll('button')];
              const on = (b) => ${attTone};
              const m = document.body.innerText.match(/(\\d+)\\/(\\d+) students marked/);
              return {
                idx: rows.findIndex((r) => of(r).filter(on).length === 0),
                marked: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null, rows: rows.length,
              };
            })()`);
            const attRow = attPre.idx >= 0 ? attPre.idx : 0;
            await page.evaluate(`(() => {
              const r = document.querySelectorAll('.ss-att-row')[${attRow}];
              const on = (b) => ${attTone};
              const btns = [...r.querySelectorAll('button')];
              (btns.find((b) => !on(b)) || btns[0]).click();
            })()`);
            const settled = await page.waitFor(
              `(() => {
                const r = document.querySelectorAll('.ss-att-row')[${attRow}];
                const on = (b) => ${attTone};
                return [...r.querySelectorAll('button')].filter(on).length === 1;
              })()`,
              2500,
            );
            const attTap = await page.evaluate(`(() => {
              const rows = [...document.querySelectorAll('.ss-att-row')];
              const of = (r) => [...r.querySelectorAll('button')];
              const on = (b) => ${attTone};
              const m = document.body.innerText.match(/(\\d+)\\/(\\d+) students marked/);
              return {
                filledInRow: of(rows[${attRow}]).filter(on).length,
                filledRows: rows.filter((r) => of(r).some(on)).length,
                marked: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null,
              };
            })()`);
            const expectMarked = attPre.marked + (attPre.idx >= 0 ? 1 : 0);
            const tapBad = [];
            if (!settled) tapBad.push("the tap did not register within 2.5s");
            if (attTap.filledInRow !== 1)
              tapBad.push(`row ${attRow + 1} shows ${attTap.filledInRow} filled status buttons, want exactly 1 — the tap did not switch the status`);
            if (attPre.marked === null || attTap.marked === null) tapBad.push("could not read the header's marked count");
            else if (attTap.marked !== expectMarked)
              tapBad.push(
                `the header says ${attTap.marked} marked, expected ${expectMarked} after ${attPre.idx >= 0 ? "marking a fresh row" : "switching a status on an already-marked row"}`,
              );
            if (attTap.marked !== attTap.filledRows)
              tapBad.push(`the header says ${attTap.marked} marked but ${attTap.filledRows} row(s) show a filled button — the header and the cards disagree`);
            if (tapBad.length) bad("teacher", "/teacher/attendance @390 tap (headless)", tapBad.join("; "));
            else
              console.log(
                `  ✅ /teacher/attendance @390 tap: a status tap on row ${attRow + 1} moved the header count ${attPre.marked} -> ${attTap.marked} and left exactly one filled button, matching ${attTap.filledRows} filled row(s)`,
              );
          }

          // --- 2. /teacher/marks at phone width: the sheet is an inset card list ---
          //
          // Both marks checks need an exam whose sheet is still OPEN. When there
          // is none, the exam stays unpicked and the waits below stay short
          // rather than timing out on a sheet this run did not open.
          const marksSkip = openEx.id ? "" : `no unpublished exam to enter marks on — ${openEx.why}`;
          const sheetWait = marksSkip ? 600 : 12000;

          await page.goto(`${origin}/teacher/marks`);
          await page.waitFor("document.querySelectorAll('select').length > 0", 12000);
          if (!marksSkip) await page.evaluate(pickExam(openEx.id));
          const loadedPhone = await page.waitFor("document.querySelector('.ss-marks-row')", sheetWait);
          const marksPhone = await page.evaluate(`(() => {
            const rows = [...document.querySelectorAll('.ss-marks-row')];
            const r0 = rows[0];
            const input = r0 && r0.querySelector('input');
            const ir = input && input.getBoundingClientRect();
            const badge = r0 && r0.querySelector('.badge');
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              rows: rows.length,
              tables: document.querySelectorAll('table').length,
              hasInput: !!input,
              editable: !!input && input.tagName === 'INPUT' && input.type === 'number' && !input.disabled,
              inputH: ir && Math.round(ir.height),
              grade: badge ? (badge.textContent || '').trim() : '',
              gpa: r0 ? /GPA/.test(r0.textContent || '') : false,
              tabbar: document.querySelectorAll('.ss-app-tabbar').length,
              pickers: document.querySelectorAll('select').length,
              pickerVisible: [...document.querySelectorAll('select')].every((s) => s.offsetParent !== null),
            };
          })()`);
          const phBad = [];
          if (!loadedPhone) phBad.push("the exam sheet never rendered after picking an exam");
          else {
            if (marksPhone.tables !== 0) phBad.push(`${marksPhone.tables} <table> still on the marks page`);
            if (!marksPhone.hasInput) phBad.push("no mark input in row 1");
            else if (!marksPhone.editable) phBad.push("the mark input is not a real editable <input type=\"number\">");
            if (marksPhone.inputH < 44) phBad.push(`mark field is ${marksPhone.inputH}px tall, want >= 44`);
            if (!marksPhone.grade) phBad.push("no grade display in row 1");
            if (!marksPhone.gpa) phBad.push("no GPA display in row 1");
          }
          if (marksPhone.overflow !== 0) phBad.push(`page overflows ${marksPhone.overflow}px`);
          if (marksPhone.tabbar < 1) phBad.push("no bottom bar on the marks page");
          if (marksPhone.pickers !== 2 || !marksPhone.pickerVisible) phBad.push("the exam/subject pickers are missing or hidden");
          if (marksSkip) console.log(`  ⏭️  SKIPPED /teacher/marks @390 — ${marksSkip}`);
          else if (phBad.length) bad("teacher", "/teacher/marks @390 (headless)", phBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/marks @390: ${marksPhone.rows} student cards (no table), a real editable numeric input ${marksPhone.inputH}px tall, grade \u201c${marksPhone.grade}\u201d + GPA shown, pickers still inline, page overflow 0`,
            );

          // --- 3. /teacher/marks at desktop: the same card list, no table, no bar ---
          await page.setViewport({ width: 1440, height: 900, mobile: false });
          await page.goto(`${origin}/teacher/marks`);
          await page.waitFor("document.querySelectorAll('select').length > 0", 12000);
          if (!marksSkip) {
            await page.evaluate(pickExam(openEx.id));
            await page.waitFor("document.querySelector('.ss-marks-row')", sheetWait);
          }
          const marksDesk = await page.evaluate(`(() => {
            const rows = [...document.querySelectorAll('.ss-marks-row')];
            const input = rows[0] && rows[0].querySelector('input');
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              rows: rows.length,
              tables: document.querySelectorAll('table').length,
              editable: !!input && input.type === 'number' && !input.disabled,
              tabbar: document.querySelectorAll('.ss-app-tabbar').length,
            };
          })()`);
          const dkBad = [];
          if (marksDesk.tables !== 0) dkBad.push(`${marksDesk.tables} <table> rendered at 1440px — the sheet should be the card list at every width`);
          if (marksDesk.rows < 1) dkBad.push("no student cards at desktop width");
          if (!marksDesk.editable) dkBad.push("the mark input is not editable at desktop width");
          if (marksDesk.tabbar !== 0) dkBad.push(`${marksDesk.tabbar} bottom bar(s) rendered at desktop width`);
          if (marksDesk.overflow !== 0) dkBad.push(`page overflows ${marksDesk.overflow}px`);
          if (marksSkip) console.log(`  ⏭️  SKIPPED /teacher/marks @1440 — ${marksSkip}`);
          else if (dkBad.length) bad("teacher", "/teacher/marks @1440 (headless)", dkBad.join("; "));
          else console.log(`  ✅ /teacher/marks @1440: the same ${marksDesk.rows} student cards, no table, editable inputs, no bottom bar`);

          // --- /teacher/remarks at phone width: the sheet really becomes cards ---
          // The second roster page. Same flow as attendance: picking a class fires
          // the page's own effect, and classes are tried in order so a class with
          // no students cannot read as a broken check. The viewport is set here
          // because the check above left it at 1440px.
          await page.setViewport({ width: 390, height: 844, mobile: true });
          const pickClass = (i) =>
            `(() => {
              const s = document.querySelectorAll('select')[0];
              const o = s && s.options[${i}];
              if (!o || !o.value) return false;
              Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
              s.dispatchEvent(new Event('change', { bubbles: true }));
              return true;
            })()`;
          await page.goto(`${origin}/teacher/remarks`);
          const rmkPicker = await page.waitFor(
            "document.querySelectorAll('select')[0] && document.querySelectorAll('select')[0].options.length > 1",
            12000,
          );
          let rmkLoaded = false;
          if (rmkPicker) {
            for (let i = 1; i <= 4 && !rmkLoaded; i++) {
              const picked = await page.evaluate(pickClass(i));
              if (!picked) break;
              rmkLoaded = await page.waitFor("document.querySelector('.ss-rmk-row')", 4000);
            }
          }
          const rmkGeom = rmkLoaded
            ? await page.evaluate(`(() => {
                const rows = [...document.querySelectorAll('.ss-rmk-row')];
                const r0 = rows[0];
                const btns = r0 ? [...r0.querySelectorAll('button')] : [];
                const sizes = btns.map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); });
                const bigEnough = btns.every((b) => { const r = b.getBoundingClientRect(); return r.width >= 44 && r.height >= 44; });
                const note = r0 ? r0.querySelector('input:not([type="number"])') : null;
                const nr = note && note.getBoundingClientRect();
                return {
                  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                  rows: rows.length, buttons: btns.length,
                  sizes, bigEnough,
                  tables: document.querySelectorAll('table').length,
                  labels: btns.map((b) => b.getAttribute('aria-label') || (b.textContent || '').trim()),
                  hasNote: !!note, noteH: nr && Math.round(nr.height),
                  tabbar: document.querySelectorAll('.ss-app-tabbar').length,
                  selects: document.querySelectorAll('select').length,
                };
              })()`)
            : null;
          const rmkBad = [];
          if (!rmkLoaded) rmkBad.push("the remarks sheet never rendered for any of the first 4 classes");
          else {
            if (rmkGeom.tables !== 0) rmkBad.push(`${rmkGeom.tables} <table> still on the remarks page`);
            if (rmkGeom.buttons !== 4) rmkBad.push(`${rmkGeom.buttons} rating controls in row 1, want 4`);
            if (!rmkGeom.bigEnough) rmkBad.push(`rating controls are ${rmkGeom.sizes.join(", ")}, want >= 44x44`);
            const wantRmk = "Excellent,Good,Average,Needs improvement";
            if (rmkGeom.labels.join(",") !== wantRmk)
              rmkBad.push(`the controls are ${rmkGeom.labels.join("/")}, want ${wantRmk.replace(/,/g, "/")}`);
            if (!rmkGeom.hasNote) rmkBad.push("no note field in row 1");
            else if (rmkGeom.noteH < 44) rmkBad.push(`note field is ${rmkGeom.noteH}px tall, want >= 44`);
          }
          if (rmkGeom) {
            if (rmkGeom.overflow !== 0) rmkBad.push(`page overflows ${rmkGeom.overflow}px`);
            if (rmkGeom.tabbar < 1) rmkBad.push("no bottom bar on the remarks page");
            if (rmkGeom.selects !== 2) rmkBad.push(`${rmkGeom.selects} pickers, want 2 (class + section; the date is an input)`);
          }
          if (rmkBad.length) bad("teacher", "/teacher/remarks @390 (headless)", rmkBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/remarks @390: ${rmkGeom.rows} remarks cards (no table), 4 rating controls at ${rmkGeom.sizes[0]} plus a ${rmkGeom.noteH}px note field, page overflow 0`,
            );

          // --- /teacher/remarks tap: the header and the cards read ONE state ---
          if (!rmkLoaded) {
            console.log("  ⏭️  SKIPPED /teacher/remarks tap — no roster to tap");
          } else {
            // Same class-derived "is it filled?" test as the roster: `bg-<tone>-500`
            // is added only when r.rating === this rating. No colour is parsed.
            const rmkTone = `['emerald', 'rose', 'amber', 'sky'].some((t) => b.className.includes('bg-' + t + '-500'))`;
            const rmkPre = await page.evaluate(`(() => {
              const rows = [...document.querySelectorAll('.ss-rmk-row')];
              const of = (r) => [...r.querySelectorAll('button')];
              const on = (b) => ${rmkTone};
              const m = document.body.innerText.match(/(\\d+)\\/(\\d+) students rated/);
              return {
                idx: rows.findIndex((r) => of(r).filter(on).length === 0),
                marked: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null,
              };
            })()`);
            const rmkRow = rmkPre.idx >= 0 ? rmkPre.idx : 0;
            await page.evaluate(`(() => {
              const r = document.querySelectorAll('.ss-rmk-row')[${rmkRow}];
              const on = (b) => ${rmkTone};
              const btns = [...r.querySelectorAll('button')];
              (btns.find((b) => !on(b)) || btns[0]).click();
            })()`);
            const rmkSettled = await page.waitFor(
              `(() => {
                const r = document.querySelectorAll('.ss-rmk-row')[${rmkRow}];
                const on = (b) => ${rmkTone};
                return [...r.querySelectorAll('button')].filter(on).length === 1;
              })()`,
              2500,
            );
            const rmkTap = await page.evaluate(`(() => {
              const rows = [...document.querySelectorAll('.ss-rmk-row')];
              const of = (r) => [...r.querySelectorAll('button')];
              const on = (b) => ${rmkTone};
              const m = document.body.innerText.match(/(\\d+)\\/(\\d+) students rated/);
              return {
                filledInRow: of(rows[${rmkRow}]).filter(on).length,
                filledRows: rows.filter((r) => of(r).some(on)).length,
                marked: m ? Number(m[1]) : null, total: m ? Number(m[2]) : null,
              };
            })()`);
            const rmkExpect = rmkPre.marked + (rmkPre.idx >= 0 ? 1 : 0);
            const rmkTapBad = [];
            if (!rmkSettled) rmkTapBad.push("the tap did not register within 2.5s");
            if (rmkTap.filledInRow !== 1)
              rmkTapBad.push(`row ${rmkRow + 1} shows ${rmkTap.filledInRow} filled rating buttons, want exactly 1 — the tap did not set a rating`);
            if (rmkPre.marked === null || rmkTap.marked === null) rmkTapBad.push("could not read the header's rated count");
            else if (rmkTap.marked !== rmkExpect)
              rmkTapBad.push(`the header says ${rmkTap.marked} rated, expected ${rmkExpect} after ${rmkPre.idx >= 0 ? "rating a fresh row" : "changing a rating on an already-rated row"}`);
            if (rmkTap.marked !== rmkTap.filledRows)
              rmkTapBad.push(`the header says ${rmkTap.marked} rated but ${rmkTap.filledRows} row(s) show a filled rating — the header and the cards disagree`);
            if (rmkTapBad.length) bad("teacher", "/teacher/remarks @390 tap (headless)", rmkTapBad.join("; "));
            else
              console.log(
                `  ✅ /teacher/remarks @390 tap: a rating tap on row ${rmkRow + 1} moved the header count ${rmkPre.marked} -> ${rmkTap.marked} and left exactly one filled button, matching ${rmkTap.filledRows} filled row(s)`,
              );
          }

          // --- /teacher/remarks at desktop: still a real 7-column table ---
          await page.setViewport({ width: 1440, height: 900, mobile: false });
          await page.goto(`${origin}/teacher/remarks`);
          await page.waitFor(
            "document.querySelectorAll('select')[0] && document.querySelectorAll('select')[0].options.length > 1",
            12000,
          );
          await page.evaluate(pickClass(1));
          await page.waitFor("document.querySelector('.ss-rmk-row')", 12000);
          const rmkDesk = await page.evaluate(`(() => {
            const rows = [...document.querySelectorAll('.ss-rmk-row')];
            const r0 = rows[0];
            const btns = r0 ? [...r0.querySelectorAll('button')] : [];
            const sizes = [...new Set(btns.map((b) => { const r = b.getBoundingClientRect(); return Math.round(r.width) + 'x' + Math.round(r.height); }))];
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              rows: rows.length,
              tables: document.querySelectorAll('table').length,
              sizes,
              tabbar: document.querySelectorAll('.ss-app-tabbar').length,
            };
          })()`);
          const rmkDkBad = [];
          if (rmkDesk.tables !== 0) rmkDkBad.push(`${rmkDesk.tables} <table> rendered at 1440px — the sheet should stay a card list`);
          if (rmkDesk.rows < 1) rmkDkBad.push("no remarks cards at desktop width");
          if (rmkDesk.sizes.some((s) => Number(s.split("x")[1]) < 44)) rmkDkBad.push(`rating controls are ${rmkDesk.sizes.join(", ")}, want >= 44 tall`);
          if (rmkDesk.tabbar !== 0) rmkDkBad.push(`${rmkDesk.tabbar} bottom bar(s) rendered at desktop width`);
          if (rmkDesk.overflow !== 0) rmkDkBad.push(`page overflows ${rmkDesk.overflow}px`);
          if (rmkDkBad.length) bad("teacher", "/teacher/remarks @1440 (headless)", rmkDkBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/remarks @1440: the same ${rmkDesk.rows} card list, no table, rating controls at ${rmkDesk.sizes[0]}, no bottom bar`,
            );

          // --- /teacher/classes: roster buttons + the one table, phone and desktop ---
          //
          // Unlike attendance/marks/remarks, this page's blocks are DATA-driven:
          // on a data-less day it renders its empty state, so there is nothing to
          // measure. Rather than write a class session into the database (this
          // suite is otherwise read-only apart from logins), the two data-driven
          // blocks are rendered from a synthetic payload injected before any page
          // script runs: fetch is stubbed ONLY for this `view=me` read, so the
          // page's own cover pickers still hit the real API. That measures the
          // phone TREATMENT without a side effect. The stub is removed before the
          // sweep so the real (empty) page is what the sweep sees.
          const classesData = {
            date: "2026-10-02",
            weekday: "Friday",
            active: { id: "cs_live", className: "Class 7", sectionName: null, subjectName: "Science", periodLabel: "Period 4", note: null, status: "OPEN", autoEnded: false, startedClock: "11:00", endedClock: null, durationMin: 5 },
            sessions: [],
            roster: [
              { routineId: "rt1", classId: "c1", sectionId: "s1", subjectId: "sub1", className: "Class 5", sectionName: "A", subjectName: "Bangla", period: 1, periodLabel: "Period 1 · 09:00–09:45", startTime: "09:00", endTime: "09:45", state: "upcoming", sessionId: null, startedClock: null, endedClock: null, durationMin: 0, isNow: false },
              { routineId: "rt4", classId: "c4", sectionId: "s4", subjectId: "sub5", className: "Class 8", sectionName: "B", subjectName: "ICT", period: 4, periodLabel: "Period 4 · 11:00–11:45", startTime: "11:00", endTime: "11:45", state: "inClass", sessionId: "cs_r", startedClock: "11:02", endedClock: null, durationMin: 0, isNow: true },
              { routineId: "rt3", classId: "c3", sectionId: "s3", subjectId: "sub3", className: "Class 6", sectionName: null, subjectName: "Science", period: 3, periodLabel: "Period 3 · 10:15–11:00", startTime: "10:15", endTime: "11:00", state: "done", sessionId: "cs_d", startedClock: "10:17", endedClock: "10:58", durationMin: 41, isNow: false },
              { routineId: "rt2", classId: "c2", sectionId: null, subjectId: "sub2", className: "Class 5", sectionName: "B", subjectName: "Math", period: 2, periodLabel: "Period 2 · 09:45–10:30", startTime: "09:45", endTime: "10:30", state: "declined", sessionId: "cs_x", startedClock: null, endedClock: null, durationMin: 0, isNow: false },
            ],
            otherSessions: [
              { id: "cs_1", className: "Class 3", sectionName: "B", subjectName: "Math", periodLabel: "Period 2", note: null, status: "CLOSED", autoEnded: false, startedClock: "10:00", endedClock: "10:40", durationMin: 40 },
              { id: "cs_live", className: "Class 7", sectionName: null, subjectName: "Science", periodLabel: "Period 4", note: null, status: "OPEN", autoEnded: false, startedClock: "11:00", endedClock: null, durationMin: 5 },
            ],
            todayKey: "2026-10-02",
            liveMaxMinutes: 240,
          };
          const clsStub = `(() => {
            const data = ${JSON.stringify(classesData)};
            const orig = window.fetch.bind(window);
            window.fetch = (input, init) => {
              const url = typeof input === "string" ? input : (input && input.url) || "";
              if (url.indexOf("/api/class-sessions?view=me") !== -1) {
                return Promise.resolve(new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } }));
              }
              return orig(input, init);
            };
          })();`;
          await page.setViewport({ width: 390, height: 844, mobile: true });
          const clsStubId = await page.addInitScript(clsStub);
          await page.goto(`${origin}/teacher/classes`);
          const clsLoaded = await page.waitFor("document.querySelector('.ss-classes-row')", 12000);
          const clsPhone = await page.evaluate(`(() => {
            const other = [...document.querySelectorAll('.ss-classes-other > li')];
            const rb = [...document.querySelectorAll('.ss-classes-row .btn')].map((b) => Math.round(b.getBoundingClientRect().height));
            const live = document.querySelector('.ss-classes-live .btn');
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              roster: document.querySelectorAll('.ss-classes-row').length,
              rosterBtns: rb.length, rosterMinH: rb.length ? Math.min(...rb) : null,
              liveBtnH: live ? Math.round(live.getBoundingClientRect().height) : null,
              other: other.length,
              otherInset: other.length ? getComputedStyle(other[0].parentElement).boxShadow.includes('0px 0px 0px 1px') : false,
              tables: document.querySelectorAll('table').length,
              tabbar: document.querySelectorAll('.ss-app-tabbar').length,
            };
          })()`);
          const clsBad = [];
          if (!clsLoaded) clsBad.push("the classes blocks never rendered from the injected payload");
          else {
            if (clsPhone.roster !== 4) clsBad.push(`${clsPhone.roster} roster rows, want 4`);
            if (clsPhone.rosterBtns < 3) clsBad.push(`${clsPhone.rosterBtns} roster action buttons, want >= 3`);
            if (clsPhone.rosterMinH === null || clsPhone.rosterMinH < 44) clsBad.push(`the shortest roster action button is ${clsPhone.rosterMinH}px tall, want >= 44`);
            if (clsPhone.liveBtnH === null || clsPhone.liveBtnH < 44) clsBad.push(`the live-class Finish button is ${clsPhone.liveBtnH}px tall, want >= 44`);
            if (clsPhone.other !== 2) clsBad.push(`${clsPhone.other} other-class rows, want 2`);
            if (!clsPhone.otherInset) clsBad.push("the other-classes list is not an inset kit surface");
            if (clsPhone.tables !== 0) clsBad.push(`${clsPhone.tables} <table> still on the classes page`);
          }
          if (clsPhone.overflow !== 0) clsBad.push(`page overflows ${clsPhone.overflow}px`);
          if (clsPhone.tabbar < 1) clsBad.push("no bottom bar on the classes page");
          if (clsBad.length) bad("teacher", "/teacher/classes @390 (headless)", clsBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/classes @390: ${clsPhone.roster} roster cards with ${clsPhone.rosterBtns} action buttons >= ${clsPhone.rosterMinH}px, live Finish button ${clsPhone.liveBtnH}px, a ${clsPhone.other}-row inset other-classes list, no table, page overflow 0`,
            );

          // the cover panel opens into full-height controls a thumb can hit
          await page.evaluate(`(() => {
            const b = [...document.querySelectorAll('button')].find((x) => /^(Show|Hide)$/.test((x.textContent || '').trim()));
            if (b) b.click();
          })()`);
          const coverReady = await page.waitFor("document.querySelectorAll('.ss-classes-cover select').length >= 4", 6000);
          const coverPhone = await page.evaluate(`(() => {
            const c = document.querySelector('.ss-classes-cover');
            if (!c) return null;
            const inputs = [...c.querySelectorAll('.input')].map((e) => Math.round(e.getBoundingClientRect().height));
            const btns = [...c.querySelectorAll('.btn')].map((e) => Math.round(e.getBoundingClientRect().height));
            return {
              selects: c.querySelectorAll('select').length,
              minInput: inputs.length ? Math.min(...inputs) : null,
              minBtn: btns.length ? Math.min(...btns) : null,
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          })()`);
          const coverBad = [];
          if (!coverReady) coverBad.push("the cover panel never opened");
          else if (!coverPhone) coverBad.push("the cover panel is missing");
          else {
            if (coverPhone.selects < 4) coverBad.push(`${coverPhone.selects} selects in the cover panel, want 4 (class, section, subject, period)`);
            if (coverPhone.minInput === null || coverPhone.minInput < 44) coverBad.push(`the shortest cover control is ${coverPhone.minInput}px tall, want >= 44`);
            if (coverPhone.minBtn === null || coverPhone.minBtn < 44) coverBad.push(`the shortest cover button is ${coverPhone.minBtn}px tall, want >= 44`);
            if (coverPhone.overflow !== 0) coverBad.push(`page overflows ${coverPhone.overflow}px`);
          }
          if (coverBad.length) bad("teacher", "/teacher/classes cover @390 (headless)", coverBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/classes cover @390: 4 pickers + note at ${coverPhone.minInput}px and buttons at ${coverPhone.minBtn}px, page overflow 0`,
            );

          // --- /teacher/classes at desktop: still a real 6-column table ---
          await page.setViewport({ width: 1440, height: 900, mobile: false });
          await page.goto(`${origin}/teacher/classes`);
          await page.waitFor("document.querySelector('.ss-classes-row')", 12000);
          const clsDesk = await page.evaluate(`(() => {
            const firstBtn = document.querySelector('.ss-classes-row .btn');
            const live = document.querySelector('.ss-classes-live .btn');
            return {
              tables: document.querySelectorAll('table').length,
              roster: document.querySelectorAll('.ss-classes-row').length,
              other: document.querySelectorAll('.ss-classes-other > li').length,
              rosterBtnH: firstBtn ? Math.round(firstBtn.getBoundingClientRect().height) : null,
              liveBtnH: live ? Math.round(live.getBoundingClientRect().height) : null,
              tabbar: document.querySelectorAll('.ss-app-tabbar').length,
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          })()`);
          const clsDkBad = [];
          if (clsDesk.tables !== 0) clsDkBad.push(`${clsDesk.tables} <table> at 1440px — the page should be cards at every width`);
          if (clsDesk.roster !== 4) clsDkBad.push(`${clsDesk.roster} roster cards at 1440px, want 4`);
          if (clsDesk.other !== 2) clsDkBad.push(`${clsDesk.other} other-class rows at 1440px, want 2`);
          if (clsDesk.tabbar !== 0) clsDkBad.push(`${clsDesk.tabbar} bottom bar(s) rendered at desktop width`);
          if (clsDesk.overflow !== 0) clsDkBad.push(`page overflows ${clsDesk.overflow}px`);
          if (clsDkBad.length) bad("teacher", "/teacher/classes @1440 (headless)", clsDkBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/classes @1440: ${clsDesk.roster} roster cards + ${clsDesk.other} other-class rows, no table, no bottom bar`,
            );

          // The injected payload is for the checks above only — restore the real
          // (data-less) page before the sweep.
          await page.removeInitScript(clsStubId);

          // --- /teacher/homework and /teacher/quizzes: cards + the new MobileSheet ---
          //
          // Both pages are card grids at every width, so the treatment lives on
          // the CONTROLS: the homework card's delete button is hover-only on
          // desktop (and, with no `group` parent, in fact unreachable), so on a
          // phone it must be visible and thumb-sized; and both create forms now
          // open in `MobileSheet` — a bottom sheet below 768px, the same centred
          // card above. The cards are rendered from an injected payload for both
          // pages, so the check does not depend on the fixture still holding a
          // homework row (or any quiz at all).
          const hwQuizData = {
            homework: [
              { id: "hw1", title: "Fractions worksheet", description: "Chapter 4, questions 1-10", attachmentUrl: null, dueDate: "2026-10-05T00:00:00.000Z", createdAt: "2026-10-01T09:00:00.000Z", subject: { name: "Math" }, classRoom: { name: "Class 5" }, section: { name: "A" }, submittedCount: 12, totalStudents: 38 },
              { id: "hw2", title: "Bangla essay", description: null, attachmentUrl: null, dueDate: null, createdAt: "2026-09-30T09:00:00.000Z", subject: null, classRoom: { name: "Class 6" }, section: null, submittedCount: 0, totalStudents: 30 },
            ],
            quizzes: [
              { id: "qz1", title: "Chapter 3 quick test", description: null, published: true, allowRetake: false, durationMin: 10, createdAt: "2026-09-29T09:00:00.000Z", classRoom: { name: "Class 5" }, subject: { name: "Science" }, questions: [{ id: "q1" }, { id: "q2" }], attempts: [{ id: "a1", score: 8, totalMarks: 10 }] },
              { id: "qz2", title: "Draft vocabulary check", description: null, published: false, allowRetake: true, durationMin: null, createdAt: "2026-09-28T09:00:00.000Z", classRoom: null, subject: null, questions: [{ id: "q1" }], attempts: [] },
            ],
          };
          const hwQuizStub = `(() => {
            const data = ${JSON.stringify(hwQuizData)};
            const orig = window.fetch.bind(window);
            window.fetch = (input, init) => {
              const url = typeof input === "string" ? input : (input && input.url) || "";
              const hit = url.indexOf("/api/homework?mine=1") !== -1 ? data.homework : url.indexOf("/api/quizzes?mine=1") !== -1 ? data.quizzes : null;
              if (hit) return Promise.resolve(new Response(JSON.stringify({ data: hit }), { status: 200, headers: { "content-type": "application/json" } }));
              return orig(input, init);
            };
          })();`;

          // Measures whatever `[role="dialog"]` is open: its shape and its controls.
          const sheetProbe = `(() => {
            const d = document.querySelector('[role="dialog"]');
            if (!d) return null;
            const r = d.getBoundingClientRect();
            const cs = getComputedStyle(d);
            const heights = (sel) => [...d.querySelectorAll(sel)].map((e) => Math.round(e.getBoundingClientRect().height));
            const inputs = heights('.input'), btns = heights('.btn');
            return {
              bottom: Math.round(window.innerHeight - r.bottom),
              left: Math.round(r.left), right: Math.round(window.innerWidth - r.right),
              w: Math.round(r.width), vw: window.innerWidth,
              radiusTop: Math.round(parseFloat(cs.borderTopLeftRadius) || 0),
              fields: inputs.length, minInput: inputs.length ? Math.min(...inputs) : null,
              buttons: btns.length, minBtn: btns.length ? Math.min(...btns) : null,
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            };
          })()`;
          const openSheet = (page_, re) =>
            page_.evaluate(`(() => {
              const b = [...document.querySelectorAll('button')].find((x) => ${re}.test(x.textContent || ''));
              if (b) b.click();
              return !!b;
            })()`);

          const hwQuizStubId = await page.addInitScript(hwQuizStub);

          // --- /teacher/homework @390: visible delete control + a bottom sheet ---
          await page.setViewport({ width: 390, height: 844, mobile: true });
          await page.goto(`${origin}/teacher/homework`);
          const hwLoaded = await page.waitFor("document.querySelector('.ss-hwpage .ss-hwdel')", 12000);
          const hwPhone = await page.evaluate(`(() => {
            const del = document.querySelector('.ss-hwpage .ss-hwdel');
            const cta = [...document.querySelectorAll('.ss-hwpage button')].find((b) => /new homework/i.test(b.textContent || ''));
            const r = del && del.getBoundingClientRect();
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              rows: document.querySelectorAll('.ss-hwpage ul > li').length,
              del: !!del, opacity: del && getComputedStyle(del).opacity,
              delW: r && Math.round(r.width), delH: r && Math.round(r.height),
              ctaH: cta && Math.round(cta.getBoundingClientRect().height),
              tabbar: document.querySelectorAll('.ss-app-tabbar').length,
            };
          })()`);
          const hwBad = [];
          if (!hwLoaded) hwBad.push("the homework cards never rendered from the injected payload");
          else {
            if (hwPhone.rows < 2) hwBad.push(`${hwPhone.rows} homework rows, want 2`);
            if (!hwPhone.del) hwBad.push("no delete control on the homework card");
            else {
              if (hwPhone.opacity !== "1") hwBad.push(`the delete control is opacity ${hwPhone.opacity} on a phone — hover-only controls are unreachable there`);
              if (hwPhone.delW < 44 || hwPhone.delH < 44) hwBad.push(`the delete control is ${hwPhone.delW}x${hwPhone.delH}, want >= 44x44`);
            }
            if (hwPhone.ctaH === null || hwPhone.ctaH < 44) hwBad.push(`the New homework button is ${hwPhone.ctaH}px tall, want >= 44`);
          }
          if (hwPhone.overflow !== 0) hwBad.push(`page overflows ${hwPhone.overflow}px`);
          if (hwPhone.tabbar < 1) hwBad.push("no bottom bar on the homework page");
          if (hwBad.length) bad("teacher", "/teacher/homework @390 (headless)", hwBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/homework @390: ${hwPhone.rows} inset rows, delete control visible (opacity ${hwPhone.opacity}) at ${hwPhone.delW}x${hwPhone.delH}, New homework button ${hwPhone.ctaH}px, page overflow 0`,
            );

          const hwOpened = await openSheet(page, "/new homework/i");
          const hwSheetReady = await page.waitFor("document.querySelector('[role=\"dialog\"]')", 6000);
          const hwSheet = await page.evaluate(sheetProbe);
          const hwSheetBad = [];
          if (!hwOpened) hwSheetBad.push("no New homework button to open the sheet");
          else if (!hwSheetReady || !hwSheet) hwSheetBad.push("the create sheet never opened");
          else {
            if (hwSheet.bottom > 1) hwSheetBad.push(`the sheet sits ${hwSheet.bottom}px off the bottom — a phone sheet should be flush`);
            if (hwSheet.w !== hwSheet.vw) hwSheetBad.push(`the sheet is ${hwSheet.w}px wide, viewport ${hwSheet.vw} — a phone sheet is full width`);
            if (hwSheet.radiusTop < 12) hwSheetBad.push(`the sheet's top corners are ${hwSheet.radiusTop}px, want the rounded sheet shape`);
            if (hwSheet.minBtn === null || hwSheet.minBtn < 44) hwSheetBad.push(`the sheet's shortest button is ${hwSheet.minBtn}px, want >= 44`);
            if (hwSheet.minInput === null || hwSheet.minInput < 44) hwSheetBad.push(`the sheet's shortest field is ${hwSheet.minInput}px, want >= 44`);
          }
          if (hwSheet && hwSheet.overflow !== 0) hwSheetBad.push(`page overflows ${hwSheet.overflow}px with the sheet open`);
          if (hwSheetBad.length) bad("teacher", "/teacher/homework sheet @390 (headless)", hwSheetBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/homework sheet @390: a bottom sheet flush to the edge, full width with ${hwSheet.radiusTop}px top corners, ${hwSheet.fields} fields at ${hwSheet.minInput}px and ${hwSheet.buttons} buttons at ${hwSheet.minBtn}px`,
            );

          // --- /teacher/homework @1440: the SAME sheet is the centred dialog ---
          await page.setViewport({ width: 1440, height: 900, mobile: false });
          await page.goto(`${origin}/teacher/homework`);
          await page.waitFor("document.querySelector('.ss-hwpage .ss-hwdel')", 12000);
          await openSheet(page, "/new homework/i");
          await page.waitFor("document.querySelector('[role=\"dialog\"]')", 6000);
          const hwDesk = await page.evaluate(sheetProbe);
          const hwDeskBad = [];
          if (!hwDesk) hwDeskBad.push("the sheet never opened at 1440px");
          else {
            if (hwDesk.left < 16 || hwDesk.right < 16) hwDeskBad.push(`the dialog is ${hwDesk.left}/${hwDesk.right}px from the sides, want it inset (centred)`);
            if (hwDesk.bottom < 16) hwDeskBad.push(`the dialog sits ${hwDesk.bottom}px off the bottom — it should be centred, not flush`);
            if (hwDesk.radiusTop !== 16) hwDeskBad.push(`the dialog's corners are ${hwDesk.radiusTop}px, want 16 (the centred card shape)`);
          }
          const hwDeskTabbar = await page.evaluate("document.querySelectorAll('.ss-app-tabbar').length");
          if (hwDeskTabbar !== 0) hwDeskBad.push(`${hwDeskTabbar} bottom bar(s) at desktop width`);
          if (hwDeskBad.length) bad("teacher", "/teacher/homework sheet @1440 (headless)", hwDeskBad.join("; "));
          else console.log(`  ✅ /teacher/homework sheet @1440: the same dialog centred (${hwDesk.left}px inset) with ${hwDesk.radiusTop}px corners, no bottom bar`);

          // --- /teacher/quizzes @390: card actions + the bottom sheet ---
          await page.setViewport({ width: 390, height: 844, mobile: true });
          await page.goto(`${origin}/teacher/quizzes`);
          const qzLoaded = await page.waitFor("document.querySelector('.ss-quizpage ul > li button')", 12000);
          const qzPhone = await page.evaluate(`(() => {
            const btns = [...document.querySelectorAll('.ss-quizpage ul > li button')].map((b) => Math.round(b.getBoundingClientRect().height));
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              rows: document.querySelectorAll('.ss-quizpage ul > li').length,
              btns: btns.length, minBtn: btns.length ? Math.min(...btns) : null,
              tabbar: document.querySelectorAll('.ss-app-tabbar').length,
            };
          })()`);
          const qzBad = [];
          if (!qzLoaded) qzBad.push("the quiz cards never rendered from the injected payload");
          else {
            if (qzPhone.rows < 2) qzBad.push(`${qzPhone.rows} quiz rows, want 2`);
            if (qzPhone.btns < 3) qzBad.push(`${qzPhone.btns} card action buttons, want >= 3`);
            if (qzPhone.minBtn === null || qzPhone.minBtn < 44) qzBad.push(`the shortest card action is ${qzPhone.minBtn}px, want >= 44`);
          }
          if (qzPhone.overflow !== 0) qzBad.push(`page overflows ${qzPhone.overflow}px`);
          if (qzPhone.tabbar < 1) qzBad.push("no bottom bar on the quizzes page");
          if (qzBad.length) bad("teacher", "/teacher/quizzes @390 (headless)", qzBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/quizzes @390: ${qzPhone.rows} inset rows with ${qzPhone.btns} actions >= ${qzPhone.minBtn}px, page overflow 0`,
            );

          await openSheet(page, "/new quiz/i");
          const qzSheetReady = await page.waitFor("document.querySelector('[role=\"dialog\"]')", 6000);
          const qzSheet = await page.evaluate(sheetProbe);
          const qzSheetBad = [];
          if (!qzSheetReady || !qzSheet) qzSheetBad.push("the quiz create sheet never opened");
          else {
            if (qzSheet.bottom > 1) qzSheetBad.push(`the sheet sits ${qzSheet.bottom}px off the bottom, want flush`);
            if (qzSheet.w !== qzSheet.vw) qzSheetBad.push(`the sheet is ${qzSheet.w}px wide, viewport ${qzSheet.vw}`);
            if (qzSheet.minInput === null || qzSheet.minInput < 44) qzSheetBad.push(`the sheet's shortest field is ${qzSheet.minInput}px, want >= 44`);
            if (qzSheet.overflow !== 0) qzSheetBad.push(`page overflows ${qzSheet.overflow}px with the sheet open`);
          }
          if (qzSheetBad.length) bad("teacher", "/teacher/quizzes sheet @390 (headless)", qzSheetBad.join("; "));
          else console.log(`  ✅ /teacher/quizzes sheet @390: bottom sheet flush and full width, ${qzSheet.fields} fields at ${qzSheet.minInput}px, page overflow 0`);

          // --- /teacher/quizzes @1440: centred dialog, no bar ---
          await page.setViewport({ width: 1440, height: 900, mobile: false });
          await page.goto(`${origin}/teacher/quizzes`);
          await page.waitFor("document.querySelector('.ss-quizpage ul > li button')", 12000);
          await openSheet(page, "/new quiz/i");
          await page.waitFor("document.querySelector('[role=\"dialog\"]')", 6000);
          const qzDesk = await page.evaluate(sheetProbe);
          const qzDeskTabbar = await page.evaluate("document.querySelectorAll('.ss-app-tabbar').length");
          const qzDeskBad = [];
          if (!qzDesk) qzDeskBad.push("the sheet never opened at 1440px");
          else {
            if (qzDesk.left < 16) qzDeskBad.push(`the dialog is ${qzDesk.left}px from the side, want it inset (centred)`);
            if (qzDesk.bottom < 16) qzDeskBad.push(`the dialog sits ${qzDesk.bottom}px off the bottom, want it centred`);
            if (qzDesk.radiusTop !== 16) qzDeskBad.push(`the dialog's corners are ${qzDesk.radiusTop}px, want 16`);
          }
          if (qzDeskTabbar !== 0) qzDeskBad.push(`${qzDeskTabbar} bottom bar(s) at desktop width`);
          if (qzDeskBad.length) bad("teacher", "/teacher/quizzes sheet @1440 (headless)", qzDeskBad.join("; "));
          else console.log(`  ✅ /teacher/quizzes sheet @1440: centred dialog (${qzDesk.left}px inset), no bottom bar`);

          await page.removeInitScript(hwQuizStubId);

          // --- Wave 1: the migrated list screens use the approved app-ui kit ---
          //
          // Eight routes now share one presentation: inset white surfaces holding
          // hairline-separated rows, and no `PageHeader` — the dark app bar is the
          // page's title. Both halves are asserted, because "no PageHeader" alone
          // would also pass on a page that had simply lost its heading, and
          // "has an inset surface" alone would not catch a title coming back.
          //
          // `/teacher/ai` is the one exception on the surface count: it is a chat
          // panel, not a list, so it has no `ListCard` by design.
          await page.setViewport({ width: 390, height: 844, mobile: true });
          // minInset is per route: seven of the eight draw the kit's inset panel;
          // `/teacher/ai` is a chat panel with no panel surface of its own, so it
          // is proven by the heading assertion instead (below).
          const kitRoutes = [
            { route: "/teacher/leaves", root: "ss-leavespage", minInset: 1 },
            { route: "/teacher/meetings", root: "ss-meetingspage", minInset: 1 },
            { route: "/teacher/homework", root: "ss-hwpage", minInset: 1 },
            { route: "/teacher/resources", root: "ss-resourcespage", minInset: 1 },
            { route: "/teacher/quizzes", root: "ss-quizpage", minInset: 1 },
            { route: "/teacher/notifications", root: "ss-notifpage", minInset: 1 },
            { route: "/teacher/messages", root: "ss-messagespage", minInset: 1 },
            { route: "/teacher/ai", root: null, minInset: 0, noHeading: "AI Assistant" },
          ];
          const kitBad = [];
          const kitSeen = [];
          for (const { route, root, minInset, noHeading } of kitRoutes) {
            await page.goto(`${origin}${route}`);
            const scope = root ? `.${root}` : "main";
            const mounted = await page.waitFor(`document.querySelector('${scope}')`, 12000);
            if (!mounted) {
              kitBad.push(`${route}: ${scope} never mounted`);
              continue;
            }
            // The panels fetch after mount (messages and notifications slowest), so
            // wait for content rather than guessing a delay.
            await page
              .waitFor(`document.querySelector('${scope}').textContent.trim().length > 40`, 15000)
              .catch(() => false);
            await HL.sleep(400);
            const k = await page.evaluate(`(() => {
              const scope = document.querySelector('${scope}');
              // The kit's inset panel is ring-1 ring-slate-900/5 with no border.
              // The computed shadow spells the ring in absolute units, hence '0px'.
              const ringed = [...scope.querySelectorAll('div, ul')].filter((d) => {
                const c = getComputedStyle(d);
                return c.boxShadow.includes('0px 0px 0px 1px') && c.borderTopWidth === '0px';
              });
              return {
                pageHeader: scope.querySelectorAll('.ss-page-title').length,
                inset: ringed.length,
                text: scope.textContent || '',
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                banner: !!document.querySelector('[aria-label="Dismiss"]'),
              };
            })()`);
            if (k.pageHeader !== 0) kitBad.push(`${route}: a PageHeader title is present — the app bar owns the title`);
            if (k.inset < minInset) kitBad.push(`${route}: ${k.inset} inset app-ui surface(s), want >= ${minInset} — the kit is not in use`);
            // The teacher variant of the assistant drops the panel's own heading,
            // because the app bar already names the screen.
            if (noHeading && k.text.includes(noHeading))
              kitBad.push(`${route}: the panel's own "${noHeading}" heading is back — the teacher variant is off`);
            if (k.overflow !== 0) kitBad.push(`${route}: page overflows ${k.overflow}px`);
            if (k.banner) kitBad.push(`${route}: the install banner is on screen`);
            kitSeen.push(`${route.replace("/teacher/", "")}(${k.inset})`);
          }
          if (kitBad.length) bad("teacher", "Wave 1 kit @390 (headless)", kitBad.slice(0, 4).join("; "));
          else
            console.log(
              `  ✅ Wave 1 kit @390: all 8 migrated routes use the approved app-ui surfaces, none shows a PageHeader (the app bar owns the title), 0px overflow, no install banner — inset surfaces per route ${kitSeen.join(" ")}`,
            );

          // --- Wave 2: the last five sheets use the SAME kit, at every width ---
          //
          // The five wide sheets are now inset surfaces at every width: no <table>
          // survives, no PageHeader comes back, and each draws at least one kit
          // surface. Asserted on the rendered page, because the appearance is a
          // runtime branch of the shared/form components.
          const kit2Routes = [
            { route: "/teacher/attendance", root: "ss-attpage" },
            { route: "/teacher/remarks", root: "ss-rmkpage" },
            { route: "/teacher/marks", root: "ss-markspage" },
            { route: "/teacher/classes", root: "ss-classespage" },
            { route: "/teacher/grades", root: "ss-gradespage" },
          ];
          const kit2Bad = [];
          const kit2Seen = [];
          for (const { route, root } of kit2Routes) {
            await page.setViewport({ width: 390, height: 844, mobile: true });
            await page.goto(`${origin}${route}`);
            // The root itself is not enough: marks/classes return a bare
            // LoadingScreen before their data lands, and grades renders its
            // surfaces only after the scheme arrives. Wait for a real kit surface.
            const ready = await page
              .waitFor(
                `(() => {
                  const s = document.querySelector('.${root}');
                  if (!s) return false;
                  return [...s.querySelectorAll('div, ul')].some((d) => {
                    const c = getComputedStyle(d);
                    return c.boxShadow.includes('0px 0px 0px 1px') && c.borderTopWidth === '0px';
                  });
                })()`,
                15000,
              )
              .catch(() => false);
            if (!ready) {
              kit2Bad.push(`${route}: .${root} never drew a kit surface`);
              continue;
            }
            const k = await page.evaluate(`(() => {
              const scope = document.querySelector('.${root}');
              const ringed = [...scope.querySelectorAll('div, ul')].filter((d) => {
                const c = getComputedStyle(d);
                return c.boxShadow.includes('0px 0px 0px 1px') && c.borderTopWidth === '0px';
              });
              return {
                pageHeader: scope.querySelectorAll('.ss-page-title').length,
                inset: ringed.length,
                tables: scope.querySelectorAll('table').length,
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                banner: !!document.querySelector('[aria-label="Dismiss"]'),
              };
            })()`);
            if (k.pageHeader !== 0) kit2Bad.push(`${route}: a PageHeader title is present — the app bar owns the title`);
            if (k.inset < 1) kit2Bad.push(`${route}: no inset app-ui surface — the kit is not in use`);
            if (k.tables !== 0) kit2Bad.push(`${route}: ${k.tables} <table> left on the page`);
            if (k.overflow !== 0) kit2Bad.push(`${route}: page overflows ${k.overflow}px`);
            if (k.banner) kit2Bad.push(`${route}: the install banner is on screen`);
            kit2Seen.push(`${route.replace("/teacher/", "")}(${k.inset})`);
          }
          if (kit2Bad.length) bad("teacher", "Wave 2 kit @390 (headless)", kit2Bad.slice(0, 4).join("; "));
          else
            console.log(
              `  ✅ Wave 2 kit @390: all 5 migrated sheets use the approved app-ui surfaces, none shows a PageHeader, no <table> survives, 0px overflow, no install banner — inset surfaces per route ${kit2Seen.join(" ")}`,
            );

          // --- the five read-only lists: a failed read shows ErrorState + Retry ---
          //
          // The read is blocked at the network layer with a 500, so the page's own
          // existing read function fails exactly as it would in the field. The
          // check is that it lands on the shared ErrorState with a working Retry,
          // and that Retry genuinely re-issues the read: once the block is lifted,
          // the same button press has to reach the populated state.
          // Scoped to `main`, never to the page root: the loading and error states
          // replace the page's own wrapper element (the root class only exists on
          // the populated state), so a root-scoped query would find nothing and
          // report a missing error state that is in fact on screen.
          const errRoutes = [
            ["/teacher/leaves", "ss-leavespage"],
            ["/teacher/meetings", "ss-meetingspage"],
            ["/teacher/homework", "ss-hwpage"],
            ["/teacher/resources", "ss-resourcespage"],
            ["/teacher/quizzes", "ss-quizpage"],
          ];
          const errBad = [];
          for (const [route, root] of errRoutes) {
            let blockId = null;
            try {
              // The block is a FLAG the wrapper consults, not something removed by
              // re-injecting: `removeInitScript` only stops future documents from
              // getting it, so a block that was installed on the current page stays
              // in force — which would make Retry fail for the wrong reason.
              blockId = await page.addInitScript(`(() => {
                window.__smokeBlockReads = true;
                const orig = window.fetch.bind(window);
                window.fetch = (input, init) => {
                  const url = typeof input === 'string' ? input : (input && input.url) || '';
                  const isRead = !init || !init.method || String(init.method).toUpperCase() === 'GET';
                  if (window.__smokeBlockReads && isRead && url.indexOf('/api/') !== -1) {
                    return Promise.resolve(new Response(JSON.stringify({ error: 'smoke: read blocked' }), { status: 500, headers: { 'content-type': 'application/json' } }));
                  }
                  return orig(input, init);
                };
              })();`);
              await page.goto(`${origin}${route}`);
              const shown = await page.waitFor(
                `document.querySelector('main button')`,
                12000,
              );
              const e1 = await page.evaluate(`(() => {
                const scope = document.querySelector('main');
                const btn = [...scope.querySelectorAll('button')].find((b) => /try again/i.test(b.textContent || ''));
                return {
                  errorShown: /couldn.t load this/i.test(scope.textContent || ''),
                  retry: !!btn,
                  retryH: btn ? Math.round(btn.getBoundingClientRect().height) : null,
                  rows: scope.querySelectorAll('ul > li').length,
                };
              })()`);
              if (!shown || !e1.errorShown) errBad.push(`${route}: a failed read did not reach ErrorState`);
              else if (!e1.retry) errBad.push(`${route}: ErrorState has no Retry control`);
              else if (e1.retryH === null || e1.retryH < 44) errBad.push(`${route}: Retry is ${e1.retryH}px tall, want >= 44`);
              else {
                // Lift the block, then press the page's own Retry.
                await page.evaluate(`(() => {
                  window.__smokeBlockReads = false;
                  const scope = document.querySelector('main');
                  const btn = [...scope.querySelectorAll('button')].find((b) => /try again/i.test(b.textContent || ''));
                  if (btn) btn.click();
                })()`);
                // Reaching the loaded state means the page's own root wrapper came
                // back — a stronger signal than the error text merely going away.
                const recovered = await page.waitFor(
                  `!!document.querySelector('.${root}') && !/couldn.t load this/i.test(document.querySelector('main').textContent || '')`,
                  15000,
                );
                if (!recovered) errBad.push(`${route}: Retry did not return the page to its loaded state`);
              }
            } catch (err) {
              errBad.push(`${route}: ${err && err.message ? err.message : err}`);
            } finally {
              if (blockId) await page.removeInitScript(blockId);
            }
          }
          if (errBad.length) bad("teacher", "Wave 1 read failure @390 (headless)", errBad.slice(0, 4).join("; "));
          else
            console.log(
              "  ✅ Wave 1 read failure @390: all 5 read-only lists show ErrorState with a 44px Retry on a failed read, and Retry recovers to the loaded state",
            );

          // --- the T12 routes: leaves / meetings / results / resources / notifications ---
          //
          // These five are list-and-form pages that already stack on a phone, so
          // their treatment is the touch targets. Rather than assert each page's
          // private geometry, the check asserts the property that must hold on
          // all five: inside the page's own root, no `.btn`/`.input`/`select` is
          // under 44px tall. Scoping to the root matters — the install banner's
          // dismiss button and the tab bar live outside it and are not this
          // task's business.
          const t12Routes = [
            ["/teacher/leaves", "ss-leavespage"],
            ["/teacher/meetings", "ss-meetingspage"],
            ["/teacher/results", "ss-resultspage"],
            ["/teacher/resources", "ss-resourcespage"],
            ["/teacher/notifications", "ss-notifpage"],
          ];

          await page.setViewport({ width: 390, height: 844, mobile: true });
          const t12Bad = [];
          const t12Seen = [];
          for (const [route, root] of t12Routes) {
            await page.goto(`${origin}${route}`);
            const mounted = await page.waitFor(`document.querySelector('.${root}')`, 12000);
            if (!mounted) {
              t12Bad.push(`${route}: .${root} never mounted`);
              continue;
            }
            await HL.sleep(900);
            const m = await page.evaluate(`(() => {
              const root = document.querySelector('.${root}');
              // every pressable thing in the page, not just the styled ones: the
              // notification centre's chips and icon actions carry no btn class
              const controls = [...root.querySelectorAll('.btn, a, button, .input, select, input[type="file"]')];
              const small = controls
                .map((e) => { const r = e.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height), t: (e.textContent || e.getAttribute('type') || e.tagName).trim().slice(0, 18) }; })
                .filter((x) => x.w > 0 && x.h < 44);
              return {
                overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
                controls: controls.length, small,
                cards: root.querySelectorAll('.card').length,
                tabbar: document.querySelectorAll('.ss-app-tabbar').length,
              };
            })()`);
            if (m.overflow !== 0) t12Bad.push(`${route}: page overflows ${m.overflow}px`);
            if (m.tabbar < 1) t12Bad.push(`${route}: no bottom bar`);
            if (m.small.length)
              t12Bad.push(`${route}: ${m.small.length} control(s) under 44px, e.g. "${m.small[0].t}" ${m.small[0].w}x${m.small[0].h}`);
            t12Seen.push(`${route.replace("/teacher/", "")} (${m.controls})`);
          }
          if (t12Bad.length) bad("teacher", "T12 pages @390 (headless)", t12Bad.slice(0, 3).join("; "));
          else
            console.log(
              `  ✅ T12 pages @390: ${t12Seen.length} routes, every pressable control inside each page root >= 44px, page overflow 0, bar present — ${t12Seen.join(", ")}`,
            );

          // --- the same five at desktop: the phone rule did NOT leak ---
          await page.setViewport({ width: 1440, height: 900, mobile: false });
          const t12DeskBad = [];
          for (const [route, root] of t12Routes) {
            await page.goto(`${origin}${route}`);
            const mounted = await page.waitFor(`document.querySelector('.${root}')`, 12000);
            if (!mounted) {
              t12DeskBad.push(`${route}: .${root} never mounted`);
              continue;
            }
            await HL.sleep(700);
            const d = await page.evaluate(`(() => {
              const root = document.querySelector('.${root}');
              const controls = [...root.querySelectorAll('.btn, a, button, .input, select')].filter((e) => e.getBoundingClientRect().width > 0);
              const heights = controls.map((e) => Math.round(e.getBoundingClientRect().height));
              return { n: controls.length, min: heights.length ? Math.min(...heights) : null, tabbar: document.querySelectorAll('.ss-app-tabbar').length };
            })()`);
            if (d.tabbar !== 0) t12DeskBad.push(`${route}: ${d.tabbar} bottom bar(s) at desktop width`);
            if (d.min === null || d.min >= 44)
              t12DeskBad.push(`${route}: every control is still >= 44px at 1440px — the phone rule leaked to desktop`);
          }
          if (t12DeskBad.length) bad("teacher", "T12 pages @1440 (headless)", t12DeskBad.slice(0, 3).join("; "));
          else
            console.log("  ✅ T12 pages @1440: all 5 routes keep their desktop control sizes (no phone rule leaked) and no bottom bar");

          // --- /teacher/grades @390: the grade bands are inset cards (teacher variant) ---
          const pickBand = `(() => {
            const root = document.querySelector('.ss-gradespage');
            const rows = [...root.querySelectorAll('.ss-grade-row')];
            const r0 = rows[0];
            const inputs = r0 ? [...r0.querySelectorAll('input')] : [];
            const gradeInput = inputs[0];
            const ir = gradeInput && gradeInput.getBoundingClientRect();
            const labels = r0 ? [...r0.querySelectorAll('label > span')].map((s) => (s.textContent || '').trim()) : [];
            const small = [...root.querySelectorAll('.btn, .input')]
              .map((e) => Math.round(e.getBoundingClientRect().height))
              .filter((h) => h > 0 && h < 44);
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              rows: rows.length,
              tables: root.querySelectorAll('table').length,
              // A band card must not overflow ITSELF: an important width class would
              // grow the card's own box instead of filling it. Measured here.
              rowOvf: Math.max(0, ...rows.map((r) => r.scrollWidth - r.clientWidth)),
              labels,
              inputs: inputs.length,
              inW: ir && Math.round(ir.width), inH: ir && Math.round(ir.height),
              small: small.length,
              tabbar: document.querySelectorAll('.ss-app-tabbar').length,
            };
          })()`;
          await page.setViewport({ width: 390, height: 844, mobile: true });
          await page.goto(`${origin}/teacher/grades`);
          const gradeUp = await page.waitFor("document.querySelector('.ss-grade-row')", 12000);
          const gradePhone = gradeUp ? await page.evaluate(pickBand) : null;
          const gradeBad = [];
          if (!gradePhone) gradeBad.push("the grade bands never rendered");
          else {
            if (gradePhone.tables !== 0) gradeBad.push(`${gradePhone.tables} <table> still on the grades page`);
            if (gradePhone.rows < 2) gradeBad.push(`${gradePhone.rows} band cards, want >= 2`);
            if (gradePhone.inputs !== 4) gradeBad.push(`${gradePhone.inputs} fields in row 1, want 4 (grade, from, GPA, remark)`);
            if (gradePhone.labels.slice(0, 3).join(",") !== "Grade,From (%),GPA")
              gradeBad.push(`the field labels are ${gradePhone.labels.slice(0, 3).join("/")}, want Grade/From (%)/GPA`);
            if (gradePhone.rowOvf > 0)
              gradeBad.push(`a band card overflows its own box by ${gradePhone.rowOvf}px — its fields do not fit the card`);
            if (gradePhone.inH !== 44) gradeBad.push(`the grade field is ${gradePhone.inH}px tall, want 44`);
            if (gradePhone.small) gradeBad.push(`${gradePhone.small} control(s) still under 44px on the page`);
            if (gradePhone.overflow !== 0) gradeBad.push(`page overflows ${gradePhone.overflow}px`);
            if (gradePhone.tabbar < 1) gradeBad.push("no bottom bar on the grades page");
          }
          if (gradeBad.length) bad("teacher", "/teacher/grades @390 (headless)", gradeBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/grades @390: ${gradePhone.rows} band cards (no table), 4 fields each with the grade field ${gradePhone.inW}px wide at ${gradePhone.inH}px, no control under 44px, page overflow 0`,
            );

          // --- /teacher/grades @1440: the same teacher card list, no table, no bar ---
          await page.setViewport({ width: 1440, height: 900, mobile: false });
          await page.goto(`${origin}/teacher/grades`);
          await page.waitFor("document.querySelector('.ss-grade-row')", 12000);
          const gradeDesk = await page.evaluate(`(() => {
            const root = document.querySelector('.ss-gradespage');
            const rows = [...root.querySelectorAll('.ss-grade-row')];
            const r0 = rows[0];
            const input = r0 && r0.querySelector('input');
            const ir = input && input.getBoundingClientRect();
            return {
              overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
              rows: rows.length,
              tables: root.querySelectorAll('table').length,
              inW: ir && Math.round(ir.width),
              tabbar: document.querySelectorAll('.ss-app-tabbar').length,
            };
          })()`);
          const gradeDkBad = [];
          if (gradeDesk.tables !== 0) gradeDkBad.push(`${gradeDesk.tables} <table> at 1440px — the teacher variant should stay a card list`);
          if (gradeDesk.rows < 2) gradeDkBad.push(`${gradeDesk.rows} band cards at 1440px, want >= 2`);
          if (gradeDesk.tabbar !== 0) gradeDkBad.push(`${gradeDesk.tabbar} bottom bar(s) at desktop width`);
          if (gradeDesk.overflow !== 0) gradeDkBad.push(`page overflows ${gradeDesk.overflow}px`);
          if (gradeDkBad.length) bad("teacher", "/teacher/grades @1440 (headless)", gradeDkBad.join("; "));
          else
            console.log(
              `  ✅ /teacher/grades @1440: the same ${gradeDesk.rows} teacher band cards, no table, no bottom bar`,
            );

          // --- the WHOLE teacher app at phone width: chrome + no sideways scroll ---
          //
          // The checks above measure the three pages that already have a phone
          // layout. This sweep covers EVERY teacher route — reusing PAGES.teacher,
          // so a route added later is swept the day it is added — and asserts the
          // properties that must hold on any of them:
          //
          //   • the bottom bar is really there, really `fixed`, the full width of
          //     the viewport, tall enough to be a target, and flush to the bottom;
          //   • the footer reserves space for it (>= 80px), so no content hides
          //     behind the bar;
          //   • nothing makes the DOCUMENT scroll sideways (0px overflow, sampled
          //     across a settle window, not just once at the end).
          //
          // Document-level overflow is the right metric rather than scanning every
          // element: the phone layouts deliberately have inner horizontal scrollers
          // (the home stat row, the quick chips), whose children legitimately extend
          // past the viewport — and because those scrollers own their overflow, they
          // never push the document wide. An element-level scan would flag them.
          //
          // It deliberately does NOT assert per-page card layouts: T9-T13 have not
          // implemented those yet, so on classes / grades / homework / ... there is
          // nothing beyond the chrome to measure. Add each page's own measurements
          // here as it lands.
          await page.setViewport({ width: 390, height: 844, mobile: true });
          const sweepBad = [];
          const sweepOver = [];
          const sweepSqueezed = [];
          const sweepHeights = new Set();
          let swept = 0;
          for (const route of PAGES.teacher) {
            await page.goto(`${origin}${route}`);
            const barUp = await page.waitFor("document.querySelector('.ss-app-tabbar')", 12000);
            if (!barUp) {
              sweepBad.push(`${route}: the bottom bar never mounted`);
              continue;
            }
            await HL.sleep(700);
            let maxOvf = 0;
            for (let i = 0; i < 4; i++) {
              const o = await page.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth");
              if (o > maxOvf) maxOvf = o;
              await HL.sleep(150);
            }
            const s = await page.evaluate(`(async () => {
              const bar = document.querySelector('.ss-app-tabbar');
              const r = bar.getBoundingClientRect();
              const main = document.querySelector('main');
              // The install banner is mounted from the root layout rather than the
              // shell, so on EVERY teacher page it is reached through its own
              // dismiss control — and on every teacher page there must be none.
              const bannerUp = !!document.querySelector('[aria-label="Dismiss"]');
              // Measured at the end of the scroll: mid-page the last child is
              // legitimately below the fold.
              window.scrollTo(0, document.documentElement.scrollHeight);
              await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
              const last = main && main.lastElementChild;
              return {
                pos: getComputedStyle(bar).position, w: Math.round(r.width), h: Math.round(r.height),
                bottom: Math.round(window.innerHeight - r.bottom), vw: window.innerWidth,
                covered: !!(last && last.getBoundingClientRect().bottom > r.top + 1),
                banner: bannerUp,
                backHref: (document.querySelector('[aria-label="Back"]') || { getAttribute: () => null }).getAttribute('href'),
              };
            })()`);
            swept++;
            // A card can satisfy every chrome metric above and still be visually
            // destroyed. In a flex row, `min-w-0 flex-1` with no basis counts as 0
            // in the wrap calculation, so the text column collapses to a sliver
            // while the buttons keep their width — the title wraps one word per
            // line. That shipped on /teacher/results (a 14px column) and the bar,
            // footer, control-size and overflow assertions all still passed. So
            // measure the text itself: a short-but-tall box means it was squeezed.
            const squeezed = await page.evaluate(`(() => {
              const hits = [];
              const root = document.querySelector('main') || document.body;
              for (const el of root.querySelectorAll('*')) {
                if (el.childElementCount || el.closest('svg')) continue;
                const text = (el.textContent || '').trim();
                if (text.length < 12) continue;
                const r = el.getBoundingClientRect();
                if (r.width <= 0 || r.width >= 115) continue;
                const lh = parseFloat(getComputedStyle(el).lineHeight) || 16;
                if (Math.round(r.height / lh) >= 3)
                  hits.push(Math.round(r.width) + 'px "' + text.slice(0, 28) + '"');
              }
              return hits.slice(0, 3);
            })()`);
            for (const h of squeezed) sweepSqueezed.push(`${route} — ${h}`);
            sweepHeights.add(s.h);
            if (s.pos !== "fixed") sweepBad.push(`${route}: bar is ${s.pos}, not fixed`);
            if (s.w !== s.vw) sweepBad.push(`${route}: bar is ${s.w}px wide, viewport ${s.vw}`);
            if (s.h < 56) sweepBad.push(`${route}: bar is only ${s.h}px tall`);
            if (s.bottom !== 0) sweepBad.push(`${route}: bar sits ${s.bottom}px off the bottom`);
            if (s.covered) sweepBad.push(`${route}: the last element in main sits behind the fixed tab bar`);
            // The same rule as the /teacher check, applied to every route: the
            // Teacher App shows no install banner anywhere, so no page can have one
            // covering its last row, a button, or the bottom bar.
            if (s.banner) sweepBad.push(`${route}: the floating install banner is on screen`);
            // The native back affordance: every screen BELOW the root has one and
            // it walks to the app root, while the root screen must not show one.
            if (route === "/teacher") {
              if (s.backHref) sweepBad.push("/teacher: the root screen shows a back affordance");
            } else if (s.backHref !== "/teacher") {
              sweepBad.push(`${route}: back affordance is ${s.backHref || "missing"}, want /teacher`);
            }
            if (maxOvf > 0) sweepOver.push(`${route} +${maxOvf}px`);
          }
          if (sweepBad.length) bad("teacher", "teacher app @390 (headless sweep)", sweepBad.slice(0, 3).join("; "));
          else if (sweepOver.length)
            bad("teacher", "teacher app @390 (headless sweep)", `sideways scroll on ${sweepOver.join(", ")}`);
          else if (swept !== PAGES.teacher.length)
            bad("teacher", "teacher app @390 (headless sweep)", `only ${swept} of ${PAGES.teacher.length} routes answered`);
          else
            console.log(
              `  ✅ teacher app @390 sweep: all ${swept} routes — bottom bar fixed ${[...sweepHeights].join("/")}px, full width & flush, back affordance on every sub-route and none at the root, no install banner on any page, 0px sideways scroll`,
            );
          if (sweepSqueezed.length)
            bad("teacher", "teacher app @390 (no collapsed text)", sweepSqueezed.slice(0, 3).join("; "));
          else
            console.log(
              `  ✅ teacher app @390: ${swept} routes, no text squeezed into a sliver column (no title wrapping one word per line)`,
            );

          // --- the missing banner and the dark bar are APP-ONLY -----------------------
          //
          // Both changes touch something the other sectors also render: the banner
          // is mounted from the ROOT LAYOUT, and the bell comes from a component the
          // School Admin / Super Admin shell shares. Both phone-first apps (Teacher
          // App, Parents App) opt into the dark chrome and hide the banner, while the
          // console/portal sectors must keep the light bar and the banner — so it is
          // checked on their OWN rendered pages, not on the source, and neither the
          // dark bar nor the dark bell may leak outside the two apps.
          {
            // The Parents App is an app now (as the Teacher App is), so it is the
            // app-side case; the console/portal sectors are the non-app controls and
            // must keep the light bar and the banner. The Teacher App's own dark
            // chrome is asserted by the phone-layout section, so this stays at the
            // previous three pages.
            const cases = [
              { label: "guardian", role: ROLES.find((r) => r.label === "guardian"), path: "/parent", app: true },
              { label: "school-admin", role: ROLES.find((r) => r.label === "school-admin"), path: "/dashboard", app: false },
              { label: "super-admin", role: ROLES.find((r) => r.label === "super-admin"), path: "/admin", app: false },
            ];
            const scopeBad = [];
            for (const c of cases) {
              const sess = await login(c.role.host, c.role.id, c.role.pw);
              if (sess.status !== 200 || !sess.cookie) {
                scopeBad.push(`${c.label}: login HTTP ${sess.status}`);
                continue;
              }
              const op = await browser.newPage();
              const [cn, ...cv] = sess.cookie.split("=");
              await op.setCookie({ name: cn, value: cv.join("="), url: `http://${c.role.host}/` });
              await op.setViewport({ width: 390, height: 844, mobile: true });
              await op.goto(`http://${c.role.host}${c.path}`);
              // The bell arrives with the session, not with the first paint, so wait
              // for the bell itself — otherwise this would race the `/api/me` read
              // and report a missing bell that was simply not there yet.
              const bellUp = await op.waitFor("document.querySelector('[aria-label=\"Notifications\"]')", 15000);
              if (!bellUp) scopeBad.push(`${c.label}: the bell never mounted within 15s`);
              await HL.sleep(600);
              const seen = await op.evaluate(`(() => {
                const bell = document.querySelector('[aria-label="Notifications"]');
                return {
                  banner: !!document.querySelector('[aria-label="Dismiss"]'),
                  darkNodes: document.querySelectorAll('[class*="0F172A"]').length,
                  bellClass: bell ? bell.className : null,
                };
              })()`);
              if (c.app) {
                if (seen.banner) scopeBad.push(`${c.label}: the install banner is still shown inside an app — the Teacher/Parents App hides it`);
                if (!seen.darkNodes) scopeBad.push(`${c.label}: the app dark bar is missing — no element carries the app dark token`);
                if (!seen.bellClass) scopeBad.push(`${c.label}: no notification bell rendered`);
                else if (!seen.bellClass.includes("text-slate-300")) scopeBad.push(`${c.label}: the bell is not the app dark variant`);
              } else {
                if (!seen.banner) scopeBad.push(`${c.label}: the install banner is gone — it must still be offered outside the apps`);
                if (seen.darkNodes) scopeBad.push(`${c.label}: ${seen.darkNodes} element(s) carry the app dark-bar token — it must not leak outside the apps`);
                if (!seen.bellClass) scopeBad.push(`${c.label}: no notification bell rendered`);
                else {
                  if (seen.bellClass.includes("text-slate-300")) scopeBad.push(`${c.label}: the bell picked up the app dark variant`);
                  if (!seen.bellClass.includes("text-slate-500")) scopeBad.push(`${c.label}: the bell trigger's original classes changed`);
                }
              }
              // The driver's Page exposes no close(); the browser is closed below.
            }
            if (scopeBad.length) bad("teacher", "app chrome scope", scopeBad.slice(0, 4).join("; "));
            else
              console.log(
                "  ✅ dark bar + banner stay app-only: dark and banner-free on /parent, still light with the banner offered to school-admin and super-admin",
              );
          }

          // --- the shared components' DEFAULT rendering is untouched --------------
          //
          // These panels are shared across sectors, each with an opt-in app
          // appearance whose DEFAULT branch is the original portal markup. Both
          // phone-first apps (Teacher App, Parents App) now take the app surface, so
          // the assertion is: the app sectors render the inset panel (and drop the
          // assistant heading), and the School Admin control still renders the
          // portal's bordered `Card`. Asserted on the rendered page rather than in
          // the source, because the branch is a runtime decision.
          {
            // `proves` is the element each component's DEFAULT branch actually
            // renders: the portal `.card` for the chat and the notification centre,
            // and the AI panel's own heading — the assistant has no `.card`, and its
            // teacher variant is precisely the branch that removes that heading.
            const sharedCases = [
              // App sectors: the inset ring panel replaces the portal Card, and the
              // assistant drops the heading the dark app bar already owns.
              { label: "guardian /parent/messages", host: `parents.localhost:${PORT}`, path: "/parent/messages", proves: 'main [class*="ring-slate-900/5"]', app: true, ai: false },
              { label: "guardian /parent/ai", host: `parents.localhost:${PORT}`, path: "/parent/ai", proves: "main", app: true, ai: true },
              // Non-app control: the console keeps the portal's bordered Card.
              { label: "school-admin /dashboard/notifications", host: `school.localhost:${PORT}`, path: "/dashboard/notifications", proves: "main .card", app: false, ai: false },
            ];
            const sharedBad = [];
            for (const c of sharedCases) {
              const role = ROLES.find((r) => r.host === c.host);
              const sess = await login(c.host, role.id, role.pw);
              if (sess.status !== 200 || !sess.cookie) {
                sharedBad.push(`${c.label}: login HTTP ${sess.status}`);
                continue;
              }
              const sp = await browser.newPage();
              const [cn, ...cv] = sess.cookie.split("=");
              await sp.setCookie({ name: cn, value: cv.join("="), url: `http://${c.host}/` });
              await sp.setViewport({ width: 390, height: 844, mobile: true });
              await sp.goto(`http://${c.host}${c.path}`);
              await sp.waitFor("document.querySelector('main')", 15000);
              // These panels fetch after mount, and the chat list is the slowest of
              // them — measured at ~6s to its first content. Wait for the thing
              // being asserted, not for a text length: the chat's header renders
              // before any conversation arrives, so a length threshold would pass
              // while the surface under test had not yet mounted.
              await sp.waitFor(`document.querySelector('${c.proves}')`, 30000).catch(() => false);
              await HL.sleep(400);
              const seen = await sp.evaluate(`(() => {
                const main = document.querySelector('main');
                const cards = [...main.querySelectorAll('.card')];
                const cs = cards[0] ? getComputedStyle(cards[0]) : null;
                return {
                  textLen: main.textContent.trim().length,
                  cards: cards.length,
                  appPanel: main.querySelectorAll('[class*="ring-slate-900/5"]').length,
                  heading: main.textContent.includes('AI Assistant'),
                  cardBorder: cs ? cs.borderTopWidth : null,
                  cardShadow: cs ? cs.boxShadow : null,
                };
              })()`);
              if (seen.textLen <= 60) {
                sharedBad.push(`${c.label}: the panel never rendered content`);
                continue;
              }
              if (c.app) {
                // The app surface is the inset ring panel; the portal Card must not
                // reappear there, and the app bar owns the screen title.
                if (!c.ai && !seen.appPanel)
                  sharedBad.push(`${c.label}: no app inset panel within 30s — the app surface regressed`);
                if (c.ai && seen.heading)
                  sharedBad.push(`${c.label}: the assistant heading is back — the app bar owns the title`);
              } else {
                // The default branch renders the portal's `.card` — a 1px border and
                // no ring. The app branch renders the inset panel instead, so a
                // default-branch page must have the card and must NOT have the ring.
                if (seen.cards < 1) sharedBad.push(`${c.label}: no portal .card within 30s — the default rendering changed`);
                else if (seen.cardBorder !== "1px")
                  sharedBad.push(`${c.label}: the .card border is ${seen.cardBorder}, not the portal's 1px`);
                else if (seen.cardShadow && seen.cardShadow.includes("0px 0px 0px 1px"))
                  sharedBad.push(`${c.label}: the app inset ring leaked into the default rendering`);
                if (c.ai && !seen.heading)
                  sharedBad.push(`${c.label}: the assistant's own heading is missing — the app variant leaked`);
              }
            }
            if (sharedBad.length) bad("teacher", "shared component defaults", sharedBad.slice(0, 4).join("; "));
            else
              console.log(
                "  ✅ shared component defaults: the two apps render the inset panel and drop the assistant heading, while admin notifications keeps the portal .card (no cross-variant leak)",
              );
          }

          // --- the shared grading editor's DEFAULT branch is untouched -------------
          //
          // /teacher/grades renders the shared editor in its teacher variant;
          // /dashboard/grades is the School Admin console's copy, which must still
          // render the original portal cards + the 5-column grade table. Asserted
          // on the rendered page, because the variant is a runtime branch.
          {
            const role = ROLES.find((r) => r.host === `school.localhost:${PORT}`);
            const sess = await login(`school.localhost:${PORT}`, role.id, role.pw);
            if (sess.status !== 200 || !sess.cookie) {
              bad("teacher", "shared grading editor default", `dashboard login HTTP ${sess.status}`);
            } else {
              const gp = await browser.newPage();
              const [gc, ...gv] = sess.cookie.split("=");
              await gp.setCookie({ name: gc, value: gv.join("="), url: `http://school.localhost:${PORT}/` });
              await gp.setViewport({ width: 390, height: 844, mobile: true });
              await gp.goto(`http://school.localhost:${PORT}/dashboard/grades`);
              await gp.waitFor("document.querySelector('main')", 15000);
              const gLoaded = await gp.waitFor("document.querySelector('main table, main .card')", 15000).catch(() => false);
              await HL.sleep(300);
              const g = await gp.evaluate(`(() => {
                const main = document.querySelector('main');
                return {
                  cards: main.querySelectorAll('.card').length,
                  tables: main.querySelectorAll('table').length,
                  teacherRows: main.querySelectorAll('.ss-grade-row').length,
                };
              })()`);
              const gBad = [];
              if (!gLoaded) gBad.push("the default editor never rendered");
              if (g.cards < 1) gBad.push("no portal .card — the default rendering changed");
              if (g.teacherRows !== 0) gBad.push("the teacher band rows leaked into the default rendering");
              if (g.tables < 1) gBad.push("the default grade-bands <table> is missing — the teacher variant leaked in");
              if (gBad.length) bad("teacher", "shared grading editor default", gBad.join("; "));
              else
                console.log(
                  "  ✅ shared grading editor default: /dashboard/grades still renders the portal .card + its 5-column grade table, with no teacher band rows leaking in",
                );
              // The driver's Page exposes no close(); the browser is closed below.
            }
          }
        } catch (e) {
          bad("teacher", "/teacher (headless layout)", `driver error — ${e && e.message ? e.message : e}`);
        } finally {
          await browser.close();
        }
      }
    }
  }
}

console.log(`\n${fails.length ? `❌ ${fails.length} FAILURE(S)` : "✅ ALL GREEN"}`);
for (const f of fails) console.log("  - " + f);
process.exit(fails.length ? 1 : 0);
