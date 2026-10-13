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

const {
  DATABASE_ID_VAR,
  DATABASE_ID_ALIAS_VAR,
  DEFAULT_DATABASE_ID,
  resolveDatabaseId,
  isEmulatorEnvironment,
  liveDatabaseProblem,
  assertNamedDatabaseId,
} = await import(MODULE_URL.href);

/** Read a repository file as text (the source pins below judge CODE, not prose). */
const readRel = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

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

/* ------------------------------------------------------------------------ 9 */

console.log("\n9. pilot P3 — a LIVE environment must NAME its database: \"(default)\" is refused");
{
  const named = { FIRESTORE_DATABASE_ID: "smart-school-db" };

  // (a) A named database is allowed, is returned verbatim, and is what the client opens.
  const allowed = liveDatabaseProblem(named);
  let namedId = null;
  try {
    namedId = assertNamedDatabaseId(named);
  } catch (e) {
    namedId = `threw: ${e?.message}`;
  }
  if (allowed !== null) {
    bad("p3-live", `a named database was refused: ${JSON.stringify(allowed)}`);
  } else if (namedId !== "smart-school-db") {
    bad("p3-live", `a named database resolved to ${JSON.stringify(namedId)}, expected "smart-school-db"`);
  } else {
    ok("a live environment with a named database is allowed, and opened by that name");
  }

  // (b) unset, (c) blank/whitespace, (d) the literal "(default)" — every form is refused,
  //     by `liveDatabaseProblem` (the text) AND by `assertNamedDatabaseId` (the throw).
  const refused = [
    ["both absent", {}],
    ["canonical empty", { FIRESTORE_DATABASE_ID: "" }],
    ["alias empty", { FIRESTORE_DB_ID: "" }],
    ["canonical whitespace", { FIRESTORE_DATABASE_ID: "   " }],
    ["alias whitespace", { FIRESTORE_DB_ID: "\t" }],
    ["canonical is (default)", { FIRESTORE_DATABASE_ID: "(default)" }],
    ["alias is (default)", { FIRESTORE_DB_ID: "(default)" }],
    ["both are (default)", { FIRESTORE_DATABASE_ID: "(default)", FIRESTORE_DB_ID: "(default)" }],
  ];
  let missed = null;
  let threwFor = 0;
  for (const [label, env] of refused) {
    const text = liveDatabaseProblem(env);
    if (!text) {
      missed = `${label} was ALLOWED by liveDatabaseProblem`;
      break;
    }
    let threw = null;
    try {
      assertNamedDatabaseId(env);
    } catch (e) {
      threw = e;
    }
    if (!threw) {
      missed = `${label} did not throw in assertNamedDatabaseId`;
      break;
    }
    if (!String(threw.message).includes(DATABASE_ID_VAR) || !String(threw.message).includes(DATABASE_ID_ALIAS_VAR)) {
      missed = `${label} threw a message that does not name BOTH variables: ${JSON.stringify(String(threw.message))}`;
      break;
    }
    threwFor += 1;
  }
  if (missed) bad("p3-live", missed);
  else ok(`${threwFor} unnamed/"(default)" live environments are refused, and each refusal names both variables`);

  // (e) The alias still works on its own — the pre-existing rules are untouched.
  let aliasId = null;
  try {
    aliasId = assertNamedDatabaseId({ FIRESTORE_DB_ID: "smart-school-db" });
  } catch (e) {
    aliasId = `threw: ${e?.message}`;
  }
  if (aliasId !== "smart-school-db") bad("p3-live", `the alias alone resolved to ${JSON.stringify(aliasId)}`);
  else ok('the ALIAS alone still selects the database on a live environment (rule unchanged)');

  // (f) A disagreeing pair still throws the CONFLICT message, not the new refusal.
  let conflict = "";
  try {
    assertNamedDatabaseId({ FIRESTORE_DATABASE_ID: "smart-school-db", FIRESTORE_DB_ID: "some-other-db" });
  } catch (e) {
    conflict = String(e?.message || "");
  }
  if (!conflict.includes("disagree")) bad("p3-live", `a disagreeing pair did not raise the conflict error: ${JSON.stringify(conflict)}`);
  else ok("a disagreeing canonical/alias pair still raises the conflict error, not the P3 refusal");

  // (g) NO OPT-IN FLAG. A flag would only re-arm the accident this stops, so the
  //     module may read no environment name beyond the emulator host; the two
  //     database names are read through their constants. Any `env.<OTHER>` in the
  //     module fails here.
  const envReads = [...new Set([...source.matchAll(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))];
  const unexpected = envReads.filter((n) => n !== "FIRESTORE_EMULATOR_HOST");
  if (unexpected.length) {
    bad("p3-live", `the module reads env.${unexpected.join(", env.")} — an opt-in flag is exactly what P3 removed`);
  } else {
    ok("there is no opt-in flag: the module reads no env name beyond FIRESTORE_EMULATOR_HOST");
  }
}

/* ----------------------------------------------------------------------- 10 */

console.log('\n10. the EMULATOR is unchanged — its own "(default)" is the local database');
{
  const emu = { FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" };
  if (isEmulatorEnvironment({})) bad("p3-emulator", "an empty environment reported itself as the emulator");
  else if (isEmulatorEnvironment({ FIRESTORE_EMULATOR_HOST: "   " })) bad("p3-emulator", "a whitespace emulator host counted as the emulator");
  else if (!isEmulatorEnvironment(emu)) bad("p3-emulator", "a loopback emulator host was not detected");
  else if (liveDatabaseProblem(emu) !== null) bad("p3-emulator", `the emulator was refused: ${JSON.stringify(liveDatabaseProblem(emu))}`);
  else if (liveDatabaseProblem({ ...emu, FIRESTORE_DATABASE_ID: "(default)" }) !== null) {
    bad("p3-emulator", 'the emulator with an explicit "(default)" was refused');
  } else if (assertNamedDatabaseId(emu) !== DEFAULT_DATABASE_ID) {
    bad("p3-emulator", `an unnamed emulator run resolved to ${JSON.stringify(assertNamedDatabaseId(emu))}`);
  } else if (assertNamedDatabaseId({ ...emu, FIRESTORE_DATABASE_ID: "smart-school-db" }) !== "smart-school-db") {
    bad("p3-emulator", "a NAMED database inside an emulator run was not honoured");
  } else {
    let emuConflict = "";
    try {
      assertNamedDatabaseId({ ...emu, FIRESTORE_DATABASE_ID: "a-db", FIRESTORE_DB_ID: "b-db" });
    } catch (e) {
      emuConflict = String(e?.message || "");
    }
    if (!emuConflict.includes("disagree")) {
      bad("p3-emulator", `the conflict rule was relaxed for the emulator: ${JSON.stringify(emuConflict)}`);
    } else {
      ok('emulator runs are unchanged: an unnamed run is its own "(default)", a named one is honoured, conflicts still throw');
    }
  }
}

/* ----------------------------------------------------------------------- 11 */

console.log("\n11. the APP and the live-capable scripts use this decision (source pins)");
{
  const firebaseSrc = readRel("src/lib/firebase.ts");
  const bootSrc = readRel("scripts/bootstrap-super-admin.mjs");
  const cleanupSrc = readRel("scripts/qa-cleanup-users.mjs");
  const certsSrc = readRel("scripts/qa-certificates.mjs");

  const strictCall = firebaseSrc.indexOf("assertNamedDatabaseId(");
  const appFallback = firebaseSrc.indexOf("getFirestore(adminApp())");
  if (strictCall === -1) {
    bad("p3-wiring", "src/lib/firebase.ts does not call assertNamedDatabaseId");
  } else if (appFallback === -1) {
    bad("p3-wiring", "src/lib/firebase.ts no longer has the emulator's default-database branch");
  } else if (strictCall > appFallback) {
    bad("p3-wiring", "src/lib/firebase.ts reaches getFirestore(adminApp()) before the guard runs");
  } else if (!firebaseSrc.includes("databaseId === DEFAULT_DATABASE_ID")) {
    bad("p3-wiring", "the default-database branch is not gated on DEFAULT_DATABASE_ID (it could be reached live)");
  } else {
    ok("the app resolves through assertNamedDatabaseId, and the only unnamed branch is gated on DEFAULT_DATABASE_ID");
  }

  const bootGuard = bootSrc.indexOf("liveDatabaseProblem(env)");
  const bootOpen = bootSrc.indexOf("initializeApp(");
  if (bootGuard === -1) {
    bad("p3-wiring", "bootstrap-super-admin.mjs does not use the app's own refusal");
  } else if (bootOpen === -1 || bootGuard > bootOpen) {
    bad("p3-wiring", "bootstrap-super-admin.mjs reaches initializeApp before refusing an unnamed database");
  } else if (!bootSrc.includes("assertNamedDatabaseId(env)")) {
    bad("p3-wiring", "bootstrap-super-admin.mjs no longer opens the database by its resolved name");
  } else if (!bootSrc.includes("getFirestore(undefined, databaseName)")) {
    bad("p3-wiring", "bootstrap-super-admin.mjs no longer opens a NAMED database by name");
  } else {
    ok("the first-owner bootstrap refuses an unnamed live run before it connects, then opens the resolved name");
  }

  const refusal = 'DATABASE_NAME === "(default)"';
  if (!cleanupSrc.includes("FIRESTORE_DATABASE_ID || process.env.FIRESTORE_DB_ID") || !cleanupSrc.includes(refusal)) {
    bad("p3-wiring", "qa-cleanup-users.mjs does not read the canonical name and refuse \"(default)\"");
  } else if (!certsSrc.includes("FIRESTORE_DATABASE_ID || process.env.FIRESTORE_DB_ID") || !certsSrc.includes('databaseName === "(default)"')) {
    bad("p3-wiring", "qa-certificates.mjs does not read the canonical name and refuse \"(default)\"");
  } else {
    ok("both QA sweeps read the canonical name (and the alias) and refuse \"(default)\"");
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
    `name selects its database, a blank value means "(default)" for the resolver, and two DISAGREEING names throw rather than guess.`
);
console.log(
  `✅ pilot P3 — that resolver value is no longer ACTED ON live: a missing/blank/"(default)" name now throws by name ` +
    `(no opt-in flag), the emulator is unchanged, and the app plus the live-capable scripts use that one decision.`
);
