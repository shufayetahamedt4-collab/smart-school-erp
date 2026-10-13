#!/usr/bin/env node
/**
 * verify-role-probe.mjs — the D-7-18 **role probe on a production build**
 * (docs/COLLEGE-DECISIONS.md §24.5 D-7-18: "it must pass the same role probe on a
 * production build before 7f").
 *
 * This is the go-live item the college phases have carried since 6f
 * (`docs/COLLEGE-STATUS.md`, "Go-live: role probe on a production build — not
 * run"). It is the same role/permission matrix the HTTP verifiers assert, but
 * aimed at the WHOLE surface a person actually touches — the college fee SCREEN
 * (`/dashboard/college-fees`) and the two D-7-17 PRINT pages — and it reports
 * which build answered, so "it was a production build" is a fact in the output
 * rather than a claim about the command someone meant to run.
 *
 *   # against a production build (the 7f evidence):
 *   npm run build
 *   NODE_ENV=production npx next start -p 3111        # emulator env set, dev STOPPED
 *   PROBE_ORIGIN=http://127.0.0.1:3111 node scripts/verify-role-probe.mjs
 *
 *   # or against the dev server on SMOKE_PORT (the same checks, labelled "dev")
 *
 * What it asserts, per D-7-18 and the phase's acceptance criteria:
 *
 *   A. AUTHENTICATION — no session renders no data and no screen: the print
 *      pages answer "…not found." and the APIs answer 401/403, never a row.
 *   B. AUTHORIZED COLLEGE ACCESS — the admin-level role, the ACCOUNTANT and the
 *      read-only REGISTRAR reach the college fee screen and both print pages, and
 *      the print pages render the tenant's OWN rows (the fixture's 45,000 charge
 *      and its CRCP- receipt).
 *   C. SCHOOL-TENANT REJECTION — a tenant with no college half (no
 *      `institutionType`) is refused by the API (403, zero data) and renders
 *      "available to college tenants only" on the print pages, with no college
 *      money anywhere in the HTML.
 *   D. ROLE BOUNDARY INSIDE A COLLEGE-CAPABLE TENANT — TEACHER, GUARDIAN and
 *      STUDENT are refused by the same tenant whose admin is served, in both
 *      directions (read and the write gate), and their own school fee read still
 *      works — the refusal is the D-7-18 rule, not a broken tenant.
 *   E. TENANT ISOLATION — a foreign student or charge id is the SAME 404/not-
 *      found answer as a ghost id (no oracle), and no foreign money appears.
 *   F. WHICH BUILD ANSWERED — the served asset prefix is compared with
 *      `.next/BUILD_ID`; a production build embeds it, a dev server does not.
 *
 * Read-mostly: the only writes it attempts are ones that MUST be refused (the
 * gate check) or invalid (the validation check), so it creates no college data.
 * Needs the emulator, the app, and `node scripts/isolation-fixture.mjs create`.
 */
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";
import { installHostFetch } from "./lib/hostfetch.mjs";
import { readFileSync } from "node:fs";

installHostFetch();
loadEnv();
requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3123";
const ORIGIN = process.env.PROBE_ORIGIN || process.env.SMOKE_ORIGIN || `http://127.0.0.1:${PORT}`;
// Whether the Host header carries routing is a property of the ORIGIN we dial,
// not of which environment variable named it: a LOCAL production build (the 7f
// run: PROBE_ORIGIN=http://127.0.0.1:3111) is host-routed exactly like the dev
// server, while a deployed address serves every app from one host.
const ORIGIN_PORT = (() => {
  try {
    return new URL(ORIGIN).port || PORT;
  } catch {
    return PORT;
  }
})();
const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?(\/|$)/i.test(ORIGIN);
// Each role signs in on the sector app that owns it (the sign-in route refuses a
// teacher on the school host) — but `/api/*` is never host-routed and `/print/*`
// is a shared path, so the probes below are valid on whichever host the role
// really uses in a browser.
const HOSTS = {
  school: `school.localhost:${ORIGIN_PORT}`,
  teachers: `teachers.localhost:${ORIGIN_PORT}`,
  parents: `parents.localhost:${ORIGIN_PORT}`,
};
// `hub` sends no Host header at all (the bare localhost the harnesses use): a
// STUDENT belongs to no sector app, and the hub stays host-agnostic by design.
const hostFor = (key) => (LOOPBACK && key !== "hub" ? { Host: HOSTS[key] } : {});

const P = "zziso-";
const BOTH_STU = `${P}both-stu`;
const BOTH_CHARGE = `${P}both-charge-1`;
const BOTH_RECEIPT = "CRCP-900001";
const COLLEGE_STU_A = `${P}col-stu-a`;
const SCHOOL_STU = `${P}student`;

const TRACK = new URL(".qa-fixtures.json", import.meta.url);
let CRED = {};
try {
  CRED = JSON.parse(readFileSync(TRACK, "utf8")).creds || {};
} catch {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(2);
}
for (const key of ["bothAdmin", "collegeAdmin", "collegeAccountant", "collegeRegistrar", "admin", "bothTeacher", "bothGuardian", "bothStudent"]) {
  if (!CRED[key]) {
    console.error(`❌ The fixture has no \`${key}\` — run: node scripts/isolation-fixture.mjs create`);
    process.exit(2);
  }
}

/* ------------------------------------------------------------------- helpers */

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/**
 * A request that returns the page TEXT as well as the status: the print pages are
 * server-rendered, so their refusal IS the HTML — the same probe
 * `verify-branch-isolation` uses for the transcript page.
 */
async function get(path, { cookie, hostKey = "school" } = {}) {
  const res = await fetch(`${ORIGIN}${path}`, {
    headers: { ...hostFor(hostKey), ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, text, data: body?.data ?? null, error: body?.error ?? null };
}
async function send(method, path, payload, { cookie, hostKey = "school" } = {}) {
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers: { ...hostFor(hostKey), "Content-Type": "application/json", ...(cookie ? { cookie } : {}) },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, text, data: body?.data ?? null, error: body?.error ?? null };
}
async function signIn(email, password, hostKey = "school") {
  const res = await fetch(`${ORIGIN}/api/auth/login`, {
    method: "POST",
    headers: { ...hostFor(hostKey), "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(60000),
  });
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (res.status !== 200 || !cookie) throw new Error(`login ${email}: HTTP ${res.status}`);
  return cookie;
}

const REFUSAL_READ = "College fees are available to the school administration, the accounts office and the registrar.";
const REFUSAL_NO_COLLEGE = "available to college tenants only";
const NOT_FOUND_STATEMENT = "Statement not found.";
const NOT_FOUND_RECEIPT = "Receipt not found.";

/* ---------------------------------------------------------------- the run */

console.log(`\n=== D-7-18 role probe — college fee screens and print pages (${ORIGIN}) ===\n`);

/* F. which build answered (first, so the transcript says it up front) */
let buildId = "";
try {
  buildId = readFileSync(new URL("../.next/BUILD_ID", import.meta.url), "utf8").trim();
} catch {
  buildId = "";
}
const login = await get("/login");
// A production build embeds the `.next/BUILD_ID` it was built with in the flight
// payload it serves (`"b":"<id>"`); `next dev` writes no such id and embeds none,
// so this is the probe's own evidence of WHICH binary answered. Run against a dev
// server this is expected to be the ONE failing check — that is its job.
const served = !!buildId && login.text.includes(buildId);
console.log(
  `### F. the build that answered: ${served ? `PRODUCTION BUILD (build id ${buildId})` : "NOT a production build of this checkout (dev server, or .next/BUILD_ID missing)"}`
);
check(
  ".next/BUILD_ID exists and the served page embeds it (a production build, not a dev server)",
  served,
  served ? `build id ${buildId}` : `buildId=${buildId || "(none)"} — the page served does not carry it`
);

/* A. authenticated at all */
console.log("\n### A. authentication: no session, no data");
{
  const anonStatement = await get(`/print/college-fee-statement/${encodeURIComponent(BOTH_STU)}`);
  check(
    "an anonymous print statement renders 'Statement not found.' and no money",
    anonStatement.status === 200 && anonStatement.text.includes(NOT_FOUND_STATEMENT) && !anonStatement.text.includes("45,000"),
    `HTTP ${anonStatement.status}`
  );
  const anonReceipt = await get(`/print/college-fee-receipt/${encodeURIComponent(BOTH_CHARGE)}`);
  check(
    "an anonymous print receipt renders 'Receipt not found.'",
    anonReceipt.status === 200 && anonReceipt.text.includes(NOT_FOUND_RECEIPT),
    `HTTP ${anonReceipt.status}`
  );
  const anonDues = await send("GET", "/api/college-fees/dues");
  check("GET /api/college-fees/dues unauthenticated → 401", anonDues.status === 401, `HTTP ${anonDues.status}`);
  const anonSchoolFees = await send("GET", "/api/fees");
  check("GET /api/fees unauthenticated → 403", anonSchoolFees.status === 403, `HTTP ${anonSchoolFees.status}`);
}

const bothAdmin = await signIn("zz-iso-both-admin@test.local", CRED.bothAdmin);
const collegeAccountant = await signIn("zz-iso-college-accountant@test.local", CRED.collegeAccountant);
const collegeRegistrar = await signIn("zz-iso-college-registrar@test.local", CRED.collegeRegistrar);

/* B. authorized college access */
console.log("\n### B. authorized college access: the screen and both print pages");
{
  const screen = await get("/dashboard/college-fees", { cookie: bothAdmin });
  check(
    "the college fee screen is served to the tenant's admin (200, an app shell — never a refusal page)",
    screen.status === 200 && !screen.text.includes(REFUSAL_READ),
    `HTTP ${screen.status}`
  );
  const statement = await get(`/print/college-fee-statement/${encodeURIComponent(BOTH_STU)}`, { cookie: bothAdmin });
  check(
    "the admin's print statement renders the tenant's OWN charge (৳45,000.00) and its rate footer",
    statement.status === 200 && statement.text.includes("45,000.00") && statement.text.includes("Rates used"),
    `HTTP ${statement.status} money=${statement.text.includes("45,000.00")}`
  );
  const receipt = await get(
    `/print/college-fee-receipt/${encodeURIComponent(BOTH_CHARGE)}?receipt=${encodeURIComponent(BOTH_RECEIPT)}`,
    { cookie: bothAdmin }
  );
  check(
    "the admin's print receipt renders THAT payment (CRCP- receipt and its ৳15,000.00)",
    receipt.status === 200 && receipt.text.includes(BOTH_RECEIPT) && receipt.text.includes("15,000.00"),
    `HTTP ${receipt.status} receipt=${receipt.text.includes(BOTH_RECEIPT)}`
  );

  // The COLLEGE tenant has no fee spine, so it is the AUTHORIZATION path (not the
  // money): the accountant and the registrar both reach the reads.
  const accountantDues = await send("GET", "/api/college-fees/dues", undefined, { cookie: collegeAccountant });
  const registrarDues = await send("GET", "/api/college-fees/dues", undefined, { cookie: collegeRegistrar });
  check(
    "the ACCOUNTANT and the read-only REGISTRAR both reach the college fee read",
    accountantDues.status === 200 && registrarDues.status === 200,
    `accountant=${accountantDues.status} registrar=${registrarDues.status}`
  );
  const accountantPage = await get(`/print/college-fee-statement/${encodeURIComponent(COLLEGE_STU_A)}`, { cookie: collegeAccountant });
  const registrarPage = await get(`/print/college-fee-statement/${encodeURIComponent(COLLEGE_STU_A)}`, { cookie: collegeRegistrar });
  check(
    "…and both print pages render for them (authorized, empty — no charges raised in that tenant)",
    accountantPage.status === 200 && registrarPage.status === 200 &&
      accountantPage.text.includes("No college charges have been raised") &&
      registrarPage.text.includes("No college charges have been raised"),
    `accountant=${accountantPage.status} registrar=${registrarPage.status}`
  );
  // The write gate WITHOUT writing: an EMPTY body reaches validation only if the
  // gate let the caller through, so 400 = allowed-to-write, 403 = refused.
  const accountantWrite = await send("POST", "/api/college-fees/heads", {}, { cookie: collegeAccountant });
  const registrarWrite = await send("POST", "/api/college-fees/heads", {}, { cookie: collegeRegistrar });
  check(
    "the ACCOUNTANT may write (400 from validation, i.e. past the gate) but the REGISTRAR may not (403)",
    accountantWrite.status === 400 && registrarWrite.status === 403,
    `accountant=${accountantWrite.status} (${accountantWrite.error || ""}) registrar=${registrarWrite.status} (${registrarWrite.error || ""})`
  );
}

/* C. a SCHOOL tenant is refused */
console.log("\n### C. a tenant with no college half is refused");
{
  const schoolAdmin = await signIn("zz-iso-admin@test.local", CRED.admin);
  const dues = await send("GET", "/api/college-fees/dues", undefined, { cookie: schoolAdmin });
  check(
    "a SCHOOL tenant's admin gets 403 with ZERO data from the college fee read",
    dues.status === 403 && dues.data === null,
    `HTTP ${dues.status} data=${JSON.stringify(dues.data)}`
  );
  const write = await send("POST", "/api/college-fees/heads", { name: "ZZ Probe Head" }, { cookie: schoolAdmin });
  check("…and is 403 on the write too", write.status === 403, `HTTP ${write.status}`);
  const statement = await get(`/print/college-fee-statement/${encodeURIComponent(SCHOOL_STU)}`, { cookie: schoolAdmin });
  check(
    "its print page says 'available to college tenants only' and carries no college money",
    statement.status === 200 && statement.text.includes(REFUSAL_NO_COLLEGE) && !statement.text.includes("45,000") && !statement.text.includes(BOTH_RECEIPT),
    `HTTP ${statement.status}`
  );
  const receipt = await get(`/print/college-fee-receipt/${encodeURIComponent(BOTH_CHARGE)}`, { cookie: schoolAdmin });
  check(
    "…and the receipt page does not render another tenant's payment",
    receipt.status === 200 && !receipt.text.includes(BOTH_RECEIPT) && !receipt.text.includes("15,000.00"),
    `HTTP ${receipt.status}`
  );
}

/* D. the role boundary inside a college-capable tenant */
console.log("\n### D. TEACHER / GUARDIAN / STUDENT are refused INSIDE a college-capable tenant");
{
  const teacher = await signIn("zz-iso-both-teacher@test.local", CRED.bothTeacher, "teachers");
  const guardian = await signIn("zz-iso-both-guardian@test.local", CRED.bothGuardian, "parents");
  const student = await signIn("zz-iso-both-student@test.local", CRED.bothStudent, "hub");

  const dues = await Promise.all([
    send("GET", "/api/college-fees/dues", undefined, { cookie: teacher, hostKey: "teachers" }),
    send("GET", "/api/college-fees/dues", undefined, { cookie: guardian, hostKey: "parents" }),
    send("GET", "/api/college-fees/dues", undefined, { cookie: student, hostKey: "hub" }),
  ]);
  check(
    "all three are 403 on the college fee read, with the D-7-18 read refusal",
    dues.every((r) => r.status === 403 && r.error === REFUSAL_READ),
    `statuses=${JSON.stringify(dues.map((r) => r.status))}`
  );
  const pages = await Promise.all([
    get(`/print/college-fee-statement/${encodeURIComponent(BOTH_STU)}`, { cookie: teacher, hostKey: "teachers" }),
    get(`/print/college-fee-statement/${encodeURIComponent(BOTH_STU)}`, { cookie: guardian, hostKey: "parents" }),
    get(`/print/college-fee-statement/${encodeURIComponent(BOTH_STU)}`, { cookie: student, hostKey: "hub" }),
  ]);
  check(
    "…and the print statement renders the same refusal for each, with the tenant's charge NOWHERE in the HTML",
    pages.every((p) => p.status === 200 && p.text.includes(REFUSAL_READ) && !p.text.includes("45,000.00") && !p.text.includes("CRCP-")),
    `statuses=${JSON.stringify(pages.map((p) => p.status))}`
  );
  const receipts = await Promise.all([
    get(`/print/college-fee-receipt/${encodeURIComponent(BOTH_CHARGE)}`, { cookie: teacher, hostKey: "teachers" }),
    get(`/print/college-fee-receipt/${encodeURIComponent(BOTH_CHARGE)}`, { cookie: guardian, hostKey: "parents" }),
    get(`/print/college-fee-receipt/${encodeURIComponent(BOTH_CHARGE)}`, { cookie: student, hostKey: "hub" }),
  ]);
  check(
    "…and so does the receipt page",
    receipts.every((p) => p.status === 200 && p.text.includes(REFUSAL_READ) && !p.text.includes(BOTH_RECEIPT)),
    `statuses=${JSON.stringify(receipts.map((p) => p.status))}`
  );
  const writes = await Promise.all([
    send("POST", "/api/college-fees/heads", { name: "ZZ Probe Head" }, { cookie: teacher, hostKey: "teachers" }),
    send("POST", "/api/college-fees/heads", { name: "ZZ Probe Head" }, { cookie: guardian, hostKey: "parents" }),
    send("POST", "/api/college-fees/heads", { name: "ZZ Probe Head" }, { cookie: student, hostKey: "hub" }),
  ]);
  check(
    "…and all three are refused the write as well (403, never a 400 — the gate is first)",
    writes.every((r) => r.status === 403),
    `statuses=${JSON.stringify(writes.map((r) => r.status))}`
  );
  // …and the school half still works for them: the refusal is the college rule,
  // not a broken account (TEACHER sees the school fee list, as it always has).
  const teacherFees = await send("GET", "/api/fees", undefined, { cookie: teacher, hostKey: "teachers" });
  check(
    "the TEACHER's own school fee read is untouched (200 — 7e changed no school behaviour)",
    teacherFees.status === 200 && Array.isArray(teacherFees.data?.fees),
    `HTTP ${teacherFees.status} rows=${teacherFees.data?.fees?.length ?? "(none)"}`
  );
}

/* E. tenant isolation */
console.log("\n### E. another tenant's student or charge is the SAME answer as a ghost");
{
  const collegeAdmin = await signIn("zz-iso-college-admin@test.local", CRED.collegeAdmin);
  const foreign = await send("GET", `/api/college-fees/dues?studentId=${encodeURIComponent(BOTH_STU)}`, undefined, { cookie: collegeAdmin });
  const ghost = await send("GET", `/api/college-fees/dues?studentId=${encodeURIComponent(`${P}no-such-student`)}`, undefined, { cookie: collegeAdmin });
  check(
    "a foreign student id is the SAME 404 body as a ghost id (no oracle)",
    foreign.status === 404 && ghost.status === 404 && JSON.stringify(foreign) === JSON.stringify(ghost),
    `foreign=${foreign.status} ghost=${ghost.status}`
  );
  const reverse = await send("GET", `/api/college-fees/dues?studentId=${encodeURIComponent(COLLEGE_STU_A)}`, undefined, { cookie: bothAdmin });
  check("…and the reverse direction is refused the same way", reverse.status === 404, `HTTP ${reverse.status}`);
  const ghostPage = await get(`/print/college-fee-receipt/${encodeURIComponent(`${P}no-such-charge`)}`, { cookie: bothAdmin });
  check(
    "a charge id that does not exist renders 'Receipt not found.' with no money",
    ghostPage.status === 200 && ghostPage.text.includes(NOT_FOUND_RECEIPT) && !ghostPage.text.includes(BOTH_RECEIPT),
    `HTTP ${ghostPage.status}`
  );
  const foreignStudentPage = await get(`/print/college-fee-statement/${encodeURIComponent(COLLEGE_STU_A)}`, { cookie: bothAdmin });
  check(
    "another tenant's student renders 'Statement not found.' for this tenant's admin",
    foreignStudentPage.status === 200 && foreignStudentPage.text.includes(NOT_FOUND_STATEMENT),
    `HTTP ${foreignStudentPage.status}`
  );
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ role probe FAILED — ${failures} of ${checks} check(s).`);
  process.exit(1);
}
console.log(
  `✅ ROLE PROBE OK — ${checks} checks${
    served ? ` against the PRODUCTION build ${buildId}` : " against a dev server (no production build id served)"
  }: authentication, authorized college access (admin + ACCOUNTANT + read-only REGISTRAR), the SCHOOL-tenant refusal, the TEACHER/GUARDIAN/STUDENT refusal inside a college-capable tenant, and tenant isolation.`
);
