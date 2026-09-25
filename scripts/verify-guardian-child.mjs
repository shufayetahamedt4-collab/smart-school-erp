/**
 * verify-guardian-child.mjs — one family, two children, one answer.
 *
 * A guard/sibling link means one login covers every child of a household
 * (§5.4). Before this harness existed, the self-service routes each picked a
 * child with a bare `findFirst({ guardianUserId })`, so every screen could name
 * a different child — and a request that *named* a child was either refused
 * (the second child looked like a stranger's) or, worse, trusted blindly.
 *
 * What is checked, against the demo tenant:
 *   1. every screen that keys off "the" child resolves to the SAME child — the
 *      family's earliest-admitted one — and does so on every request
 *   2. the guardian's stats and identity agree with the admin's view of that
 *      child's data (fees counted for the right child)
 *   3. a sibling linked only by family id is reachable (student page,
 *      certificate) — family membership, not just guardianUserId
 *   4. a child who is not this family's is never reachable: student page,
 *      certificate, book issues, leave request, chat subject
 *   5. a leave request that names one of the guardian's own children is filed
 *      against that child, not silently re-pointed at the default one
 *
 * It creates one throwaway sibling (student, family link, one fee) and removes
 * it again — deleting by document reference and reading each doc back — so the
 * demo school's roster, fee list and family links are identical afterwards.
 *
 * Usage: SMOKE_PORT=3123 node scripts/verify-guardian-child.mjs
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";

loadEnv();

// NB: this shell exports PORT=0, so never read process.env.PORT here.
const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3123";
const BASE = `http://127.0.0.1:${PORT}`;
const HOSTS = { school: `school.localhost:${PORT}`, parents: `parents.localhost:${PORT}` };
const GUARDIAN = { id: "guardian1@demo.com", pw: "Guardian@123" };
const ADMIN = { id: "principal@sunrise.edu", pw: "School@123" };

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
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Host: host, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null, setCookie: res.headers.get("set-cookie") || "" };
}

async function login(host, identifier, password) {
  const r = await req(host, "/api/auth/login", { method: "POST", body: JSON.stringify({ identifier, password }) });
  if (r.status !== 200) throw new Error(`login ${identifier}: HTTP ${r.status} ${r.error || ""}`);
  const cookie = r.setCookie.split(";")[0];
  if (!cookie) throw new Error(`login ${identifier}: no cookie`);
  return cookie;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------------------------------------------------------- the family */
const userSnap = await db.collection("users").where("email", "==", GUARDIAN.id).limit(1).get();
if (userSnap.empty) {
  console.error(`No demo guardian ${GUARDIAN.id} — is the tenant seeded?`);
  process.exit(1);
}
const guardianUser = { id: userSnap.docs[0].id, ...userSnap.docs[0].data() };
const schoolId = guardianUser.schoolId;

const studentDocs = await db.collection("students").where("schoolId", "==", schoolId).get();
const allStudents = studentDocs.docs.map((d) => ({ id: d.id, ...d.data() }));
const ownChildren = allStudents.filter((s) => s.guardianUserId === guardianUser.id);
if (!ownChildren.length) {
  console.error("Demo guardian has no directly-linked child — cannot run this check.");
  process.exit(1);
}
/** Firestore hands these back as Timestamps, which `new Date()` cannot read. */
const asMs = (v) => (v?.toDate ? v.toDate().getTime() : v ? new Date(v).getTime() : NaN);
const childOrder = (s) => {
  const t = [s.admissionDate, s.createdAt].map(asMs).find((v) => Number.isFinite(v));
  return [t ?? Number.MAX_SAFE_INTEGER, s.id];
};
ownChildren.sort((a, b) => childOrder(a)[0] - childOrder(b)[0] || (childOrder(a)[1] < childOrder(b)[1] ? -1 : 1));
const defaultChild = ownChildren[0];
// A student of the same school that is NOT this family's — the "stranger".
const foreignChild = allStudents.find(
  (s) => s.guardianUserId !== guardianUser.id && s.familyId !== defaultChild.familyId && s.id !== defaultChild.id
);
if (!foreignChild) {
  console.error("No foreign demo student available for the access checks.");
  process.exit(1);
}

/** Throwaway sibling, linked by family id ONLY — exercises the sibling path. */
const stamp = Math.random().toString(36).slice(2, 8);
const siblingId = `zzgc-student-${stamp}`;
const siblingFamilyId = defaultChild.familyId || `fam_zzgc-${stamp}`;
const siblingFeeId = `zzgc-fee-${stamp}`;
const restore = { firstChildFamilyId: defaultChild.familyId ?? null };
const createdLeaveIds = [];
const createdIntentIds = [];

console.log(`family: ${guardianUser.id} · default child ${defaultChild.name} (${defaultChild.id}) · sibling probe ${siblingId}`);
console.log(`stranger for the access checks: ${foreignChild.name} (${foreignChild.id})\n`);

await db.collection("students").doc(siblingId).set({
  id: siblingId,
  schoolId,
  name: "ZZ Guardian Child",
  admissionNo: `ZZGC-${stamp}`,
  classId: defaultChild.classId ?? null,
  sectionId: defaultChild.sectionId ?? null,
  // No guardianUserId on purpose: only the family link makes this child ours.
  guardianUserId: null,
  familyId: siblingFamilyId,
  admissionDate: new Date(Date.now() + 60000),
  createdAt: new Date(Date.now() + 60000),
  active: true,
  status: "ACTIVE",
});
await db.collection("students").doc(defaultChild.id).update({ familyId: siblingFamilyId });
// One fee for the probe child, so "which child's numbers does stats show?" is a
// question with a distinguishable answer.
await db.collection("fees").doc(siblingFeeId).set({
  id: siblingFeeId,
  schoolId,
  studentId: siblingId,
  title: "ZZ Guardian probe fee",
  amount: 4321,
  paidAmount: 0,
  feeType: "OTHER",
  status: "UNPAID",
  dueDate: new Date(),
  createdAt: new Date(),
});

const adminCookie = await login(HOSTS.school, ADMIN.id, ADMIN.pw);
const guardianCookie = await login(HOSTS.parents, GUARDIAN.id, GUARDIAN.pw);

try {
  /* 1. the server sees the family (read cache can lag a new document) */
  let siblingList = [];
  for (let i = 0; i < 18; i++) {
    const r = await req(HOSTS.parents, "/api/parent/siblings", { cookie: guardianCookie });
    siblingList = Array.isArray(r.data) ? r.data : [];
    if (siblingList.some((c) => c.id === siblingId)) break;
    await sleep(5000);
  }
  check(
    "guardian portal lists both children (family link)",
    siblingList.length >= 2 && siblingList.some((c) => c.id === siblingId) && siblingList.some((c) => c.id === defaultChild.id),
    siblingList.map((c) => c.name).join(", ") || "none"
  );

  /* 2. one child everywhere, every time */
  const meIds = new Set();
  for (let i = 0; i < 3; i++) {
    const me = await req(HOSTS.parents, "/api/auth/me", { cookie: guardianCookie });
    meIds.add(me.data?.student?.id || "(none)");
  }
  check(
    "/api/auth/me always names the same child",
    meIds.size === 1 && meIds.has(defaultChild.id),
    [...meIds].join(", ")
  );

  const stats = await req(HOSTS.parents, "/api/stats", { cookie: guardianCookie });
  const adminFeesDefault = await req(HOSTS.school, `/api/fees?studentId=${defaultChild.id}`, { cookie: adminCookie });
  const adminFeesSibling = await req(HOSTS.school, `/api/fees?studentId=${siblingId}`, { cookie: adminCookie });
  const countOf = (r) => (Array.isArray(r.data?.fees) ? r.data.fees.length : null);
  const statsFeeTotal = stats.data?.fees?.total;
  const defaultFeeCount = countOf(adminFeesDefault);
  const siblingFeeCount = countOf(adminFeesSibling);
  check(
    "guardian stats count the same child's fees as the admin view of that child",
    statsFeeTotal === defaultFeeCount && statsFeeTotal !== siblingFeeCount,
    `stats=${statsFeeTotal} admin(default)=${defaultFeeCount} admin(sibling)=${siblingFeeCount}`
  );

  /* 3. a family-linked sibling is reachable, a stranger never is */
  const sibStudent = await req(HOSTS.parents, `/api/students/${siblingId}`, { cookie: guardianCookie });
  check("guardian can open a family-linked sibling's page", sibStudent.status === 200, `HTTP ${sibStudent.status}`);

  const foreignStudent = await req(HOSTS.parents, `/api/students/${foreignChild.id}`, { cookie: guardianCookie });
  check("guardian cannot open another family's child page", foreignStudent.status === 403, `HTTP ${foreignStudent.status}`);

  const sibCert = await req(HOSTS.parents, `/api/certificates?studentId=${siblingId}&type=TC`, { cookie: guardianCookie });
  const foreignCert = await req(HOSTS.parents, `/api/certificates?studentId=${foreignChild.id}&type=TC`, { cookie: guardianCookie });
  check("certificate for a family-linked sibling is allowed", sibCert.status === 200, `HTTP ${sibCert.status} ${sibCert.error || ""}`);
  check("certificate for another family's child is refused", foreignCert.status === 403, `HTTP ${foreignCert.status}`);

  const foreignIssues = await req(HOSTS.parents, `/api/books/issues?studentId=${foreignChild.id}`, { cookie: guardianCookie });
  check(
    "book issues asked for another family's child come back empty",
    foreignIssues.status === 200 && Array.isArray(foreignIssues.data) && foreignIssues.data.length === 0,
    `HTTP ${foreignIssues.status} rows=${Array.isArray(foreignIssues.data) ? foreignIssues.data.length : "?"}`
  );

  /* 4. a named child is honoured when ours, refused when not */
  const ownLeave = await req(HOSTS.parents, "/api/leave-requests", {
    cookie: guardianCookie,
    method: "POST",
    body: JSON.stringify({ studentId: siblingId, fromDate: new Date().toISOString().slice(0, 10), reason: "ZZ guardian-child probe" }),
  });
  if (ownLeave.data?.id) createdLeaveIds.push(ownLeave.data.id);
  check(
    "leave request naming a family child files against that child",
    ownLeave.status === 201 && ownLeave.data?.studentId === siblingId,
    `HTTP ${ownLeave.status} studentId=${ownLeave.data?.studentId || "?"}`
  );

  const foreignLeave = await req(HOSTS.parents, "/api/leave-requests", {
    cookie: guardianCookie,
    method: "POST",
    body: JSON.stringify({ studentId: foreignChild.id, fromDate: new Date().toISOString().slice(0, 10), reason: "ZZ guardian-child probe (foreign)" }),
  });
  if (foreignLeave.data?.id) createdLeaveIds.push(foreignLeave.data.id);
  check("leave request naming another family's child is refused", foreignLeave.status >= 400, `HTTP ${foreignLeave.status}`);

  const foreignChat = await req(HOSTS.parents, "/api/chat", {
    cookie: guardianCookie,
    method: "POST",
    body: JSON.stringify({ body: "ZZ guardian-child probe", studentId: foreignChild.id }),
  });
  check("chat cannot be opened for another family's child", foreignChat.status >= 400, `HTTP ${foreignChat.status} ${foreignChat.error || ""}`);

  const leaveList = await req(HOSTS.parents, "/api/leave-requests", { cookie: guardianCookie });
  const leaveStudentIds = [...new Set((leaveList.data || []).map((r) => r.studentId))];
  const ownIds = new Set([defaultChild.id, siblingId]);
  check(
    "leave list shows only this family's children",
    leaveStudentIds.every((id) => ownIds.has(id)),
    leaveStudentIds.join(", ") || "none"
  );

  const payments = await req(HOSTS.parents, "/api/payments", { cookie: guardianCookie });
  const paymentStudentIds = [...new Set((payments.data || []).map((p) => p.studentId))];
  check(
    "payment intents list shows only this family's children",
    paymentStudentIds.every((id) => ownIds.has(id)),
    paymentStudentIds.join(", ") || "none"
  );

  /* 5. paying: the second child's fee is payable, a stranger's is not */
  const foreignFeeId = `zzgc-fee-foreign-${stamp}`;
  await db.collection("fees").doc(foreignFeeId).set({
    id: foreignFeeId,
    schoolId,
    studentId: foreignChild.id,
    title: "ZZ Guardian probe fee (foreign)",
    amount: 500,
    paidAmount: 0,
    feeType: "OTHER",
    status: "UNPAID",
    dueDate: new Date(),
    createdAt: new Date(),
  });
  const ownPay = await req(HOSTS.parents, "/api/payments", {
    cookie: guardianCookie,
    method: "POST",
    body: JSON.stringify({ feeId: siblingFeeId, method: "BKASH", amount: 100 }),
  });
  if (ownPay.data?.id) createdIntentIds.push(ownPay.data.id);
  check(
    "guardian can start a payment on a family-linked sibling's fee",
    ownPay.status === 201 && ownPay.data?.studentId === siblingId,
    `HTTP ${ownPay.status} ${ownPay.error || ""}`
  );

  const foreignPay = await req(HOSTS.parents, "/api/payments", {
    cookie: guardianCookie,
    method: "POST",
    body: JSON.stringify({ feeId: foreignFeeId, method: "BKASH", amount: 100 }),
  });
  if (foreignPay.data?.id) createdIntentIds.push(foreignPay.data.id);
  check(
    "guardian cannot start a payment on another family's fee",
    foreignPay.status === 403,
    `HTTP ${foreignPay.status}`
  );
  await db.collection("fees").doc(foreignFeeId).delete().catch(() => null);
} finally {
  /* -------------------------------------------------- cleanup: put it all back */
  for (const id of createdLeaveIds) {
    await db.collection("leaveRequests").doc(id).delete().catch(() => null);
  }
  for (const id of createdIntentIds) {
    await db.collection("paymentIntents").doc(id).delete().catch(() => null);
  }
  await db.collection("fees").doc(siblingFeeId).delete().catch(() => null);
  await db.collection("students").doc(siblingId).delete().catch(() => null);
  // The first child's own family link is put back exactly as it was: this
  // harness must not silently re-family (or de-family) a demo student.
  const { FieldValue } = await import("firebase-admin/firestore");
  await db.collection("students").doc(defaultChild.id).update(
    restore.firstChildFamilyId ? { familyId: restore.firstChildFamilyId } : { familyId: FieldValue.delete() }
  );

  // Read everything back: a delete that did not delete is a leaked fixture.
  const leftovers = [];
  for (const [col, id] of [
    ["students", siblingId],
    ["fees", siblingFeeId],
    ...createdLeaveIds.map((id) => ["leaveRequests", id]),
    ...createdIntentIds.map((id) => ["paymentIntents", id]),
  ]) {
    const snap = await db.collection(col).doc(id).get();
    if (snap.exists) leftovers.push(`${col}/${id}`);
  }
  const defaultSnap = await db.collection("students").doc(defaultChild.id).get();
  const rosterAfter = await db.collection("students").where("schoolId", "==", schoolId).get();

  console.log("");
  check("fixture removed (no leaked documents)", leftovers.length === 0, leftovers.join(", "));
  const restoredFamily = defaultSnap.data()?.familyId || null;
  check(
    "demo child's original link restored",
    defaultSnap.data()?.guardianUserId === guardianUser.id && restoredFamily === restore.firstChildFamilyId,
    `guardianUserId=${defaultSnap.data()?.guardianUserId || "none"} familyId=${restoredFamily} (was ${restore.firstChildFamilyId})`
  );
  check("demo roster unchanged", rosterAfter.size === allStudents.length, `${allStudents.length} → ${rosterAfter.size}`);
}

console.log(`\n${failures ? `❌ ${failures} check(s) failed` : "✅ GUARDIAN CHILD RESOLUTION CONFIRMED"}`);
process.exit(failures ? 1 : 0);
