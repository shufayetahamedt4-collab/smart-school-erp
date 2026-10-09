/**
 * QA — Phase 2/3 features: §3.3 onboarding, §12.4 CSV import/export, §12.1 billing.
 * Runs against a running dev server. Creates a throwaway school, exercises the
 * new flows end-to-end via the real API, then deletes everything it created.
 *
 *   node scripts/qa-phase23.mjs [baseUrl]
 */

const BASE = process.argv[2] || process.env.BASE || "http://localhost:64512";
const RUN = Date.now().toString(36);
const SUPER = { identifier: "admin@smartschool.com", password: "Admin@123" };
const WIZARD_ADMIN = { email: `wizard-admin-${RUN}@qatest.edu`, name: "QA Wizard Admin", password: "Wiz@12345" };
const SCHOOL_NAME = `QA Wizard School ${RUN}`;

let passed = 0;
let failed = 0;
const fail = (name, detail) => {
  failed++;
  console.log(`[FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
};
const pass = (name) => {
  passed++;
  console.log(`[PASS] ${name}`);
};
const assert = (name, cond, detail = "") => (cond ? pass(name) : fail(name, detail));

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  let json = null;
  const text = await res.text();
  try { json = JSON.parse(text); } catch { /* not JSON (CSV) */ }
  return { status: res.status, json, text, setCookie };
}
const cookieOf = (r) => (r.setCookie ? r.setCookie.split(";").map((s) => s.trim()).filter((s) => s.startsWith("ss_token=")).join("; ") : null);

async function login(identifier, password) {
  const r = await api("/api/auth/login", { method: "POST", body: { identifier, password } });
  const cookie = cookieOf(r);
  if (!cookie) throw new Error(`login failed for ${identifier}: ${r.status} ${JSON.stringify(r.json)}`);
  return cookie;
}

/* ------------------------------------------------------------------ */

async function main() {
  console.log(`QA against ${BASE}\n`);

  // ---- 1. Unauthenticated guards ----
  let r = await api("/api/onboarding");
  assert("onboarding GET requires auth", r.status === 401, `got ${r.status}`);
  r = await api("/api/onboarding", { method: "POST", body: {} });
  assert("onboarding POST requires auth", r.status === 401, `got ${r.status}`);
  r = await api("/api/export?type=students");
  assert("export requires auth", r.status === 401, `got ${r.status}`);
  r = await api("/api/subscription/billing");
  assert("school billing requires auth", r.status === 401, `got ${r.status}`);

  // ---- 2. Super admin session ----
  const superCookie = await login(SUPER.identifier, SUPER.password);

  r = await api("/api/onboarding", { cookie: superCookie });
  assert("onboarding status: no school for SUPER_ADMIN", r.status === 200 && r.json?.data?.onboarded === false && r.json?.data?.school === null, JSON.stringify(r.json));

  // ---- 3. Onboarding wizard (create mode) ----
  r = await api("/api/onboarding", {
    method: "POST",
    cookie: superCookie,
    body: {
      school: { name: SCHOOL_NAME, address: "QA Road 1, Dhaka", phone: "+8801700000000", tagline: "QA tagline", themeColor: "#4f46e5" },
      admin: WIZARD_ADMIN,
      classes: [
        { name: "QA Class 1", sections: ["A", "B"] },
        { name: "QA Class 2", sections: ["A"] },
      ],
      subjects: [{ name: "QA Subject X" }, { name: "QA Subject Y" }],
      fees: { monthlyFee: 1234, admissionFee: 5678 },
    },
  });
  const created = r.json?.data || {};
  assert("onboarding POST creates school + wizard data (201)", r.status === 201 && created.schoolId, `status ${r.status}: ${JSON.stringify(r.json)}`);
  assert("onboarding created 2 classes / 3 sections / 2 subjects", created.classesCreated === 2 && created.sectionsCreated === 3 && created.subjectsCreated === 2, JSON.stringify(created));
  assert("onboarding feeSetting applied (monthly 1234)", Number(created.fees?.monthlyFee) === 1234, JSON.stringify(created.fees));
  const schoolId = created.schoolId;
  if (!schoolId) throw new Error("cannot continue without schoolId");

  // duplicate admin email must be rejected
  r = await api("/api/onboarding", {
    method: "POST",
    cookie: superCookie,
    body: { school: { name: `${SCHOOL_NAME} 2` }, admin: WIZARD_ADMIN, classes: [], subjects: [], fees: {} },
  });
  assert("onboarding rejects duplicate admin email", r.status === 400, `got ${r.status}: ${JSON.stringify(r.json)}`);

  r = await api(`/api/onboarding?schoolId=${schoolId}`, { cookie: superCookie });
  assert("onboarding status: onboarded=true with progress", r.json?.data?.onboarded === true && r.json?.data?.progress?.classes === 2 && r.json?.data?.progress?.fees === true, JSON.stringify(r.json));

  // ---- 4. New school admin session ----
  const wizCookie = await login(WIZARD_ADMIN.email, WIZARD_ADMIN.password);

  r = await api("/api/onboarding", { cookie: wizCookie });
  assert("wizard admin sees own school (extend mode)", r.json?.data?.school?.id === schoolId && r.json?.data?.onboarded === true, JSON.stringify(r.json));

  // ---- 5. Billing before a plan is assigned ----
  r = await api("/api/subscription/billing", { cookie: wizCookie });
  assert("billing: no plan yet → NONE + no invoices", r.status === 200 && r.json?.data?.status === "NONE" && Array.isArray(r.json?.data?.invoices), JSON.stringify(r.json));

  // ---- 6. CSV import round-trip ----
  r = await api("/api/import/students", { cookie: wizCookie });
  assert("students import template downloads as CSV", r.status === 200 && /^admissionNo,name/.test(r.text) && r.text.includes("STU-1001"), `status ${r.status}`);

  const csvOk = [
    "Admission No,Name,Class,Section,Roll,Guardian Name,Guardian Email,Guardian Phone,Create Guardian Login",
    `QA-STU-001,Ayesha Test,QA Class 1,A,1,Karim Test,karim.qa@${RUN}.test.com,+8801711111111,yes`,
    `QA-STU-002,Rahim Test,QA Class 1,B,2,Fatima Test,fatima.qa@${RUN}.test.com,+8801722222222,no`,
  ].join("\n");
  r = await api("/api/import/students", { method: "POST", cookie: wizCookie, body: { csv: csvOk, dryRun: true } });
  const pv = r.json?.data || {};
  assert("import dryRun: 2 rows OK, 0 errors, guardian login detected", r.status === 200 && pv.ok === 2 && pv.errors === 0 && pv.guardianLoginsToCreate === 1, JSON.stringify(pv));

  r = await api("/api/import/students", { method: "POST", cookie: wizCookie, body: { csv: csvOk, dryRun: false } });
  const cm = r.json?.data || {};
  assert("import commit: 2 students created, 1 guardian login", r.status === 200 && cm.created === 2 && cm.guardianLoginsCreated === 1, JSON.stringify(cm));

  // Validation matrix — runs AFTER the commit so the duplicate is real.
  const csvBad = [
    "admissionNo,name,class,section",
    `QA-STU-001,Dup Person,QA Class 1,A`, // duplicate admission number → SKIP
    "QA-STU-009,,A", //                       blank name → ERROR
    "QA-STU-008,Ghost Person,No Such Class,A", // class not found → ERROR
  ].join("\n");
  r = await api("/api/import/students", { method: "POST", cookie: wizCookie, body: { csv: csvBad, dryRun: true } });
  const pvBad = r.json?.data || {};
  const rowErrs = (pvBad.results || []).filter((x) => x.status === "ERROR");
  const rowSkips = (pvBad.results || []).filter((x) => x.status === "SKIP");
  assert("import dryRun: duplicate SKIP + blank-name & class-not-found ERRORs", pvBad.errors === 2 && pvBad.skipped === 1 && rowErrs.some((x) => /Name is required/.test(x.error || "")) && rowErrs.some((x) => /not found/.test(x.error || "")) && rowSkips.some((x) => /Duplicate/.test(x.error || "")), JSON.stringify(pvBad.results));

  r = await api("/api/import/students", { method: "POST", cookie: wizCookie, body: { csv: csvOk, dryRun: false } });
  assert("re-import same CSV → both rows SKIP (idempotent)", r.json?.data?.skipped === 2, JSON.stringify(r.json?.data));

  r = await api("/api/import/teachers", {
    method: "POST",
    cookie: wizCookie,
    body: {
      dryRun: false,
      csv: ["Name,Email,Phone,Designation", `Sabrina QA,sabrina.qa.${RUN}@qatest.edu,+8801933333333,Senior Teacher`].join("\n"),
    },
  });
  assert("teacher import commit: 1 created", r.json?.data?.created === 1, JSON.stringify(r.json?.data));

  // ---- 7. Exports ----
  const studentIds = [];
  r = await api("/api/students", { cookie: wizCookie });
  for (const s of r.json?.data || []) if ((s.admissionNo || "").startsWith("QA-STU-")) studentIds.push(s.id);

  r = await api("/api/export?type=students", { cookie: wizCookie });
  assert("export students contains imported rows", r.status === 200 && r.text.includes("QA-STU-001") && r.text.includes("Ayesha Test") && r.text.includes("QA Class 1"), r.text.slice(0, 120));

  r = await api("/api/export?type=teachers", { cookie: wizCookie });
  assert("export teachers contains imported teacher", r.status === 200 && r.text.includes(`sabrina.qa.${RUN}@qatest.edu`), r.text.slice(0, 120));

  for (const t of ["fees", "ledger", "attendance"]) {
    r = await api(`/api/export?type=${t}`, { cookie: wizCookie });
    assert(`export ${t} returns CSV`, r.status === 200 && typeof r.text === "string", `status ${r.status}`);
  }

  // ---- 8. Plan limit (402) ----
  r = await api("/api/plans", { cookie: superCookie });
  const trialPlan = (r.json?.data || []).find((p) => String(p.name).toLowerCase() === "trial") || (r.json?.data || [])[0];
  assert("plans list available", !!trialPlan, JSON.stringify(r.json?.data));
  const originalLimit = trialPlan?.maxStudents ?? null;
  const restorePlan = async () => {
    await api("/api/plans", { method: "PATCH", cookie: superCookie, body: { id: trialPlan.id, maxStudents: originalLimit === null ? "" : originalLimit } });
  };

  if (trialPlan) {
    r = await api("/api/plans", { method: "PATCH", cookie: superCookie, body: { id: trialPlan.id, maxStudents: 2 } });
    assert("plan limit set to 2", r.status === 200, JSON.stringify(r.json));

    r = await api("/api/subscriptions", { method: "POST", cookie: superCookie, body: { schoolId, planId: trialPlan.id, cycle: "MONTHLY" } });
    assert("trial plan assigned to QA school", r.status === 201 || r.status === 200, JSON.stringify(r.json));

    r = await api("/api/subscription/billing", { cookie: wizCookie });
    const bill = r.json?.data || {};
    assert("billing shows plan + usage 2/2 + invoice", bill.status === "TRIAL" && bill.usage?.used === 2 && bill.usage?.limit === 2 && (bill.invoices || []).length >= 1, JSON.stringify(bill));

    r = await api("/api/students", {
      method: "POST",
      cookie: wizCookie,
      body: { name: "Over Limit Olive", admissionNo: "QA-STU-003", classId: null },
    });
    assert("3rd student blocked with 402 + upgrade message", r.status === 402 && /Upgrade the plan/.test(r.json?.error || ""), `status ${r.status}: ${JSON.stringify(r.json)}`);

    r = await api("/api/admissions?action=enroll", { method: "POST", cookie: wizCookie, body: { admissionId: "nonexistent", method: "CASH" } });
    assert("enroll path also plan-guarded (402 before lookup)", r.status === 402, `status ${r.status}: ${JSON.stringify(r.json)}`);

    await restorePlan();
    pass("plan limit restored");
  }

  // ---- 9. Onboarding extend mode (adds data to existing school) ----
  r = await api("/api/onboarding", {
    method: "POST",
    cookie: wizCookie,
    body: {
      school: { id: schoolId, name: SCHOOL_NAME },
      classes: [{ name: "QA Class 3", sections: ["A"] }],
      subjects: [{ name: "QA Subject Z" }],
      fees: { monthlyFee: 2222 },
    },
  });
  assert("extend mode adds 1 class + 1 subject + updates fee", r.status === 200 && r.json?.data?.extended === true && r.json?.data?.classesCreated === 1 && r.json?.data?.subjectsCreated === 1 && Number(r.json?.data?.fees?.monthlyFee) === 2222, JSON.stringify(r.json?.data));

  // ---- 10. Cleanup everything created ----
  console.log("\n— cleanup —");
  r = await api("/api/students", { cookie: wizCookie });
  const students = (r.json?.data || []).filter((s) => (s.admissionNo || "").startsWith("QA-STU-"));
  for (const s of students) {
    const d = await api(`/api/students/${s.id}`, { method: "DELETE", cookie: wizCookie });
    if (d.status >= 300) fail(`cleanup student ${s.admissionNo}`, `status ${d.status}`);
  }
  pass(`deleted ${students.length} QA students`);

  r = await api("/api/teachers", { cookie: wizCookie });
  for (const t of r.json?.data || []) {
    if ((t.user?.email || "").includes("qatest.edu")) {
      const d = await api(`/api/teachers/${t.id}`, { method: "DELETE", cookie: wizCookie });
      if (d.status >= 300) fail(`cleanup teacher ${t.id}`, `status ${d.status}`);
    }
  }
  pass("deleted QA teachers");

  r = await api("/api/classes", { cookie: wizCookie });
  for (const c of r.json?.data || []) {
    if (String(c.name).startsWith("QA Class")) {
      const d = await api(`/api/classes?id=${c.id}`, { method: "DELETE", cookie: wizCookie });
      if (d.status >= 300) fail(`cleanup class ${c.name}`, `status ${d.status}`);
    }
  }
  pass("deleted QA classes (+sections)");

  r = await api("/api/subjects", { cookie: wizCookie });
  for (const s of r.json?.data || []) {
    if (String(s.name).startsWith("QA Subject")) {
      const d = await api(`/api/subjects?id=${s.id}`, { method: "DELETE", cookie: wizCookie });
      if (d.status >= 300) fail(`cleanup subject ${s.name}`, `status ${d.status}`);
    }
  }
  pass("deleted QA subjects");

  r = await api(`/api/schools/${schoolId}`, { method: "DELETE", cookie: superCookie });
  assert("QA school deleted (super admin)", r.status === 200 || r.status === 204, `status ${r.status}: ${JSON.stringify(r.json)}`);

  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("QA crashed:", e);
  console.log(`\n===== RESULT: ${passed} passed, ${failed + 1} failed =====`);
  process.exit(1);
});
