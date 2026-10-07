#!/usr/bin/env node
/**
 * Phase 3c — the college TERM model, proved OFFLINE.
 *
 * `src/lib/college-terms.ts` is the ONE place that turns a program's
 * `(durationYears, termSystem)` into a term count and a term's label. The API
 * routes validate `programCourse.termNumber` against it and the (later) catalogue
 * page renders it, so a mistake here is a mistake in two places at once. This
 * script pins the arithmetic and the boundary behaviour:
 *
 *   1. THE VALUES. `TERM_SYSTEMS` is exactly YEARLY/SEMESTER and the default is
 *      YEARLY.
 *   2. MISSING-SAFE READ. `normalizeTermSystem` returns YEARLY for undefined,
 *      null, "", a number, an object and a lowercase-ish string — a missing or
 *      unrecognised stored field is the default, never null.
 *   3. TERMS PER YEAR. YEARLY 1, SEMESTER 2, default YEARLY.
 *   4. THE COUNT. `durationYears × termsPerYear`: 3 YEARLY = 3, 3 SEMESTER = 6,
 *      and a non-positive / non-integer duration is 0 (a total function, not a
 *      throw — the routes validate the duration separately).
 *   5. THE LABELS. `termLabel` produces "Year k" / "Semester k" and
 *      `termLabels(durationYears, system)` produces the 1-based run.
 *   6. THE BOUNDS. `isValidTermNumber` accepts only a whole number in
 *      [1, termCount] — 0, negatives, fractions, non-numbers and a term past the
 *      end are refused.
 *   7. DEPENDENCY-FREE. The module imports nothing (`no imports/prisma/node:`),
 *      which is what lets the verifier, a client component and Edge code share
 *      it — the same property `college-routes.ts` claims.
 *
 *   node scripts/verify-college-terms.mjs
 *
 * Needs no database, no server and no network, so it carries no
 * `requireEmulator()` guard and runs on plain `node`.
 */

import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension,
 * so this local, synchronous hook retries a failed relative specifier with `.ts`
 * appended — the same approach as `verify-college-gate.mjs`, scoped to this
 * process.
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

const MODULE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/college-terms.ts");
const {
  TERM_SYSTEMS,
  DEFAULT_TERM_SYSTEM,
  isTermSystem,
  normalizeTermSystem,
  termsPerYear,
  termCount,
  termLabel,
  termLabels,
  isValidTermNumber,
} = await import("../src/lib/college-terms.ts");

let failures = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (scope, msg) => {
  failures += 1;
  console.log(`  ❌ [${scope}] ${msg}`);
};

/** Assert a value equals the expected one, recording a failure otherwise. */
function eq(scope, label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) return true;
  bad(scope, `${label}: expected ${e}, got ${a}`);
  return false;
}

console.log("=== Phase 3c college term model (offline) ===");

/* ------------------------------------------------------------------- check 1 */

console.log("\n1. the values — YEARLY/SEMESTER, default YEARLY");
{
  const exact = TERM_SYSTEMS.length === 2 && TERM_SYSTEMS[0] === "YEARLY" && TERM_SYSTEMS[1] === "SEMESTER";
  if (exact && DEFAULT_TERM_SYSTEM === "YEARLY") {
    ok(`TERM_SYSTEMS = ${JSON.stringify([...TERM_SYSTEMS])}, DEFAULT_TERM_SYSTEM = ${DEFAULT_TERM_SYSTEM}`);
  } else {
    bad("values", `TERM_SYSTEMS = ${JSON.stringify(TERM_SYSTEMS)}, default ${DEFAULT_TERM_SYSTEM}`);
  }

  // isTermSystem is STRICT: only exactly the two stored values pass.
  const strictCases = [
    ["YEARLY", true],
    ["SEMESTER", true],
    ["yearly", false],
    ["semester", false],
    [" SEMESTER", false],
    ["", false],
    [undefined, false],
    [null, false],
    [2, false],
  ];
  const strictBad = strictCases.filter(([input, expected]) => isTermSystem(input) !== expected);
  if (strictBad.length) {
    for (const [input, expected] of strictBad) {
      bad("values", `isTermSystem(${JSON.stringify(input)}) should be ${expected}`);
    }
  } else {
    ok(`${strictCases.length} isTermSystem case(s): only exactly "YEARLY"/"SEMESTER" pass`);
  }
}

/* ------------------------------------------------------------------- check 2 */

console.log("\n2. missing-safe read — normalizeTermSystem never returns null");
{
  const cases = [
    ["YEARLY", "YEARLY"],
    ["SEMESTER", "SEMESTER"],
    [undefined, "YEARLY"],
    [null, "YEARLY"],
    ["", "YEARLY"],
    ["yearly", "YEARLY"],
    ["semester", "YEARLY"],
    ["SEMESTERS", "YEARLY"],
    [3, "YEARLY"],
    [{}, "YEARLY"],
  ];
  const wrong = cases.filter(([input, expected]) => normalizeTermSystem(input) !== expected);
  if (wrong.length) {
    for (const [input, expected] of wrong) {
      bad("normalize", `normalizeTermSystem(${JSON.stringify(input)}) should be ${expected}, got ${normalizeTermSystem(input)}`);
    }
  } else {
    ok(`${cases.length} case(s): a missing or unrecognised value reads as YEARLY (${"missing-safe"})`);
  }
}

/* ------------------------------------------------------------------- check 3 */

console.log("\n3. terms per year — YEARLY 1, SEMESTER 2, default YEARLY");
{
  const good =
    termsPerYear("YEARLY") === 1 &&
    termsPerYear("SEMESTER") === 2 &&
    termsPerYear(undefined) === 2 - 1 && // default YEARLY → 1
    termsPerYear("garbage") === 1;
  if (good) ok("termsPerYear: YEARLY → 1, SEMESTER → 2, missing/unrecognised → 1");
  else {
    bad("perYear", `termsPerYear: YEARLY=${termsPerYear("YEARLY")} SEMESTER=${termsPerYear("SEMESTER")} — expected 1 / 2`);
  }
}

/* ------------------------------------------------------------------- check 4 */

console.log("\n4. the count — durationYears × termsPerYear");
{
  const baseline = failures;
  eq("count", "termCount(3, YEARLY)", termCount(3, "YEARLY"), 3);
  eq("count", "termCount(3, SEMESTER)", termCount(3, "SEMESTER"), 6);
  eq("count", "termCount(1, SEMESTER)", termCount(1, "SEMESTER"), 2);
  eq("count", "termCount(6, SEMESTER)", termCount(6, "SEMESTER"), 12);
  eq("count", "termCount(2, undefined)", termCount(2, undefined), 2);
  // A bad duration is a total 0, never a throw (the routes validate duration).
  eq("count", "termCount(0, YEARLY)", termCount(0, "YEARLY"), 0);
  eq("count", "termCount(-3, SEMESTER)", termCount(-3, "SEMESTER"), 0);
  eq("count", "termCount(2.5, SEMESTER)", termCount(2.5, "SEMESTER"), 0);
  if (failures === baseline) ok("termCount: 3 YEARLY → 3, 3 SEMESTER → 6, invalid duration → 0");
}

/* ------------------------------------------------------------------- check 5 */

console.log("\n5. the labels — \"Year k\" / \"Semester k\"");
{
  const baseline = failures;
  eq("label", "termLabel(1, YEARLY)", termLabel(1, "YEARLY"), "Year 1");
  eq("label", "termLabel(2, YEARLY)", termLabel(2, "YEARLY"), "Year 2");
  eq("label", "termLabel(2, SEMESTER)", termLabel(2, "SEMESTER"), "Semester 2");
  eq("label", "termLabel(5, YEARLY)", termLabel(5, "YEARLY"), "Year 5");
  eq("label", "termLabel(1, undefined)", termLabel(1, undefined), "Year 1");

  eq("labels", "termLabels(1, YEARLY)", termLabels(1, "YEARLY"), ["Year 1"]);
  eq("labels", "termLabels(3, YEARLY)", termLabels(3, "YEARLY"), ["Year 1", "Year 2", "Year 3"]);
  eq("labels", "termLabels(2, SEMESTER)", termLabels(2, "SEMESTER"), [
    "Semester 1",
    "Semester 2",
    "Semester 3",
    "Semester 4",
  ]);
  eq("labels", "termLabels(0, SEMESTER)", termLabels(0, "SEMESTER"), []);
  if (failures === baseline) ok("labels: 1-based run, YEARLY/SEMESTER unit, empty when there are no terms");
}

/* ------------------------------------------------------------------- check 6 */

console.log("\n6. the bounds — isValidTermNumber is a whole number in [1, termCount]");
{
  const cases = [
    // [termNumber, durationYears, system, expected]
    [1, 3, "YEARLY", true],
    [3, 3, "YEARLY", true],
    [4, 3, "YEARLY", false],
    [0, 3, "YEARLY", false],
    [-1, 3, "YEARLY", false],
    [1.5, 3, "YEARLY", false],
    ["2", 3, "YEARLY", false],
    [undefined, 3, "YEARLY", false],
    [6, 3, "SEMESTER", true],
    [7, 3, "SEMESTER", false],
    [2, 1, "SEMESTER", true],
    [1, 0, "YEARLY", false],
  ];
  const wrong = cases.filter(([n, d, s, expected]) => isValidTermNumber(n, d, s) !== expected);
  if (wrong.length) {
    for (const [n, d, s, expected] of wrong) {
      bad("bounds", `isValidTermNumber(${JSON.stringify(n)}, ${d}, ${s}) should be ${expected}`);
    }
  } else {
    ok(`${cases.length} case(s): accepts 1..termCount, refuses 0 / negatives / fractions / strings / past-the-end`);
  }
}

/* ------------------------------------------------------------------- check 7 */

console.log("\n7. dependency-free — the module imports nothing");
{
  // Strip comments FIRST: the header documents this property in prose ("… can
  // all import it"), and prose is not an import statement. Same rule as the
  // route guard's comment masking.
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const code = stripComments(readFileSync(MODULE_PATH, "utf8"));
  const moduleImport = /^\s*import\s/m.test(code);
  const relativeImport = /^\s*import\b[^\n]*\bfrom\s+["']/m.test(code);
  const requireCall = /\brequire\s*\(/.test(code);
  if (!moduleImport && !relativeImport && !requireCall) {
    ok("college-terms.ts carries no import/require — safe for node, a client component and Edge");
  } else {
    bad("dependency-free", "college-terms.ts contains an import/require — it must stay dependency-free");
  }
}

console.log(
  failures === 0
    ? "\n✅ COLLEGE TERMS OK — YEARLY/SEMESTER, default YEARLY, missing-safe, count = years × per-year, labels and bounds pinned"
    : `\n❌ ${failures} college-terms failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
