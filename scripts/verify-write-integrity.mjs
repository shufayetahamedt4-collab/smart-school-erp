/**
 * verify-write-integrity.mjs — writes must mean one thing.
 *
 * Defects that all came from the same habit — trusting a read taken before
 * the write, or trusting an id/decision that arrived from the client:
 *
 *   1. A daily remark is a property of (student, day), but POST /api/remarks
 *      called `create()` with a random id, so every save APPENDED a row. The
 *      read then used `take: 1` with no `orderBy`, so a teacher who fixed a
 *      rating could be shown the copy they had just replaced. Checked here:
 *      saving the same sheet twice leaves ONE row per pupil, the row's id is the
 *      canonical (student, day) id, a leftover duplicate is swept when that
 *      pupil is saved again, and the read reports the corrected value.
 *   2. `POST /api/fees/generate` promises one bill per (student, category,
 *      period), but the promise rested on a read taken before the write loop and
 *      a fee row had no deterministic id — two overlapping submissions billed
 *      the family twice. Checked here by firing both at once and counting rows.
 *   3. A leave decision is terminal, but PATCH re-decided a closed request and
 *      read a missing `decision` as REJECTED. Checked here: both are refused and
 *      the stored status does not move.
 *   4. Writes that name a record from another school were accepted as long as
 *      the caller had the permission: POST /api/payments created an intent in
 *      the fee's school, POST /api/fees raised an orphan fee for a foreign
 *      pupil, POST /api/books/issues lent a copy to one, and POST /api/remarks
 *      wrote a remark against one. Attendance and marks likewise named pupils
 *      directly with no roster check. Checked here: all are refused (or the row
 *      is dropped) and nothing is written.
 *   5. DELETE handlers for subjects, assignments and notices deleted by id
 *      alone, so a foreign or unknown id was accepted and the cascade
 *      (assignments/routines/homework) crossed schools. Checked here: an unknown
 *      id is refused with 404, not a silent success.
 *   6. Deleting a student removed only the identity doc — fees kept showing as
 *      due, a stale fee could still be paid, and the ledger kept money against
 *      a pupil nobody could see. Checked here with a fully-built probe pupil:
 *      pupil-owned rows (fees, attendance, marks, remarks, submissions, quiz
 *      attempts, leave requests, intents, installments, notifications,
 *      messages, bookings, SMS) go with the pupil; history rows (ledger,
 *      library issues, complaints, chat threads, admissions) survive with the
 *      student link cut to null; the pupil's login user is removed too.
 *
 * Everything it creates is removed again — by document reference, reading each
 * doc back — except append-only auditLogs, which every action legitimately
 * writes. The probes use a period/date far outside real data (1900-01 and
 * 2001-01-01) so a failed cleanup cannot be mistaken for real school data.
 *
 * Usage: node scripts/verify-write-integrity.mjs        (SMOKE_PORT, default 3000)
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

import { installHostFetch } from "./lib/hostfetch.mjs";

// Integration 5a — a `Host:` header on fetch is a fetch-spec forbidden name and
// was silently dropped, so every host-scoped request below reached the hub.
// Those requests now go through node:http, which delivers the header for real.
// This changes request DELIVERY only: no assertion, expectation or fixture moved.
installHostFetch();

loadEnv();
requireEmulator();

// NB: this shell exports PORT=0, so never read process.env.PORT here.
const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const HOST = `school.localhost:${PORT}`;
const ADMIN = { id: "principal@sunrise.edu", pw: "School@123" };

const SENTINEL_DATE = "2001-01-01"; // no real sheet is ever filed for this day
const SENTINEL_PERIOD = "1900-01"; // nor is any category ever billed for it
const STAMP = Math.random().toString(36).slice(2, 8);

let failures = 0;
let skipped = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};
const skip = (label, why) => {
  console.log(`  SKIP  ${label} — ${why}`);
  skipped++;
};

/* ----------------------------------------------------------------- firebase */
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

/* --------------------------------------------------------------------- http */
async function req(path, { cookie, ...init } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { Host: HOST, "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(90000),
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

/* ------------------------------------------------------------------ helpers */
/** Local YYYY-MM-DD, matching the route's own date key. */
const dateKeyOf = (v) => {
  const d = v?.toDate ? v.toDate() : new Date(v);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const canonicalRemarkId = (studentId, date) => `rm_${studentId}_${date}`;
const docsOf = async (col, field, value) => (await db.collection(col).where(field, "==", value).get()).docs.map((d) => ({ id: d.id, ...d.data() }));
/** Delete by reference and read every doc back — no "deleteMany and hope". */
async function removeAll(col, refs, label) {
  for (const r of refs) await db.collection(col).doc(r).delete();
  for (const r of refs) {
    const back = await db.collection(col).doc(r).get();
    if (back.exists) throw new Error(`cleanup failed: ${label} ${r} still exists`);
  }
}

/* ------------------------------------------------------------------ the tenant */
const userSnap = await db.collection("users").where("email", "==", ADMIN.id).limit(1).get();
if (userSnap.empty) {
  console.error(`No demo admin ${ADMIN.id} — is the tenant seeded?`);
  process.exit(1);
}
const schoolId = userSnap.docs[0].data().schoolId;
const adminId = userSnap.docs[0].id;

const students = (await docsOf("students", "schoolId", schoolId)).filter((s) => s.active !== false);
if (!students.length) {
  console.error("Demo school has no students — cannot run this check.");
  process.exit(1);
}
// A class with at least two pupils, so "one row per pupil" is a real question.
const classCounts = new Map();
for (const s of students) if (s.classId) classCounts.set(s.classId, (classCounts.get(s.classId) || 0) + 1);
const busiestClass = [...classCounts.entries()].filter(([, n]) => n >= 2).sort((a, b) => b[1] - a[1])[0]?.[0] || null;
// The sheet endpoint is queried per class, so even a one-pupil class is usable.
const classId = busiestClass || students.find((s) => s.classId)?.classId || null;
const roster = classId ? students.filter((s) => s.classId === classId).slice(0, 3) : students.slice(0, 3);

const adminCookie = await req("/api/auth/login", { method: "POST", body: JSON.stringify({ identifier: ADMIN.id, password: ADMIN.pw }) });
if (adminCookie.status !== 200) throw new Error(`login ${ADMIN.id}: HTTP ${adminCookie.status} ${adminCookie.error || ""}`);
const cookie = adminCookie.setCookie.split(";")[0];

console.log(`school ${schoolId} · ${students.length} active students · probe class ${classId || "(none)"} · roster ${roster.length}`);
console.log(`probe ids: date ${SENTINEL_DATE} · period ${SENTINEL_PERIOD} · stamp ${STAMP}\n`);

/* =========================================================== 1. daily remarks */
console.log("1. a daily remark is replaced, not appended");
{
  const probeIds = roster.map((s) => s.id);
  const payload = (rating, note) => ({
    date: SENTINEL_DATE,
    rows: probeIds.map((id) => ({ studentId: id, rating, note })),
  });
  const rowsFor = async () =>
    (await docsOf("remarks", "schoolId", schoolId)).filter(
      (r) => probeIds.includes(r.studentId) && dateKeyOf(r.date) === SENTINEL_DATE
    );

  const first = await req("/api/remarks", { cookie, method: "POST", body: JSON.stringify(payload("GOOD", `${STAMP} first`)) });
  check("saving a sheet is accepted", first.status === 200 && first.data?.saved === probeIds.length, `HTTP ${first.status}`);

  let rows = await rowsFor();
  check(
    "one row per pupil after the first save",
    rows.length === probeIds.length && probeIds.every((id) => rows.filter((r) => r.studentId === id).length === 1),
    `${rows.length} row(s) for ${probeIds.length} pupil(s)`
  );
  check(
    "the row carries the canonical (student, day) id",
    probeIds.every((id) => rows.some((r) => r.id === canonicalRemarkId(id, SENTINEL_DATE))),
    rows.map((r) => r.id).join(", ")
  );

  // A duplicate written the way the old code wrote them: random id, same day.
  const legacyId = `zzwi-legacy-${STAMP}`;
  const pupil = probeIds[0];
  await db.collection("remarks").doc(legacyId).set({
    id: legacyId,
    schoolId,
    studentId: pupil,
    teacherId: adminId,
    date: new Date(`${SENTINEL_DATE}T00:00:00`),
    rating: "AVERAGE",
    note: `${STAMP} legacy duplicate`,
  });

  const second = await req(
    "/api/remarks",
    { cookie, method: "POST", body: JSON.stringify({ date: SENTINEL_DATE, rows: probeIds.map((id) => ({ studentId: id, rating: "EXCELLENT", note: `${STAMP} corrected` })) }) }
  );
  rows = await rowsFor();
  check(
    "re-saving does not add a second row",
    rows.length === probeIds.length,
    `${rows.length} row(s) for ${probeIds.length} pupil(s)`
  );
  check(
    "the re-save reports it replaced the duplicate",
    (second.data?.replaced || 0) >= 1,
    `replaced=${second.data?.replaced ?? "n/a"}`
  );
  const stillLegacy = await db.collection("remarks").doc(legacyId).get();
  check("the leftover duplicate is swept", !stillLegacy.exists, legacyId);
  const canon = rows.find((r) => r.id === canonicalRemarkId(pupil, SENTINEL_DATE));
  check("the corrected value is what is stored", canon?.rating === "EXCELLENT", canon?.rating || "(missing)");

  // And the sheet reads it back — the old read could show the replaced copy.
  const sheet = await req(
    `/api/remarks?classId=${classId}&date=${SENTINEL_DATE}`,
    { cookie }
  );
  const shown = Array.isArray(sheet.data) ? sheet.data.find((r) => r.id === pupil) : null;
  check(
    "the sheet shows the corrected value, not the replaced duplicate",
    shown?.rating === "EXCELLENT",
    shown ? `${shown.rating} / ${shown.note}` : "(pupil not in roster payload)"
  );

  await removeAll("remarks", rows.map((r) => r.id).concat(await db.collection("remarks").doc(legacyId).get().then((d) => (d.exists ? [legacyId] : []))), "remarks probe");
  check("probe remarks removed", (await rowsFor()).length === 0);
}

/* ============================================================ 2. leave decisions */
console.log("\n2. a leave decision is terminal and explicit");
{
  const leaveId = `zzwi-leave-${STAMP}`;
  await db.collection("leaveRequests").doc(leaveId).set({
    id: leaveId,
    schoolId,
    studentId: students[0].id,
    fromDate: new Date("2001-02-01T00:00:00"),
    toDate: new Date("2001-02-02T00:00:00"),
    reason: `zzwi probe ${STAMP}`,
    status: "APPROVED",
    type: "STUDENT",
    approvedById: adminId,
    approvedAt: new Date(),
  });
  const statusOf = async () => (await db.collection("leaveRequests").doc(leaveId).get()).data()?.status;

  const flip = await req("/api/leave-requests", { cookie, method: "PATCH", body: JSON.stringify({ id: leaveId, decision: "REJECTED" }) });
  check("re-deciding a closed request is refused", flip.status === 409, `HTTP ${flip.status} ${flip.error || ""}`);
  check("the stored decision did not move", (await statusOf()) === "APPROVED", await statusOf());

  const vague = await req("/api/leave-requests", { cookie, method: "PATCH", body: JSON.stringify({ id: leaveId }) });
  check("a missing decision is not read as REJECTED", vague.status === 400, `HTTP ${vague.status} ${vague.error || ""}`);
  check("still APPROVED after the vague request", (await statusOf()) === "APPROVED", await statusOf());

  await removeAll("leaveRequests", [leaveId], "leave probe");
  check("probe leave removed", !(await db.collection("leaveRequests").doc(leaveId).get()).exists);
}

/* ========================================================= 3. cross-tenant writes */
console.log("\n3. a write may not name another school's record");
{
  const schools = (await db.collection("schools").get()).docs.map((d) => d.id).filter((id) => id !== schoolId);
  let foreignStudent = null;
  let foreignFee = null;
  for (const s of schools) {
    foreignStudent = foreignStudent || (await db.collection("students").where("schoolId", "==", s).limit(1).get()).docs[0] || null;
    foreignFee = foreignFee || (await db.collection("fees").where("schoolId", "==", s).limit(1).get()).docs[0] || null;
  }

  if (!foreignStudent) {
    skip("cross-tenant write guards", "the demo has only one school, so there is no foreign record to name");
  } else {
    const foreignStudentId = foreignStudent.id;

    if (!foreignFee) {
      skip("payments: foreign fee", "no fee exists in the other school");
    } else {
      const pay = await req("/api/payments", {
        cookie,
        method: "POST",
        body: JSON.stringify({ feeId: foreignFee.id, method: "CASH", amount: 10 }),
      });
      check("POST /api/payments refuses another school's fee", pay.status === 404, `HTTP ${pay.status} ${pay.error || ""}`);
      const strayIntents = await docsOf("paymentIntents", "feeId", foreignFee.id);
      check("no payment intent was written in the foreign school", strayIntents.length === 0, `${strayIntents.length} intent(s)`);
    }

    const feeTitle = `zzwi cross-tenant ${STAMP}`;
    const raise = await req("/api/fees", {
      cookie,
      method: "POST",
      body: JSON.stringify({ studentId: foreignStudentId, title: feeTitle, amount: 999 }),
    });
    check("POST /api/fees refuses another school's student", raise.status === 404, `HTTP ${raise.status} ${raise.error || ""}`);
    const strayFees = await docsOf("fees", "title", feeTitle);
    check("no fee row was written", strayFees.length === 0, `${strayFees.length} row(s)`);

    const book = (await docsOf("bookCatalog", "schoolId", schoolId))[0];
    if (!book) {
      skip("books: foreign borrower", "this school has no book catalogue entry");
    } else {
      const issue = await req("/api/books/issues", {
        cookie,
        method: "POST",
        body: JSON.stringify({ bookId: book.id, studentId: foreignStudentId }),
      });
      check("POST /api/books/issues refuses another school's student", issue.status === 404, `HTTP ${issue.status} ${issue.error || ""}`);
      const strayIssues = await docsOf("bookIssues", "studentId", foreignStudentId);
      check("no copy was issued to the foreign pupil", strayIssues.length === 0, `${strayIssues.length} issue(s)`);
    }

    const mark = await req("/api/remarks", {
      cookie,
      method: "POST",
      body: JSON.stringify({ date: SENTINEL_DATE, rows: [{ studentId: foreignStudentId, rating: "EXCELLENT", note: `${STAMP} foreign` }] }),
    });
    const strayMarks = (await docsOf("remarks", "schoolId", schoolId)).filter(
      (r) => r.studentId === foreignStudentId && dateKeyOf(r.date) === SENTINEL_DATE
    );
    check("POST /api/remarks refuses another school's pupil", strayMarks.length === 0, `HTTP ${mark.status} · ${strayMarks.length} row(s)`);
    if (strayMarks.length) await removeAll("remarks", strayMarks.map((r) => r.id), "stray remark");

    // Attendance and marks name a pupil directly, so both must drop a pupil who
    // is not on this school's roster even when the caller is a real teacher.
    if (classId) {
      const att = await req("/api/attendance", {
        cookie,
        method: "POST",
        body: JSON.stringify({ date: SENTINEL_DATE, rows: [{ studentId: foreignStudentId, classId, status: "PRESENT" }] }),
      });
      const strayAtt = (await docsOf("attendance", "studentId", foreignStudentId)).filter(
        (a) => a.schoolId === schoolId && dateKeyOf(a.date) === SENTINEL_DATE
      );
      check("POST /api/attendance drops a foreign pupil", strayAtt.length === 0, `HTTP ${att.status} · ${strayAtt.length} row(s)`);
      if (strayAtt.length) await removeAll("attendance", strayAtt.map((a) => a.id), "stray attendance");
    }

    const openExam = (await docsOf("exams", "schoolId", schoolId)).find((e) => !e.published);
    if (openExam) {
      const subject = (await docsOf("subjects", "schoolId", schoolId))[0];
      const mark = await req("/api/marks", {
        cookie,
        method: "POST",
        body: JSON.stringify({ examId: openExam.id, rows: [{ studentId: foreignStudentId, subjectId: subject?.id || "zzwi-none", obtained: 5 }] }),
      });
      const strayMarks = (await docsOf("marks", "studentId", foreignStudentId)).filter((m) => m.examId === openExam.id);
      check("POST /api/marks drops a foreign pupil", strayMarks.length === 0, `HTTP ${mark.status} · ${strayMarks.length} mark(s)`);
      if (strayMarks.length) await removeAll("marks", strayMarks.map((m) => m.id), "stray mark");

      // The pupil may be ours, but the subject must be too: a fabricated (or
      // foreign-catalogue) subject id must not land on the exam's report cards.
      const ghostSubjectId = `zzwi-subject-${STAMP}`;
      const marked = await req("/api/marks", {
        cookie,
        method: "POST",
        body: JSON.stringify({ examId: openExam.id, rows: [{ studentId: students[0].id, subjectId: ghostSubjectId, obtained: 5 }] }),
      });
      const straySubject = (await docsOf("marks", "examId", openExam.id)).filter((m) => m.subjectId === ghostSubjectId);
      check("POST /api/marks drops an unknown subject", straySubject.length === 0, `HTTP ${marked.status} · ${straySubject.length} mark(s)`);
      if (straySubject.length) await removeAll("marks", straySubject.map((m) => m.id), "stray subject mark");
    }
  }
}

/* ================================================== 5. deletes are school-scoped */
console.log("\n4. a delete may not name a record this school does not own");
{
  // Before the fix these handlers deleted by id alone: a foreign (or simply
  // unknown) id returned 200 and the SQL-style deleteMany cascaded across
  // tables. A school admin must only ever delete its own rows.
  const ghost = `zzwi-ghost-${STAMP}`;
  const cases = [
    [`/api/subjects?id=${ghost}`, "DELETE /api/subjects"],
    [`/api/assignments?id=${ghost}`, "DELETE /api/assignments"],
    [`/api/notices?id=${ghost}`, "DELETE /api/notices"],
  ];
  for (const [path, label] of cases) {
    const r = await req(path, { cookie, method: "DELETE" });
    check(`${label} refuses an unknown id`, r.status === 404, `HTTP ${r.status} ${r.error || ""}`);
  }
}

/* ==================================== 5. deleting a pupil leaves no orphans */
console.log("\n5. deleting a pupil takes their rows and cuts the dangling links");
{
  // The old DELETE removed only the identity doc, so fees kept showing as due,
  // a stale fee could still be paid, and the ledger kept money against a pupil
  // nobody could see. The probe builds a whole pupil: pupil-owned rows that
  // must go WITH the pupil, and history rows that must SURVIVE with the link
  // cut to null — plus a login whose user doc must go too.
  const pupilId = `zzwi-pupil-${STAMP}`;
  const pupilRef = db.collection("students").doc(pupilId);
  const gUser = (await db.collection("users").where("email", "==", "guardian1@demo.com").limit(1).get()).docs[0];
  const openExam = (await docsOf("exams", "schoolId", schoolId)).find((e) => !e.published);
  const subject = (await docsOf("subjects", "schoolId", schoolId))[0];
  const book = (await docsOf("bookCatalog", "schoolId", schoolId))[0];
  const stuDoc = {
    id: pupilId, schoolId, name: `ZZ WI Pupil ${STAMP}`, active: true,
    classId: classId || null, guardianEmail: "guardian1@demo.com",
    guardianUserId: null,
  };
  await pupilRef.set(stuDoc);

  const seed = async (col, id, data) => {
    await db.collection(col).doc(id).set({ id, schoolId, studentId: pupilId, ...data });
  };
  const feeId = `zzwi-fee-${STAMP}`;
  const loginId = `u_zzwi-login-${STAMP}`;
  await seed("fees", feeId, { title: `zzwi orphan ${STAMP}`, amount: 500, paidAmount: 200, period: SENTINEL_PERIOD, categoryId: "zzwi-none" });
  await seed("attendance", `zzwi-att-${STAMP}`, { date: new Date(`${SENTINEL_DATE}T00:00:00`), status: "PRESENT", classId: classId || null });
  await seed("remarks", `zzwi-rem-${STAMP}`, { date: new Date(`${SENTINEL_DATE}T00:00:00`), rating: "GOOD", teacherId: adminId });
  await seed("marks", `zzwi-mark-${STAMP}`, { examId: openExam?.id || "zzwi-none", subjectId: subject?.id || "zzwi-none", obtained: 5, fullMarks: 100, grade: "F", gradePoint: 0 });
  await seed("submissions", `zzwi-sub-${STAMP}`, { homeworkId: "zzwi-none", submittedAt: new Date(), body: "probe" });
  await seed("quizAttempts", `zzwi-qa-${STAMP}`, { quizId: "zzwi-none", score: 1, answers: [] });
  await seed("leaveRequests", `zzwi-lv-${STAMP}`, { fromDate: new Date("2001-02-01T00:00:00"), toDate: new Date("2001-02-02T00:00:00"), reason: `probe ${STAMP}`, status: "PENDING", type: "STUDENT" });
  await seed("paymentIntents", `zzwi-pi-${STAMP}`, { feeId, amount: 100, method: "CASH", status: "PENDING" });
  await seed("installments", `zzwi-in-${STAMP}`, { feeId, amount: 250, dueDate: new Date("2001-03-01T00:00:00"), status: "PENDING" });
  await seed("notifications", `zzwi-no-${STAMP}`, { userId: adminId, event: "PROBE", title: `probe ${STAMP}` });
  await seed("messages", `zzwi-ms-${STAMP}`, { senderId: adminId, receiverId: adminId, body: `probe ${STAMP}` });
  await seed("meetingBookings", `zzwi-mb-${STAMP}`, { slotId: "zzwi-none", guardianUserId: gUser?.id || adminId, status: "BOOKED" });
  await seed("smsLogs", `zzwi-sms-${STAMP}`, { to: "+880000000000", text: `probe ${STAMP}`, ok: true });
  await seed("ledger", `zzwi-led-${STAMP}`, { kind: "FEE", amount: 500, status: "CONFIRMED", feeId });
  await seed("bookIssues", `zzwi-bi-${STAMP}`, { bookId: book?.id || "zzwi-none", status: "RETURNED", fineAmount: 0, fineFeeId: null, issuedAt: new Date() });
  await seed("complaints", `zzwi-cm-${STAMP}`, { guardianUserId: gUser?.id || adminId, subject: `probe ${STAMP}`, message: "probe", category: "GENERAL", status: "OPEN" });
  await seed("conversations", `zzwi-cv-${STAMP}`, { teacherUserId: adminId, guardianUserId: gUser?.id || adminId, partyKey: `zzwi-${STAMP}`, lastMessageAt: new Date() });
  await seed("admissions", `zzwi-ad-${STAMP}`, { convertedStudentId: pupilId, status: "ENROLLED", applicantName: `ZZ WI ${STAMP}` });
  await db.collection("users").doc(loginId).set({ id: loginId, schoolId, email: `zzwi-login-${STAMP}@test.local`, name: `ZZ WI Pupil ${STAMP}`, role: "STUDENT", active: true });
  await pupilRef.set({ userId: loginId }, { merge: true });

  const one = async (col, id) => {
    const d = await db.collection(col).doc(id).get();
    return d.exists ? d.data() : null;
  };
  const PUPIL_ROWS = [
    ["fees", "zzwi-fee-"], ["attendance", "zzwi-att-"], ["remarks", "zzwi-rem-"], ["marks", "zzwi-mark-"],
    ["submissions", "zzwi-sub-"], ["quizAttempts", "zzwi-qa-"], ["leaveRequests", "zzwi-lv-"],
    ["paymentIntents", "zzwi-pi-"], ["installments", "zzwi-in-"], ["notifications", "zzwi-no-"],
    ["messages", "zzwi-ms-"], ["meetingBookings", "zzwi-mb-"], ["smsLogs", "zzwi-sms-"],
  ];
  const SURVIVORS = [
    ["ledger", `zzwi-led-${STAMP}`, ["studentId", "feeId"]],
    ["bookIssues", `zzwi-bi-${STAMP}`, ["studentId", "fineFeeId"]],
    ["complaints", `zzwi-cm-${STAMP}`, ["studentId"]],
    ["conversations", `zzwi-cv-${STAMP}`, ["studentId"]],
    ["admissions", `zzwi-ad-${STAMP}`, ["convertedStudentId"]],
  ];
  const sweepLeftovers = async () => {
    for (const [col] of PUPIL_ROWS) {
      for (const d of (await db.collection(col).where("studentId", "==", pupilId).get()).docs) await d.ref.delete();
    }
    for (const [col, id] of SURVIVORS) await db.collection(col).doc(id).delete();
    await db.collection("users").doc(loginId).delete().catch(() => {});
    await pupilRef.delete().catch(() => {});
  };

  try {
    const del = await req(`/api/students/${pupilId}`, { cookie, method: "DELETE" });
    check("deleting the probe pupil is accepted", del.status === 200, `HTTP ${del.status} ${del.error || ""}`);

    const identity = await one("students", pupilId);
    check("the pupil doc is gone", !identity);

    const pupilsLeft = [];
    for (const [col] of PUPIL_ROWS) {
      const left = (await db.collection(col).where("studentId", "==", pupilId).get()).docs.length;
      if (left) pupilsLeft.push(`${col}:${left}`);
    }
    check("no pupil-owned row is left behind", pupilsLeft.length === 0, pupilsLeft.join(", ") || "13 collections clean");

    const cutProblems = [];
    for (const [col, id, fields] of SURVIVORS) {
      const row = await one(col, id);
      if (!row) cutProblems.push(`${col}:deleted`);
      else for (const f of fields) if (row[f] != null) cutProblems.push(`${col}.${f}`);
    }
    check("history rows survive with the link cut", cutProblems.length === 0, cutProblems.join(", ") || "ledger, library, complaints, chat, admissions kept");

    const login = await one("users", loginId);
    check("the pupil's login user is gone too", !login);

    const caretakerFee = await req("/api/fees", {
      cookie,
      method: "POST",
      body: JSON.stringify({ studentId: pupilId, title: `zzwi ghost ${STAMP}`, amount: 1 }),
    });
    check("a deleted pupil cannot be billed", caretakerFee.status === 404, `HTTP ${caretakerFee.status} ${caretakerFee.error || ""}`);
  } finally {
    await sweepLeftovers();
  }
  check("probe pupil and rows removed", !(await pupilRef.get()).exists && !(await one("users", loginId)));
}

/* =================================================== 4. fee generation identity */
console.log("\n6. generating the same period twice bills once");
{
  const categories = (await docsOf("feeCategories", "schoolId", schoolId)).filter(
    (c) => c.active !== false && c.amounts && Object.values(c.amounts).some((a) => Number(a) > 0)
  );
  // The generator validates the period against the category's cadence (a YEARLY
  // head refuses a monthly period), so the probe must offer a period the chosen
  // category actually bills under — or nothing will be planned at all.
  const periodFor = (c) => {
    const freq = c.frequency || "MONTHLY";
    if (freq === "YEARLY") return SENTINEL_PERIOD.slice(0, 4); // "1900"
    return SENTINEL_PERIOD; // MONTHLY and free-form cadences take "1900-01"
  };
  const cat = categories[0];
  if (!cat) {
    skip("fee generation idempotency", "this school has no active priced fee category");
  } else {
    const probePeriod = periodFor(cat);
    const post = (dryRun) =>
      req("/api/fees/generate", {
        cookie,
        method: "POST",
        body: JSON.stringify({ categoryIds: [cat.id], period: probePeriod, dryRun }),
      });

    const preview = await post(true);
    const wouldBill = preview.data?.wouldBill || 0;
    if (preview.status !== 200 || !wouldBill) {
      skip("fee generation idempotency", `preview not usable (HTTP ${preview.status}${preview.error ? `: ${preview.error}` : ""}, wouldBill=${wouldBill})`);
    } else {
      const periodRows = async () => (await docsOf("fees", "period", probePeriod)).filter((f) => f.schoolId === schoolId);

      // The real test: two submissions that overlap. The comment above the route
      // promises (student, category, period) is billed at most once, and the only
      // thing that keeps that promise under a double-click is the row's id.
      const [a, b] = await Promise.all([post(false), post(false)]);
      check(
        "both overlapping submissions are accepted",
        a.status === 200 && b.status === 200,
        `HTTP ${a.status}/${b.status}`
      );

      const rows = await periodRows();
      const triples = rows.map((f) => `${f.studentId}|${f.categoryId}|${f.period}`);
      // NB: the load-bearing assertion is the next one. Two rows per triple only
      // appear when the two submissions genuinely overlapped; what always holds
      // — before and after — is that the row's id IS the triple, which is the
      // only reason an overlap cannot double-bill.
      check(
        "the family is billed once per (student, category, period)",
        new Set(triples).size === triples.length,
        `${rows.length} row(s), ${new Set(triples).size} distinct triple(s), submissions wrote ${a.data?.created ?? "?"}+${b.data?.created ?? "?"}`
      );
      check(
        "the plan and the books agree",
        rows.length === wouldBill,
        `preview said ${wouldBill}, books hold ${rows.length}`
      );
      check(
        "every bill carries the deterministic id for its triple",
        rows.every((f) => f.id.startsWith("fee_") && f.id.includes(f.studentId)),
        rows[0]?.id || "(none)"
      );

      const again = await post(false);
      check(
        "a later submission creates nothing",
        again.status === 200 && again.data?.created === 0 && again.data?.skipped >= wouldBill,
        `created=${again.data?.created ?? "n/a"} skipped=${again.data?.skipped ?? "n/a"}`
      );
      const after = await periodRows();
      check("still one bill per triple", after.length === wouldBill, `${after.length} row(s)`);

      // Cleanup: the fees and the ledger entries the generation posted.
      const ids = after.map((f) => f.id);
      const ledgerRefs = [];
      for (const id of ids) {
        for (const e of await docsOf("ledger", "feeId", id)) ledgerRefs.push(e.id);
      }
      await removeAll("ledger", ledgerRefs, "ledger");
      await removeAll("fees", ids, "fees");
      check("probe bills and their ledger entries removed", (await periodRows()).length === 0, `${ledgerRefs.length} ledger entr(ies)`);
    }
  }
}

/* ==================================== 7. cadence guards the period shape */
console.log("\n7. a category is only billed under a period its cadence accepts");
{
  // The demo school once owed its YEARLY study-tour fee twice — once under
  // `2026` and again under `2026-09` — because the generator accepted any
  // period for any category. Now a mismatch is skipped and reported.
  const yearly = (await docsOf("feeCategories", "schoolId", schoolId)).find(
    (c) => (c.frequency || "").toUpperCase() === "YEARLY" && c.active !== false
  );
  if (!yearly) {
    skip("cadence guard", "this school has no active YEARLY fee category to probe with");
  } else {
    const preview = await req("/api/fees/generate", {
      cookie,
      method: "POST",
      body: JSON.stringify({ categoryIds: [yearly.id], period: SENTINEL_PERIOD, dryRun: true }),
    });
    check(
      "a YEARLY fee is not billed under a monthly period",
      preview.status === 200 && preview.data?.wouldBill === 0,
      `wouldBill=${preview.data?.wouldBill ?? "n/a"}`
    );
    check(
      "the mismatched category is reported by name",
      Array.isArray(preview.data?.mismatched) && preview.data.mismatched.some((m) => m.id === yearly.id),
      (preview.data?.mismatched || []).map((m) => m.name).join(", ") || "(none reported)"
    );
    // And nothing was written — a preview cannot write, so check the books.
    const rows = (await docsOf("fees", "period", SENTINEL_PERIOD)).filter((f) => f.schoolId === schoolId);
    check("no bill leaked into the books", rows.length === 0, `${rows.length} row(s)`);
    if (rows.length) {
      for (const r of rows) await db.collection("fees").doc(r.id).delete();
    }
  }
}

console.log(
  `\n${failures ? "❌" : "✅"} verify-write-integrity: ${failures ? `${failures} failure(s)` : "all checks passed"}${
    skipped ? ` · ${skipped} skipped` : ""
  }`
);
process.exit(failures ? 1 : 0);
