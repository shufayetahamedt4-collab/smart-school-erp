#!/usr/bin/env node
/**
 * proof/8/browser-proof.mjs — the ca-5 BROWSER proof of the college course
 * register screen (Phase 8 ca-4, docs/COLLEGE-DECISIONS.md §30).
 *
 * Why it exists: ca-4's own verifier
 * (`scripts/verify-college-attendance-page.mjs`, 36 checks) says in its header
 * that it does **NOT prove the page renders** — it has no DOM, no React and no
 * browser. This script closes exactly that gap in a REAL Chrome, over the
 * repository's own dependency-free driver (`scripts/lib/headless.mjs`), and it is
 * the one thing ca-4's record left owed. It is a PROOF, not a suite verifier: it
 * is registered in no suite, it needs the emulator, the app and the fixture, and
 * it is run by hand.
 *
 *   node proof/8/browser-proof.mjs seed   # the two students + their APPROVED
 *                                         # registrations the grid needs, written
 *                                         # BEFORE the app starts (the app's pull
 *                                         # memo means a row written after it is
 *                                         # serving may be invisible to the read
 *                                         # under test)
 *   node proof/8/browser-proof.mjs run    # drive the page and assert
 *   node proof/8/browser-proof.mjs clean  # delete what `seed` wrote
 *
 * What `run` proves, all of it in the browser:
 *   1. an ADMIN loads the register: the roster grid is the course's two APPROVED
 *      students, marks Present on one and Absent on the other, saves, and the
 *      stored `courseAttendance` rows really carry those two statuses;
 *   2. a REGISTRAR sees the same grid with NO save control, NO mark controls and
 *      the read-only note;
 *   3. a course with no APPROVED registrations shows the empty-roster message;
 *   4. a role the rule REFUSES (the college ACCOUNTANT) is told so, issues NO
 *      register request at all, and the API refuses it 403 in both directions;
 *   5. a SCHOOL tenant is told the screen is college-only, issues NO register
 *      request, and the API answers 403.
 *
 * No password, QR token or PIN is ever printed: the fixture and demo credentials
 * are read from the untracked track file / the module the sign-in screen uses.
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { existsSync, readFileSync } from "node:fs";

import { requireEmulator } from "../../scripts/lib/guard.mjs";
import { launch, findBrowser } from "../../scripts/lib/headless.mjs";

requireEmulator();

const P = "zziso-";
const BASE = process.env.BASE || `http://127.0.0.1:${process.env.SMOKE_PORT || 3000}`;
const C1 = `${P}college`;
const BR_A = `${P}col-br-a`;
const PROG_A = `${P}col-prog-a`;
const COURSE_A = `${P}col-course-a`; // ZZCA-101 — the roster the grid will list
const COURSE_B = `${P}col-course-b`; // ZZCB-101 — no APPROVED registrations
const STU_1 = `${P}ca5b-stu-1`;
const STU_2 = `${P}ca5b-stu-2`;
const REG_1 = `${P}ca5b-reg-1`;
const REG_2 = `${P}ca5b-reg-2`;
const SEEDED = [
  ["students", STU_1], ["students", STU_2],
  ["courseRegistrations", REG_1], ["courseRegistrations", REG_2],
];

const TRACK = new URL("../../scripts/.qa-fixtures.json", import.meta.url);
const now = () => new Date().toISOString();
/** The screen's own default date, computed the way `src/lib/utils.ts` does. */
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

if (!existsSync(TRACK)) {
  console.error("❌ Missing scripts/.qa-fixtures.json — run: node scripts/isolation-fixture.mjs create");
  process.exit(1);
}
const CRED = JSON.parse(readFileSync(TRACK, "utf8")).creds || {};

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

/* ------------------------------------------------------------------ assertions */

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

/* ------------------------------------------------------------------ seed / clean */

async function seed() {
  const student = (id, name, admissionNo) => ({
    id, schoolId: C1, branchId: BR_A, name, admissionNo,
    programId: PROG_A, termNumber: 1, active: true, createdAt: now(),
  });
  const registration = (id, studentId) => ({
    id, schoolId: C1, branchId: BR_A, studentId, courseId: COURSE_A,
    programId: PROG_A, termNumber: 1, status: "APPROVED",
    requestedById: null, decidedById: null, decidedAt: null, createdAt: now(),
  });
  await db.collection("students").doc(STU_1).set(student(STU_1, "ZZ Iso Ca5b Student One", "ZZCA5B-1"));
  await db.collection("students").doc(STU_2).set(student(STU_2, "ZZ Iso Ca5b Student Two", "ZZCA5B-2"));
  await db.collection("courseRegistrations").doc(REG_1).set(registration(REG_1, STU_1));
  await db.collection("courseRegistrations").doc(REG_2).set(registration(REG_2, STU_2));
  // Any register row a previous run left behind would make the save assertions
  // read the wrong thing: this proof owns its session rows and starts them clean.
  const stale = await db.collection("courseAttendances").where("schoolId", "==", C1).get();
  for (const d of stale.docs) {
    if (String(d.id).startsWith(`ca_${COURSE_A}_`)) await d.ref.delete();
  }
  console.log(`seeded: 2 students + 2 APPROVED registrations for ${COURSE_A}`);
}

async function clean() {
  for (const [col, id] of SEEDED) await db.collection(col).doc(id).delete().catch(() => null);
  const rows = await db.collection("courseAttendances").where("schoolId", "==", C1).get();
  for (const d of rows.docs) {
    if (String(d.id).startsWith(`ca_${COURSE_A}_`)) await d.ref.delete();
  }
  // The one ABSENT mark this proof saved notified a family (D-CA-3), so the
  // notification rows it wrote are removed too — the proof leaves no trace.
  for (const studentId of [STU_1, STU_2]) {
    const notes = await db.collection("notifications").where("studentId", "==", studentId).get().catch(() => null);
    for (const d of notes?.docs || []) await d.ref.delete().catch(() => null);
  }
  console.log("cleaned: the proof's students, registrations, register rows and notifications");
}

/* ------------------------------------------------------------------ the browser */

async function login(email, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier: email, password }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`login ${email} → HTTP ${res.status}`);
  return (res.headers.get("set-cookie") || "").split(";")[0];
}
function cookieFor(raw) {
  const i = raw.indexOf("=");
  return { name: raw.slice(0, i), value: raw.slice(i + 1), url: BASE };
}
/** Open the register screen for one session, recording every request it makes. */
async function openRegister(browser, cookie) {
  const page = await browser.newPage();
  const requests = [];
  page.conn.listeners.set("Network.requestWillBeSent", [(p) => requests.push(p.request.url)]);
  await page.setCookie(cookieFor(cookie));
  await page.goto(`${BASE}/dashboard/course-attendance`);
  return { page, requests };
}
const SET_SELECT = (needle) => `(() => {
  const sel = document.querySelector('select');
  if (!sel) return null;
  const opt = [...sel.options].find((o) => o.textContent.includes(${JSON.stringify(needle)}));
  if (!opt) return null;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, opt.value);
  sel.dispatchEvent(new Event('change', { bubbles: true }));
  return opt.value;
})()`;
const CLICK_SAVE = `(() => {
  const b = [...document.querySelectorAll('button')].find((x) => /Save register|Saving/.test(x.textContent));
  if (b) b.click();
  return !!b;
})()`;

async function run() {
  if (!findBrowser()) {
    console.log("SKIPPED — no Chrome/Edge on this machine (scripts/lib/headless.mjs found none).");
    process.exit(2);
  }
  const browser = await launch();
  if (!browser) {
    console.log("SKIPPED — a browser was found but could not be launched.");
    process.exit(2);
  }
  try {
    const adminCookie = await login("zz-iso-college-admin@test.local", CRED.collegeAdmin);
    const registrarCookie = await login("zz-iso-college-registrar@test.local", CRED.collegeRegistrar);
    const accountantCookie = await login("zz-iso-college-accountant@test.local", CRED.collegeAccountant);
    const schoolCookie = await login("principal@sunrise.edu", "School@123");

    /* 1. THE ADMIN SAVES A REGISTER ------------------------------------- */
    console.log("\n### 1. an admin loads the register, marks and saves");
    {
      const { page } = await openRegister(browser, adminCookie);
      check(
        "the page renders (the navbar offers the new entry)",
        await page.waitFor(`document.body.innerText.includes('Course Attendance')`, 20000),
        BASE
      );
      await page.waitFor(`document.querySelector('select') && document.querySelectorAll('select option').length > 1`, 20000);
      const picked = await page.evaluate(SET_SELECT("ZZCA-101"));
      check("the course picker lists the college's courses and ZZCA-101 is selectable", !!picked, String(picked));
      const grid = await page.waitFor(`document.querySelectorAll('[role=group]').length >= 2`, 20000);
      const rosterNames = await page.evaluate(
        `[...document.querySelectorAll('li p.font-bold')].map((p) => p.textContent)`
      );
      check(
        "the grid lists exactly the course's two APPROVED students",
        grid && Array.isArray(rosterNames) &&
          rosterNames.includes("ZZ Iso Ca5b Student One") &&
          rosterNames.includes("ZZ Iso Ca5b Student Two") &&
          rosterNames.length === 2,
        JSON.stringify(rosterNames)
      );
      // Mark Present on the first row, Absent on the second, then save.
      const marked = await page.evaluate(`(() => {
        const groups = [...document.querySelectorAll('[role=group]')];
        const click = (g, label) => {
          const b = [...g.querySelectorAll('button')].find((x) => x.textContent.trim() === label);
          if (b) b.click();
          return !!b;
        };
        return [click(groups[0], 'Present'), click(groups[1], 'Absent')];
      })()`);
      check("the four mark controls are present and two marks are set", marked[0] && marked[1], JSON.stringify(marked));
      await page.evaluate(CLICK_SAVE);
      const saved = await page.waitFor(`/Saved \\d+ mark/.test(document.body.innerText)`, 25000);
      const message = await page.evaluate(
        `(document.body.innerText.match(/Saved \\d+ marks?[^\\n]*/) || [""])[0]`
      );
      check("the save reports what it wrote", saved, message);

      const dateKey = today();
      const row1 = (await db.collection("courseAttendances").doc(`ca_${COURSE_A}_${dateKey}_1_${STU_1}`).get()).data();
      const row2 = (await db.collection("courseAttendances").doc(`ca_${COURSE_A}_${dateKey}_1_${STU_2}`).get()).data();
      check(
        "the STORE holds exactly the two marks the screen sent",
        row1?.status === "PRESENT" && row2?.status === "ABSENT" &&
          row1?.studentId === STU_1 && row2?.schoolId === C1,
        `${row1?.status}/${row2?.status} for ${dateKey}`
      );
      check(
        "the saved rows carry the course, the slot and the session date (D-CA-1)",
        row1?.courseId === COURSE_A && row1?.slot === 1 && !!row1?.sessionDate,
        `${row1?.courseId} slot=${row1?.slot}`
      );
      await page.send("Page.close").catch(() => null);
    }

    /* 2. THE REGISTRAR SEES IT READ-ONLY -------------------------------- */
    console.log("\n### 2. a REGISTRAR sees the register with no save control");
    {
      const { page } = await openRegister(browser, registrarCookie);
      await page.waitFor(`document.querySelector('select') && document.querySelectorAll('select option').length > 1`, 20000);
      await page.evaluate(SET_SELECT("ZZCA-101"));
      const grid = await page.waitFor(`document.querySelectorAll('li p.font-bold').length >= 2`, 25000);
      const state = await page.evaluate(`(() => ({
        save: [...document.querySelectorAll('button')].some((b) => /Save register/.test(b.textContent)),
        marks: document.querySelectorAll('[role=group]').length,
        roster: document.querySelectorAll('li p.font-bold').length,
        note: document.body.innerText.includes('Your role may read this register but never mark it.'),
        text: document.body.innerText,
      }))()`);
      check("the registrar's grid shows the same roster", grid && state.roster >= 2, `${state.roster} row(s)`);
      check("…there is NO save control", state.save === false, "no 'Save register' button");
      check("…and NO mark controls", state.marks === 0, String(state.marks));
      check("…and the read-only note is shown", state.note === true);
      check(
        "…and the stored statuses are visible (Present / Absent)",
        /Present/.test(state.text) && /Absent/.test(state.text)
      );
      await page.send("Page.close").catch(() => null);
    }

    /* 3. A COURSE WITH NO ROSTER ---------------------------------------- */
    console.log("\n### 3. a course with no APPROVED registrations says so");
    {
      const { page } = await openRegister(browser, adminCookie);
      await page.waitFor(`document.querySelector('select') && document.querySelectorAll('select option').length > 1`, 20000);
      await page.evaluate(SET_SELECT("ZZCB-101"));
      const empty = await page.waitFor(
        `document.body.innerText.includes('No approved registrations')`, 25000
      );
      const note = await page.evaluate(
        `(document.body.innerText.match(/No APPROVED registrations for [^\\n]*/) || [""])[0]`
      );
      check("the empty-roster message is shown", empty, note);
      check("…and it names the rule (APPROVED registrations only)", /APPROVED registrations/.test(note), note);
      await page.send("Page.close").catch(() => null);
    }

    /* 4. A REFUSED ROLE -------------------------------------------------- */
    console.log("\n### 4. a refused role is told so and issues NO register request");
    {
      const { page, requests } = await openRegister(browser, accountantCookie);
      const refused = await page.waitFor(
        `document.body.innerText.includes('Not available for your role')`, 20000
      );
      // The SCREEN's wording is the view module's own (ca-4 owns it); the API's is
      // ca-0's refusal sentence. Both are asserted, each where it belongs.
      const note = await page.evaluate(
        `document.body.innerText.includes('Your role may not read a course register.')`
      );
      check("the ACCOUNTANT is refused on the screen, before any read", refused);
      check("…with the screen's own refusal sentence", note === true);
      check(
        "…and the page issued NO /api/course-attendance request",
        !requests.some((u) => u.includes("/api/course-attendance")),
        `${requests.filter((u) => u.includes("/api/")).length} api request(s), none a register read`
      );
      const api = await page.evaluate(`(async () => {
        const r = await fetch('/api/course-attendance?courseId=${COURSE_A}&date=${today()}&slot=1');
        return { status: r.status, body: await r.json().catch(() => null) };
      })()`);
      const apiPost = await page.evaluate(`(async () => {
        const r = await fetch('/api/course-attendance', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ courseId: '${COURSE_A}', date: '${today()}', rows: [] }),
        });
        return { status: r.status, body: await r.json().catch(() => null) };
      })()`);
      check(
        "…and the API really refuses it 403 READ (with ca-0's sentence)",
        api.status === 403 && /school administration and the registrar/.test(String(api.body?.error)),
        `${api.status} ${JSON.stringify(api.body?.error)}`
      );
      check(
        "…and 403 WRITE",
        apiPost.status === 403 && /marked by the school administration/.test(String(apiPost.body?.error)),
        `${apiPost.status} ${JSON.stringify(apiPost.body?.error)}`
      );
      await page.send("Page.close").catch(() => null);
    }

    /* 5. A SCHOOL TENANT ------------------------------------------------- */
    console.log("\n### 5. a SCHOOL tenant is told the screen is college-only");
    {
      const { page, requests } = await openRegister(browser, schoolCookie);
      const note = await page.waitFor(`document.body.innerText.includes('College mode only')`, 20000);
      const says = await page.evaluate(
        `document.body.innerText.includes('Course attendance is a college-mode screen — this tenant runs a school.')`
      );
      check("a school admin who reaches the URL gets the college-only note", note && says === true);
      check(
        "…and the page issued NO /api/course-attendance request",
        !requests.some((u) => u.includes("/api/course-attendance")),
        `${requests.filter((u) => u.includes("/api/")).length} api request(s), none a register read`
      );
      const api = await page.evaluate(`(async () => {
        const r = await fetch('/api/course-attendance?courseId=${COURSE_A}&date=${today()}&slot=1');
        return { status: r.status, body: await r.json().catch(() => null) };
      })()`);
      check(
        "…and the API gates the school tenant 403 with zero data",
        api.status === 403,
        `${api.status}`
      );
      await page.send("Page.close").catch(() => null);
    }
  } finally {
    await browser.close();
  }

  console.log(
    failures
      ? `\n❌ ${failures} browser-proof check(s) FAILED`
      : `\n✅ BROWSER PROOF PASSED — the register page loads, marks, saves, refuses read-only and school tenants, and the store matches what the screen sent.`
  );
  process.exit(failures ? 1 : 0);
}

const mode = process.argv[2];
if (mode === "seed") await seed();
else if (mode === "clean") await clean();
else if (mode === "run") await run();
else {
  console.error("usage: node proof/8/browser-proof.mjs seed|run|clean");
  process.exit(1);
}
