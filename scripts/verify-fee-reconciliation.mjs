/**
 * verify-fee-reconciliation.mjs — the school fee reconciliation report (pilot P2c).
 *
 * `GET /api/fees/reconciliation` is a READ-ONLY, admin-only, school-scoped report:
 * for every fee of the caller's school it compares `paidAmount` with the sum of
 * that fee's payment rows and the sum of its CONFIRMED PAYMENT ledger entries and
 * reports the three ways a crash or a keyless clamp can make them disagree —
 * (i) `fee_above_sums`, (ii) `payment_ledger_mismatch`, (iii) `sums_above_fee` —
 * with ids, INTEGER amounts and the keyed stamp/receipt when the fee carries one.
 *
 * What this verifier proves, against the emulator and a running app:
 *   1. each drift class is DETECTED, with the right amounts and the right class,
 *      built directly in the emulator (no product write is needed to make drift);
 *   2. a real KEYED payment through `POST /api/fees/[id]/pay` produces NO drift
 *      (the report calls the product's own money path clean);
 *   3. a clean fee is never reported;
 *   4. the chunked walk is exact: `limit` bounds the page, `cursor` is a keyset
 *      over the school's fee ids (never skips, never repeats, covers every fee),
 *      `total` is the native count, and the reported read cost matches the rows
 *      that really exist for the page (nothing else was read);
 *   5. another tenant's fees NEVER appear — and the same report read by a super
 *      admin for that other school DOES show them (so the scope is real, not
 *      vacuous);
 *   6. the role matrix holds: SCHOOL_ADMIN / ACCOUNTANT / SUPER_ADMIN(+schoolId)
 *      read it; REGISTRAR, TEACHER, STUDENT, GUARDIAN, a branch-confined
 *      ACCOUNTANT and an unauthenticated caller do not, and none of them receives
 *      a single fee row;
 *   7. the route performs NO writes: the money books' content hash and the total
 *      document count of EVERY collection are identical before and after every
 *      call (the database is proven quiescent first, so a late `after()` audit
 *      write from a sign-in cannot be mistaken for one of ours);
 *   8. statically: the route file contains no write call site and names no
 *      college model or collection.
 *
 * `--mutations` additionally proves this file is not vacuous: it reverses the
 * route one property at a time (drop class (i), drop the tenant scope, allow
 * GUARDIAN, make it write), shows the matching check FAILS, then restores the
 * file and proves it byte-identical (sha256).
 *
 * Everything it creates is prefixed `zzrec-` and deleted again; the money books
 * of the demo school and of its throwaway second tenant are identical afterwards.
 *
 * Usage: SMOKE_PORT=3000 node scripts/verify-fee-reconciliation.mjs [--mutations]
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import bcrypt from "bcryptjs";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

loadEnv();
requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = (process.env.BASE || `http://127.0.0.1:${PORT}`).replace(/\/+$/, "");
const ROUTE = "/api/fees/reconciliation";
const ROUTE_PATH = new URL("../src/app/api/fees/reconciliation/route.ts", import.meta.url);
const ROUTE_FILE = fileURLToPath(ROUTE_PATH);

initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

const STAMP = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
const ID = (what) => `zzrec-${what}-${STAMP}`;

let checks = 0;
let failures = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const section = (title) => console.log(`\n${title}`);

/* --------------------------------------------------------------------- http */

async function req(path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(60000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON (an HTML error page) — `text` is kept for the checks */
  }
  return {
    status: res.status,
    data: body?.data ?? null,
    error: body?.error ?? null,
    text,
    cookie: (res.headers.get("set-cookie") || "").split(";")[0],
  };
}

async function login(identifier, password) {
  const r = await req("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ identifier, password }),
  });
  if (r.status !== 200 || !r.cookie) throw new Error(`login ${identifier}: HTTP ${r.status} ${r.error || ""}`);
  return r.cookie;
}

const report = (cookie, qs = "") => req(`${ROUTE}${qs}`, { cookie });

/** The classes a report lists for one fee (sorted), and one class's row. */
const classesOf = (r, id) => ((r?.issues || []).filter((i) => i.feeId === id).map((i) => i.class)).sort();
const issueOf = (r, id, cls) => (r?.issues || []).find((i) => i.feeId === id && i.class === cls) || null;

/* ----------------------------------------------------------------- fixtures */

const PASSWORD = () => randomBytes(12).toString("base64url");
const hashPw = (pw) => bcrypt.hashSync(pw, 10);
/** An account's document id is deterministic in this app (`u_<sha1(email)>`),
 *  which is how an email sign-in is one document read — and the ONLY id an email
 *  sign-in can find, so these throwaway accounts must use it too. */
const userDocId = (email) => `u_${createHash("sha1").update(String(email).toLowerCase()).digest("hex")}`;
const created = []; // [collection, id] — every document this run writes
const write = async (collection, id, data) => {
  await db.collection(collection).doc(id).set(data);
  created.push([collection, id]);
};

const feeDoc = (id, over = {}) => ({
  id,
  schoolId: over.schoolId,
  studentId: over.studentId,
  feeType: "MONTHLY",
  title: `ZZ reconciliation probe ${id}`,
  amount: over.amount ?? 0,
  paidAmount: over.paidAmount ?? 0,
  status: over.status ?? "UNPAID",
  dueDate: new Date(),
  createdAt: new Date(),
  ...(over.idempotency ? { idempotency: over.idempotency, idempotencyKeys: [over.idempotency.key] } : {}),
  ...(over.branchId ? { branchId: over.branchId } : {}),
});

const paymentDoc = (id, over = {}) => ({
  id,
  schoolId: over.schoolId,
  studentId: over.studentId,
  feeId: over.feeId,
  amount: over.amount,
  method: "CASH",
  refNo: over.refNo ?? null,
  receiptNo: over.receiptNo ?? `RCP-${id.slice(-6)}`,
  date: new Date(),
});

const ledgerDoc = (id, over = {}) => ({
  id,
  schoolId: over.schoolId,
  kind: "PAYMENT",
  amount: over.amount,
  method: "CASH",
  refNo: over.receiptNo ?? null,
  status: over.status ?? "CONFIRMED",
  studentId: over.studentId,
  feeId: over.feeId,
  actorId: null,
  description: "ZZ reconciliation probe",
  meta: over.receiptNo ? { receiptNo: over.receiptNo } : null,
});

const userDoc = (id, over = {}) => ({
  id,
  email: over.email,
  name: `ZZ Reconciliation ${over.role}`,
  role: over.role,
  schoolId: over.schoolId,
  scope: over.scope ?? null,
  branchId: over.branchId ?? null,
  active: true,
  passwordHash: hashPw(over.pw),
});

/* ---------------------------------------------------------------- snapshots */

/** Deterministic content fingerprint of a set of collections. */
async function bookHash(collections) {
  const parts = [];
  for (const c of collections) {
    const snap = await db.collection(c).get();
    const rows = snap.docs.map((d) => `${d.id}:${JSON.stringify(d.data() ?? {})}`).sort();
    parts.push(`${c}=${createHash("sha256").update(rows.join("\n")).digest("hex")}`);
  }
  return createHash("sha256").update(parts.join("|")).digest("hex");
}

/** How many documents exist in the whole emulator database (every collection). */
async function totalDocs() {
  const cols = await db.listCollections();
  let n = 0;
  for (const c of cols) {
    const s = await c.count().get();
    n += Number(s.data().count ?? 0);
  }
  return n;
}

/* -------------------------------------------------------------------- start */

// Readiness is a real sign-in, not /api/health: in emulator mode that route
// answers 503 by design (`problems` names the absent cloud credentials), while a
// sign-in is exactly what the checks below need.
const ready = await req("/api/auth/login", {
  method: "POST",
  body: JSON.stringify({ identifier: "principal@sunrise.edu", password: "School@123" }),
}).catch(() => null);
if (!ready || ready.status !== 200) {
  console.error(`No usable app at ${BASE} (sign-in → ${ready ? `HTTP ${ready.status} ${ready.error || ""}` : "unreachable"}).`);
  console.error("Start the emulator, seed it, and start the app first — see docs/TESTING.md.");
  process.exit(1);
}

// The demo tenant, taken from the seeded school admin, and a throwaway student
// of it (own student = no guardian link, so no notification is ever sent).
const adminSnap = await db.collection("users").where("email", "==", "principal@sunrise.edu").limit(1).get();
if (adminSnap.empty) {
  console.error("The demo tenant is not seeded (no principal@sunrise.edu). Run scripts/seed.mjs first.");
  process.exit(1);
}
const schoolId = adminSnap.docs[0].data().schoolId;
const studentId = ID("student");

const second = { schoolId: ID("school"), studentId: ID("student2") };
const receipt = `RCP-${STAMP.slice(-8)}`;
const fixtureIds = {
  above: ID("fee-above"),
  mismatch: ID("fee-mismatch"),
  over: ID("fee-over"),
  clean: ID("fee-clean"),
  keyed: ID("fee-keyed"),
  real: ID("fee-real"),
};

console.log(`fee reconciliation — school ${schoolId}, ${Object.keys(fixtureIds).length} fixture fees\n`);

try {
  /* ------------------------------------------------------------- fixtures */
  await write("schools", second.schoolId, {
    id: second.schoolId,
    name: "ZZ Reconciliation Second Tenant",
    status: "ACTIVE",
    plan: "PRO",
    createdAt: new Date(),
  });
  await write("students", studentId, { id: studentId, schoolId, name: "ZZ Reconciliation Student", guardianUserId: null });
  await write("students", second.studentId, {
    id: second.studentId,
    schoolId: second.schoolId,
    name: "ZZ Reconciliation Student 2",
    guardianUserId: null,
  });

  // (i) the header claims more than its payment rows wrote — nothing else exists.
  await write(
    "fees",
    fixtureIds.above,
    feeDoc(fixtureIds.above, { schoolId, studentId, amount: 100000, paidAmount: 50000, status: "PARTIAL" })
  );

  // (ii) the payment row landed, the CONFIRMED ledger entry did not.
  await write(
    "fees",
    fixtureIds.mismatch,
    feeDoc(fixtureIds.mismatch, { schoolId, studentId, amount: 100000, paidAmount: 30000, status: "PARTIAL" })
  );
  await write("payments", ID("pay-mismatch"), {
    ...paymentDoc(ID("pay-mismatch"), { schoolId, studentId, feeId: fixtureIds.mismatch, amount: 30000 }),
  });
  await write("ledger", ID("led-mismatch"), {
    ...ledgerDoc(ID("led-mismatch"), {
      schoolId,
      studentId,
      feeId: fixtureIds.mismatch,
      amount: 30000,
      status: "PENDING",
    }),
  });

  // (iii) a keyless clamp swallowed an over-collection: both row families kept
  // the larger figure, the header was capped at what was billed.
  await write(
    "fees",
    fixtureIds.over,
    feeDoc(fixtureIds.over, { schoolId, studentId, amount: 100000, paidAmount: 100000, status: "PAID" })
  );
  await write("payments", ID("pay-over"), {
    ...paymentDoc(ID("pay-over"), { schoolId, studentId, feeId: fixtureIds.over, amount: 150000 }),
  });
  await write("ledger", ID("led-over"), {
    ...ledgerDoc(ID("led-over"), { schoolId, studentId, feeId: fixtureIds.over, amount: 150000, receiptNo: "RCP-OVER" }),
  });

  // clean — the header, the payment row and the CONFIRMED ledger entry agree.
  await write(
    "fees",
    fixtureIds.clean,
    feeDoc(fixtureIds.clean, { schoolId, studentId, amount: 100000, paidAmount: 30000, status: "PARTIAL" })
  );
  await write("payments", ID("pay-clean"), {
    ...paymentDoc(ID("pay-clean"), { schoolId, studentId, feeId: fixtureIds.clean, amount: 30000 }),
  });
  await write("ledger", ID("led-clean"), {
    ...ledgerDoc(ID("led-clean"), { schoolId, studentId, feeId: fixtureIds.clean, amount: 30000, receiptNo: "RCP-CLEAN" }),
  });

  // A KEYED fee whose header moved without its rows (the crash window): the two
  // rows are there, the header claims more, and the stamp/receipt is carried.
  await write(
    "fees",
    fixtureIds.keyed,
    feeDoc(fixtureIds.keyed, {
      schoolId,
      studentId,
      amount: 100000,
      paidAmount: 90000,
      status: "PARTIAL",
      idempotency: {
        key: `zzrec-key-${STAMP}`,
        amount: 50000,
        method: "CASH",
        receiptNo: receipt,
        paidAmount: 50000,
        due: 50000,
        feeStatus: "PARTIAL",
        at: new Date().toISOString(),
      },
    })
  );
  await write("payments", ID("pay-keyed"), {
    ...paymentDoc(ID("pay-keyed"), { schoolId, studentId, feeId: fixtureIds.keyed, amount: 50000, receiptNo: receipt }),
  });
  await write("ledger", ID("led-keyed"), {
    ...ledgerDoc(ID("led-keyed"), { schoolId, studentId, feeId: fixtureIds.keyed, amount: 50000, receiptNo: receipt }),
  });

  // The second tenant: its own drift, which must never appear in the demo
  // school's report.
  await write(
    "fees",
    ID("fee-second"),
    feeDoc(ID("fee-second"), {
      schoolId: second.schoolId,
      studentId: second.studentId,
      amount: 70000,
      paidAmount: 70000,
      status: "PAID",
    })
  );

  // The shared ledger ALSO holds college money, TAGGED (`feeId: null` +
  // `meta.collegeFeeId`, D-7-12). The report must be blind to it: it is a fee
  // book, and every one of its ledger queries is keyed by a fee id of the
  // school's OWN fee rows, so a college entry can never match. Written here, with
  // the other fixtures, so the read-only proof below covers it too.
  const collegeLedger = ID("led-college");
  await write("ledger", collegeLedger, {
    ...ledgerDoc(collegeLedger, { schoolId, studentId: null, feeId: null, amount: 999999, receiptNo: "CRCP-ZZ" }),
    meta: { receiptNo: "CRCP-ZZ", collegeFeeId: "zzrec-cf-probe", collegePaymentKey: "zzrec-key" },
  });

  // Role matrix: throwaway accounts, random passwords, never committed.
  const pw = { accountant: PASSWORD(), branch: PASSWORD(), registrar: PASSWORD(), student: PASSWORD() };
  const branchId = ID("branch");
  await write("branches", branchId, { id: branchId, schoolId, name: "ZZ Reconciliation Branch", enabled: true });
  const mail = {
    accountant: `zzrec-accountant-${STAMP}@test.local`,
    branch: `zzrec-accountant-branch-${STAMP}@test.local`,
    registrar: `zzrec-registrar-${STAMP}@test.local`,
    student: `zzrec-student-${STAMP}@test.local`,
  };
  await write("users", userDocId(mail.accountant), userDoc(userDocId(mail.accountant), { email: mail.accountant, role: "ACCOUNTANT", schoolId, pw: pw.accountant }));
  await write("users", userDocId(mail.branch), userDoc(userDocId(mail.branch), { email: mail.branch, role: "ACCOUNTANT", schoolId, scope: "BRANCH", branchId, pw: pw.branch }));
  await write("users", userDocId(mail.registrar), userDoc(userDocId(mail.registrar), { email: mail.registrar, role: "REGISTRAR", schoolId, pw: pw.registrar }));
  await write("users", userDocId(mail.student), userDoc(userDocId(mail.student), { email: mail.student, role: "STUDENT", schoolId, pw: pw.student }));

  // A REAL keyed payment through the product's own route: it must record the
  // money and produce NO drift.
  const realFee = fixtureIds.real;
  await write("fees", realFee, feeDoc(realFee, { schoolId, studentId, amount: 1000, paidAmount: 0, status: "UNPAID" }));

  const schoolCookie = await login("principal@sunrise.edu", "School@123");
  const superCookie = await login("admin@smartschool.com", "Admin@123");
  const teacherCookie = await login("teacher@sunrise.edu", "Teacher@123");
  const guardianCookie = await login("guardian1@demo.com", "Guardian@123");
  const accountantCookie = await login(mail.accountant, pw.accountant);
  const branchCookie = await login(mail.branch, pw.branch);
  const registrarCookie = await login(mail.registrar, pw.registrar);
  const studentCookie = await login(mail.student, pw.student);

  const payReal = await req(`/api/fees/${realFee}/pay`, {
    cookie: schoolCookie,
    method: "POST",
    body: JSON.stringify({ amount: 500, method: "CASH", idempotencyKey: `zzrec-real-${STAMP}` }),
  });
  const realReceipt = payReal.data?.receiptNo || "";
  const realFeeAfter = await db.collection("fees").doc(realFee).get();

  /* ------------------------------------------ the route's own source (static) */
  section("0. the route is read-only and school-only, by construction");
  const source = readFileSync(ROUTE_FILE, "utf8");
  // A comment is not code: strip both shapes before pinning what the route DOES.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  check("the route file exists at src/app/api/fees/reconciliation/route.ts", source.length > 0);
  const writeCalls = code.match(/prisma\.[A-Za-z]+\.(create|createMany|update|updateMany|upsert|delete|deleteMany|set|add)\(/g) || [];
  check(
    "no write call site in the route (create/update/delete/upsert/$guardedUpdate)",
    writeCalls.length === 0 && !code.includes("$guardedUpdate"),
    writeCalls.join(", ")
  );
  check(
    "the route's code names no college model or collection",
    !/college/i.test(code) && !/college/i.test(ROUTE),
    (code.match(/.{0,24}college.{0,24}/gi) || []).join(" | ")
  );
  check("it reads exactly fee + payment + ledgerEntry", ["prisma.fee", "prisma.payment", "prisma.ledgerEntry"].every((m) => code.includes(m)));

  /* ---------------------------------------------------------- quiescence + 1st read */
  // The database must be STILL before the read-only proof starts: a sign-in's
  // audit write runs in `after()` and could land after the "before" snapshot.
  let still = null;
  for (let i = 0; i < 6 && !still; i += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const a = { hash: await bookHash(["fees", "payments", "ledger"]), docs: await totalDocs() };
    await new Promise((r) => setTimeout(r, 1200));
    const b = { hash: await bookHash(["fees", "payments", "ledger"]), docs: await totalDocs() };
    if (a.hash === b.hash && a.docs === b.docs) still = b;
  }
  check("the database is quiescent before the read-only proof", !!still, still ? `${still.docs} documents` : "still moving after 6 tries");

  const before = still || { hash: await bookHash(["fees", "payments", "ledger"]), docs: await totalDocs() };

  /* ---------------------------------------------------------------- the report */
  section("1. each drift class is detected, a clean fee is not, amounts are integers");
  const first = await report(schoolCookie, "?limit=200");
  check("SCHOOL_ADMIN GET /api/fees/reconciliation → 200", first.status === 200, `HTTP ${first.status} ${first.error || ""}`);
  const body = first.data || {};
  check("the report is scoped to the caller's own school", body.schoolId === schoolId, `schoolId=${body.schoolId}`);

  const above = issueOf(body, fixtureIds.above, "fee_above_sums");
  check("(i) a fee whose header exceeds its payment rows is reported as fee_above_sums", classesOf(body, fixtureIds.above).join(",") === "fee_above_sums", classesOf(body, fixtureIds.above).join(",") || "not reported");
  check(
    "(i) the amounts name the gap exactly (paid 50000, rows 0, delta 50000)",
    !!above && above.paidAmount === 50000 && above.paymentSum === 0 && above.ledgerSum === 0 && above.delta === 50000 && above.paymentCount === 0,
    above ? `paid=${above.paidAmount} paySum=${above.paymentSum} ledSum=${above.ledgerSum} delta=${above.delta}` : "no issue"
  );

  const mismatch = issueOf(body, fixtureIds.mismatch, "payment_ledger_mismatch");
  check("(ii) payment rows that disagree with the CONFIRMED ledger are reported as payment_ledger_mismatch", classesOf(body, fixtureIds.mismatch).join(",") === "payment_ledger_mismatch", classesOf(body, fixtureIds.mismatch).join(",") || "not reported");
  check(
    "(ii) the row delta is the difference (30000 rows, 0 confirmed rows)",
    !!mismatch && mismatch.paymentSum === 30000 && mismatch.ledgerSum === 0 && mismatch.rowDelta === 30000 && mismatch.ledgerCount === 0,
    mismatch ? `paySum=${mismatch.paymentSum} ledSum=${mismatch.ledgerSum} rowDelta=${mismatch.rowDelta}` : "no issue"
  );

  const over = issueOf(body, fixtureIds.over, "sums_above_fee");
  check("(iii) an over-collection the keyless clamp swallowed is reported as sums_above_fee", classesOf(body, fixtureIds.over).join(",") === "sums_above_fee", classesOf(body, fixtureIds.over).join(",") || "not reported");
  check(
    "(iii) the over-collection is measured against the amount billed (150000 rows on a 100000 fee)",
    !!over && over.feeAmount === 100000 && over.paymentSum === 150000 && over.overFee === 50000,
    over ? `fee=${over.feeAmount} paySum=${over.paymentSum} overFee=${over.overFee}` : "no issue"
  );

  check("a clean fee (header = payment row = confirmed ledger row) is never reported", classesOf(body, fixtureIds.clean).length === 0, classesOf(body, fixtureIds.clean).join(",") || "clean");
  check("the clean fee is counted as clean", body.clean >= 1, `clean=${body.clean}`);

  const keyed = issueOf(body, fixtureIds.keyed, "fee_above_sums");
  check(
    "a keyed fee carries its stamp and the receipt the family holds",
    !!keyed && keyed.stamp?.receiptNo === receipt && keyed.stamp?.paidAmount === 50000 && keyed.receipts.includes(receipt) && keyed.ledgerIds.length === 1,
    keyed ? `stamp=${keyed.stamp?.receiptNo} receipts=${keyed.receipts.join(",")}` : "no issue"
  );

  const amounts = [];
  for (const i of body.issues || []) {
    for (const k of ["feeAmount", "paidAmount", "paymentSum", "ledgerSum", "delta", "rowDelta", "overFee"]) {
      if (!Number.isInteger(i[k])) amounts.push(`${i.class}:${k}=${i[k]}`);
    }
  }
  check("every amount in every issue is an integer", amounts.length === 0, amounts.slice(0, 4).join(", "));

  const countsConsistent = (() => {
    const seen = { fee_above_sums: 0, payment_ledger_mismatch: 0, sums_above_fee: 0 };
    for (const i of body.issues || []) seen[i.class] += 1;
    return (body.counts || {}).fee_above_sums === seen.fee_above_sums && (body.counts || {}).payment_ledger_mismatch === seen.payment_ledger_mismatch && (body.counts || {}).sums_above_fee === seen.sums_above_fee;
  })();
  check("`counts` agrees with the issue list", countsConsistent, JSON.stringify(body.counts || {}));

  section("2. a real keyed payment through the product's own route produces no drift");
  check("POST /api/fees/[id]/pay wrote the payment (200 + a receipt)", payReal.status === 200 && !!realReceipt, `HTTP ${payReal.status} receipt=${realReceipt || "none"} ${payReal.error || ""}`);
  check("the fee header really moved to 500", realFeeAfter.data()?.paidAmount === 500 && realFeeAfter.data()?.status === "PARTIAL", `paidAmount=${realFeeAfter.data()?.paidAmount}`);
  const realIssue = (body.issues || []).filter((i) => i.feeId === realFee);
  check("a fee paid through the keyed route is NOT flagged", realIssue.length === 0, realIssue.map((i) => i.class).join(",") || "clean");

  /* ------------------------------------------------------------- the walk */
  section("3. the chunked walk: bounded pages, a keyset cursor, an exact read cost");
  const limit = 3;
  const allFeeIds = (await db.collection("fees").where("schoolId", "==", schoolId).get()).docs.map((d) => d.id).sort();
  const payRows = (await db.collection("payments").where("schoolId", "==", schoolId).get()).docs.map((d) => d.data());
  const ledRows = (await db.collection("ledger").where("schoolId", "==", schoolId).get()).docs
    .map((d) => d.data())
    .filter((l) => l.kind === "PAYMENT" && l.status === "CONFIRMED");
  const payByFee = new Map();
  for (const p of payRows) payByFee.set(p.feeId, (payByFee.get(p.feeId) || 0) + 1);
  const ledByFee = new Map();
  for (const l of ledRows) ledByFee.set(l.feeId, (ledByFee.get(l.feeId) || 0) + 1);

  const walked = [];
  const walkedIssues = [];
  let cursor = "";
  let pages = 0;
  let bounded = true;
  let cursorExact = true;
  let cursorMonotonic = true;
  let costExact = true;
  let costNote = "";
  let sawEnd = false;
  for (let guard = 0; guard < 200; guard += 1) {
    const page = await report(schoolCookie, `?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
    if (page.status !== 200) {
      bounded = false;
      break;
    }
    pages += 1;
    const d = page.data;
    if (d.page.limit !== limit || d.page.scanned > limit || d.total !== allFeeIds.length) bounded = false;
    // The cursor is a keyset over the school's own fee ids: page k must hold
    // exactly the ids [limit*(k-1), limit*k) of that sorted list, and the cursor
    // it hands back must be the last id of the page — so no fee can be skipped
    // and none can be visited twice.
    const expectIds = allFeeIds.slice(limit * (pages - 1), limit * pages);
    if (d.page.scanned !== expectIds.length) cursorExact = false;
    if (d.page.hasMore && d.page.nextCursor !== allFeeIds[limit * pages - 1]) cursorExact = false;
    walked.push(...expectIds);
    walkedIssues.push(...(d.issues || []));
    // The reported read cost must match the rows that really exist for THIS page.
    const wantPay = expectIds.reduce((n, id) => n + (payByFee.get(id) || 0), 0);
    const wantLed = expectIds.reduce((n, id) => n + (ledByFee.get(id) || 0), 0);
    const wantQueries = 2 + 2 * Math.ceil(d.page.scanned / 30);
    if (d.readCost.paymentDocuments !== wantPay || d.readCost.ledgerDocuments !== wantLed) {
      costExact = false;
      costNote = `page ${pages}: pay ${d.readCost.paymentDocuments}≠${wantPay} led ${d.readCost.ledgerDocuments}≠${wantLed}`;
    }
    if (d.readCost.queries !== wantQueries || d.readCost.feeDocuments !== allFeeIds.length) costExact = false;
    if (d.readCost.paymentDocuments > 0 && d.page.scanned === 0) costExact = false;
    if (!d.page.hasMore) {
      sawEnd = true;
      if (d.page.nextCursor) cursorExact = false;
      break;
    }
    if (!d.page.nextCursor || d.page.nextCursor <= cursor) cursorMonotonic = false;
    cursor = d.page.nextCursor;
  }

  check("every page honours `limit` and reports the school-wide `total`", bounded, `${pages} page(s) of ≤${limit}`);
  check("the walk ends (hasMore false, nextCursor null) after every fee", sawEnd, `${walked.length} fee ids walked`);
  const uniqueWalked = new Set(walked).size === walked.length;
  check("the cursor is the last id of the page it was handed — no fee skipped, none repeated", cursorExact && uniqueWalked && walked.length === allFeeIds.length, `${walked.length} vs ${allFeeIds.length} fee ids${uniqueWalked ? "" : " (repeats)"}`);
  check("the cursor only ever moves forward", cursorMonotonic);
  check(
    "the reported read cost matches the rows that exist for the page (nothing else was read)",
    costExact,
    costNote || `payments+ledger per page exact; feeDocuments=${allFeeIds.length} headers, queries=2+2×⌈scanned/30⌉`
  );

  const walkedKeys = walkedIssues.map((i) => `${i.class}:${i.feeId}`);
  const once = (cls, id) => walkedKeys.filter((k) => k === `${cls}:${id}`).length;
  check("walking the school reports each drift class exactly once per fee", once("fee_above_sums", fixtureIds.above) === 1 && once("payment_ledger_mismatch", fixtureIds.mismatch) === 1 && once("sums_above_fee", fixtureIds.over) === 1 && once("fee_above_sums", fixtureIds.keyed) === 1, `${walkedKeys.filter((k) => k.includes(STAMP)).length} of this run's fixtures seen`);
  check("the paged walk never reports the clean fee", walkedKeys.filter((k) => k.endsWith(fixtureIds.clean)).length === 0);

  /* --------------------------------------------------------- tenant isolation */
  section("4. another tenant's fees never appear");
  const secondReport = await report(superCookie, `?schoolId=${encodeURIComponent(second.schoolId)}&limit=200`);
  check("SUPER_ADMIN may read another school's report by naming it", secondReport.status === 200 && secondReport.data?.schoolId === second.schoolId, `HTTP ${secondReport.status}`);
  check(
    "the second tenant's own drift IS reported there (the scope is real, not vacuous)",
    classesOf(secondReport.data, ID("fee-second")).includes("fee_above_sums"),
    classesOf(secondReport.data, ID("fee-second")).join(",") || "not reported"
  );
  check(
    "and the second tenant's report contains none of the demo school's rows",
    !(secondReport.data?.issues || []).some((i) => Object.values(fixtureIds).includes(i.feeId)),
    `${(secondReport.data?.issues || []).length} row(s) in that tenant`
  );
  check(
    "the demo school's report contains none of the second tenant's fees",
    !(body.issues || []).some((i) => i.feeId === ID("fee-second")) && body.total === allFeeIds.length,
    `total=${body.total}`
  );
  // The tagged college entry that is already in the shared ledger (see the
  // fixtures) must not change a single number of the report.
  const collegeRow = await db.collection("ledger").doc(collegeLedger).get();
  check(
    "the probe college entry really is in the shared ledger and tagged (feeId null + meta.collegeFeeId)",
    collegeRow.exists && !collegeRow.data().feeId && collegeRow.data().meta?.collegeFeeId === "zzrec-cf-probe"
  );
  const withCollege = await report(schoolCookie, "?limit=200");
  const signature = (d) =>
    JSON.stringify({
      total: d.total,
      clean: d.clean,
      counts: d.counts,
      issues: (d.issues || []).map((i) => `${i.class}:${i.feeId}`).sort(),
    });
  check(
    "college-tagged ledger money never reaches the report (no sum, no issue, no count)",
    signature(withCollege.data) === signature(body),
    `before=${(body.issues || []).length} issue(s) / after=${(withCollege.data?.issues || []).length}`
  );
  check(
    "…because every ledger read in the route is keyed by a school fee id",
    /prisma\.ledgerEntry\.findMany\(\{\s*where: \{ feeId: \{ in: chunk \}/.test(code),
    (code.match(/prisma\.ledgerEntry[\s\S]{0,80}/) || [""])[0].replace(/\s+/g, " ")
  );

  const noSchool = await report(superCookie, "?limit=10");
  check("a super admin without ?schoolId is refused", noSchool.status === 400, `HTTP ${noSchool.status}`);
  const unknownSchool = await report(superCookie, "?schoolId=zz-no-such-school&limit=10");
  check("an unknown school reads empty, never another tenant's rows", unknownSchool.status === 200 && unknownSchool.data.total === 0 && unknownSchool.data.issues.length === 0, `total=${unknownSchool.data?.total}`);

  /* ------------------------------------------------------------- role matrix */
  section("5. the role matrix");
  const matrix = [
    ["SCHOOL_ADMIN", schoolCookie, 200],
    ["ACCOUNTANT", accountantCookie, 200],
    ["SUPER_ADMIN (+schoolId)", superCookie, 200, `?schoolId=${encodeURIComponent(schoolId)}&limit=10`],
    ["REGISTRAR", registrarCookie, 403],
    ["TEACHER", teacherCookie, 403],
    ["STUDENT", studentCookie, 403],
    ["GUARDIAN", guardianCookie, 403],
    ["ACCOUNTANT (branch-confined)", branchCookie, 403],
    ["unauthenticated", "", 401],
  ];
  for (const [label, cookie, want, qs] of matrix) {
    const path = `${ROUTE}${qs || "?limit=10"}`;
    const r = cookie ? await req(path, { cookie }) : await req(path);
    const wantStatus = want ?? 200;
    check(`${label} → ${wantStatus}`, r.status === wantStatus, `HTTP ${r.status} ${r.error || ""}`);
    if (wantStatus !== 200) {
      const leaked = Object.values(fixtureIds).filter((id) => r.text.includes(id));
      check(`${label} receives no fee row`, r.data === null && leaked.length === 0, leaked.join(", ") || `body=${r.text.slice(0, 60)}`);
    }
  }
  const badLimit = await report(schoolCookie, "?limit=999999");
  check("a cap above the maximum is clamped, not honoured", badLimit.status === 200 && badLimit.data.page.limit <= 500, `limit=${badLimit.data?.page?.limit}`);

  /* --------------------------------------------------------------- no writes */
  section("6. the route performs no writes");
  const after = { hash: await bookHash(["fees", "payments", "ledger"]), docs: await totalDocs() };
  check("the money books are byte-identical (content hash) after every call", before.hash === after.hash, `${before.hash.slice(0, 12)} → ${after.hash.slice(0, 12)}`);
  check("the total document count of EVERY collection is unchanged", before.docs === after.docs, `${before.docs} → ${after.docs}`);
} catch (e) {
  failures += 1;
  console.error(`\n❌ harness error: ${e?.stack || e}`);
} finally {
  /* ------------------------------------------------------- mutations (opt-in) */
  if (process.argv.includes("--mutations")) {
    await runMutations();
  }
  await cleanup();
}

/* --------------------------------------------------------------- mutations */

/**
 * Reverse one property of the route at a time and prove the matching check
 * FAILS; then restore the file and prove it byte-identical.
 */
async function runMutations() {
  const originalBytes = readFileSync(ROUTE_PATH);
  const originalSha = createHash("sha256").update(originalBytes).digest("hex");
  const original = originalBytes.toString("utf8");
  const schoolCookie = await login("principal@sunrise.edu", "School@123");
  const guardianCookie = await login("guardian1@demo.com", "Guardian@123");

  const mutations = [
    {
      name: "drop class (i)",
      from: 'if (paidAmount > paymentSum) classes.push("fee_above_sums");',
      to: "if (false) classes.push(\"fee_above_sums\");",
      // The signature of the mutation: the reported drift disappears.
      probe: async () => {
        const r = await report(schoolCookie, "?limit=200");
        return { mutated: classesOf(r.data, fixtureIds.above).length === 0, detail: classesOf(r.data, fixtureIds.above).join(",") || "not reported" };
      },
    },
    {
      name: "drop the tenant scope",
      from: "const feeWhere: Record<string, any> = { schoolId };",
      to: "const feeWhere: Record<string, any> = {};",
      // The signature: another tenant's fee shows up in this school's report.
      probe: async () => {
        const r = await report(schoolCookie, "?limit=500");
        const leaked = (r.data?.issues || []).filter((i) => i.feeId === ID("fee-second"));
        return { mutated: leaked.length > 0, detail: `${(r.data?.issues || []).length} row(s), another tenant's fee present=${leaked.length > 0}` };
      },
    },
    {
      name: "allow GUARDIAN",
      from: 'const RECON_ROLES = new Set(["SUPER_ADMIN", "SCHOOL_ADMIN", "ACCOUNTANT"]);',
      to: 'const RECON_ROLES = new Set(["SUPER_ADMIN", "SCHOOL_ADMIN", "ACCOUNTANT", "GUARDIAN"]);',
      probe: async () => {
        const r = await report(guardianCookie, "?limit=10");
        return { mutated: r.status === 200, detail: `HTTP ${r.status}` };
      },
    },
    {
      name: "make it write",
      from: "  return NextResponse.json({\n    data: {",
      to: '  if (feeRows.length) await prisma.fee.update({ where: { id: feeRows[0].id }, data: { reconProbe: "zz" } });\n  return NextResponse.json({\n    data: {',
      probe: async () => {
        const before = { hash: await bookHash(["fees", "payments", "ledger"]), docs: await totalDocs() };
        await report(schoolCookie, "?limit=5");
        const after = { hash: await bookHash(["fees", "payments", "ledger"]), docs: await totalDocs() };
        return { mutated: before.hash !== after.hash || before.docs !== after.docs, detail: `hash ${before.hash.slice(0, 8)}→${after.hash.slice(0, 8)}, docs ${before.docs}→${after.docs}` };
      },
    },
  ];

  section("7. mutation proof — each reversal must make the matching check fail");
  for (const m of mutations) {
    if (!original.includes(m.from)) {
      check(`mutation "${m.name}" applies`, false, "anchor not found in the route file");
      continue;
    }
    writeFileSync(ROUTE_PATH, original.replace(m.from, m.to));
    let observed = null;
    for (let i = 0; i < 45 && !observed?.mutated; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        observed = await m.probe();
      } catch (e) {
        observed = { mutated: false, detail: String(e.message || e).slice(0, 80) };
      }
    }
    check(`mutation "${m.name}" is caught (the check fails)`, !!observed?.mutated, observed?.detail || "never observed");

    // Restore byte-identical, then prove the behaviour came back.
    writeFileSync(ROUTE_PATH, originalBytes);
    const restoredSha = createHash("sha256").update(readFileSync(ROUTE_PATH)).digest("hex");
    check(`mutation "${m.name}" restored byte-identical`, restoredSha === originalSha, `${restoredSha.slice(0, 12)} vs ${originalSha.slice(0, 12)}`);
    // Poll until the restored behaviour is observed again (the first request
    // after the write is what makes `next dev` recompile the route).
    let back = { mutated: true, detail: "not yet re-observed" };
    for (let i = 0; i < 45 && back.mutated; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        back = await m.probe();
      } catch {
        back = { mutated: true, detail: "probe error" };
      }
    }
    check(`mutation "${m.name}" is fully reversed (the check passes again)`, !back.mutated, back.detail);
  }

  // The "make it write" reversal really does write: it leaves a field on a seeded
  // demo fee, so put that document back exactly as it was.
  const { FieldValue } = await import("firebase-admin/firestore");
  const probed = await db.collection("fees").where("reconProbe", "==", "zz").get();
  for (const d of probed.docs) await d.ref.update({ reconProbe: FieldValue.delete() });
  if (probed.size) console.log(`(removed the probe field the write mutation left on ${probed.size} fee row(s))`);
}

/* ------------------------------------------------------------------ cleanup */

async function cleanup() {
  // The keyed pay ran the product's own path, which audits; that audit row names
  // this throwaway fee, so it goes with the fixture.
  const auditSnap = await db.collection("auditLogs").where("entityId", "==", fixtureIds.real).get().catch(() => null);
  for (const d of auditSnap?.docs || []) await d.ref.delete().catch(() => null);
  if (auditSnap?.docs?.length) console.log(`\n(removed ${auditSnap.docs.length} audit row(s) the keyed payment created)`);

  for (const [col, id] of [...created].reverse()) {
    await db.collection(col).doc(id).delete().catch(() => null);
  }

  const leftovers = [];
  for (const [col, id] of created) {
    const snap = await db.collection(col).doc(id).get();
    if (snap.exists) leftovers.push(`${col}/${id}`);
  }
  // Nothing of this run may remain anywhere: every fixture id carries the stamp.
  const stray = [];
  for (const col of ["fees", "payments", "ledger", "users", "students", "schools", "branches"]) {
    const snap = await db.collection(col).get();
    for (const d of snap.docs) if (d.id.includes(STAMP)) stray.push(`${col}/${d.id}`);
  }

  console.log("");
  check("fixture removed (no leaked documents)", leftovers.length === 0 && stray.length === 0, [...leftovers, ...stray].slice(0, 5).join(", "));
  console.log(`\n${failures ? `❌ ${failures} of ${checks} check(s) FAILED` : `✅ PASS — ${checks} checks (fee reconciliation)`}`);
  process.exit(failures ? 1 : 0);
}
