/**
 * verify-grading.mjs — prove the school-editable grading & GPA system.
 *
 * Exercises what a school admin / teacher can actually do, end to end:
 *   1. who may read the scheme and who may change it (teacher yes, guardian no)
 *   2. an invalid scale is refused with a reason, never stored
 *   3. saved marks are graded by the ACTIVE scheme
 *   4. editing a band re-grades marks already entered, with no re-entry
 *   5. an exam's subject columns and per-column full marks are editable
 *   6. a mark above its column's full marks is rejected
 *   7. the printed report card shows the school's own scale
 *
 * Creates its own exam and deletes it afterwards, and restores the default
 * scheme, so it is safe (and repeatable) against the demo school.
 *
 * Usage: BASE_URL=http://127.0.0.1:3000 node scripts/verify-grading.mjs
 */
const BASE = process.env.BASE_URL || "http://localhost:3000";

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function login(identifier, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ identifier, password }),
  });
  if (!res.ok) throw new Error(`login ${identifier}: HTTP ${res.status}`);
  const cookie = (res.headers.get("set-cookie") || "").split(";")[0];
  if (!cookie) throw new Error(`login ${identifier}: no cookie`);
  return cookie;
}

/** `payload` is the API's `data` envelope; `error` is its error string. */
async function req(cookie, path, init = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { cookie } : {}), ...(init.headers || {}) },
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON (an HTML page) — callers that need it read .text */
  }
  return { status: res.status, payload: body?.data ?? null, error: body?.error ?? null, text };
}

const schemePath = "/api/grading-scheme";
const CUSTOM = {
  name: "Verify Scale",
  gpaScale: 5,
  passPercent: 40,
  failCapsGpa: true,
  bands: [
    { grade: "Z", minPercent: 80, gpa: 4.5, remark: "Top band" },
    { grade: "Y", minPercent: 40, gpa: 2, remark: "Middle band" },
    { grade: "W", minPercent: 0, gpa: 0, remark: "Bottom band" },
  ],
};

const admin = await login("principal@sunrise.edu", "School@123");
const teacher = await login("teacher@sunrise.edu", "Teacher@123");
const guardian = await login("guardian1@demo.com", "Guardian@123");

// Start from a known state: whatever a previous run left behind is dropped.
await req(admin, schemePath, { method: "DELETE" });

// ---------------------------------------------------------------- 1. who may read
console.log("\n### access");
const anon = await req(null, schemePath);
check("anonymous cannot read the grading scheme", anon.status === 401, `HTTP ${anon.status}`);

const readAdmin = await req(admin, schemePath);
check("school admin can read the grading scheme", readAdmin.status === 200, `HTTP ${readAdmin.status}`);
check(
  "the school's active scale is the shipped 5.00 default",
  readAdmin.payload?.scheme?.gpaScale === 5 && readAdmin.payload?.scheme?.bands?.length === 7,
  `${readAdmin.payload?.scheme?.gpaScale} / ${readAdmin.payload?.scheme?.bands?.length} bands`
);
check(
  "the shipped default is always offered separately",
  readAdmin.payload?.default?.gpaScale === 5 && readAdmin.payload?.default?.bands?.length === 7
);
check("ready-made presets are offered", (readAdmin.payload?.presets || []).length >= 2);

const readTeacher = await req(teacher, schemePath);
check("teacher can read the grading scheme", readTeacher.status === 200, `HTTP ${readTeacher.status}`);
const readGuardian = await req(guardian, schemePath);
check("guardian can read it too (report cards need it)", readGuardian.status === 200, `HTTP ${readGuardian.status}`);

const guardianWrite = await req(guardian, schemePath, { method: "PUT", body: JSON.stringify({ scheme: CUSTOM }) });
check("guardian CANNOT change the grading system", guardianWrite.status === 403, `HTTP ${guardianWrite.status}`);

// ---------------------------------------------------------------- 2. teacher writes it
console.log("\n### editing the scale");
const putByTeacher = await req(teacher, schemePath, { method: "PUT", body: JSON.stringify({ scheme: CUSTOM }) });
check("teacher CAN change the grading system", putByTeacher.status === 200, `HTTP ${putByTeacher.status}`);
check(
  "the scale is stored exactly as sent",
  putByTeacher.payload?.scheme?.name === "Verify Scale" &&
    putByTeacher.payload?.scheme?.bands?.length === 3 &&
    putByTeacher.payload?.scheme?.bands?.[0]?.grade === "Z",
  putByTeacher.error || ""
);
check("and reads back identically", (await req(admin, schemePath)).payload?.scheme?.name === "Verify Scale");

// ---------------------------------------------------------------- 3. bad scales are refused
console.log("\n### validation");
const bad = async (label, bands, extra = {}) => {
  const res = await req(admin, schemePath, { method: "PUT", body: JSON.stringify({ scheme: { ...CUSTOM, ...extra, bands } }) });
  check(label, res.status === 400 && !!res.error, `HTTP ${res.status}${res.error ? ` — ${res.error}` : ""}`);
};
await bad("a duplicate band minimum is refused", [
  { grade: "A", minPercent: 50, gpa: 5 },
  { grade: "B", minPercent: 50, gpa: 2 },
  { grade: "F", minPercent: 0, gpa: 0 },
]);
await bad("a scale with no 0% band is refused", [
  { grade: "A", minPercent: 80, gpa: 5 },
  { grade: "F", minPercent: 50, gpa: 0 },
]);
await bad("a grade point above the GPA scale is refused", [
  { grade: "A", minPercent: 50, gpa: 9 },
  { grade: "F", minPercent: 0, gpa: 0 },
]);
await bad("a single-band scale is refused", [{ grade: "A", minPercent: 0, gpa: 5 }]);
await bad("a band with no grade label is refused", [
  { grade: "", minPercent: 50, gpa: 5 },
  { grade: "F", minPercent: 0, gpa: 0 },
]);
check(
  "a refused scale never overwrites the stored one",
  (await req(admin, schemePath)).payload?.scheme?.name === "Verify Scale"
);

// ---------------------------------------------------------------- 4. an exam sheet
console.log("\n### exam sheet & marks");
const classes = (await req(admin, "/api/classes")).payload || [];
let cls = null;
for (const c of classes) {
  const rows = (await req(admin, `/api/students?classId=${c.id}`)).payload || [];
  if (rows.length) {
    cls = c;
    break;
  }
}
if (!cls) {
  check("a class with students exists to test against", false, "no class has students");
  process.exit(1);
}

const created = await req(admin, "/api/exams", {
  method: "POST",
  body: JSON.stringify({ name: `Verify Grading ${Date.now()}`, classId: cls.id }),
});
const examId = created.payload?.id;
check("a verify exam can be created", !!examId, created.error || `HTTP ${created.status}`);

const sheet0 = await req(admin, `/api/exams/${examId}`);
check(
  "a fresh exam still marks every subject out of 100 (the unchanged default)",
  sheet0.payload?.columnsDeclared === false && sheet0.payload?.subjects?.every((s) => s.fullMarks === 100),
  `${sheet0.payload?.subjects?.length} subjects`
);

const subjectA = sheet0.payload.subjects[0];
const subjectB = sheet0.payload.subjects[1];
const subjectC = sheet0.payload.subjects[2];
const student = sheet0.payload.students[0];

const saved = await req(admin, "/api/marks", {
  method: "POST",
  body: JSON.stringify({ examId, rows: [{ studentId: student.studentId, subjectId: subjectA.id, obtained: 85 }] }),
});
check("marks save against the sheet's column", saved.payload?.count === 1, saved.error || `count ${saved.payload?.count}`);

const sheet1 = await req(admin, `/api/exams/${examId}`);
const mark1 = sheet1.payload.students.find((s) => s.studentId === student.studentId)?.marks?.[0];
check(
  "85% is graded by the ACTIVE scheme (Z / 4.50), not a hardcoded scale",
  mark1?.grade === "Z" && mark1?.gpa === 4.5,
  `${mark1?.grade} / ${mark1?.gpa}`
);

// ---------------------------------------------------------------- 5. re-grade on edit
const rebanded = {
  ...CUSTOM,
  name: "Verify Scale 2",
  bands: [
    { grade: "P", minPercent: 80, gpa: 3, remark: "" },
    { grade: "Q", minPercent: 25, gpa: 1, remark: "" },
    { grade: "F", minPercent: 0, gpa: 0, remark: "" },
  ],
};
const rebandPut = await req(admin, schemePath, { method: "PUT", body: JSON.stringify({ scheme: rebanded }) });
check("the re-banded scale saves", rebandPut.status === 200, rebandPut.error || `HTTP ${rebandPut.status}`);
check("and is what the next read returns", (await req(admin, schemePath)).payload?.scheme?.name === "Verify Scale 2");

const sheet2 = await req(admin, `/api/exams/${examId}`);
check("the exam sheet reports the new scale name", sheet2.payload?.scheme?.name === "Verify Scale 2", `${sheet2.payload?.scheme?.name}`);
const mark2 = sheet2.payload.students.find((s) => s.studentId === student.studentId)?.marks?.[0];
check(
  "editing a band re-grades marks already saved, with no re-entry",
  mark2?.grade === "P" && mark2?.gpa === 3,
  `${mark2?.grade} / ${mark2?.gpa}`
);

// ---------------------------------------------------------------- 6. columns
console.log("\n### subject columns");
const patch = await req(admin, `/api/exams/${examId}/columns`, {
  method: "PATCH",
  body: JSON.stringify({
    columns: [
      { subjectId: subjectB.id, fullMarks: 50 },
      { subjectId: subjectC.id, fullMarks: 20 },
    ],
  }),
});
check("columns can be set", patch.status === 200, patch.error || `HTTP ${patch.status}`);
check(
  "the column whose full marks changed cleared its now-meaningless marks",
  patch.payload?.clearedMarks === 1,
  `cleared ${patch.payload?.clearedMarks}`
);

const sheet3 = await req(admin, `/api/exams/${examId}`);
check(
  "the sheet is exactly the chosen columns with their own full marks",
  sheet3.payload?.subjects?.length === 2 && sheet3.payload?.subjects?.[0]?.fullMarks === 50 && sheet3.payload?.subjects?.[1]?.fullMarks === 20,
  JSON.stringify(sheet3.payload?.subjects?.map((s) => `${s.name}:${s.fullMarks}`))
);
check("columnsDeclared flips on", sheet3.payload?.columnsDeclared === true);

const offSheet = await req(admin, "/api/marks", {
  method: "POST",
  body: JSON.stringify({ examId, rows: [{ studentId: student.studentId, subjectId: subjectA.id, obtained: 30 }] }),
});
check("a subject that is off the sheet cannot be marked", offSheet.payload?.count === 0, `count ${offSheet.payload?.count}`);

const overFull = await req(admin, "/api/marks", {
  method: "POST",
  body: JSON.stringify({ examId, rows: [{ studentId: student.studentId, subjectId: subjectB.id, obtained: 80 }] }),
});
check("a mark above the column's full marks is rejected", overFull.status === 400, `HTTP ${overFull.status}${overFull.error ? ` — ${overFull.error}` : ""}`);

const onSheet = await req(admin, "/api/marks", {
  method: "POST",
  body: JSON.stringify({ examId, rows: [{ studentId: student.studentId, subjectId: subjectB.id, obtained: 45 }] }),
});
check("a mark within the column's full marks saves", onSheet.payload?.count === 1, onSheet.error || `count ${onSheet.payload?.count}`);

const sheet4 = await req(admin, `/api/exams/${examId}`);
const mark4 = sheet4.payload.students
  .find((s) => s.studentId === student.studentId)
  ?.marks?.find((m) => m.subjectId === subjectB.id);
check(
  "45 out of 50 (90%) grades on the column's own denominator",
  mark4?.grade === "P" && mark4?.percent === 90,
  `${mark4?.grade} at ${mark4?.percent}%`
);

// ---------------------------------------------------------------- 7. printed report card
console.log("\n### report card");
const card = await req(admin, `/print/report-card/${examId}/${student.studentId}`);
check("the report card renders", card.status === 200, `HTTP ${card.status}`);
// React separates static text around an expression with comment markers, so
// assert on what a reader sees rather than on the raw markup.
const visible = (html) =>
  html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, " ");
const cardText = visible(card.text);
check("it prints the school's own scale name", cardText.includes("Verify Scale 2"));
check(
  "it prints the school's pass mark and GPA scale",
  cardText.includes("Pass mark 40%") && cardText.includes("GPA out of 5.00"),
  cardText.includes("Pass mark") ? "found the scale line" : "scale line missing"
);
check("it prints the school's own band grades", cardText.includes("P (3.00)"));

// ---------------------------------------------------------------- cleanup
await req(admin, `/api/exams/${examId}`, { method: "DELETE" });
await req(admin, schemePath, { method: "DELETE" });
check(
  "cleanup restored the shipped default scale",
  (await req(admin, schemePath)).payload?.scheme?.name === "Bangladesh National"
);

console.log(
  failures === 0
    ? "\nPASS — the grading system is editable, validated and consistently applied."
    : `\nFAIL — ${failures} check(s) failed.`
);
process.exit(failures === 0 ? 0 : 1);
