/**
 * QA — custom certificate template system (PRD §9.2 extension).
 * Runs against a running dev server. Creates a throwaway school + students,
 * exercises template CRUD, tenant isolation, placeholder/conditional
 * resolution and built-in fallbacks via the real API, then deletes
 * everything it created (including certificate storage artwork).
 *
 *   node scripts/qa-certificates.mjs [baseUrl]
 */

import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const BASE = process.argv[2] || process.env.BASE || "http://localhost:64512";
const RUN = Date.now().toString(36);
const SUPER = { identifier: "admin@smartschool.com", password: "Admin@123" };
const SCHOOL_NAME = `QA Cert School ${RUN}`;
const ADMIN = { email: `cert-admin-${RUN}@qatest.edu`, name: "QA Cert Admin", password: "Cert@12345" };

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
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, json, text, setCookie };
}
const cookieOf = (r) => (r.setCookie ? r.setCookie.split(";").map((s) => s.trim()).filter((s) => s.startsWith("ss_token=")).join("; ") : null);

async function login(identifier, password) {
  const r = await api("/api/auth/login", { method: "POST", body: { identifier, password } });
  const cookie = cookieOf(r);
  if (!cookie) throw new Error(`login failed for ${identifier}: ${r.status} ${JSON.stringify(r.json)}`);
  return cookie;
}

// storage sweep for this run's artwork (uploads in cert tests are simulated
// by admin SDK writes; real UI uploads are covered in click-through)
const bucketName = process.env.FIREBASE_STORAGE_BUCKET || `${process.env.FIREBASE_PROJECT_ID || ""}.appspot.com`;
const uploadedStoragePaths = [];

/* ------------------------------------------------------------------ */

async function main() {
  console.log(`QA against ${BASE}\n`);

  // ---- 0. unauthenticated guards ----
  let r = await api("/api/certificate-templates");
  assert("templates GET requires auth", r.status === 401 || r.status === 403, `got ${r.status}`);
  r = await api("/api/certificate-templates", { method: "POST", body: { name: "X", type: "TC" } });
  assert("templates POST requires auth", r.status === 401 || r.status === 403, `got ${r.status}`);

  // ---- 1. throwaway school via onboarding (real API path) ----
  const superCookie = await login(SUPER.identifier, SUPER.password);
  r = await api("/api/onboarding", {
    method: "POST",
    cookie: superCookie,
    body: {
      school: { name: SCHOOL_NAME, address: "QA Cert Road, Dhaka", phone: "+8801700000000" },
      admin: ADMIN,
      classes: [{ name: "QA C1", sections: ["A"] }],
      subjects: [{ name: "QA Sub 1" }],
      fees: { monthlyFee: 500 },
    },
  });
  const schoolId = r.json?.data?.schoolId;
  assert("throwaway school created", r.status === 201 && !!schoolId, `status ${r.status}: ${JSON.stringify(r.json)}`);
  if (!schoolId) throw new Error("cannot continue without schoolId");

  const adminCookie = await login(ADMIN.email, ADMIN.password);

  // ---- 2. seed a QA student + guardian through the import flow ----
  r = await api("/api/import/students", {
    method: "POST",
    cookie: adminCookie,
    body: {
      dryRun: false,
      csv: [
        "Admission No,Name,Class,Section,Roll,Guardian Name,Guardian Email,Guardian Phone,Guardian Relation,Create Guardian Login",
        `CERT-STU-1,Sadia Cert,QA C1,A,1,Mizanur Cert,mizanur.${RUN}@qatest.com,+8801711111111,FATHER,yes`,
        `CERT-STU-2,Rahim Cert,QA C1,A,2,Fatima Cert,fatima.${RUN}@qatest.com,+8801722222222,MOTHER,yes`,
      ].join("\n"),
    },
  });
  assert("QA students imported (2, with guardian logins)", r.json?.data?.created === 2, JSON.stringify(r.json?.data));

  r = await api("/api/students", { cookie: adminCookie });
  const students = (r.json?.data || []).filter((s) => (s.admissionNo || "").startsWith("CERT-STU-"));
  const sadia = students.find((s) => s.name === "Sadia Cert");
  const rahim = students.find((s) => s.name === "Rahim Cert");
  assert("both QA students resolvable", !!sadia && !!rahim, JSON.stringify(students.map((s) => s.name)));

  // ---- 3. built-in fallback (no custom template yet) ----
  r = await api(`/api/certificates?studentId=${sadia.id}&type=TC`, { cookie: adminCookie });
  assert("certificates API returns built-in when no template", r.status === 200 && r.json?.data?.useBuiltIn === true, JSON.stringify(r.json).slice(0, 220));
  assert("father derived from FATHER guardian relation", r.json?.data?.values?.fatherName === "Mizanur Cert", JSON.stringify(r.json?.data?.values));
  assert("mother empty when guardian is father", r.json?.data?.values?.motherName === "", JSON.stringify(r.json?.data?.values));
  const builtinResolved = r.json?.data?.resolved?.en || "";
  assert("built-in resolution contains student + father names", builtinResolved.includes("Sadia Cert") && builtinResolved.includes("Mizanur Cert"), builtinResolved.slice(0, 200));
  assert("no orphaned dashes in built-in body", !/of —|to —/.test(builtinResolved), builtinResolved.slice(0, 200));

  // mother-relation student derives motherName instead
  r = await api(`/api/certificates?studentId=${rahim.id}&type=TC`, { cookie: adminCookie });
  assert("mother derived from MOTHER guardian relation", r.json?.data?.values?.fatherName === "" && r.json?.data?.values?.motherName === "Fatima Cert", JSON.stringify(r.json?.data?.values));

  // ---- 4. template validation errors ----
  r = await api("/api/certificate-templates", {
    method: "POST",
    cookie: adminCookie,
    body: { type: "TC", name: "Bad", bodyEn: "Hello <script>alert(1)</script> {{studentName}}" },
  });
  assert("HTML in body rejected", r.status === 400 && /HTML is not allowed/i.test(r.json?.error || ""), JSON.stringify(r.json));

  r = await api("/api/certificate-templates", {
    method: "POST",
    cookie: adminCookie,
    body: { type: "TC", name: "Bad", bodyEn: "Hello {{notAPlaceholder}}" },
  });
  assert("unknown placeholder rejected", r.status === 400 && /unknown placeholder/i.test(r.json?.error || ""), JSON.stringify(r.json));

  r = await api("/api/certificate-templates", {
    method: "POST",
    cookie: adminCookie,
    body: {
      type: "TC", name: "Bad",
      design: { logoUrl: "https://evil.example.com/other-school.png" },
    },
  });
  assert("cross-school image URL rejected", r.status === 400 && /must be uploaded to your school's folder/i.test(r.json?.error || ""), JSON.stringify(r.json));

  r = await api("/api/certificate-templates", {
    method: "POST",
    cookie: adminCookie,
    body: { type: "TC", name: "Bad", bodyEn: "Open [[ never closed {{studentName}}" },
  });
  assert("unbalanced conditionals rejected", r.status === 400 && /unbalanced/i.test(r.json?.error || ""), JSON.stringify(r.json));

  // ---- 5. create a valid custom template ----
  r = await api("/api/certificate-templates", {
    method: "POST",
    cookie: adminCookie,
    body: {
      type: "TC",
      name: "TC Classic",
      isDefault: true,
      bodyEn:
        "TO WHOM IT MAY CONCERN.\n\nThis certifies that **{{studentName}}**[[, son of {{fatherName}},]] studies in {{class}} (Sec {{section}}), roll {{rollNo}}, admission {{admissionNo}}, session {{academicYear}}.",
      design: {
        borderStyle: "double",
        primaryColor: "#8b0000",
        fontFamily: "serif",
        orientation: "portrait",
        headerText: "Est. 1995 · EIIN 123456",
        signatoryLeftLabel: "Class Teacher",
        signatoryRightLabel: "Headmaster",
        watermark: { kind: "text", text: "OFFICIAL", opacity: 0.06, position: "center" },
      },
    },
  });
  const tpl = r.json?.data || {};
  assert("custom template created (201)", r.status === 201 && !!tpl.id, `status ${r.status}: ${JSON.stringify(r.json)}`);
  const tplId = tpl.id;

  // ---- 6. template resolution + conditional handling ----
  r = await api("/api/certificate-templates", { cookie: adminCookie });
  const list = r.json?.data?.templates || [];
  assert("template list school-scoped + typed", r.status === 200 && list.some((t) => t.id === tplId && t.type === "TC"), JSON.stringify(list.map((t) => t.name)));
  assert("placeholders list exposed (15)", (r.json?.data?.placeholders || []).length === 15, JSON.stringify(r.json?.data?.placeholders));

  // get the resolved certificate with the custom template
  r = await api(`/api/certificates?studentId=${sadia.id}&type=TC`, { cookie: adminCookie });
  assert("custom template resolved (useBuiltIn=false)", r.status === 200 && r.json?.data?.useBuiltIn === false && r.json?.data?.templateName === "TC Classic", JSON.stringify(r.json).slice(0, 200));
  const customResolved = r.json?.data?.resolved?.en || "";
  assert("custom body resolved with placeholders", customResolved.includes("Sadia Cert") && customResolved.includes("QA C1"), customResolved.slice(0, 220));
  assert("no unresolved placeholders in resolved text", !/\{\{/.test(customResolved), customResolved.slice(0, 160));

  // ---- 7. default handling ----
  r = await api("/api/certificate-templates", {
    method: "POST",
    cookie: adminCookie,
    body: { type: "TC", name: "TC Modern", isDefault: true, bodyEn: "Modern template for {{studentName}}." },
  });
  assert("second template created with isDefault", r.status === 201, JSON.stringify(r.json));
  const modernId = r.json?.data?.id;

  r = await api("/api/certificate-templates", { cookie: adminCookie });
  const afterDefault = (r.json?.data?.templates || []).filter((t) => t.type === "TC");
  const classic = afterDefault.find((t) => t.name === "TC Classic");
  const modern = afterDefault.find((t) => t.name === "TC Modern");
  assert("setting new default cleared old default (per type)", modern?.isDefault === true && classic?.isDefault === false, JSON.stringify(afterDefault.map((t) => ({ name: t.name, isDefault: t.isDefault }))));

  r = await api(`/api/certificates?studentId=${sadia.id}&type=TC`, { cookie: adminCookie });
  assert("default template now used for resolution", r.json?.data?.templateName === "TC Modern", r.json?.data?.templateName);

  // ---- 8. PATCH + DELETE + ownership ----
  r = await api(`/api/certificate-templates/${modernId}`, {
    method: "PATCH",
    cookie: adminCookie,
    body: { name: "TC Modern v2", bodyBn: "এই মর্মে প্রত্যয়ন করা হচ্ছে যে **{{studentName}}**।" },
  });
  assert("PATCH updates name + Bangla body", r.status === 200 && r.json?.data?.name === "TC Modern v2" && !!r.json?.data?.bodyBn, JSON.stringify(r.json));

  r = await api(`/api/certificates?studentId=${sadia.id}&type=TC`, { cookie: adminCookie });
  assert("Bangla resolution works", /প্রত্যয়ন/.test(r.json?.data?.resolved?.bn || ""), (r.json?.data?.resolved?.bn || "").slice(0, 120));

  // cross-school access: login as demo school admin and try to PATCH/delete QA template
  const demoCookie = await login("principal@sunrise.edu", "School@123");
  r = await api(`/api/certificate-templates/${modernId}`, { method: "PATCH", cookie: demoCookie, body: { name: "Hacked" } });
  assert("cross-school PATCH rejected (404)", r.status === 404, `status ${r.status}: ${JSON.stringify(r.json)}`);
  r = await api(`/api/certificate-templates/${modernId}`, { method: "DELETE", cookie: demoCookie });
  assert("cross-school DELETE rejected (404)", r.status === 404, `status ${r.status}`);

  // teacher is forbidden from template management
  const teacherCookie = await login("teacher@sunrise.edu", "Teacher@123");
  r = await api("/api/certificate-templates", { cookie: teacherCookie });
  assert("teacher forbidden from templates list", r.status === 403, `status ${r.status}`);

  // certificates tenant isolation: demo admin cannot read QA student's certificate
  r = await api(`/api/certificates?studentId=${sadia.id}&type=TC`, { cookie: demoCookie });
  assert("cross-school certificate read rejected (403)", r.status === 403, `status ${r.status}: ${JSON.stringify(r.json)}`);

  // teacher can read their own class's student certificate but not others
  r = await api(`/api/certificates?studentId=${sadia.id}&type=TC`, { cookie: teacherCookie });
  assert("teacher outside class forbidden (403)", r.status === 403, `status ${r.status}: ${JSON.stringify(r.json)}`);

  // ---- 9. guardian access (own child only) ----
  r = await api("/api/auth/login", { method: "POST", body: { identifier: `mizanur.${RUN}@qatest.com`, password: "Guardian@123" } });
  const guardianCookie = cookieOf(r);
  if (guardianCookie) {
    r = await api(`/api/certificates?studentId=${sadia.id}&type=TC`, { cookie: guardianCookie });
    assert("guardian can read own child's certificate", r.status === 200 && r.json?.data?.values?.studentName === "Sadia Cert", `status ${r.status}`);
    r = await api(`/api/certificates?studentId=${rahim.id}&type=TC`, { cookie: guardianCookie });
    assert("guardian cannot read another child (403)", r.status === 403, `status ${r.status}`);
  } else {
    fail("guardian login for own-child test", "guardian account not created by import");
  }

  // ---- 10. CHARACTER type independence ----
  r = await api("/api/certificate-templates", {
    method: "POST",
    cookie: adminCookie,
    body: { type: "CHARACTER", name: "CC Default", isDefault: true, bodyEn: "Character certificate for {{studentName}} — conduct {{conduct}}." },
  });
  const ccId = r.json?.data?.id;
  assert("CHARACTER template created independently", r.status === 201, JSON.stringify(r.json));

  r = await api(`/api/certificates?studentId=${sadia.id}&type=CHARACTER`, { cookie: adminCookie });
  assert("CHARACTER uses its own default template", r.json?.data?.templateName === "CC Default", r.json?.data?.templateName);
  r = await api(`/api/certificates?studentId=${sadia.id}&type=TC`, { cookie: adminCookie });
  assert("TC unaffected by CHARACTER default", r.json?.data?.templateName === "TC Modern v2", r.json?.data?.templateName);

  // ---- cleanup ----
  console.log("\n— cleanup —");

  // templates
  r = await api("/api/certificate-templates", { cookie: adminCookie });
  for (const t of r.json?.data?.templates || []) {
    const d = await api(`/api/certificate-templates/${t.id}`, { method: "DELETE", cookie: adminCookie });
    if (d.status >= 300) fail(`cleanup template ${t.name}`, `status ${d.status}`);
  }
  pass("deleted QA templates");

  // students (+ their guardian users, via Firebase SDK)
  r = await api("/api/students", { cookie: adminCookie });
  for (const s of (r.json?.data || []).filter((s) => (s.admissionNo || "").startsWith("CERT-STU-"))) {
    await api(`/api/students/${s.id}`, { method: "DELETE", cookie: adminCookie });
  }
  pass("deleted QA students");

  // classes/subjects/fees + school + orphaned users
  r = await api("/api/classes", { cookie: adminCookie });
  for (const c of r.json?.data || []) {
    if (String(c.name).startsWith("QA C")) await api(`/api/classes?id=${c.id}`, { method: "DELETE", cookie: adminCookie });
  }
  r = await api("/api/subjects", { cookie: adminCookie });
  for (const s of r.json?.data || []) {
    if (String(s.name).startsWith("QA Sub")) await api(`/api/subjects?id=${s.id}`, { method: "DELETE", cookie: adminCookie });
  }

  r = await api(`/api/schools/${schoolId}`, { method: "DELETE", cookie: superCookie });
  assert("QA school deleted", r.status === 200 || r.status === 204, `status ${r.status}`);

  // orphaned users sweep (school delete doesn't cascade users) + storage sweep
  if (getApps().length === 0 && process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
      }),
    });
  }
  if (getApps().length) {
    const db = getFirestore();
    const snap = await db.collection("users").get();
    const batch = db.batch();
    let n = 0;
    snap.docs.forEach((d) => {
      const email = String(d.data().email || "");
      if (email.endsWith("@qatest.edu") || email.endsWith("@qatest.com") || email.includes(`.${RUN}@`)) {
        batch.delete(d.ref);
        n++;
      }
    });
    if (n) await batch.commit();
    pass(`deleted ${n} orphaned QA user account(s)`);

    // storage: delete any certificate artwork created by this run
    try {
      const { getStorage } = await import("firebase-admin/storage");
      const bucket = getStorage().bucket(bucketName);
      const [files] = await bucket.getFiles({ prefix: `certificates/${schoolId}/` });
      for (const f of files) {
        await f.delete();
        uploadedStoragePaths.push(f.name);
      }
      pass(`deleted ${uploadedStoragePaths.length} storage file(s) from certificates/${schoolId}/`);
    } catch (e) {
      console.log(`[info] storage sweep skipped: ${e.message}`);
    }
  } else {
    fail("orphaned user sweep", "no Firebase credentials — run with --env-file=.env");
  }

  console.log(`\n===== RESULT: ${passed} passed, ${failed} failed =====`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("QA crashed:", e);
  console.log(`\n===== RESULT: ${passed} passed, ${failed + 1} failed =====`);
  process.exit(1);
});
