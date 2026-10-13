/**
 * verify-admission-intake-idempotency.mjs — pilot P2b.
 *
 * The bug this locks down (docs/PILOT-FIX-2.md §4): POST /api/admissions/intake
 * wrote a whole family in one action — admission, student, guardian login, family
 * link, fee rows, a payment, kit and a notification — and its ONLY duplicate
 * guard was a read-then-act pre-read on the guardian's phone + the child's name.
 * Two submits in flight at once both passed that pre-read, so the desk could get
 * two admissions, two students, two fee sets, two receipts/payment rows/ledger
 * entries and the kit handed over twice; and with an EMPTY phone the guard did
 * not run at all.
 *
 * What is checked:
 *
 *   A. OFFLINE PINS on the files this stage may touch
 *        db.ts     — `intakeAdmissionId` is DETERMINISTIC (sha1 of tenant|key, no
 *                    clock, no randomness), keys on the tenant, and the generic
 *                    id machinery does NOT re-id every admission
 *        route     — the key is optional and validated by name, the admission id
 *                    is derived from it, the replay is answered from the record
 *                    BEFORE any pricing/guard/kit work, the create-once gate is a
 *                    real `$guardedUpdate("admission", …)` transaction whose loser
 *                    answers from the winner's row, the payment key is derived
 *                    (no clock), only the key's HASH is stored, a replay writes
 *                    NOTHING, and the keyless path still does the old create
 *        form      — ONE key per attempt, reused on a retry, cleared after a
 *                    success, and the Submit button is disabled in flight
 *        enroll.ts — no intake-key concept leaked into the shared kernel
 *
 *   B. LIVE, against the emulator + a running app, counting every collection
 *      before/after (admissions, students, fees, payments, ledger, bookIssues,
 *      notifications):
 *        (e) a normal single keyed submit with a payment + kit → ONE of each
 *        (b) the same key, sequential replay → 200, `replay: true`, the ORIGINAL
 *            admission/student/receipt/QR slip, and a delta of ZERO everywhere
 *        (h) the same key with a different child → 409, nothing written
 *        (a) two SIMULTANEOUS submits, same key → ONE of each, one winner
 *        (f) a short / whitespace-only key → 400 by name, nothing written
 *        (k)(d) an empty key and no key at all → exactly the old keyless write
 *        (j) the key honoured from `x-idempotency-key`, replay included
 *        (c1) a DIFFERENT key for the same phone+name → the existing duplicate
 *             guard refuses the second one
 *        (c2) the same pair SIMULTANEOUSLY — reported, not asserted: this is the
 *             documented hole the phone+name pre-read leaves open
 *        (g) a retry after a crash (an APPLIED admission with the key's id and a
 *             stale startedAt) → 409 naming the admission, nothing written
 *
 * Usage:
 *   node scripts/verify-admission-intake-idempotency.mjs --offline   # pins only
 *   SMOKE_PORT=3000 node scripts/verify-admission-intake-idempotency.mjs
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

loadEnv();

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(path.join(ROOT, p), "utf8");

let pass = 0;
let fail = 0;
const check = (id, label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  [${id}] ${label}${!ok && detail ? ` — ${detail}` : ""}`);
  if (ok) pass++;
  else fail++;
};
const info = (label) => console.log(`  ....  ${label}`);

/** Strip comments so a pin can never be satisfied by prose. */
const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/[^\n]*/g, "$1");

/**
 * The body of a named function, by brace matching.
 *
 * The opening brace is the first `{` that is NOT the start of a return-type
 * annotation (`): { a: string } {`), so a typed helper is not mistaken for its
 * own signature. Copied from verify-school-fee-idempotency.mjs.
 */
function body(text, nameRe) {
  const m = nameRe.exec(text);
  if (!m) return "";
  let open = -1;
  for (let j = m.index + m[0].length - 1; j < text.length; j++) {
    if (text[j] === "{") {
      const before = text.slice(Math.max(0, j - 60), j);
      if (/:\s*$/.test(before)) continue; // this `{` starts a `): { … }` return type
      open = j;
      break;
    }
  }
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(open, i + 1);
    }
  }
  return "";
}

/* =========================================================== A. OFFLINE PINS */

console.log("\n=== A. offline pins ===\n");

const dbSrc = strip(read("src/lib/db.ts"));
const routeSrc = strip(read("src/app/api/admissions/intake/route.ts"));
const formSrc = strip(read("src/components/AdmissionIntakeForm.tsx"));
const enrollSrc = strip(read("src/lib/enroll.ts"));

// --- db.ts: the id helper is deterministic and tenant-scoped -----------------
const idHelper = body(dbSrc, /export function intakeAdmissionId\s*\(/);
check("off-1", "db.ts exports intakeAdmissionId", /export function intakeAdmissionId/.test(dbSrc));
check("off-2", "intakeAdmissionId derives the id from sha1 (deterministic)", /sha1\(/.test(idHelper), idHelper ? "sha1 found" : "no body");
check(
  "off-3",
  "intakeAdmissionId has NO clock and NO randomness (mutation i)",
  idHelper.length > 0 && !/Math\.random/.test(idHelper) && !/Date\.now/.test(idHelper),
  idHelper.replace(/\s+/g, " ").slice(0, 120)
);
check(
  "off-4",
  "the id is a function of the TENANT and the key (one tenant cannot block another)",
  /\bschoolId\b/.test(idHelper) && /\bkey\b/.test(idHelper)
);
check("off-5", "the id is namespaced apart from the payment ids (`adm_`)", /adm_\$\{sha1\(/.test(idHelper), idHelper.replace(/\s+/g, " ").slice(0, 120));
check(
  "off-6",
  "the GENERIC id machinery does NOT re-id every admission (only the keyed intake is gated)",
  !/model === "admission"/.test(dbSrc),
  "idFor() has an `admission` branch"
);

// --- route: key, derivation, create-once gate, replay answer -----------------
check("off-7", "the replay wait is shorter than the stale (crash) threshold", /REPLAY_WAIT_MS = ([\d_]+)/.test(routeSrc) && /REPLAY_STALE_MS = ([\d_]+)/.test(routeSrc) && Number(routeSrc.match(/REPLAY_WAIT_MS = ([\d_]+)/)[1].replace(/_/g, "")) < Number(routeSrc.match(/REPLAY_STALE_MS = ([\d_]+)/)[1].replace(/_/g, "")));
check(
  "off-8",
  "the key is optional and read from the body OR the x-idempotency-key header",
  /const rawKey = body\?\.idempotencyKey \?\? req\.headers\.get\("x-idempotency-key"\);/.test(routeSrc),
  "no `body?.idempotencyKey ?? req.headers.get(\"x-idempotency-key\")`"
);
check(
  "off-9",
  "an unusable key is refused by NAME (400), never silently ignored",
  /idempotencyKey must be between 8 and 120 characters\./.test(routeSrc) && /status: 400/.test(routeSrc)
);
check(
  "off-10",
  "the admission id is DERIVED from the key (create-once, mutation i)",
  /const attemptAdmissionId = idempotencyKey \? intakeAdmissionId\(schoolId, idempotencyKey\) : null;/.test(routeSrc),
  "the keyed id is still random"
);
check(
  "off-11",
  "the payment key is DERIVED from the intake key with NO clock and NO randomness (mutation iii)",
  /const paymentAttemptKey = idempotencyKey \? `\$\{idempotencyKey\}:admission-fee` : null;/.test(routeSrc),
  "the payment key is not a pure function of the intake key"
);
check(
  "off-12",
  "a keyed request whose attempt exists is answered from the record before any other work (mutation ii)",
  /if \(attemptAdmissionId\) \{[\s\S]{0,160}?const already = await prisma\.admission\.findUnique\(\{ where: \{ id: attemptAdmissionId \} \}\)\.catch\(\(\) => null\);[\s\S]{0,80}?if \(already\) return await answerFromRecord\(already\);/.test(routeSrc),
  "no early replay pre-read"
);
const atPreRead = routeSrc.indexOf("if (already) return await answerFromRecord(already);");
const atKit = routeSrc.indexOf("issueKitAtAdmission({");
const atNotify = routeSrc.indexOf("await notifyUsers({");
check(
  "off-13",
  "the replay return sits BEFORE the kit hand-out and the notification (mutation v)",
  atPreRead > -1 && atKit > -1 && atNotify > -1 && atPreRead < atKit && atPreRead < atNotify,
  `pre-read ${atPreRead}, kit ${atKit}, notify ${atNotify}`
);
check(
  "off-14",
  "the replay return also sits BEFORE the phone+name duplicate guard",
  atPreRead > -1 && atPreRead < routeSrc.indexOf("already enrolled for this guardian phone"),
  `pre-read ${atPreRead}, guard ${routeSrc.indexOf("already enrolled for this guardian phone")}`
);

const fromRecord = body(routeSrc, /const answerFromRecord = async \(row: any\) =>/);
check("off-15", "answerFromRecord has a body", fromRecord.length > 200);
check(
  "off-16",
  "answering a replay WRITES NOTHING — no kit, no notification, no payment (mutation v)",
  fromRecord.length > 0 && !/issueKitAtAdmission\(/.test(fromRecord) && !/notifyUsers\(/.test(fromRecord) && !/confirmPayment\(/.test(fromRecord),
  "the replay path issues kit / notifies / charges"
);
check(
  "off-17",
  "a replay flags itself and is NOT a 201",
  /replay: true/.test(fromRecord) && !/status: 201/.test(fromRecord),
  "the replay answer does not set `replay: true` / claims 201"
);
check(
  "off-18",
  "a keyed attempt that never linked a student is refused by NAME (409) with its state",
  /already started/.test(fromRecord) && /409/.test(fromRecord) && /convertedStudentId/.test(fromRecord)
);
check(
  "off-19",
  "the same key aimed at a different child is refused (409)",
  /This admission key was already used for/.test(fromRecord) && /409/.test(fromRecord)
);
check(
  "off-20",
  "the first write is a real transaction gate — deciding on a MISSING row inserts it (create-once)",
  /prisma\.\$guardedUpdate\(\s*"admission", attemptAdmissionId,/.test(routeSrc) && /current\s*\?\s*\{ ok: false, error: "already recorded" \}/.test(routeSrc),
  'no $guardedUpdate("admission", …) refuse-if-present gate'
);
check(
  "off-21",
  "the loser of the race is answered from the WINNER's row, not re-run",
  /gate\.reason === "REFUSED"\) return await answerFromRecord\(gate\.holder\)/.test(routeSrc)
);
check(
  "off-22",
  "a keyed loser caught by the duplicate guard is answered from its record too",
  /if \(mine\) return await answerFromRecord\(mine\);/.test(routeSrc)
);
check(
  "off-23",
  "only the key's HASH is stored on the row (never the raw key)",
  /intake: \{ keyId: attemptAdmissionId, startedAt: new Date\(\), by: session\.id \}/.test(routeSrc) && !/keyId: idempotencyKey/.test(routeSrc)
);
check(
  "off-24",
  "the KEYLESS path is still exactly the old create (unchanged for every existing caller)",
  /admission = await prisma\.admission\.create\(\{ data: admissionData \}\);/.test(routeSrc) && /if \(attemptAdmissionId\) \{/.test(routeSrc)
);
check(
  "off-25",
  "the admission fee is paid through the existing keyed confirmPayment (caller-supplied key)",
  /const payment = await confirmPayment\(\{[\s\S]{0,400}?idempotencyKey: paymentAttemptKey,/.test(routeSrc),
  "confirmPayment is not called with the derived key"
);
check(
  "off-26",
  "the replay reads the ORIGINAL receipt from the deterministic payment id",
  /schoolPaymentIds\(schoolId, admissionFeeRow\.id, paymentAttemptKey\)\.paymentId/.test(routeSrc)
);
check(
  "off-27",
  "a keyed write says so in its 201, and a keyless caller's response is untouched",
  /\.\.\.\(idempotencyKey \? \{ replay: false \} : \{\}\),/.test(routeSrc)
);
check(
  "off-28",
  "the keyed attempt still mints one QR slip per student (the kernel's own token/pin)",
  /const token = qrToken\(\);/.test(routeSrc) && /enrollStudent\(\{/.test(routeSrc)
);

// --- the form: one key per attempt, reused, button disabled in flight --------
check("off-29", "the form mints a key (crypto.randomUUID with a fallback)", /function newIntakeKey\(\): string \{/.test(formSrc) && /randomUUID/.test(formSrc));
check(
  "off-30",
  "ONE key per attempt, REUSED on a retry of that attempt",
  /const idempotencyKey = attemptKey\.current \|\| \(attemptKey\.current = newIntakeKey\(\)\);/.test(formSrc),
  "the key is re-minted on every press"
);
check("off-31", "the attempt's key is cleared after a success (a new admission is a new attempt)", /attemptKey\.current = "";/.test(formSrc));
check("off-32", "the payload carries the key", /idempotencyKey,/.test(formSrc));
check(
  "off-33",
  "the Submit button is disabled while the request is in flight (mutation iv)",
  /disabled=\{saving \|\|/.test(formSrc),
  "Submit is clickable during the flight"
);
check(
  "off-34",
  "a server refusal is surfaced verbatim and nothing auto-retries",
  /setError\(e\?\.message \|\| "Admission failed"\);/.test(formSrc) && !/for \(\s*let attempt/.test(formSrc)
);

// --- the shared kernel is untouched by this stage ----------------------------
check("off-35", "enroll.ts is not keyed (the shared kernel learned nothing about intake keys)", /export async function enrollStudent/.test(enrollSrc) && !/idempotencyKey/.test(enrollSrc));

console.log(`\noffline: ${pass} pass / ${fail} fail`);

/* ============================================================= B. LIVE HALF */

const OFFLINE_ONLY = process.argv.includes("--offline");
if (OFFLINE_ONLY) {
  console.log("\nlive half: SKIP (--offline)");
} else {
  requireEmulator();
  await liveHalf();
}

async function liveHalf() {
  const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
  const ORIGIN = process.env.SMOKE_ORIGIN || `http://127.0.0.1:${PORT}`;
  const LOCAL = !process.env.SMOKE_ORIGIN;
  const host = (h) => (LOCAL ? { Host: h } : {});
  const SCHOOL = `school.localhost:${PORT}`;
  const ADMIN = { id: "principal@sunrise.edu", pw: "School@123" };
  const stamp = `P2b-${Date.now().toString(36)}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const { initializeApp } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const db = getFirestore(initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID }, "p2b-intake"));

  async function req(pathname, { cookie, ...init } = {}) {
    const res = await fetch(`${ORIGIN}${pathname}`, {
      ...init,
      headers: {
        ...host(SCHOOL),
        "Content-Type": "application/json",
        ...(cookie ? { cookie } : {}),
        ...(init.headers || {}),
      },
      signal: AbortSignal.timeout(90000),
    });
    const text = await res.text();
    let b = null;
    try {
      b = JSON.parse(text);
    } catch {
      /* html */
    }
    return { status: res.status, data: b?.data ?? null, error: b?.error ?? null, setCookie: res.headers.get("set-cookie") || "" };
  }

  const login = async () => {
    const r = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: ADMIN.id, password: ADMIN.pw }) });
    if (r.status !== 200) throw new Error(`login ${ADMIN.id}: HTTP ${r.status} ${r.error || ""}`);
    const cookie = r.setCookie.split(";")[0];
    if (!cookie) throw new Error("login: no session cookie");
    return cookie;
  };

  console.log(`\n=== B. live intake idempotency (${ORIGIN}) ===\n`);
  const admin = await login();
  const me = await req("/api/auth/me", { cookie: admin });
  const schoolId = me.data?.user?.schoolId || me.data?.school?.id;
  if (!schoolId) throw new Error("could not resolve the demo school from /api/auth/me");
  check("s-1", "the desk signs in and resolves its tenant", schoolId === (me.data?.school?.id ?? schoolId), `${schoolId}`);

  const classes = await req("/api/classes", { cookie: admin });
  const classRow = (classes.data || [])[0];
  if (!classRow?.id) throw new Error("no class in the demo school — run scripts/seed.mjs first");
  const classId = classRow.id;
  const className = classRow.name || "Class";

  // A real kit item, created through the app's own books route (its write clears
  // the pull memo, so the intake route's catalogue read sees it immediately).
  const bookRes = await req("/api/books", {
    method: "POST",
    cookie: admin,
    body: JSON.stringify({ title: `P2b kit ${stamp}`, type: "UNIFORM", classId, className, price: 350, stock: 5 }),
  });
  if (bookRes.status !== 201 || !bookRes.data?.id) throw new Error(`POST /api/books: HTTP ${bookRes.status} ${bookRes.error || ""}`);
  const bookId = bookRes.data.id;

  const COLLECTIONS = ["admissions", "students", "fees", "payments", "ledger", "bookIssues", "notifications", "users"];
  const countOf = async (col) => {
    const base = db.collection(col).where("schoolId", "==", schoolId);
    try {
      return (await base.count().get()).data().count;
    } catch {
      return (await base.select().get()).size;
    }
  };
  const snap = async () => {
    const out = {};
    for (const c of COLLECTIONS) out[c] = await countOf(c);
    return out;
  };
  /** Counts, once they stop moving (the loser of a race may answer first). */
  const stable = async () => {
    let prev = await snap();
    for (let i = 0; i < 15; i++) {
      await sleep(1000);
      const next = await snap();
      if (JSON.stringify(next) === JSON.stringify(prev)) return next;
      prev = next;
    }
    return prev;
  };
  const delta = (before, after) => COLLECTIONS.map((c) => `${c} ${after[c] - before[c] >= 0 ? "+" : ""}${after[c] - before[c]}`).join(", ");
  const zeroDelta = (before, after) => COLLECTIONS.every((c) => before[c] === after[c]);

  const sha1 = (s) => createHash("sha1").update(s).digest("hex");
  /** db.ts's own formula, mirrored so the fixture can pre-create a "crashed" row. */
  const derivedAdmissionId = (key) => `adm_${sha1(`${schoolId}|${key}`)}`;

  const newKey = () => `p2bk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  const payload = ({ key, name, phone, email = "", kit = [], pay = true, keyInHeader = false }) => {
    const body = {
      student: { name, classId },
      guardian: { name: `${name} Guardian`, phone, email, relation: "FATHER", createLogin: !!email },
      sibling: { siblingId: null },
      fees: { admissionFee: 500, monthlyFee: 300, createMonthly: true },
      discount: null,
      payment: { collect: pay, method: "CASH", refNo: "" },
      kit: { issue: kit, pending: [], uniformSize: null, idCardIssued: false },
    };
    if (!keyInHeader && key !== undefined) body.idempotencyKey = key;
    return body;
  };
  const submit = (opts) =>
    req("/api/admissions/intake", {
      method: "POST",
      cookie: admin,
      ...(opts.keyInHeader ? { headers: { "x-idempotency-key": opts.key } } : {}),
      body: JSON.stringify(payload(opts)),
    });

  const created = { students: [], admissions: [] };
  const runStart = new Date();
  let before = await snap();
  console.log(`  counts before: ${JSON.stringify(before)}\n`);

  try {
    /* ---- (e) a normal single keyed submit: exactly one of each ------------ */
    const kE = newKey();
    const nameE = `P2b Single ${stamp}`;
    const e1 = await submit({ key: kE, name: nameE, phone: "01710000001", kit: [bookId] });
    const afterE = await stable();
    check("e-1", "(e) the keyed submit is 201 and flagged a first write", e1.status === 201 && e1.data?.replay === false, `HTTP ${e1.status} replay=${e1.data?.replay} ${e1.error || ""}`);
    check(
      "e-2",
      "(e) the admission row's id IS the key's hash (create-once is structural)",
      e1.data?.admissionId === derivedAdmissionId(kE),
      `${e1.data?.admissionId} vs ${derivedAdmissionId(kE)}`
    );
    check(
      "e-3",
      "(e) exactly one admission, student, admission+monthly fee, payment, ledger entry and kit issue",
      afterE.admissions - before.admissions === 1 &&
        afterE.students - before.students === 1 &&
        afterE.fees - before.fees === 2 &&
        afterE.payments - before.payments === 1 &&
        afterE.ledger - before.ledger === 1 &&
        afterE.bookIssues - before.bookIssues === 1,
      delta(before, afterE)
    );
    check("e-4", "(e) the desk was told once (a notification per staff user)", afterE.notifications - before.notifications >= 1, `${afterE.notifications - before.notifications} notification(s)`);
    check("e-5", "(e) the desk got the receipt and the QR slip", !!e1.data?.payment?.receiptNo && !!e1.data?.qrToken && !!e1.data?.qrPin, JSON.stringify({ receipt: e1.data?.payment?.receiptNo, qr: !!e1.data?.qrToken, pin: !!e1.data?.qrPin }));
    created.students.push(e1.data?.studentId);
    created.admissions.push(e1.data?.admissionId);
    const afterSingle = afterE;
    info(`counts after (e): ${JSON.stringify(afterSingle)}`);

    /* ---- (b) the same key, sequential replay: nothing new, same slip ------ */
    const b1 = await submit({ key: kE, name: nameE, phone: "01710000001", kit: [bookId] });
    const afterB = await stable();
    check("b-1", "(b) the sequential replay is 200 and flagged a replay", b1.status === 200 && b1.data?.replay === true, `HTTP ${b1.status} replay=${b1.data?.replay} ${b1.error || ""}`);
    check(
      "b-2",
      "(b) it returns the ORIGINAL admission and student",
      b1.data?.admissionId === e1.data?.admissionId && b1.data?.studentId === e1.data?.studentId && b1.data?.admissionNo === e1.data?.admissionNo,
      `${b1.data?.admissionId}/${b1.data?.studentId} vs ${e1.data?.admissionId}/${e1.data?.studentId}`
    );
    check(
      "b-3",
      "(b) it returns the ORIGINAL receipt and the SAME QR slip (token + PIN)",
      b1.data?.payment?.receiptNo === e1.data?.payment?.receiptNo && b1.data?.qrToken === e1.data?.qrToken && b1.data?.qrPin === e1.data?.qrPin,
      JSON.stringify({ receipt: [e1.data?.payment?.receiptNo, b1.data?.payment?.receiptNo], qr: e1.data?.qrToken === b1.data?.qrToken, pin: e1.data?.qrPin === b1.data?.qrPin })
    );
    check("b-4", "(b) the replay wrote NOTHING at all — no second record anywhere", zeroDelta(afterSingle, afterB), delta(afterSingle, afterB));

    /* ---- (h) the same key aimed at someone else: refused, nothing written - */
    const h1 = await submit({ key: kE, name: `P2b Other ${stamp}`, phone: "01710000002", kit: [bookId] });
    const afterH = await stable();
    check("h-1", "(h) reusing the key for another child is refused 409 by NAME", h1.status === 409 && /already used for/.test(String(h1.error || "")), `HTTP ${h1.status} ${h1.error || ""}`);
    check("h-2", "(h) the refusal wrote nothing", zeroDelta(afterB, afterH), delta(afterB, afterH));

    /* ---- (a) two SIMULTANEOUS submits, same key: one family --------------- */
    const kA = newKey();
    const nameA = `P2b Race ${stamp}`;
    const [a1, a2] = await Promise.all([
      submit({ key: kA, name: nameA, phone: "01710000003", kit: [bookId] }),
      submit({ key: kA, name: nameA, phone: "01710000003", kit: [bookId] }),
    ]);
    const afterA = await stable();
    const answers = [a1, a2];
    const winners = answers.filter((r) => r.data?.replay === false);
    const replays = answers.filter((r) => r.data?.replay === true);
    check("a-1", "(a) both simultaneous submits were answered (no 409/500)", answers.every((r) => r.status === 201 || r.status === 200), answers.map((r) => `HTTP ${r.status}${r.error ? ` ${r.error}` : ""}`).join(" / "));
    check("a-2", "(a) exactly ONE is the first write and the other is a replay", winners.length === 1 && replays.length === 1, `first-write ${winners.length}, replay ${replays.length}`);
    check(
      "a-3",
      "(a) both answers name the SAME admission and student",
      a1.data?.admissionId === a2.data?.admissionId && a1.data?.studentId === a2.data?.studentId && !!a1.data?.studentId,
      `${a1.data?.admissionId}/${a1.data?.studentId} vs ${a2.data?.admissionId}/${a2.data?.studentId}`
    );
    check(
      "a-4",
      "(a) the race left exactly ONE admission, ONE student, ONE fee set, ONE payment, ONE ledger entry, ONE kit issue",
      afterA.admissions - afterH.admissions === 1 &&
        afterA.students - afterH.students === 1 &&
        afterA.fees - afterH.fees === 2 &&
        afterA.payments - afterH.payments === 1 &&
        afterA.ledger - afterH.ledger === 1 &&
        afterA.bookIssues - afterH.bookIssues === 1,
      delta(afterH, afterA)
    );
    check("a-5", "(a) the loser's answer carries the winner's receipt", a1.data?.payment?.receiptNo === a2.data?.payment?.receiptNo && !!a1.data?.payment?.receiptNo, `${a1.data?.payment?.receiptNo} vs ${a2.data?.payment?.receiptNo}`);
    created.students.push(a1.data?.studentId, a2.data?.studentId);
    created.admissions.push(a1.data?.admissionId, a2.data?.admissionId);
    const afterRace = afterA;

    /* ---- (f) unusable keys are refused by name, nothing written ----------- */
    const fShort = await submit({ key: "short", name: `P2b Short ${stamp}`, phone: "01710000004" });
    const fBlank = await submit({ key: "        ", name: `P2b Blank ${stamp}`, phone: "01710000005" });
    const afterF = await stable();
    check("f-1", "(f) a too-short key is refused 400 by name", fShort.status === 400 && /between 8 and 120 characters/.test(String(fShort.error || "")), `HTTP ${fShort.status} ${fShort.error || ""}`);
    check("f-2", "(f) a whitespace-only key is refused 400 by name", fBlank.status === 400 && /between 8 and 120 characters/.test(String(fBlank.error || "")), `HTTP ${fBlank.status} ${fBlank.error || ""}`);
    check("f-3", "(f) neither refusal wrote anything", zeroDelta(afterRace, afterF), delta(afterRace, afterF));

    /* ---- (k)(d) an empty key and no key at all are the OLD keyless write -- */
    const kEmpty = await submit({ key: "", name: `P2b Empty ${stamp}`, phone: "01710000006" });
    const afterK = await stable();
    check("k-1", "(k) an empty key is treated as keyless, not refused", kEmpty.status === 201 && kEmpty.data?.replay === undefined, `HTTP ${kEmpty.status} replay=${kEmpty.data?.replay}`);
    check("k-2", "(k) it wrote exactly one family (unchanged keyless behaviour)", afterK.admissions - afterF.admissions === 1 && afterK.students - afterF.students === 1, delta(afterF, afterK));
    created.students.push(kEmpty.data?.studentId);
    created.admissions.push(kEmpty.data?.admissionId);

    const nameD = `P2b Keyless ${stamp}`;
    const d1 = await submit({ name: nameD, phone: "01710000007" });
    const afterD = await stable();
    check("d-1", "(d) a body with NO key at all is still the old create (no replay flag)", d1.status === 201 && d1.data?.replay === undefined, `HTTP ${d1.status} replay=${d1.data?.replay}`);
    check("d-2", "(d) a keyless key really is NOT derived — the same body twice makes two admissions", !!d1.data?.studentId && !String(d1.data?.admissionId || "").startsWith("adm_"), `${d1.data?.admissionId}`);
    // The old guard still governs keyless callers: the same phone+name a second
    // time is refused, exactly as it was before this stage.
    const d2 = await submit({ name: nameD, phone: "01710000007" });
    const afterD2 = await stable();
    check(
      "d-3",
      "(d) a keyless retry for the same phone+name is still refused by the OLD guard",
      d2.status === 400 && /already enrolled for this guardian phone/.test(String(d2.error || "")),
      `HTTP ${d2.status} ${d2.error || ""}`
    );
    check("d-4", "(d) that refusal wrote nothing", zeroDelta(afterD, afterD2), delta(afterD, afterD2));
    created.students.push(d1.data?.studentId);
    created.admissions.push(d1.data?.admissionId);
    const afterKeyless = afterD2;

    /* ---- (j) the key honoured from the header ----------------------------- */
    const kJ = newKey();
    const nameJ = `P2b Header ${stamp}`;
    const j1 = await submit({ key: kJ, name: nameJ, phone: "01710000008", keyInHeader: true });
    const afterJ = await stable();
    const j2 = await submit({ key: kJ, name: nameJ, phone: "01710000008", keyInHeader: true });
    const afterJ2 = await stable();
    check("j-1", "(j) x-idempotency-key is honoured as a first write", j1.status === 201 && j1.data?.replay === false && j1.data?.admissionId === derivedAdmissionId(kJ), `HTTP ${j1.status} replay=${j1.data?.replay}`);
    check("j-2", "(j) the header's replay writes nothing and returns the same student", j2.status === 200 && j2.data?.replay === true && j2.data?.studentId === j1.data?.studentId && zeroDelta(afterJ, afterJ2), `HTTP ${j2.status} ${delta(afterJ, afterJ2)}`);
    created.students.push(j1.data?.studentId);
    created.admissions.push(j1.data?.admissionId);
    const afterHeader = afterJ2;

    /* ---- (c1) a DIFFERENT key for the same phone+name: the guard refuses -- */
    const nameC = `P2b Twin ${stamp}`;
    const phoneC = "01710000009";
    const c1 = await submit({ key: newKey(), name: nameC, phone: phoneC });
    const afterC1 = await stable();
    const c2 = await submit({ key: newKey(), name: nameC, phone: phoneC });
    const afterC2 = await stable();
    check("c1-1", "(c1) the first of two DIFFERENT-key submits is admitted", c1.status === 201, `HTTP ${c1.status} ${c1.error || ""}`);
    check(
      "c1-2",
      "(c1) the second is refused by the existing phone+name guard",
      c2.status === 400 && /already enrolled for this guardian phone/.test(String(c2.error || "")),
      `HTTP ${c2.status} ${c2.error || ""}`
    );
    check("c1-3", "(c1) the refusal wrote nothing (still one family for that child)", afterC2.admissions - afterHeader.admissions === 1 && zeroDelta(afterC1, afterC2), delta(afterC1, afterC2));
    created.students.push(c1.data?.studentId);
    created.admissions.push(c1.data?.admissionId);
    const afterC1Case = afterC2;

    /* ---- (c2) the SAME pair simultaneously: reported, not asserted -------- */
    const nameC2 = `P2b Twin Race ${stamp}`;
    const phoneC2 = "01710000010";
    const [r1, r2] = await Promise.all([submit({ key: newKey(), name: nameC2, phone: phoneC2 }), submit({ key: newKey(), name: nameC2, phone: phoneC2 })]);
    const afterC2Race = await stable();
    const accepted = [r1, r2].filter((r) => r.status === 201);
    const refused = [r1, r2].filter((r) => r.status !== 201);
    for (const r of accepted) {
      created.students.push(r.data?.studentId);
      created.admissions.push(r.data?.admissionId);
    }
    info(`(c2) two DIFFERENT keys, same phone+name, simultaneously → ${accepted.length} admitted, ${refused.length} refused`);
    for (const r of refused) info(`(c2) refusal: HTTP ${r.status} ${String(r.error || "").slice(0, 140)}`);
    info(`(c2) the pair created ${afterC2Race.admissions - afterC1Case.admissions} admission(s), ${afterC2Race.students - afterC1Case.students} student(s) — what is NOT covered (see docs/ADMISSION-IDEMPOTENCY.md)`);

    /* ---- (g) a retry after a crash is refused by name --------------------- */
    const kG = newKey();
    const crashId = derivedAdmissionId(kG);
    await db.collection("admissions").doc(crashId).set({
      schoolId,
      classId,
      fullName: `P2b Crashed ${stamp}`,
      status: "APPLIED",
      source: "WALK_IN",
      intake: { keyId: crashId, startedAt: new Date(Date.now() - 600_000), by: "verifier" },
    });
    const beforeG = await stable();
    const g1 = await submit({ key: kG, name: `P2b Crashed ${stamp}`, phone: "01710000011" });
    const afterG = await stable();
    check(
      "g-1",
      "(g) a retry whose attempt is already APPLIED is refused 409 by NAME and state",
      g1.status === 409 && String(g1.error || "").includes(crashId) && /nothing new was written/.test(String(g1.error || "")),
      `HTTP ${g1.status} ${g1.error || ""}`
    );
    check("g-2", "(g) the crash refusal wrote nothing", zeroDelta(beforeG, afterG), delta(beforeG, afterG));

    /* ---- teardown: every collection back to the pre-run counts ----------- */
    console.log("\n  cleanup:");
    let removed = 0;
    for (const studentId of created.students.filter(Boolean)) {
      for (const col of ["fees", "payments", "ledger", "bookIssues", "discounts"]) {
        const rows = await db.collection(col).where("studentId", "==", studentId).get();
        for (const row of rows.docs) {
          await row.ref.delete();
          removed++;
        }
      }
      // These folders carry the id as the DOCUMENT id, so a query cannot find them.
      const doc = db.collection("students").doc(studentId);
      if ((await doc.get()).exists) {
        await doc.delete();
        removed++;
      }
    }
    for (const admissionId of created.admissions.filter(Boolean)) {
      const doc = db.collection("admissions").doc(admissionId);
      if ((await doc.get()).exists) {
        await doc.delete();
        removed++;
      }
    }
    // The intake notification carries no studentId, so it is matched by its own
    // title and this run's start time — never by a wider net.
    const notes = await db.collection("notifications").where("schoolId", "==", schoolId).where("title", "==", "Admission completed at the desk").where("createdAt", ">=", runStart).get();
    for (const n of notes.docs) {
      await n.ref.delete();
      removed++;
    }
    await db.collection("admissions").doc(crashId).delete();
    removed++;
    const stock = await db.collection("bookStock").where("bookId", "==", bookId).get();
    for (const s of stock.docs) {
      await s.ref.delete();
      removed++;
    }
    await db.collection("bookCatalog").doc(bookId).delete();
    removed++;
    console.log(`  removed ${removed} record(s) this run created`);

    const after = await stable();
    check(
      "t-1",
      "every collection this run touched is EXACTLY as it was found",
      zeroDelta(before, after),
      `${delta(before, after)} (before ${JSON.stringify(before)} / after ${JSON.stringify(after)})`
    );

    console.log(`\nlive: ${pass} pass / ${fail} fail`);
  } finally {
    if (!process.env.P2B_KEEP_FIXTURES) {
      // Best effort: the try block already deleted everything it tracked.
      for (const s of created.students.filter(Boolean)) await db.collection("students").doc(s).delete().catch(() => null);
    }
  }
}

console.log(`\n${fail ? `❌ ${fail} FAILURE(S) — ${pass} pass` : `✅ PASS — ${pass} checks (offline pins + live concurrency on the desk intake)`}`);
process.exit(fail ? 1 : 0);
