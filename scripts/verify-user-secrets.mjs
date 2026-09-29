/**
 * verify-user-secrets.mjs — no account secret ever leaves the API.
 *
 * The Firestore shim returns whole documents (it ignores `select`), so any route
 * that puts a user document straight into a response ships that account's bcrypt
 * hash to the browser — and the demo shares one password, so a leaked hash is a
 * leaked account. `/api/guardians` and `/api/staff` were both caught doing
 * exactly that. This harness is the guard against a third time.
 *
 * What it does, against a running server:
 *   1. signs in as each demo role on its own host
 *   2. GETs that role's whole API surface and deep-scans every JSON response for
 *      `passwordHash` / `twoFactorSecret` / `backupCodes` / a bcrypt `$2a$`
 *      signature (the raw scan is what catches a hash under an unexpected key)
 *   3. a guardian must additionally never receive its child's `qrPin`/`qrToken`
 *      (staff legitimately may — the student page prints the QR identity)
 *   4. WRITE probes as the school admin: create a staff account, reset its
 *      password, soft-delete it — those RESPONSES are scanned too, because the
 *      original leak was in the body of the row that had just been written
 *   5. removes every probe document by reference and reads each one back
 *
 * Usage:
 *   SMOKE_PORT=3123 node scripts/verify-user-secrets.mjs
 *   SMOKE_ORIGIN=https://… node scripts/verify-user-secrets.mjs
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";

loadEnv();

// NB: this shell exports PORT=0, so never read process.env.PORT here.
const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const LOCAL_BASE = `http://127.0.0.1:${PORT}`;
const ORIGIN = (process.env.SMOKE_ORIGIN || "").trim().replace(/\/+$/, "");
const base = () => ORIGIN || LOCAL_BASE;

const ROLES = {
  "super-admin": { host: `admin.localhost:${PORT}`, id: "admin@smartschool.com", pw: "Admin@123" },
  "school-admin": { host: `school.localhost:${PORT}`, id: "principal@sunrise.edu", pw: "School@123" },
  teacher: { host: `teacher.localhost:${PORT}`, id: "teacher@sunrise.edu", pw: "Teacher@123" },
  guardian: { host: `parents.localhost:${PORT}`, id: "guardian1@demo.com", pw: "Guardian@123" },
};

/** Key names that must never appear in a response body, for any role. */
const FORBIDDEN_KEYS = /^(passwordHash|password|twoFactorSecret|totpSecret|backupCodes|backupHashes)$/;
/** `qrPin`/`qrToken` are staff-only: they are the child's own login credential. */
const GUARDIAN_FORBIDDEN_KEYS = /^(qrPin|qrToken)$/;
/** A bcrypt hash, wherever it turns up — value-level check. */
const BCRYPT = /\$2[aby]\$/;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
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
  const res = await fetch(`${base()}${path}`, {
    ...init,
    headers: {
      ...(ORIGIN ? {} : { Host: host }),
      "Content-Type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(init.headers || {}),
    },
    redirect: "manual",
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* html or empty */
  }
  return {
    status: res.status,
    body,
    data: body?.data ?? null,
    error: body?.error ?? null,
    setCookie: res.headers.get("set-cookie") || "",
  };
}

async function login(roleKey) {
  const role = ROLES[roleKey];
  const r = await req(role.host, "/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier: role.id, password: role.pw }),
  });
  if (r.status !== 200) throw new Error(`login ${role.id}: HTTP ${r.status} ${r.error || ""}`);
  const cookie = r.setCookie.split(";")[0];
  if (!cookie) throw new Error(`login ${role.id}: no session cookie`);
  return cookie;
}

/* ------------------------------------------------------------- the scanner */
const isPlain = (v) => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * Walk the whole payload and collect every offending location. A string VALUE
 * that looks like a bcrypt hash is reported wherever it is; forbidden KEY names
 * are reported too, so a future route that returns a hash under another label is
 * still caught by the value scan.
 */
function scan(node, { role, path = "data", hits = [] } = {}) {
  if (node === null || node === undefined) return hits;
  if (typeof node === "string") {
    if (BCRYPT.test(node)) hits.push(`${path} = a bcrypt hash`);
    return hits;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => scan(v, { role, path: `${path}[${i}]`, hits }));
    return hits;
  }
  if (isPlain(node)) {
    for (const [k, v] of Object.entries(node)) {
      const p = `${path}.${k}`;
      if (FORBIDDEN_KEYS.test(k)) hits.push(p);
      if (role === "guardian" && GUARDIAN_FORBIDDEN_KEYS.test(k)) hits.push(p);
      scan(v, { role, path: p, hits });
    }
  }
  return hits;
}

/**
 * GET a route and assert nothing secret comes back. 401/403/404 are counted as
 * "not reachable for this role" (a route a role may not read cannot leak to it)
 * rather than passing silently as a clean read.
 */
async function scanRoute(role, host, cookie, path, stats) {
  const r = await req(host, path, { cookie });
  if (r.status !== 200 || !r.body) {
    stats.skipped.push(`${path} (HTTP ${r.status})`);
    return;
  }
  const hits = scan(r.body, { role });
  stats.scanned.push(path);
  if (hits.length) {
    stats.leaks.push(`${path} → ${hits.join(", ")}`);
    check(`${role} GET ${path} leaks nothing`, false, hits.join(", "));
  }
}

/* ------------------------------------------------------------- route lists */
const SUPER_ADMIN_APIS = ["/api/auth/me", "/api/schools", "/api/settings", "/api/plans", "/api/subscriptions", "/api/stats"];
const SCHOOL_ADMIN_APIS = [
  "/api/auth/me", "/api/stats", "/api/students", "/api/teachers", "/api/staff", "/api/guardians",
  "/api/classes", "/api/sections", "/api/subjects", "/api/fees", "/api/fees/settings", "/api/fee-categories",
  "/api/exams", "/api/homework", "/api/attendance", "/api/notices", "/api/meetings",
  "/api/messages", "/api/chat", "/api/admissions", "/api/ledger", "/api/leave-requests", "/api/books",
  "/api/complaints", "/api/resources", "/api/branches", "/api/grading-scheme", "/api/routines",
  "/api/payments", "/api/settings",
];
const TEACHER_APIS = [
  "/api/auth/me", "/api/stats", "/api/students", "/api/classes", "/api/sections", "/api/subjects",
  "/api/fees", "/api/exams", "/api/homework", "/api/attendance", "/api/notices", "/api/meetings",
  "/api/messages", "/api/chat", "/api/remarks", "/api/resources", "/api/quizzes", "/api/leave-requests",
  "/api/grading-scheme",
];
const GUARDIAN_APIS = [
  "/api/auth/me", "/api/stats", "/api/fees", "/api/payments", "/api/parent/siblings", "/api/student/me",
  "/api/homework", "/api/attendance", "/api/exams", "/api/notices", "/api/meetings", "/api/messages",
  "/api/chat", "/api/resources", "/api/leave-requests", "/api/books", "/api/quizzes/available",
  "/api/ledger", "/api/complaints",
];

async function routesFor(role, host, cookie) {
  if (role === "super-admin") return SUPER_ADMIN_APIS;
  if (role === "school-admin") return SCHOOL_ADMIN_APIS;
  if (role === "teacher") return TEACHER_APIS;
  // The guardian's own child, discovered at run time — the routes that resolve a
  // student embed that child's whole document when they go wrong.
  const sib = await req(host, "/api/parent/siblings", { cookie });
  const childId = Array.isArray(sib.data) ? sib.data[0]?.id : null;
  return childId
    ? [...GUARDIAN_APIS, `/api/students/${childId}`, `/api/certificates?studentId=${childId}&type=TC`]
    : GUARDIAN_APIS;
}

/* ------------------------------------------------------- write-probe cleanup */
const probeIds = { userId: null };
/** Remove the probe account and prove it is gone (the API only soft-deletes). */
async function cleanProbe() {
  if (!probeIds.userId) return true;
  const ref = db.collection("users").doc(probeIds.userId);
  await ref.delete();
  const back = await ref.get();
  return !back.exists;
}

/* ------------------------------------------------------------- self-test */
// A guard that cannot fail is not a guard: prove the scanner actually sees a
// hash and a QR credential before trusting a clean sweep.
{
  const fixture = {
    data: {
      user: { id: "u1", passwordHash: "$2a$10$AAAAAAAAAAAAAAAAAAAAAA", twoFactorSecret: "JBSWY3DP" },
      student: { id: "s1", qrPin: "1234", qrToken: "tok_abc" },
    },
  };
  const hits = scan(fixture, { role: "guardian" });
  const sawHash = hits.some((h) => h.includes("passwordHash")) && hits.some((h) => h.endsWith("a bcrypt hash"));
  const sawQr = hits.some((h) => h.includes("qrPin")) && hits.some((h) => h.includes("qrToken"));
  check("scanner self-test: a bcrypt hash is detected", sawHash, hits.join(", "));
  check("scanner self-test: a guardian's qrPin/qrToken are detected", sawQr, "");
  if (!sawHash || !sawQr) {
    console.error("Scanner is broken — refusing to report a clean sweep.");
    process.exit(1);
  }
}

/* ----------------------------------------------------------------- the run */
console.log(`user-secret sweep against ${base()}\n`);

for (const role of ["super-admin", "school-admin", "teacher", "guardian"]) {
  const { host } = ROLES[role];
  const cookie = await login(role);
  const routes = await routesFor(role, host, cookie);
  const s = { scanned: [], skipped: [], leaks: [] };
  for (const route of routes) await scanRoute(role, host, cookie, route, s);
  console.log(
    `\n${role}: scanned ${s.scanned.length}/${routes.length} routes` +
      (s.skipped.length ? `, ${s.skipped.length} not readable by this role` : "")
  );
  // A route that answers 400/403/404 (needs a param, or is not this role's) has
  // nothing to leak, so it counts as covered — but the run must still have
  // scanned a real surface, or a broken route list would "pass" by doing nothing.
  check(
    `${role} API surface returned data to scan (${s.scanned.length} routes)`,
    s.scanned.length >= 5,
    s.skipped.length ? `not readable by this role: ${s.skipped.join(" ")}` : ""
  );
}

/* ---- write probes: the create/update RESPONSES are part of the surface ---- */
const adminRole = ROLES["school-admin"];
const adminCookie = await login("school-admin");
const stamp = Math.random().toString(36).slice(2, 8);
const probeEmail = `zz-secrets-${stamp}@demo.local`;

try {
  const created = await req(adminRole.host, "/api/staff", {
    cookie: adminCookie,
    method: "POST",
    body: JSON.stringify({ name: "ZZ Secret Probe", email: probeEmail, password: "Probe@12345", role: "ACCOUNTANT" }),
  });
  if (created.status === 201) {
    probeIds.userId = created.data?.id || null;
    const hits = scan(created.body, { role: "school-admin" });
    check("staff POST response leaks nothing", hits.length === 0, hits.join(", "));
    if (probeIds.userId) {
      const patched = await req(adminRole.host, "/api/staff", {
        cookie: adminCookie,
        method: "PATCH",
        body: JSON.stringify({ id: probeIds.userId, password: "Probe@67890" }),
      });
      const patchHits = scan(patched.body, { role: "school-admin" });
      check("staff PATCH (password reset) response leaks nothing", patchHits.length === 0, patchHits.join(", "));

      const removed = await req(adminRole.host, `/api/staff?id=${probeIds.userId}`, { cookie: adminCookie, method: "DELETE" });
      const delHits = scan(removed.body, { role: "school-admin" });
      check("staff DELETE response leaks nothing", delHits.length === 0, delHits.join(", "));
    }
  } else {
    // A locked subscription (PRD §12.1) legitimately refuses writes on this tenant.
    check("staff POST probe ran", false, `HTTP ${created.status} ${created.error || ""}`);
  }
} finally {
  const gone = await cleanProbe();
  check("probe staff account removed from Firestore", gone, probeIds.userId || "(never created)");
}

console.log("");
if (failures) {
  console.log(`${failures} CHECK(S) FAILED — an account secret is reachable from the API.`);
  process.exit(1);
}
console.log("ALL GREEN — no bcrypt hash, 2FA secret or QR credential leaves the API for any role.");
