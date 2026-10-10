#!/usr/bin/env node
/**
 * Phase 6a — the pure college grading logic, proved OFFLINE.
 *
 * `src/lib/college-results.ts` is the ONLY place that decides which attempt
 * grades a course and how the grades become a term GPA and a CGPA; the additive
 * `src/lib/grading.ts` changes (`showGpa`, the retake block, the new presets) are
 * the scheme half. Both are dependency-free — no prisma, no HTTP, no React, no
 * `node:` — which is what lets this script pin them without a database, a server
 * or an emulator: it carries **no `requireEmulator()` guard** and runs on plain
 * `node`, the same design as `verify-college-promotion-logic.mjs`,
 * `verify-college-terms.mjs` and `verify-college-gate.mjs`.
 *
 * The decisions it pins (docs/COLLEGE-DECISIONS.md §23):
 *
 *   1. DEPENDENCY-FREE. Neither pure module has an `import` or a `require(`.
 *   2. THE RETALE LIST IS ONE LIST. `college-results.ts` re-declares the four
 *      retake policies (to stay import-free); their values must equal
 *      `grading.ts`'s `RETAKE_POLICIES` exactly.
 *   3. `showGpa` IS BACKWARD-COMPATIBLE. Absent means shown; `validateScheme`
 *      emits the key only for an explicit `false`, so every existing scheme
 *      validates to a byte-identical object.
 *   4. THE PRESETS. The three existing ones are unchanged; the three new shapes
 *      validate; a no-GPA preset stores bands with no point.
 *   5. NO-GPA VALIDATION (D-6-5). A band may omit `gpa` only under `showGpa:
 *      false`; a no-GPA band that carries an out-of-range point is refused; every
 *      other existing rule still applies.
 *   6. THE RETAKE BLOCK (D-6-7…D-6-10). `validateRetakeConfig` accepts an integer
 *      limit or null (unlimited) and refuses junk; the lenient readers fall back
 *      to "no retakes".
 *   7. THE FOUR POLICIES (D-6-8). `resolveCollegeAttempts` picks REPLACE/BEST/
 *      BOTH/AVERAGE exactly, uses the one `passPercent`, sorts, and drops junk.
 *   8. THE LIMIT IS A PREDICATE (D-6-9). `retakeLimitReached`/`retakesUsed`, not a
 *      deleted attempt, and `overLimit` reports a stored set past the limit.
 *   9. CREDIT-WEIGHTED GPA (D-6-11). Credits weigh the course, a course with no
 *      credits weighs 1, and a creditless set is the plain mean.
 *  10. NO GPA IS `null`, NEVER `0.00` (D-6-16), and the value is capped at the
 *      scale and rounded to two decimals; `termGpa` filters by term.
 *  11. `resolveSchemeFor` (D-6-18). The ONE resolution point exists in
 *      `grading-store.ts`, delegates to the untouched `loadScheme`, and ignores
 *      `programId`; `schemeKey`/`loadScheme` signatures are unchanged.
 *  12. PURITY. Frozen inputs are accepted twice with deep-equal output, nothing is
 *      mutated, and the module names no store/HTTP surface.
 *
 *   node scripts/verify-college-grading-logic.mjs
 *
 * It only READS three files from the repository.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension,
 * so this local, synchronous hook retries a failed relative specifier with `.ts`
 * appended — the same approach as verify-college-promotion-logic.mjs.
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

const RESULTS_URL = new URL("../src/lib/college-results.ts", import.meta.url);
const GRADING_URL = new URL("../src/lib/grading.ts", import.meta.url);
const STORE_URL = new URL("../src/lib/grading-store.ts", import.meta.url);
const resultsSource = readFileSync(RESULTS_URL, "utf8");
const gradingSource = readFileSync(GRADING_URL, "utf8");
const storeSource = readFileSync(STORE_URL, "utf8");

const R = await import(RESULTS_URL.href);
const G = await import(GRADING_URL.href);

/**
 * Blank out comments and string literals, PRESERVING LENGTH, so a token search
 * runs against code only. Both modules document their decisions in prose, so a
 * raw scan would match the documentation instead of the surface.
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

const resultsCode = maskCommentsAndStrings(resultsSource);
const gradingCode = maskCommentsAndStrings(gradingSource);

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
const sameDeep = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (a, b) => a === b;

console.log("=== Phase 6a college grading logic (offline) ===");
console.log(
  `modules: src/lib/college-results.ts (${resultsSource.split("\n").length} lines), src/lib/grading.ts (${gradingSource.split("\n").length} lines)`
);

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. dependency-free — no import, no require() in either pure module");
for (const [name, code] of [
  ["college-results.ts", resultsCode],
  ["grading.ts", gradingCode],
]) {
  const importAt = code.search(/\bimport\b/);
  const requireAt = code.search(/\brequire\s*\(/);
  if (importAt >= 0) bad("dependencies", `${name}: \`import\` appears at character ${importAt} — the module must stay dependency-free`);
  else if (requireAt >= 0) bad("dependencies", `${name}: \`require(\` appears at character ${requireAt} — the module must stay dependency-free`);
  else ok(`${name}: no \`import\` and no \`require(\` — no prisma, no node:, no React`);
}

/* ------------------------------------------------------------------------ 2 */

console.log("\n2. the retake policy list is ONE list (grading.ts ↔ college-results.ts)");
{
  const want = ["REPLACE", "BEST", "BOTH", "AVERAGE"];
  const a = [...G.RETAKE_POLICIES];
  const b = [...R.COLLEGE_RETAKE_POLICIES];
  if (!sameDeep(a, want)) bad("policies", `grading.ts RETAKE_POLICIES = ${JSON.stringify(a)}, expected ${JSON.stringify(want)}`);
  else if (!sameDeep(b, a)) bad("policies", `college-results.ts list ${JSON.stringify(b)} disagrees with grading.ts ${JSON.stringify(a)}`);
  else if (!G.RETAKE_POLICIES.every((p) => R.isCollegeRetakePolicy(p)) || R.isCollegeRetakePolicy("retain"))
    bad("policies", "isCollegeRetakePolicy disagrees with the list");
  else if (!a.every((p) => G.isRetakePolicy(p)) || G.isRetakePolicy("retain")) bad("policies", "isRetakePolicy disagrees with the list");
  else ok(`both lists are ${JSON.stringify(want)}; each predicate accepts exactly those and rejects "retain"`);
}

/* ------------------------------------------------------------------------ 3 */

console.log("\n3. showGpa — absent means shown, and existing schemes are byte-identical (D-6-2)");
{
  const frozenDefault = JSON.stringify(G.DEFAULT_SCHEME);
  const validated = G.validateScheme(G.DEFAULT_SCHEME);
  const hasKey = (o) => Object.prototype.hasOwnProperty.call(o, "showGpa");

  if (!validated.ok) bad("showGpa", `the shipped DEFAULT_SCHEME no longer validates: ${validated.error}`);
  else if (JSON.stringify(validated.scheme) !== frozenDefault)
    bad("showGpa", `validateScheme(DEFAULT_SCHEME) changed the object:\n    ${JSON.stringify(validated.scheme)}`);
  else if (hasKey(validated.scheme)) bad("showGpa", "a scheme with no showGpa gained the key");
  else if (!eq(G.showsGpa(undefined), true) || !eq(G.showsGpa(null), true) || !eq(G.showsGpa({}), true) || !eq(G.showsGpa({ showGpa: true }), true))
    bad("showGpa", "showsGpa did not read absent/true as shown");
  else if (!eq(G.showsGpa({ showGpa: false }), false) || !eq(R.showsGpaIn({ showGpa: false }), false))
    bad("showGpa", "showsGpa/showsGpaIn did not read an explicit false as hidden");
  else if (!eq(R.showsGpaIn(undefined), true) || !eq(R.showsGpaIn({}), true))
    bad("showGpa", "showsGpaIn did not read absent as shown");
  else if (hasKey(G.validateScheme({ ...G.DEFAULT_SCHEME, showGpa: true }).scheme))
    bad("showGpa", "an explicit showGpa:true was stored — only false may be stored");
  else if (!eq(hasKey(G.validateScheme(G.DEFAULT_SCHEME).scheme), false))
    bad("showGpa", "an absent showGpa added the key");
  else {
    const noGpa = G.validateScheme({
      name: "Letters only",
      gpaScale: 5,
      passPercent: 40,
      failCapsGpa: false,
      showGpa: false,
      bands: [
        { grade: "A", minPercent: 80 },
        { grade: "F", minPercent: 0 },
      ],
    });
    if (!noGpa.ok) bad("showGpa", `a no-GPA scheme was refused: ${noGpa.error}`);
    else if (noGpa.scheme.showGpa !== false) bad("showGpa", "showGpa:false was not stored");
    else if (noGpa.scheme.bands.some((x) => "gpa" in x)) bad("showGpa", "a no-GPA band carried a gpa key");
    else ok("DEFAULT_SCHEME validates byte-identically (no showGpa key); absent/true read as shown, false as hidden and stored, and a no-GPA band carries no point");
  }
}

/* ------------------------------------------------------------------------ 4 */

console.log("\n4. presets — the three existing ones unchanged, the three new shapes valid (D-6-3)");
{
  const byKey = Object.fromEntries(G.GRADING_PRESETS.map((p) => [p.key, p]));

  const BD5 = {
    key: "bd-5",
    label: "Bangladesh National (5.00)",
    hint: "A+ 80%, A 70%, A- 60%, B 50%, C 40%, D 33%, F below — pass at 33%.",
    scheme: {
      name: "Bangladesh National",
      gpaScale: 5,
      passPercent: 33,
      failCapsGpa: false,
      bands: [
        { grade: "A+", minPercent: 80, gpa: 5, remark: "Outstanding" },
        { grade: "A", minPercent: 70, gpa: 4, remark: "Excellent" },
        { grade: "A-", minPercent: 60, gpa: 3.5, remark: "Very good" },
        { grade: "B", minPercent: 50, gpa: 3, remark: "Good" },
        { grade: "C", minPercent: 40, gpa: 2, remark: "Satisfactory" },
        { grade: "D", minPercent: 33, gpa: 1, remark: "Needs improvement" },
        { grade: "F", minPercent: 0, gpa: 0, remark: "Failed" },
      ],
    },
  };
  const GPA4 = {
    key: "gpa-4",
    label: "GPA 4.00 scale",
    hint: "A 90%, B 80%, C 70%, D 60%, F below — pass at 60%.",
    scheme: {
      name: "GPA 4.00",
      gpaScale: 4,
      passPercent: 60,
      failCapsGpa: false,
      bands: [
        { grade: "A", minPercent: 90, gpa: 4, remark: "Excellent" },
        { grade: "B", minPercent: 80, gpa: 3, remark: "Good" },
        { grade: "C", minPercent: 70, gpa: 2, remark: "Satisfactory" },
        { grade: "D", minPercent: 60, gpa: 1, remark: "Pass" },
        { grade: "F", minPercent: 0, gpa: 0, remark: "Failed" },
      ],
    },
  };
  const LETTERS5 = {
    key: "letters-5",
    label: "Letters + 5.00 GPA (no minus)",
    hint: "A+ 80%, A 65%, B 50%, C 40%, D 33% — pass at 33%.",
    scheme: {
      name: "Letters only",
      gpaScale: 5,
      passPercent: 33,
      failCapsGpa: true,
      bands: [
        { grade: "A+", minPercent: 80, gpa: 5, remark: "Outstanding" },
        { grade: "A", minPercent: 65, gpa: 4, remark: "Excellent" },
        { grade: "B", minPercent: 50, gpa: 3, remark: "Good" },
        { grade: "C", minPercent: 40, gpa: 2, remark: "Satisfactory" },
        { grade: "D", minPercent: 33, gpa: 1, remark: "Pass" },
        { grade: "F", minPercent: 0, gpa: 0, remark: "Failed" },
      ],
    },
  };

  let problem = null;
  for (const expected of [BD5, GPA4, LETTERS5]) {
    const got = byKey[expected.key];
    if (!got) problem = `preset "${expected.key}" is missing`;
    else if (!sameDeep(got, expected)) problem = `preset "${expected.key}" changed:\n    ${JSON.stringify(got)}`;
    if (problem) break;
  }
  if (problem) bad("presets", problem);
  else if (G.GRADING_PRESETS.length < 6) bad("presets", `only ${G.GRADING_PRESETS.length} presets — the three new shapes are missing`);
  else {
    const bad1 = G.GRADING_PRESETS.find((p) => !G.validateScheme(p.scheme).ok);
    const uni = byKey["bd-university-4"];
    const eng = byKey["eng-medium-letters"];
    const pct = byKey["percent-only"];
    if (bad1) bad("presets", `preset "${bad1.key}" does not validate: ${G.validateScheme(bad1.scheme).error}`);
    else if (!uni || uni.scheme.gpaScale !== 4 || uni.scheme.passPercent !== 40)
      bad("presets", "bd-university-4 is not a 4.00 scale passing at 40%");
    else if (!eng || eng.scheme.showGpa !== false || eng.scheme.bands.some((b) => "gpa" in b))
      bad("presets", "eng-medium-letters is not a no-GPA letters scheme");
    else if (!pct || pct.scheme.showGpa !== false || pct.scheme.bands.some((b) => "gpa" in b))
      bad("presets", "percent-only is not a no-GPA percentage scheme");
    else ok(
      `bd-5/gpa-4/letters-5 byte-identical; ${G.GRADING_PRESETS.length} presets all validate; bd-university-4 = 4.00 @40%, eng-medium-letters and percent-only are no-GPA`
    );
  }
}

/* ------------------------------------------------------------------------ 5 */

console.log("\n5. no-GPA validation relaxes exactly one rule (D-6-5)");
{
  const base = {
    name: "No GPA",
    gpaScale: 5,
    passPercent: 40,
    failCapsGpa: false,
    showGpa: false,
    bands: [
      { grade: "P", minPercent: 40 },
      { grade: "F", minPercent: 0 },
    ],
  };
  const withPoint = { ...base, bands: [{ grade: "P", minPercent: 40, gpa: 9 }, { grade: "F", minPercent: 0 }] };
  const dupMin = { ...base, bands: [{ grade: "P", minPercent: 0 }, { grade: "F", minPercent: 0 }] };
  const oneBand = { ...base, bands: [{ grade: "P", minPercent: 0 }] };
  const noZero = { ...base, bands: [{ grade: "P", minPercent: 40 }, { grade: "F", minPercent: 10 }] };
  const longLabel = { ...base, bands: [{ grade: "TOOLONG", minPercent: 40 }, { grade: "F", minPercent: 0 }] };
  const showGpaMissingPoint = { ...base, showGpa: true };

  if (!G.validateScheme(base).ok) bad("no-gpa", `an omitted band point was refused: ${G.validateScheme(base).error}`);
  else if (G.validateScheme(withPoint).ok) bad("no-gpa", "a no-GPA band with a point above the scale was accepted");
  else if (G.validateScheme(dupMin).ok) bad("no-gpa", "two bands starting at 0% were accepted");
  else if (G.validateScheme(oneBand).ok) bad("no-gpa", "a single-band no-GPA scheme was accepted");
  else if (G.validateScheme(noZero).ok) bad("no-gpa", "a no-GPA scheme with no 0% band was accepted");
  else if (G.validateScheme(longLabel).ok) bad("no-gpa", "a 7-character label was accepted");
  else if (G.validateScheme(showGpaMissingPoint).ok) bad("no-gpa", "a band with no point was accepted while showGpa is true");
  else ok("a no-GPA band may omit its point; a bad point and every existing refusal (dup 0%, one band, no 0% band, long label) still apply, and omitted points are refused while showGpa is true");
}

/* ------------------------------------------------------------------------ 6 */

console.log("\n6. the retake block validates, and junk reads as no retakes (D-6-9)");
{
  const cases = [
    [{ policy: "BEST", maxRetakes: 2 }, true],
    [{ policy: "AVERAGE", maxRetakes: null }, true],
    [{ policy: "REPLACE", maxRetakes: "" }, true],
    [{ policy: "NOPE", maxRetakes: 1 }, false],
    [{ policy: "BEST", maxRetakes: -1 }, false],
    [{ policy: "BEST", maxRetakes: 1.5 }, false],
    [{ policy: "BEST", maxRetakes: "x" }, false],
    [null, false],
  ];
  let problem = null;
  for (const [input, want] of cases) {
    const got = G.validateRetakeConfig(input).ok;
    if (got !== want) {
      problem = `validateRetakeConfig(${JSON.stringify(input)}) = ${got}, expected ${want}`;
      break;
    }
  }
  if (problem) bad("retake", problem);
  else if (!sameDeep(G.normalizeRetakeConfig({ policy: "NOPE" }), G.DEFAULT_RETAKE))
    bad("retake", "normalizeRetakeConfig did not fall back to DEFAULT_RETAKE");
  else if (!sameDeep(R.normalizeCollegeRetake({ policy: "NOPE", maxRetakes: 3 }), R.DEFAULT_COLLEGE_RETAKE))
    bad("retake", "normalizeCollegeRetake did not fall back to its own default");
  else if (G.normalizeRetakeConfig({ policy: "BEST", maxRetakes: null }).maxRetakes !== null)
    bad("retake", "an unlimited limit did not read as null");
  else ok(`${cases.length} inputs: an integer limit or null is accepted, junk is refused, and both lenient readers fall back to "no retakes"`);
}

/* ------------------------------------------------------------------------ 7 */

console.log("\n7. the four policies resolve exactly (D-6-8)");
{
  const mk = (policy, rows, passPercent = 40, extra = {}) => R.resolveCollegeAttempts({ attempts: rows, policy, passPercent, ...extra });
  const pct = (r) => r.effectivePercent;
  const eff = (r) => r.effectiveAttempt;

  const replace = mk("REPLACE", [{ attempt: 1, obtained: 50, fullMarks: 100 }, { attempt: 2, obtained: 80, fullMarks: 100 }]);
  const best = mk("BEST", [{ attempt: 1, obtained: 90, fullMarks: 100 }, { attempt: 2, obtained: 60, fullMarks: 100 }]);
  const bestTie = mk("BEST", [{ attempt: 1, obtained: 70, fullMarks: 100 }, { attempt: 2, obtained: 70, fullMarks: 100 }]);
  const both = mk("BOTH", [{ attempt: 1, obtained: 50, fullMarks: 100 }, { attempt: 2, obtained: 80, fullMarks: 100 }]);
  const avg = mk("AVERAGE", [{ attempt: 1, obtained: 50, fullMarks: 100 }, { attempt: 2, obtained: 90, fullMarks: 100 }]);

  if (eff(replace) !== 2 || pct(replace) !== 80 || !sameDeep(replace.attempts.map((r) => r.superseded), [true, false]))
    bad("policies", `REPLACE chose ${eff(replace)} / ${pct(replace)}%`);
  else if (eff(best) !== 1 || pct(best) !== 90) bad("policies", `BEST chose ${eff(best)} / ${pct(best)}%`);
  else if (eff(bestTie) !== 2) bad("policies", `BEST on a tie chose ${eff(bestTie)} instead of the later attempt`);
  else if (eff(both) !== 2 || both.count !== 2 || !sameDeep(both.attempts.map((r) => r.effective), [false, true]))
    bad("policies", `BOTH did not report both attempts with the latest effective`);
  else if (eff(avg) !== null || pct(avg) !== 70 || avg.effectivePassed !== true)
    bad("policies", `AVERAGE gave attempt ${eff(avg)} / ${pct(avg)}%`);
  else ok("REPLACE latest, BEST highest (tie → later), BOTH latest-effective over all attempts, AVERAGE the mean with no single effective attempt");
}

/* ------------------------------------------------------------------------ 8 */

console.log("\n8. the ONE pass mark, the limit, and junk (D-6-9/D-6-10)");
{
  const mk = (policy, rows, passPercent, extra = {}) => R.resolveCollegeAttempts({ attempts: rows, policy, passPercent, ...extra });
  const fail = mk("REPLACE", [{ attempt: 1, obtained: 30, fullMarks: 100 }], 40);
  const pass = mk("REPLACE", [{ attempt: 1, obtained: 40, fullMarks: 100 }], 40);
  const outOfOrder = mk("BEST", [{ attempt: 3, obtained: 90, fullMarks: 100 }, { attempt: 1, obtained: 10, fullMarks: 100 }, { attempt: 2, obtained: 50, fullMarks: 100 }], 40);
  const junk = mk(
    "BEST",
    [
      { attempt: 1, obtained: 50, fullMarks: 100 },
      { attempt: 1, obtained: 99, fullMarks: 100 }, // duplicate attempt number
      { attempt: 1.5, obtained: 99, fullMarks: 100 }, // not a whole attempt
      { attempt: 2, obtained: 50, fullMarks: 0 }, // full marks 0
      { attempt: 3, obtained: NaN, fullMarks: 100 }, // non-finite
      { attempt: 4, obtained: 60, fullMarks: 100 },
    ],
    40
  );
  const empty = mk("BEST", [], 40);
  const limited = mk(
    "BEST",
    [
      { attempt: 1, obtained: 50, fullMarks: 100 },
      { attempt: 2, obtained: 60, fullMarks: 100 },
      { attempt: 3, obtained: 70, fullMarks: 100 },
    ],
    40,
    { retake: { policy: "BEST", maxRetakes: 1 } }
  );

  if (fail.attempts[0].passed !== false || pass.attempts[0].passed !== true)
    bad("pass", "the scheme's single pass mark was not applied");
  else if (!sameDeep(outOfOrder.attempts.map((r) => r.attempt), [1, 2, 3]) || outOfOrder.effectiveAttempt !== 3)
    bad("pass", "attempts were not sorted by attempt number");
  else if (junk.count !== 2 || junk.effectiveAttempt !== 4)
    bad("pass", `junk handling kept ${junk.count} attempts, effective ${junk.effectiveAttempt} (expected 2 valid, effective 4)`);
  else if (empty.count !== 0 || empty.effectivePercent !== null || empty.effectivePassed !== null || empty.retakesUsed !== 0)
    bad("pass", "an empty set did not resolve to null");
  else if (!sameDeep([R.retakesUsed(1), R.retakesUsed(2), R.retakesUsed(0), R.retakesUsed(undefined)], [0, 1, 0, 0]))
    bad("pass", "retakesUsed disagreed");
  else if (
    R.retakeLimitReached(1, { maxRetakes: 0 }) !== true ||
    R.retakeLimitReached(1, { maxRetakes: 1 }) !== false ||
    R.retakeLimitReached(2, { maxRetakes: 1 }) !== true ||
    R.retakeLimitReached(9, { maxRetakes: null }) !== false
  )
    bad("pass", "retakeLimitReached disagreed");
  else if (limited.overLimit !== true || limited.retakesUsed !== 2 || limited.maxRetakes !== 1)
    bad("pass", "overLimit was not reported for a stored set past the limit");
  else ok("pass/fail follows the one passPercent; attempts sort; junk and duplicates drop; the limit is a predicate (null = unlimited) and overLimit is reported, never a deletion");
}

/* ------------------------------------------------------------------------ 9 */

console.log("\n9. credit-weighted GPA — weight 1 with no credits, plain mean when none carry (D-6-11)");
{
  const scheme = { gpaScale: 5 };
  const weighted = R.creditWeightedGpa(scheme, [
    { credits: 3, points: 4 },
    { credits: 1, points: 0 },
  ]);
  const fallback = R.creditWeightedGpa(scheme, [
    { credits: 3, points: 4 },
    { points: 2 },
  ]);
  const noCredits = R.creditWeightedGpa(scheme, [{ points: 4 }, { points: 2 }]);
  const zeroCredits = R.creditWeightedGpa(scheme, [
    { credits: 0, points: 4 },
    { credits: 0, points: 2 },
  ]);

  if (weighted !== 3) bad("gpa", `a 3-credit 4.00 + 1-credit 0.00 set gave ${weighted}, expected 3 (not the plain mean 2)`);
  else if (fallback !== 3.5) bad("gpa", `a creditless course did not weigh 1: got ${fallback}, expected 3.5`);
  else if (noCredits !== 3) bad("gpa", `a creditless set was not the plain mean: got ${noCredits}`);
  else if (zeroCredits !== 3) bad("gpa", `0-credit rows were not treated as no credits: got ${zeroCredits}`);
  else ok("3 credits weigh 3× (weighted 3, not the plain mean 2); a course with null/0 credits weighs 1; a creditless set is the plain mean");
}

/* ----------------------------------------------------------------------- 10 */

console.log("\n10. no GPA is null, never 0.00; capped, rounded, per term (D-6-16)");
{
  const rows = [
    { termNumber: 1, credits: 2, points: 4 },
    { termNumber: 1, credits: 2, points: 2 },
    { termNumber: 2, credits: 4, points: 3 },
  ];
  const scale5 = { gpaScale: 5 };
  const scale4 = { gpaScale: 4 };
  const noGpa = { showGpa: false, gpaScale: 5 };

  const all = R.creditWeightedGpa(scale5, rows);
  const t1 = R.termGpa(scale5, rows, 1);
  const t2 = R.termGpa(scale5, rows, 2);
  const capped = R.creditWeightedGpa(scale4, [{ credits: 1, points: 4.9 }]);
  const rounded = R.creditWeightedGpa(scale5, [{ credits: 1, points: 3.333 }]);
  const missing = R.creditWeightedGpa(scale5, [{ credits: 1 }, { points: null }]);
  const none = R.creditWeightedGpa(noGpa, rows);

  if (all !== 3) bad("gpa", `CGPA = ${all}, expected 3`);
  else if (t1 !== 3) bad("gpa", `term 1 GPA = ${t1}, expected 3`);
  else if (t2 !== 3) bad("gpa", `term 2 GPA = ${t2}, expected 3`);
  else if (R.termGpa(scale5, rows, 0) !== null || R.termGpa(scale5, rows, "1") !== null)
    bad("gpa", "an invalid term number did not read null");
  else if (capped !== 4) bad("gpa", `an over-scale GPA was not capped: ${capped}`);
  else if (rounded !== 3.33) bad("gpa", `rounding gave ${rounded}, expected 3.33`);
  else if (missing !== null) bad("gpa", `a set with no points gave ${missing}, expected null`);
  else if (none !== null) bad("gpa", `a no-GPA scheme returned ${none}, expected null (never 0.00)`);
  else if (R.creditWeightedGpa(scale5, []) !== null || R.creditWeightedGpa(scale5, null) !== null)
    bad("gpa", "an empty set did not read null");
  else if (R.cumulativeGpa(scale5, rows) !== all) bad("gpa", "cumulativeGpa disagreed with creditWeightedGpa");
  else if (
    R.gpaWeightingBasis(scale5, rows) !== "credits" ||
    R.gpaWeightingBasis(scale5, [{ points: 4 }]) !== "courses" ||
    R.gpaWeightingBasis(noGpa, rows) !== "none" ||
    R.gpaWeightingBasis(scale5, []) !== "none"
  )
    bad("gpa", "gpaWeightingBasis disagreed");
  else ok("CGPA and term GPAs weight by credits, cap at the scale, round to 2dp, filter by term, and a no-GPA or empty set is null — never 0.00");
}

/* ----------------------------------------------------------------------- 11 */

console.log("\n11. resolveSchemeFor is the ONE resolution point and loadScheme/schemeKey are unchanged (D-6-18)");
{
  const declAt = storeSource.indexOf("export async function resolveSchemeFor");
  const endAt = storeSource.indexOf("export async function saveScheme", declAt + 10);
  const body = declAt >= 0 ? storeSource.slice(declAt, endAt > declAt ? endAt : undefined) : "";
  const schemeKeySig = "export const schemeKey = (schoolId: string, mode?: Mode | null): string =>";
  const loadSchemeSig = "export async function loadScheme(schoolId: string | null | undefined, mode?: Mode | null): Promise<GradingScheme> {";

  if (declAt < 0) bad("resolver", "grading-store.ts does not export resolveSchemeFor");
  else if (!/loadScheme\(schoolId, mode\)/.test(body)) bad("resolver", "resolveSchemeFor does not delegate to loadScheme(schoolId, mode)");
  else if (!/void\s+programId/.test(body)) bad("resolver", "resolveSchemeFor does not visibly ignore programId (v1, D-6-19)");
  else if (!storeSource.includes(schemeKeySig)) bad("resolver", "schemeKey's signature changed");
  else if (!storeSource.includes(loadSchemeSig)) bad("resolver", "loadScheme's signature changed");
  else ok("grading-store.ts exports resolveSchemeFor, it delegates to loadScheme and ignores programId, and schemeKey/loadScheme are byte-unchanged");
}

/* ----------------------------------------------------------------------- 12 */

console.log("\n12. purity — no mutation, deterministic, and no store/HTTP surface");
{
  const attempts = Object.freeze([
    Object.freeze({ attempt: 1, obtained: 50, fullMarks: 100 }),
    Object.freeze({ attempt: 2, obtained: 80, fullMarks: 100 }),
  ]);
  const rows = Object.freeze([Object.freeze({ termNumber: 1, credits: 3, points: 4 }), Object.freeze({ points: 2 })]);
  const args = Object.freeze({ attempts: Object.freeze(attempts.slice()), policy: "BEST", passPercent: 40 });

  let first = null;
  let second = null;
  let threw = null;
  try {
    first = R.resolveCollegeAttempts(args);
    second = R.resolveCollegeAttempts(args);
  } catch (e) {
    threw = e?.message || String(e);
  }
  const gpaFirst = R.creditWeightedGpa({ gpaScale: 5 }, rows);
  const gpaSecond = R.creditWeightedGpa({ gpaScale: 5 }, rows);

  const storeSurface = /\b(prisma|findMany|update|delete|create|firestore|fetch|require)\b/.test(resultsCode);

  if (threw) bad("purity", `a frozen input threw: ${threw}`);
  else if (!sameDeep(first, second)) bad("purity", "two identical resolutions differed");
  else if (attempts.length !== 2 || attempts[0].obtained !== 50) bad("purity", "the input attempts were mutated");
  else if (!eq(gpaFirst, gpaSecond) || gpaFirst !== 3.5) bad("purity", "the GPA computation was not deterministic");
  else if (storeSurface) bad("purity", "the module names a store/HTTP surface — it must stay pure");
  else ok("a frozen input resolves twice to the same result, nothing is mutated, and the module names no store/HTTP surface");
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ COLLEGE GRADING LOGIC FAILED — ${failures} of ${checks} check(s) failed.`);
  process.exit(1);
}
console.log(
  `✅ COLLEGE GRADING LOGIC OK — ${checks} check(s): showGpa is backward-compatible, the four retake policies and the ` +
    `single pass mark resolve purely, GPA/CGPA are credit-weighted with a weight-1 fallback and null (never 0.00) when no GPA is shown, ` +
    `and resolveSchemeFor is the one resolution point.`
);
