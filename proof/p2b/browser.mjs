/**
 * browser.mjs — pilot P2b browser proof, ONE CDP driver (`scripts/lib/headless.mjs`).
 *
 * Proves over the real UI, in a real browser:
 *   1. a DOUBLE-click on the intake form's Submit creates exactly ONE student
 *      (one key per attempt, one POST — counted from the network, not inferred);
 *   2. the Submit button is DISABLED and reads "Admitting…" while that request is
 *      in flight (the network is slowed so the state is observable);
 *   3. the desk still lands on the success screen with the receipt and QR slip.
 *
 * PNGs + each PNG's DOM text go to proof/p2b/.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";

const REPO = process.cwd();
const { launch } = await import(pathToFileURL(`${REPO}/scripts/lib/headless.mjs`).href);
const { loadEnv } = await import(pathToFileURL(`${REPO}/scripts/load-env.mjs`).href);
const { requireEmulator } = await import(pathToFileURL(`${REPO}/scripts/lib/guard.mjs`).href);
loadEnv();
requireEmulator(); // this script deletes documents — emulator only
const { initializeApp } = await import("firebase-admin/app");
const { getFirestore } = await import("firebase-admin/firestore");

const ORIGIN = process.env.P2B_ORIGIN || "http://127.0.0.1:3000";
const OUT = "proof/p2b";
const ADMIN = { id: "principal@sunrise.edu", pw: "School@123" };
const stamp = `P2BUI${Date.now().toString(36)}`;
const NAME = `P2b Browser ${stamp}`;
const PHONE = "01710990001";
const EMAIL = `p2b.${stamp.toLowerCase()}@example.com`;

mkdirSync(OUT, { recursive: true });

let n = 0;
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${++n}. ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

const api = async (path, { cookie, ...init } = {}) => {
  const res = await fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* html */
  }
  return { status: res.status, data: body?.data ?? null, error: body?.error ?? null, setCookie: res.headers.get("set-cookie") || "" };
};

const login = await api("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: ADMIN.id, password: ADMIN.pw }) });
if (login.status !== 200) throw new Error(`login failed: HTTP ${login.status} ${login.error || ""}`);
const cookie = login.setCookie.split(";")[0];
const cookieName = cookie.split("=")[0];
const token = cookie.slice(cookieName.length + 1);
const me = await api("/api/auth/me", { cookie });
const schoolId = me.data?.user?.schoolId || me.data?.school?.id;
if (!schoolId) throw new Error("could not resolve the demo school");

const db = getFirestore(initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID }, "p2b-browser"));
const countStudents = async () => (await db.collection("students").where("schoolId", "==", schoolId).count().get()).data().count;
const studentsBefore = await countStudents();

const browser = await launch();
if (!browser) throw new Error("no drivable Chrome/Edge found");
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });
await page.setCookie({ name: cookieName, value: token, url: ORIGIN });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const textOf = () => page.evaluate("document.body.innerText");
/** The lines of a page's text that carry the proof (skips the Shell's own nav). */
const focus = (text) => {
  const all = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const from = all.findIndex((l) => /New Admission|Student information/.test(l));
  const slice = from > -1 ? all.slice(from) : all.slice(-40);
  return slice.join(" · ").slice(0, 400);
};
const shot = async (name) => {
  const { data } = await page.send("Page.captureScreenshot", { format: "png" });
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(data, "base64"));
  return textOf();
};
const clickAt = async (x, y, clickCount = 1) => {
  await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount });
  await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount });
};

/* Count the POSTs the browser itself sends — the only honest way to show that a
   double-click produced ONE request. */
const posts = [];
const listener = (params) => {
  if (params?.request?.method === "POST" && String(params.request.url).includes("/api/admissions/intake")) posts.push(params.request.url);
};
const bucket = page.conn.listeners.get("Network.requestWillBeSent") || [];
bucket.push(listener);
page.conn.listeners.set("Network.requestWillBeSent", bucket);

const setField = (label, value) =>
  page.evaluate(`(() => {
    const lab = [...document.querySelectorAll("label.label")].find((l) => l.textContent.trim() === ${JSON.stringify(label)});
    if (!lab) return "no label";
    const el = lab.parentElement.querySelector("input, select, textarea");
    if (!el) return "no field";
    const proto = Object.getPrototypeOf(el);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    desc.set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return el.value;
  })()`);

/* --------------------------------------------------- 1. the form, equipped --- */
await page.goto(`${ORIGIN}/dashboard/students/new`);
const ready = await page.waitFor('!!document.querySelector(".ss-admission-cta")', 30000);
check("the intake form rendered in the browser", ready);
const classesLoaded = await page.waitFor('(() => { const l = [...document.querySelectorAll("label.label")].find(x => x.textContent.trim() === "Class *"); return !!l && l.parentElement.querySelectorAll("select option").length > 1; })()', 30000);
check("the form loaded this school's classes", classesLoaded);

const nameSet = await setField("Full name *", NAME);
check("the Full name field takes the typed name", nameSet === NAME, `value=${JSON.stringify(nameSet)}`);
const classSet = await page.evaluate(`(() => {
  const lab = [...document.querySelectorAll("label.label")].find((l) => l.textContent.trim() === "Class *");
  const sel = lab.parentElement.querySelector("select");
  if (!sel) return null;
  const opt = [...sel.options].find((o) => o.value);
  if (!opt) return null;
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set.call(sel, opt.value);
  sel.dispatchEvent(new Event("change", { bubbles: true }));
  return opt.textContent.trim();
})()`);
check("a class is chosen (fee defaults + kit follow)", !!classSet, `class=${classSet}`);
await setField("Phone", PHONE);
// The form ships with "create the guardian login" ON, so an email is required —
// without it submit() stops client-side and never reaches the server.
const emailSet = await setField("Email", EMAIL);
check("the guardian email takes the typed address (the form requires one)", emailSet === EMAIL, `value=${JSON.stringify(emailSet)}`);
await setField("Admission fee (৳)", "500");
const collectTicked = await page.evaluate(`(() => {
  const lab = [...document.querySelectorAll("label")].find((l) => /Collect the admission fee now/.test(l.textContent));
  const box = lab && lab.querySelector('input[type="checkbox"]');
  if (!box) return false;
  if (!box.checked) box.click();
  return box.checked;
})()`);
check("Collect the admission fee now is ticked (the payment rides the same submit)", collectTicked);
await sleep(600);
const filledText = await shot("01-form-filled");

/* ----------------------------- 2. double-click, observed in flight ---------- */
await page.send("Network.emulateNetworkConditions", { offline: false, latency: 1200, downloadThroughput: 300000, uploadThroughput: 300000 });
await sleep(300);
const rect = await page.evaluate(`(() => {
  const b = document.querySelector(".ss-admission-cta");
  if (!b) return null;
  b.scrollIntoView({ block: "center" });
  const r = b.getBoundingClientRect();
  const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
  const hit = document.elementFromPoint(cx, cy);
  return { x: cx, y: cy, disabled: b.disabled, label: b.textContent.trim(), hitIsButton: !!hit && b.contains(hit) };
})()`);
check("the Submit button is clickable before the first press", !!rect && rect.disabled === false, JSON.stringify(rect));
check("nothing is covering the Submit button (the click lands on it)", rect?.hitIsButton === true, `hitIsButton=${rect?.hitIsButton}`);

await clickAt(rect.x, rect.y, 1);
await clickAt(rect.x, rect.y, 2);
await sleep(400);
const inFlight = await page.evaluate(`(() => {
  const b = document.querySelector(".ss-admission-cta");
  if (!b) return { gone: true };
  return { disabled: b.disabled, label: b.textContent.trim() };
})()`);
check("the Submit button is DISABLED while the request is in flight", inFlight?.disabled === true, JSON.stringify(inFlight));
check("the button reads \"Admitting…\" in flight", /Admitting/.test(inFlight?.label || ""), `"${inFlight?.label}"`);
const flightText = await shot("02-in-flight-disabled");
await page.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

const admitted = await page.waitFor('document.body.innerText.includes("Student admitted")', 90000);
if (!admitted && posts.length === 0) {
  const shown = await page.evaluate('document.body.innerText');
  console.log("   [debug] no POST left the browser; the form showed:\n" + shown.split("\n").filter((l) => /required|Choose|needed|more than|error/i.test(l)).join("\n"));
}
check("the desk lands on the success screen", admitted);
await sleep(400);
const successText = await shot("03-admitted-once");

/* ------------------------------------------------- 3. exactly one student ---- */
check("the browser sent exactly ONE intake POST for the double-click", posts.length === 1, `${posts.length} POST(s)`);
const studentsAfter = await countStudents();
check("the roster grew by exactly ONE student", studentsAfter - studentsBefore === 1, `${studentsBefore} → ${studentsAfter}`);
const roster = await api("/api/students", { cookie });
const matches = (roster.data || []).filter((s) => s.name === NAME);
check("the roster holds the new student exactly once", matches.length === 1, `${matches.length} match(es) for ${NAME}`);
check(
  "the success screen shows the student, the receipt and the QR slip",
  new RegExp(NAME).test(successText) && /Paid/.test(successText) && /QR PIN/.test(successText),
  focus(successText.split(/\r?\n/).filter((l) => new RegExp(`${NAME}|Paid |RCP-|QR PIN|Student admitted`).test(l)).join(" · ")) || "no success markers"
);
const admissionRows = await db.collection("admissions").where("schoolId", "==", schoolId).where("fullName", "==", NAME).get();
check("exactly ONE admission row was written for it", admissionRows.size === 1, `${admissionRows.size} row(s)`);

/* ---------------------------------------------------------------- cleanup ---- */
const studentId = matches[0]?.id;
const admissionId = admissionRows.docs[0]?.id;
let removed = 0;
// The guardian login this run minted (createGuardian is on by default).
const guardianUsers = await db.collection("users").where("email", "==", EMAIL).get();
for (const u of guardianUsers.docs) {
  await u.ref.delete();
  removed++;
}
if (studentId) {
  for (const col of ["fees", "payments", "ledger", "bookIssues", "discounts"]) {
    const rows = await db.collection(col).where("studentId", "==", studentId).get();
    for (const row of rows.docs) {
      await row.ref.delete();
      removed++;
    }
  }
  await db.collection("students").doc(studentId).delete();
  removed++;
}
if (admissionId) {
  await db.collection("admissions").doc(admissionId).delete();
  removed++;
}
const notes = await db.collection("notifications").where("schoolId", "==", schoolId).where("title", "==", "Admission completed at the desk").get();
for (const note of notes.docs) {
  await note.ref.delete();
  removed++;
}
const studentsEnd = await countStudents();
check("the browser run cleaned up after itself", studentsEnd === studentsBefore, `${studentsBefore} → ${studentsEnd} (removed ${removed} record(s))`);

/* --------------------------------------------------------------- the report -- */
const report = [
  "# pilot P2b — browser proof (one Chrome over CDP, `proof/p2b/`)",
  "",
  `Emulator only (\`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080\`, project \`demo-ss-test\`), app on \`${ORIGIN}\`, driver \`scripts/lib/headless.mjs\` (one browser, one page, 1280×1000).`,
  "",
  `${n - failures}/${n} browser checks (\`BROWSER PROOF ${failures === 0 ? "COMPLETE" : "INCOMPLETE"}\`, exit ${failures === 0 ? 0 : 1}).`,
  "",
  "| PNG | DOM text captured with it |",
  "|---|---|",
  `| \`01-form-filled.png\` | \`${focus(filledText)}\` |`,
  `| \`02-in-flight-disabled.png\` | button \`"${inFlight?.label}"\`, \`disabled=${inFlight?.disabled}\` while the request was in flight · \`${focus(flightText)}\` |`,
  `| \`03-admitted-once.png\` | \`${focus(successText)}\` |`,
  "",
  `Double-clicking Submit sent **${posts.length}** POST to \`/api/admissions/intake\` and created **${studentsAfter - studentsBefore}** student (${studentsAfter - studentsBefore === 1 ? "one admission, one fee set, one receipt" : "UNEXPECTED"}), with the button \`disabled=${inFlight?.disabled}\` / \`"${inFlight?.label}"\` while the request was in flight.`,
  "",
].join("\n");
writeFileSync(`${OUT}/BROWSER-PROOF.md`, report);
writeFileSync(`${OUT}/browser-dom-text.md`, [
  "# DOM text behind each P2b browser PNG",
  "",
  "## 01-form-filled.png",
  "```",
  filledText.slice(0, 4000),
  "```",
  "",
  "## 02-in-flight-disabled.png",
  "```",
  flightText.slice(0, 4000),
  "```",
  "",
  "## 03-admitted-once.png",
  "```",
  successText.slice(0, 4000),
  "```",
  "",
].join("\n"));

console.log(`\n${failures === 0 ? "BROWSER PROOF COMPLETE" : `${failures} BROWSER CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
