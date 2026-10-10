#!/usr/bin/env node
/**
 * Phase 6b — the college RESULTS DATA LAYER, proved OFFLINE.
 *
 * `src/lib/db.ts` is the ONE place a collection is declared: `COLS` (model →
 * collection), `RELS` (model → relations) and the `prisma` shim (the accessors
 * every route uses). Phase 6b registers the college result row there —
 * `courseResult` → `courseResults`, per docs/COLLEGE-DECISIONS.md §23 D-6-17 —
 * and nothing else. This script pins that registration and, above all, proves it
 * is **purely additive**: the school spine and every pre-existing collection must
 * be byte-identical.
 *
 * Like `verify-college-terms.mjs` and `verify-college-gate.mjs`, it runs on plain
 * `node` with no database, no server and no network — it carries **no
 * `requireEmulator()` guard**. It only READS four files from the repository
 * (`db.ts` as text, because `db.ts` imports firebase-admin; plus the two guard
 * files and the segment list, which are dependency-free and imported directly).
 *
 * The decisions it pins:
 *
 *   1. THE COLLECTION. `COLS.courseResult === "courseResults"`, used exactly once
 *      — a college result never lands in the school `marks` collection.
 *   2. ADDITIVE ONLY. Removing the `courseResult` entries from the three maps
 *      reproduces the recorded pre-6b checksums exactly, so no other collection,
 *      relation or accessor was added, renamed or removed. This is the strongest
 *      form of "existing behaviour byte-identical" a text check can make.
 *   3. THE RELATIONS. `RELS.courseResult` names `school`/`branch`/`student`/
 *      `course`/`program` with the STORED foreign keys the store cannot join on,
 *      and every target is itself a registered model.
 *   4. THE RANDOM-ID DECISION. There is NO `idFor`/`idForCreate` entry for the
 *      model: the row gets a random id, and the
 *      `(studentId, courseId, termNumber, attempt)` uniqueness stays a rule the
 *      6c route enforces with a visible refusal, not a silent id overwrite.
 *   5. THE SCHOOL SPINE IS UNTOUCHED. `examMark` still maps to `marks`, `marks` is
 *      still used by exactly one model, and the school-critical mappings are
 *      unchanged.
 *   6. NO API YET. 6b builds no route: nothing under `src/app/api` names
 *      `prisma.courseResult`.
 *   7. THE SEGMENT IS DEFERRED, DELIBERATELY. `verify-college-routes.mjs` check 1
 *      fails a LISTED college segment that has no directory ("a stale list"), so
 *      `course-results` is added in the same change that creates its directory
 *      (6c) — the guard stays strict at 3/0 instead of being weakened.
 *   8. THE GUARD COVERS THE NEW MODEL. `verify-college-routes.mjs`'s
 *      `COLLEGE_MODEL_RE` includes `courseResult`, so a non-college route touching
 *      college results fails check 3 from the moment the model exists.
 *   9. THE SEGMENT LIST IS THE SINGLE SOURCE OF TRUTH and stays dependency-free.
 *
 *   node scripts/verify-college-results-data.mjs
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const dbText = readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8");
const guardText = readFileSync(new URL("./verify-college-routes.mjs", import.meta.url), "utf8");
const segmentsText = readFileSync(new URL("../src/lib/college-routes.ts", import.meta.url), "utf8");
const segments = await import(new URL("../src/lib/college-routes.ts", import.meta.url).href);

const sha1 = (s) => createHash("sha1").update(s).digest("hex");

/**
 * The pre-6b baseline, captured from `git show HEAD:src/lib/db.ts` at the moment
 * 6b landed (HEAD was 8354ca1). Each is a sha1 of the sorted entry list from the
 * corresponding map. A phase that adds a model must update these deliberately —
 * which is the point: an accidental rename or removal cannot slip through.
 */
const PRE_6B = {
  cols: "cef608da74b38e37425be4205ef97a88b7ca3381",
  relKeys: "c73228480470d3780c788ac90062a1fa577c2f32",
  accessors: "67ccce4cf572e04c7cef21329f062c1f70fc606e",
};

/** Blank out comments and string literals, PRESERVING LENGTH, so a scan sees code only. */
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

/** The text between a start marker and the next top-level `\n};` (an object literal). */
function block(text, startRe) {
  const m = startRe.exec(text);
  if (!m) return null;
  const from = m.index + m[0].length;
  const end = text.indexOf("\n};", from);
  return end === -1 ? text.slice(from) : text.slice(from, end);
}

/**
 * The text of a `function …` body, up to its own closing `\n}` at column 0.
 * (A plain `block()` would run on to the next `};` and pick up unrelated code.)
 */
function fnBlock(text, startRe) {
  const m = startRe.exec(text);
  if (!m) return null;
  const from = m.index + m[0].length;
  const end = text.indexOf("\n}", from);
  return end === -1 ? text.slice(from) : text.slice(from, end);
}

const colsText = block(dbText, /const COLS: Record<string, string> = \{/);
const relsText = block(dbText, /const RELS: Record<string, Record<string, Rel>> = \{/);
const prismaText = block(dbText, /export const prisma = \{/);
// Masked, so a comment that merely NAMES the model cannot masquerade as a
// derived-id entry.
const idForText = maskCommentsAndStrings(fnBlock(dbText, /function idFor\(model: string, where: Record<string, any>\): string \| undefined \{/) || "");
const idForCreateText = maskCommentsAndStrings(fnBlock(dbText, /function idForCreate\(model: string, data: Record<string, any>\): string \| undefined \{/) || "");

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
const eq = (a, b) => a === b;
const countOf = (haystack, needle) => haystack.split(needle).length - 1;

console.log("=== Phase 6b college results data layer (offline) ===");
console.log(`store: src/lib/db.ts (${dbText.split("\n").length} lines)`);

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. the collection — courseResult maps to courseResults, exactly once");
{
  if (!colsText) bad("collection", "the COLS block could not be located in db.ts");
  else if (!/^\s*courseResult:\s*"courseResults",\s*$/m.test(colsText))
    bad("collection", 'COLS has no `courseResult: "courseResults",` entry');
  else if (countOf(colsText, '"courseResults"') !== 1)
    bad("collection", `the name "courseResults" is used ${countOf(colsText, '"courseResults"')} time(s) in COLS — expected exactly 1`);
  else ok('COLS.courseResult === "courseResults", and no second model shares that collection');
}

/* ------------------------------------------------------------------------ 2 */

console.log("\n2. additive only — every pre-6b collection, relation key and accessor is byte-identical");
{
  const pairs = [...colsText.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`).sort();
  const relKeys = [...relsText.matchAll(/^  (\w+):/gm)].map((m) => m[1]).sort();
  const accessors = [...prismaText.matchAll(/^  (\w+): model\("/gm)].map((m) => m[1]).sort();

  const head = {
    cols: sha1(pairs.filter((p) => !p.startsWith("courseResult=")).join("\n")),
    relKeys: sha1(relKeys.filter((k) => k !== "courseResult").join("\n")),
    accessors: sha1(accessors.filter((a) => a !== "courseResult").join("\n")),
  };

  const wrong = Object.keys(PRE_6B).find((k) => head[k] !== PRE_6B[k]);
  if (wrong) {
    bad(
      "additive",
      `the ${wrong} map differs from the pre-6b baseline beyond courseResult ` +
        `(computed ${head[wrong]}, recorded ${PRE_6B[wrong]})`
    );
  } else if (!pairs.includes("courseResult=courseResults")) {
    bad("additive", "courseResult is missing from the COLS map");
  } else if (!relKeys.includes("courseResult")) {
    bad("additive", "courseResult is missing from the RELS keys");
  } else if (!accessors.includes("courseResult")) {
    bad("additive", "the prisma shim has no courseResult accessor");
  } else {
    ok(
      `COLS ${pairs.length} entries, RELS ${relKeys.length} models, prisma ${accessors.length} accessors — removing courseResult reproduces all three recorded baselines, so nothing else moved`
    );
  }
}

/* ------------------------------------------------------------------------ 3 */

console.log("\n3. the relations — courseResult names the five STORED foreign keys, and every target exists");
{
  const m = /^  courseResult: \{([\s\S]*?)^  \},$/m.exec(relsText);
  if (!m) bad("relations", "RELS has no courseResult block");
  else {
    const body = m[1];
    const got = [...body.matchAll(/(\w+): \{ to: "(\w+)", fk: "(\w+)", kind: "one" \}/g)].map((x) => `${x[1]}->${x[2]}:${x[3]}`);
    const want = [
      "school->school:schoolId",
      "branch->branch:branchId",
      "student->student:studentId",
      "course->course:courseId",
      "program->program:programId",
    ];
    const accessors = new Set([...prismaText.matchAll(/^  (\w+): model\("/gm)].map((x) => x[1]));
    const unknown = got.map((g) => g.split("->")[1].split(":")[0]).filter((t) => !accessors.has(t));
    if (got.length !== want.length || want.some((w) => !got.includes(w)))
      bad("relations", `RELS.courseResult = ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`);
    else if (unknown.length) bad("relations", `a relation targets an unregistered model: ${JSON.stringify(unknown)}`);
    else ok(`RELS.courseResult = ${got.length} relations (school, branch, student, course, program) with stored fks, every target a registered model`);
  }
}

/* ------------------------------------------------------------------------ 4 */

console.log("\n4. the id policy — a random id, so uniqueness stays a 6c rule with a visible refusal");
{
  const inIdFor = /courseResult/.test(idForText || "");
  const inIdForCreate = /courseResult/.test(idForCreateText || "");
  if (idForText.length < 20 || idForCreateText.length < 20) bad("id", "the idFor/idForCreate functions could not be located");
  else if (inIdFor || inIdForCreate)
    bad("id", "courseResult has a derived-id entry — a duplicate attempt would then overwrite silently instead of being refused");
  else ok("no derive-id entry for courseResult: the row gets a random id and (studentId, courseId, termNumber, attempt) stays an enforced refusal");
}

/* ------------------------------------------------------------------------ 5 */

console.log("\n5. the school spine is untouched — marks is still the school's own collection");
{
  const marksPairs = [...colsText.matchAll(/(\w+):\s*"marks"/g)].map((m) => m[1]);
  const required = [
    ["examMark", "marks"],
    ["attendance", "attendance"],
    ["student", "students"],
    ["subject", "subjects"],
    ["exam", "exams"],
  ];
  const missing = required.filter(([k, v]) => !new RegExp(`^\\s*${k}:\\s*"${v}",\\s*$`, "m").test(colsText));
  if (missing.length) bad("school-spine", `a school-critical mapping is missing or renamed: ${JSON.stringify(missing)}`);
  else if (marksPairs.length !== 1 || marksPairs[0] !== "examMark")
    bad("school-spine", `the "marks" collection is mapped by ${JSON.stringify(marksPairs)} — expected only examMark`);
  else ok('examMark still maps to "marks" (the only model that does), and attendance/students/subjects/exams are unchanged');
}

/* ------------------------------------------------------------------------ 6 */

console.log("\n6. no API yet — nothing under src/app/api reaches the new model");
{
  const apiDir = fileURLToPath(new URL("../src/app/api", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        if (/\bprisma\.courseResult\b/.test(maskCommentsAndStrings(readFileSync(full, "utf8")))) offenders.push(full);
      }
    }
  };
  if (existsSync(apiDir)) walk(apiDir);
  if (offenders.length) bad("no-api", `6b builds no route, but ${offenders.join(", ")} names prisma.courseResult`);
  else ok("no route file under src/app/api names prisma.courseResult — the model is registered but unreachable until 6c");
}

/* ------------------------------------------------------------------------ 7 */

console.log("\n7. the segment is deferred to 6c, deliberately — the guard's stale-list rule forbids listing it early");
{
  const listed = [...segments.COLLEGE_API_SEGMENTS];
  const dirExists = existsSync(fileURLToPath(new URL("../src/app/api/course-results", import.meta.url)));
  const guardPinsStale = /a listed segment with no directory|stale/i.test(guardText) || /staleSegments/.test(guardText);
  if (!guardPinsStale) bad("segment", "the guard no longer pins the stale-list rule — re-check the 6b deferral");
  else if (listed.includes("course-results"))
    bad("segment", 'COLLEGE_API_SEGMENTS lists "course-results" while src/app/api/course-results does not exist — verify-college-routes check 1 would fail');
  else if (dirExists)
    bad("segment", "the directory src/app/api/course-results exists but the segment is not listed — check 1 would fail the other way");
  else ok('not listed and no directory: the segment lands in 6c together with src/app/api/course-results, so check 1 stays green (guarded by the recorded rule)');
}

/* ------------------------------------------------------------------------ 8 */

console.log("\n8. the guard covers the new model, and the segment list stays the one source of truth");
{
  const covers = /COLLEGE_MODEL_RE = \/\\bprisma\\\.\(([^)]*)\)/.exec(guardText);
  const names = covers ? covers[1].split("|").map((s) => s.trim()) : [];
  const importFree = !/\bimport\b/.test(maskCommentsAndStrings(segmentsText)) && !/\brequire\s*\(/.test(maskCommentsAndStrings(segmentsText));
  if (!covers) bad("guard", "COLLEGE_MODEL_RE could not be read from verify-college-routes.mjs");
  else if (!names.includes("courseResult"))
    bad("guard", `COLLEGE_MODEL_RE does not cover courseResult: ${JSON.stringify(names)}`);
  else if (!["department", "program", "programCourse", "course"].every((n) => names.includes(n)))
    bad("guard", `COLLEGE_MODEL_RE lost a pre-existing model: ${JSON.stringify(names)}`);
  else if (!importFree) bad("guard", "college-routes.ts gained an import — it must stay dependency-free");
  else if (!Array.isArray(segments.COLLEGE_API_SEGMENTS) || segments.COLLEGE_API_SEGMENTS.some((s) => typeof s !== "string"))
    bad("guard", "COLLEGE_API_SEGMENTS is not a list of strings");
  else ok(`COLLEGE_MODEL_RE covers ${names.length} models including courseResult; college-routes.ts is dependency-free with ${segments.COLLEGE_API_SEGMENTS.length} segments`);
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ COLLEGE RESULTS DATA LAYER FAILED — ${failures} of ${checks} check(s) failed.`);
  process.exit(1);
}
console.log(
  `✅ COLLEGE RESULTS DATA LAYER OK — ${checks} check(s): courseResults is registered in COLS/RELS/prisma as a purely ` +
    `additive change (the three pre-6b baselines still reproduce), the school marks spine is untouched, the row takes a ` +
    `random id, the guard covers the new model, and the API segment waits for its directory in 6c.`
);
