/**
 * verify-cache-scoping.mjs — prove write invalidation is SCOPED, not global.
 *
 * The db read cache (src/lib/db.ts) used to clear its ENTIRE process memo on
 * every write. That is correct but wasteful in a multi-tenant process: one
 * school's submit cold-starts every other school's reads. This harness proves
 * the scoped replacement:
 *
 *   1. School A reads students → cached.
 *   2. School B reads students → cached independently.
 *   3. An OUT-OF-BAND change (straight through the admin SDK, bypassing the
 *      server cache) to both schools' students is provably INVISIBLE until the
 *      server's memo entry is dropped. That is the detector: after a write, a
 *      read that still shows the pre-change value proves the entry was KEPT; a
 *      read that shows the new value proves the entry was DROPPED.
 *   4. A write to School A students → A's student cache is dropped (fresh read
 *      shows the new value).
 *   5. School B's student cache is KEPT (its read still shows the pre-change
 *      value) → a write in one school does not cold-start another.
 *   6. A write to School A NOTICES leaves School A's STUDENT cache untouched →
 *      a write to one model does not evict another model.
 *   7. A normal POST is immediately reflected by the next read → write-after-
 *      read freshness is preserved.
 *   8. Cross-school reads never leak: every student returned for B carries B's
 *      schoolId and never A's fixtures.
 *
 * It creates its own second school + admin + students and removes everything
 * afterwards. It never modifies pre-existing demo rows (the two student names
 * it changes are restored).
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-cache-scoping.mjs
 */
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

loadEnv();
requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const HOST = `school.localhost:${PORT}`;
const stamp = Date.now();

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const sha1 = (s) => createHash("sha1").update(s).digest("hex");
const unescapeKey = (k) => {
  const BS = String.fromCharCode(92);
  return k.includes(BS + "n") ? k.split(BS + "n").join("\n") : k.replace(/\\n/g, "\n");
};

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

async function req(path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Host: HOST, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* html */ }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null, text };
}
async function cookieFor(identifier, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { Host: HOST, "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
    signal: AbortSignal.timeout(60000),
  });
  if (res.status !== 200) throw new Error(`login ${identifier}: HTTP ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
const students = async (cookie) => (await req("/api/students", { cookie })).data || [];

/* ------------------------------------------------------------------- fixture */
console.log(`\n=== set-up (${BASE})`);
const adminCookie = await cookieFor("principal@sunrise.edu", "School@123");
const me = (await req("/api/auth/me", { cookie: adminCookie })).data;
const schoolA = me?.school?.id;
check("School A (sunrise) is signed in", !!schoolA, String(schoolA));

const slugB = `cacheiso-${stamp}`;
const schoolB = `s_${sha1(slugB)}`;
const adminBEmail = `cache-admin-${stamp}@demo.com`;
const adminBCookieUser = `u_${sha1(adminBEmail)}`;

await db.collection("schools").doc(schoolB).set({
  name: `Cache Iso ${stamp}`,
  slug: slugB,
  plan: "PRO",
  status: "ACTIVE",
  themeColor: null,
});
await db.collection("users").doc(adminBCookieUser).set({
  email: adminBEmail,
  name: `Cache Iso Admin ${stamp}`,
  role: "SCHOOL_ADMIN",
  schoolId: schoolB,
  passwordHash: bcrypt.hashSync("CacheB@123", 10),
  active: true,
});
const bStudentNames = [`B Student One ${stamp}`, `B Student Two ${stamp}`];
for (const name of bStudentNames) {
  const ref = db.collection("students").doc();
  await ref.set({ schoolId: schoolB, name, admissionNo: `ISO-${stamp}-${ref.id.slice(0, 4)}`, active: true, createdAt: new Date() });
}
const bCookie = await cookieFor(adminBEmail, "CacheB@123");
check("School B admin signs in", !!bCookie);

const aStudents = await students(adminCookie);
const bStudents = await students(bCookie);
const aTarget = aStudents.find((s) => s.name && !s.name.startsWith("B Student"));
const bTarget = bStudents.find((s) => bStudentNames.includes(s.name));
check("both schools have a student to work with", !!aTarget?.id && !!bTarget?.id, `${aTarget?.id} / ${bTarget?.id}`);

const aOriginalName = aTarget?.name;
const bOriginalName = bTarget?.name;
const A_OOB = `A-OOB-${stamp}`;
const B_OOB = `B-OOB-${stamp}`;

/* ------------------------------------------------- T1: cross-school isolation */
console.log("\n### 1-5. a write in School A must not evict School B's cached reads");
if (aTarget && bTarget) {
  // Both schools' student lists are now cached (the reads above).
  // Out-of-band rename — invisible until the server memo entry is dropped.
  await db.collection("students").doc(aTarget.id).update({ name: A_OOB });
  await db.collection("students").doc(bTarget.id).update({ name: B_OOB });

  // Write to School A through the API (scoped invalidation of student + A).
  const created = await req("/api/students", {
    cookie: adminCookie,
    method: "POST",
    body: JSON.stringify({ name: `A Temp ${stamp}`, admissionNo: `CACHE-A-${stamp}`, createGuardian: false, createFees: false }),
  });
  check("School A student write succeeds", created.status === 201, `HTTP ${created.status} ${created.error || ""}`);

  const aAfter = await students(adminCookie);
  const bAfter = await students(bCookie);
  const aSeesOob = aAfter.some((s) => s.name === A_OOB);
  const bValue = bAfter.find((s) => bTarget.id === s.id || s.name === B_OOB || s.name === bOriginalName);
  const bSeesOob = bAfter.some((s) => s.name === B_OOB);

  check("School A's student cache was DROPPED (fresh read sees the out-of-band rename)", aSeesOob, `A names=[${aAfter.map((s) => s.name).slice(0, 4).join(", ")}]`);
  check("School B's student cache was KEPT (still the pre-rename value)", !bSeesOob && bValue?.name === bOriginalName, `B value=${bValue?.name}`);
}

/* ------------------------------------------- T2: cross-model isolation (same school) */
console.log("\n### 6. a write to School A notices leaves School A's student cache untouched");
if (aTarget) {
  // A's student list is cached as A-OOB (from T1). Change it out-of-band to
  // A-OOB-2 and DO NOT read students until after the notice write.
  const A_OOB2 = `A-OOB2-${stamp}`;
  await db.collection("students").doc(aTarget.id).update({ name: A_OOB2 });

  const notice = await req("/api/notices", {
    cookie: adminCookie,
    method: "POST",
    body: JSON.stringify({ title: `Cache iso notice ${stamp}`, body: "cache scope probe" }),
  });
  check("School A notice write succeeds", notice.status === 201, `HTTP ${notice.status} ${notice.error || ""}`);

  const aAfterNotice = await students(adminCookie);
  const stillA_OOB = aAfterNotice.some((s) => s.name === A_OOB);
  const seesA_OOB2 = aAfterNotice.some((s) => s.name === A_OOB2);
  check("School A's student cache was KEPT across a notice write", stillA_OOB && !seesA_OOB2, `A names=[${aAfterNotice.map((s) => s.name).slice(0, 4).join(", ")}]`);

  if (notice.data?.id) await db.collection("notices").doc(notice.data.id).delete().catch(() => null);
  const notifs = await db.collection("notifications").where("title", "==", `Notice: Cache iso notice ${stamp}`).get();
  await Promise.all(notifs.docs.map((d) => d.ref.delete()));
}

/* ------------------------------------------------ T3/T4: freshness + isolation */
console.log("\n### 7-8. write-after-read freshness + no cross-school leakage");
const freshAdm = `CACHE-FRESH-${stamp}`;
{
  const created = await req("/api/students", {
    cookie: adminCookie,
    method: "POST",
    body: JSON.stringify({ name: `Fresh ${stamp}`, admissionNo: freshAdm, createGuardian: false, createFees: false }),
  });
  check("a fresh student write succeeds", created.status === 201, `HTTP ${created.status} ${created.error || ""}`);
  const list = await students(adminCookie);
  check("the next read reflects the write immediately (no stale cache)", list.some((s) => s.admissionNo === freshAdm), `admissionNo=${freshAdm}`);
}
{
  const bList = await students(bCookie);
  const leaked = bList.filter((s) => s.schoolId !== schoolB);
  const aNames = new Set((await students(adminCookie)).map((s) => s.id));
  check("School B's list contains only School B rows", leaked.length === 0, `${leaked.length} foreign row(s)`);
  check("School B's list contains none of School A's rows", !bList.some((s) => aNames.has(s.id)));
}

/* ------------------- T5: by-id doc-cache freshness (the authorization read path) */
// The lifecycle route (and every relation lookup) reads a student with
// findUnique({ where: { id } }) — the SINGLE-DOCUMENT cache entry. An update
// addressed by id alone cannot name a school, so it must still drop that entry
// (the model-wide fallback); otherwise a stale doc could answer an
// authorization check with a pre-write branchId/status. This proves it cannot.
console.log("\n### 9. a by-id update is visible to the very next by-id read (doc cache dropped)");
const docAdm = `CACHE-DOC-${stamp}`;
let docStudentId = null;
{
  const ref = db.collection("students").doc();
  docStudentId = ref.id;
  await ref.set({ schoolId: schoolA, name: `Doc Cache ${stamp}`, admissionNo: docAdm, active: true, createdAt: new Date() });

  const first = await req(`/api/students/${docStudentId}`, { cookie: adminCookie });
  check("the fresh student reads back by id", first.status === 200 && first.data?.name === `Doc Cache ${stamp}`, `HTTP ${first.status}`);

  const renamed = `Doc Cache RENAMED ${stamp}`;
  const patched = await req(`/api/students/${docStudentId}`, { cookie: adminCookie, method: "PATCH", body: JSON.stringify({ name: renamed }) });
  check("the by-id update succeeds", patched.status === 200, `HTTP ${patched.status} ${patched.error || ""}`);

  const after = await req(`/api/students/${docStudentId}`, { cookie: adminCookie });
  check("the very next by-id read shows the new value (doc cache invalidated)", after.data?.name === renamed, `name=${after.data?.name}`);
}

/* ------------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
if (aTarget && aOriginalName) await db.collection("students").doc(aTarget.id).update({ name: aOriginalName }).catch(() => null);
if (bTarget && bOriginalName) await db.collection("students").doc(bTarget.id).update({ name: bOriginalName }).catch(() => null);
{
  const temps = await db.collection("students").where("admissionNo", "==", `CACHE-A-${stamp}`).get();
  const temps2 = await db.collection("students").where("admissionNo", "==", freshAdm).get();
  await Promise.all([...temps.docs, ...temps2.docs].map(async (d) => {
    for (const c of ["fees", "payments"]) {
      const snap = await db.collection(c).where("studentId", "==", d.id).get();
      await Promise.all(snap.docs.map((x) => x.ref.delete()));
    }
    await d.ref.delete();
  }));
}
if (docStudentId) await db.collection("students").doc(docStudentId).delete().catch(() => null);
{
  const bs = await db.collection("students").where("schoolId", "==", schoolB).get();
  await Promise.all(bs.docs.map((d) => d.ref.delete()));
  await db.collection("users").doc(adminBCookieUser).delete();
  await db.collection("schools").doc(schoolB).delete();
}

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : "✅ PASS — write invalidation is scoped to the model (and school, when provable); other schools and other models keep their cached reads, and freshness is preserved."}`);
process.exit(failures ? 1 : 0);
