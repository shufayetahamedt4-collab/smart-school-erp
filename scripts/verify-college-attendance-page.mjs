#!/usr/bin/env node
/**
 * verify-college-attendance-page.mjs — Phase 8 ca-4: the college course REGISTER
 * screen, proved OFFLINE (docs/COLLEGE-DECISIONS.md §24.8, D-CA-1…D-CA-4, §29/§30).
 *
 * `src/lib/college-attendance-view.ts` holds every NON-JSX decision
 * `src/app/dashboard/course-attendance/page.tsx` makes: which words the five mark
 * controls are shown under, which values may be sent, what the save reports, how a
 * refusal is worded, and the count lines. This script pins that module — and the
 * fact that the PAGE still USES it rather than re-stating the vocabulary, the
 * roster rule or the endpoint — with no database, no server and no network, so it
 * carries **no `requireEmulator()` guard** and runs on plain `node`, the same
 * design as `verify-college-results-page.mjs` and `verify-college-promotion-page.mjs`.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT — read this before trusting it:
 *
 *   ✅ PROVES: the mark vocabulary is exactly ca-1's four stored values (UNMARKED is
 *      never offered, never sendable), the slot parser IS ca-1's reader on the same
 *      probe table, the save payload can only contain rows the API HANDED OVER (a
 *      student the screen was not given cannot be sent, and no status the API would
 *      refuse is), the save message's truth table including D-CA-3's notification
 *      count, the summary/count lines, the course label, the refusal wording per
 *      HTTP status, the five notes, and — statically — that the page goes through
 *      this module and ca-0's allow-list (ONE rule for the sidebar, the screen and
 *      the API), carries no status literal or role list of its own, calls exactly
 *      the one endpoint ca-3 built, and renders the grid from what the API served.
 *
 *   ❌ DOES NOT PROVE THAT THE PAGE RENDERS. There is no DOM, no React, no browser
 *      and no server in this file: nothing here mounts the page, clicks a mark,
 *      signs in, or performs an API round trip. The register's own HTTP behaviour
 *      is proved by `verify-course-attendance.mjs` (46 checks, live against the
 *      fixture); a REAL BROWSER TEST is a separate, recorded step. Treat a green
 *      run here as "the screen's non-visual logic is right", never as "the screen
 *      works".
 *
 *   node scripts/verify-college-attendance-page.mjs
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(resolve(ROOT, p), "utf8");

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

const view = await import("../src/lib/college-attendance-view.ts");
const pure = await import("../src/lib/college-attendance.ts");
const access = await import("../src/lib/college-attendance-access.ts");
const nav = await import("../src/components/nav.ts");

/** Blank out comments only — string literals are KEPT (an href lives in one). */
function stripComments(text) {
  const out = text.split("");
  const blank = (i) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") blank(i++);
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      blank(i++);
      blank(i++);
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Blank out comments AND string literals — what a "no literal here" pin reads. */
function maskAll(text) {
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

const VIEW_FILE = "src/lib/college-attendance-view.ts";
const PAGE_FILE = "src/app/dashboard/course-attendance/page.tsx";
const viewSource = read(VIEW_FILE);
const pageSource = read(PAGE_FILE);

let checks = 0;
let failures = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log("=== Phase 8 ca-4 — the college course register screen (offline) ===");

/* ------------------------------------------------------------------- 1. purity */

console.log("\n1. the view module is pure, and the page is a client component");
{
  const code = stripComments(viewSource);
  const imports = [...code.matchAll(/^\s*import\s[\s\S]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  check(
    "college-attendance-view.ts imports ONLY ca-1's pure module (no React, no next, no prisma, no node:)",
    imports.length === 1 && imports[0] === "./college-attendance",
    imports.join(", ") || "(no imports)"
  );
  check(
    "it declares no `require(`, no JSX and no I/O",
    !/\brequire\s*\(/.test(code) && !/<[A-Za-z]/.test(code) && !/\bnode:|\bfetch\(|\bwindow\b|\bdocument\b/.test(code)
  );
  const pageCode = stripComments(pageSource);
  check(
    'the page is a client component, imports the view module, ca-0\'s rule and the shell',
    /^"use client";/.test(pageSource.trimStart()) &&
      /from "@\/lib\/college-attendance-view"/.test(pageCode) &&
      /canReadCollegeAttendance/.test(pageCode) &&
      /canWriteCollegeAttendance/.test(pageCode) &&
      /useMe\(\)/.test(pageCode)
  );
}

/* -------------------------------------------------------- 2. the mark vocabulary */

console.log("\n2. the mark vocabulary is ca-1's — the four stored statuses, never the placeholder");
{
  const options = view.statusOptions();
  const want = [...pure.COURSE_ATTENDANCE_STATUSES];
  check(
    "statusOptions() is exactly the four stored statuses, in ca-1's order",
    options.length === want.length && options.every((o, i) => o.value === want[i]),
    options.map((o) => o.value).join(", ")
  );
  check(
    "every option carries a non-empty, distinct word",
    options.every((o) => typeof o.label === "string" && o.label.trim()) &&
      new Set(options.map((o) => o.label)).size === options.length,
    options.map((o) => o.label).join(" · ")
  );
  check(
    "UNMARKED is NOT offered as a choice (ca-1 refuses to store it, and the API skips it)",
    !options.some((o) => o.value === pure.COURSE_ATTENDANCE_UNMARKED) &&
      view.statusLabel(pure.COURSE_ATTENDANCE_UNMARKED) === "Not marked"
  );
  const clearly = [view.NO_COLLEGE_NOTE, view.REFUSED_NOTE, view.READ_ONLY_NOTE, view.PICK_COURSE_NOTE, view.SLOT_HINT, view.noRosterNote("ZZCA-101 — Course A")];
  check(
    "the six notes are non-empty, distinct sentences and the empty-roster note names the course",
    clearly.every((n) => typeof n === "string" && n.length > 20) &&
      new Set(clearly).size === clearly.length &&
      view.noRosterNote("ZZCA-101 — Course A").includes("ZZCA-101")
  );
  check(
    "isStorableStatus admits exactly the four and refuses the placeholder, junk and raw values",
    [...pure.COURSE_ATTENDANCE_STATUSES].every((s) => view.isStorableStatus(s)) &&
      !view.isStorableStatus(pure.COURSE_ATTENDANCE_UNMARKED) &&
      [null, undefined, "", "PRESENT ", 0, {}, "EXCUSED"].every((v) => !view.isStorableStatus(v))
  );
  const tones = options.map((o) => view.markTone(o.value));
  check(
    "each stored status has its own non-empty mark fill, and the placeholder a neutral one",
    new Set(tones).size === 4 &&
      tones.every((t) => typeof t === "string" && t.length > 10) &&
      view.markTone(pure.COURSE_ATTENDANCE_UNMARKED) !== tones[0] &&
      typeof view.markTone("EXCUSED") === "string"
  );
}

/* ------------------------------------------------------------------- 3. the slot */

console.log("\n3. the slot is ca-1's own reader — the screen never parses a second way");
{
  const probe = ["1", "2", 1, 12, undefined, "", "1.0", "0", "-1", "2.5", "x", null, " 3 "];
  const same = probe.filter((v) => view.slotFromInput(v) !== pure.readCourseAttendanceSlot(v));
  check(
    "slotFromInput agrees with readCourseAttendanceSlot on every probed value",
    same.length === 0,
    same.length ? same.map((v) => JSON.stringify(v)).join(", ") : `${probe.length} values`
  );
  check(
    "an absent slot is 1, a real slot parses, and an unusable one is null (never a guess)",
    view.slotFromInput(undefined) === 1 &&
      view.slotFromInput("2") === 2 &&
      view.slotFromInput("2.5") === null &&
      view.slotFromInput("0") === null &&
      view.slotFromInput("x") === null
  );
}

/* --------------------------------------------------------------- 4. the payload */

console.log("\n4. the save payload can only hold rows the API handed over (D-CA-2)");
{
  const rows = view.editableRows([
    { studentId: "s1", name: "Ayesha", admissionNo: "A-1", status: "PRESENT", remark: "  early  " },
    { studentId: "s2", name: "Bashir", status: pure.COURSE_ATTENDANCE_UNMARKED, remark: "" },
    { studentId: "s3", name: "Chitra", status: "ABSENT", remark: null },
    { studentId: "s4", name: "Daud", status: "EXCUSED", remark: "junk" },
    { studentId: "  ", name: "Nobody", status: "PRESENT", remark: "" },
  ]);
  const { rows: payload, skipped } = view.rowsToSave(rows);
  check(
    "rowsToSave sends only storable statuses, trims the remark to null, and counts the rest as skipped",
    payload.length === 2 &&
      skipped === 3 &&
      payload[0].studentId === "s1" &&
      payload[0].status === "PRESENT" &&
      payload[0].remark === "early" &&
      payload[1].studentId === "s3" &&
      payload[1].remark === null,
    `${payload.length} sent / ${skipped} skipped`
  );
  check(
    "the payload's student ids are a SUBSET of what was handed over, in the roster's own order",
    payload.every((row) => ["s1", "s3"].includes(row.studentId)) &&
      payload.map((r) => r.studentId).join() === "s1,s3"
  );
  check(
    "no payload row carries a field beyond the three the API reads",
    payload.every((row) => Object.keys(row).sort().join() === "remark,status,studentId")
  );
  const none = view.rowsToSave([
    { studentId: "s2", name: "B", admissionNo: "", status: pure.COURSE_ATTENDANCE_UNMARKED, remark: "x" },
  ]);
  check(
    "an all-unmarked register sends NOTHING (the API skips the placeholder too)",
    none.rows.length === 0 && none.skipped === 1 && view.rowsToSave(null).rows.length === 0
  );
  const edited = view.withStatus(view.withRemark(view.editableRows([{ studentId: "s1", status: "PRESENT" }]), "s1", " late "), "s1", "LATE");
  check(
    "the grid's own edits address a row by the id the API served, and only that row",
    edited.length === 1 && edited[0].status === "LATE" && edited[0].remark === " late " &&
      view.withStatus(edited, "not-served", "PRESENT")[0].status === "LATE"
  );
}

/* --------------------------------------------------------------- 5. the messages */

console.log("\n5. what the screen says — save truth table, counts, refusals");
{
  check(
    "a save that wrote nothing says so; a save that wrote marks counts them, with the skipped and the notified",
    view.saveMessage({ written: 0, skipped: 0, newlyAbsent: [] }) === "Nothing to save." &&
      view.saveMessage({ written: 0, skipped: 4, newlyAbsent: [] }) ===
        "Nothing to save — every student was left unmarked." &&
      view.saveMessage({ written: 1, skipped: 0, newlyAbsent: [] }) === "Saved 1 mark" &&
      view.saveMessage({ written: 3, skipped: 2, newlyAbsent: [] }) === "Saved 3 marks · 2 left unmarked" &&
      view.saveMessage({ written: 3, skipped: 0, newlyAbsent: ["s1"] }) ===
        "Saved 3 marks · 1 family notified" &&
      view.saveMessage({ written: 3, skipped: 1, newlyAbsent: ["s1", "s2"] }) ===
        "Saved 3 marks · 1 left unmarked · 2 families notified",
    view.saveMessage({ written: 3, skipped: 1, newlyAbsent: ["s1", "s2"] })
  );
  check(
    "junk from the API reads as nothing rather than as a number",
    view.saveMessage(null) === "Nothing to save." &&
      view.saveMessage({ written: "3", skipped: -1, newlyAbsent: "x" }) === "Nothing to save."
  );
  check(
    "the roster and progress lines count what is shown",
    view.rosterCountText([]) === "0 students" &&
      view.rosterCountText([1]) === "1 student" &&
      view.rosterCountText([1, 2, 3]) === "3 students" &&
      view.markedCountText(view.editableRows([
        { studentId: "a", status: "PRESENT" },
        { studentId: "b", status: pure.COURSE_ATTENDANCE_UNMARKED },
      ])) === "1 of 2 marked"
  );
  const cells = view.summaryCells({ total: 3, present: 1, absent: 2, late: 0, leave: 0, unmarked: 0 });
  check(
    "the summary strip is the five counters in order, from the API's own summary",
    cells.map((c) => c.label).join() === "Present,Absent,Late,Leave,Not marked" &&
      cells.map((c) => c.value).join() === "1,2,0,0,0" &&
      view.summaryCells(null).every((c) => c.value === 0)
  );
  check(
    "the course label prefers code and title, and never renders a stray separator",
    view.courseLabel({ code: "ZZCA-101", title: "Course A" }) === "ZZCA-101 — Course A" &&
      view.courseLabel({ code: "", title: "Course A" }) === "Course A" &&
      view.courseLabel({ code: "ZZCA-101" }) === "ZZCA-101" &&
      view.courseLabel(null) === ""
  );
  const errs = [
    view.pageError({ message: "A college attendance status must be PRESENT, ABSENT, LATE or LEAVE.", status: 400 }, "fallback"),
    view.pageError({ status: 403 }, "fallback"),
    view.pageError({ status: 404 }, "fallback"),
    view.pageError({ status: 400 }, "fallback"),
    view.pageError({ status: 401 }, "fallback"),
  ];
  check(
    "a refusal keeps the API's own sentence; only a sentence-less one is mapped, per status",
    errs[0].includes("PRESENT") &&
      errs[1] === "Your role may not read this register." &&
      errs[2] === "That course is not in this college." &&
      errs[3].startsWith("The register refused the request") &&
      errs[4].startsWith("Your session ended") &&
      view.pageError(new Error("boom"), "fallback") === "boom" &&
      view.pageError(null, "fallback") === "fallback"
  );
  check(
    "the save button's label follows the busy flag (the app's own wording)",
    view.saveButtonLabel(false) === "Save register" && view.saveButtonLabel(true) === "Saving…"
  );
}

/* ---------------------------------------------------------------- 6. the page */

console.log("\n6. the page uses the module, ca-0's rule and ONE endpoint — and re-states nothing");
{
  const pageCode = stripComments(pageSource);
  const pageMasked = maskAll(pageSource);
  const statusWords = ["PRESENT", "ABSENT", "LATE", "LEAVE", "UNMARKED"];
  check(
    "the page carries no status literal at all (the words come from ca-1 through the view module)",
    statusWords.every((w) => !new RegExp(w).test(pageMasked)),
    statusWords.filter((w) => new RegExp(w).test(pageMasked)).join(", ") || "none"
  );
  const roleWords = ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"];
  check(
    "the page restates no role list — the allow-lists are ca-0's, called, not copied",
    roleWords.every((w) => !new RegExp(w).test(pageMasked)),
    roleWords.filter((w) => new RegExp(w).test(pageMasked)).join(", ") || "none"
  );
  check(
    "the READ gate is the module AND ca-0's rule (ONE rule for sidebar, screen and API), and marking is ca-0's write list",
    /can\(role, "attendanceMarks", "view"\) && canReadCollegeAttendance\(role\)/.test(pageCode) &&
      /canWriteCollegeAttendance\(role\)/.test(pageCode)
  );
  check(
    "the page reads the ONE register endpoint with qs(), and never the history or the teacher API",
    /ATTENDANCE_ENDPOINT/.test(pageCode) &&
      /qs\(\{ courseId, date, slot \}\)/.test(pageCode) &&
      !/\/history/.test(pageCode) &&
      !/teachers/.test(pageCode)
  );
  check(
    "the save posts to that same endpoint, with the payload built by rowsToSave()",
    /method: "POST"/.test(pageCode) &&
      /rowsToSave\(rows\)/.test(pageCode) &&
      /body: JSON\.stringify\(\{ courseId, date, slot, rows: payload\.rows \}\)/.test(pageCode)
  );
  check(
    "the page never derives an id, never guesses a slot and never invents a student",
    !/courseAttendanceId/.test(pageCode) &&
      !/readCourseAttendanceSlot/.test(pageCode) &&
      /slotFromInput\(slotInput\)/.test(pageCode) &&
      /editableRows\(data\?\.rows\)/.test(pageCode)
  );
  check(
    "the grid renders the module's options and tones, and the save control only when the caller may mark",
    /statusOptions\(\)\.map/.test(pageCode) &&
      /markTone\(option\.value\)/.test(pageCode) &&
      /canMark \? \(/.test(pageCode)
  );
  check(
    "the college gate and the four notes come from the shared modules, before any read",
    /hasCollege\(normalizeInstitutionType\(institutionType\)\)/.test(pageCode) &&
      /NO_COLLEGE_NOTE/.test(pageCode) &&
      /REFUSED_NOTE/.test(pageCode) &&
      /READ_ONLY_NOTE/.test(pageCode) &&
      /noRosterNote\(/.test(pageCode)
  );
  const readEffect = pageCode.indexOf("api<CourseLite[]>(\"/api/courses\")");
  const gateAt = pageCode.indexOf("if (!ready) return;");
  check(
    "both read effects return before issuing a request until the gate resolves",
    gateAt > 0 && readEffect > gateAt && (pageCode.match(/if \(!ready\) return;/g) || []).length >= 2
  );
}

/* -------------------------------------------------------- 7. the API contract */

console.log("\n7. the screen speaks ca-3's contract — the keys it reads are the keys the route serves");
{
  const route = stripComments(read("src/app/api/course-attendance/route.ts"));
  const pageCode = stripComments(pageSource);
  check(
    "the route serves rows/summary/course/dateKey/slot, and the page reads exactly those",
    ["rows", "summary", "course", "dateKey", "slot"].every((key) => new RegExp(`\\b${key}\\b`).test(route)) &&
      /interface RegisterPayload/.test(pageCode) &&
      /data\?\.rows/.test(pageCode) &&
      /data\?\.summary/.test(pageCode)
  );
  check(
    "the route's refusals are the ones the screen maps (400 by name, 404 for a foreign course)",
    /status: 400/.test(route) && /status: 404/.test(route) && /COURSE_ATTENDANCE_ROSTER_REFUSAL/.test(route)
  );
  check(
    "the nav entry exists for exactly the roles ca-0 admits with a dashboard nav, and the nav proof names it",
    ["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR"].every((role) =>
      (nav.NAVS[role] || []).some((i) => i.href === "/dashboard/course-attendance" && i.requires === "COLLEGE")
    ) &&
      !(nav.NAVS.ACCOUNTANT || []).some((i) => i.href === "/dashboard/course-attendance") &&
      !(nav.NAVS.TEACHER || []).some((i) => i.href === "/dashboard/course-attendance") &&
      /\/dashboard\/course-attendance/.test(read("scripts/verify-nav-scope.mjs"))
  );
  check(
    "ca-0's READ list is what the screen and the nav agree on, and the REGISTRAR is read-only in it",
    access.COLLEGE_ATTENDANCE_READ_ROLES.includes("REGISTRAR") &&
      !access.COLLEGE_ATTENDANCE_WRITE_ROLES.includes("REGISTRAR") &&
      !access.COLLEGE_ATTENDANCE_READ_ROLES.includes("TEACHER")
  );
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ COLLEGE ATTENDANCE PAGE FAILED — ${failures} of ${checks} check(s) failed.`);
  process.exit(1);
}
console.log(
  `✅ COLLEGE ATTENDANCE PAGE OK — ${checks} check(s): the mark vocabulary is ca-1's four stored statuses ` +
    `(never the placeholder), the save payload can only hold rows the API handed over, the slot parser IS ` +
    `ca-1's reader, the save message states what happened including D-CA-3's notification count, the refusals ` +
    `keep the API's own sentence, and the page goes through the ONE rule, the ONE endpoint and the ONE ` +
    `vocabulary — with no status literal or role list of its own. It does NOT prove the page renders.`
);
