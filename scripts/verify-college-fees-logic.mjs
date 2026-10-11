#!/usr/bin/env node
/**
 * Phase 7a — the pure college fee logic, proved OFFLINE.
 *
 * `src/lib/college-fees.ts` is the ONLY place that decides what a college term
 * charges from the admin's own heads and structure rows plus a student's
 * enrolment and APPROVED registrations: the charge set and its deterministic
 * ids, the discount arithmetic, the dues read and the payment rules. It is
 * deliberately dependency-free — no prisma, no HTTP, no React, no `node:` — so
 * this script pins it without a database, a server or an emulator: it carries
 * **no `requireEmulator()` guard** and runs on plain `node`, the same design as
 * `verify-college-grading-logic.mjs`, `verify-college-promotion-logic.mjs`,
 * `verify-college-terms.mjs` and `verify-college-gate.mjs`.
 *
 * The decisions it pins (docs/COLLEGE-DECISIONS.md §24.2–§24.4):
 *
 *   1. DEPENDENCY-FREE. The module has no `import` and no `require(`.
 *   2. MONEY IS INTEGER MINOR UNITS. `toMinor`/`fromMinor`/`roundMoney` are
 *      finite, 2-decimal, junk-safe, and the paisa rounding rule holds.
 *   3. THE TERM MODEL IS ONE MODEL. The restated term arithmetic equals
 *      `college-terms.ts` on every probe (pinned, not assumed to agree).
 *   4. THE HEAD IS THE SCHOOL'S SHAPE (D-7-2/D-7-5): name required and bounded,
 *      bucket/frequency fall back, dueDay clamps 1..28, and the bucket/frequency
 *      lists equal the school route's own lists.
 *   5. THE STRUCTURE ROW (D-7-6…D-7-8): a positive amount, a term the programme
 *      really has, and `PER_CREDIT` refused by name in v1.
 *   6. PRESETS (D-7-4): every preset validates, every head validates, each call
 *      returns an editable COPY, and no preset is privileged.
 *   7. THE CADENCE RULE (D-7-7): MONTHLY bills per month of the term, WEEKLY per
 *      week, TERM/YEARLY/ONE_TIME once, and every count is a whole number ≥ 1.
 *   8. TERM TOTALS (D-7-6/D-7-7): the row sum and the billed total (`amount ×
 *      events`), with an inactive head excluded.
 *   9. CHARGE DERIVATION (D-7-10): deterministic `(student, head, term,
 *      sequence)` ids, one row per billing event, an inactive or optional head
 *      handled, a COURSE-unit head billing once per APPROVED registration (and
 *      nothing at all without one — every event of the term), `PER_CREDIT` never
 *      priced, a re-run idempotent, and a late registration topping up instead of
 *      duplicating: the sequence is COURSE-major, so an id already billed keeps
 *      its own course and event and the new course's events are appended.
 *  10. DISCOUNTS (D-7-13): percent-of-term and fixed-per-head, propose/approve
 *      (only APPROVED applies), the paisa rounding rule, 100% waivers, no
 *      over-discount, no negative amount, and deterministic order.
 *  11. DUES AND PAYMENTS (D-7-14): `amount − paid` finite, partial payments,
 *      over-payment refused, and the status derived from the two fields.
 *  12. THE RESOLVER (D-6-18 pattern): `resolveCollegeFeeSettings` is the one
 *      settings entry point and ignores the programme/term in v1.
 *  13. PURITY: frozen inputs twice, deep-equal, nothing mutated, no store/HTTP
 *      surface named.
 *
 *   node scripts/verify-college-fees-logic.mjs
 *
 * It only READS files from the repository.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension,
 * so this local, synchronous hook retries a failed relative specifier with `.ts`
 * appended — the same approach as verify-college-grading-logic.mjs.
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

const FEES_URL = new URL("../src/lib/college-fees.ts", import.meta.url);
const TERMS_URL = new URL("../src/lib/college-terms.ts", import.meta.url);
const CATEGORIES_URL = new URL("../src/app/api/fee-categories/route.ts", import.meta.url);

const feesSource = readFileSync(FEES_URL, "utf8");
const categoriesSource = readFileSync(CATEGORIES_URL, "utf8");

const F = await import(FEES_URL.href);
const T = await import(TERMS_URL.href);

/**
 * Blank out comments and string literals, PRESERVING LENGTH, so a token search
 * runs against code only. The module documents its decisions in prose, so a raw
 * scan would match the documentation instead of the surface.
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

const feesCode = maskCommentsAndStrings(feesSource);

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

console.log("=== Phase 7a college fee logic (offline) ===");
console.log(`module: src/lib/college-fees.ts (${feesSource.split("\n").length} lines)`);

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. dependency-free — no import, no require() in the pure module");
{
  const importAt = feesCode.search(/\bimport\b/);
  const requireAt = feesCode.search(/\brequire\s*\(/);
  if (importAt >= 0) bad("dependencies", `\`import\` appears at character ${importAt} — the module must stay dependency-free`);
  else if (requireAt >= 0) bad("dependencies", `\`require(\` appears at character ${requireAt} — the module must stay dependency-free`);
  else ok("no `import` and no `require(` — no prisma, no node:, no React, no college-terms import");
}

/* ------------------------------------------------------------------------ 2 */

console.log("\n2. money is integer minor units — finite, 2 decimals, junk-safe");
{
  const cases = [
    [1500, 150000, 1500],
    ["1,500", 150000, 1500],
    ["৳1500.005", 150001, 1500.01],
    [1001.05, 100105, 1001.05],
    [0, 0, 0],
    [-5, -500, -5],
    [null, 0, 0],
    [undefined, 0, 0],
    ["x", 0, 0],
    [NaN, 0, 0],
    [Infinity, 0, 0],
    [{}, 0, 0],
    [[], 0, 0],
  ];
  let problem = null;
  for (const [input, minor, money] of cases) {
    if (F.toMinor(input) !== minor) problem = `toMinor(${JSON.stringify(input)}) = ${F.toMinor(input)}, expected ${minor}`;
    else if (F.fromMinor(minor) !== money) problem = `fromMinor(${minor}) = ${F.fromMinor(minor)}, expected ${money}`;
    else if (F.roundMoney(input) !== money) problem = `roundMoney(${JSON.stringify(input)}) = ${F.roundMoney(input)}, expected ${money}`;
    if (problem) break;
  }
  if (problem) bad("money", problem);
  else if (F.MINOR_PER_UNIT !== 100) bad("money", `MINOR_PER_UNIT = ${F.MINOR_PER_UNIT}, expected 100`);
  else if (!Number.isFinite(F.toMinor(1e12 + 0.005)) || !Number.isFinite(F.fromMinor(Number.MAX_SAFE_INTEGER)))
    bad("money", "a huge amount did not stay finite");
  else ok(`${cases.length} money inputs: paisa rounding, 2 decimals, junk reads 0, and huge amounts stay finite`);
}

/* ------------------------------------------------------------------------ 3 */

console.log("\n3. the term model is ONE model (college-terms.ts ↔ college-fees.ts)");
{
  const durations = [0, -1, 1, 2, 3, 4, 5, 6, 7, 1.5, "3", null, undefined, NaN];
  const systems = [undefined, null, "", "YEARLY", "SEMESTER", "yearly", "SEMESTERS", "x", 0, 1, true, {}, []];
  let problem = null;
  for (const d of durations) {
    for (const s of systems) {
      if (F.collegeTermCount(d, s) !== T.termCount(d, s)) {
        problem = `collegeTermCount(${JSON.stringify(d)}, ${JSON.stringify(s)}) = ${F.collegeTermCount(d, s)}, expected ${T.termCount(d, s)}`;
        break;
      }
      if (F.collegeTermsPerYear(s) !== T.termsPerYear(s)) {
        problem = `collegeTermsPerYear(${JSON.stringify(s)}) = ${F.collegeTermsPerYear(s)}, expected ${T.termsPerYear(s)}`;
        break;
      }
      if (F.normalizeCollegeTermSystem(s) !== T.normalizeTermSystem(s)) {
        problem = `normalizeCollegeTermSystem(${JSON.stringify(s)}) = ${F.normalizeCollegeTermSystem(s)}, expected ${T.normalizeTermSystem(s)}`;
        break;
      }
      for (const n of [0, 1, 2, 3, 6, 7, 12, -1, 1.5, "1", null, NaN, true]) {
        if (F.isValidCollegeTermNumber(n, d, s) !== T.isValidTermNumber(n, d, s)) {
          problem = `isValidCollegeTermNumber(${JSON.stringify(n)}, ${JSON.stringify(d)}, ${JSON.stringify(s)}) = ${F.isValidCollegeTermNumber(n, d, s)}, expected ${T.isValidTermNumber(n, d, s)}`;
          break;
        }
        if (F.collegeTermLabel(n, s) !== T.termLabel(n, s)) {
          problem = `collegeTermLabel(${JSON.stringify(n)}, ${JSON.stringify(s)}) = ${F.collegeTermLabel(n, s)}, expected ${T.termLabel(n, s)}`;
          break;
        }
      }
      if (problem) break;
    }
    if (problem) break;
  }
  const probes = durations.length * systems.length;
  if (problem) bad("terms", problem);
  else if (F.collegeTermMonths("YEARLY") !== 12 || F.collegeTermMonths("SEMESTER") !== 6 || F.collegeTermMonths(undefined) !== 12)
    bad("terms", `collegeTermMonths gave ${F.collegeTermMonths("YEARLY")}/${F.collegeTermMonths("SEMESTER")}, expected 12/6`);
  else if (F.collegeTermCount(3, "SEMESTER") !== 6 || F.isValidCollegeTermNumber(7, 3, "SEMESTER") !== false)
    bad("terms", "a 3-year SEMESTER programme did not have exactly 6 terms");
  else ok(`${probes} (duration × system) probes agree with college-terms.ts on the count, the per-year rate, the normalising read, the term label and the validity predicate`);
}

/* ------------------------------------------------------------------------ 4 */

console.log("\n4. the head is the school's shape, and the two enum lists are the school's lists (D-7-2/D-7-5)");
{
  const readArray = (source, name) => {
    const m = source.match(new RegExp(`const ${name} = \\[([^\\]]+)\\]`));
    return m ? m[1].split(",").map((s) => JSON.parse(s.trim())).filter((v) => typeof v === "string") : null;
  };
  const schoolBuckets = readArray(categoriesSource, "BUCKETS");
  const schoolFrequencies = readArray(categoriesSource, "FREQUENCIES");
  const mineBuckets = [...F.COLLEGE_FEE_BUCKETS];
  const mineFrequencies = [...F.COLLEGE_FEE_FREQUENCIES];

  if (!schoolBuckets || !schoolFrequencies) bad("heads", "could not read the school route's BUCKETS/FREQUENCIES");
  else if (!sameDeep(mineBuckets, schoolBuckets))
    bad("heads", `buckets ${JSON.stringify(mineBuckets)} != the school's ${JSON.stringify(schoolBuckets)}`);
  else if (!sameDeep(mineFrequencies, schoolFrequencies))
    bad("heads", `frequencies ${JSON.stringify(mineFrequencies)} != the school's ${JSON.stringify(schoolFrequencies)}`);
  else if (!F.COLLEGE_FEE_BUCKETS.every((b) => F.isCollegeFeeBucket(b)) || F.isCollegeFeeBucket("tuition"))
    bad("heads", "isCollegeFeeBucket disagrees with its own list");
  else if (!F.COLLEGE_FEE_FREQUENCIES.every((f) => F.isCollegeFeeFrequency(f)) || F.isCollegeFeeFrequency("monthly"))
    bad("heads", "isCollegeFeeFrequency disagrees with its own list");
  else
    ok(`the 8 buckets and 5 cadences are byte-equal to the school route's own lists, and each predicate accepts exactly its list`);
}

{
  const noName = F.validateCollegeFeeHead({ bucket: "TUITION" });
  const good = F.validateCollegeFeeHead({ name: "  Tuition Fee  ", bucket: "TUITION", frequency: "TERM", dueDay: "10", note: "per term" });
  const longName = F.validateCollegeFeeHead({ name: "x".repeat(200) });
  const junkEnums = F.validateCollegeFeeHead({ name: "Lab", bucket: "nope", frequency: "monthly", dueDay: 99, optional: "yes", active: 0 });
  const lowDay = F.validateCollegeFeeHead({ name: "Lab", dueDay: 0 });
  const junkDay = F.validateCollegeFeeHead({ name: "Lab", dueDay: "abc" });
  const longNote = F.validateCollegeFeeHead({ name: "Lab", note: "n".repeat(500) });
  const branch = F.validateCollegeFeeHead({ name: "Lab", branchId: "b_1" });

  if (noName.ok) bad("heads", "a head with no name was accepted");
  else if (!/name/i.test(noName.error)) bad("heads", `the missing-name refusal does not name the fix: ${noName.error}`);
  else if (!good.ok) bad("heads", `a valid head was refused: ${good.error}`);
  else if (good.head.name !== "Tuition Fee" || good.head.bucket !== "TUITION" || good.head.frequency !== "TERM" || good.head.dueDay !== 10 || good.head.note !== "per term")
    bad("heads", `a valid head was not normalised: ${JSON.stringify(good.head)}`);
  else if (!longName.ok || longName.head.name.length !== F.COLLEGE_FEE_NAME_MAX)
    bad("heads", `the name bound is not ${F.COLLEGE_FEE_NAME_MAX}`);
  else if (!junkEnums.ok || junkEnums.head.bucket !== "OTHER" || junkEnums.head.frequency !== "MONTHLY" || junkEnums.head.dueDay !== 28)
    bad("heads", `the enums/dueDay do not fall back and clamp: ${JSON.stringify(junkEnums.ok ? junkEnums.head : junkEnums.error)}`);
  else if (junkEnums.head.optional !== true || junkEnums.head.active !== false)
    bad("heads", "optional/active were not coerced the way the school's own route coerces them (`!!value`: \"yes\" → optional, 0 → inactive)");
  else if (!lowDay.ok || lowDay.head.dueDay !== 1) bad("heads", `dueDay 0 did not clamp to 1: ${JSON.stringify(lowDay.ok ? lowDay.head : lowDay.error)}`);
  else if (!junkDay.ok || junkDay.head.dueDay !== null) bad("heads", "a junk dueDay did not read null");
  else if (!longNote.ok || longNote.head.note.length !== F.COLLEGE_FEE_NOTE_MAX)
    bad("heads", `the note bound is not ${F.COLLEGE_FEE_NOTE_MAX}`);
  else if (!branch.ok || branch.head.branchId !== "b_1") bad("heads", "branchId was not carried");
  else {
    const junkInputs = [null, undefined, "x", 1, [], true, NaN];
    const accepted = junkInputs.filter((v) => F.validateCollegeFeeHead(v).ok);
    if (accepted.length) bad("heads", `junk input was accepted: ${JSON.stringify(accepted)}`);
    else {
      const normalized = junkInputs.map((v) => F.normalizeCollegeFeeHead(v));
      const badNorm = normalized.filter((h) => !h || typeof h.name !== "string" || !h.name || !h.bucket || !h.frequency || typeof h.active !== "boolean");
      if (badNorm.length) bad("heads", `normalizeCollegeFeeHead produced an unusable head: ${JSON.stringify(badNorm)}`);
      else if (F.normalizeCollegeFeeHead({ name: "", bucket: "z", frequency: "z", dueDay: 500 }).bucket !== "OTHER")
        bad("heads", "the lenient reader did not fall back");
      else if (F.normalizeCollegeFeeHead({ name: "A", dueDay: 0 }).dueDay !== 1)
        bad("heads", "the lenient reader did not clamp dueDay");
      else ok("a name is required and bounded, junk enums fall back, dueDay clamps 1..28 (junk → null), a 500-char note is bounded, and the lenient reader never throws");
    }
  }
}

/* ------------------------------------------------------------------------ 5 */

console.log("\n5. the structure row — a positive amount, the programme's own term, and PER_CREDIT refused (D-7-6…D-7-8)");
{
  const programme = { durationYears: 3, termSystem: "SEMESTER" }; // 6 terms
  const base = { programId: "pg_1", termNumber: 4, headId: "h_1", amount: 2500 };

  const good = F.validateCollegeFeeStructure({ ...base, required: false, unit: "COURSE", note: "lab" }, programme);
  const noProgram = F.validateCollegeFeeStructure({ ...base, programId: "" });
  const noHead = F.validateCollegeFeeStructure({ ...base, headId: null });
  const zeroAmount = F.validateCollegeFeeStructure({ ...base, amount: 0 });
  const junkAmount = F.validateCollegeFeeStructure({ ...base, amount: "abc" });
  const badTerm = F.validateCollegeFeeStructure({ ...base, termNumber: 7 }, programme);
  const fracTerm = F.validateCollegeFeeStructure({ ...base, termNumber: 1.5 }, programme);
  const zeroTerm = F.validateCollegeFeeStructure({ ...base, termNumber: 0 }, programme);
  const perCredit = F.validateCollegeFeeStructure({ ...base, basis: "PER_CREDIT" });
  const outsideRange = F.validateCollegeFeeStructure({ ...base, termNumber: 7 });
  const junkUnit = F.validateCollegeFeeStructure({ ...base, unit: "nope" });
  const junkBasis = F.validateCollegeFeeStructure({ ...base, basis: "CREDIT" });
  const absentFields = F.validateCollegeFeeStructure({ ...base, basis: null, unit: "" });

  if (!good.ok) bad("structure", `a valid row was refused: ${good.error}`);
  else if (good.row.amount !== 2500 || good.row.required !== false || good.row.unit !== "COURSE" || good.row.basis !== "FLAT" || good.row.note !== "lab")
    bad("structure", `a valid row was not normalised: ${JSON.stringify(good.row)}`);
  else if (noProgram.ok || noHead.ok) bad("structure", "a row without a programme or a head was accepted");
  else if (zeroAmount.ok || junkAmount.ok) bad("structure", "a row with amount 0 / junk was accepted");
  else if (badTerm.ok) bad("structure", "a row priced for term 7 of a 6-term programme was accepted");
  else if (!/6 term/i.test(badTerm.error)) bad("structure", `the out-of-range refusal does not say how many terms exist: ${badTerm.error}`);
  else if (fracTerm.ok || zeroTerm.ok) bad("structure", "a fractional or zero term was accepted");
  else if (perCredit.ok) bad("structure", "a PER_CREDIT row was accepted in v1");
  else if (perCredit.error !== F.PER_CREDIT_NOT_IN_V1) bad("structure", `the PER_CREDIT refusal is not the pinned one: ${perCredit.error}`);
  else if (!outsideRange.ok || outsideRange.row.termNumber !== 7) bad("structure", "a term is no longer accepted when no programme bounds are given");
  else if (junkUnit.ok || junkBasis.ok) bad("structure", `a junk unit/basis was accepted instead of refused: ${JSON.stringify([junkUnit, junkBasis])}`);
  else if (!/STUDENT or COURSE/.test(junkUnit.error) || !/FLAT or PER_CREDIT/.test(junkBasis.error))
    bad("structure", `the junk unit/basis refusals do not name the allowed values: ${junkUnit.error} / ${junkBasis.error}`);
  else if (!absentFields.ok || absentFields.row.unit !== "STUDENT" || absentFields.row.basis !== "FLAT")
    bad("structure", "an absent unit/basis did not default to STUDENT/FLAT");
  else {
    const junk = [null, undefined, "x", 1, []].filter((v) => F.validateCollegeFeeStructure(v).ok);
    const normalised = F.normalizeCollegeFeeStructure({ termNumber: 0, amount: "abc", basis: "PER_CREDIT", unit: "nope" });
    if (junk.length) bad("structure", `junk input was accepted: ${JSON.stringify(junk)}`);
    else if (normalised.termNumber !== 1 || normalised.amount !== 0 || normalised.unit !== "STUDENT")
      bad("structure", `the lenient reader did not fall back: ${JSON.stringify(normalised)}`);
    else if (normalised.basis !== "PER_CREDIT") bad("structure", "the lenient reader dropped an explicit PER_CREDIT basis — the billing path must be able to refuse it");
    else ok("a valid row normalises; an unknown unit/basis is refused by name (only absent fields default), and a missing programme/head, a non-positive amount, a fractional or out-of-range term and PER_CREDIT are all refused");
  }
}

/* ------------------------------------------------------------------------ 6 */

console.log("\n6. presets are editable starting points, all valid, none privileged (D-7-4)");
{
  const keys = F.COLLEGE_FEE_PRESETS.map((p) => p.key);
  const invalidHead = F.COLLEGE_FEE_PRESETS.flatMap((p) => p.heads.map((h) => ({ key: p.key, result: F.validateCollegeFeeHead(h) }))).find((x) => !x.result.ok);
  const perCredit = F.COLLEGE_FEE_PRESETS.flatMap((p) => p.heads).find((h) => h.basis === "PER_CREDIT");

  const copyA = F.presetHeads("college-hsc");
  const copyB = F.presetHeads("college-hsc");
  if (copyA.length) copyA[0].name = "MUTATED";
  const presetHeadAfter = F.presetHeads("college-hsc")[0].name;

  if (F.COLLEGE_FEE_PRESETS.length < 3) bad("presets", `only ${F.COLLEGE_FEE_PRESETS.length} presets`);
  else if (new Set(keys).size !== keys.length) bad("presets", `duplicate preset keys: ${JSON.stringify(keys)}`);
  else if (invalidHead) bad("presets", `preset "${invalidHead.key}" carries a head that does not validate: ${invalidHead.result.error}`);
  else if (perCredit) bad("presets", "a preset carries a PER_CREDIT head while D-7-8 refuses one in v1");
  else if (F.collegeFeePreset("nope") !== null || !F.collegeFeePreset("college-hsc")) bad("presets", "collegeFeePreset does not resolve keys strictly");
  else if (!sameDeep(F.presetHeads("custom"), [])) bad("presets", "the custom preset is not empty");
  else if (copyA === copyB || copyA[0] === copyB[0]) bad("presets", "presetHeads returned the same array/object twice — an edit could rewrite the table");
  else if (presetHeadAfter === "MUTATED") bad("presets", "mutating a returned copy changed the preset table itself");
  else if (!sameDeep(F.presetHeads("nope"), [])) bad("presets", "presetHeads(junk) did not return an empty list");
  else {
    const heads = F.validateCollegeFeeHead(F.COLLEGE_FEE_PRESETS[0].heads[0]);
    if (!heads.ok || heads.head.frequency !== "MONTHLY") bad("presets", "the HSC preset's first head is not the monthly tuition head");
    else ok(`all ${F.COLLEGE_FEE_PRESETS.length} presets (and all ${F.COLLEGE_FEE_PRESETS.reduce((a, p) => a + p.heads.length, 0)} heads) validate, each call returns an independent copy, and no credit-based preset exists while PER_CREDIT is refused`);
  }
}

/* ------------------------------------------------------------------------ 7 */

console.log("\n7. the cadence rule — one row = one event, the frequency decides how many (D-7-7)");
{
  const expected = [
    ["MONTHLY", 12, 12],
    ["MONTHLY", 6, 6],
    ["MONTHLY", 1, 1],
    ["TERM", 12, 1],
    ["TERM", 6, 1],
    ["YEARLY", 12, 1],
    ["YEARLY", 6, 1],
    ["YEARLY", 24, 2],
    ["WEEKLY", 12, 52],
    ["WEEKLY", 6, 26],
    ["ONE_TIME", 12, 1],
  ];
  let problem = null;
  for (const [freq, months, want] of expected) {
    const got = F.billingEventsFor(freq, months);
    if (got !== want) {
      problem = `billingEventsFor("${freq}", ${months}) = ${got}, expected ${want}`;
      break;
    }
  }
  const all = F.COLLEGE_FEE_FREQUENCIES.map((f) => f).concat(["junk", "", "monthly", null, undefined]);
  const notWhole = all.filter((f) => !Number.isInteger(F.billingEventsFor(f, 6)) || F.billingEventsFor(f, 6) < 1);

  if (problem) bad("cadence", problem);
  else if (!eq(F.billingEventsFor("monthly", 6), 6) || !eq(F.billingEventsFor("junk", 12), 12) || !eq(F.billingEventsFor(undefined, 12), 12))
    bad("cadence", "an unknown or missing frequency did not read as MONTHLY");
  else if (!eq(F.billingEventsFor("MONTHLY", 0), 12) || !eq(F.billingEventsFor("MONTHLY", -3), 12) || !eq(F.billingEventsFor("MONTHLY", "x"), 12))
    bad("cadence", "a missing/zero/negative/junk term length did not fall back to a year");
  else if (!eq(F.billingEventsFor("MONTHLY", 999), F.MAX_TERM_MONTHS) || F.MAX_TERM_MONTHS !== 60)
    bad("cadence", `a huge term length was not capped at ${F.MAX_TERM_MONTHS} months`);
  else if (notWhole.length) bad("cadence", `these frequencies did not give a whole number ≥ 1: ${JSON.stringify(notWhole)}`);
  else ok(`${expected.length} cadence/length anchors exact (MONTHLY per month, WEEKLY per week, TERM/YEARLY/ONE_TIME once, YEARLY once per year); every frequency gives a whole number ≥ 1 and junk reads as a year of MONTHLY`);
}

/* ------------------------------------------------------------------------ 8 */

console.log("\n8. term totals — the row sum, and the money a term raises (D-7-6/D-7-7)");
{
  const heads = [
    { id: "h_tuition", name: "Tuition", bucket: "TUITION", frequency: "MONTHLY", active: true },
    { id: "h_exam", name: "Exam", bucket: "EXAM", frequency: "TERM", active: true },
    { id: "h_old", name: "Old Levy", bucket: "OTHER", frequency: "TERM", active: false },
  ];
  const rows = [
    { programId: "pg", termNumber: 1, headId: "h_tuition", amount: 1000 },
    { programId: "pg", termNumber: 1, headId: "h_exam", amount: 500 },
    { programId: "pg", termNumber: 1, headId: "h_old", amount: 300 },
  ];
  const billable = F.billableStructureRows(rows, heads);
  const lines = F.billingBreakdown(rows, heads, 6);

  if (F.structureTotal(rows) !== 1800) bad("totals", `structureTotal = ${F.structureTotal(rows)}, expected 1800 (one event each)`);
  else if (billable.length !== 2 || billable.some((r) => r.headId === "h_old")) bad("totals", "an inactive head's row was not excluded from billing");
  else if (F.termBillTotal(rows, heads, 6) !== 6500) bad("totals", `termBillTotal = ${F.termBillTotal(rows, heads, 6)}, expected 6500 (1000×6 + 500)`);
  else if (F.termBillTotal([], heads, 6) !== 0 || F.structureTotal(null) !== 0 || F.termBillTotal("x", "y", 6) !== 0)
    bad("totals", "an empty/junk structure did not total 0");
  else if (!sameDeep(lines.map((l) => [l.headId, l.events, l.total]), [["h_tuition", 6, 6000], ["h_exam", 1, 500]]))
    bad("totals", `billingBreakdown = ${JSON.stringify(lines)}`);
  else if (
    F.termBillTotal(
      rows,
      [
        { id: "h_tuition", frequency: "YEARLY" },
        { id: "h_exam", frequency: "TERM" },
        { id: "h_old", frequency: "TERM", active: false },
      ],
      12
    ) !== 1500
  )
    bad("totals", "a row whose head changed cadence did not follow the head (YEARLY tuition 1000 + TERM exam 500 = 1500)");
  else ok("structureTotal sums the rows once each; termBillTotal is amount × events and excludes an inactive head; an empty structure is 0 and the breakdown names every line");
}

/* ------------------------------------------------------------------------ 9 */

console.log("\n9. charge derivation — deterministic ids, one row per event, idempotent, late top-up (D-7-10)");
{
  const programme = { durationYears: 3, termSystem: "SEMESTER" };
  const heads = [
    { id: "h_tuition", name: "Tuition Fee", bucket: "TUITION", frequency: "MONTHLY", active: true, dueDay: 10 },
    { id: "h_exam", name: "Exam Fee", bucket: "EXAM", frequency: "TERM", active: true },
    { id: "h_lab", name: "Lab Fee", bucket: "OTHER", frequency: "TERM", active: true },
    { id: "h_old", name: "Old Levy", bucket: "OTHER", frequency: "TERM", active: false },
    { id: "h_lib", name: "Library", bucket: "OTHER", frequency: "TERM", active: true, optional: true },
  ];
  const rows = [
    { programId: "pg_1", termNumber: 1, headId: "h_tuition", amount: 1000 },
    { programId: "pg_1", termNumber: 1, headId: "h_exam", amount: 500 },
    { programId: "pg_1", termNumber: 1, headId: "h_lab", amount: 200, unit: "COURSE" },
    { programId: "pg_1", termNumber: 1, headId: "h_old", amount: 300 },
    { programId: "pg_1", termNumber: 1, headId: "h_lib", amount: 400 },
    { programId: "pg_1", termNumber: 2, headId: "h_exam", amount: 500 },
    { programId: "pg_2", termNumber: 1, headId: "h_exam", amount: 500 },
  ];
  const approved3 = [
    { courseId: "c1", status: "APPROVED" },
    { courseId: "c2", status: "APPROVED" },
    { courseId: "c3", status: "APPROVED" },
  ];
  const request = {
    schoolId: "s_1",
    branchId: "b_1",
    studentId: "st_1",
    programId: "pg_1",
    termNumber: 1,
    programme,
    heads,
    structure: rows,
    registrations: approved3,
  };

  const plan = F.deriveCollegeCharges(request);
  const again = F.deriveCollegeCharges(request);
  const shuffled = F.deriveCollegeCharges({ ...request, heads: [...heads].reverse(), structure: [...rows].reverse() });

  const ids = plan.charges.map((c) => c.id);
  const expectedTuition = F.collegeChargeId("st_1", "h_tuition", 1, 1);
  const byHead = (id) => plan.charges.filter((c) => c.headId === id);

  if (!eq(plan.charges.length, 6 + 1 + 3)) bad("charges", `plan = ${plan.charges.length} charges, expected 10 (6 tuition + 1 exam + 3 lab)`);
  else if (!sameDeep(plan, again)) bad("charges", "two identical derivations differed — the derivation is not deterministic");
  else if (!sameDeep(plan, shuffled) || !sameDeep(shuffled.charges.map((c) => c.id), ids))
    bad("charges", "reversing the input rows/heads changed the plan — the output is not order-independent");
  else if (new Set(ids).size !== ids.length) bad("charges", "the charge ids are not unique");
  else if (!plan.charges.some((c) => c.id === expectedTuition) || expectedTuition !== "cf_st_1_h_tuition_1_1")
    bad("charges", `the id is not (student, head, term, sequence): ${expectedTuition}`);
  else if (byHead("h_tuition").length !== 6 || byHead("h_tuition")[5].sequence !== 6) bad("charges", "a MONTHLY head did not bill six times in a semester");
  else if (byHead("h_lab").length !== 3 || !byHead("h_lab").every((c) => c.unit === "COURSE")) bad("charges", "a COURSE-unit head did not bill once per approved registration");
  else if (!byHead("h_tuition").every((c) => c.paidAmount === 0 && c.status === "UNPAID" && c.termNumber === 1 && c.programId === "pg_1" && c.schoolId === "s_1" && c.branchId === "b_1"))
    bad("charges", "a charge row is missing paidAmount: 0 / status UNPAID / its tenant, programme or term");
  else if (!plan.charges.some((c) => c.title.includes("Tuition Fee") && c.title.includes("Semester 1") && c.title.includes("(6/6)")))
    bad("charges", `a charge title does not carry its head, term and event: ${plan.charges[0].title}`);
  else if (byHead("h_old").length !== 0 || !plan.refused.some((r) => r.headId === "h_old" && /inactive/i.test(r.reason)))
    bad("charges", "an inactive head was billed instead of refused");
  else if (byHead("h_lib").length !== 0 || plan.skippedOptional !== 1) bad("charges", "an optional head billed without being asked for");
  else if (plan.total !== 1000 * 6 + 500 + 200 * 3) bad("charges", `plan.total = ${plan.total}, expected ${1000 * 6 + 500 + 200 * 3}`);
  else if (plan.planned !== plan.charges.length || plan.existing.length !== 0)
    bad("charges", "the first run reported existing rows");
  else {
    const optional = F.deriveCollegeCharges({ ...request, includeOptional: true, headIds: ["h_tuition", "h_lib"] });
    const picked = F.deriveCollegeCharges({ ...request, headIds: ["h_tuition"] });
    if (optional.charges.filter((c) => c.headId === "h_lib").length !== 1)
      bad("charges", "an explicitly requested optional head did not bill");
    else if (picked.charges.some((c) => c.headId !== "h_tuition"))
      bad("charges", "an explicit head pick did not narrow the plan");
    else {
      const reRun = F.deriveCollegeCharges({ ...request, existing: plan.charges });
      const late = F.deriveCollegeCharges({ ...request, registrations: approved3.slice(0, 2) });
      const topUp = F.deriveCollegeCharges({ ...request, registrations: approved3, existing: late.charges });
      const noReg = F.deriveCollegeCharges({ ...request, registrations: [] });
      const pending = F.deriveCollegeCharges({ ...request, registrations: [{ status: "PENDING" }, { status: "REJECTED" }, {}] });
      const lowerCased = F.deriveCollegeCharges({ ...request, registrations: [{ status: "approved" }] });

      if (reRun.charges.length !== 0 || reRun.existing.length !== plan.charges.length || reRun.total !== 0)
        bad("charges", `a re-run with every charge on the books still wrote ${reRun.charges.length} rows`);
      else if (late.charges.filter((c) => c.headId === "h_lab").length !== 2)
        bad("charges", "a student with two approved registrations did not bill two lab charges");
      else if (topUp.charges.length !== 1 || topUp.charges[0].headId !== "h_lab" || topUp.charges[0].amount !== 200)
        bad("charges", `a late registration did not top up exactly one new charge: ${JSON.stringify(topUp.charges.map((c) => c.id))}`);
      else if (!topUp.existing.includes(F.collegeChargeId("st_1", "h_lab", 1, 1)))
        bad("charges", "the top-up did not recognise the charge already on the books");
      else if (noReg.charges.some((c) => c.headId === "h_lab")) bad("charges", "a COURSE head billed with no approved registration");
      else if (noReg.charges.filter((c) => c.headId === "h_tuition").length !== 6 || !noReg.refused.some((r) => r.headId === "h_lab" && /no approved course registration/i.test(r.reason)))
        bad("charges", "a flat head stopped billing, or a course-based head was not refused by name, when there were no registrations");
      else if (pending.charges.some((c) => c.headId === "h_lab"))
        bad("charges", "a PENDING/REJECTED registration billed a course-based head");
      else if (lowerCased.charges.filter((c) => c.headId === "h_lab").length !== 1)
        bad("charges", "the lenient status read did not treat a lower-cased \"approved\" as approved");
      else ok("10 charges derived (6 monthly + 1 term + 3 per course), ids deterministic and unique, order-independent, paidAmount 0, an inactive head refused, an optional head only on request, a re-run writes nothing, and a late registration tops up exactly one charge");
    }
  }
}

{
  // A COURSE-unit head on a multi-event cadence (D-7-7 x D-7-10): a late
  // registration must APPEND the new course's events and must never re-attribute
  // an id already on the books to another course.
  const programme = { durationYears: 3, termSystem: "SEMESTER" };
  const heads = [{ id: "h_lab", name: "Lab Fee", bucket: "OTHER", frequency: "MONTHLY", active: true }];
  const structure = [{ programId: "pg", termNumber: 1, headId: "h_lab", amount: 150, unit: "COURSE" }];
  const base = { studentId: "st_9", programId: "pg", termNumber: 1, programme, heads, structure };
  const approved1 = [{ status: "APPROVED" }];
  const approved2 = [{ status: "APPROVED" }, { status: "APPROVED" }];
  const one = F.deriveCollegeCharges({ ...base, registrations: approved1 });
  const two = F.deriveCollegeCharges({ ...base, registrations: approved2 });
  const topped = F.deriveCollegeCharges({ ...base, registrations: approved2, existing: one.charges });
  const oneIds = one.charges.map((c) => c.id);
  const fresh = topped.charges;

  if (one.charges.length !== 6) bad("charges", `a MONTHLY COURSE head billed ${one.charges.length} times for one course, expected 6 (a semester)`);
  else if (two.charges.length !== 12) bad("charges", `two approved courses billed ${two.charges.length} charges, expected 12 (2 x 6 events)`);
  else if (topped.existing.length !== 6 || fresh.length !== 6)
    bad("charges", `the top-up recognised ${topped.existing.length} of 6 rows already on the books and wrote ${fresh.length}, expected 6 new`);
  else if (!topped.existing.every((id) => oneIds.includes(id)))
    bad("charges", "the top-up did not recognise exactly the ids already on the books");
  else if (fresh.some((c) => oneIds.includes(c.id))) bad("charges", "the late registration reused an id already on the books");
  else if (!fresh.every((c) => /Course 2/.test(c.title)))
    bad("charges", `a topped-up charge was not attributed to the newly registered course: ${fresh.map((c) => c.title).join(" | ")}`);
  else if (topped.total !== 6 * 150 || two.total !== 12 * 150)
    bad("charges", `the money did not add up once per course per event: ${topped.total} / ${two.total}, expected ${6 * 150} / ${12 * 150}`);
  else if (fresh.some((c) => c.paidAmount !== 0 || c.status !== "UNPAID"))
    bad("charges", "a topped-up charge did not start unpaid");
  else
    ok("a COURSE head on a MONTHLY cadence bills every event of the term for each course (6 then 12), and a late registration appends the new course's 6 events — the ids already billed keep their own course and event");
}

{
  const programme = { durationYears: 3, termSystem: "SEMESTER" };
  const heads = [
    { id: "h_credit", name: "Per-credit Tuition", bucket: "TUITION", frequency: "TERM", active: true },
    { id: "h_flat", name: "Flat Fee", bucket: "OTHER", frequency: "TERM", active: true },
  ];
  const structure = [
    { programId: "pg", termNumber: 1, headId: "h_credit", amount: 900, basis: "PER_CREDIT" },
    { programId: "pg", termNumber: 1, headId: "h_flat", amount: 100 },
  ];
  const plan = F.deriveCollegeCharges({
    studentId: "st_1",
    programId: "pg",
    termNumber: 1,
    programme,
    heads,
    structure,
    registrations: [{ status: "APPROVED", creditHours: null }, { status: "APPROVED", creditHours: null }],
  });
  const amounts = [...plan.charges.map((c) => c.amount), plan.total];

  if (plan.charges.some((c) => c.headId === "h_credit")) bad("charges", "a PER_CREDIT row was priced");
  else if (!plan.refused.some((r) => r.headId === "h_credit" && r.reason === F.PER_CREDIT_NOT_IN_V1))
    bad("charges", "a PER_CREDIT row was not refused with the pinned reason");
  else if (amounts.some((n) => !Number.isFinite(n))) bad("charges", `a null creditHours produced a non-finite amount: ${JSON.stringify(amounts)}`);
  else if (plan.total !== 100) bad("charges", `only the flat row should bill: total ${plan.total}`);
  else ok("a PER_CREDIT row is refused by name even with approved registrations, and null creditHours can never produce a NaN");
}

{
  const programme = { durationYears: 2, termSystem: "YEARLY" };
  const base = {
    studentId: "st_1",
    programId: "pg",
    termNumber: 1,
    programme,
    heads: [{ id: "h_1", name: "Fee", frequency: "TERM", active: true }],
    structure: [{ programId: "pg", termNumber: 1, headId: "h_1", amount: 100 }],
  };
  const empties = [
    F.deriveCollegeCharges({}),
    F.deriveCollegeCharges(null),
    F.deriveCollegeCharges({ ...base, structure: [] }),
    F.deriveCollegeCharges({ ...base, structure: "x" }),
    F.deriveCollegeCharges({ ...base, studentId: "" }),
    F.deriveCollegeCharges({ ...base, programId: null }),
    F.deriveCollegeCharges({ ...base, termNumber: 0 }),
    F.deriveCollegeCharges({ ...base, termNumber: 1.5 }),
    F.deriveCollegeCharges({ ...base, termNumber: 3 }), // a 2-year YEARLY programme has 2 terms
    F.deriveCollegeCharges({ ...base, heads: undefined }),
  ];
  const offenders = empties.filter((p) => !p || p.charges.length !== 0 || p.total !== 0 || p.planned !== 0 || !Number.isFinite(p.total));
  if (offenders.length) bad("charges", `${offenders.length} empty/junk/zero-charge inputs did not resolve to an empty plan`);
  else if (empties.some((p) => !Array.isArray(p.refused) || !Array.isArray(p.existing)))
    bad("charges", "an empty plan is missing its refused/existing arrays");
  else ok("empty input, an empty structure, junk, a missing student/programme, a fractional/zero/out-of-range term and an unknown head all resolve to an empty finite plan — never a throw");
}

/* ----------------------------------------------------------------------- 10 */

console.log("\n10. discounts — percent and fixed, proposed/approved, rounded in paisa, never over-discounted (D-7-13)");
{
  const badPercent = [0, -1, 101, "x", null, NaN].filter((p) => F.validateCollegeDiscount({ kind: "PERCENT", percent: p }).ok);
  const badFixed = [0, -5, "x", null].filter((a) => F.validateCollegeDiscount({ kind: "FIXED", amountPerHead: a, headIds: ["h_1"] }).ok);
  const noHeads = F.validateCollegeDiscount({ kind: "FIXED", amountPerHead: 100 });
  const noKind = F.validateCollegeDiscount({ percent: 10 });
  const noApprover = F.validateCollegeDiscount({ kind: "PERCENT", percent: 10, status: "APPROVED" });
  const approved = F.validateCollegeDiscount({ kind: "PERCENT", percent: 10, status: "APPROVED", approvedBy: "u_admin", proposedBy: "u_acc" });

  if (badPercent.length) bad("discounts", `an out-of-range percentage was accepted: ${JSON.stringify(badPercent)}`);
  else if (badFixed.length) bad("discounts", `a non-positive fixed amount was accepted: ${JSON.stringify(badFixed)}`);
  else if (noHeads.ok) bad("discounts", "a fixed award with no head was accepted");
  else if (noKind.ok) bad("discounts", "an award with no kind was accepted");
  else if (noApprover.ok) bad("discounts", "an APPROVED award with no approver was accepted");
  else if (!approved.ok || approved.award.status !== "APPROVED" || approved.award.approvedBy !== "u_admin")
    bad("discounts", "a valid approved award was refused or not normalised");
  else ok("validation: 1..100 percent, a positive fixed amount with a head, and an APPROVED award must record its approver — junk is refused rather than defaulted");
}

{
  const charge = (over) => ({
    id: "cf_1",
    headId: "h_lab",
    programId: "pg",
    termNumber: 1,
    amount: 1001.05,
    paidAmount: 0,
    ...over,
  });
  const awards = [
    { id: "d_2", kind: "FIXED", amountPerHead: 500, headIds: ["h_lab"], status: "APPROVED", approvedBy: "u" },
    { id: "d_1", kind: "PERCENT", percent: 33, status: "APPROVED", approvedBy: "u" },
  ];
  const result = F.applyCollegeDiscounts([charge()], awards);
  // 100105 paisa × 33% = 33034.65 → 33035 paisa (330.35); remaining 67070; the
  // fixed 500 → 50000 paisa; net 17070 paisa (170.70).
  const row = result.rows[0];

  if (row.grossAmount !== 1001.05) bad("discounts", `the gross amount changed: ${row.grossAmount}`);
  else if (row.discount !== 830.35) bad("discounts", `the discount = ${row.discount}, expected 330.35 + 500 = 830.35 (paisa rounding)`);
  else if (row.amount !== 170.7) bad("discounts", `the net amount = ${row.amount}, expected 170.70`);
  else if (result.grossTotal !== 1001.05 || result.netTotal !== 170.7 || result.totalDiscount !== 830.35)
    bad("discounts", `the totals disagree: ${JSON.stringify({ g: result.grossTotal, n: result.netTotal, d: result.totalDiscount })}`);
  else if (result.rows.reduce((a, r) => a + r.discount, 0) !== 0 && Math.abs(result.rows.reduce((a, r) => a + r.discount, 0) - result.totalDiscount) > 1e-9)
    bad("discounts", "the row discounts do not add up to the reported total");
  else if (result.applied.length !== 2 || !result.applied.some((a) => a.awardId === "d_1") || !result.applied.some((a) => a.awardId === "d_2"))
    bad("discounts", `the applied list is wrong: ${JSON.stringify(result.applied)}`);
  else ok("percent-first with paisa rounding on an odd amount (1001.05 × 33% = 330.35), then the fixed waiver, and both are reported");
}

{
  const sixMonthly = Array.from({ length: 6 }, (_, i) => ({
    id: `cf_${i + 1}`,
    headId: "h_tuition",
    programId: "pg",
    termNumber: 1,
    amount: 1000,
    paidAmount: 0,
  }));
  const waiver = F.applyCollegeDiscounts(sixMonthly, [
    { id: "d_lab", kind: "FIXED", amountPerHead: 1500, headIds: ["h_tuition"], status: "APPROVED", approvedBy: "u" },
  ]);
  const tooBig = F.applyCollegeDiscounts(sixMonthly, [
    { id: "d_huge", kind: "FIXED", amountPerHead: 99999, headIds: ["h_tuition"], status: "APPROVED", approvedBy: "u" },
  ]);
  const hundred = F.applyCollegeDiscounts(sixMonthly.slice(0, 1), [
    { id: "d_full", kind: "PERCENT", percent: 100, status: "APPROVED", approvedBy: "u" },
  ]);
  const proposed = F.applyCollegeDiscounts(sixMonthly, [
    { id: "d_prop", kind: "PERCENT", percent: 100, status: "PROPOSED", proposedBy: "u" },
  ]);
  const rejected = F.applyCollegeDiscounts(sixMonthly, [
    { id: "d_rej", kind: "PERCENT", percent: 100, status: "REJECTED", approvedBy: "u" },
  ]);
  const junkAward = F.applyCollegeDiscounts(sixMonthly, [{ id: "d_junk", kind: "PERCENT", status: "APPROVED", approvedBy: "u" }]);

  if (waiver.totalDiscount !== 1500) bad("discounts", `a fixed waiver per head waived ${waiver.totalDiscount}, expected 1500 once across the term`);
  else if (waiver.rows.map((r) => r.discount).join(",") !== "1000,500,0,0,0,0")
    bad("discounts", `the fixed waiver did not walk the head's charges in order: ${waiver.rows.map((r) => r.discount).join(",")}`);
  else if (tooBig.totalDiscount !== 6000 || tooBig.rows.some((r) => r.amount < 0))
    bad("discounts", `an over-large waiver produced ${JSON.stringify(tooBig.rows.map((r) => r.amount))}`);
  else if (!tooBig.applied.some((a) => a.clamped)) bad("discounts", "an exhausted waiver was not reported as clamped");
  else if (hundred.rows[0].amount !== 0 || hundred.totalDiscount !== 1000) bad("discounts", `a 100% waiver left ${hundred.rows[0].amount}`);
  else if (proposed.totalDiscount !== 0 || rejected.totalDiscount !== 0) bad("discounts", "a PROPOSED/REJECTED award discounted something");
  else if (junkAward.rows[0].discount !== 0 || junkAward.skippedAwards.length !== 1)
    bad("discounts", "an unreadable approved award was not skipped with a reason");
  else ok("a fixed waiver lands once per head (1000 + 500 across six monthly charges), an exhausted one clamps and reports it, a 100% waiver reaches 0 with no negative amount, and PROPOSED/REJECTED/junk awards are inert");
}

{
  const charges = [
    { id: "cf_1", headId: "h_a", programId: "pg", termNumber: 1, amount: 100, paidAmount: 0 },
    { id: "cf_2", headId: "h_b", programId: "pg", termNumber: 1, amount: 100, paidAmount: 0 },
  ];
  const overlap = F.applyCollegeDiscounts(charges, [
    { id: "d_a", kind: "PERCENT", percent: 100, status: "APPROVED", approvedBy: "u" },
    { id: "d_b", kind: "FIXED", amountPerHead: 500, headIds: ["h_a", "h_b"], status: "APPROVED", approvedBy: "u" },
  ]);
  const otherTerm = F.applyCollegeDiscounts(charges, [
    { id: "d_t", kind: "PERCENT", percent: 50, termNumber: 2, status: "APPROVED", approvedBy: "u" },
  ]);
  const otherProgramme = F.applyCollegeDiscounts(charges, [
    { id: "d_p", kind: "PERCENT", percent: 50, programId: "pg_other", status: "APPROVED", approvedBy: "u" },
  ]);
  const ordered = F.applyCollegeDiscounts(charges, [
    { id: "d_b", kind: "PERCENT", percent: 25, status: "APPROVED", approvedBy: "u" },
    { id: "d_a", kind: "PERCENT", percent: 25, status: "APPROVED", approvedBy: "u" },
  ]);
  const flipped = F.applyCollegeDiscounts(charges, [
    { id: "d_a", kind: "PERCENT", percent: 25, status: "APPROVED", approvedBy: "u" },
    { id: "d_b", kind: "PERCENT", percent: 25, status: "APPROVED", approvedBy: "u" },
  ]);

  if (overlap.rows.some((r) => r.amount !== 0) || overlap.netTotal !== 0 || overlap.totalDiscount !== 200)
    bad("discounts", `overlapping awards did not clamp at zero: ${JSON.stringify(overlap.rows.map((r) => r.amount))}`);
  else if (otherTerm.totalDiscount !== 0 || otherProgramme.totalDiscount !== 0)
    bad("discounts", "an award reached a charge outside its own programme or term");
  else if (!sameDeep(ordered, flipped)) bad("discounts", "award order changed the result — the ordering is not deterministic");
  else if (ordered.rows.some((r) => r.amount !== 50))
    bad("discounts", `two 25% awards gave ${JSON.stringify(ordered.rows.map((r) => r.amount))}, expected 50 each`);
  else ok("two overlapping awards clamp at zero, a term/programme scoped award reaches only its own charges, and the same awards in either order give the same rows");
}

/* ----------------------------------------------------------------------- 11 */

console.log("\n11. dues and payments — finite, derived status, over-payment refused (D-7-14)");
{
  const charges = [
    { id: "cf_1", amount: 1000, paidAmount: 400 },
    { id: "cf_2", amount: 500.5, paidAmount: 500.5 },
    { id: "cf_3", amount: "junk", paidAmount: null },
  ];
  const dues = F.collegeDues(charges);
  const empty = F.collegeDues([]);
  const junkInput = F.collegeDues(null);
  const huge = F.collegeDues([{ id: "cf_h", amount: 9_000_000_000.55, paidAmount: 1_000_000_000.25 }]);

  if (dues.billed !== 1500.5 || dues.paid !== 900.5 || dues.due !== 600)
    bad("dues", `dues = ${JSON.stringify({ billed: dues.billed, paid: dues.paid, due: dues.due })}`);
  else if (dues.rows[0].status !== "PARTIAL" || dues.rows[1].status !== "PAID" || dues.rows[2].status !== "PAID" || dues.rows[2].amount !== 0)
    bad("dues", `the derived statuses are wrong: ${JSON.stringify(dues.rows.map((r) => r.status))}`);
  else if (dues.status !== "PARTIAL") bad("dues", `the set status = ${dues.status}, expected PARTIAL`);
  else if (empty.count !== 0 || empty.due !== 0 || empty.status !== "UNPAID" || junkInput.due !== 0)
    bad("dues", "an empty or junk charge set did not read as a finite zero");
  else if (!Number.isFinite(huge.due) || huge.due !== 8_000_000_000.3)
    bad("dues", `a huge amount did not stay finite: ${huge.due}`);
  else if (!sameDeep([F.duesStatus(0, 0), F.duesStatus(100, 0), F.duesStatus(100, 50), F.duesStatus(100, 100), F.duesStatus(100, 150), F.duesStatus("junk", 10)], ["PAID", "UNPAID", "PARTIAL", "PAID", "PAID", "PAID"]))
    bad("dues", "duesStatus disagreed with the vocabulary");
  else if (F.chargeDue({ amount: 100, paidAmount: 250 }) !== 0 || F.chargeDue(null) !== 0 || F.chargeDue({ amount: 100.5, paidAmount: 0.25 }) !== 100.25)
    bad("dues", "chargeDue did not clamp or round");
  else ok("dues are Σ(amount − paid) and finite (including a ৳9-billion set), the status is derived, junk money reads 0, and an over-paid charge owes 0");
}

{
  const charge = { amount: 1000, paidAmount: 250 };
  const partial = F.acceptCollegePayment(charge, 250);
  const exact = F.acceptCollegePayment(charge, 750);
  const over = F.acceptCollegePayment(charge, 751);
  const wayOver = F.acceptCollegePayment({ amount: 100, paidAmount: 0 }, 100.01);
  const zero = F.acceptCollegePayment(charge, 0);
  const negative = F.acceptCollegePayment(charge, -5);
  const junk = F.acceptCollegePayment(charge, "x");
  const object = F.acceptCollegePayment(charge, { amount: 100 });
  const junkCharge = F.acceptCollegePayment(null, 10);
  const paidUp = F.acceptCollegePayment({ amount: 100, paidAmount: 100 }, 1);

  if (!partial.ok || partial.paidAmount !== 500 || partial.due !== 500 || partial.status !== "PARTIAL")
    bad("payments", `a partial payment gave ${JSON.stringify(partial)}`);
  else if (!exact.ok || exact.paidAmount !== 1000 || exact.due !== 0 || exact.status !== "PAID")
    bad("payments", `an exact payment gave ${JSON.stringify(exact)}`);
  else if (over.ok || !/exceeds/i.test(over.error)) bad("payments", `an over-payment was not refused by name: ${JSON.stringify(over)}`);
  else if (wayOver.ok) bad("payments", "a 0.01 over-payment on a ৳100 charge was accepted");
  else if (zero.ok || negative.ok || junk.ok) bad("payments", "a zero, negative or junk payment was accepted");
  else if (!object.ok || object.applied !== 100) bad("payments", "an { amount } payment was not read");
  else if (junkCharge.ok || paidUp.ok) bad("payments", "a payment was accepted on a charge with no amount or nothing left to pay");
  else if (!Number.isFinite(partial.due) || partial.due !== 500) bad("payments", "the returned due is not finite");
  else ok("a partial payment leaves PARTIAL, an exact one PAID, and an over-payment (even by ৳0.01), a zero/negative/junk payment, a paid-up charge and an amount-less charge are all refused");
}

/* ----------------------------------------------------------------------- 12 */

console.log("\n12. the ONE settings resolver — one config per tenant in v1 (D-6-18 pattern)");
{
  const stored = { channels: [{ id: "ch_1", label: "bKash" }, "junk", null], paymentNote: "Pay at the office", currency: "BDT" };
  const resolved = F.resolveCollegeFeeSettings({ stored });
  const otherProgramme = F.resolveCollegeFeeSettings({ stored, programId: "pg_other", termNumber: 7, schoolId: "s_other" });
  const defaults = F.resolveCollegeFeeSettings({});
  const junk = F.normalizeCollegeFeeConfig({ channels: "x", paymentNote: "n".repeat(900), currency: "   " });

  if (typeof F.resolveCollegeFeeSettings !== "function") bad("resolver", "resolveCollegeFeeSettings is not exported");
  else if (!sameDeep(resolved, otherProgramme)) bad("resolver", "the resolver changed with the programme/term — v1 is one config per tenant");
  else if (resolved.channels.length !== 1 || resolved.paymentNote !== "Pay at the office" || resolved.currency !== "BDT")
    bad("resolver", `the stored config was not normalised: ${JSON.stringify(resolved)}`);
  else if (!sameDeep(defaults, F.COLLEGE_FEE_CONFIG_DEFAULTS) || defaults.currency !== F.COLLEGE_FEE_CURRENCY_DEFAULT)
    bad("resolver", `no stored config did not give the shipped defaults: ${JSON.stringify(defaults)}`);
  else if (junk.channels.length !== 0 || junk.paymentNote.length !== 500 || junk.currency !== F.COLLEGE_FEE_CURRENCY_DEFAULT)
    bad("resolver", `a junk config was not normalised: ${JSON.stringify(junk)}`);
  else if (!sameDeep(F.resolveCollegeFeeSettings({ stored: { channels: [] } }).channels, []))
    bad("resolver", "an empty channel list did not survive");
  else ok("resolveCollegeFeeSettings is the one entry point, ignores the programme/term in v1, normalises channels/note/currency and falls back to the shipped defaults");
}

/* ----------------------------------------------------------------------- 13 */

console.log("\n13. purity — frozen inputs twice, nothing mutated, no store/HTTP surface");
{
  const heads = Object.freeze([Object.freeze({ id: "h_1", name: "Fee", frequency: "MONTHLY", active: true })]);
  const structure = Object.freeze([Object.freeze({ programId: "pg", termNumber: 1, headId: "h_1", amount: 100 })]);
  const registrations = Object.freeze([Object.freeze({ status: "APPROVED" })]);
  const awards = Object.freeze([Object.freeze({ id: "d_1", kind: "PERCENT", percent: 10, status: "APPROVED", approvedBy: "u" })]);
  const request = Object.freeze({
    studentId: "st_1",
    programId: "pg",
    termNumber: 1,
    programme: Object.freeze({ durationYears: 1, termSystem: "YEARLY" }),
    heads,
    structure,
    registrations,
  });

  let first = null;
  let second = null;
  let threw = null;
  try {
    first = F.deriveCollegeCharges(request);
    second = F.deriveCollegeCharges(request);
  } catch (e) {
    threw = e?.message || String(e);
  }
  const discounted = F.applyCollegeDiscounts(first ? first.charges : [], awards);
  const storeSurface = /\b(prisma|findMany|firestore|fetch|require)\b/.test(feesCode);

  if (threw) bad("purity", `a frozen input threw: ${threw}`);
  else if (!sameDeep(first, second)) bad("purity", "two identical derivations of a frozen input differed");
  else if (heads.length !== 1 || structure.length !== 1 || registrations[0].status !== "APPROVED" || heads[0].name !== "Fee")
    bad("purity", "the input rows were mutated");
  else if (discounted.rows.length !== first.charges.length || !Number.isFinite(discounted.netTotal))
    bad("purity", "the discount pass produced an unusable result");
  else if (storeSurface) bad("purity", "the module names a store/HTTP surface — it must stay pure");
  else ok("a frozen input derives twice to the same plan, nothing is mutated, and the module names no store/HTTP surface");
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ COLLEGE FEES LOGIC FAILED — ${failures} of ${checks} check(s) failed.`);
  process.exit(1);
}
console.log(
  `✅ COLLEGE FEES LOGIC OK — ${checks} check(s): heads and structure validate around the school's own buckets and cadences, ` +
    `the cadence decides the billing events, a charge set is derived from the enrolment plus APPROVED registrations with ` +
    `deterministic ids and a late-registration top-up, discounts are rounded in paisa and never over-discount, dues are finite ` +
    `with over-payment refused, and one resolver owns the tenant's settings.`
);
