#!/usr/bin/env node
/**
 * Phase 8 ca-1 — the pure college attendance logic, proved OFFLINE.
 *
 * `src/lib/college-attendance.ts` is the ONE place that decides the row
 * identity, the slot, the four statuses, the APPROVED-registration roster and
 * the "only a NEW absence today notifies" rule (docs/COLLEGE-DECISIONS.md §24.8,
 * D-CA-1…D-CA-3; owner's answers Q7/Q8 — see §27). It is dependency-free — no
 * prisma, no HTTP, no React, no `node:` — which is what lets this script pin it
 * without a database, a server or an emulator: it carries **no
 * `requireEmulator()` guard** and runs on plain `node`, the design of
 * `verify-college-grading-logic.mjs` and `verify-college-fees-logic.mjs`.
 *
 * It IMPORTS the module (`registerHooks`, the `verify-college-gate.mjs` trick)
 * so the checks run against the REAL rules, not a copy, and pins:
 *
 *   1. PURITY — no `import`/`require`, and no store/HTTP name anywhere in its code.
 *   2. THE DATE-KEY MIRROR (D-CA-1) — the local `YYYY-MM-DD` key on a probe table,
 *      and the store's own module-local `dateKey` in `src/lib/db.ts`, EXECUTED
 *      from its source here and compared with the mirror date by date. ca-2's
 *      resolution (§28): the mirror stays — importing db.ts would break this
 *      module's pinned purity and drag firebase-admin into the ca-4 screen — so
 *      the assertion is a real execution instead of a text-shape copy.
 *   3. THE ID (D-CA-1) — `ca_<courseId>_<dateKey>_<slot>_<studentId>`, trimmed
 *      parts, idempotent, and a THROW for every empty part and every invalid slot.
 *   4. THE SLOT (Q7) — absent/null/blank = 1, whole numbers 1..n, junk refused.
 *   5. THE FOUR STATUSES (D-CA-3) — exactly PRESENT/ABSENT/LATE/LEAVE, strict,
 *      with UNMARKED as a read-only placeholder that is never a stored status.
 *   6. THE ROSTER (D-CA-2) — APPROVED registrations only, duplicates collapsed,
 *      blanks dropped, order kept, and the reader is pinned against
 *      `college-fees.ts`'s `isApprovedRegistration` on one probe table ("the same
 *      machine decides who may be marked and who may be billed").
 *   7. THE NOTIFY DECISION (D-CA-3) — the full transition table, including a
 *      re-saved absence and a corrected register.
 *   8. SCOPE — no route, page or component consumes it yet (ca-3/ca-4 own the
 *      consumers; add them HERE deliberately), and the school's own attendance
 *      path never reaches for it.
 *
 *   node scripts/verify-college-attendance-logic.mjs
 */

import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The app compiles with bundler-style resolution; Node's ESM resolver wants the
 * extension. Retry a failed relative specifier with `.ts`, exactly as the sibling
 * offline verifiers do.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (error?.code === "ERR_MODULE_NOT_FOUND" && relative) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MODULE_URL = new URL("../src/lib/college-attendance.ts", import.meta.url);
const moduleSource = readFileSync(MODULE_URL, "utf8");

const logic = await import(MODULE_URL.href);
const {
  COURSE_ATTENDANCE_ID_PREFIX,
  COURSE_ATTENDANCE_STATUSES,
  COURSE_ATTENDANCE_UNMARKED,
  COURSE_ATTENDANCE_DEFAULT_SLOT,
  COURSE_ATTENDANCE_SLOT_REFUSAL,
  COURSE_ATTENDANCE_STATUS_REFUSAL,
  COURSE_ATTENDANCE_ROSTER_REFUSAL,
  courseAttendanceDateKey,
  readCourseAttendanceSlot,
  courseAttendanceId,
  isCourseAttendanceStatus,
  isApprovedCourseRegistration,
  approvedRosterStudentIds,
  isOnApprovedRoster,
  shouldNotifyAbsence,
} = logic;

// The fee-side reader D-CA-2 says must agree ("the same machine decides who may
// be marked and who may be billed").
const fees = await import("../src/lib/college-fees.ts");

/**
 * Blank out comments and string literals, PRESERVING LENGTH, so a token search
 * runs against code only — the module documents itself in prose.
 */
function maskCommentsAndStrings(text) {
  const out = text.split("");
  const blank = (i) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") blank(i++);
      continue;
    }
    if (ch === "/" && next === "*") {
      blank(i++);
      blank(i++);
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      blank(i++);
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") blank(i++);
        blank(i++);
      }
      blank(i++);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

const code = maskCommentsAndStrings(moduleSource);

/** Every file under the given dirs whose text imports the LOGIC module. */
function findConsumers(dirs) {
  const hits = [];
  const walk = (dir) => {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name)) {
        const text = readFileSync(full, "utf8");
        // `college-attendance-access` is a DIFFERENT module (ca-0) — never match it.
        if (/college-attendance(?!-access)/.test(text)) {
          hits.push(full.slice(ROOT.length + 1).replace(/\\/g, "/"));
        }
      }
    }
  };
  for (const dir of dirs) walk(resolve(ROOT, dir));
  return hits;
}

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const throws = (fn) => {
  try {
    fn();
    return false;
  } catch {
    return true;
  }
};

console.log("=== Phase 8 ca-1 — college attendance pure logic (offline) ===");

/* ------------------------------------------------------------------ 1. purity */

console.log("\n1. the module is pure");
{
  check("college-attendance.ts declares no import/require", !/\bimport\b|\brequire\s*\(/.test(code));
  check("no genuine import statement — it cannot drag the database into a bundle", !/^\s*import\b/m.test(moduleSource));
  check(
    "its code names no store, HTTP or React surface",
    !/prisma|NextResponse|next\/server|firestore|React/.test(code)
  );
}

/* ------------------------------------------------------------ 2. the date key */

console.log("\n2. the date-key mirror (D-CA-1) — executed against the store's own helper, not re-typed");
{
  const PROBE = [
    [new Date(2026, 9, 14), "2026-10-14"],
    [new Date(2026, 0, 5), "2026-01-05"],
    [new Date(2025, 11, 31), "2025-12-31"],
    ["2026-03-04T00:00:00", "2026-03-04"],
    [new Date("2026-07-09T00:00:00"), "2026-07-09"],
  ];
  const wrong = PROBE.filter(([d, want]) => courseAttendanceDateKey(d) !== want).map(
    ([d, want]) => `${String(d)} → ${courseAttendanceDateKey(d)}, want ${want}`
  );
  check(
    "probe dates produce the store's local YYYY-MM-DD (padding, year, string and Date inputs)",
    wrong.length === 0,
    wrong.join(" · ") || `${PROBE.length} dates`
  );

  // The store's OWN helper, executed from its source. The verifier cannot
  // `import` db.ts (plain-node type stripping rejects the file's TS parameter
  // properties), so the declaration is read here, its type annotations erased
  // with Node's own `stripTypeScriptTypes` (a first call prints Node's
  // ExperimentalWarning on stderr — a Node notice, not a check failure), and the
  // resulting function run against the SAME probe table as the mirror. A
  // renamed, reformatted or edited original fails this check loudly instead of
  // passing on a stale text copy (D-CA-1's own words: the mirror is asserted
  // against the original).
  const dbSource = readFileSync(resolve(ROOT, "src/lib/db.ts"), "utf8");
  const decl = dbSource.match(/function dateKey\([^)]*\)\s*:\s*string\s*\{[\s\S]*?\r?\n\}/);
  let storeDateKey = null;
  let execError = "";
  if (!decl) execError = "the module-local helper was not found — re-read db.ts";
  else if (typeof stripTypeScriptTypes !== "function")
    execError = "module.stripTypeScriptTypes is unavailable on this Node — use ≥22.13";
  else {
    try {
      const helperJs = stripTypeScriptTypes(decl[0], { mode: "strip" });
      storeDateKey = new Function(`${helperJs}\nreturn dateKey;`)();
    } catch (error) {
      execError = String((error && error.message) || error);
    }
  }
  check(
    "db.ts's module-local `dateKey` was located and EXECUTED here — the original, not a copy",
    typeof storeDateKey === "function",
    typeof storeDateKey === "function"
      ? "the store's own helper runs in this process"
      : execError
  );
  if (typeof storeDateKey === "function") {
    const disagreements = PROBE.filter(([d]) => storeDateKey(d) !== courseAttendanceDateKey(d));
    check(
      "the mirror agrees with the original on every probe date (executed, not re-typed)",
      disagreements.length === 0,
      disagreements
        .map(([d]) => `${String(d)}: store ${storeDateKey(d)}, mirror ${courseAttendanceDateKey(d)}`)
        .join(" · ") || `${PROBE.length} dates`
    );
  }
}

/* --------------------------------------------------------------------- 3. id */

console.log("\n3. the derived id (D-CA-1) — ca_<courseId>_<dateKey>_<slot>_<studentId>");
{
  check("the prefix is `ca_`", COURSE_ATTENDANCE_ID_PREFIX === "ca_", COURSE_ATTENDANCE_ID_PREFIX);

  const id = courseAttendanceId("r_course1", "2026-10-14", 2, "r_student1");
  check(
    "the id is the four parts in D-CA-1's order, joined by `_`",
    id === "ca_r_course1_2026-10-14_2_r_student1",
    id
  );

  check(
    "an absent slot is slot 1 in the key (Q7)",
    courseAttendanceId("c1", "2026-10-14", undefined, "s1") === "ca_c1_2026-10-14_1_s1" &&
      courseAttendanceId("c1", "2026-10-14", null, "s1") === "ca_c1_2026-10-14_1_s1" &&
      courseAttendanceId("c1", "2026-10-14", "", "s1") === "ca_c1_2026-10-14_1_s1" &&
      COURSE_ATTENDANCE_DEFAULT_SLOT === 1
  );

  check(
    "the same parts always derive the same id (a re-save addresses one row)",
    courseAttendanceId("c1", "2026-10-14", 1, "s1") === courseAttendanceId("c1", "2026-10-14", 1, "s1")
  );

  check(
    "a different course, day, slot or student is a different row",
    courseAttendanceId("c1", "2026-10-14", 1, "s1") !== courseAttendanceId("c2", "2026-10-14", 1, "s1") &&
      courseAttendanceId("c1", "2026-10-14", 1, "s1") !== courseAttendanceId("c1", "2026-10-15", 1, "s1") &&
      courseAttendanceId("c1", "2026-10-14", 1, "s1") !== courseAttendanceId("c1", "2026-10-14", 2, "s1") &&
      courseAttendanceId("c1", "2026-10-14", 1, "s1") !== courseAttendanceId("c1", "2026-10-14", 1, "s2")
  );

  check(
    "every part is trimmed, so ` c1 ` and `c1` are one row",
    courseAttendanceId("  c1  ", " 2026-10-14 ", " 2 ", " s1 ") === courseAttendanceId("c1", "2026-10-14", 2, "s1")
  );

  const emptyCases = [
    ["", "course id", () => courseAttendanceId("", "2026-10-14", 1, "s1")],
    ["   ", "course id", () => courseAttendanceId("   ", "2026-10-14", 1, "s1")],
    [undefined, "course id", () => courseAttendanceId(undefined, "2026-10-14", 1, "s1")],
    [null, "course id", () => courseAttendanceId(null, "2026-10-14", 1, "s1")],
    ["2026-10-14", "date key", () => courseAttendanceId("c1", "", 1, "s1")],
    ["2026-10-14", "date key", () => courseAttendanceId("c1", "   ", 1, "s1")],
    ["s1", "student id", () => courseAttendanceId("c1", "2026-10-14", 1, "")],
    ["s1", "student id", () => courseAttendanceId("c1", "2026-10-14", 1, null)],
  ];
  const unthrown = emptyCases.filter(([, , call]) => !throws(call)).map(([value, what]) => `${what}=${JSON.stringify(value)}`);
  check(
    "an empty/whitespace/null part THROWS instead of deriving a shared id",
    unthrown.length === 0,
    unthrown.join(", ") || `${emptyCases.length} empty parts`
  );

  const badSlots = [0, -1, 1.5, "abc", "2.5", true, [], {}];
  const unthrownSlots = badSlots.filter((v) => !throws(() => courseAttendanceId("c1", "2026-10-14", v, "s1")));
  check(
    "a present-but-invalid slot THROWS too (never a NaN in an id)",
    unthrownSlots.length === 0,
    unthrownSlots.map((v) => JSON.stringify(v)).join(", ") || `${badSlots.length} invalid slots`
  );
}

/* ---------------------------------------------------------------- 4. the slot */

console.log("\n4. the slot rule (Q7) — absent = 1, whole numbers 1..n, junk refused");
{
  const table = [
    [undefined, 1],
    [null, 1],
    ["", 1],
    ["   ", 1],
    [1, 1],
    [2, 2],
    ["3", 3],
    [" 4 ", 4],
    [12, 12],
  ];
  const wrong = table.filter(([v, want]) => readCourseAttendanceSlot(v) !== want);
  check(
    `the reader returns ${table.length} expected value(s) — absent defaults to 1`,
    wrong.length === 0,
    wrong.map(([v, want]) => `${JSON.stringify(v)} → ${readCourseAttendanceSlot(v)}, want ${want}`).join(" · ")
  );
  const junk = [0, -1, 1.5, "abc", "2.5", true, [], {}];
  const notRefused = junk.filter((v) => readCourseAttendanceSlot(v) !== null);
  check(
    "junk never becomes a slot — it reads as null and the caller refuses it",
    notRefused.length === 0,
    notRefused.map((v) => JSON.stringify(v)).join(", ") || `${junk.length} junk values → null`
  );
  check("the slot refusal names the rule", /whole number/.test(COURSE_ATTENDANCE_SLOT_REFUSAL));
}

/* ------------------------------------------------------------ 5. the statuses */

console.log("\n5. the four statuses (D-CA-3), reused verbatim");
{
  check(
    "the list is exactly PRESENT, ABSENT, LATE, LEAVE",
    JSON.stringify([...COURSE_ATTENDANCE_STATUSES]) === JSON.stringify(["PRESENT", "ABSENT", "LATE", "LEAVE"]),
    COURSE_ATTENDANCE_STATUSES.join(", ")
  );
  const storable = [...COURSE_ATTENDANCE_STATUSES].every((s) => isCourseAttendanceStatus(s));
  const refused = [
    COURSE_ATTENDANCE_UNMARKED,
    "UNMARKED",
    "present",
    "EXCUSED",
    "",
    null,
    undefined,
    0,
    {},
  ].every((v) => !isCourseAttendanceStatus(v));
  check(
    "the predicate is strict: the four stored values pass, UNMARKED and every raw junk value fail",
    storable && refused,
    `UNMARKED = ${JSON.stringify(COURSE_ATTENDANCE_UNMARKED)}`
  );
  check("the status refusal names the dictionary", /PRESENT/.test(COURSE_ATTENDANCE_STATUS_REFUSAL) && /LEAVE/.test(COURSE_ATTENDANCE_STATUS_REFUSAL));
}

/* -------------------------------------------------------------- 6. the roster */

console.log("\n6. the roster (D-CA-2) — APPROVED registrations only");
{
  const rows = [
    { studentId: "s1", status: "APPROVED" },
    { studentId: "s2", status: "PENDING" },
    { studentId: "s3", status: "APPROVED" },
    { studentId: "s4", status: "REJECTED" },
    { studentId: "s5" },
  ];
  const roster = approvedRosterStudentIds(rows);
  check(
    "only APPROVED rows are on the roster",
    JSON.stringify(roster) === JSON.stringify(["s1", "s3"]),
    roster.join(", ")
  );

  const dupes = approvedRosterStudentIds([
    { studentId: "s1", status: "APPROVED" },
    { studentId: "s1", status: "APPROVED" },
    { studentId: "s1", status: "APPROVED" },
  ]);
  check("duplicate rows collapse to one student", JSON.stringify(dupes) === JSON.stringify(["s1"]), dupes.join(", "));

  const blanks = approvedRosterStudentIds([
    { studentId: "  ", status: "APPROVED" },
    { status: "APPROVED" },
    { studentId: "s1", status: "APPROVED" },
  ]);
  check("a blank/absent student id is dropped, not treated as a student", JSON.stringify(blanks) === JSON.stringify(["s1"]), blanks.join(", "));

  const order = approvedRosterStudentIds([
    { studentId: "sB", status: "APPROVED" },
    { studentId: "sA", status: "APPROVED" },
  ]);
  check("first-seen order is kept (the roster is not re-sorted)", JSON.stringify(order) === JSON.stringify(["sB", "sA"]), order.join(", "));

  const PROBE = ["APPROVED", " approved ", "APPROVED ", "PENDING", "REJECTED", "", null, undefined, "APPROVEDX", 0];
  const disagree = PROBE.filter(
    (status) => fees.isApprovedRegistration({ status }) !== isApprovedCourseRegistration({ status })
  );
  const disagreeRaw = [null, undefined, "APPROVED", 3, {}].filter(
    (raw) => fees.isApprovedRegistration(raw) !== isApprovedCourseRegistration(raw)
  );
  check(
    "the reader agrees with college-fees' isApprovedRegistration on one probe table (the SAME machine)",
    disagree.length === 0 && disagreeRaw.length === 0,
    [...disagree, ...disagreeRaw].map((v) => JSON.stringify(v)).join(", ") || `${PROBE.length + 5} values`
  );

  check(
    "isOnApprovedRoster: an approved (even padded) student is on it; pending, rejected, blank and junk are not",
    isOnApprovedRoster(rows, " s1 ") &&
      isOnApprovedRoster(rows, "s3") &&
      !isOnApprovedRoster(rows, "s2") &&
      !isOnApprovedRoster(rows, "s4") &&
      !isOnApprovedRoster(rows, "s5") &&
      !isOnApprovedRoster(rows, "  ") &&
      !isOnApprovedRoster(rows, null) &&
      !isOnApprovedRoster(null, "s1")
  );
  check("the roster refusal names the requirement", /APPROVED/.test(COURSE_ATTENDANCE_ROSTER_REFUSAL));
}

/* ------------------------------------------------------ 7. the notify decision */

console.log("\n7. the notify decision (D-CA-3) — only a NEW absence today");
{
  const table = [
    [undefined, "ABSENT", true],
    [null, "ABSENT", true],
    [COURSE_ATTENDANCE_UNMARKED, "ABSENT", true],
    ["PRESENT", "ABSENT", true],
    ["LATE", "ABSENT", true],
    ["LEAVE", "ABSENT", true],
    ["ABSENT", "ABSENT", false],
    ["ABSENT", "PRESENT", false],
    ["ABSENT", "LATE", false],
    ["PRESENT", "LATE", false],
    [undefined, "PRESENT", false],
    ["absent", "ABSENT", true],
    [undefined, "absent", false],
  ];
  const wrong = table.filter(([prev, next, want]) => shouldNotifyAbsence(prev, next) !== want);
  check(
    `the transition table holds (${table.length} cases)`,
    wrong.length === 0,
    wrong.map(([p, n, w]) => `${JSON.stringify(p)}→${n}: got ${shouldNotifyAbsence(p, n)}, want ${w}`).join(" · ")
  );

  check(
    "a re-saved register does not re-mail: an already-ABSENT row stays quiet, and correcting to PRESENT/LATE never notifies",
    shouldNotifyAbsence("ABSENT", "ABSENT") === false &&
      shouldNotifyAbsence("ABSENT", "PRESENT") === false &&
      shouldNotifyAbsence("ABSENT", "LATE") === false &&
      shouldNotifyAbsence("PRESENT", "ABSENT") === true
  );
}

/* -------------------------------------------------------------------- 8. scope */

console.log("\n8. scope — no route/page/component consumer yet, and no school path");
{
  const consumers = findConsumers(["src/app", "src/components"]);
  check(
    "no route, page or component consumes the logic yet (ca-3/ca-4 own the consumers; add them HERE deliberately)",
    consumers.length === 0,
    consumers.join(", ") || "the module exists alone, exactly as ca-1 requires"
  );

  const schoolRoute = readFileSync(resolve(ROOT, "src/app/api/attendance/route.ts"), "utf8");
  check(
    "the school's own attendance route never reaches for it (or for the college collection)",
    !/college-attendance|courseAttendance/.test(schoolRoute)
  );
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ college attendance logic (ca-1) verification FAILED — ${failures} of ${checks} check(s).`);
  process.exit(1);
}
console.log(`✅ college attendance logic (ca-1) verification PASSED — ${checks} checks.`);
