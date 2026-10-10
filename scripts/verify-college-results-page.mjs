#!/usr/bin/env node
/**
 * verify-college-results-page.mjs — Phase 6d: the college results screen and the
 * transcript PRINT page, proved OFFLINE (docs/COLLEGE-DECISIONS.md §23, D-6-6,
 * D-6-12, D-6-14, D-6-16, Q3).
 *
 * `src/lib/college-results-view.ts` holds every NON-JSX decision the two pages
 * make: how the active scheme's scale is described, whether a GPA figure is shown
 * at all, how a retake attempt is marked effective/superseded, and whether the
 * record form is usable. This script pins that module — and the fact that BOTH
 * pages still USE it, and that neither re-inlines a literal the module owns — with
 * no database, no server and no network, so it carries **no `requireEmulator()`
 * guard** and runs on plain `node`, the same design as
 * `verify-college-promotion-page.mjs`, `verify-college-terms.mjs` and
 * `verify-registration-status.mjs`.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT — read this before trusting it:
 *
 *   ✅ PROVES: the scale line for every shipped preset (5.00/4.00 GPA, letters-only
 *      and percent-only no-GPA scales), the D-6-16 rule that a no-GPA scheme never
 *      yields a numeric figure, the retake marking (Q3), the record-form truth
 *      table, the v1 READ allow-list (6d-fix — admin roles + REGISTRAR, with
 *      TEACHER/GUARDIAN/STUDENT denied) and that both pages go through that ONE
 *      rule instead of restating it, and — statically — that the print page goes
 *      through the module for the scale and the GPA figure rather than formatting
 *      them by hand.
 *
 *   ❌ DOES NOT PROVE THAT A PAGE RENDERS. There is no DOM here, no React, no
 *      browser and no server: nothing in this file mounts a page, clicks a button,
 *      signs in, or performs an API round trip. A REAL BROWSER TEST is a separate,
 *      recorded step. Treat a green run here as "the pages' non-visual logic is
 *      right", never as "the pages work".
 *
 *   node scripts/verify-college-results-page.mjs
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension,
 * so this local, synchronous hook retries a failed relative specifier with `.ts`
 * appended — the same approach as the sibling offline verifiers, scoped to this
 * process. Nothing is installed and no loader flag is needed.
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

const ACCESS_URL = new URL("../src/lib/college-results-access.ts", import.meta.url);
const MODULE_URL = new URL("../src/lib/college-results-view.ts", import.meta.url);
const PAGE_URL = new URL("../src/app/dashboard/college-results/page.tsx", import.meta.url);
const PRINT_URL = new URL("../src/app/print/college-transcript/[studentId]/page.tsx", import.meta.url);
const NAV_URL = new URL("../src/components/nav.ts", import.meta.url);

const accessSource = readFileSync(ACCESS_URL, "utf8");
const source = readFileSync(MODULE_URL, "utf8");
const pageSource = readFileSync(PAGE_URL, "utf8");
const printSource = readFileSync(PRINT_URL, "utf8");
const navSource = readFileSync(NAV_URL, "utf8");

const view = await import(MODULE_URL.href);
const access = await import(ACCESS_URL.href);
const {
  PAGE_ERRORS,
  GRADING_EDITOR_HREF,
  messageOf,
  showsGpaFigure,
  scaleLine,
  formatGpa,
  percentText,
  gradeText,
  noGpaNote,
  policyWords,
  policyLine,
  attemptStatus,
  attemptSummary,
  hasRetakes,
  weightingBasisText,
  transcriptHref,
  resultsCountText,
  recordDisabled,
  recordBlocked,
  recordButtonLabel,
} = view;

const { canReadCollegeResults, COLLEGE_RESULTS_READ_ROLES } = access;

const { GRADING_PRESETS } = await import(new URL("../src/lib/grading.ts", import.meta.url).href);

/**
 * Blank out comments and string literals, PRESERVING LENGTH, so a token search
 * runs against code only — the pages document themselves in prose, and the
 * module's own header names "page.tsx", "DOM" and "React".
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

/**
 * Blank out COMMENTS only (kept: string literals), PRESERVING LENGTH. Used for the
 * "must not hard-code this literal" checks: a real hard-coded value lives in a
 * string literal and is kept, while the pages' prose (which names their own file
 * path) is blanked.
 */
function stripComments(text) {
  const out = text.split("");
  const blank = (i) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
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
    i += 1;
  }
  return out.join("");
}

const accessCode = maskCommentsAndStrings(accessSource);
const accessNoComments = stripComments(accessSource);
const viewCode = maskCommentsAndStrings(source);
const pageCode = maskCommentsAndStrings(pageSource);
const printCode = maskCommentsAndStrings(printSource);
const pageNoComments = stripComments(pageSource);
const printNoComments = stripComments(printSource);

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const eq = (label, got, want) => check(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

console.log("=== college results page + transcript print (offline) ===");

/* ------------------------------------------------------------------ 1. purity */

console.log("\n1. the view module is dependency-free, and both pages use it");
{
  check("college-results-view.ts declares no import/require", !/\bimport\b|\brequire\s*\(/.test(viewCode));
  // The read rule must stay import-free too: the results SCREEN is a client
  // component and imports it, so a prisma/`next/server` import here would drag the
  // database into the browser bundle.
  check("college-results-access.ts declares no import/require", !/\bimport\b|\brequire\s*\(/.test(accessCode));
  // The import specifier and every "must not contain" literal live in STRING
  // LITERALS, which `maskCommentsAndStrings` blanks — so these read RAW source.
  check("the results page imports the view module", /@\/lib\/college-results-view/.test(pageSource));
  check("the print page imports the view module", /@\/lib\/college-results-view/.test(printSource));
  // The literal the module owns must not be re-inlined in a page.
  check(
    "neither page re-inlines the transcript path",
    !pageNoComments.includes("/print/college-transcript/") && !printNoComments.includes("/print/college-transcript/")
  );
  check("the results page does not hard-format a scale line", !pageNoComments.includes("GPA out of"));
  check("the print page does not hard-format a scale line", !printNoComments.includes("GPA out of"));
}

/* ------------------------------------------------------- 2. the scale (D-6-6) */

console.log("\n2. the scale line names a GPA scale, or the GPA-free shape (D-6-6)");
{
  const byKey = new Map(GRADING_PRESETS.map((p) => [p.key, p.scheme]));
  eq("bd-5 → GPA out of 5.00", scaleLine(byKey.get("bd-5")), "GPA out of 5.00");
  eq("gpa-4 → GPA out of 4.00", scaleLine(byKey.get("gpa-4")), "GPA out of 4.00");
  eq("letters-5 → GPA out of 5.00", scaleLine(byKey.get("letters-5")), "GPA out of 5.00");
  eq("bd-university-4 → GPA out of 4.00", scaleLine(byKey.get("bd-university-4")), "GPA out of 4.00");
  eq("eng-medium-letters → letters only", scaleLine(byKey.get("eng-medium-letters")), "letters only");
  eq("percent-only → percent only", scaleLine(byKey.get("percent-only")), "percent only");
  eq("no scheme → empty line", scaleLine(null), "");
  // Every preset's own showGpa agrees with the figure rule.
  let agree = true;
  for (const p of GRADING_PRESETS) {
    if (showsGpaFigure(p.scheme) !== (p.scheme.showGpa !== false)) agree = false;
  }
  check("showsGpaFigure agrees with every preset's showGpa", agree, `${GRADING_PRESETS.length} presets`);
}

/* ----------------------------------------------- 3. no-GPA never prints 0.00 */

console.log("\n3. a no-GPA scheme yields NO figure — never a printed 0.00 (D-6-16)");
{
  const values = [0, 4.5, 5, "3.2", null, undefined, "", "  ", NaN, Infinity, -1];
  let leaked = null;
  for (const v of values) {
    if (formatGpa(v, false) !== null) leaked = v;
  }
  check("formatGpa(any value, showGpa=false) is ALWAYS null", leaked === null, leaked === null ? `${values.length} inputs` : `leaked for ${String(leaked)}`);
  eq("formatGpa(4.5, true) → 4.50", formatGpa(4.5, true), "4.50");
  eq("formatGpa(0, true) → 0.00 (a REAL zero still prints)", formatGpa(0, true), "0.00");
  eq("formatGpa(null, true) → null (absent is not zero)", formatGpa(null, true), null);
  eq("formatGpa('', true) → null", formatGpa("", true), null);
  eq("formatGpa(NaN, true) → null", formatGpa(NaN, true), null);
  eq("formatGpa('2.50', true) → 2.50", formatGpa("2.50", true), "2.50");
  check("noGpaNote names the rule", /0\.00/.test(noGpaNote()) && /omitted/.test(noGpaNote()));
  // The print page must route the GPA figure through the module, and render a dash otherwise.
  check("print page uses formatGpa", /formatGpa\(/.test(printCode));
  // The ONLY hand-formatted figure left on the print page is the scale's own
  // label (`gpaScale.toFixed(2)`); every GPA point and the CGPA go through the
  // module, so a no-GPA scheme cannot print a number at all.
  const fixed = [...printNoComments.matchAll(/(\w+)\.toFixed\(2\)/g)].map((m) => m[1]);
  check(
    "print page hand-formats nothing but the scale label",
    fixed.length > 0 && fixed.every((name) => name === "gpaScale"),
    fixed.join(", ") || "none"
  );
}

/* -------------------------------------------------------- 4. retakes (Q3/D-6-8) */

console.log("\n4. every attempt is listed with the effective one marked (Q3)");
{
  const att = (attempt, percent, effective) => ({ attempt, percent, effective, superseded: !effective });
  eq("the effective attempt reads Effective", attemptStatus(att(2, 64, true)), "Effective");
  eq("a superseded attempt reads Superseded", attemptStatus(att(1, 40, false)), "Superseded");
  eq("an empty attempt reads Superseded (never Effective)", attemptStatus(null), "Superseded");
  eq("attempt 2, 64% → summary", attemptSummary(att(2, 64, true)), "Attempt 2 — 64.00% — Effective");
  eq("a junk attempt number still labels", attemptSummary({ attempt: "x", percent: 50 }), "Attempt — 50.00% — Superseded");
  eq("one attempt is not a retake", hasRetakes([att(1, 50, true)]), false);
  eq("two attempts are a retake", hasRetakes([att(1, 40, false), att(2, 64, true)]), true);
  eq("no attempts is not a retake", hasRetakes([]), false);
  for (const policy of ["REPLACE", "BEST", "BOTH", "AVERAGE"]) {
    eq(`${policy}: no retakes recorded at limit 0`, policyLine({ policy, maxRetakes: 0 }), "Retakes: no retakes recorded");
  }
  eq("BEST, limit 2", policyLine({ policy: "BEST", maxRetakes: 2 }), "Retakes: best attempt counts, up to 2 retakes");
  eq("REPLACE, limit 1 (singular)", policyLine({ policy: "REPLACE", maxRetakes: 1 }), "Retakes: latest attempt counts, up to 1 retake");
  eq("AVERAGE, unlimited", policyLine({ policy: "AVERAGE", maxRetakes: null }), "Retakes: attempts averaged, unlimited");
  eq("absent block reads as no retakes", policyLine(undefined), "Retakes: no retakes recorded");
  eq("an odd limit reads as no retakes", policyLine({ policy: "BOTH", maxRetakes: 1.5 }), "Retakes: no retakes recorded");
  eq("policyWords of an unknown policy", policyWords("NOPE"), "latest attempt counts");
  // The print page marks attempts through the module.
  check("print page uses attemptSummary", /attemptSummary\(/.test(printCode));
  check("print page uses attemptStatus", /attemptStatus\(/.test(printCode));
}

/* --------------------------------------------------- 5. weighting (D-6-11) */

console.log("\n5. the weighting basis is stated, not guessed (Q2/D-6-11)");
{
  eq("credits → weighted by credit hours", weightingBasisText("credits"), "Weighted by credit hours");
  eq("courses → one per course", weightingBasisText("courses"), "One per course (no credit hours recorded)");
  eq("none → nothing to say", weightingBasisText("none"), "");
  eq("unknown → nothing to say", weightingBasisText(undefined), "");
  check("print page states the weighting basis", /weightingBasisText\(/.test(printCode));
}

/* -------------------------------------------------------- 6. wording & wiring */

console.log("\n6. counts, links and copy");
{
  eq("1 result is singular", resultsCountText(1), "1 result");
  eq("3 results is plural", resultsCountText(3), "3 results");
  eq("a non-number counts 0", resultsCountText(undefined), "0 results");
  eq("the transcript path encodes the id", transcriptHref("ab/c"), "/print/college-transcript/ab%2Fc");
  eq("an absent id makes the root path", transcriptHref(null), "/print/college-transcript/");
  eq("the grading editor href", GRADING_EDITOR_HREF, "/dashboard/grades");
  check("the results page links to the grading editor (one click to presets)", /GRADING_EDITOR_HREF/.test(pageCode));
  check("the results page links transcripts through transcriptHref", /transcriptHref\(/.test(pageCode));
  eq("messageOf prefers the server text", messageOf(new Error("nope"), "fallback"), "nope");
  eq("messageOf falls back on an empty error", messageOf({}, "fallback"), "fallback");
  eq("messageOf falls back on null", messageOf(null, "fallback"), "fallback");
  check("PAGE_ERRORS carries every load's fallback", ["scheme", "students", "courses", "results", "record"].every((k) => typeof PAGE_ERRORS[k] === "string"));
}

/* ------------------------------------------------------ 7. the record form */

console.log("\n7. the record form's truth table");
{
  const base = { studentId: "s", courseId: "c", obtained: "70", fullMarks: "100", busy: false };
  eq("a complete form is enabled", recordDisabled(base), false);
  eq("a missing student disables", recordDisabled({ ...base, studentId: "" }), true);
  eq("a missing course disables", recordDisabled({ ...base, courseId: "" }), true);
  eq("an empty obtained disables", recordDisabled({ ...base, obtained: "" }), true);
  eq("a non-numeric obtained disables", recordDisabled({ ...base, obtained: "abc" }), true);
  eq("a negative obtained disables", recordDisabled({ ...base, obtained: "-1" }), true);
  eq("a zero full marks disables", recordDisabled({ ...base, fullMarks: "0" }), true);
  eq("obtained above full disables", recordDisabled({ ...base, obtained: "101" }), true);
  eq("a busy form disables", recordDisabled({ ...base, busy: true }), true);
  eq("full marks equal to obtained is allowed", recordDisabled({ ...base, obtained: "100" }), false);
  eq("a zero obtained is allowed", recordDisabled({ ...base, obtained: "0" }), false);
  eq("recordBlocked mirrors recordDisabled", recordBlocked(base), recordDisabled(base));
  eq("recordBlocked blocks a busy form", recordBlocked({ ...base, busy: true }), true);
  eq("the button label while busy", recordButtonLabel(true), "Recording…");
  eq("the button label while idle", recordButtonLabel(false), "Record result");
  check("the results page gates recording on recordDisabled", /recordDisabled\(/.test(pageCode));
  check("the results page gates the handler on recordBlocked", /recordBlocked\(/.test(pageCode));
  check("the results page sends only ids + marks to the API", /body:\s*JSON\.stringify\(\{\s*studentId,\s*courseId,\s*obtained:/.test(pageCode));
}

/* ------------------------------------------- 8. the print page's requirements */

console.log("\n8. the print page prints what D-6-14 requires, and gates the tenant");
{
  check("prints the scheme NAME", /scheme\.name/.test(printCode));
  check("prints the scale through scaleLine", /scaleLine\(scheme\)/.test(printCode));
  check("prints the PASS MARK", /scheme\.passPercent/.test(printCode));
  check("prints the PRINT DATE", /generatedAt/.test(printCode) && /fmtDate\(/.test(printCode));
  check("gates the tenant with collegeGateDecision", /collegeGateDecision\(/.test(printCode));
  check("requires a session", /getSession\(\)/.test(printCode));
  check("confines the student to the session's tenant", /student\.schoolId !== session\.schoolId/.test(printCode));
  check("confines the branch", /canAccessBranch\(/.test(printCode));
  // EDITED IN 6d-fix (disclosed, not weakened): this check used to assert that the
  // print page required `attendanceMarks` view (Q5). The owner ruling of
  // 2026-10-10 REPLACED that gate for reads with the narrower allow-list in
  // `src/lib/college-results-access.ts`, so the old assertion describes behaviour
  // the ruling forbids. It now asserts the gate that actually protects the page —
  // a STRICTLY stronger rule (four roles, not the module's seven) — and section 10
  // below pins the whole truth table. The module name is a STRING LITERAL in
  // `can(...)`, so this read RAW source; the allow-list call is code, so it reads
  // the masked code.
  check(
    "gates the read with the shared v1 allow-list (6d-fix; replaced the Q5 module check)",
    /canReadCollegeResults\(/.test(printCode) && !/attendanceMarks/.test(printSource)
  );
  check("omits the CGPA block under a no-GPA scheme", /showGpa &&/.test(printCode) && /transcript\.cgpa/.test(printCode));
  check("the results screen names the scheme and the scale", /scheme\?\.name/.test(pageCode) && /scaleLine\(/.test(pageCode));
  check("the results screen renders no GPA column under a no-GPA scheme", /showGpa &&/.test(pageCode));
  // RECORDING is unchanged by 6d-fix: it still needs `attendanceMarks` full (Q5),
  // which is why the screen keeps importing `can` — the read rule only narrows reads.
  check(
    "recording still needs attendanceMarks full (writes unchanged)",
    /attendanceMarks/.test(pageSource) && /can\(role, "attendanceMarks", "full"\)/.test(pageSource)
  );
}

/* ------------------------------------------------------------- 9. the nav (Q4) */

console.log("\n9. exactly ONE new college nav entry (Q4)");
{
  const hits = navSource.split("\n").filter((line) => line.includes('href: "/dashboard/college-results"'));
  check("the results screen is one registry item per college role", hits.length === 3, `${hits.length} entries`);
  check("every one is behind requires COLLEGE", hits.every((l) => l.includes('requires: "COLLEGE"')));
  check(
    "the item is grouped in `academics`",
    /"\/dashboard\/college-results": "academics"/.test(navSource)
  );
}

/* --------------------------------------------------- 10. the v1 read allow-list */

console.log("\n10. v1 READ access (6d-fix) — admin roles + REGISTRAR only, in ONE rule");
{
  // Every storable role, plus the raw values a session may carry.
  const ALLOWED = ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR"];
  const DENIED = ["TEACHER", "GUARDIAN", "STUDENT", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"];
  check(
    "the allow-list is exactly the four ordered roles",
    JSON.stringify([...COLLEGE_RESULTS_READ_ROLES]) === JSON.stringify(ALLOWED),
    COLLEGE_RESULTS_READ_ROLES.join(", ")
  );
  let leaks = null;
  for (const role of ALLOWED) if (!canReadCollegeResults(role)) leaks = `denied ${role}`;
  for (const role of DENIED) if (canReadCollegeResults(role)) leaks = `allowed ${role}`;
  for (const raw of [undefined, null, "", "  ", "NOT_A_ROLE", 0, {}, [], "super_admin", "Registrar"]) {
    if (canReadCollegeResults(raw)) leaks = `allowed ${JSON.stringify(raw)}`;
  }
  check(
    "the truth table holds (4 allowed, 6 roles + 9 raw values denied)",
    leaks === null,
    leaks || `${ALLOWED.length} allowed, ${DENIED.length + 9} denied`
  );
  check("the refusal names who may read", /administration/.test(access.COLLEGE_RESULTS_READ_REFUSAL));

  // Both consumers must go THROUGH the rule, and neither may restate the list.
  check("the print page gates on canReadCollegeResults", /canReadCollegeResults\(/.test(printCode));
  check("the results screen gates on canReadCollegeResults", /canReadCollegeResults\(/.test(pageCode));
  let restated = [];
  for (const [name, text] of [["the print page", printNoComments], ["the results screen", pageNoComments]]) {
    if (/"REGISTRAR"|'REGISTRAR'/.test(text)) restated.push(name);
  }
  check("no page re-states the role list", restated.length === 0, restated.join(", ") || "the rule is used, never copied");
  check("the print page no longer relies on the module alone", !/attendanceMarks/.test(printNoComments));

  // The sidebar must not offer the screen to a role the rule denies.
  const navHits = navSource.split("\n").filter((l) => l.includes('href: "/dashboard/college-results"'));
  const carriers = navHits.map((l) => (l.match(/label: "([^"]+)"/) || [])[1]).filter(Boolean);
  const navRoles = [];
  for (const role of ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "TEACHER", "GUARDIAN", "STUDENT"]) {
    const block = navSource.slice(navSource.indexOf(`  ${role}: [`));
    const end = block.indexOf("  ],");
    if (end > 0 && block.slice(0, end).includes('href: "/dashboard/college-results"')) navRoles.push(role);
  }
  check(
    "the nav offers it only to the read roles (SCHOOL_ADMIN, BRANCH_ADMIN, REGISTRAR)",
    JSON.stringify(navRoles) === JSON.stringify(["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR"]),
    navRoles.join(", ") || "no carrier"
  );
  check("…and every carrier is on the rule's allow-list", navRoles.every((r) => canReadCollegeResults(r)));
  check("the nav entry keeps its one label", carriers.length === navHits.length && carriers.every((c) => c === "College Results"), carriers.join(", ") || "none");
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ college results page verification FAILED — ${failures} of ${checks} check(s).`);
  process.exit(1);
}
console.log(`✅ college results page verification PASSED — ${checks} checks.`);
