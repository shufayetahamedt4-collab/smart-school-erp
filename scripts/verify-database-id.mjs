#!/usr/bin/env node
/**
 * verify-database-id.mjs — the Firestore database-id decision, proved OFFLINE.
 *
 * `src/lib/database-id.ts` is the ONLY place that decides which database the
 * Admin SDK opens from the environment. It is pure and dependency-free — no
 * firebase, no `node:`, nothing to resolve — which is what lets this script pin
 * it without a database, a server or an emulator: it carries **no
 * `requireEmulator()` guard** and runs on plain `node`, the same design as
 * `verify-college-promotion-logic.mjs`, `verify-college-terms.mjs` and
 * `verify-registration-status.mjs`.
 *
 * What it pins (the decision recorded in docs/INTEGRATION-LOG.md):
 *
 *   1. DEPENDENCY-FREE. No `import`, no `require(` — the no-import property the
 *      sibling pure modules are held to, so the resolver is importable from the
 *      app, a server route and this verifier alike.
 *   2. THE NAMES. `FIRESTORE_DATABASE_ID` is CANONICAL; `FIRESTORE_DB_ID` is the
 *      documented ALIAS (origin/main's cutover switch). Neither name is renamed.
 *   3. NEITHER SET. Unset, `""` or whitespace ⇒ `null` — the project's
 *      "(default)" database, the rollback database.
 *   4. ONE SET. Only the canonical, or only the alias, ⇒ that value: the real
 *      deployment sets exactly one name, so this is the unchanged behaviour.
 *   5. BOTH EQUAL. Both set to the same value ⇒ that value (they agree).
 *   6. BOTH DIFFERENT. ⇒ THROWS, and the message names BOTH variables and their
 *      values — the app must never silently pick one.
 *   7. EXACT VALUE. A real id is returned verbatim (never trimmed); only a
 *      blank (empty/whitespace) value counts as "not set".
 *   8. PURITY. Deterministic, the env object is not mutated, and the default
 *      argument reads `process.env`.
 *
 *   node scripts/verify-database-id.mjs
 *
 * It is an OFFLINE script: safe (and expected) to run without the emulator. It
 * only READS one file from the repository.
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

const MODULE_URL = new URL("../src/lib/database-id.ts", import.meta.url);
const source = readFileSync(MODULE_URL, "utf8");

const { DATABASE_ID_VAR, DATABASE_ID_ALIAS_VAR, resolveDatabaseId } = await import(MODULE_URL.href);

/**
 * Blank out comments and string literals, PRESERVING LENGTH, so a token search
 * runs against code only. The module documents `import`/`require` in prose, so
 * scanning the raw text would match the documentation instead of the surface.
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

console.log("=== Firestore database-id resolution (offline) ===");
console.log(`module: src/lib/database-id.ts (${source.split("\n").length} lines)`);

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. dependency-free — no import, no require() in the module");
{
  const importAt = code.search(/\bimport\b/);
  const requireAt = code.search(/\brequire\s*\(/);
  const nodeAt = code.search(/\bnode:/);
  if (importAt >= 0) {
    bad("dependencies", `\`import\` appears at character ${importAt} — the resolver must stay dependency-free`);
  } else if (requireAt >= 0) {
    bad("dependencies", `\`require(\` appears at character ${requireAt} — the resolver must stay dependency-free`);
  } else if (nodeAt >= 0) {
    bad("dependencies", `\`node:\` appears at character ${nodeAt} — the resolver must not touch the Node runtime`);
  } else if (/\bfirebase/i.test(code)) {
    bad("dependencies", "the module names firebase — it must be a pure string comparison");
  } else {
    ok("no `import`, no `require(`, no `node:` and no firebase — nothing to resolve");
  }
}

/* ------------------------------------------------------------------------ 2 */

console.log("\n2. the names — canonical FIRESTORE_DATABASE_ID, alias FIRESTORE_DB_ID");
{
  if (DATABASE_ID_VAR !== "FIRESTORE_DATABASE_ID") {
    bad("names", `DATABASE_ID_VAR = ${JSON.stringify(DATABASE_ID_VAR)}, expected "FIRESTORE_DATABASE_ID"`);
  } else if (DATABASE_ID_ALIAS_VAR !== "FIRESTORE_DB_ID") {
    bad("names", `DATABASE_ID_ALIAS_VAR = ${JSON.stringify(DATABASE_ID_ALIAS_VAR)}, expected "FIRESTORE_DB_ID"`);
  } else if (typeof resolveDatabaseId !== "function") {
    bad("names", "resolveDatabaseId is not exported as a function");
  } else {
    ok(`DATABASE_ID_VAR = ${DATABASE_ID_VAR}; DATABASE_ID_ALIAS_VAR = ${DATABASE_ID_ALIAS_VAR}`);
  }
}

/* ------------------------------------------------------------------------ 3 */

console.log('\n3. neither set ⇒ null (the project\'s "(default)" rollback database)');
{
  const cases = [
    ["both absent", {}],
    ["canonical undefined", { FIRESTORE_DATABASE_ID: undefined }],
    ["alias undefined", { FIRESTORE_DB_ID: undefined }],
    ["canonical empty", { FIRESTORE_DATABASE_ID: "" }],
    ["alias empty", { FIRESTORE_DB_ID: "" }],
    ["both empty", { FIRESTORE_DATABASE_ID: "", FIRESTORE_DB_ID: "" }],
    ["canonical whitespace", { FIRESTORE_DATABASE_ID: "   " }],
    ["alias whitespace", { FIRESTORE_DB_ID: "\t\n" }],
    ["both whitespace", { FIRESTORE_DATABASE_ID: "  ", FIRESTORE_DB_ID: " " }],
  ];
  let problem = null;
  for (const [label, env] of cases) {
    const got = resolveDatabaseId(env);
    if (got !== null) {
      problem = `${label} ⇒ ${JSON.stringify(got)}, expected null`;
      break;
    }
  }
  if (problem) bad("unset", problem);
  else ok(`${cases.length} blank environments (absent, "", whitespace) all resolve to null`);
}

/* ------------------------------------------------------------------------ 4 */

console.log("\n4. only ONE name set ⇒ that value (the unchanged production behaviour)");
{
  const cases = [
    ["only canonical", { FIRESTORE_DATABASE_ID: "smart-school-db" }, "smart-school-db"],
    ["only alias", { FIRESTORE_DB_ID: "smart-school-db" }, "smart-school-db"],
    ["canonical set, alias empty", { FIRESTORE_DATABASE_ID: "smart-school-db", FIRESTORE_DB_ID: "" }, "smart-school-db"],
    ["alias set, canonical blank", { FIRESTORE_DATABASE_ID: "  ", FIRESTORE_DB_ID: "smart-school-db" }, "smart-school-db"],
    ["canonical rollback name verbatim", { FIRESTORE_DATABASE_ID: "(default)" }, "(default)"],
  ];
  let problem = null;
  for (const [label, env, want] of cases) {
    const got = resolveDatabaseId(env);
    if (got !== want) {
      problem = `${label} ⇒ ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      break;
    }
  }
  if (problem) bad("one-set", problem);
  else ok(`${cases.length} single-name environments resolve to their value, blank counterparts ignored`);
}

/* ------------------------------------------------------------------------ 5 */

console.log("\n5. both set and EQUAL ⇒ that value (they agree)");
{
  const cases = [
    ["same named database", { FIRESTORE_DATABASE_ID: "smart-school-db", FIRESTORE_DB_ID: "smart-school-db" }, "smart-school-db"],
    ["both rollback", { FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_DB_ID: "(default)" }, "(default)"],
  ];
  let problem = null;
  for (const [label, env, want] of cases) {
    const got = resolveDatabaseId(env);
    if (got !== want) {
      problem = `${label} ⇒ ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      break;
    }
  }
  if (problem) bad("both-equal", problem);
  else ok(`${cases.length} agreeing pairs resolve to the shared value, with no error`);
}

/* ------------------------------------------------------------------------ 6 */

console.log("\n6. both set and DIFFERENT ⇒ THROWS, naming both variables and values");
{
  const env = { FIRESTORE_DATABASE_ID: "smart-school-db", FIRESTORE_DB_ID: "some-other-db" };
  let threw = null;
  let value = null;
  try {
    value = resolveDatabaseId(env);
  } catch (e) {
    threw = e;
  }

  const message = threw?.message || "";
  if (!threw) {
    bad("disagree", `no error was thrown — got ${JSON.stringify(value)}; the resolver silently picked one`);
  } else if (!(threw instanceof Error)) {
    bad("disagree", `a non-Error was thrown: ${JSON.stringify(threw)}`);
  } else if (!message.includes("FIRESTORE_DATABASE_ID")) {
    bad("disagree", `the error message does not name FIRESTORE_DATABASE_ID: ${JSON.stringify(message)}`);
  } else if (!message.includes("FIRESTORE_DB_ID")) {
    bad("disagree", `the error message does not name FIRESTORE_DB_ID: ${JSON.stringify(message)}`);
  } else if (!message.includes("smart-school-db") || !message.includes("some-other-db")) {
    bad("disagree", `the error message does not show both values: ${JSON.stringify(message)}`);
  } else {
    ok(`throws: ${JSON.stringify(message)}`);
  }
}

/* ------------------------------------------------------------------------ 7 */

console.log("\n7. a real id is returned VERBATIM — only a blank value counts as unset");
{
  const cases = [
    ["padded id preserved", { FIRESTORE_DATABASE_ID: " smart-school-db " }, " smart-school-db "],
    ["padded alias preserved", { FIRESTORE_DB_ID: " db-2" }, " db-2"],
    ["case preserved", { FIRESTORE_DATABASE_ID: "Smart-School-DB" }, "Smart-School-DB"],
  ];
  let problem = null;
  for (const [label, env, want] of cases) {
    const got = resolveDatabaseId(env);
    if (got !== want) {
      problem = `${label} ⇒ ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`;
      break;
    }
  }
  // A padded canonical and an unpadded alias are DIFFERENT strings ⇒ must throw.
  let paddedThrew = false;
  try {
    resolveDatabaseId({ FIRESTORE_DATABASE_ID: " smart-school-db ", FIRESTORE_DB_ID: "smart-school-db" });
  } catch {
    paddedThrew = true;
  }
  if (problem) bad("verbatim", problem);
  else if (!paddedThrew) bad("verbatim", `" smart-school-db " vs "smart-school-db" were treated as equal — they are not`);
  else ok("a padded/odd-cased id is preserved and compared verbatim; only whitespace-only is 'unset'");
}

/* ------------------------------------------------------------------------ 8 */

console.log("\n8. purity — deterministic, the env is not mutated, and the default reads process.env");
{
  const env = { FIRESTORE_DATABASE_ID: "smart-school-db" };
  const snapshot = JSON.stringify(env);
  const first = resolveDatabaseId(env);
  const second = resolveDatabaseId(env);

  // The default argument must read the live process environment.
  const hadCanonical = Object.prototype.hasOwnProperty.call(process.env, "FIRESTORE_DATABASE_ID");
  const hadAlias = Object.prototype.hasOwnProperty.call(process.env, "FIRESTORE_DB_ID");
  const prevCanonical = process.env.FIRESTORE_DATABASE_ID;
  const prevAlias = process.env.FIRESTORE_DB_ID;
  let defaulted = null;
  let defaultThrew = null;
  try {
    delete process.env.FIRESTORE_DATABASE_ID;
    process.env.FIRESTORE_DB_ID = "alias-only-db";
    defaulted = resolveDatabaseId();
  } catch (e) {
    defaultThrew = e?.message || String(e);
  } finally {
    // Restore exactly what we found.
    if (hadCanonical) process.env.FIRESTORE_DATABASE_ID = prevCanonical;
    else delete process.env.FIRESTORE_DATABASE_ID;
    if (hadAlias) process.env.FIRESTORE_DB_ID = prevAlias;
    else delete process.env.FIRESTORE_DB_ID;
  }

  if (first !== second || first !== "smart-school-db") {
    bad("purity", `two identical calls returned ${JSON.stringify(first)} / ${JSON.stringify(second)}`);
  } else if (JSON.stringify(env) !== snapshot) {
    bad("purity", "the env object was mutated");
  } else if (defaultThrew) {
    bad("purity", `the default argument threw: ${defaultThrew}`);
  } else if (defaulted !== "alias-only-db") {
    bad("purity", `the default argument returned ${JSON.stringify(defaulted)}, expected "alias-only-db"`);
  } else {
    ok("deterministic, the passed env is untouched, and resolveDatabaseId() defaults to process.env");
  }
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ DATABASE-ID RESOLUTION FAILED — ${failures} of ${checks} check(s) failed.`);
  process.exit(1);
}
console.log(
  `✅ DATABASE-ID RESOLUTION OK — ${checks} check(s): the canonical name wins by agreement, either single ` +
    `name selects its database, a blank value means "(default)", and two DISAGREEING names throw rather than guess.`
);
