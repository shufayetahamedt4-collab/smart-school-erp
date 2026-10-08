#!/usr/bin/env node
/**
 * Phase 4b — the course-registration STATUS MACHINE, proved OFFLINE.
 *
 * `src/lib/registration-status.ts` is the ONE place that defines PENDING /
 * APPROVED / REJECTED and the rule "a REJECTED row still blocks nothing". The API
 * routes decide and withdraw by it, and — crucially — every guard in the phase
 * (the duplicate check, the un-enrol / programme-change block, the mapping-delete
 * guard, the course-delete guard) filters with `isBlockingRegistration`. A mistake
 * here is a mistake in five places at once, so this script pins the behaviour:
 *
 *   1. THE VALUES. `REGISTRATION_STATUSES` is exactly PENDING/APPROVED/REJECTED,
 *      the default is PENDING, and `DECISION_STATUSES` is exactly APPROVED/REJECTED.
 *   2. STRICT READS. `isRegistrationStatus` / `isDecisionStatus` accept only the
 *      exact stored strings (a lowercase or padded value is refused).
 *   3. MISSING-SAFE READ. `normalizeRegistrationStatus` returns PENDING for
 *      undefined, null, "", a number, an object and a lowercase-ish string — a
 *      missing or unrecognised stored field is un-decided, never a guard that
 *      silently passes.
 *   4. WHO BLOCKS. `isBlockingRegistration` is true for PENDING and APPROVED and
 *      false for REJECTED and anything unknown — the single rule behind every guard.
 *   5. TERMINAL. APPROVED and REJECTED are terminal; only PENDING can be decided
 *      or withdrawn.
 *   6. DEPENDENCY-FREE. The module imports nothing (`no imports/prisma/node:`),
 *      which is what lets the verifier, a client component and Edge code share it —
 *      the same property `college-terms.ts` and `college-routes.ts` claim.
 *
 *   node scripts/verify-registration-status.mjs
 *
 * Needs no database, no server and no network, so it carries no
 * `requireEmulator()` guard and runs on plain `node`.
 */

import { registerHooks } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension,
 * so this local, synchronous hook retries a failed relative specifier with `.ts`
 * appended — the same approach as `verify-college-terms.mjs`, scoped to this
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

const MODULE_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../src/lib/registration-status.ts");
const {
  REGISTRATION_STATUSES,
  DEFAULT_REGISTRATION_STATUS,
  DECISION_STATUSES,
  isRegistrationStatus,
  isDecisionStatus,
  normalizeRegistrationStatus,
  isBlockingRegistration,
  isTerminalRegistration,
  canDecideRegistration,
  canWithdrawRegistration,
} = await import("../src/lib/registration-status.ts");

let failures = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (scope, msg) => {
  failures += 1;
  console.log(`  ❌ [${scope}] ${msg}`);
};

/** Run a table of [input, expected] cases through a predicate, reporting each miss. */
function table(scope, label, cases, predicate) {
  const wrong = cases.filter(([input, expected]) => predicate(input) !== expected);
  if (wrong.length) {
    for (const [input, expected] of wrong) {
      bad(scope, `${label}(${JSON.stringify(input)}) should be ${expected}`);
    }
  } else {
    ok(`${label}: ${cases.length} case(s) as expected`);
  }
}

console.log("=== Phase 4b course-registration status machine (offline) ===");

/* ------------------------------------------------------------------- check 1 */

console.log("\n1. the values — PENDING/APPROVED/REJECTED, default PENDING, decisions APPROVED/REJECTED");
{
  const statusesOk =
    REGISTRATION_STATUSES.length === 3 &&
    REGISTRATION_STATUSES[0] === "PENDING" &&
    REGISTRATION_STATUSES[1] === "APPROVED" &&
    REGISTRATION_STATUSES[2] === "REJECTED";
  const decisionsOk =
    DECISION_STATUSES.length === 2 &&
    DECISION_STATUSES[0] === "APPROVED" &&
    DECISION_STATUSES[1] === "REJECTED";
  if (statusesOk && decisionsOk && DEFAULT_REGISTRATION_STATUS === "PENDING") {
    ok(`REGISTRATION_STATUSES = ${JSON.stringify([...REGISTRATION_STATUSES])}, DECISION_STATUSES = ${JSON.stringify([...DECISION_STATUSES])}, default ${DEFAULT_REGISTRATION_STATUS}`);
  } else {
    bad("values", `statuses ${JSON.stringify(REGISTRATION_STATUSES)}, decisions ${JSON.stringify(DECISION_STATUSES)}, default ${DEFAULT_REGISTRATION_STATUS}`);
  }
}

/* ------------------------------------------------------------------- check 2 */

console.log("\n2. strict reads — only the exact stored strings pass");
{
  table("strict", "isRegistrationStatus", [
    ["PENDING", true],
    ["APPROVED", true],
    ["REJECTED", true],
    ["pending", false],
    [" APPROVED", false],
    ["DECIDED", false],
    ["", false],
    [undefined, false],
    [null, false],
    [1, false],
  ], isRegistrationStatus);

  table("strict", "isDecisionStatus", [
    ["APPROVED", true],
    ["REJECTED", true],
    ["PENDING", false],
    ["approved", false],
    ["", false],
    [undefined, false],
    [null, false],
  ], isDecisionStatus);
}

/* ------------------------------------------------------------------- check 3 */

console.log("\n3. missing-safe read — anything unrecognised is PENDING");
{
  for (const v of [undefined, null, "", "pending", "DECIDED", 3, {}, []]) {
    const got = normalizeRegistrationStatus(v);
    if (got !== "PENDING") bad("normalize", `normalizeRegistrationStatus(${JSON.stringify(v)}) = ${JSON.stringify(got)}, expected "PENDING"`);
  }
  for (const v of ["PENDING", "APPROVED", "REJECTED"]) {
    if (normalizeRegistrationStatus(v) !== v) bad("normalize", `normalizeRegistrationStatus(${JSON.stringify(v)}) did not round-trip`);
  }
  if (failures === 0) ok('undefined / null / "" / lowercase / number / object / array all read as "PENDING"; the three stored values round-trip');
}

/* ------------------------------------------------------------------- check 4 */

console.log("\n4. who blocks — PENDING and APPROVED only");
{
  table("blocking", "isBlockingRegistration", [
    ["PENDING", true],
    ["APPROVED", true],
    ["REJECTED", false],
    ["DECIDED", false],
    ["", false],
    [undefined, false],
    [null, false],
  ], isBlockingRegistration);
}

/* ------------------------------------------------------------------- check 5 */

console.log("\n5. terminal — only a PENDING row may be decided or withdrawn");
{
  table("terminal", "isTerminalRegistration", [
    ["PENDING", false],
    ["APPROVED", true],
    ["REJECTED", true],
    ["", false],
    [undefined, false],
  ], isTerminalRegistration);

  table("terminal", "canDecideRegistration", [
    ["PENDING", true],
    ["APPROVED", false],
    ["REJECTED", false],
    [undefined, false],
    [null, false],
  ], canDecideRegistration);

  table("terminal", "canWithdrawRegistration", [
    ["PENDING", true],
    ["APPROVED", false],
    ["REJECTED", false],
    [undefined, false],
    [null, false],
  ], canWithdrawRegistration);
}

/* ------------------------------------------------------------------- check 6 */

console.log("\n6. dependency-free — the module imports nothing");
{
  // Strip comments FIRST: the header documents this property in prose, and prose
  // is not an import statement. Same rule as the route guard's comment masking.
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const code = stripComments(readFileSync(MODULE_PATH, "utf8"));
  const moduleImport = /^\s*import\s/m.test(code);
  const requireCall = /\brequire\s*\(/.test(code);
  if (!moduleImport && !requireCall) {
    ok("registration-status.ts carries no import/require — safe for node, a client component and Edge");
  } else {
    bad("dependency-free", "registration-status.ts contains an import/require — it must stay dependency-free");
  }
}

console.log(
  failures === 0
    ? "\n✅ REGISTRATION STATUS OK — PENDING/APPROVED/REJECTED, default PENDING, PENDING/APPROVED block and REJECTED never does, decided is terminal"
    : `\n❌ ${failures} registration-status failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
