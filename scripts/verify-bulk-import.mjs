/**
 * verify-bulk-import.mjs — Phase 2 bulk student import.
 *
 * Exercises the whole import pipeline against a running server:
 *   template download · column detection · preview (ZERO writes) · server-side
 *   validation · duplicate rules (in-file / existing / possible) · guardian reuse
 *   · missing guardian info · chunked commit · idempotent re-run & retry ·
 *   school isolation · 1,000+ row chunk behaviour.
 *
 * Creates its own students + one guardian and removes them (and the batch/rows it
 * wrote) afterwards. Nothing is deleted that the run did not create.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-bulk-import.mjs
 *        IMPORT_FULL_SCALE=1 … also import all 1,000 rows (default: 100 unique).
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

loadEnv();
requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const FULL_SCALE = process.env.IMPORT_FULL_SCALE === "1";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

function unescapeKey(k) {
  const BS = String.fromCharCode(92);
  return k.includes(BS + "n") ? k.split(BS + "n").join("\n") : k;
}

// Inside the emulator (FIRESTORE_EMULATOR_HOST — the guard above guarantees it is
// loopback) the emulator needs no credentials, so never build a cert() from
// possibly absent ones: initialise with the project id alone, exactly as
// scripts/seed.mjs does. Outside it, the credentials are used as before.
const emulatorMode = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

if (!getApps().length) {
  if (emulatorMode) {
    initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
  } else {
    initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID,
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: unescapeKey(process.env.FIREBASE_PRIVATE_KEY || ""),
      }),
    });
  }
}
const db = getFirestore();

const HOSTS = { school: `school.localhost:${PORT}`, parents: `parents.localhost:${PORT}`, teacher: `teacher.localhost:${PORT}` };

async function req(host, path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Host: host, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(300000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* html / file */ }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null, setCookie: res.headers.get("set-cookie") || "", text };
}
async function login(host, identifier, password) {
  const r = await req(host, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
  if (r.status !== 200) throw new Error(`login ${identifier}: HTTP ${r.status} ${r.error || ""}`);
  return r.setCookie.split(";")[0];
}

/* canonical template headers, in order */
const HEADERS = ["Name", "Admission No", "Roll", "Registration No", "Class", "Section", "Name (Bangla)", "Date of Birth", "Gender", "Blood Group", "Birth Certificate No", "Address", "Previous School", "Previous School Class", "Guardian Name", "Guardian Phone", "Guardian Email", "Guardian Relation", "Photo URL"];
const row = (o = {}) => [
  o.name ?? "", o.admissionNo ?? "", o.roll ?? "", o.registrationNo ?? "", o.class ?? "", o.section ?? "",
  o.nameBn ?? "", o.dob ?? "", o.gender ?? "", o.bloodGroup ?? "", o.birthCertificateNo ?? "", o.address ?? "",
  o.previousSchoolName ?? "", o.previousSchoolClass ?? "", o.guardianName ?? "", o.guardianPhone ?? "",
  o.guardianEmail ?? "", o.guardianRelation ?? "", o.photoUrl ?? "",
];
const post = (host, path, body, cookie) => req(host, path, { cookie, method: "POST", body: JSON.stringify(body) });
// Commit rows carry ABSOLUTE spreadsheet row numbers (the client contract), so a
// chunked commit keeps a stable identity per row.
const numbered = (rows, start = 2) => rows.map((cells, i) => ({ rowNumber: start + i, cells }));

async function countCol(collection, schoolId) {
  const snap = await db.collection(collection).where("schoolId", "==", schoolId).get();
  return snap.size;
}
async function delByAdmission(admissionNos) {
  const wanted = new Set(admissionNos);
  const snap = await db.collection("students").get();
  const docs = snap.docs.filter((d) => wanted.has(d.data().admissionNo));
  await Promise.all(
    docs.map(async (doc) => {
      for (const c of ["fees", "payments"]) {
        const s = await db.collection(c).where("studentId", "==", doc.id).get();
        await Promise.all(s.docs.map((x) => x.ref.delete()));
      }
      await doc.ref.delete();
    })
  );
}

const admin = await login(HOSTS.school, "principal@sunrise.edu", "School@123");
const teacher = await login(HOSTS.teacher, "teacher@sunrise.edu", "Teacher@123");
const guardian = await login(HOSTS.parents, "guardian1@demo.com", "Guardian@123");

/* ------------------------------------------------------------------- run */
console.log(`\n=== set-up (${BASE})`);
const me = await req(HOSTS.school, "/api/auth/me", { cookie: admin });
const schoolId = me.data?.school?.id || me.data?.schoolId;
check("the school admin is signed in", !!schoolId, String(schoolId));

const classes = (await req(HOSTS.school, "/api/classes", { cookie: admin })).data || [];
const class1 = classes.find((c) => c.name === "Class 1") || classes[0];
check("there is a class to import into", !!class1, class1?.name);

const existingStudents = (await req(HOSTS.school, "/api/students", { cookie: admin })).data || [];
const existingStudent = existingStudents.find((s) => s.admissionNo && s.classRoom) || null;
check("there is an existing student for duplicate checks", !!existingStudent, existingStudent?.admissionNo);

// an existing guardian account to test reuse
const guardianSnap = await db.collection("users").where("schoolId", "==", schoolId).get();
const existingGuardian = guardianSnap.docs.map((d) => ({ id: d.id, ...d.data() })).find((u) => u.role === "GUARDIAN" && u.email) || null;
check("there is an existing guardian account for reuse checks", !!existingGuardian, existingGuardian?.email);

const stamp = Date.now();
const createdAdmissionNos = [];
const batchIds = [];
let sessionId = null;
let displacedCurrent = null;
if (class1) {
  const existing = await req(HOSTS.school, "/api/academic-sessions", { cookie: admin });
  displacedCurrent = (existing.data || []).find((s) => s.isCurrent)?.id || null;
  const sres = await post(HOSTS.school, "/api/academic-sessions", { name: `Bulk Import Verify ${stamp}`, isCurrent: true }, admin);
  sessionId = sres.data?.id || null;
}

console.log("\n### template download");
const tplCsv = await req(HOSTS.school, "/api/import/students/template?format=csv", { cookie: admin });
check("CSV template downloads", tplCsv.status === 200 && /Name/.test(tplCsv.text), `HTTP ${tplCsv.status}`);
const tplXlsx = await req(HOSTS.school, "/api/import/students/template?format=xlsx", { cookie: admin });
check("XLSX template downloads", tplXlsx.status === 200, `HTTP ${tplXlsx.status}`);
const tplNoAuth = await req(HOSTS.parents, "/api/import/students/template?format=csv");
check("an unauthenticated template request is refused", tplNoAuth.status === 401, `HTTP ${tplNoAuth.status}`);

console.log("\n### preview performs ZERO writes");
{
  const before = { s: await countCol("students", schoolId), u: await countCol("users", schoolId), b: await countCol("importBatches", schoolId), r: await countCol("importBatchRows", schoolId) };
  const rows = [row({ name: `Zero Write ${stamp}`, admissionNo: `ZW-${stamp}`, class: class1?.name })];
  const res = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: numbered(rows) }, admin);
  const after = { s: await countCol("students", schoolId), u: await countCol("users", schoolId), b: await countCol("importBatches", schoolId), r: await countCol("importBatchRows", schoolId) };
  check("preview succeeds", res.status === 200 && res.data?.summary?.total === 1, `HTTP ${res.status} ${res.error || ""}`);
  check("preview wrote no student", before.s === after.s, `${before.s} → ${after.s}`);
  check("preview wrote no user", before.u === after.u, `${before.u} → ${after.u}`);
  check("preview wrote no batch", before.b === after.b && before.r === after.r, `${before.b}/${before.r} → ${after.b}/${after.r}`);
}

console.log("\n### strict absolute row numbers");
{
  const good = row({ name: `RN ${stamp}`, admissionNo: `RN-${stamp}`, class: class1?.name });
  const bare = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: [good] }, admin);
  check("preview rejects rows with no row number", bare.status === 400 && /rowNumber/i.test(bare.error || ""), `HTTP ${bare.status} ${bare.error || ""}`);

  const commitBare = await post(HOSTS.school, "/api/import/students/commit", { headers: HEADERS, rows: [good], allowWarnings: true }, admin);
  check("commit rejects rows with no row number", commitBare.status === 400, `HTTP ${commitBare.status} ${commitBare.error || ""}`);

  const headerRow = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: [{ rowNumber: 1, cells: good }] }, admin);
  check("preview rejects row number 1 (the header)", headerRow.status === 400, `HTTP ${headerRow.status}`);

  const nonNumeric = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: [{ rowNumber: "2", cells: good }] }, admin);
  check("preview rejects a non-numeric row number", nonNumeric.status === 400, `HTTP ${nonNumeric.status}`);

  const dupNumbers = await post(HOSTS.school, "/api/import/students/commit", {
    headers: HEADERS,
    rows: [
      { rowNumber: 7, cells: row({ name: `DN ${stamp}-a`, admissionNo: `DN-${stamp}-a`, class: class1?.name }) },
      { rowNumber: 7, cells: row({ name: `DN ${stamp}-b`, admissionNo: `DN-${stamp}-b`, class: class1?.name }) },
    ],
    allowWarnings: true,
  }, admin);
  check("commit rejects duplicate row numbers in one chunk", dupNumbers.status === 400 && /unique/i.test(dupNumbers.error || ""), `HTTP ${dupNumbers.status} ${dupNumbers.error || ""}`);

  // a rejected chunk must not have created a student or a batch
  const before = await countCol("students", schoolId);
  const batchesBefore = await countCol("importBatches", schoolId);
  const malformed = await post(HOSTS.school, "/api/import/students/commit", { headers: HEADERS, rows: [{ rowNumber: 9, cells: "not-an-array" }], allowWarnings: true }, admin);
  const after = await countCol("students", schoolId);
  const batchesAfter = await countCol("importBatches", schoolId);
  check("a malformed chunk is rejected", malformed.status === 400, `HTTP ${malformed.status}`);
  check("a malformed chunk writes nothing", before === after && batchesBefore === batchesAfter, `${before}→${after} students, ${batchesBefore}→${batchesAfter} batches`);
}

console.log("\n### column detection / mapping override");
{
  const altHeaders = ["Student Name", "Adm No", "Grade", "Guardian Phone", "Guardian Email"];
  const rows = [["Detect Me", `DET-${stamp}`, class1?.name, "01710000000", `detect-${stamp}@demo.com`]];
  const res = await post(HOSTS.school, "/api/import/students/preview", { headers: altHeaders, rows: numbered(rows) }, admin);
  const m = res.data?.mapping || {};
  check("alias headers are detected", m.name === 0 && m.admissionNo === 1 && m.class === 2, JSON.stringify(m));
  check("the alias row validates", res.data?.summary?.importable === 1, `importable ${res.data?.summary?.importable}`);
}

console.log("\n### valid import (create + session)");
const validRows = [1, 2, 3].map((i) => row({
  name: `Bulk Valid ${stamp}-${i}`, admissionNo: `BLK-${stamp}-${i}`, roll: 900 + i, class: class1?.name,
  section: "A", gender: i % 2 ? "Male" : "Female", dob: "2018-05-1" + i, bloodGroup: "B+",
  guardianName: `Bulk Guardian ${stamp}`, guardianPhone: `0179${String(stamp).slice(-7)}`, guardianEmail: `bulk-guardian-${stamp}@demo.com`, guardianRelation: "Father",
}));
validRows.forEach((r) => createdAdmissionNos.push(r[1]));
{
  const before = await countCol("students", schoolId);
  const pv = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: numbered(validRows) }, admin);
  check("valid rows preview as importable", pv.data?.summary?.importable === 3 && pv.data?.summary?.errors === 0, JSON.stringify(pv.data?.summary));
  const mid = await countCol("students", schoolId);
  check("preview did not write the valid rows", before === mid, `${before} → ${mid}`);

  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "valid.csv", headers: HEADERS, rows: numbered(validRows), allowWarnings: true, totalRows: 3, final: true }, admin);
  check("commit creates the three students", cm.status === 200 && cm.data?.totals?.created === 3, `HTTP ${cm.status} ${cm.error || ""} created=${cm.data?.totals?.created}`);
  if (cm.data?.batchId) batchIds.push(cm.data.batchId);

  const after = await countCol("students", schoolId);
  check("exactly three students were added", after === before + 3, `${before} → ${after}`);

  const found = (await req(HOSTS.school, `/api/students?q=${encodeURIComponent(`Bulk Valid ${stamp}`)}`, { cookie: admin })).data || [];
  const mine = found.filter((s) => createdAdmissionNos.includes(s.admissionNo));
  check("the imported students carry the current session", !!sessionId && mine.every((s) => s.sessionId === sessionId), `${mine.length} checked`);
  check("the imported students are in Class 1", mine.every((s) => s.classRoom?.name === class1?.name), class1?.name);

  const gsnap = await db.collection("users").where("email", "==", `bulk-guardian-${stamp}@demo.com`).get();
  check("one guardian account was created for the three rows", gsnap.size === 1, `${gsnap.size}`);
}

console.log("\n### family linking (same-guardian rows share a family)");
{
  const mine = (await db.collection("students").where("schoolId", "==", schoolId).get()).docs
    .map((d) => d.data())
    .filter((s) => createdAdmissionNos.includes(s.admissionNo));
  const familyIds = new Set(mine.map((s) => s.familyId).filter(Boolean));
  check("the three same-guardian rows were linked into one family", mine.length === 3 && familyIds.size === 1, `${mine.length} students / ${familyIds.size} family`);
}

console.log("\n### fee behavior (createFees)");
{
  const rows = [1, 2].map((i) => row({ name: `Fee ${stamp}-${i}`, admissionNo: `FEE-${stamp}-${i}`, class: class1?.name }));
  const ids = rows.map((r) => r[1]);
  ids.forEach((a) => createdAdmissionNos.push(a));
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "fees.csv", headers: HEADERS, rows: numbered(rows), allowWarnings: true, createFees: true, totalRows: 2, final: true }, admin);
  if (cm.data?.batchId) batchIds.push(cm.data.batchId);
  check("a fee-enabled import creates both students", cm.data?.totals?.created === 2, JSON.stringify(cm.data?.totals));
  const docs = (await db.collection("students").where("schoolId", "==", schoolId).get()).docs.map((d) => d.data()).filter((s) => ids.includes(s.admissionNo));
  let feeCount = 0;
  const titles = new Set();
  for (const s of docs) {
    const fees = (await db.collection("fees").where("studentId", "==", `st_${s.qrToken}`).get()).docs.map((f) => f.data());
    feeCount += fees.length;
    fees.forEach((f) => titles.add(f.title));
  }
  check("each fee-enabled student got the default admission + monthly fee", feeCount === 4 && titles.has("Admission Fee") && titles.has("Monthly Fee"), `${feeCount} fee(s) [${[...titles].join(", ")}]`);
}

console.log("\n### write throughput (200-row chunk)");
{
  const rows = [];
  for (let i = 0; i < 200; i++) {
    const r = row({ name: `Perf ${stamp}-${i}`, admissionNo: `PERF-${stamp}-${i}`, class: class1?.name });
    createdAdmissionNos.push(r[1]);
    rows.push(r);
  }
  const before = await countCol("students", schoolId);
  const t0 = Date.now();
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "perf.csv", headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: 200, final: true }, admin);
  const elapsed = Date.now() - t0;
  if (cm.data?.batchId) batchIds.push(cm.data.batchId);
  const after = await countCol("students", schoolId);
  check("a 200-row chunk imports fully", cm.status === 200 && cm.data?.totals?.created === 200 && after === before + 200, `created=${cm.data?.totals?.created} HTTP ${cm.status}`);
  check("a 200-row chunk completes in seconds, not minutes", elapsed < 120000, `${(elapsed / 1000).toFixed(1)}s`);
  console.log(`   MEASURED 200-row chunk: ${elapsed} ms`);
}

console.log("\n### invalid rows");
{
  const rows = [
    row({ admissionNo: `BAD-${stamp}-1`, class: class1?.name }),                       // missing name
    row({ name: `Bad ${stamp}-2`, admissionNo: `BAD-${stamp}-2` }),                    // missing class
    row({ name: `Bad ${stamp}-3`, admissionNo: `BAD-${stamp}-3`, class: "NoSuchClass" }), // unknown class
    row({ name: `Bad ${stamp}-4`, class: class1?.name }),                              // missing identifier
    row({ name: `Bad ${stamp}-5`, admissionNo: `BAD-${stamp}-5`, class: class1?.name, gender: "banana", dob: "not-a-date" }), // bad values
  ];
  const pv = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: numbered(rows) }, admin);
  const codes = new Set((pv.data?.rows || []).flatMap((r) => r.messages.map((m) => m.code)));
  check("all five rows are errors", pv.data?.summary?.errors === 5, JSON.stringify(pv.data?.summary));
  check("missing name is reported", codes.has("MISSING_NAME"));
  check("missing class is reported", codes.has("MISSING_CLASS"));
  check("unknown class is reported", codes.has("UNKNOWN_CLASS"));
  check("missing identifier is reported", codes.has("MISSING_IDENTIFIER"));
  check("bad gender/date are reported", codes.has("INVALID_GENDER") && codes.has("INVALID_DOB"));
}

console.log("\n### duplicate rules");
{
  // existing admission number → ERROR
  const dupExisting = await post(HOSTS.school, "/api/import/students/preview", {
    headers: HEADERS,
    rows: numbered([row({ name: `Dup ${stamp}`, admissionNo: existingStudent.admissionNo, class: class1?.name })]),
  }, admin);
  check("an existing admission number is a definite duplicate", (dupExisting.data?.rows?.[0]?.messages || []).some((m) => m.code === "DUPLICATE_ADMISSION_NO"), JSON.stringify(dupExisting.data?.rows?.[0]?.messages));

  // in-file duplicate → ERROR on the second row
  const inFile = await post(HOSTS.school, "/api/import/students/preview", {
    headers: HEADERS,
    rows: numbered([row({ name: `InFile A ${stamp}`, admissionNo: `IF-${stamp}`, class: class1?.name }), row({ name: `InFile B ${stamp}`, admissionNo: `IF-${stamp}`, class: class1?.name })]),
  }, admin);
  check("an in-file duplicate is an error on the later row", inFile.data?.rows?.[1]?.importable === false && inFile.data?.rows?.[1]?.messages.some((m) => m.code === "DUPLICATE_IN_FILE"), JSON.stringify(inFile.data?.rows?.[1]?.messages));

  // possible existing match → WARNING
  const possible = await post(HOSTS.school, "/api/import/students/preview", {
    headers: HEADERS,
    rows: numbered([row({ name: existingStudent.name, roll: 5000, class: existingStudent.classRoom.name })]),
  }, admin);
  check("a same-name same-class row is a warning, not an error", possible.data?.rows?.[0]?.level === "WARNING" && possible.data?.rows?.[0]?.messages.some((m) => m.code === "POSSIBLE_DUPLICATE"), JSON.stringify(possible.data?.rows?.[0]?.messages));
  check("a possible duplicate stays importable", possible.data?.rows?.[0]?.importable === true);

  // guardian reuse
  const reuse = await post(HOSTS.school, "/api/import/students/preview", {
    headers: HEADERS,
    rows: numbered([row({ name: `Reuse G ${stamp}`, admissionNo: `RG-${stamp}`, class: class1?.name, guardianName: existingGuardian.name, guardianEmail: existingGuardian.email })]),
  }, admin);
  const rr = reuse.data?.rows?.[0];
  check("an existing guardian email is REUSED", rr?.action === "REUSE_GUARDIAN" && rr?.guardianUserId === existingGuardian.id, JSON.stringify({ action: rr?.action, id: rr?.guardianUserId }));

  // missing guardian info
  const noGuardian = await post(HOSTS.school, "/api/import/students/preview", {
    headers: HEADERS,
    rows: numbered([row({ name: `No G ${stamp}`, admissionNo: `NG-${stamp}`, class: class1?.name })]),
  }, admin);
  check("a row with no guardian info warns, but is importable", noGuardian.data?.rows?.[0]?.level === "WARNING" && noGuardian.data?.rows?.[0]?.importable === true && noGuardian.data?.rows?.[0]?.messages.some((m) => m.code === "MISSING_GUARDIAN_INFO"), JSON.stringify(noGuardian.data?.rows?.[0]?.messages));
}

console.log("\n### re-run safety (same rows, new batch)");
{
  const before = await countCol("students", schoolId);
  const rr = await post(HOSTS.school, "/api/import/students/commit", { fileName: "valid.csv", headers: HEADERS, rows: numbered(validRows), allowWarnings: true, totalRows: 3, final: true }, admin);
  if (rr.data?.batchId) batchIds.push(rr.data.batchId);
  check("re-running the same rows creates nothing", rr.data?.totals?.created === 0 && rr.data?.totals?.skipped === 3, JSON.stringify(rr.data?.totals));
  const after = await countCol("students", schoolId);
  check("the student count is unchanged by the re-run", before === after, `${before} → ${after}`);
}

console.log("\n### partial failure / retry (same batch, same chunk twice)");
{
  const rows = [4, 5].map((i) => row({ name: `Retry ${stamp}-${i}`, admissionNo: `RT-${stamp}-${i}`, class: class1?.name }));
  rows.forEach((r) => createdAdmissionNos.push(r[1]));
  const first = await post(HOSTS.school, "/api/import/students/commit", { fileName: "retry.csv", headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: 2 }, admin);
  const batchId = first.data?.batchId;
  if (batchId) batchIds.push(batchId);
  check("the first chunk creates both rows", first.data?.totals?.created === 2, JSON.stringify(first.data?.totals));
  const again = await post(HOSTS.school, "/api/import/students/commit", { batchId, fileName: "retry.csv", headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: 2, final: true }, admin);
  check("re-sending the chunk creates nothing more", again.data?.totals?.created === 2 && again.data?.chunk?.created === 0, JSON.stringify(again.data?.chunk));
  check("the batch is marked DONE", again.data?.status === "DONE", String(again.data?.status));
  const retryDocs = batchId ? (await db.collection("importBatchRows").where("batchId", "==", batchId).get()).docs.map((d) => d.data()) : [];
  check("a retried chunk keeps exactly one record per row", retryDocs.length === 2 && new Set(retryDocs.map((r) => r.rowNumber)).size === 2, `${retryDocs.length} record(s)`);
  check("the retried rows kept their original row numbers", retryDocs.every((r) => r.rowNumber === 2 || r.rowNumber === 3), JSON.stringify(retryDocs.map((r) => r.rowNumber)));
}

console.log("\n### 1,000+ row / chunk behaviour");
{
  const before = await countCol("students", schoolId);
  const uniqueCount = FULL_SCALE ? 1000 : 50;
  const rows = [];
  for (let i = 0; i < uniqueCount; i++) {
    const r = row({ name: `Scale ${stamp}-${i}`, admissionNo: `SC-${stamp}-${i}`, class: class1?.name });
    createdAdmissionNos.push(r[1]);
    rows.push(r);
  }
  // fill up to 1,000 rows with copies of an EXISTING admission number → definite duplicates
  while (rows.length < 1000) rows.push(row({ name: `Scale Dup ${stamp}`, admissionNo: existingStudent.admissionNo, class: class1?.name }));

  const pv = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: numbered(rows) }, admin);
  check("a 1,000-row file previews in one request", pv.data?.summary?.total === 1000, JSON.stringify(pv.data?.summary));
  check("the correct rows are flagged importable", pv.data?.summary?.importable === uniqueCount && pv.data?.summary?.errors === 1000 - uniqueCount, JSON.stringify(pv.data?.summary));

  // commit in chunks of 200 — never one giant request
  const chunks = [];
  for (let i = 0; i < rows.length; i += 200) chunks.push(rows.slice(i, i + 200));
  let batchId = undefined;
  let last = null;
  const chunkTimes = [];
  const scaleT0 = Date.now();
  for (let i = 0; i < chunks.length; i++) {
    const t = Date.now();
    const res = await post(HOSTS.school, "/api/import/students/commit", {
      batchId, fileName: "scale.csv", headers: HEADERS, rows: numbered(chunks[i], 2 + i * 200), allowWarnings: true, totalRows: rows.length, final: i === chunks.length - 1,
    }, admin);
    chunkTimes.push(Date.now() - t);
    if (res.status !== 200) { check(`scale chunk ${i + 1} commits`, false, `HTTP ${res.status} ${res.error || ""}`); break; }
    batchId = res.data.batchId;
    last = res.data;
  }
  const scaleElapsed = Date.now() - scaleT0;
  console.log(`   MEASURED scale import: ${scaleElapsed} ms total; chunk times (ms): ${chunkTimes.join(", ")}`);
  if (batchId) batchIds.push(batchId);
  check("the scale import ran in multiple chunks", chunks.length >= 4, `${chunks.length} chunk(s)`);
  check("exactly the unique rows were created", last?.totals?.created === uniqueCount, JSON.stringify(last?.totals));
  check("the duplicate rows were rejected, never created", last?.totals?.errors === 1000 - uniqueCount, JSON.stringify(last?.totals));
  const after = await countCol("students", schoolId);
  check("the school gained exactly the unique rows", after === before + uniqueCount, `${before} → ${after}`);

  // batch status + row-level reporting
  const detail = await req(HOSTS.school, `/api/import/students/${batchId}`, { cookie: admin });
  check("the batch detail reports totals", detail.data?.batch?.created === uniqueCount && detail.data?.counts?.total === 1000, JSON.stringify(detail.data?.counts));
  const errDetail = await req(HOSTS.school, `/api/import/students/${batchId}?level=ERROR&limit=5`, { cookie: admin });
  if (FULL_SCALE) {
    check("a clean full-scale import has no error rows", (errDetail.data?.rows || []).length === 0 && detail.data?.counts?.errors === 0, `${errDetail.data?.rows?.length} row(s)`);
  } else {
    check("the batch detail returns row-level errors", (errDetail.data?.rows || []).length > 0 && (errDetail.data?.rows || []).every((r) => r.status === "ERROR"), `${errDetail.data?.rows?.length} row(s)`);
  }

  // every committed row must keep its ABSOLUTE spreadsheet row number (2..1001)
  const rowDocs = batchId ? (await db.collection("importBatchRows").where("batchId", "==", batchId).get()).docs.map((d) => d.data()) : [];
  const nums = rowDocs.map((r) => r.rowNumber);
  check("every row number was preserved across all chunks", rowDocs.length === 1000 && new Set(nums).size === 1000, `${rowDocs.length} docs / ${new Set(nums).size} distinct`);
  check("row numbers are the original 2..1001 (no re-numbering, no collapse)", !nums.some((n) => n < 2) && Math.min(...nums) === 2 && Math.max(...nums) === 1001, `min=${Math.min(...nums)} max=${Math.max(...nums)}`);
}

console.log("\n### school isolation");
{
  const tPreview = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: [row({ name: "X", admissionNo: "X", class: class1?.name })] }, teacher);
  check("a teacher cannot preview an import", tPreview.status === 403, `HTTP ${tPreview.status}`);
  const gPreview = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: [row({ name: "X", admissionNo: "X", class: class1?.name })] }, guardian);
  check("a guardian cannot preview an import", gPreview.status === 403, `HTTP ${gPreview.status}`);
  const tCommit = await post(HOSTS.school, "/api/import/students/commit", { headers: HEADERS, rows: [row({ name: "X", admissionNo: "X", class: class1?.name })] }, teacher);
  check("a teacher cannot commit an import", tCommit.status === 403, `HTTP ${tCommit.status}`);

  // a batch belonging to another school is invisible
  const foreignId = `imp_foreign_${stamp}`;
  await db.collection("importBatches").doc(foreignId).set({ schoolId: "s_another_school", module: "students", status: "DONE" });
  const foreign = await req(HOSTS.school, `/api/import/students/${foreignId}`, { cookie: admin });
  check("another school's batch answers 404", foreign.status === 404, `HTTP ${foreign.status}`);
  const foreignCommit = await post(HOSTS.school, "/api/import/students/commit", { batchId: foreignId, headers: HEADERS, rows: [row({ name: "X", admissionNo: "X", class: class1?.name })] }, admin);
  check("committing into another school's batch is refused", foreignCommit.status === 404, `HTTP ${foreignCommit.status}`);
  await db.collection("importBatches").doc(foreignId).delete();
}

console.log("\n### undo never deletes guardians");
{
  const gEmail = `bulk-undo-${stamp}@demo.com`;
  const rows = [row({ name: `Undo ${stamp}`, admissionNo: `UNDO-${stamp}`, class: class1?.name, guardianName: `Undo Guard ${stamp}`, guardianEmail: gEmail })];
  createdAdmissionNos.push(rows[0][1]);
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "undo.csv", headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: 1, final: true }, admin);
  const batchId = cm.data?.batchId;
  const guardBefore = await db.collection("users").where("email", "==", gEmail).get();
  check("the undo row created a guardian", guardBefore.size === 1, `${guardBefore.size}`);
  const un = await post(HOSTS.school, `/api/import/students/${batchId}/undo`, {}, admin);
  check("undo removes the imported student", un.status === 200 && un.data?.removedStudents === 1, JSON.stringify(un.data));
  const sAfter = await db.collection("students").where("admissionNo", "==", `UNDO-${stamp}`).get();
  check("the imported student is gone", sAfter.size === 0, `${sAfter.size}`);
  const guardAfter = await db.collection("users").where("email", "==", gEmail).get();
  check("the guardian account is KEPT after undo", guardAfter.size === 1, `${guardAfter.size}`);
  await Promise.all(guardAfter.docs.map((d) => d.ref.delete()));
}

/* ---------------------------------------------- Phase 3 — guardian matching */
console.log("\n### Phase 3 — guardian matching & provisioning");
const p3GuardianEmails = [];
const studentByAdmission = async (admissionNo) => {
  const snap = await db.collection("students").where("admissionNo", "==", admissionNo).get();
  return snap.size ? { id: snap.docs[0].id, ...snap.docs[0].data() } : null;
};
const usersByEmail = async (email) => (await db.collection("users").where("email", "==", email).get()).docs.map((d) => ({ id: d.id, ...d.data() }));

console.log("\n### Phase 3 · existing guardian by email → reuse");
{
  const adm = `P3-EMAIL-${stamp}`;
  createdAdmissionNos.push(adm);
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p3-email.csv", headers: HEADERS, rows: numbered([row({ name: `P3 Email ${stamp}`, admissionNo: adm, class: class1?.name, guardianName: existingGuardian.name, guardianEmail: existingGuardian.email })]), allowWarnings: true, totalRows: 1, final: true }, admin);
  if (cm.data?.batchId) batchIds.push(cm.data.batchId);
  const s = await studentByAdmission(adm);
  check("an existing guardian email is reused on commit", s?.guardianUserId === existingGuardian.id, `${s?.guardianUserId} vs ${existingGuardian.id}`);
  check("a reused-email student is marked LINKED (no new credential)", s?.guardianOnboarding === "LINKED", String(s?.guardianOnboarding));
}

console.log("\n### Phase 3 · existing guardian by normalized phone → reuse");
{
  const phone = `0188${String(stamp).slice(-7)}`;
  const email = `p3-phone-${stamp}@demo.com`;
  p3GuardianEmails.push(email);
  const gid = `u_p3phone_${stamp}`;
  await db.collection("users").doc(gid).set({ id: gid, schoolId, email, name: `P3 Phone ${stamp}`, role: "GUARDIAN", phone, active: true, createdAt: new Date() });

  const pv = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: numbered([row({ name: `P3 Phone Child ${stamp}`, admissionNo: `P3-PHONE-${stamp}`, class: class1?.name, guardianPhone: phone })]) }, admin);
  const rr = pv.data?.rows?.[0];
  check("an existing guardian is matched by phone", rr?.action === "REUSE_GUARDIAN" && rr?.guardianUserId === gid, JSON.stringify({ action: rr?.action, id: rr?.guardianUserId, expected: gid }));

  // a differently formatted phone (spaces) normalizes to the same account
  const pv2 = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: numbered([row({ name: `P3 Phone Child2 ${stamp}`, admissionNo: `P3-PHONE2-${stamp}`, class: class1?.name, guardianPhone: `0188 ${String(stamp).slice(-7)}` })]) }, admin);
  check("phone matching is normalized (spacing ignored)", pv2.data?.rows?.[0]?.guardianUserId === gid, JSON.stringify({ id: pv2.data?.rows?.[0]?.guardianUserId }));

  // commit the phone-reuse row and confirm the link + marker
  const adm = `P3-PHONE-${stamp}`;
  createdAdmissionNos.push(adm);
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p3-phone.csv", headers: HEADERS, rows: numbered([row({ name: `P3 Phone Child ${stamp}`, admissionNo: adm, class: class1?.name, guardianPhone: phone })]), allowWarnings: true, totalRows: 1, final: true }, admin);
  if (cm.data?.batchId) batchIds.push(cm.data.batchId);
  const s = await studentByAdmission(adm);
  check("a phone-matched student links to the existing account", s?.guardianUserId === gid, `${s?.guardianUserId} vs ${gid}`);
  check("a phone-reused student is marked LINKED", s?.guardianOnboarding === "LINKED", String(s?.guardianOnboarding));
}

console.log("\n### Phase 3 · ambiguous phone is never auto-linked");
{
  const phone = `0199${String(stamp).slice(-7)}`;
  const emailA = `p3-amb-a-${stamp}@demo.com`;
  const emailB = `p3-amb-b-${stamp}@demo.com`;
  p3GuardianEmails.push(emailA, emailB);
  await db.collection("users").doc(`u_p3amb_a_${stamp}`).set({ schoolId, email: emailA, name: `P3 Amb A ${stamp}`, role: "GUARDIAN", phone, active: true });
  await db.collection("users").doc(`u_p3amb_b_${stamp}`).set({ schoolId, email: emailB, name: `P3 Amb B ${stamp}`, role: "GUARDIAN", phone, active: true });
  const pv = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: numbered([row({ name: `P3 Amb Child ${stamp}`, admissionNo: `P3-AMB-${stamp}`, class: class1?.name, guardianPhone: phone })]) }, admin);
  const rr = pv.data?.rows?.[0];
  check("a phone shared by two guardians is never auto-linked", rr?.action !== "REUSE_GUARDIAN", JSON.stringify({ action: rr?.action, id: rr?.guardianUserId }));
  check("an ambiguous phone-only row still imports (warning)", rr?.importable === true && rr?.messages?.some((m) => m.code === "GUARDIAN_EMAIL_REQUIRED"), JSON.stringify(rr?.messages));
}

console.log("\n### Phase 3 · new guardian → one invite-pending account");
{
  const email = `p3-new-${stamp}@demo.com`;
  p3GuardianEmails.push(email);
  const adm = `P3-NEW-${stamp}`;
  createdAdmissionNos.push(adm);
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p3-new.csv", headers: HEADERS, rows: numbered([row({ name: `P3 New ${stamp}`, admissionNo: adm, class: class1?.name, guardianName: `P3 New G ${stamp}`, guardianEmail: email })]), allowWarnings: true, totalRows: 1, final: true }, admin);
  if (cm.data?.batchId) batchIds.push(cm.data.batchId);
  const g = (await usersByEmail(email))[0];
  check("a new guardian gets exactly one account", !!g, `${(await usersByEmail(email)).length}`);
  check("the provisioned account is marked QR_CREDENTIALS", g?.passwordStatus === "QR_CREDENTIALS", String(g?.passwordStatus));
  const s = await studentByAdmission(adm);
  check("the student is marked guardian onboarding CREDENTIALS_READY", s?.guardianOnboarding === "CREDENTIALS_READY", String(s?.guardianOnboarding));
  const bad = await req(HOSTS.parents, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: email, password: "Guardian@123" }) });
  check("the provisioned account cannot sign in with the shared default password", bad.status === 401, `HTTP ${bad.status} ${bad.error || ""}`);
}

console.log("\n### Phase 3 · siblings — 2 children share one account, 3 share one family");
const twoRows = [1, 2].map((i) => row({ name: `P3 Two ${stamp}-${i}`, admissionNo: `P3-TWO-${stamp}-${i}`, class: class1?.name, guardianName: `P3 Two G ${stamp}`, guardianEmail: `p3-two-${stamp}@demo.com` }));
const threeRows = [1, 2, 3].map((i) => row({ name: `P3 Three ${stamp}-${i}`, admissionNo: `P3-THREE-${stamp}-${i}`, class: class1?.name, guardianName: `P3 Three G ${stamp}`, guardianEmail: `p3-three-${stamp}@demo.com` }));
const diffRows = [1, 2].map((i) => row({ name: `P3 Diff ${stamp}-${i}`, admissionNo: `P3-DIFF-${stamp}-${i}`, class: class1?.name, guardianName: `P3 Diff G ${stamp}-${i}`, guardianEmail: `p3-diff-${stamp}-${i}@demo.com` }));
[...twoRows, ...threeRows, ...diffRows].forEach((r) => createdAdmissionNos.push(r[1]));
p3GuardianEmails.push(`p3-two-${stamp}@demo.com`, `p3-three-${stamp}@demo.com`, `p3-diff-${stamp}-1@demo.com`, `p3-diff-${stamp}-2@demo.com`);
{
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p3-two.csv", headers: HEADERS, rows: numbered(twoRows), allowWarnings: true, totalRows: 2, final: true }, admin);
  if (cm.data?.batchId) batchIds.push(cm.data.batchId);
  check("two same-guardian children create exactly one account", (await usersByEmail(`p3-two-${stamp}@demo.com`)).length === 1, `${(await usersByEmail(`p3-two-${stamp}@demo.com`)).length}`);
  const a = await studentByAdmission(`P3-TWO-${stamp}-1`);
  const b = await studentByAdmission(`P3-TWO-${stamp}-2`);
  check("both children share the one guardian account", !!a?.guardianUserId && a.guardianUserId === b?.guardianUserId, `${a?.guardianUserId} / ${b?.guardianUserId}`);
  check("two siblings share one family", !!a?.familyId && a.familyId === b?.familyId, `${a?.familyId} / ${b?.familyId}`);
}
{
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p3-three.csv", headers: HEADERS, rows: numbered(threeRows), allowWarnings: true, totalRows: 3, final: true }, admin);
  if (cm.data?.batchId) batchIds.push(cm.data.batchId);
  check("three same-guardian children create exactly one account", (await usersByEmail(`p3-three-${stamp}@demo.com`)).length === 1, `${(await usersByEmail(`p3-three-${stamp}@demo.com`)).length}`);
  const kids = await Promise.all([1, 2, 3].map((i) => studentByAdmission(`P3-THREE-${stamp}-${i}`)));
  const fams = new Set(kids.map((k) => k?.familyId).filter(Boolean));
  check("three siblings share exactly one family", kids.every((k) => !!k?.familyId) && fams.size === 1, `${kids.length} students / ${fams.size} family`);
  check("all three share one guardian account", new Set(kids.map((k) => k?.guardianUserId)).size === 1 && !!kids[0]?.guardianUserId);
}
{
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p3-diff.csv", headers: HEADERS, rows: numbered(diffRows), allowWarnings: true, totalRows: 2, final: true }, admin);
  if (cm.data?.batchId) batchIds.push(cm.data.batchId);
  check("different guardians get separate accounts", (await usersByEmail(`p3-diff-${stamp}-1@demo.com`)).length === 1 && (await usersByEmail(`p3-diff-${stamp}-2@demo.com`)).length === 1);
  const d1 = await studentByAdmission(`P3-DIFF-${stamp}-1`);
  const d2 = await studentByAdmission(`P3-DIFF-${stamp}-2`);
  check("the two students link to different accounts", !!d1?.guardianUserId && !!d2?.guardianUserId && d1.guardianUserId !== d2.guardianUserId, `${d1?.guardianUserId} / ${d2?.guardianUserId}`);
}

console.log("\n### Phase 3 · missing guardian contact imports, marked incomplete");
{
  const adm = `P3-NOG-${stamp}`;
  createdAdmissionNos.push(adm);
  const before = await countCol("users", schoolId);
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p3-nog.csv", headers: HEADERS, rows: numbered([row({ name: `P3 NoG ${stamp}`, admissionNo: adm, class: class1?.name })]), allowWarnings: true, totalRows: 1, final: true }, admin);
  if (cm.data?.batchId) batchIds.push(cm.data.batchId);
  const s = await studentByAdmission(adm);
  check("a student with no guardian contact still imports", !!s && cm.data?.totals?.created === 1, `HTTP ${cm.status} created=${cm.data?.totals?.created}`);
  check("the student is marked guardian onboarding INCOMPLETE", s?.guardianOnboarding === "INCOMPLETE", String(s?.guardianOnboarding));
  check("no guardian account was invented", !s?.guardianUserId && (await countCol("users", schoolId)) === before, `${before} → ${await countCol("users", schoolId)}`);
}

console.log("\n### Phase 3 · re-run creates no duplicate guardian");
{
  const usersBefore = (await usersByEmail(`p3-three-${stamp}@demo.com`)).length;
  const studentsBefore = await countCol("students", schoolId);
  const rr = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p3-three.csv", headers: HEADERS, rows: numbered(threeRows), allowWarnings: true, totalRows: 3, final: true }, admin);
  if (rr.data?.batchId) batchIds.push(rr.data.batchId);
  check("re-running the same roster creates no guardian", (await usersByEmail(`p3-three-${stamp}@demo.com`)).length === usersBefore, `${usersBefore} → ${(await usersByEmail(`p3-three-${stamp}@demo.com`)).length}`);
  check("re-running the same roster creates no student", rr.data?.totals?.created === 0 && rr.data?.totals?.skipped === 3, JSON.stringify(rr.data?.totals));
  check("the student count is unchanged by the guardian re-run", (await countCol("students", schoolId)) === studentsBefore);
}

console.log("\n### Phase 3 · undo never deletes a reused guardian");
{
  const adm = `P3-UNDO-${stamp}`;
  createdAdmissionNos.push(adm);
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p3-undo.csv", headers: HEADERS, rows: numbered([row({ name: `P3 Undo ${stamp}`, admissionNo: adm, class: class1?.name, guardianName: existingGuardian.name, guardianEmail: existingGuardian.email })]), allowWarnings: true, totalRows: 1, final: true }, admin);
  const batchId = cm.data?.batchId;
  const un = await post(HOSTS.school, `/api/import/students/${batchId}/undo`, {}, admin);
  check("undo removes the imported student", un.status === 200 && un.data?.removedStudents === 1, JSON.stringify(un.data));
  check("the pre-existing/reused guardian survives undo", (await usersByEmail(existingGuardian.email)).length >= 1);
}

console.log("\n### Phase 3 · school isolation");
{
  const phone = `0155${String(stamp).slice(-7)}`;
  const outerEmail = `p3-outer-${stamp}@demo.com`;
  p3GuardianEmails.push(outerEmail);
  await db.collection("users").doc(`u_p3outer_${stamp}`).set({ schoolId: `s_other_school_p3_${stamp}`, email: outerEmail, name: `P3 Outer ${stamp}`, role: "GUARDIAN", phone, active: true });
  const pv = await post(HOSTS.school, "/api/import/students/preview", { headers: HEADERS, rows: numbered([row({ name: `P3 Outer Child ${stamp}`, admissionNo: `P3-OUTER-${stamp}`, class: class1?.name, guardianPhone: phone })]) }, admin);
  const rr = pv.data?.rows?.[0];
  check("a guardian from another school is never matched", rr?.action !== "REUSE_GUARDIAN" && rr?.guardianUserId !== `u_p3outer_${stamp}`, JSON.stringify({ action: rr?.action, id: rr?.guardianUserId }));
}

console.log("\n### Phase 3 · branch isolation");
{
  const branches = (await req(HOSTS.school, "/api/branches", { cookie: admin })).data || [];
  if (branches.length) {
    const branch = branches[0];
    const adm = `P3-BRANCH-${stamp}`;
    createdAdmissionNos.push(adm);
    const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p3-branch.csv", branchId: branch.id, headers: HEADERS, rows: numbered([row({ name: `P3 Branch ${stamp}`, admissionNo: adm, class: class1?.name, guardianName: `P3 Branch G ${stamp}`, guardianEmail: `p3-branch-${stamp}@demo.com` })]), allowWarnings: true, totalRows: 1, final: true }, admin);
    if (cm.data?.batchId) batchIds.push(cm.data.batchId);
    p3GuardianEmails.push(`p3-branch-${stamp}@demo.com`);
    const s = await studentByAdmission(adm);
    check("imported students carry the resolved branch", s?.branchId === branch.id, `${s?.branchId} vs ${branch.id}`);
  } else {
    check("branch isolation: no branches configured (nothing to scope)", true);
  }
}

/* --------------------------------------------- Phase 4 — QR credentials */
console.log("\n### Phase 4 — guardian QR credential handoff");
const p4Email = `p4-new-${stamp}@demo.com`;
const p4AdmNew = `P4-NEW-${stamp}`;
const p4AdmReuse = `P4-REUSE-${stamp}`;
const p4AdmNone = `P4-NONE-${stamp}`;
createdAdmissionNos.push(p4AdmNew, p4AdmReuse, p4AdmNone);
p3GuardianEmails.push(p4Email);
let p4BatchId = null;
{
  const rows = [
    row({ name: `P4 New ${stamp}`, admissionNo: p4AdmNew, class: class1?.name, guardianName: `P4 New G ${stamp}`, guardianEmail: p4Email }),
    row({ name: `P4 Reuse ${stamp}`, admissionNo: p4AdmReuse, class: class1?.name, guardianName: existingGuardian.name, guardianEmail: existingGuardian.email }),
    row({ name: `P4 None ${stamp}`, admissionNo: p4AdmNone, class: class1?.name }),
  ];
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "p4.csv", headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: 3, final: true }, admin);
  p4BatchId = cm.data?.batchId || null;
  if (p4BatchId) batchIds.push(p4BatchId);

  const sNew = await studentByAdmission(p4AdmNew);
  const g = (await usersByEmail(p4Email))[0];
  check("a new-guardian student is marked CREDENTIALS_READY", sNew?.guardianOnboarding === "CREDENTIALS_READY", String(sNew?.guardianOnboarding));
  check("the provisioned account is marked QR_CREDENTIALS", g?.passwordStatus === "QR_CREDENTIALS", String(g?.passwordStatus));

  const cred = await req(HOSTS.school, `/api/import/students/${p4BatchId}/credentials`, { cookie: admin });
  const list = cred.data?.credentials || [];
  check("the credentials endpoint returns exactly the new-guardian slip", cred.status === 200 && list.length === 1 && list[0]?.admissionNo === p4AdmNew, `HTTP ${cred.status} ${JSON.stringify(list)}`);
  check("the slip carries the QR token + PIN and never a password", !!list[0]?.qrToken && !!list[0]?.qrPin && !(list[0] && ("password" in list[0])) && !(list[0] && ("passwordHash" in list[0])), JSON.stringify({ token: list[0]?.qrToken, pin: list[0]?.qrPin, keys: Object.keys(list[0] || {}) }));

  const list2 = (await req(HOSTS.school, `/api/import/students/${p4BatchId}/credentials`, { cookie: admin })).data?.credentials || [];
  check("the reused-guardian student is excluded from the slips", !list2.some((c) => c.admissionNo === p4AdmReuse), JSON.stringify(list2.map((c) => c.admissionNo)));
  check("the INCOMPLETE student is excluded from the slips", !list2.some((c) => c.admissionNo === p4AdmNone), JSON.stringify(list2.map((c) => c.admissionNo)));
}

console.log("\n### Phase 4 · credential endpoint access control");
{
  const noAuth = await req(HOSTS.school, `/api/import/students/${p4BatchId}/credentials`);
  check("the credentials endpoint refuses an unauthenticated request", noAuth.status === 401, `HTTP ${noAuth.status}`);
  const t = await req(HOSTS.school, `/api/import/students/${p4BatchId}/credentials`, { cookie: teacher });
  check("a teacher cannot read guardian credentials", t.status === 403, `HTTP ${t.status}`);
  const gg = await req(HOSTS.school, `/api/import/students/${p4BatchId}/credentials`, { cookie: guardian });
  check("a guardian cannot read guardian credentials", gg.status === 403, `HTTP ${gg.status}`);
  const missing = await req(HOSTS.school, `/api/import/students/imp_missing_${stamp}/credentials`, { cookie: admin });
  check("credentials for an unknown batch answer 404", missing.status === 404, `HTTP ${missing.status}`);
  const foreignId = `imp_p4foreign_${stamp}`;
  await db.collection("importBatches").doc(foreignId).set({ schoolId: "s_another_school", module: "students", status: "DONE" });
  const foreign = await req(HOSTS.school, `/api/import/students/${foreignId}/credentials`, { cookie: admin });
  check("credentials for another school's batch answer 404", foreign.status === 404, `HTTP ${foreign.status}`);
  await db.collection("importBatches").doc(foreignId).delete();
}

console.log("\n### Phase 4 · printable credential view");
{
  const page = await req(HOSTS.school, `/print/guardian-credentials/${p4BatchId}`, { cookie: admin });
  check("the printable credential view renders the new guardian's slip", page.status === 200 && page.text.includes(p4AdmNew), `HTTP ${page.status}`);
  check("the slip shows the QR PIN and never the shared default password", /QR PIN/i.test(page.text) && !page.text.includes("Guardian@123"), "");
  const missingPage = await req(HOSTS.school, `/print/guardian-credentials/imp_p4missing_${stamp}`, { cookie: admin });
  check("the printable view refuses a missing batch", missingPage.status === 200 && /not found/i.test(missingPage.text), `HTTP ${missingPage.status}`);
}

console.log("\n### Phase 4 · undo hides credentials");
{
  const un = await post(HOSTS.school, `/api/import/students/${p4BatchId}/undo`, {}, admin);
  check("undo removes the import's students", un.status === 200 && un.data?.removedStudents >= 1, JSON.stringify(un.data));
  const after = (await req(HOSTS.school, `/api/import/students/${p4BatchId}/credentials`, { cookie: admin })).data?.credentials || [];
  check("no credentials are exposed after undo", after.length === 0, `${after.length}`);
  check("the reused guardian survived the undo", (await usersByEmail(existingGuardian.email)).length >= 1);
}

/* --------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
await delByAdmission(createdAdmissionNos);
await Promise.all(batchIds.map(async (id) => {
  const rowsSnap = await db.collection("importBatchRows").where("batchId", "==", id).get();
  await Promise.all(rowsSnap.docs.map((d) => d.ref.delete()));
  await db.collection("importBatches").doc(id).delete();
}));
// stray batches/rows this run created but did not track (none expected) are left alone.
const gsnap = await db.collection("users").where("email", "==", `bulk-guardian-${stamp}@demo.com`).get();
await Promise.all(gsnap.docs.map((d) => d.ref.delete()));
// Phase 3 guardian accounts (provisioned, injected or foreign-school fixtures).
for (const email of p3GuardianEmails) {
  const snap = await db.collection("users").where("email", "==", email).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}
if (sessionId) await db.collection("academicSessions").doc(sessionId).delete();
if (schoolId) {
  const pointer = db.collection("settings").doc(`set_school.${schoolId}.current_session`);
  if (displacedCurrent) await pointer.set({ key: `school.${schoolId}.current_session`, value: displacedCurrent }, { merge: true });
  else await pointer.delete();
}

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : "✅ PASS — bulk import works: template, detection, preview (zero writes), validation, duplicates, guardian reuse, chunking, re-run, retry, isolation."}`);
process.exit(failures ? 1 : 0);
