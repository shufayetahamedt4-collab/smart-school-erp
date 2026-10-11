/**
 * verify-enrollment-fees.mjs — 7-pre-2: mode-aware enrolment billing.
 *
 * `enrollStudent` → `createStudentFees` used to raise the school's `feeSetting`
 * defaults (Admission Fee + Monthly Fee) for ANY student it was asked to bill —
 * including a student enrolled with the college identity (`programId` /
 * `termNumber`). That is SCHOOL code on the school's money path, so this suite
 * checks both halves of the rule (docs/COLLEGE-DECISIONS.md §24.7, 7-pre-2):
 *
 *   • the decision comes from the ENROLMENT — a student carrying the college
 *     identity raises no school default;
 *   • the tenant's `institutionType` is the cross-check — a COLLEGE tenant can
 *     never raise school defaults even when a caller forgets the identity;
 *   • a SCHOOL tenant, and a BOTH tenant's school half, are byte-identical to
 *     before (the two default rows, 5000 + 1500, both UNPAID);
 *   • a college enrolment writes NOTHING — no `fee` row and no `feeSetting`.
 *
 * Runs over HTTP against the demo tenant + the isolation fixture tenants
 * (`scripts/isolation-fixture.mjs create`), reading the fee rows and the
 * `feeSettings` documents back through the Admin SDK so "raises no row" is
 * counted rather than inferred from an empty API payload.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-enrollment-fees.mjs
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync, existsSync } from "node:fs";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

import { installHostFetch } from "./lib/hostfetch.mjs";

installHostFetch();
loadEnv();
requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const HOST = `school.localhost:${PORT}`;
/** Isolation-fixture id prefix. */
const P = "zziso-";
/** The demo tenant's own fee default pair (the school's fixed 1500 / 5000). */
const DEFAULT_MONTHLY = 1500;
const DEFAULT_ADMISSION = 5000;

const TRACK = new URL(".qa-fixtures.json", import.meta.url);
if (!existsSync(TRACK)) {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(1);
}
const CRED = JSON.parse(readFileSync(TRACK, "utf8")).creds || {};
for (const key of ["admin", "collegeAdmin", "bothAdmin"]) {
  if (!CRED[key]) {
    console.error(`❌ Track file lacks credentials (${key}) — re-run: node scripts/isolation-fixture.mjs clean && create`);
    process.exit(1);
  }
}

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function req(path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Host: HOST, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null, setCookie: res.headers.get("set-cookie") || "" };
}
async function login(identifier, password) {
  const r = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
  if (r.status !== 200) throw new Error(`login ${identifier}: HTTP ${r.status} ${r.error || ""}`);
  return r.setCookie.split(";")[0];
}
const post = (path, body, cookie) => req(path, { cookie, method: "POST", body: JSON.stringify(body) });

/* ------------------------------------------------------------- db readers */
const feeRowsOf = async (studentId) => {
  const snap = await db.collection("fees").where("studentId", "==", studentId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => String(a.title).localeCompare(String(b.title)));
};
const feeSettingOf = async (schoolId) => {
  const snap = await db.collection("feeSettings").where("schoolId", "==", schoolId).get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
};
/** The two default rows, exactly as the school's own path writes them. */
const hasDefaultPair = (rows) => {
  const admission = rows.find((f) => f.feeType === "ADMISSION");
  const monthly = rows.find((f) => f.feeType === "MONTHLY");
  return (
    rows.length === 2 &&
    admission?.title === "Admission Fee" && admission.amount === DEFAULT_ADMISSION && admission.status === "UNPAID" && admission.paidAmount === 0 &&
    monthly?.title === "Monthly Fee" && monthly.amount === DEFAULT_MONTHLY && monthly.status === "UNPAID" && monthly.paidAmount === 0
  );
};
const describeRows = (rows) => rows.map((f) => `${f.title} ${f.amount} ${f.status} paid=${f.paidAmount}`).join(" | ") || "(none)";
const schoolIdOf = async (cookie) => (await req("/api/auth/me", { cookie })).data?.school?.id || null;

/* ---------------------------------------------------------------- the run */
console.log(`\n=== mode-aware enrolment billing (${BASE}) ===\n`);

const demoAdmin = await login("principal@sunrise.edu", "School@123");
const schoolAdmin = await login("zz-iso-admin@test.local", CRED.admin);
const collegeAdmin = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
const bothAdmin = await login("zz-iso-both-admin@test.local", CRED.bothAdmin);

const demoSchoolId = await schoolIdOf(demoAdmin);
const collegeSchoolId = await schoolIdOf(collegeAdmin);
const bothSchoolId = await schoolIdOf(bothAdmin);
console.log(`demo ${demoSchoolId} · college ${collegeSchoolId} · both ${bothSchoolId}\n`);

const stamp = Date.now();
const createdStudents = [];
const createdColleges = [];
let bothClassId = null;
let bothFeeSettingCreated = false;

/* --- A. the SCHOOL tenant: unchanged, byte for byte ---------------------- */
console.log("### A. SCHOOL tenant (demo — no institutionType)");
const demoClasses = (await req("/api/classes", { cookie: demoAdmin })).data || [];
const demoClass = demoClasses.find((c) => /class 1/i.test(c.name)) || demoClasses[0];
const demoSettingBefore = (await feeSettingOf(demoSchoolId))[0] || null;

const aBody = { name: `ZF A ${stamp}`, admissionNo: `ZF-A-${stamp}`, classId: demoClass?.id, createFees: true };
const a = await post("/api/students", aBody, demoAdmin);
if (a.data?.id) createdStudents.push({ id: a.data.id, cookie: demoAdmin });
check("A: the school enrolment succeeds (201)", a.status === 201 && !!a.data?.id, `HTTP ${a.status} ${a.error || ""} class=${demoClass?.name}`);

const aRowsApi = a.data?.id ? (await req(`/api/fees?studentId=${a.data.id}`, { cookie: demoAdmin })).data?.fees || [] : [];
const aRowsDb = a.data?.id ? await feeRowsOf(a.data.id) : [];
check(
  "A: it carries exactly the two default rows (Admission 5000 + Monthly 1500, both UNPAID)",
  hasDefaultPair(aRowsApi) && hasDefaultPair(aRowsDb),
  `api: ${describeRows(aRowsApi)}`
);
const demoSettingAfter = (await feeSettingOf(demoSchoolId))[0] || null;
check(
  "A: the school's fee setting is still 1500 / 5000",
  demoSettingAfter?.monthlyFee === DEFAULT_MONTHLY && demoSettingAfter?.admissionFee === DEFAULT_ADMISSION,
  `${demoSettingAfter?.monthlyFee} / ${demoSettingAfter?.admissionFee}`
);

/* --- B. a second SCHOOL tenant: the upsert still happens ------------- --- */
console.log("\n### B. SCHOOL tenant (fixture tenant with no institutionType)");
const schoolClasses = (await req("/api/classes", { cookie: schoolAdmin })).data || [];
const schoolClass = schoolClasses.find((c) => c.id === `${P}class`) || schoolClasses[0];
const b = await post("/api/students", { name: `ZF B ${stamp}`, admissionNo: `ZF-B-${stamp}`, classId: schoolClass?.id, createFees: true }, schoolAdmin);
if (b.data?.id) createdStudents.push({ id: b.data.id, cookie: schoolAdmin });
const bRows = b.data?.id ? await feeRowsOf(b.data.id) : [];
check("B: a school tenant's class student gets the two default rows", b.status === 201 && hasDefaultPair(bRows), `HTTP ${b.status} ${describeRows(bRows)}`);
const schoolSetting = (await feeSettingOf(`${P}school`))[0] || null;
check(
  "B: its fee setting was created with 1500 / 5000 (the upsert is untouched)",
  schoolSetting?.monthlyFee === DEFAULT_MONTHLY && schoolSetting?.admissionFee === DEFAULT_ADMISSION,
  `${schoolSetting?.monthlyFee} / ${schoolSetting?.admissionFee}`
);

/* --- C. a COLLEGE-only tenant: no school default at all ----------------- */
console.log("\n### C. COLLEGE tenant");
const cSettingBefore = (await feeSettingOf(collegeSchoolId)).length;
const c = await post(
  "/api/students",
  { name: `ZF C ${stamp}`, admissionNo: `ZF-C-${stamp}`, createFees: true, createGuardian: false, programId: `${P}col-prog-a`, termNumber: 1 },
  collegeAdmin
);
if (c.data?.id) createdStudents.push({ id: c.data.id, cookie: collegeAdmin });
check(
  "C: a college enrolment still succeeds and returns the student (201, identity back)",
  c.status === 201 && c.data?.programId === `${P}col-prog-a` && c.data?.termNumber === 1,
  `HTTP ${c.status} programId=${c.data?.programId} term=${c.data?.termNumber}`
);
const cRows = c.data?.id ? await feeRowsOf(c.data.id) : [];
check("C: the college student carries NO school fee rows", cRows.length === 0, describeRows(cRows));
check(
  "C: no school fee setting was created for the college tenant",
  (await feeSettingOf(collegeSchoolId)).length === cSettingBefore,
  `${cSettingBefore} before / ${(await feeSettingOf(collegeSchoolId)).length} after`
);
// the cross-check: a caller that FORGETS the college identity still raises nothing
const c2 = await post("/api/students", { name: `ZF C2 ${stamp}`, admissionNo: `ZF-C2-${stamp}`, createFees: true, createGuardian: false }, collegeAdmin);
if (c2.data?.id) createdStudents.push({ id: c2.data.id, cookie: collegeAdmin });
const c2Rows = c2.data?.id ? await feeRowsOf(c2.data.id) : [];
check(
  "C: even without the identity, a COLLEGE tenant raises no school default (the institutionType cross-check)",
  c2.status === 201 && c2Rows.length === 0,
  `HTTP ${c2.status} rows: ${describeRows(c2Rows)}`
);
check(
  "C: that cross-check left no fee setting either",
  (await feeSettingOf(collegeSchoolId)).length === cSettingBefore,
  `${(await feeSettingOf(collegeSchoolId)).length} doc(s)`
);

/* --- D. a BOTH tenant: the school half keeps today's behaviour ----------- */
console.log("\n### D. BOTH tenant");
const bothClassRes = await post("/api/classes", { name: `ZF Both Class ${stamp}` }, bothAdmin);
bothClassId = bothClassRes.data?.id || null;
const d = await post("/api/students", { name: `ZF D ${stamp}`, admissionNo: `ZF-D-${stamp}`, classId: bothClassId, createFees: true }, bothAdmin);
if (d.data?.id) createdStudents.push({ id: d.data.id, cookie: bothAdmin });
const dRows = d.data?.id ? await feeRowsOf(d.data.id) : [];
check(
  "D: a BOTH tenant's class student still gets the two school rows",
  d.status === 201 && hasDefaultPair(dRows),
  `HTTP ${d.status} class ${bothClassId ? "created" : "MISSING"} ${describeRows(dRows)}`
);
const bothSettingAfterClass = (await feeSettingOf(bothSchoolId))[0] || null;
bothFeeSettingCreated = !!bothSettingAfterClass;
check(
  "D: the BOTH tenant's school half still raises its fee setting (1500 / 5000)",
  bothSettingAfterClass?.monthlyFee === DEFAULT_MONTHLY && bothSettingAfterClass?.admissionFee === DEFAULT_ADMISSION,
  `${bothSettingAfterClass?.monthlyFee} / ${bothSettingAfterClass?.admissionFee}`
);
const d2 = await post(
  "/api/students",
  { name: `ZF D2 ${stamp}`, admissionNo: `ZF-D2-${stamp}`, createFees: true, createGuardian: false, programId: `${P}both-prog`, termNumber: 1 },
  bothAdmin
);
if (d2.data?.id) createdStudents.push({ id: d2.data.id, cookie: bothAdmin });
check(
  "D: a BOTH tenant's program student still enrols (201, identity back)",
  d2.status === 201 && d2.data?.programId === `${P}both-prog`,
  `HTTP ${d2.status} programId=${d2.data?.programId}`
);
const d2Rows = d2.data?.id ? await feeRowsOf(d2.data.id) : [];
check("D: the BOTH tenant's program student gets NO school fee rows", d2Rows.length === 0, describeRows(d2Rows));
const bothSettingAfterProgram = (await feeSettingOf(bothSchoolId))[0] || null;
check(
  "D: the BOTH tenant's fee setting is unchanged by the program enrolment",
  bothSettingAfterProgram?.monthlyFee === bothSettingAfterClass?.monthlyFee &&
    bothSettingAfterProgram?.admissionFee === bothSettingAfterClass?.admissionFee &&
    bothSettingAfterProgram?.id === bothSettingAfterClass?.id,
  `${bothSettingAfterProgram?.monthlyFee} / ${bothSettingAfterProgram?.admissionFee}`
);

/* --- E. the gate stays intact, and a college enrolment writes nothing ---- */
console.log("\n### E. the college gate, and the school setting a college enrolment must not touch");
const e = await post("/api/students", { name: `ZF E ${stamp}`, admissionNo: `ZF-E-${stamp}`, createFees: true, programId: `${P}col-prog-a`, termNumber: 1 }, schoolAdmin);
check(
  "E: a SCHOOL tenant is still refused a program (403) and raises no fee row",
  e.status === 403 && !e.data?.id,
  `HTTP ${e.status} ${e.error || ""}`
);
const demoSettingNow = (await feeSettingOf(demoSchoolId))[0] || null;
check(
  "E: the college enrolments created no fee setting and changed no school fee setting",
  demoSettingNow?.monthlyFee === demoSettingBefore?.monthlyFee &&
    demoSettingNow?.admissionFee === demoSettingBefore?.admissionFee &&
    demoSettingNow?.id === demoSettingBefore?.id &&
    (await feeSettingOf(collegeSchoolId)).length === cSettingBefore,
  `demo ${demoSettingNow?.monthlyFee}/${demoSettingNow?.admissionFee} (was ${demoSettingBefore?.monthlyFee}/${demoSettingBefore?.admissionFee})`
);

/* --------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
let leftovers = 0;
for (const { id, cookie } of createdStudents) {
  await req(`/api/students/${id}`, { cookie, method: "DELETE" });
  const rows = await feeRowsOf(id);
  const doc = await db.collection("students").doc(id).get();
  if (rows.length || doc.exists) {
    leftovers++;
    createdColleges.push(`${id} (${rows.length} fee row(s), student exists=${doc.exists})`);
  }
}
if (bothClassId) await db.collection("classes").doc(bothClassId).delete();
if (bothFeeSettingCreated) await db.collection("feeSettings").doc(bothSettingAfterClass.id).delete();
check(
  "every student this run created is gone, with its fee rows",
  leftovers === 0,
  leftovers ? createdColleges.join("; ") : `${createdStudents.length} student(s) removed`
);
const strays = await db.collection("fees").where("studentId", "in", [String(stamp)]).get();
check("no stray fee row is left for this run's stamp", strays.empty, `${strays.size} row(s)`);

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : "✅ ENROLMENT FEES OK — a college enrolment raises no school default; school tenants are unchanged"}`);
process.exit(failures ? 1 : 0);
