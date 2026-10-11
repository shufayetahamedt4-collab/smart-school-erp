#!/usr/bin/env node
/**
 * Phase 7b — the college FEE DATA LAYER, proved OFFLINE.
 *
 * `src/lib/db.ts` is the ONE place a collection is declared: `COLS` (model →
 * collection), `RELS` (model → relations) and the `prisma` shim (the accessors
 * every route uses). Phase 7b registers the four rows of the college fee spine
 * there — `collegeFeeHead`, `collegeFeeStructure`, `collegeFee` and
 * `collegeFeeConfig`, per docs/COLLEGE-DECISIONS.md §24 — and nothing else. This
 * script pins that registration and, above all, proves it is **purely additive**:
 * every pre-existing collection, relation key, relation BODY and accessor must be
 * byte-identical, which is a stronger statement than 6b's key-level proof.
 *
 * Like `verify-college-terms.mjs`, `verify-college-gate.mjs` and
 * `verify-college-results-data.mjs`, it runs on plain `node` with no database, no
 * server and no network — it carries **no `requireEmulator()` guard**. `db.ts` is
 * read as TEXT (it imports firebase-admin); `college-routes.ts` and
 * `college-fees.ts` are dependency-free and imported directly.
 *
 * The decisions it pins:
 *
 *   1. THE COLLECTIONS. `COLS` maps the four models §24 names to the four
 *      collections the repository's own model → collection convention produces
 *      (`feeCategory` → `feeCategories`, `courseResult` → `courseResults`):
 *      `collegeFeeHeads`, `collegeFeeStructures`, `collegeFees`,
 *      `collegeFeeConfigs`. Each name is used once and all four are distinct.
 *   2. ADDITIVE ONLY. Dropping the four entries reproduces the recorded pre-7b
 *      checksums of the COLS entry list, the RELS key list, EVERY pre-existing
 *      RELS body and the prisma accessor list — so nothing else moved: no school
 *      collection added, renamed, removed or edited.
 *   3. THE RELATIONS. Each row names the STORED foreign keys the store cannot
 *      join on, and every target is itself a registered model. The config is
 *      school-scoped and carries no branch (D-7-3 gives the channels one
 *      tenant-wide row); head/structure/charge carry the branch they inherit.
 *   4. NO DERIVED ID. There is NO `idFor`/`idForCreate` entry for any of the four,
 *      so (programId, termNumber, headId) for a structure row and the `cf_…`
 *      charge id 7a derives stay rules the 7c routes enforce with a VISIBLE
 *      refusal instead of a silent overwrite. The college id space (`cf_…`) is
 *      provably not the school fee id space (`fee_…`).
 *   5. THE SCHOOL FEE SPINE IS UNTOUCHED. `fee` → `fees`, `feeSetting` →
 *      `feeSettings`, `feeCategory` → `feeCategories`, `feeTemplate` →
 *      `feeTemplates` and `discount` → `discounts` still map where they did, the
 *      four new collections are none of them, and no entry has a `mode` field.
 *   6. NO SCHOOL FEE SURFACE NAMES A COLLEGE FEE MODEL. Every school fee route,
 *      lib, page, print page and the school-fee verifier is scanned: none may
 *      mention a college fee model or collection (the Q3 condition, checkable at
 *      build time). Check 3 of `verify-college-routes.mjs` covers the API
 *      directories; this check extends the same rule to libs, pages, print pages
 *      and scripts.
 *   7. THE MODEL IS REACHABLE ONLY FROM A LISTED COLLEGE SEGMENT. 7b builds no
 *      route, so no route may reach the models yet; when 7c adds the API it must
 *      live inside a LISTED college segment (check 3 keeps it there).
 *   8. THE SEGMENT LANDS WITH ITS DIRECTORY (7c). `COLLEGE_API_SEGMENTS` holds
 *      the six pre-7b segments plus `college-fees`, and `src/app/api/college-fees`
 *      exists — both added in the one change that created the directory (§8 D-A).
 *      A listed segment with no directory (or the reverse) still fails here.
 *   9. THE GUARD COVERS THE NEW MODELS. `verify-college-routes.mjs`'s
 *      `COLLEGE_MODEL_RE` includes all four — and 7c's `collegeDiscount`
 *      (a strengthening: no allowlist, no relaxed check) — and `college-routes.ts`
 *      stays dependency-free.
 *
 * TWO DELIBERATE RE-SCOPES, both documented here because both are additions that
 * must not read as regressions:
 *
 *   - **7c's `collegeDiscount` joins the dropped set** in check 2's baseline
 *     comparison, exactly as 7b's four models were dropped from 6b's verifier. Only
 *     those NAMES are dropped: `courseResult` — the entry 6b owns — and every other
 *     pre-existing COLS/RELS/prisma entry stay INSIDE the shared projections, so
 *     `verify-college-fees-data`'s pre-7b proof still covers them and no coverage
 *     is lost.
 *   - **`src/lib/ledger.ts` is exempt from the check-6 college-model scan for ONE
 *     function.** D-7-12 BINDS the college payment helper (`confirmCollegePayment`)
 *     into the SHARED ledger module, so the file necessarily names `prisma.collegeFee`.
 *     The exemption is not a skip: every college fee reference in the file must sit
 *     at or after that function's declaration, so the school's own writers and
 *     readers (`postToLedger`, `confirmPayment`, `applyLateFees`, `ledgerForStudent`,
 *     `ledgerForSchool`) still fail the check if one ever names a college row.
 *
 *   node scripts/verify-college-fees-data.mjs
 */

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const dbText = readFileSync(new URL("../src/lib/db.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const guardText = readFileSync(new URL("./verify-college-routes.mjs", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const segmentsText = readFileSync(new URL("../src/lib/college-routes.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const segments = await import(new URL("../src/lib/college-routes.ts", import.meta.url).href);
const fees = await import(new URL("../src/lib/college-fees.ts", import.meta.url).href);

const sha1 = (s) => createHash("sha1").update(s).digest("hex");

/**
 * The pre-7b baselines, captured from `src/lib/db.ts` at e492a6d (7a) the moment
 * before 7b's edits. Each is a sha1 over a normalised, sorted projection:
 *
 *   cols       `model=collection` for every COLS entry
 *   relKeys    every RELS model key
 *   relBodies  `key|<body>` for EVERY RELS entry - single-line bodies such as
 *              `setting: {}` and `twoFactor: { ... }` included - so an EDIT inside
 *              a pre-existing body cannot slip through a key-level proof
 *   accessors  every prisma accessor name
 *
 * A later phase that adds a model must update these deliberately — which is the
 * point: an accidental rename, removal or edit cannot pass unnoticed.
 */
const PRE_7B = {
  cols: "cbbea9d2380235e4ae5e4a2ec3f2daacfb83101b",
  relKeys: "c33c52e419dcd3fefa6757633adb61971db0c847",
  relBodies: "293f859af0de6248d63332072411e5391b89d441",
  accessors: "cc72672dd256867edc81145ea9b04b56fc31fc0e",
};

const NEW_MODELS = ["collegeFeeHead", "collegeFeeStructure", "collegeFee", "collegeFeeConfig"];

/**
 * The models registered by a phase AFTER 7b: 7c's `collegeDiscount` (the D-7-13
 * award row). It is dropped alongside 7b's own four before the pre-7b baseline
 * comparison — the same deliberate re-scope 7b applied to 6b's verifier — and
 * ONLY its name is dropped, so `courseResult` and every other pre-existing entry
 * remain inside the hashed projections.
 */
const LATER_MODELS = ["collegeDiscount"];

/** Any college fee model reached through the shim — check 6's needle. */
const COLLEGE_REF_RE = /\bprisma\.college(?:Fee(?:Head|Structure|Config)?|Discount)\b/g;

/** The ONE shared-ledger file, and the ONE function D-7-12 mandates in it. */
const LEDGER_FILE = "src/lib/ledger.ts";
const LEDGER_COLLEGE_MARKER = "export async function confirmCollegePayment(";
const WANT_COLS = {
  collegeFeeHead: "collegeFeeHeads",
  collegeFeeStructure: "collegeFeeStructures",
  collegeFee: "collegeFees",
  collegeFeeConfig: "collegeFeeConfigs",
};
const SCHOOL_FEE_COLLECTIONS = ["fees", "feeSettings", "feeCategories", "feeTemplates", "discounts"];
const PRE_7B_SEGMENTS = [
  "departments",
  "programs",
  "courses",
  "course-registrations",
  "college-promotion",
  "course-results",
];

/** The text between a start marker and the next top-level `\n};` (an object literal). */
function block(text, startRe) {
  const m = startRe.exec(text);
  if (!m) return null;
  const from = m.index + m[0].length;
  const end = text.indexOf("\n};", from);
  return end === -1 ? text.slice(from) : text.slice(from, end);
}

/** The text of a `function …` body, up to its own closing `\n}` at column 0. */
function fnBlock(text, startRe) {
  const m = startRe.exec(text);
  if (!m) return null;
  const from = m.index + m[0].length;
  const end = text.indexOf("\n}", from);
  return end === -1 ? text.slice(from) : text.slice(from, end);
}

/**
 * Blank out COMMENT text only (strings kept), PRESERVING LENGTH.
 *
 * Used for the idFor/idForCreate bodies: an entry there is written as
 * `model === "collegeFee"`, so it lives inside a string literal — masking strings
 * (as `maskCommentsAndStrings` does) would hide exactly the thing this check
 * exists to find. Comments are still blanked, so a comment that merely NAMES a
 * model cannot masquerade as a derived-id entry.
 */
function stripComments(text) {
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
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i += 1;
        i += 1;
      }
      i += 1;
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/** Blank out comments and string literals, PRESERVING LENGTH, so a scan sees code only. */
function maskCommentsAndStrings(text) {
  const out = text.split("");
  const LF = "\n";
  const blank = (i) => {
    if (out[i] !== LF) out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== LF) blank(i++);
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

/** Normalise a block for hashing: trim each line, collapse inner space runs. */
function norm(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length)
    .join("\n");
}

/**
 * Every RELS entry, keyed by its key - SINGLE-LINE bodies included.
 *
 * A key-level proof alone would miss an EDIT inside a pre-existing body, and a
 * multi-line-only body proof would miss `twoFactor: { ... }` / `setting: {}`
 * (which are written on one line). So both shapes are captured: a `  key: { ... },`
 * line is its own body, and a `  key: {` line accumulates its inner lines up to
 * the `  },` that closes it at the same indentation.
 */
function relEntries(text) {
  const lines = text.split("\n");
  const found = {};
  for (let i = 0; i < lines.length; i += 1) {
    const m = /^ {2}(\w+): \{(.*)$/.exec(lines[i]);
    if (!m) continue;
    const rest = m[2];
    if (rest.trimEnd().endsWith("},") || rest.trimEnd().endsWith("}")) {
      found[m[1]] = rest;
      continue;
    }
    const body = [rest];
    let j = i + 1;
    while (j < lines.length && !/^ {2}\},?\s*$/.test(lines[j])) {
      body.push(lines[j]);
      j += 1;
    }
    found[m[1]] = body.join("\n");
    i = j;
  }
  return found;
}

/**
 * The four projections, from ONE db.ts text. `--baseline <path>` prints them for
 * an arbitrary file (how PRE_7B was recorded from the 7a commit), so the recorded
 * values and the checked values come from the SAME code path.
 */
function project(text) {
  const colsText = block(text, /const COLS: Record<string, string> = \{/);
  const relsText = block(text, /const RELS: Record<string, Record<string, Rel>> = \{/);
  const prismaText = block(text, /export const prisma = \{/);
  const bodies = relsText ? relEntries(relsText) : {};
  // Comments stripped, strings KEPT - see `stripComments`.
  const idForText = stripComments(
    fnBlock(text, /function idFor\(model: string, where: Record<string, any>\): string \| undefined \{/) || ""
  );
  const idForCreateText = stripComments(
    fnBlock(text, /function idForCreate\(model: string, data: Record<string, any>\): string \| undefined \{/) || ""
  );
  const pairs = colsText ? [...colsText.matchAll(/(\w+):\s*"([^"]+)"/g)].map((m) => `${m[1]}=${m[2]}`).sort() : [];
  const relKeys = Object.keys(bodies).sort();
  const accessors = prismaText ? [...prismaText.matchAll(/^ {2}(\w+): model\("/gm)].map((m) => m[1]).sort() : [];
  return { colsText, relsText, prismaText, bodies, idForText, idForCreateText, pairs, relKeys, accessors };
}

const projected = project(dbText);
const { colsText, relsText, prismaText, bodies, idForText, idForCreateText, pairs, relKeys, accessors } = projected;

/** `node scripts/verify-college-fees-data.mjs --baseline <db.ts>` - print the four hashes. */
const baselineArg = process.argv.indexOf("--baseline");
if (baselineArg !== -1) {
  const p = project(readFileSync(process.argv[baselineArg + 1], "utf8").replace(/\r\n/g, "\n"));
  console.log(
    JSON.stringify(
      {
        cols: sha1(p.pairs.join("\n")),
        relKeys: sha1(p.relKeys.join("\n")),
        relBodies: sha1(p.relKeys.map((k) => `${k}|${norm(p.bodies[k])}`).join("\n")),
        accessors: sha1(p.accessors.join("\n")),
      },
      null,
      2
    )
  );
  process.exit(0);
}

function hashesWithout(drop) {
  const dropSet = new Set(drop);
  const bodyKeys = Object.keys(bodies).filter((k) => !dropSet.has(k)).sort();
  return {
    cols: sha1(pairs.filter((p) => !dropSet.has(p.split("=")[0])).join("\n")),
    relKeys: sha1(relKeys.filter((k) => !dropSet.has(k)).join("\n")),
    relBodies: sha1(bodyKeys.map((k) => `${k}|${norm(bodies[k])}`).join("\n")),
    accessors: sha1(accessors.filter((a) => !dropSet.has(a)).join("\n")),
  };
}

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
const countOf = (haystack, needle) => haystack.split(needle).length - 1;
const relBlock = (model) => {
  const m = new RegExp(`^ {2}${model}: \\{\\n([\\s\\S]*?)^ {2}\\},$`, "m").exec(relsText || "");
  return m ? m[1] : null;
};

console.log("=== Phase 7b college fee data layer (offline) ===");
console.log(`store: src/lib/db.ts (${dbText.split("\n").length} lines)`);

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. the collections — the four §24 models map to four distinct new collections");
{
  const wrong = NEW_MODELS.filter((m) => !new RegExp(`^\\s*${m}:\\s*"${WANT_COLS[m]}",\\s*$`, "m").test(colsText || ""));
  const dupes = NEW_MODELS.filter((m) => countOf(colsText || "", `"${WANT_COLS[m]}"`) !== 1);
  const values = NEW_MODELS.map((m) => WANT_COLS[m]);
  const collisions = SCHOOL_FEE_COLLECTIONS.filter((c) => values.includes(c));
  if (!colsText) bad("collections", "the COLS block could not be located in db.ts");
  else if (wrong.length)
    bad("collections", `COLS is missing or mis-maps: ${JSON.stringify(wrong.map((m) => `${m} -> ${WANT_COLS[m]}`))}`);
  else if (dupes.length) bad("collections", `a name is used more than once in COLS: ${JSON.stringify(dupes)}`);
  else if (new Set(values).size !== values.length) bad("collections", "two of the four models share one collection");
  else if (collisions.length) bad("collections", `a college fee row shares a school fee collection: ${JSON.stringify(collisions)}`);
  else
    ok(
      `COLS maps collegeFeeHead/collegeFeeStructure/collegeFee/collegeFeeConfig to ${values.join(", ")} — once each, and none is a school fee collection`
    );
}

/* ------------------------------------------------------------------------ 2 */

console.log("\n2. additive only — dropping the four entries reproduces every pre-7b checksum");
{
  const head = hashesWithout([...NEW_MODELS, ...LATER_MODELS]);
  const wrong = Object.keys(PRE_7B).find((k) => head[k] !== PRE_7B[k]);
  const missing = NEW_MODELS.filter(
    (m) => !pairs.includes(`${m}=${WANT_COLS[m]}`) || !relKeys.includes(m) || !accessors.includes(m)
  );
  if (wrong) {
    bad(
      "additive",
      `the ${wrong} projection differs from the recorded pre-7b baseline beyond the ${NEW_MODELS.length + LATER_MODELS.length} later-phase models ` +
        `(computed ${head[wrong]}, recorded ${PRE_7B[wrong]}) — an existing entry was added, renamed, removed or edited`
    );
  } else if (missing.length) bad("additive", `a new model is missing from one of the three maps: ${JSON.stringify(missing)}`);
  else
    ok(
      `COLS ${pairs.length} entries, RELS ${relKeys.length} models (${Object.keys(bodies).length} bodies), ` +
        `prisma ${accessors.length} accessors — dropping the ${NEW_MODELS.length} 7b models and 7c's ${LATER_MODELS.length} reproduces all four recorded baselines, so no existing entry moved (bodies included), courseResult included`
    );
}

/* ------------------------------------------------------------------------ 3 */

console.log("\n3. the relations — the STORED foreign keys, and every target a registered model");
{
  const want = {
    collegeFeeHead: ["school->school:schoolId", "branch->branch:branchId"],
    collegeFeeStructure: [
      "school->school:schoolId",
      "branch->branch:branchId",
      "program->program:programId",
      "head->collegeFeeHead:headId",
    ],
    collegeFee: [
      "school->school:schoolId",
      "branch->branch:branchId",
      "student->student:studentId",
      "program->program:programId",
      "head->collegeFeeHead:headId",
    ],
    collegeFeeConfig: ["school->school:schoolId"],
  };
  const accessorSet = new Set(accessors);
  let problem = null;
  for (const model of NEW_MODELS) {
    const body = relBlock(model);
    if (!body) {
      problem = `RELS has no ${model} block`;
      break;
    }
    const got = [...body.matchAll(/(\w+): \{ to: "(\w+)", fk: "(\w+)", kind: "one" \}/g)].map(
      (x) => `${x[1]}->${x[2]}:${x[3]}`
    );
    if (got.length !== want[model].length || want[model].some((w) => !got.includes(w))) {
      problem = `RELS.${model} = ${JSON.stringify(got)}, expected ${JSON.stringify(want[model])}`;
      break;
    }
    const unknown = got.map((g) => g.split("->")[1].split(":")[0]).filter((t) => !accessorSet.has(t));
    if (unknown.length) {
      problem = `${model} targets an unregistered model: ${JSON.stringify(unknown)}`;
      break;
    }
  }
  if (problem) bad("relations", problem);
  else
    ok(
      `${NEW_MODELS.length} RELS blocks, 9 relations: every fk a STORED field, every target a registered model, and the config school-scoped (D-7-3)`
    );
}

/* ------------------------------------------------------------------------ 4 */

console.log("\n4. no derived id — the uniqueness stays a 7c refusal, and the id space is not the school's");
{
  const derived = NEW_MODELS.filter(
    (m) => new RegExp(`\\b${m}\\b`).test(idForText) || new RegExp(`\\b${m}\\b`).test(idForCreateText)
  );
  const collegeId = fees.collegeChargeId("st_1", "h_1", 1, 1);
  const schoolIdTemplate = /fee_\$\{[^}]+\}/.test(dbText) && /export function generatedFeeId\(/.test(dbText);
  if (idForText.length < 20 || idForCreateText.length < 20) bad("id", "the idFor/idForCreate functions could not be located");
  else if (derived.length)
    bad("id", `${JSON.stringify(derived)} has a derived-id entry — a duplicate would then overwrite silently instead of being refused`);
  else if (typeof collegeId !== "string" || !collegeId.startsWith("cf_"))
    bad("id", `collegeChargeId("st_1","h_1",1,1) = ${String(collegeId)} — expected the 7a cf_… id`);
  else if (!schoolIdTemplate)
    bad("id", "generatedFeeId no longer derives the school's fee_… ids — the two id spaces can no longer be told apart");
  else
    ok(
      `no derived-id entry for any of the four; 7a's charge id is ${collegeId} (cf_…) and the school's is still fee_… — no shared id space`
    );
}

/* ------------------------------------------------------------------------ 5 */

console.log("\n5. the school fee spine is untouched — the same models, the same collections, no mode field");
{
  const school = [
    ["fee", "fees"],
    ["feeSetting", "feeSettings"],
    ["feeCategory", "feeCategories"],
    ["feeTemplate", "feeTemplates"],
    ["discount", "discounts"],
    ["payment", "payments"],
    ["ledgerEntry", "ledger"],
  ];
  const missing = school.filter(([k, v]) => !new RegExp(`^\\s*${k}:\\s*"${v}",\\s*$`, "m").test(colsText || ""));
  const newLines = dbText
    .split("\n")
    .filter((l) => l.trim().startsWith("collegeFee") && NEW_MODELS.some((m) => new RegExp(`\\b${m}\\b`).test(l)));
  const modeLines = newLines.filter((l) => /\bmode\b/.test(l));
  if (missing.length) bad("school-spine", `a school money mapping is missing or renamed: ${JSON.stringify(missing)}`);
  else if (modeLines.length) bad("school-spine", `a college fee entry names a mode field: ${JSON.stringify(modeLines)}`);
  else
    ok(
      "fee/feeSetting/feeCategory/feeTemplate/discount/payment/ledgerEntry still map where they did, and no college fee entry carries a mode field"
    );
}

/* ------------------------------------------------------------------------ 6 */

console.log("\n6. no school fee surface names a college fee model (libs, pages, print pages, scripts included)");
{
  const targets = [
    "src/app/api/fees",
    "src/app/api/fee-categories",
    "src/app/api/fee-templates",
    "src/app/api/ledger",
    "src/app/api/stats",
    "src/lib/ledger.ts",
    "src/lib/payments.ts",
    "src/lib/enroll.ts",
    "src/lib/fee-channels.ts",
    "src/app/print/admission-receipt",
    "src/app/print/invoice",
    "src/app/dashboard/fees",
    "src/app/parent/fees",
    "scripts/verify-fees-totals.mjs",
  ];
  const root = fileURLToPath(new URL("..", import.meta.url));
  const offenders = [];
  const missingPaths = [];
  const filesIn = (p) => {
    const full = `${root}${p}`;
    if (!existsSync(full)) return null;
    if (statSync(full).isFile()) return [p];
    const out = [];
    const walk = (dir, prefix) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = `${prefix}/${entry.name}`;
        if (entry.isDirectory()) walk(`${dir}/${entry.name}`, rel);
        else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(rel);
      }
    };
    walk(full, p);
    return out;
  };
  for (const t of targets) {
    const files = filesIn(t);
    if (!files) {
      missingPaths.push(t);
      continue;
    }
    for (const f of files) {
      const code = maskCommentsAndStrings(readFileSync(`${root}${f}`, "utf8"));
      if (!(code.match(COLLEGE_REF_RE) || []).length) continue;
      if (f !== LEDGER_FILE) {
        offenders.push(f);
        continue;
      }
      // The ONE exempt file, for the ONE function D-7-12 binds into it: every
      // college fee reference must sit AT OR AFTER `confirmCollegePayment`'s
      // declaration, so the school's own ledger readers and writers (all of which
      // come before it) still fail the moment one names a college row.
      const marker = code.indexOf(LEDGER_COLLEGE_MARKER);
      if (marker < 0 || (code.slice(0, marker).match(COLLEGE_REF_RE) || []).length) {
        offenders.push(`${f} (a college fee reference outside confirmCollegePayment — D-7-12 allows it nowhere else)`);
      }
    }
  }
  if (missingPaths.length)
    bad("school-scope", `a school fee surface is missing (the scan would silently skip it): ${JSON.stringify(missingPaths)}`);
  else if (offenders.length)
    bad(
      "school-scope",
      `a SCHOOL fee file names a college fee model: ${offenders.join(", ")} — the two modes' money would mix in a read (Q3)`
    );
  else
    ok(
      `none of the ${targets.length} school fee surfaces (routes, libs, pages, print pages, verify-fees-totals) names a college fee model, and the ONE shared-ledger exception (D-7-12's confirmCollegePayment) names it nowhere else in src/lib/ledger.ts`
    );
}

/* ------------------------------------------------------------------------ 7 */

console.log("\n7. the models are reachable only from a listed college segment — none yet, because 7b builds no route");
{
  const apiDir = fileURLToPath(new URL("../src/app/api", import.meta.url));
  const collegeSet = new Set(segments.COLLEGE_API_SEGMENTS);
  const owners = new Set();
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith(".ts")) {
        const code = maskCommentsAndStrings(readFileSync(full, "utf8"));
        if (!(code.match(COLLEGE_REF_RE) || []).length) continue;
        const rel = full.slice(apiDir.length + 1).split("\\").join("/");
        const segment = rel.split("/")[0];
        owners.add(segment);
        if (!collegeSet.has(segment)) offenders.push(rel);
      }
    }
  };
  if (existsSync(apiDir)) walk(apiDir);
  if (offenders.length)
    bad(
      "route-scope",
      `a NON-college route names a college fee model: ${offenders.join(", ")} — check 3 of verify-college-routes.mjs must fail such a file`
    );
  else if (owners.size)
    ok(`no non-college route names a college fee model; the model is reached from the LISTED segment(s): ${[...owners].join(", ")}`);
  else ok("no route names a college fee model yet — 7b builds no route, and 7c's API must live in a listed college segment");
}

/* ------------------------------------------------------------------------ 8 */

console.log("\n8. the segment lands WITH its directory — 7c adds both in one change (§8 D-A)");
{
  const listed = [...segments.COLLEGE_API_SEGMENTS];
  const dirExists = existsSync(fileURLToPath(new URL("../src/app/api/college-fees", import.meta.url)));
  const expected = [...PRE_7B_SEGMENTS, "college-fees"];
  const keptPre = PRE_7B_SEGMENTS.every((s) => listed.includes(s));
  const guardPinsStale = /staleSegments/.test(guardText);
  if (!guardPinsStale)
    bad("segment", "the guard no longer pins the stale-list rule — check 1 could then accept a listed segment with no directory");
  else if (!keptPre)
    bad("segment", `a pre-7b segment was dropped: ${JSON.stringify(listed)}`);
  else if (listed.length !== expected.length || !expected.every((s) => listed.includes(s)))
    bad(
      "segment",
      `COLLEGE_API_SEGMENTS is ${JSON.stringify(listed)}, expected the six pre-7b segments plus "college-fees" ${JSON.stringify(expected)}`
    );
  else if (!dirExists)
    bad("segment", "src/app/api/college-fees is listed but the directory does not exist — check 1 would fail it as a stale segment");
  else
    ok(
      `COLLEGE_API_SEGMENTS holds the six pre-7b segments plus "college-fees" (${listed.length}), and src/app/api/college-fees exists — the directory and its entry landed in one change (§8 D-A)`
    );
}

/* ------------------------------------------------------------------------ 9 */

console.log("\n9. the guard covers the new models (7b's four and 7c's collegeDiscount), and the segment list stays dependency-free");
{
  const covers = /COLLEGE_MODEL_RE = \/\\bprisma\\\.\(([^)]*)\)/.exec(guardText);
  const names = covers ? covers[1].split("|").map((s) => s.trim()) : [];
  const importFree =
    !/\bimport\b/.test(maskCommentsAndStrings(segmentsText)) && !/\brequire\s*\(/.test(maskCommentsAndStrings(segmentsText));
  const keptPreExisting = ["department", "program", "programCourse", "course", "courseResult"].every((n) => names.includes(n));
  if (!covers) bad("guard", "COLLEGE_MODEL_RE could not be read from verify-college-routes.mjs");
  else if (![...NEW_MODELS, ...LATER_MODELS].every((m) => names.includes(m)))
    bad("guard", `COLLEGE_MODEL_RE does not cover every college fee model (7b's four plus 7c's collegeDiscount): ${JSON.stringify(names)}`);
  else if (!keptPreExisting) bad("guard", `COLLEGE_MODEL_RE lost a pre-existing model: ${JSON.stringify(names)}`);
  else if (!importFree) bad("guard", "college-routes.ts gained an import — it must stay dependency-free");
  else {
    const rule = guardText.split("\n").find((l) => l.includes("const COLLEGE_MODEL_RE"));
    // Strip the literal delimiters, so the probe is the regex's own source.
    const pattern = new RegExp(rule.replace(/^.*= \/(.*)\/;\s*$/, "$1"));
    const overMatch =
      pattern.test("prisma.collegeFeeHeads") || pattern.test("prisma.collegeFeeStructures") || pattern.test("prisma.collegeFeeConfigs");
    const exact = NEW_MODELS.every((m) => pattern.test(`prisma.${m}`)) && !pattern.test("prisma.collegeFeeX");
    if (overMatch) bad("guard", "the regex matches a COLLECTION name (prisma.collegeFeeHeads) — a model name must be matched exactly");
    else if (!exact) bad("guard", `the regex does not match the four model names exactly: ${JSON.stringify(names)}`);
    else
      ok(
        `COLLEGE_MODEL_RE covers ${names.length} models (the five pre-existing + 7b's four + 7c's collegeDiscount), matches each model name exactly, and college-routes.ts is dependency-free`
      );
  }
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ COLLEGE FEES DATA LAYER FAILED — ${failures} of ${checks} check(s) failed.`);
  process.exit(1);
}
console.log(
  `✅ COLLEGE FEES DATA LAYER OK — ${checks} check(s): the four college fee collections are registered in ` +
    `COLS/RELS/prisma as a purely additive change (the four recorded pre-7b baselines, RELS bodies included, still ` +
    `reproduce), the school fee spine is untouched and reachable from no college fee read, no derived-id entry makes a ` +
    `duplicate silent, no non-college route reaches the models, the college-fees segment and its directory landed together, and the ` +
    `route guard covers every college fee model (7b's four plus 7c's collegeDiscount).`
);
