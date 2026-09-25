/**
 * verify-admission-intake.mjs — prove the desk can admit a student in one action.
 *
 * Exercises what the front desk actually does, end to end:
 *   1. who may intake at all (front desk/registrar/accountant yes, teacher no)
 *   2. fee defaults come from the school's settings; kit availability is live
 *   3. one POST writes the student, the guardian login, the family link, the fees,
 *      the payment, the receipt and the kit
 *   4. a discount is applied immediately for an admin and only PROPOSED for a desk
 *      clerk — and a proposed discount does not reduce what is collected
 *   5. kit is refused when there are no copies, and reported rather than dropped
 *   6. the sibling link really joins one family (the guardian portal lists both)
 *   7. bad input is refused with a reason (no class, discount > fee, duplicate)
 *
 * Creates its own students, guardian, staff login and admission, and deletes them
 * all afterwards — including the fees/payments/ledger/kit rows they produced — so
 * it is safe (and repeatable) against the demo school.
 *
 * Usage: SMOKE_PORT=3123 node scripts/verify-admission-intake.mjs
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";

loadEnv();

// NB: this shell exports PORT=0, so never read process.env.PORT here (it would
// connect to port 0 and fail with EADDRNOTAVAIL).
const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3123";
const BASE = `http://127.0.0.1:${PORT}`;

// Create one record of each thing a student owns, then delete them by studentId.
const KIND = {
  student: "students",
  fee: "fees",
  payment: "payments",
  ledgerEntry: "ledger", // see below: the shim names this collection "ledger"
  bookIssue: "bookIssues",
  discount: "discounts",
  admission: "admissions",
};

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
const HOSTS = { school: `school.localhost:${PORT}`, parents: `parents.localhost:${PORT}`, teacher: `teacher.localhost:${PORT}` };

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

const admin = await login(HOSTS.school, "principal@sunrise.edu", "School@123");

/** Everything this run created, so cleanup can undo exactly that. */
const created = { students: [], admissions: [], users: [], studentIds: [] };
/** Deletes that did not actually delete (see the cleanup section). */
const leftoverDocs = [];

async function intake(cookie, payload) {
  const r = await req(HOSTS.school, "/api/admissions/intake", { cookie, method: "POST", body: JSON.stringify(payload) });
  if (r.data?.studentId) {
    created.students.push(r.data.studentId);
    created.studentIds.push(r.data.studentId);
  }
  if (r.data?.admissionId) created.admissions.push(r.data.admissionId);
  return r;
}

/* ------------------------------------------------------------------- set-up */
console.log(`\n=== set-up (${BASE})`);
const classes = await req(HOSTS.school, "/api/classes", { cookie: admin });
const class1 = (classes.data || []).find((c) => c.name === "Class 1") || classes.data?.[0];
check("the demo school has Class 1 to admit into", !!class1, class1?.name);

// The already-enrolled sibling (Class 1) whose family the new student should join.
const class1Students = (await req(HOSTS.school, `/api/students?classId=${class1.id}`, { cookie: admin })).data || [];
const sibling = class1Students.find((s) => s.guardianEmail === "guardian1@demo.com") || class1Students[0];
check("found an enrolled sibling to link to", !!sibling, sibling ? `${sibling.name} (${sibling.admissionNo})` : "none");
// The sibling is deliberately a REAL demo student (guardian1's child) — the point
// of the test is that one login covers both children — so the link writes to demo
// data. Record what those two fields looked like and put them back in cleanup.
const siblingBefore = (await db.collection("students").doc(sibling.id).get()).data() || {};
const siblingSnapshot = {
  familyId: siblingBefore.familyId ?? null,
  guardianUserId: siblingBefore.guardianUserId ?? null,
};
// Every student in the school when the run started. The harness may add nothing,
// so this set must be identical again afterwards (see the roster check in cleanup).
const schoolId = siblingBefore.schoolId;
const roster = async () =>
  new Set((await db.collection("students").where("schoolId", "==", schoolId).get()).docs.map((d) => d.id));
const rosterBefore = await roster();

// A temp FRONT_DESK login: the desk role that cannot POST /api/students.
const deskEmail = `verify-desk-${Date.now()}@demo.com`;
const deskPassword = "Verify@123";
const staffRes = await req(HOSTS.school, "/api/staff", {
  cookie: admin,
  method: "POST",
  body: JSON.stringify({ name: "Verify Front Desk", email: deskEmail, password: deskPassword, role: "FRONT_DESK", scope: "SCHOOL" }),
});
check("a front-desk login can be created for the test", staffRes.status === 201 || staffRes.status === 200, `HTTP ${staffRes.status}`);

const teacher = await login(HOSTS.teacher, "teacher@sunrise.edu", "Teacher@123");
const guardian = await login(HOSTS.parents, "guardian1@demo.com", "Guardian@123");
// The demo guardian's portal as the run found it — the cleanup section restores
// both of these and asserts they came back.
const guardianChildBefore = (await req(HOSTS.parents, "/api/auth/me", { cookie: guardian })).data?.student?.id;
const kidsBefore = (await req(HOSTS.parents, "/api/parent/siblings", { cookie: guardian })).data || [];
check("the demo guardian has a child to compare against later", !!guardianChildBefore, String(guardianChildBefore));
const desk = staffRes.data?.id ? await login(HOSTS.school, deskEmail, deskPassword) : null;

/* ---------------------------------------------------------------- 1. access */
console.log("\n### who may admit");
const anon = await req(HOSTS.school, "/api/admissions/intake", { method: "POST", body: JSON.stringify({}) });
check("anonymous cannot intake", anon.status === 401, `HTTP ${anon.status}`);
const asTeacher = await req(HOSTS.school, "/api/admissions/intake", { cookie: teacher, method: "POST", body: JSON.stringify({ student: { name: "X" } }) });
check("a teacher cannot intake (no admission permission)", asTeacher.status === 403, `HTTP ${asTeacher.status}`);
const asGuardian = await req(HOSTS.school, "/api/admissions/intake", { cookie: guardian, method: "POST", body: JSON.stringify({ student: { name: "X" } }) });
check("a guardian cannot intake", asGuardian.status === 403 || asGuardian.status === 404, `HTTP ${asGuardian.status}`);
check("the front desk CAN read the intake form data", (await req(HOSTS.school, `/api/admissions/intake?classId=${class1.id}`, { cookie: desk || admin })).status === 200);

/* -------------------------------------------------------------- 2. defaults */
console.log("\n### fee defaults & live stock");
const form = await req(HOSTS.school, `/api/admissions/intake?classId=${class1.id}`, { cookie: admin });
const feeDefaults = form.data?.feeDefaults;
const kit = form.data?.kit || [];
check("the admission fee default comes from the school's fee settings", feeDefaults?.admissionFee === 5000, `${feeDefaults?.admissionFee} (${feeDefaults?.source})`);
check("the class's kit is listed with availability", kit.length > 0, `${kit.length} catalogue item(s)`);
const inStock = kit.find((k) => k.available > 0);
const outOfStock = kit.find((k) => k.available === 0);
check("at least one kit item is on the shelf", !!inStock, inStock ? `${inStock.title} — ${inStock.available} available` : "none");
check("the deliberately empty item reports 0 available", !!outOfStock, outOfStock ? outOfStock.title : "none seeded");

/* ------------------------------------------------- 3. one action, one student */
console.log("\n### one action admits a student");
const stamp = Date.now();
const name = `Verify Intake ${stamp}`;
const result = await intake(admin, {
  student: {
    name,
    classId: class1.id,
    sectionId: sibling.sectionId || undefined,
    dob: "2019-04-12",
    gender: "FEMALE",
    bloodGroup: "B_NEG",
    religion: "ISLAM",
    birthCertificateNo: `BC-${stamp}`,
    address: "12 Verify Road, Dhaka",
    previousSchoolName: "Little Steps Kindergarten",
    previousClass: "Nursery",
    previousSchoolAddress: "Dhanmondi, Dhaka",
  },
  guardian: { name: "Verify Guardian", phone: "01700000099", email: "guardian1@demo.com", relation: "Father", createLogin: true },
  sibling: { siblingId: sibling.id },
  fees: { admissionFee: 5000, monthlyFee: 1500, createMonthly: true },
  discount: { type: "PERCENT", value: 10, reason: "SIBLING", reasonNote: "Second child" },
  payment: { collect: true, method: "CASH" },
  kit: {
    // The desk ticks what it wants to hand over — including an item that turns out
    // to have no copies, which the server must refuse and report.
    issue: [inStock.id, ...(outOfStock ? [outOfStock.id] : [])],
    pending: outOfStock ? [outOfStock.id] : [],
    uniformSize: "M",
    idCardIssued: true,
  },
});
check("the desk intake succeeds", result.status === 201, `HTTP ${result.status} ${result.error || ""}`);
const d = result.data || {};

// student
const student = d.studentId ? (await req(HOSTS.school, `/api/students/${d.studentId}`, { cookie: admin })).data : null;
check("the student exists with the intake fields", !!student && student.bloodGroup === "B_NEG" && student.previousSchoolName === "Little Steps Kindergarten",
  student ? `${student.name} · ${student.admissionNo} · ${student.bloodGroup}` : "missing");
check("the student is in the chosen class", student?.classId === class1.id);
check("the student got QR credentials", !!student?.qrToken && !!student?.qrPin);

// admission row
const admissions = (await req(HOSTS.school, "/api/admissions?status=ENROLLED", { cookie: admin })).data || [];
const admitted = admissions.find((a) => a.id === d.admissionId);
check("an ENROLLED admission record exists (so it shows in Admissions)", !!admitted, admitted ? `${admitted.fullName} · ${admitted.admissionNo}` : "missing");
check("the admission carries the fee and the payable", admitted?.admissionFee === 5000 && admitted?.payableAmount === 4500,
  `fee ${admitted?.admissionFee} / payable ${admitted?.payableAmount}`);
check("the kit handed over is archived on the admission", Array.isArray(admitted?.checklist) && admitted.checklist.includes(inStock.title),
  (admitted?.checklist || []).join(", "));
check("the kit left for later is recorded, not lost", Array.isArray(admitted?.pendingKit) && admitted.pendingKit.length === (outOfStock ? 1 : 0),
  (admitted?.pendingKit || []).join(", "));
check("uniform size and ID card are recorded", admitted?.uniformSize === "M" && admitted?.idCardIssued === true);

// family + guardian
check("the new student joined the sibling's family", !!d.family && d.family.familyId, d.family ? `family ${d.family.familyId} with ${d.family.siblingName}` : "none");
const siblingFresh = sibling ? (await req(HOSTS.school, `/api/students/${sibling.id}`, { cookie: admin })).data : null;
check("the sibling carries the same family id", siblingFresh?.familyId === d.family?.familyId, `${siblingFresh?.familyId}`);
check("one guardian login covers both children", siblingFresh?.guardianUserId && siblingFresh.guardianUserId === student?.guardianUserId);
const kids = (await req(HOSTS.parents, "/api/parent/siblings", { cookie: guardian })).data || [];
check("the guardian portal lists BOTH children after the link", kids.length >= 2, `${kids.length} child(ren): ${kids.map((k) => k.name).join(", ")}`);
check("the existing guardian account was reused, not duplicated", d.guardian?.linked === true && d.guardian?.created === false);

// money
check("the discount was applied immediately for an admin", d.discount?.status === "APPROVED" && d.discount?.amount === 500, `${d.discount?.status} ${d.discount?.amount}`);
check("the amount collected is fee − discount with a receipt", d.payment?.amount === 4500 && !!d.payment?.receiptNo, `${d.payment?.amount} · ${d.payment?.receiptNo}`);
check("the monthly fee was raised too", !!d.fees?.monthlyFeeId, String(d.fees?.monthlyFee));
check("the work list reports no unpaid fee", !(d.pending || []).some((p) => p.includes("not collected")), (d.pending || []).join(" / ") || "nothing pending");

// kit + stock
check("only the on-shelf item was issued", (d.kit?.issued || []).length === 1, (d.kit?.issued || []).map((k) => k.title).join(", "));
check("the issued item is the one with stock", (d.kit?.issued || [])[0]?.bookId === inStock.id);
const kitAfter = (await req(HOSTS.school, `/api/admissions/intake?classId=${class1.id}`, { cookie: admin })).data?.kit || [];
const inStockAfter = kitAfter.find((k) => k.id === inStock.id);
check("stock went down by exactly the copies handed out", inStockAfter?.available === inStock.available - 1, `${inStock.available} → ${inStockAfter?.available}`);
check("an empty shelf was refused, not silently skipped", outOfStock ? (d.kit?.unavailable || []).some((u) => u.bookId === outOfStock.id) : true,
  (d.kit?.unavailable || []).map((u) => `${u.title} (${u.available} left)`).join(", "));

/* --------------------------------------------------- 4. desk role: proposed */
console.log("\n### the desk proposes, the admin approves");
if (desk) {
  const deskName = `Verify Desk ${stamp}`;
  const deskRes = await intake(desk, {
    student: { name: deskName, classId: class1.id },
    guardian: { name: "Verify Desk Guardian", phone: "01700000100", email: `verify-parent-${stamp}@demo.com`, createLogin: true, password: "Verify@123" },
    fees: { admissionFee: 5000, monthlyFee: 1500, createMonthly: false },
    discount: { type: "PERCENT", value: 10, reason: "FINANCIAL_HARDSHIP" },
    payment: { collect: true, method: "BKASH", refNo: "BKASH-VERIFY" },
    kit: {},
  });
  check("the front desk can admit a student", deskRes.status === 201, `HTTP ${deskRes.status} ${deskRes.error || ""}`);
  const dd = deskRes.data || {};
  check("a desk discount is only PROPOSED", dd.discount?.status === "PROPOSED", String(dd.discount?.status));
  check("a proposed discount does NOT reduce what is collected today", dd.payment?.amount === 5000 && dd.fees?.discountAmount === 0,
    `collected ${dd.payment?.amount}, discount applied ${dd.fees?.discountAmount}`);
  const deskAdmission = ((await req(HOSTS.school, `/api/admissions?status=ENROLLED`, { cookie: admin })).data || []).find((a) => a.id === dd.admissionId);
  check("the admission's payable ignores the unapproved discount", deskAdmission?.payableAmount === 5000, String(deskAdmission?.payableAmount));
  check("the work list tells the desk an approval is waiting", (dd.pending || []).some((p) => p.includes("needs an admin")), (dd.pending || []).join(" / "));

  // The admin approves it → payable recomputes from ALL approved discounts.
  if (dd.discount?.id) {
    const approve = await req(HOSTS.school, "/api/admissions?action=discount", {
      cookie: admin,
      method: "PATCH",
      body: JSON.stringify({ admissionId: dd.admissionId, discountId: dd.discount.id, decision: "APPROVED" }),
    });
    check("an admin can approve the proposed discount", approve.status === 200, `HTTP ${approve.status}`);
    const after = ((await req(HOSTS.school, `/api/admissions?status=ENROLLED`, { cookie: admin })).data || []).find((a) => a.id === dd.admissionId);
    check("approval recomputes the payable from the approved discount", after?.payableAmount === 4500, String(after?.payableAmount));
    // And a second discount on the same admission must ADD UP, not replace.
    const second = await req(HOSTS.school, "/api/admissions?action=discount", {
      cookie: admin,
      method: "POST",
      body: JSON.stringify({ admissionId: dd.admissionId, type: "FIXED", value: 500, reason: "MERIT" }),
    });
    if (second.data?.id) {
      await req(HOSTS.school, "/api/admissions?action=discount", {
        cookie: admin,
        method: "PATCH",
        body: JSON.stringify({ admissionId: dd.admissionId, discountId: second.data.id, decision: "APPROVED" }),
      });
      const summed = ((await req(HOSTS.school, `/api/admissions?status=ENROLLED`, { cookie: admin })).data || []).find((a) => a.id === dd.admissionId);
      check("two approved discounts are summed, not replaced", summed?.payableAmount === 4000, `payable ${summed?.payableAmount} (expected 4000)`);
    }
  }
  if (dd.guardian?.created) {
    const parentUser = (await db.collection("users").where("email", "==", `verify-parent-${stamp}@demo.com`).get()).docs[0];
    if (parentUser) created.users.push(parentUser.id);
  }
} else {
  check("front-desk login available for the desk-role checks", false, "staff login could not be created");
}

/* ------------------------------------------------------ 5. refused with reason */
console.log("\n### bad input is refused");
const noClass = await intake(admin, { student: { name: `Verify NoClass ${stamp}` } });
check("a student with no class is refused", noClass.status === 400, noClass.error || "");
const badDiscount = await intake(admin, {
  student: { name: `Verify BadDisc ${stamp}`, classId: class1.id },
  fees: { admissionFee: 1000 },
  discount: { type: "FIXED", value: 5000, reason: "MERIT" },
});
check("a discount larger than the fee is refused", badDiscount.status === 400, badDiscount.error || "");
const noEmail = await intake(admin, {
  student: { name: `Verify NoEmail ${stamp}`, classId: class1.id },
  guardian: { createLogin: true, email: "" },
});
check("asking for a login without an email is refused", noEmail.status === 400, noEmail.error || "");
const dupe = await intake(admin, {
  student: { name, classId: class1.id },
  guardian: { phone: "01700000099", email: "guardian1@demo.com" },
  fees: { admissionFee: 5000 },
  payment: { collect: false },
});
check("the same child of the same guardian cannot be admitted twice", dupe.status === 400 && /already enrolled/i.test(dupe.error || ""), dupe.error || "");

/* ------------------------------------------------------------------- cleanup */
console.log("\n### cleanup");
const COLLECTION = { fee: "fees", payment: "payments", ledger: "ledger", bookIssue: "bookIssues", discount: "discounts" };
let removed = 0;
for (const studentId of created.studentIds) {
  for (const [key, col] of Object.entries(COLLECTION)) {
    const rows = await db.collection(col).where("studentId", "==", studentId).get();
    for (const row of rows.docs) {
      await row.ref.delete();
      removed++;
    }
    void key;
  }
  const notes = await db.collection("notifications").where("studentId", "==", studentId).get();
  for (const n of notes.docs) await n.ref.delete();
}
for (const admissionId of created.admissions) {
  // Discounts proposed through the pipeline carry only the admission id.
  const discountsForAdmission = await db.collection("discounts").where("admissionId", "==", admissionId).get();
  for (const row of discountsForAdmission.docs) {
    await row.ref.delete();
    removed++;
  }
  await db.collection("admissions").doc(admissionId).delete();
  removed++;
  if ((await db.collection("admissions").doc(admissionId).get()).exists) leftoverDocs.push(`admission ${admissionId}`);
}
for (const id of created.students) {
  await db.collection("students").doc(id).delete();
  removed++;
  if ((await db.collection("students").doc(id).get()).exists) leftoverDocs.push(`student ${id}`);
}
// The temp staff login and any guardian account this run minted.
const staffUser = (await db.collection("users").where("email", "==", deskEmail).get()).docs[0];
if (staffUser) {
  const teams = await db.collection("teachers").where("userId", "==", staffUser.id).get();
  for (const t of teams.docs) await t.ref.delete();
  await staffUser.ref.delete();
  removed++;
}
for (const userId of created.users) {
  const row = await db.collection("users").doc(userId).get();
  if (row.exists) {
    await row.ref.delete();
    removed++;
  }
}
console.log(`  removed ${removed} record(s) this run created`);

// Students and admissions keep their id as the DOCUMENT id: db.create() strips an
// `id` data field, so `where("id", "==", …)` matches nothing and a query-based
// delete would silently leave the rows behind — which is exactly how an earlier
// version of this harness polluted the demo family. Deleting by reference and
// reading the doc back is the only way to be sure, so assert it.
check("every student and admission this run created is really gone", leftoverDocs.length === 0,
  leftoverDocs.length ? leftoverDocs.join(", ") : `${created.students.length} student(s), ${created.admissions.length} admission(s)`);

// Put the demo sibling back exactly as found — the family link writes both fields.
if (sibling) {
  await db.collection("students").doc(sibling.id).set(siblingSnapshot, { merge: true });
  const now = (await db.collection("students").doc(sibling.id).get()).data() || {};
  check("the demo sibling's family link is back to its pre-run value",
    (now.familyId ?? null) === siblingSnapshot.familyId && (now.guardianUserId ?? null) === siblingSnapshot.guardianUserId,
    `${sibling.name}: familyId=${now.familyId ?? "null"} guardianUserId=${now.guardianUserId ?? "null"}`);
}

// The strongest guard rail of all: the demo school's roster must be identical.
const rosterAfter = await roster();
const leaked = [...rosterAfter].filter((id) => !rosterBefore.has(id));
const lost = [...rosterBefore].filter((id) => !rosterAfter.has(id));
check("the demo school's roster is exactly as this run found it", leaked.length === 0 && lost.length === 0,
  leaked.length ? `leaked: ${leaked.join(", ")}` : lost.length ? `lost: ${lost.join(", ")}` : `${rosterBefore.size} students`);

/**
 * Poll until the guardian's portal agrees again.
 *
 * Reads are SWR-cached for ~30s (DB_READ_CACHE_MS) and a delete made through the
 * SDK cannot invalidate them, so the next HTTP read may legitimately still show a
 * child this run created. Wait the cache out instead of failing on it, and still
 * fail if it never converges — a leak into the demo family is exactly what this
 * guard rail exists to catch.
 */
async function settles(label, read, want, describe) {
  const deadline = Date.now() + 45000;
  let got = await read();
  while (!want(got) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 2000));
    got = await read();
  }
  check(label, want(got), describe(got));
}
await settles(
  "the demo guardian still resolves to the same child",
  async () => (await req(HOSTS.parents, "/api/auth/me", { cookie: guardian })).data?.student?.id,
  (id) => id === guardianChildBefore,
  (id) => `${guardianChildBefore} → ${id}`
);
await settles(
  "the guardian portal lists the children it listed before the run",
  async () => ((await req(HOSTS.parents, "/api/parent/siblings", { cookie: guardian })).data || []).map((k) => k.name),
  (names) => names.length === kidsBefore.length,
  (names) => `${kidsBefore.length} → ${names.length} (${names.join(", ")})`
);

console.log(`\n${failures ? `❌ ${failures} FAILURE(S)` : "✅ PASS — the desk can admit a student in one action."}`);
process.exit(failures ? 1 : 0);
