#!/usr/bin/env node
/**
 * Phase 5a — the pure college promotion ladder, proved OFFLINE.
 *
 * `src/lib/college-promotion.ts` is the ONLY place that decides what a student's
 * position on a programme's ladder means. It writes nothing and reads nothing —
 * no prisma, no HTTP, no React — which is what lets this script pin it without a
 * database, a server or an emulator: it carries **no `requireEmulator()` guard**
 * and runs on plain `node`, the same design as `verify-college-terms.mjs`,
 * `verify-registration-status.mjs` and `verify-college-permissions.mjs`.
 *
 * The decisions it pins (docs/COLLEGE-DECISIONS.md §15):
 *
 *   1. DEPENDENCY-FREE. No `import`, no `require(` — the no-import property the
 *      sibling pure modules are held to, because it is what makes the module
 *      importable from the verifier, a client component and Edge code alike.
 *   2. ACTION INVENTORY. Exactly `advance` and `graduate`. **No `retain`** and no
 *      `already` action — D2 removed retain from Phase 5 entirely.
 *   3. NO MARKER / NO SESSION SURFACE. No exported name mentions a marker, a
 *      promotion marker field or a session — D2 (no marker field) and D9 (the
 *      ladder is independent of the academic session).
 *   4-8. THE TABLES. Term-normalisation, term-count normalisation, the last-term
 *      test, the action decision and the next-term arithmetic, each exhaustively
 *      over its valid and invalid inputs.
 *   9. STRICT COHORT. Both halves must match: `programId` AND `termNumber` (D3),
 *      and a student with no programme is never in the cohort (D4).
 *  10. WARNING AND INFO. A cohort member that also holds a `classId` is flagged
 *      but KEPT (D4); a pending-registration count is carried as info and never
 *      removes anybody (D6).
 *  11. THE PREVIEW. Rows, the advance/graduate tallies and the `graduating` flag
 *      for a mid-term run, a last-term run and a mixed cohort (D5), plus the
 *      unreachable-position rule (an unresolvable term count yields an empty
 *      preview rather than a guess).
 *  12. PURITY. Frozen input does not throw, a second call is deep-equal, the
 *      input is not mutated, and the module touches no registration or session
 *      (D7 registrations untouched; D9 no session dimension).
 *
 *   node scripts/verify-college-promotion-logic.mjs
 *
 * It is an OFFLINE script: it must be safe (and is expected) to run without the
 * emulator. It only READS two files from the repository.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension,
 * so this local, synchronous hook retries a failed relative specifier with `.ts`
 * appended — the same approach as verify-college-gate.mjs, scoped to this
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

const MODULE_URL = new URL("../src/lib/college-promotion.ts", import.meta.url);
const source = readFileSync(MODULE_URL, "utf8");

const {
  COLLEGE_PROMOTION_ACTIONS,
  isCollegePromotionAction,
  normalizeTermNumber,
  normalizeTermCount,
  normalizeCount,
  isLastCollegeTerm,
  collegePromotionActionFor,
  collegeNextTerm,
  inCollegeCohort,
  buildCollegePromotionRow,
  buildCollegePromotionPreview,
} = await import(MODULE_URL.href);

/**
 * Blank out comments and string literals, PRESERVING LENGTH, so a token search
 * runs against code only. The module documents D2/D9 in prose (it names
 * `promotionSessionId` and `sessionId` in its own comments), so scanning the raw
 * text would match the documentation instead of the surface.
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
const sameDeep = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const eq = (a, b) => a === b;

console.log("=== Phase 5a college promotion ladder (offline) ===");
console.log(`module: src/lib/college-promotion.ts (${source.split("\n").length} lines)`);

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. dependency-free — no import, no require() in the module");
{
  const importAt = code.search(/\bimport\b/);
  const requireAt = code.search(/\brequire\s*\(/);
  if (importAt >= 0) {
    bad("dependencies", `\`import\` appears at character ${importAt} — the module must stay dependency-free`);
  } else if (requireAt >= 0) {
    bad("dependencies", `\`require(\` appears at character ${requireAt} — the module must stay dependency-free`);
  } else {
    ok("no `import` and no `require(` — no prisma, no node:, no React, nothing to resolve");
  }
}

/* ------------------------------------------------------------------------ 2 */

console.log("\n2. action inventory — exactly advance | graduate, with no `retain`");
{
  const want = ["advance", "graduate"];
  const got = [...COLLEGE_PROMOTION_ACTIONS];
  const stray = got.filter((a) => !want.includes(a));
  const forbidden = got.filter((a) => /retain|repeat|already|skip/i.test(a));
  if (forbidden.length) {
    bad("actions", `the action list carries ${JSON.stringify(forbidden)} — D2 has no retain/repeat/already action`);
  } else if (!sameDeep(got, want)) {
    bad("actions", `COLLEGE_PROMOTION_ACTIONS = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
  } else if (got.some((a) => !isCollegePromotionAction(a)) || isCollegePromotionAction("retain")) {
    bad("actions", "isCollegePromotionAction disagrees with the exported list");
  } else {
    ok(`COLLEGE_PROMOTION_ACTIONS = ${JSON.stringify(got)}; isCollegePromotionAction("retain") === false`);
  }
}

/* ------------------------------------------------------------------------ 3 */

console.log("\n3. no marker and no session surface (D2, D9)");
{
  const exported = [];
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|var|interface|type|class)\s+([A-Za-z0-9_]+)/g)) {
    exported.push(m[1]);
  }
  const suspicious = exported.filter((n) => /session|marker|retain|repeat|promotionSession/i.test(n));
  if (!exported.length) {
    bad("surface", "no exported names were found — the scan is not reading the module");
  } else if (suspicious.length) {
    bad("surface", `exported name(s) ${JSON.stringify(suspicious)} suggest a marker or a session dimension`);
  } else {
    ok(`${exported.length} exported name(s), none mentioning a marker, a session or a retain action`);
  }
}

/* ------------------------------------------------------------------------ 4 */

console.log("\n4. normalizeTermNumber — a position is a whole number ≥ 1, nothing else");
{
  const cases = [
    [1, 1],
    [3, 3],
    [6, 6],
    [0, null],
    [-1, null],
    [1.5, null],
    ["2", null],
    [null, null],
    [undefined, null],
    [NaN, null],
    [Infinity, null],
    [true, null],
  ];
  let problem = null;
  for (const [input, want] of cases) {
    const got = normalizeTermNumber(input);
    if (!eq(got, want)) {
      problem = `normalizeTermNumber(${String(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      break;
    }
  }
  if (problem) bad("term", problem);
  else ok(`${cases.length} inputs: ${cases.filter(([, w]) => w === null).length} non-positions read null, every whole term survives`);
}

/* ------------------------------------------------------------------------ 5 */

console.log("\n5. normalizeTermCount — a whole number > 0, else 0 (never a guess)");
{
  const cases = [
    [1, 1],
    [3, 3],
    [6, 6],
    [0, 0],
    [-2, 0],
    [2.5, 0],
    ["3", 0],
    [null, 0],
    [undefined, 0],
    [NaN, 0],
  ];
  let problem = null;
  for (const [input, want] of cases) {
    const got = normalizeTermCount(input);
    if (!eq(got, want)) {
      problem = `normalizeTermCount(${String(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      break;
    }
  }
  // The display-only counter reads 0 for anything that is not a whole ≥ 0.
  for (const [input, want] of [[0, 0], [2, 2], [-1, 0], [1.5, 0], [undefined, 0]]) {
    if (problem) break;
    if (!eq(normalizeCount(input), want)) problem = `normalizeCount(${String(input)}) = ${normalizeCount(input)}, expected ${want}`;
  }
  if (problem) bad("count", problem);
  else ok(`${cases.length} inputs + 5 counter inputs: an unknown term count is 0, never a fabricated ladder`);
}

/* ------------------------------------------------------------------------ 6 */

console.log("\n6. isLastCollegeTerm — the last term is the programme's own count");
{
  const cases = [
    [3, 3, true],
    [2, 3, false],
    [1, 1, true],
    [1, 6, false],
    [4, 3, false],
    [1, 0, false],
  ];
  let problem = null;
  for (const [term, total, want] of cases) {
    const got = isLastCollegeTerm(term, total);
    if (got !== want) {
      problem = `isLastCollegeTerm(${term}, ${total}) = ${got}, expected ${want}`;
      break;
    }
  }
  if (problem) bad("last-term", problem);
  else ok(`${cases.length} cases: (n, n) is the last term and an unknown count (0) knows no last term`);
}

/* ------------------------------------------------------------------------ 7 */

console.log("\n7. collegePromotionActionFor — advance above, graduate at the end, null off-ladder");
{
  const cases = [
    [1, 3, "advance"],
    [2, 3, "advance"],
    [3, 3, "graduate"],
    [1, 1, "graduate"],
    [6, 6, "graduate"],
    [4, 3, null],
    [0, 3, null],
    [1, 0, null],
    [1.5, 3, null],
    [1, undefined, null],
    ["1", 3, null],
  ];
  let problem = null;
  for (const [term, total, want] of cases) {
    const got = collegePromotionActionFor(term, total);
    if (got !== want) {
      problem = `collegePromotionActionFor(${String(term)}, ${String(total)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      break;
    }
  }
  if (problem) bad("action", problem);
  else ok(`${cases.length} cases: a mid term advances, the last term graduates, a bad/past-the-end term is null`);
}

/* ------------------------------------------------------------------------ 8 */

console.log("\n8. collegeNextTerm — one step up, null for a non-position");
{
  const cases = [
    [1, 2],
    [6, 7],
    [0, null],
    [1.5, null],
    ["2", null],
    [undefined, null],
  ];
  let problem = null;
  for (const [input, want] of cases) {
    const got = collegeNextTerm(input);
    if (!eq(got, want)) {
      problem = `collegeNextTerm(${String(input)}) = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      break;
    }
  }
  if (problem) bad("next-term", problem);
  else ok(`${cases.length} cases: the destination is exactly one step up, and a bad term has none`);
}

/* ------------------------------------------------------------------------ 9 */

console.log("\n9. strict cohort — programId AND termNumber, and never a student with no programme (D3, D4)");
{
  const P = "prog-a";
  const cases = [
    [{ programId: P, termNumber: 2 }, P, 2, true],
    [{ programId: P, termNumber: 3 }, P, 2, false],
    [{ programId: P, termNumber: 1 }, P, 2, false],
    [{ programId: "prog-b", termNumber: 2 }, P, 2, false],
    [{ termNumber: 2 }, P, 2, false],
    [{ programId: P }, P, 2, false],
    [{ programId: "", termNumber: 2 }, P, 2, false],
    [{ programId: P, termNumber: 2 }, "", 2, false],
    [{ programId: P, termNumber: 0 }, P, 2, false],
    [{ programId: P, termNumber: 2 }, P, 0, false],
    [null, P, 2, false],
    [undefined, P, 2, false],
  ];
  let problem = null;
  for (const [student, programId, from, want] of cases) {
    const got = inCollegeCohort(student, programId, from);
    if (got !== want) {
      problem = `inCollegeCohort(${JSON.stringify(student)}, ${JSON.stringify(programId)}, ${JSON.stringify(from)}) = ${got}, expected ${want}`;
      break;
    }
  }
  // A term past the programme's end is not a reachable position, so no row exists.
  const offLadder = buildCollegePromotionRow({ id: "s", programId: P, termNumber: 4 }, P, 4, 3);
  if (problem) bad("cohort", problem);
  else if (offLadder !== null) bad("cohort", `a row was built at term 4 of a 3-term programme: ${JSON.stringify(offLadder)}`);
  else ok(`${cases.length} strict cases + an off-ladder position: a mismatch in either half (or no programme) is never in the cohort`);
}

/* ------------------------------------------------------------------------ 10 */

console.log("\n10. the classId warning and the info-only pending count (D4, D6)");
{
  const P = "prog-a";
  const flagged = buildCollegePromotionRow({ id: "s1", programId: P, termNumber: 1, classId: "c_1" }, P, 1, 3);
  const clean = buildCollegePromotionRow({ id: "s2", programId: P, termNumber: 1, classId: null }, P, 1, 3);
  const pending = buildCollegePromotionRow({ id: "s3", programId: P, termNumber: 1, pendingRegistrationCount: 2 }, P, 1, 3);
  let problem = null;
  if (!flagged || flagged.classIdWarning !== true) problem = "a cohort member holding a classId was not flagged";
  else if (!clean || clean.classIdWarning !== false) problem = "a member without a classId was flagged anyway";
  else if (!clean || clean.action !== "advance") problem = "the classId flag changed the action";
  else if (!pending) problem = "a student with a pending registration was dropped from the cohort (D6)";
  else if (pending.pendingRegistrationCount !== 2) problem = `pendingRegistrationCount = ${pending.pendingRegistrationCount}, expected 2`;
  if (problem) bad("warning", problem);
  else ok("a classId is flagged but KEPT (D4); a pending count is carried as info and never excludes (D6)");
}

/* ------------------------------------------------------------------------ 11 */

console.log("\n11. the preview — rows, tallies and the `graduating` flag (D5)");
{
  const P = "prog-a";
  const cohort = [
    { id: "s1", programId: P, termNumber: 1, classId: "c_1", pendingRegistrationCount: 2 },
    { id: "s2", programId: P, termNumber: 1, pendingRegistrationCount: 0 },
    { id: "s3", programId: "prog-b", termNumber: 1 },
    { id: "s4", termNumber: 1 },
  ];
  const mid = buildCollegePromotionPreview({ students: cohort, programId: P, fromTermNumber: 1, termCount: 3 });
  const last = buildCollegePromotionPreview({ students: cohort, programId: P, fromTermNumber: 3, termCount: 3 });
  const unreachable = buildCollegePromotionPreview({ students: cohort, programId: P, fromTermNumber: 4, termCount: 3 });
  const noCount = buildCollegePromotionPreview({ students: cohort, programId: P, fromTermNumber: 1, termCount: 0 });

  let problem = null;
  if (mid.count !== 2 || mid.counts.advance !== 2 || mid.counts.graduate !== 0)
    problem = `mid-term preview = ${JSON.stringify({ count: mid.count, counts: mid.counts })}, expected 2 advances and no graduate`;
  else if (mid.graduating !== false) problem = "a mid-term run reported itself as graduating";
  else if (mid.rows.some((r) => r.toTermNumber !== 2 || r.graduating)) problem = "a mid-term row did not point at term 2";
  else if (mid.counts.classIdWarnings !== 1) problem = `classIdWarnings = ${mid.counts.classIdWarnings}, expected 1`;
  else if (mid.counts.pendingRegistrations !== 2) problem = `pendingRegistrations = ${mid.counts.pendingRegistrations}, expected 2`;
  else if (last.count !== 0 || last.graduating !== true) problem = `last-term run = ${JSON.stringify({ count: last.count, graduating: last.graduating })} — expected an empty graduating run (the cohort sits at term 1)`;
  else if (unreachable.count !== 0 || unreachable.graduating !== false) problem = "an off-ladder position produced rows";
  else if (noCount.count !== 0) problem = "a missing term count produced rows";

  // A genuine last-term cohort graduates, with no destination term.
  const atLast = [
    { id: "g1", programId: P, termNumber: 3 },
    { id: "g2", programId: P, termNumber: 3 },
  ];
  const grad = buildCollegePromotionPreview({ students: atLast, programId: P, fromTermNumber: 3, termCount: 3 });
  if (!problem) {
    if (grad.count !== 2 || grad.counts.graduate !== 2 || grad.counts.advance !== 0 || grad.graduating !== true)
      problem = `last-term cohort = ${JSON.stringify({ count: grad.count, counts: grad.counts, graduating: grad.graduating })}`;
    else if (grad.rows.some((r) => r.action !== "graduate" || r.toTermNumber !== null || r.graduating !== true))
      problem = "a graduating row carried a destination term";
  }
  if (problem) bad("preview", problem);
  else
    ok(
      "a mid-term run advances with destination term 2; a last-term cohort graduates with no destination and a `graduating` run; " +
        "both non-cohort students and an unresolvable position yield nothing"
    );
}

/* ------------------------------------------------------------------------ 12 */

console.log("\n12. purity — no mutation, deterministic, and no registration or session surface (D7, D9)");
{
  const P = "prog-a";
  const input = [
    Object.freeze({ id: "s1", programId: P, termNumber: 1, classId: null, pendingRegistrationCount: 1 }),
    Object.freeze({ id: "s2", programId: P, termNumber: 1, classId: null, pendingRegistrationCount: 0 }),
  ];
  const frozen = Object.freeze(input.slice());
  const args = { students: frozen, programId: P, fromTermNumber: 1, termCount: 3 };

  let first = null;
  let second = null;
  let threw = null;
  try {
    first = buildCollegePromotionPreview(args);
    second = buildCollegePromotionPreview(args);
  } catch (e) {
    threw = e?.message || String(e);
  }

  const registrationSurface = /\b(courseRegistration|prisma|findMany|update|delete|create)\b/.test(code);
  const sessionSurface = /\b(sessionId|academicSession|currentSession)\b/.test(code);

  if (threw) bad("purity", `a frozen input threw: ${threw}`);
  else if (!sameDeep(first, second)) bad("purity", "two identical calls returned different previews");
  else if (input.length !== 2 || !input[0] || input[0].termNumber !== 1) bad("purity", "the input array or one of its students was mutated");
  else if (first.rows.some((r) => !("pendingRegistrationCount" in r))) bad("purity", "a row lost its informational pending count");
  else if (registrationSurface) bad("purity", "the module names a write/registration call — registrations must stay untouched (D7)");
  else if (sessionSurface) bad("purity", "the module names a session dimension — the ladder is session-independent (D9)");
  else ok("a frozen input is accepted twice with deep-equal output, nothing is mutated, and no registration/session surface exists");
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ COLLEGE PROMOTION LADDER FAILED — ${failures} of ${checks} check(s) failed.`);
  process.exit(1);
}
console.log(
  `✅ COLLEGE PROMOTION LADDER OK — ${checks} check(s): the pure ladder advances a term, graduates at the last one, ` +
    `selects a strict cohort, warns about a classId and consults nothing else.`
);
