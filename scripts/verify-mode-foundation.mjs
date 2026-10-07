/**
 * verify-mode-foundation.mjs — Phase M (Mode Foundation) pre-push check.
 *
 * Creates throwaway tenants in the local Firestore emulator — one with NO
 * institutionType (legacy SCHOOL), one COLLEGE, one BOTH — plus a few users, and
 * signs sessions for them directly (no login, so no password fixtures). Then it
 * proves, over the real HTTP API:
 *
 *   1. legacy SCHOOL tenant: allowedModes=[SCHOOL], mode=SCHOOL, no switcher,
 *      a stray ss_mode cookie is ignored, and College is refused;
 *   2. COLLEGE tenant: allowedModes=[COLLEGE], mode=COLLEGE, School is refused;
 *   3. BOTH tenant: allowedModes=[SCHOOL,COLLEGE], default SCHOOL, a valid
 *      lastMode is honoured, an invalid one falls back to SCHOOL;
 *   4. POST /api/mode: sets the cookie with the auth conventions, persists
 *      users.lastMode, audits a real switch only, rejects invalid/disallowed
 *      modes with 400 and no cookie/audit, and is exempt from the write guard;
 *   5. cache separation: BOTH School vs College resolves to distinct settings
 *      keys (grading scheme, routine config, academic session) and both modes
 *      serve stats/exams — today's SCHOOL key is untouched;
 *   6. institutionType stays platform-only and a mode switch cannot change it;
 *   7. a SCHOOL tenant still reads its settings from today's exact key.
 *
 * Everything it creates is deleted at the end (and at the start, to recover from
 * an aborted run). Emulator-only — it fails closed anywhere but a loopback
 * Firestore emulator and never touches production.
 *
 * Usage: node scripts/verify-mode-foundation.mjs        (BASE, default http://localhost:3000)
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { SignJWT } from "jose";

import { requireEmulator } from "./lib/guard.mjs";

requireEmulator();

const BASE = (process.env.BASE || `http://localhost:${process.env.SMOKE_PORT || "3000"}`).replace(/\/+$/, "");
const P = "zzmode-";
const LEGACY = `${P}school`; // no institutionType → SCHOOL
const COLLEGE = `${P}college`; // institutionType COLLEGE
const BOTH = `${P}both`; // institutionType BOTH
const U = (n) => `${P}u-${n}`;
const USER_IDS = [U("legacy"), U("college"), U("both"), U("both-last"), U("both-bad"), U("switch")];
const ASM = `${P}asm-1`;

/** Read one key from the repo .env (the server's JWT_SECRET source). */
function dotenvValue(key) {
  try {
    const txt = readFileSync(new URL("../.env", import.meta.url), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
      if (!m || m[1] !== key) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch {
    /* no .env — fall through to the module default */
  }
  return "";
}

// The server signs sessions with JWT_SECRET from .env; our signed sessions must
// use the same secret. No credential file is read.
const JWT_SECRET =
  process.env.JWT_SECRET || dotenvValue("JWT_SECRET") || "smart-school-erp-secret-change-me-in-production";
const SECRET = new TextEncoder().encode(JWT_SECRET);

// Emulator-only, credential-free init with the SAME project id as seed.mjs.
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

/* --------------------------------------------------------------- helpers */

async function makeToken(userId, schoolId, role = "SCHOOL_ADMIN") {
  return new SignJWT({ id: userId, name: "ZZ Mode Admin", email: `${userId}@test.local`, role, schoolId, scope: null, branchId: null })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(SECRET);
}

async function call(path, { method = "GET", token, mode, body } = {}) {
  const cookies = [];
  if (token) cookies.push(`ss_token=${token}`);
  if (mode) cookies.push(`ss_mode=${mode}`);
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(cookies.length ? { cookie: cookies.join("; ") } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000),
    redirect: "manual",
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { __raw: text.slice(0, 200) };
  }
  const setCookies =
    typeof res.headers.getSetCookie === "function"
      ? res.headers.getSetCookie()
      : res.headers.get("set-cookie")
        ? [res.headers.get("set-cookie")]
        : [];
  return { status: res.status, json, setCookies };
}

function cookieAttrs(list, name) {
  const raw = list.find((c) => c.startsWith(`${name}=`));
  if (!raw) return null;
  const parts = raw.split(";").map((s) => s.trim());
  const value = parts[0].slice(name.length + 1);
  const flags = {};
  for (const a of parts.slice(1)) {
    const eq = a.indexOf("=");
    if (eq === -1) flags[a.toLowerCase()] = true;
    else flags[a.slice(0, eq).toLowerCase()] = a.slice(eq + 1);
  }
  return { value, flags, raw };
}

async function modeSwitchAudits(userId) {
  const snap = await db.collection("auditLogs").where("action", "==", "MODE_SWITCH").get();
  return snap.docs.filter((d) => d.data().userId === userId);
}

let failures = 0;
function check(cond, msg) {
  if (cond) console.log(`  ✅ ${msg}`);
  else {
    failures++;
    console.log(`  ❌ ${msg}`);
  }
}

/* ------------------------------------------------------------- fixtures */

const SETTING_KEYS = [
  `grading_scheme_${LEGACY}`,
  `routine_config_${LEGACY}`,
  `school.${LEGACY}.current_session`,
  `grading_scheme_${BOTH}`,
  `routine_config_${BOTH}`,
  `school.${BOTH}.current_session`,
];

async function cleanup() {
  for (const id of [LEGACY, COLLEGE, BOTH]) await db.collection("schools").doc(id).delete().catch(() => {});
  for (const id of USER_IDS) await db.collection("users").doc(id).delete().catch(() => {});
  for (const id of [ASM, `${ASM}-legacy`]) await db.collection("academicSessions").doc(id).delete().catch(() => {});
  for (const key of SETTING_KEYS) await db.collection("settings").doc(`set_${key}`).delete().catch(() => {});
  for (const schoolId of [LEGACY, COLLEGE, BOTH]) {
    const subs = await db.collection("subscriptions").where("schoolId", "==", schoolId).get().catch(() => null);
    if (subs) for (const d of subs.docs) await d.ref.delete().catch(() => {});
  }
  const audits = await db.collection("auditLogs").where("action", "==", "MODE_SWITCH").get().catch(() => null);
  if (audits) for (const d of audits.docs) if (USER_IDS.includes(d.data().userId)) await d.ref.delete().catch(() => {});
}

const MARKER_SCHEME = {
  name: "ZZ Mode Marker",
  gpaScale: 5,
  passPercent: 33,
  failCapsGpa: false,
  bands: [
    { grade: "A", minPercent: 80, gpa: 5, remark: "ok" },
    { grade: "F", minPercent: 0, gpa: 0, remark: "no" },
  ],
};
const MARKER_DAYS = [0, 1];
const MARKER_ROUTINE = { days: MARKER_DAYS, periods: [{ period: 1, start: "09:00", end: "09:45" }] };

try {
  await cleanup(); // recover from an aborted run

  await db.collection("schools").doc(LEGACY).set({ name: "ZZ Mode Legacy School", slug: "zz-mode-legacy", status: "ACTIVE" });
  await db.collection("schools").doc(COLLEGE).set({ name: "ZZ Mode College", slug: "zz-mode-college", status: "ACTIVE", institutionType: "COLLEGE" });
  await db.collection("schools").doc(BOTH).set({ name: "ZZ Mode Both", slug: "zz-mode-both", status: "ACTIVE", institutionType: "BOTH" });

  const mkUser = (id, schoolId, extra = {}) =>
    db.collection("users").doc(id).set({ name: "ZZ Mode Admin", email: `${id}@test.local`, role: "SCHOOL_ADMIN", schoolId, active: true, ...extra });
  await mkUser(U("legacy"), LEGACY);
  await mkUser(U("college"), COLLEGE);
  await mkUser(U("both"), BOTH);
  await mkUser(U("both-last"), BOTH, { lastMode: "COLLEGE" });
  await mkUser(U("both-bad"), BOTH, { lastMode: "HISTORY" });
  await mkUser(U("switch"), BOTH);

  // A LOCKED subscription on the BOTH tenant, so we can prove a mode switch is
  // write-guard exempt while an ordinary write is not.
  await db.collection("subscriptions").doc(`${P}sub-both`).set({ schoolId: BOTH, status: "LOCKED", createdAt: new Date() });

  const tLegacy = await makeToken(U("legacy"), LEGACY);
  const tCollege = await makeToken(U("college"), COLLEGE);
  const tBoth = await makeToken(U("both"), BOTH);
  const tBothLast = await makeToken(U("both-last"), BOTH);
  const tBothBad = await makeToken(U("both-bad"), BOTH);
  const tSwitch = await makeToken(U("switch"), BOTH);

  /* ------------------------------------------------------------ 1. legacy */
  console.log("\n### 1. Legacy SCHOOL tenant / absent institutionType");
  {
    const me = await call("/api/auth/me", { token: tLegacy });
    check(me.status === 200, `GET /api/auth/me → 200 (got ${me.status})`);
    check(JSON.stringify(me.json?.data?.allowedModes) === '["SCHOOL"]', `allowedModes = ["SCHOOL"] (got ${JSON.stringify(me.json?.data?.allowedModes)})`);
    check(me.json?.data?.mode === "SCHOOL", `mode = SCHOOL (got ${me.json?.data?.mode})`);
    check(me.json?.data?.institutionType === "SCHOOL", `institutionType reads as SCHOOL (got ${me.json?.data?.institutionType})`);
    check(!me.json?.data?.school?.institutionType, `the school document carries no institutionType (got ${JSON.stringify(me.json?.data?.school?.institutionType)})`);
    check(me.json?.data?.school?.institutionType !== "BOTH", "no switcher is offered (institutionType !== BOTH)");
    const stray = await call("/api/auth/me", { token: tLegacy, mode: "COLLEGE" });
    check(stray.json?.data?.mode === "SCHOOL", `a stray ss_mode=COLLEGE cookie is ignored on a SCHOOL tenant (got ${stray.json?.data?.mode})`);
    const refused = await call("/api/mode", { method: "POST", token: tLegacy, body: { mode: "COLLEGE" } });
    check(refused.status === 400, `POST /api/mode {COLLEGE} on a SCHOOL tenant → 400 (got ${refused.status})`);
    check(cookieAttrs(refused.setCookies, "ss_mode") === null, "a refused switch sets no ss_mode cookie");
  }

  /* ----------------------------------------------------------- 2. college */
  console.log("\n### 2. COLLEGE tenant");
  {
    const me = await call("/api/auth/me", { token: tCollege });
    check(me.json?.data?.mode === "COLLEGE", `mode = COLLEGE (got ${me.json?.data?.mode})`);
    check(JSON.stringify(me.json?.data?.allowedModes) === '["COLLEGE"]', `allowedModes = ["COLLEGE"] (got ${JSON.stringify(me.json?.data?.allowedModes)})`);
    const refused = await call("/api/mode", { method: "POST", token: tCollege, body: { mode: "SCHOOL" } });
    check(refused.status === 400, `POST /api/mode {SCHOOL} on a COLLEGE tenant → 400 (got ${refused.status})`);
    check(cookieAttrs(refused.setCookies, "ss_mode") === null, "a refused switch sets no ss_mode cookie");
    const ok = await call("/api/mode", { method: "POST", token: tCollege, body: { mode: "COLLEGE" } });
    check(ok.status === 200 && ok.json?.data?.mode === "COLLEGE", `POST /api/mode {COLLEGE} → 200 (got ${ok.status})`);
    check(cookieAttrs(ok.setCookies, "ss_mode")?.value === "COLLEGE", "the cookie is set to COLLEGE");
  }

  /* -------------------------------------------------------------- 3. BOTH */
  console.log("\n### 3. BOTH tenant");
  {
    const me = await call("/api/auth/me", { token: tBoth });
    check(JSON.stringify(me.json?.data?.allowedModes) === '["SCHOOL","COLLEGE"]', `allowedModes = ["SCHOOL","COLLEGE"] (got ${JSON.stringify(me.json?.data?.allowedModes)})`);
    check(me.json?.data?.school?.institutionType === "BOTH", "the switcher is available (institutionType === BOTH)");
    check(me.json?.data?.mode === "SCHOOL", `default mode is SCHOOL with no lastMode and no cookie (got ${me.json?.data?.mode})`);
    check((await call("/api/auth/me", { token: tBothLast })).json?.data?.mode === "COLLEGE", "a valid lastMode is honoured (COLLEGE)");
    check((await call("/api/auth/me", { token: tBothBad })).json?.data?.mode === "SCHOOL", "an invalid lastMode falls back to SCHOOL");
    check((await call("/api/auth/me", { token: tBoth, mode: "COLLEGE" })).json?.data?.mode === "COLLEGE", "ss_mode=COLLEGE selects College for a BOTH tenant");
    check((await call("/api/auth/me", { token: tBoth, mode: "NOPE" })).json?.data?.mode === "SCHOOL", "an unknown ss_mode value is ignored");
  }

  /* ----------------------------------------------------------- 4. POST /api/mode */
  console.log("\n### 4. POST /api/mode");
  {
    const before = (await modeSwitchAudits(U("switch"))).length;

    // The write guard is genuinely active for this tenant…
    const locked = await call("/api/routine-config", {
      method: "PUT",
      token: tSwitch,
      body: { config: { days: [0], periods: [{ period: 1, start: "09:00", end: "09:45" }] } },
    });
    check(locked.status === 402, `an ordinary write on this locked tenant → 402 (got ${locked.status})`);

    // …but a mode switch is exempt from it.
    const ok = await call("/api/mode", { method: "POST", token: tSwitch, body: { mode: "COLLEGE" } });
    check(ok.status === 200 && ok.json?.data?.mode === "COLLEGE", `POST /api/mode {COLLEGE} → 200 despite the lock (got ${ok.status})`);
    const c = cookieAttrs(ok.setCookies, "ss_mode");
    check(!!c, "ss_mode cookie is set");
    check(c?.flags.httponly === true, "cookie is HttpOnly");
    check(String(c?.flags.samesite || "").toLowerCase() === "lax", "cookie is SameSite=Lax");
    check(c?.flags.path === "/", "cookie path is /");
    // The cookie's Secure flag follows the *server's* NODE_ENV, which is not
    // always this script's own. When the suite is pointed at a production
    // build (`next start`) say so with SERVER_NODE_ENV=production.
    const prod = (process.env.SERVER_NODE_ENV || process.env.NODE_ENV) === "production";
    check(
      prod ? c?.flags.secure === true : c?.flags.secure === undefined,
      `Secure matches the server's mode (${prod ? "production" : "development"})`,
    );

    const stored = await db.collection("users").doc(U("switch")).get();
    check(stored.data()?.lastMode === "COLLEGE", `users.lastMode persisted = COLLEGE (got ${stored.data()?.lastMode})`);

    const audits = await modeSwitchAudits(U("switch"));
    check(audits.length === before + 1, `exactly one new MODE_SWITCH audit (${before} → ${audits.length})`);
    const latest = audits
      .map((d) => d.data())
      .sort((a, b) => ((a.createdAt?.toMillis?.() ?? 0) - (b.createdAt?.toMillis?.() ?? 0)))
      .pop();
    check(latest?.entity === "user" && latest?.entityId === U("switch"), `audit targets the user (entity=${latest?.entity}, entityId=${latest?.entityId})`);
    check(latest?.details?.from === "SCHOOL" && latest?.details?.to === "COLLEGE", `audit records {from:SCHOOL,to:COLLEGE} (got ${JSON.stringify(latest?.details)})`);
    check(!("ss_mode" in (latest?.details || {})) && !("token" in (latest?.details || {})), "audit carries no sensitive payload");

    // A same-mode request is a successful no-op and adds no audit noise.
    const noop = await call("/api/mode", { method: "POST", token: tSwitch, mode: "COLLEGE", body: { mode: "COLLEGE" } });
    check(noop.status === 200 && noop.json?.data?.mode === "COLLEGE", `re-selecting the current mode → 200 (got ${noop.status})`);
    const afterNoop = (await modeSwitchAudits(U("switch"))).length;
    check(afterNoop === audits.length, `a no-op adds no audit (${audits.length} → ${afterNoop})`);

    // Invalid / missing / disallowed → 400, no cookie, no audit.
    const inv = await call("/api/mode", { method: "POST", token: tSwitch, body: { mode: "HISTORY" } });
    check(inv.status === 400, `an unknown mode → 400 (got ${inv.status})`);
    check(cookieAttrs(inv.setCookies, "ss_mode") === null, "a rejected (unknown) request sets no cookie");
    const missing = await call("/api/mode", { method: "POST", token: tSwitch, body: {} });
    check(missing.status === 400, `a missing mode → 400 (got ${missing.status})`);
    const empty = await call("/api/mode", { method: "POST", token: tSwitch, body: { mode: "" } });
    check(empty.status === 400, `an empty mode → 400 (got ${empty.status})`);
    const disallowed = await call("/api/mode", { method: "POST", token: tLegacy, body: { mode: "COLLEGE" } });
    check(disallowed.status === 400, `a disallowed mode → 400 (got ${disallowed.status})`);
    check(cookieAttrs(disallowed.setCookies, "ss_mode") === null, "a rejected (disallowed) request sets no cookie");

    const afterRej = await modeSwitchAudits(U("switch"));
    check(afterRej.length === audits.length, `rejected requests create no MODE_SWITCH audit (${audits.length} → ${afterRej.length})`);
    const stored2 = await db.collection("users").doc(U("switch")).get();
    check(stored2.data()?.lastMode === "COLLEGE", "a rejected switch does not overwrite lastMode");

    const anon = await call("/api/mode", { method: "POST", body: { mode: "COLLEGE" } });
    check(anon.status === 401, `unauthenticated → 401 (got ${anon.status})`);
  }

  /* --------------------------------------------------- 5. cache separation */
  console.log("\n### 5. BOTH: School vs College separation (settings keys, stats/exams)");
  {
    // Write the marker under TODAY'S SCHOOL key for the BOTH tenant.
    await db.collection("settings").doc(`set_grading_scheme_${BOTH}`).set({ key: `grading_scheme_${BOTH}`, value: MARKER_SCHEME });
    await db.collection("settings").doc(`set_routine_config_${BOTH}`).set({ key: `routine_config_${BOTH}`, value: MARKER_ROUTINE });
    await db.collection("academicSessions").doc(ASM).set({ schoolId: BOTH, name: "ZZ 2026", isCurrent: false, startDate: new Date() });
    await db.collection("settings").doc(`set_school.${BOTH}.current_session`).set({ key: `school.${BOTH}.current_session`, value: ASM });

    const sSchool = await call("/api/grading-scheme", { token: tBoth, mode: "SCHOOL" });
    const sCollege = await call("/api/grading-scheme", { token: tBoth, mode: "COLLEGE" });
    check(sSchool.json?.data?.scheme?.name === MARKER_SCHEME.name, `SCHOOL mode reads the SCHOOL grading key (got ${sSchool.json?.data?.scheme?.name})`);
    check(sCollege.json?.data?.scheme?.name !== MARKER_SCHEME.name, `COLLEGE mode does not read the SCHOOL grading key (got ${sCollege.json?.data?.scheme?.name})`);

    const rSchool = await call("/api/routine-config", { token: tBoth, mode: "SCHOOL" });
    const rCollege = await call("/api/routine-config", { token: tBoth, mode: "COLLEGE" });
    check(JSON.stringify(rSchool.json?.data?.config?.days) === JSON.stringify(MARKER_DAYS), `SCHOOL mode reads the SCHOOL routine key (got ${JSON.stringify(rSchool.json?.data?.config?.days)})`);
    check(JSON.stringify(rCollege.json?.data?.config?.days) !== JSON.stringify(MARKER_DAYS), `COLLEGE mode does not read the SCHOOL routine key (got ${JSON.stringify(rCollege.json?.data?.config?.days)})`);

    const aSchool = await call("/api/academic-sessions", { token: tBoth, mode: "SCHOOL" });
    const aCollege = await call("/api/academic-sessions", { token: tBoth, mode: "COLLEGE" });
    const cur = (r) => (r.json?.data || []).some((s) => s.id === ASM && s.isCurrent);
    check(cur(aSchool), "SCHOOL mode reads the current session from the SCHOOL pointer key");
    check(!cur(aCollege), "COLLEGE mode does not read the SCHOOL pointer key");

    const st1 = await call("/api/stats", { token: tBoth, mode: "SCHOOL" });
    const st2 = await call("/api/stats", { token: tBoth, mode: "COLLEGE" });
    check(st1.status === 200 && !!st1.json?.data, `stats in SCHOOL mode → 200 (got ${st1.status})`);
    check(st2.status === 200 && !!st2.json?.data, `stats in COLLEGE mode → 200 (got ${st2.status})`);
    const ex1 = await call("/api/exams", { token: tBoth, mode: "SCHOOL" });
    const ex2 = await call("/api/exams", { token: tBoth, mode: "COLLEGE" });
    check(ex1.status === 200 && Array.isArray(ex1.json?.data), `exams in SCHOOL mode → 200 (got ${ex1.status})`);
    check(ex2.status === 200 && Array.isArray(ex2.json?.data), `exams in COLLEGE mode → 200 (got ${ex2.status})`);
  }

  /* -------------------------------------------- 6. institutionType / authz */
  console.log("\n### 6. institutionType is platform-only; mode is not a grant");
  {
    const patch = await call(`/api/schools/${LEGACY}`, { method: "PATCH", token: tLegacy, body: { institutionType: "BOTH" } });
    check(patch.status === 403, `a school admin cannot change institutionType → 403 (got ${patch.status})`);
    check((await db.collection("schools").doc(LEGACY).get()).data()?.institutionType === undefined, "the tenant's institutionType is unchanged after the refusal");

    const sw = await call("/api/mode", { method: "POST", token: tLegacy, body: { mode: "COLLEGE" } });
    check(sw.status === 400, `a SCHOOL tenant cannot switch into College → 400 (got ${sw.status})`);
    check((await db.collection("schools").doc(LEGACY).get()).data()?.institutionType === undefined, "a refused mode switch never changes institutionType");
  }

  /* ------------------------------------------------- 7. SCHOOL compatibility */
  console.log("\n### 7. SCHOOL tenant backward compatibility");
  {
    await db.collection("settings").doc(`set_grading_scheme_${LEGACY}`).set({ key: `grading_scheme_${LEGACY}`, value: MARKER_SCHEME });
    await db.collection("settings").doc(`set_routine_config_${LEGACY}`).set({ key: `routine_config_${LEGACY}`, value: MARKER_ROUTINE });
    await db.collection("academicSessions").doc(`${ASM}-legacy`).set({ schoolId: LEGACY, name: "ZZ 2026", isCurrent: false, startDate: new Date() });
    await db.collection("settings").doc(`set_school.${LEGACY}.current_session`).set({ key: `school.${LEGACY}.current_session`, value: `${ASM}-legacy` });

    const s = await call("/api/grading-scheme", { token: tLegacy });
    check(s.json?.data?.scheme?.name === MARKER_SCHEME.name, `reads its scheme from today's exact key grading_scheme_<id> (got ${s.json?.data?.scheme?.name})`);
    const r = await call("/api/routine-config", { token: tLegacy });
    check(JSON.stringify(r.json?.data?.config?.days) === JSON.stringify(MARKER_DAYS), `reads its routine config from today's exact key routine_config_<id> (got ${JSON.stringify(r.json?.data?.config?.days)})`);
    const a = await call("/api/academic-sessions", { token: tLegacy });
    check((a.json?.data || []).some((x) => x.id === `${ASM}-legacy` && x.isCurrent), "reads its current session from today's exact key school.<id>.current_session");

    const me = await call("/api/auth/me", { token: tLegacy });
    check(me.json?.data?.school?.institutionType !== "BOTH", "a SCHOOL tenant's URLs stay unscoped (no ?mode=) — institutionType !== BOTH");
  }
} finally {
  await cleanup();
  // Confirm the fixtures are gone.
  const leftover = [];
  for (const id of [LEGACY, COLLEGE, BOTH]) {
    const d = await db.collection("schools").doc(id).get().catch(() => null);
    if (d?.exists) leftover.push(`schools/${id}`);
  }
  for (const id of USER_IDS) {
    const d = await db.collection("users").doc(id).get().catch(() => null);
    if (d?.exists) leftover.push(`users/${id}`);
  }
  const audits = await db.collection("auditLogs").where("action", "==", "MODE_SWITCH").get().catch(() => null);
  if (audits) for (const d of audits.docs) if (USER_IDS.includes(d.data().userId)) leftover.push(`auditLogs/${d.id}`);
  console.log(`\n### cleanup`);
  check(leftover.length === 0, leftover.length ? `fixtures removed (left over: ${leftover.join(", ")})` : "all fixtures removed — emulator baseline restored");
}

const line = "─".repeat(60);
console.log(`\n${line}`);
console.log(failures === 0 ? `✅ mode-foundation verification PASSED` : `❌ mode-foundation verification FAILED (${failures} check${failures === 1 ? "" : "s"})`);
console.log(line);
process.exit(failures === 0 ? 0 : 1);
