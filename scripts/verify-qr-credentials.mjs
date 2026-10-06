/**
 * verify-qr-credentials.mjs — Phase 4 credential handoff, end to end.
 *
 * Proves the FULL path a real bulk-imported guardian takes:
 *   credential slip (QR token + PIN)
 *     → POST /api/qr/verify
 *     → guardian session cookie
 *     → GET /api/auth/me resolves the CORRECT student
 *     → GET /api/parent/siblings speaks for only that child
 *     → GET /parent loads on the Parents App
 *
 * It creates its own import batch + two provisioned guardians, and removes
 * everything it created afterwards. Nothing pre-existing is touched.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-qr-credentials.mjs
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

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

const HOSTS = { school: `school.localhost:${PORT}`, parents: `parents.localhost:${PORT}` };

async function req(host, path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    redirect: "manual",
    ...init,
    headers: { Host: host, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(120000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* html / file */ }
  return { status: res.status, location: res.headers.get("location") || "", data: body?.data ?? null, error: body?.error ?? null, setCookie: res.headers.get("set-cookie") || "", text };
}
async function login(host, identifier, password) {
  const r = await req(host, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
  if (r.status !== 200) throw new Error(`login ${identifier}: HTTP ${r.status} ${r.error || ""}`);
  return r.setCookie.split(";")[0];
}

const HEADERS = ["Name", "Admission No", "Roll", "Registration No", "Class", "Section", "Name (Bangla)", "Date of Birth", "Gender", "Blood Group", "Birth Certificate No", "Address", "Previous School", "Previous School Class", "Guardian Name", "Guardian Phone", "Guardian Email", "Guardian Relation", "Photo URL"];
const row = (o = {}) => [o.name ?? "", o.admissionNo ?? "", o.roll ?? "", o.registrationNo ?? "", o.class ?? "", o.section ?? "", o.nameBn ?? "", o.dob ?? "", o.gender ?? "", o.bloodGroup ?? "", o.birthCertificateNo ?? "", o.address ?? "", o.previousSchoolName ?? "", o.previousSchoolClass ?? "", o.guardianName ?? "", o.guardianPhone ?? "", o.guardianEmail ?? "", o.guardianRelation ?? "", o.photoUrl ?? ""];
const numbered = (rows, start = 2) => rows.map((cells, i) => ({ rowNumber: start + i, cells }));
const post = (host, path, body, cookie) => req(host, path, { cookie, method: "POST", body: JSON.stringify(body) });

const admin = await login(HOSTS.school, "principal@sunrise.edu", "School@123");

/* ------------------------------------------------------------------- set-up */
console.log(`\n=== set-up (${BASE})`);
const me = await req(HOSTS.school, "/api/auth/me", { cookie: admin });
const schoolId = me.data?.school?.id || me.data?.schoolId;
check("the school admin is signed in", !!schoolId, String(schoolId));

const classes = (await req(HOSTS.school, "/api/classes", { cookie: admin })).data || [];
const class1 = classes.find((c) => c.name === "Class 1") || classes[0];
check("there is a class to import into", !!class1, class1?.name);

const stamp = Date.now();
const createdAdmissionNos = [];
const guardianEmails = [];
let batchId = null;
let sessionId = null;
let displacedCurrent = null;

if (class1) {
  const existing = await req(HOSTS.school, "/api/academic-sessions", { cookie: admin });
  displacedCurrent = (existing.data || []).find((s) => s.isCurrent)?.id || null;
  const sres = await post(HOSTS.school, "/api/academic-sessions", { name: `QR Verify ${stamp}`, isCurrent: true }, admin);
  sessionId = sres.data?.id || null;
}

/* ------------------------------------------------------ import two students */
console.log("\n### import two provisioned-guardian students");
const admA = `QR-A-${stamp}`;
const admB = `QR-B-${stamp}`;
const emailA = `qr-a-${stamp}@demo.com`;
const emailB = `qr-b-${stamp}@demo.com`;
createdAdmissionNos.push(admA, admB);
guardianEmails.push(emailA, emailB);
{
  const rows = [
    row({ name: `QR Child A ${stamp}`, admissionNo: admA, class: class1?.name, guardianName: `QR Guard A ${stamp}`, guardianEmail: emailA }),
    row({ name: `QR Child B ${stamp}`, admissionNo: admB, class: class1?.name, guardianName: `QR Guard B ${stamp}`, guardianEmail: emailB }),
  ];
  const cm = await post(HOSTS.school, "/api/import/students/commit", { fileName: "qr.csv", headers: HEADERS, rows: numbered(rows), allowWarnings: true, totalRows: 2, final: true }, admin);
  batchId = cm.data?.batchId || null;
  check("the import created both students", cm.status === 200 && cm.data?.totals?.created === 2, `HTTP ${cm.status} created=${cm.data?.totals?.created}`);
}

/* --------------------------------------------------------- credential slip */
console.log("\n### credential slip");
let slipA = null;
let slipB = null;
{
  const cred = await req(HOSTS.school, `/api/import/students/${batchId}/credentials`, { cookie: admin });
  const list = cred.data?.credentials || [];
  slipA = list.find((c) => c.admissionNo === admA) || null;
  slipB = list.find((c) => c.admissionNo === admB) || null;
  check("a slip exists for each new guardian", !!slipA?.qrToken && !!slipA?.qrPin && !!slipB?.qrToken && !!slipB?.qrPin, JSON.stringify(list.map((c) => c.admissionNo)));
  check("the slips carry no password", list.every((c) => !("password" in c) && !("passwordHash" in c)));
}

/* --------------------------------------------------- QR token + PIN → login */
console.log("\n### QR token + PIN → guardian session");
let qrCookie = "";
{
  const r = await post(HOSTS.school, "/api/qr/verify", { token: slipA?.qrToken, pin: slipA?.qrPin });
  qrCookie = r.setCookie.split(";")[0] || "";
  check("a valid QR token + PIN is accepted", r.status === 200 && r.data?.ok === true, `HTTP ${r.status} ${r.error || ""}`);
  check("a guardian session cookie is issued", !!qrCookie && /ss_token=/.test(qrCookie), qrCookie ? "cookie set" : "no cookie");
  check("the verify response points at the Parents App", /\/parent$/.test(r.data?.redirect || ""), String(r.data?.redirect));
}
{
  const bad = await post(HOSTS.school, "/api/qr/verify", { token: slipA?.qrToken, pin: "0000" === slipA?.qrPin ? "1111" : "0000" });
  check("a wrong PIN is rejected", bad.status === 401, `HTTP ${bad.status}`);
  const noToken = await post(HOSTS.school, "/api/qr/verify", { token: "", pin: slipA?.qrPin });
  check("a missing token is rejected", noToken.status === 400, `HTTP ${noToken.status}`);
}

/* --------------------------------------------- session resolves to the child */
console.log("\n### the session resolves to the correct student");
const studentA = (await db.collection("students").where("admissionNo", "==", admA).get()).docs.map((d) => ({ id: d.id, ...d.data() }))[0] || null;
const studentB = (await db.collection("students").where("admissionNo", "==", admB).get()).docs.map((d) => ({ id: d.id, ...d.data() }))[0] || null;
{
  const meQr = await req(HOSTS.school, "/api/auth/me", { cookie: qrCookie });
  check("the QR session authenticates as a GUARDIAN", meQr.status === 200 && meQr.data?.user?.role === "GUARDIAN", `HTTP ${meQr.status} role=${meQr.data?.user?.role}`);
  check("the session resolves to the correct student", meQr.data?.user?.studentId === studentA?.id && meQr.data?.student?.id === studentA?.id, `${meQr.data?.user?.studentId} vs ${studentA?.id}`);
}
{
  const sib = await req(HOSTS.school, "/api/parent/siblings", { cookie: qrCookie });
  const list = sib.data || [];
  check("the QR session speaks for exactly one child", sib.status === 200 && list.length === 1, `HTTP ${sib.status} children=${list.length}`);
  check("that child is the slip's student, not another", list[0]?.id === studentA?.id, `${list[0]?.id} vs ${studentA?.id}`);
  check("another student's data is not exposed", !list.some((c) => c.id === studentB?.id), JSON.stringify(list.map((c) => c.admissionNo)));
}

/* ------------------------------------------------------ /parent loads (host) */
console.log("\n### /parent loads on the Parents App");
{
  const schoolHostParent = await req(HOSTS.school, "/parent", { cookie: qrCookie });
  check("the hub hands /parent to the Parents App", schoolHostParent.status === 307 && /parents\./.test(schoolHostParent.location), `HTTP ${schoolHostParent.status} → ${schoolHostParent.location}`);
  const parentPage = await req(HOSTS.parents, "/parent", { cookie: qrCookie });
  check("/parent loads for the QR guardian", parentPage.status === 200, `HTTP ${parentPage.status}`);
  const anonParent = await req(HOSTS.parents, "/parent");
  check("/parent refuses an anonymous visitor", anonParent.status === 307 && /\/login/.test(anonParent.location), `HTTP ${anonParent.status} → ${anonParent.location}`);
}

/* --------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
const wantedAdm = new Set(createdAdmissionNos);
const studentDocs = (await db.collection("students").get()).docs.filter((d) => wantedAdm.has(d.data().admissionNo));
await Promise.all(
  studentDocs.map(async (doc) => {
    for (const c of ["fees", "payments"]) {
      const s = await db.collection(c).where("studentId", "==", doc.id).get();
      await Promise.all(s.docs.map((x) => x.ref.delete()));
    }
    await doc.ref.delete();
  })
);
for (const email of guardianEmails) {
  const snap = await db.collection("users").where("email", "==", email).get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}
if (batchId) {
  const rowsSnap = await db.collection("importBatchRows").where("batchId", "==", batchId).get();
  await Promise.all(rowsSnap.docs.map((d) => d.ref.delete()));
  await db.collection("importBatches").doc(batchId).delete();
}
if (sessionId) await db.collection("academicSessions").doc(sessionId).delete();
if (schoolId) {
  const pointer = db.collection("settings").doc(`set_school.${schoolId}.current_session`);
  if (displacedCurrent) await pointer.set({ key: `school.${schoolId}.current_session`, value: displacedCurrent }, { merge: true });
  else await pointer.delete();
}

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : "✅ PASS — a credential slip's QR token + PIN signs the guardian in, resolves to the right child, and reaches /parent."}`);
process.exit(failures ? 1 : 0);
