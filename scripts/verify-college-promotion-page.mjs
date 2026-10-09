#!/usr/bin/env node
/**
 * Phase 6-pre 1 — the college promotion page's view logic, proved OFFLINE
 * (docs/COLLEGE-DECISIONS.md §21).
 *
 * `src/lib/college-promotion-view.ts` holds every NON-JSX decision the page makes:
 * which warnings appear, how the D6 pending figure is phrased, whether a control is
 * disabled and whether a handler may proceed, what the confirmation dialog promises,
 * what the server's report becomes, and what the failure path re-fetches. This script
 * pins that module — and the fact that `page.tsx` still USES it — with no database, no
 * server and no network, so it carries **no `requireEmulator()` guard** and runs on
 * plain `node`, the same design as `verify-college-promotion-logic.mjs`,
 * `verify-college-terms.mjs` and `verify-registration-status.mjs`.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT — read this before trusting it:
 *
 *   ✅ PROVES: the decisions above, exhaustively over their inputs, including the
 *      singular/plural rule, the disabled/refused truth tables, the warning
 *      predicates, the confirmation verb and destination, and the failure-path
 *      refresh list. It also proves the extraction cannot silently regress: the page
 *      must import the module, and the literals the module now owns must be GONE
 *      from the page (no duplicate left behind).
 *
 *   ❌ DOES NOT PROVE THAT THE PAGE RENDERS. There is no DOM here, no React, no
 *      browser and no server: nothing in this file mounts the page, clicks a button,
 *      signs in, or performs an API round trip. A REAL BROWSER TEST (real login →
 *      real page → real API) is still **NOT DONE** and would need a browser driver
 *      this project does not depend on (§21). Treat a green run here as "the page's
 *      non-visual logic is right", never as "the page works".
 *
 *   node scripts/verify-college-promotion-page.mjs
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension, so
 * this local, synchronous hook retries a failed relative specifier with `.ts`
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

const MODULE_URL = new URL("../src/lib/college-promotion-view.ts", import.meta.url);
const PAGE_URL = new URL("../src/app/dashboard/college-promotion/page.tsx", import.meta.url);
const source = readFileSync(MODULE_URL, "utf8");
const pageSource = readFileSync(PAGE_URL, "utf8");

const {
  PENDING_TOOLTIP,
  pendingRequests,
  LADDER_RUN_WARNING,
  PAGE_ERRORS,
  UNNAMED_PROGRAM,
  messageOf,
  applyDisabled,
  applyBlocked,
  ladderRunDisabled,
  previewLadderDisabled,
  ladderRunButtonLabel,
  applyButtonLabel,
  showGraduatingBanner,
  showClassIdBanner,
  showDestinationLine,
  classIdBannerText,
  rowNote,
  stepNote,
  confirmSummary,
  emptyCohortTitle,
  applyResultMessage,
  ladderRunMessage,
  ladderGraduateText,
  LADDER_FAILURE_REFRESH,
  LADDER_FAILURE_REFRESH_IS_SILENT,
} = await import(MODULE_URL.href);

/**
 * Blank out comments and string literals, PRESERVING LENGTH, so a token search runs
 * against code only. The module documents the page ("page.tsx", "React", "DOM") in
 * its own prose, so scanning the raw text would match the documentation.
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

const code = maskCommentsAndStrings(source);

let failures = 0;
let checks = 0;
const ok = (msg) => {
  checks += 1;
  console.log(`  ✅ ${msg}`);
};
const bad = (scope, msg) => {
  checks += 1;
  failures += 1;
  console.log(`  ❌ [${scope}] ${msg}`);
};

console.log("=== Phase 6-pre 1 college promotion page logic (offline) ===");
console.log(`module: src/lib/college-promotion-view.ts (${source.split("\n").length} lines)`);
console.log(`page:   src/app/dashboard/college-promotion/page.tsx (${pageSource.split("\n").length} lines)`);
console.log("NOTE: this verifies the page's LOGIC only. It does NOT render the page;");
console.log("      a real browser test is still NOT DONE (§21).");

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. dependency-free — no import, no require(), no React, no prisma, no node:");
{
  const importAt = code.search(/\bimport\b/);
  const requireAt = code.search(/\brequire\s*\(/);
  const surfaces = [
    ["React/JSX", /\b(useState|useEffect|useMemo|useCallback|React|jsx|tsx)\b/],
    ["prisma", /\bprisma\b/],
    ["node:", /\bnode:/],
  ];
  const hit = surfaces.find(([, re]) => re.test(code));
  if (importAt >= 0) bad("dependencies", `\`import\` appears at character ${importAt} — the module must stay dependency-free`);
  else if (requireAt >= 0) bad("dependencies", `\`require(\` appears at character ${requireAt} — the module must stay dependency-free`);
  else if (hit) bad("dependencies", `the module names a ${hit[0]} surface — it must be pure view logic`);
  else ok("no `import`, no `require(`, and no React/prisma/node: surface — pure, importable anywhere");
}

/* ------------------------------------------------------------------------ 2 */

console.log("\n2. the page CONSUMES the module — and the moved literals are gone from it");
{
  const grouped = [
    ["@/lib/college-promotion-view", 'the page imports the module'],
  ];
  const mustCall = [
    "applyDisabled",
    "applyBlocked",
    "ladderRunDisabled",
    "previewLadderDisabled",
    "messageOf",
    "rowNote",
    "stepNote",
    "confirmSummary",
    "classIdBannerText",
    "emptyCohortTitle",
    "LADDER_RUN_WARNING",
    "LADDER_FAILURE_REFRESH",
    "PENDING_TOOLTIP",
  ];
  const missing = mustCall.filter((n) => !pageSource.includes(n));
  // The literals the module now owns. If any of these is back in the page, the
  // extraction has been duplicated and the two copies can drift apart.
  const forbidden = [
    'const pendingRequests =',
    "Could not load programmes",
    "The ladder could not be run",
    "Run this one at a time:",
    "Nobody is at term",
    "will graduate",
    "Graduated ${res.graduated}",
  ];
  const leaked = forbidden.filter((f) => pageSource.includes(f));
  if (grouped.some(([token]) => !pageSource.includes(token))) {
    bad("consumes", "the page no longer imports @/lib/college-promotion-view");
  } else if (missing.length) {
    bad("consumes", `the page does not use ${JSON.stringify(missing)} — the extraction is not wired in`);
  } else if (leaked.length) {
    bad("consumes", `the page still inlines ${JSON.stringify(leaked)} — the module's wording is duplicated`);
  } else {
    ok(`${mustCall.length} module names used by the page, and ${forbidden.length} moved literal(s) are absent from it`);
  }
}

/* ------------------------------------------------------------------------ 3 */

console.log("\n3. the D6 pending figure — requests, never students (D6)");
{
  const cases = [
    [0, "0 pending course requests"],
    [1, "1 pending course request"],
    [2, "2 pending course requests"],
    [10, "10 pending course requests"],
    [undefined, "0 pending course requests"],
    [null, "0 pending course requests"],
    [NaN, "0 pending course requests"],
    ["3", "0 pending course requests"],
  ];
  let problem = null;
  for (const [input, want] of cases) {
    const got = pendingRequests(input);
    if (got !== want) {
      problem = `pendingRequests(${String(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      break;
    }
  }
  if (problem) bad("pending", problem);
  else if (/\bpending students\b/i.test(PENDING_TOOLTIP)) bad("pending", "the tooltip says \"pending students\" — D6 forbids the student reading");
  else if (!/not a student count/.test(PENDING_TOOLTIP) || !/does not block/.test(PENDING_TOOLTIP))
    bad("pending", "the tooltip no longer states that it is not a student count and does not block a promotion");
  else ok(`${cases.length} inputs: the singular is exactly 1, and the tooltip states requests-only, non-blocking`);
}

/* ------------------------------------------------------------------------ 4 */

console.log("\n4. the run-in-progress warning is present and truthful");
{
  if (!/no run lock/.test(LADDER_RUN_WARNING)) bad("warning", `LADDER_RUN_WARNING no longer states there is no run lock: ${JSON.stringify(LADDER_RUN_WARNING)}`);
  else if (!/two runs at once/.test(LADDER_RUN_WARNING)) bad("warning", "the warning no longer names the two-runs-at-once hazard");
  else ok("the warning names the two-runs-at-once hazard and states there is no run lock");
}

/* ------------------------------------------------------------------------ 5 */

console.log("\n5. PAGE_ERRORS and messageOf — the failure phrasing, exactly");
{
  const want = {
    programs: "Could not load programmes",
    preview: "Could not load the preview",
    ladderPlan: "Could not build the ladder plan",
    apply: "The promotion could not be applied",
    ladderRun: "The ladder could not be run",
  };
  const keys = Object.keys(PAGE_ERRORS);
  let problem = null;
  for (const [k, v] of Object.entries(want)) {
    if (PAGE_ERRORS[k] !== v) problem = `PAGE_ERRORS.${k} = ${JSON.stringify(PAGE_ERRORS[k])}, expected ${JSON.stringify(v)}`;
    if (problem) break;
  }
  if (!problem && keys.length !== Object.keys(want).length) problem = `PAGE_ERRORS has ${keys.length} entries, expected ${Object.keys(want).length}`;
  // messageOf: a falsy message reads as the fallback (the page's own rule).
  const msgCases = [
    [null, "FB"],
    [undefined, "FB"],
    [{}, "FB"],
    ["", "FB"],
    [{ message: "" }, "FB"],
    [{ message: "boom" }, "boom"],
    [new Error("kaput"), "kaput"],
  ];
  if (!problem) {
    for (const [input, wantOut] of msgCases) {
      const got = messageOf(input, "FB");
      if (got !== wantOut) {
        problem = `messageOf(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(wantOut)}`;
        break;
      }
    }
  }
  if (problem) bad("errors", problem);
  else if (UNNAMED_PROGRAM !== "the programme") bad("errors", `UNNAMED_PROGRAM = ${JSON.stringify(UNNAMED_PROGRAM)}, expected "the programme"`);
  else ok(`5 error strings exact; ${msgCases.length} messageOf inputs, with a falsy message reading as the fallback`);
}

/* ------------------------------------------------------------------------ 6 */

console.log("\n6. the disabled predicates and handler guards — a truth table each");
{
  const rows = [
    [{ hasPreview: false, count: 1, busy: false, previewLoading: false }, true],
    [{ hasPreview: true, count: 0, busy: false, previewLoading: false }, true],
    [{ hasPreview: true, count: 1, busy: true, previewLoading: false }, true],
    [{ hasPreview: true, count: 1, busy: false, previewLoading: true }, true],
    [{ hasPreview: true, count: 1, busy: false, previewLoading: false }, false],
  ];
  let problem = null;
  for (const [input, want] of rows) {
    const got = applyDisabled(input);
    if (got !== want) {
      problem = `applyDisabled(${JSON.stringify(input)}) = ${got}, expected ${want}`;
      break;
    }
  }
  // The two "cannot go" rules must agree; they are the same expression by intent.
  for (const count of [0, 1, 3]) {
    for (const busy of [false, true]) {
      if (problem) break;
      if (applyBlocked({ count, busy }) !== ladderRunDisabled({ count, busy }))
        problem = `applyBlocked and ladderRunDisabled disagree at count=${count} busy=${busy}`;
    }
  }
  if (!problem) {
    for (const [count, busy, want] of [
      [0, false, true],
      [0, true, true],
      [2, true, true],
      [2, false, false],
    ]) {
      if (ladderRunDisabled({ count, busy }) !== want) problem = `ladderRunDisabled(${count}, ${busy}) should be ${want}`;
    }
  }
  if (!problem) {
    for (const [programId, busy, want] of [
      ["", false, true],
      ["p", true, true],
      ["p", false, false],
    ]) {
      if (previewLadderDisabled({ programId, busy }) !== want) problem = `previewLadderDisabled(${JSON.stringify(programId)}, ${busy}) should be ${want}`;
    }
  }
  if (problem) bad("disabled", problem);
  else ok(`${rows.length} apply rows + the two agreement rows + the ladder/preview tables all hold`);
}

/* ------------------------------------------------------------------------ 7 */

console.log("\n7. button labels — the verb follows the action, never a generic label");
{
  let problem = null;
  if (applyButtonLabel(true) !== "Graduate the cohort") problem = `applyButtonLabel(true) = ${applyButtonLabel(true)}`;
  else if (applyButtonLabel(false) !== "Advance the cohort") problem = `applyButtonLabel(false) = ${applyButtonLabel(false)}`;
  else if (ladderRunButtonLabel(6, false) !== "Run the whole ladder (6)") problem = `ladderRunButtonLabel(6,false) = ${ladderRunButtonLabel(6, false)}`;
  else if (ladderRunButtonLabel(6, true) !== "Running…") problem = `ladderRunButtonLabel(6,true) = ${ladderRunButtonLabel(6, true)}`;
  else if (ladderRunButtonLabel(0, false) !== "Run the whole ladder (0)") problem = "the zero-count label lost its number";
  if (problem) bad("labels", problem);
  else ok("graduating reads \"Graduate the cohort\"; the run label carries the count and swaps to \"Running…\"");
}

/* ------------------------------------------------------------------------ 8 */

console.log("\n8. the warning switches (D4, D5)");
{
  let problem = null;
  if (showGraduatingBanner({ graduating: true }) !== true) problem = "a graduating preview did not raise the banner";
  else if (showGraduatingBanner({ graduating: false }) !== false) problem = "an advancing preview raised the graduating banner";
  else if (showGraduatingBanner(null) !== false || showGraduatingBanner(undefined) !== false) problem = "no preview raised the banner";
  else if (showGraduatingBanner({ graduating: "true" }) !== false) problem = "a non-boolean graduating value raised the banner";
  else if (showDestinationLine({ graduating: true }) !== false) problem = "a graduating run still showed a destination line";
  else if (showDestinationLine({ graduating: false }) !== true) problem = "an advancing run hid its destination line";
  else if (showClassIdBanner({ counts: { classIdWarnings: 0 } }) !== false) problem = "zero classId warnings raised the banner";
  else if (showClassIdBanner({ counts: { classIdWarnings: 2 } }) !== true) problem = "two classId warnings did not raise the banner";
  else if (showClassIdBanner(null) !== false) problem = "a missing preview raised the classId banner";
  else if (classIdBannerText(2) !== "2 student(s) below are also enrolled in a school class — school promotion may advance this student too.")
    problem = `classIdBannerText(2) = ${JSON.stringify(classIdBannerText(2))}`;
  else if (confirmSummary({ graduating: true, fromTermNumber: 3, termCount: 3 }).toTermNumber !== null)
    problem = "a graduating summary carried a destination term";
  if (problem) bad("warnings", problem);
  else ok("the graduating banner, the destination line and the classId banner each switch on exactly the right value");
}

/* ------------------------------------------------------------------------ 9 */

console.log("\n9. the Notes cell and the step footnote");
{
  const cases = [
    [{ classIdWarning: true, pendingRegistrationCount: 2 }, { classIdWarning: true, pendingText: "2 pending course requests at this term", placeholder: false }],
    [{ classIdWarning: false, pendingRegistrationCount: 1 }, { classIdWarning: false, pendingText: "1 pending course request at this term", placeholder: false }],
    [{ classIdWarning: true, pendingRegistrationCount: 0 }, { classIdWarning: true, pendingText: null, placeholder: false }],
    [{ classIdWarning: false, pendingRegistrationCount: 0 }, { classIdWarning: false, pendingText: null, placeholder: true }],
  ];
  let problem = null;
  for (const [input, want] of cases) {
    const got = rowNote(input);
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      problem = `rowNote(${JSON.stringify(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      break;
    }
  }
  if (!problem) {
    const two = stepNote({ counts: { classIdWarnings: 2, pendingRegistrations: 3 } });
    const none = stepNote({ counts: { classIdWarnings: 0, pendingRegistrations: 0 } });
    if (two.classIdText !== "2 also in a school class · " || two.pendingText !== "3 pending course requests")
      problem = `stepNote(2 warnings) = ${JSON.stringify(two)}`;
    else if (none.classIdText !== null || none.pendingText !== "0 pending course requests")
      problem = `stepNote(0 warnings) = ${JSON.stringify(none)}`;
  }
  if (problem) bad("notes", problem);
  else ok("a row shows a warning, a request count, both or a dash; a step's footnote drops its classId clause at zero");
}

/* ------------------------------------------------------------------------ 10 */

console.log("\n10. the confirmation summary and the empty-cohort headline");
{
  const advance = confirmSummary({ graduating: false, fromTermNumber: 1, termCount: 3 });
  const graduate = confirmSummary({ graduating: true, fromTermNumber: 3, termCount: 3 });
  let problem = null;
  if (advance.verb !== "advance" || advance.toTermNumber !== 2 || advance.termCount !== 3)
    problem = `advance summary = ${JSON.stringify(advance)}`;
  else if (graduate.verb !== "graduate" || graduate.toTermNumber !== null)
    problem = `graduate summary = ${JSON.stringify(graduate)} — a graduating summary must carry no destination`;
  else if (emptyCohortTitle({ fromTermNumber: 2, termCount: 4 }) !== "Nobody is at term 2 of 4")
    problem = `emptyCohortTitle = ${JSON.stringify(emptyCohortTitle({ fromTermNumber: 2, termCount: 4 }))}`;
  if (problem) bad("confirm", problem);
  else ok("the summary says advance→term N or graduate (no destination); the empty headline names the position");
}

/* ------------------------------------------------------------------------ 11 */

console.log("\n11. the server's report becomes the operator's sentence");
{
  const promoted = applyResultMessage({ graduating: false, promoted: 3, graduated: 0, toTermNumber: 2 }, "BSc");
  const graduated = applyResultMessage({ graduating: true, promoted: 0, graduated: 2, toTermNumber: null }, "BSc");
  let problem = null;
  if (promoted !== "Promoted 3 student(s) to Term 2 of BSc.") problem = `advance message = ${JSON.stringify(promoted)}`;
  else if (graduated !== "Graduated 2 student(s) as ALUMNI from BSc.") problem = `graduate message = ${JSON.stringify(graduated)}`;
  else if (ladderRunMessage({ promoted: 4, graduated: 1 }, "BSc") !== "Ran the whole ladder for BSc: 4 advanced, 1 graduated.")
    problem = `ladder message = ${JSON.stringify(ladderRunMessage({ promoted: 4, graduated: 1 }, "BSc"))}`;
  else if (ladderGraduateText({ counts: { graduate: 2 } }) !== "2 will graduate") problem = "the plan summary lost its graduate figure";
  else if (ladderGraduateText({}) !== "0 will graduate") problem = "a plan without counts did not read 0";
  if (problem) bad("messages", problem);
  else ok("the graduating and advancing sentences differ by verb and count; the plan summary reads its graduate figure");
}

/* ------------------------------------------------------------------------ 12 */

console.log("\n12. the failure path re-fetches BOTH stale parts, silently (§20)");
{
  const list = [...LADDER_FAILURE_REFRESH];
  let problem = null;
  if (JSON.stringify(list) !== JSON.stringify(["ladderPlan", "preview"]))
    problem = `LADDER_FAILURE_REFRESH = ${JSON.stringify(list)}, expected ["ladderPlan","preview"]`;
  else if (LADDER_FAILURE_REFRESH_IS_SILENT !== true)
    problem = "the failure refresh is no longer silent — it would wipe the server's report";
  else {
    // And the page must actually drive its refresh from that list, not two copies.
    if (!/LADDER_FAILURE_REFRESH/.test(pageSource) || !/LADDER_FAILURE_REFRESH_IS_SILENT/.test(pageSource))
      problem = "the page does not use the shared refresh list";
  }
  if (problem) bad("refresh", problem);
  else ok("the list names the plan and the preview, the refresh is silent, and the page drives it from the list");
}

/* ------------------------------------------------------------------------ 13 */

console.log("\n13. purity — frozen inputs, deterministic output, nothing mutated (D7)");
{
  const frozenRow = Object.freeze({ classIdWarning: true, pendingRegistrationCount: 1 });
  const frozenStep = Object.freeze({ counts: Object.freeze({ classIdWarnings: 1, pendingRegistrations: 2 }) });
  const frozenPreview = Object.freeze({ graduating: true, fromTermNumber: 3, termCount: 3 });
  let threw = null;
  let a = null;
  let b = null;
  try {
    a = [rowNote(frozenRow), stepNote(frozenStep), confirmSummary(frozenPreview)];
    b = [rowNote(frozenRow), stepNote(frozenStep), confirmSummary(frozenPreview)];
  } catch (e) {
    threw = e?.message || String(e);
  }
  const registrationSurface = /\b(courseRegistration|findMany|update|delete|create)\b/.test(code);
  const sessionSurface = /\b(sessionId|academicSession|currentSession)\b/.test(code);
  if (threw) bad("purity", `a frozen input threw: ${threw}`);
  else if (JSON.stringify(a) !== JSON.stringify(b)) bad("purity", "two identical calls returned different results");
  else if (registrationSurface) bad("purity", "the module names a write/registration call — it must not touch the store");
  else if (sessionSurface) bad("purity", "the module names a session dimension — the ladder is session-independent (D9)");
  else ok("frozen inputs are accepted twice with deep-equal output, and no store/session surface exists");
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ COLLEGE PROMOTION PAGE FAILED — ${failures} of ${checks} check(s) failed.`);
  process.exit(1);
}
console.log(
  `✅ COLLEGE PROMOTION PAGE OK — ${checks} check(s): the page's non-visual logic (warnings, D6 phrasing, ` +
    `disabled predicates, confirmation summary, failure refresh) is correct and the page still uses it.`
);
console.log("   ⚠️  This does NOT render the page. A real browser test is still NOT DONE (§21).");
