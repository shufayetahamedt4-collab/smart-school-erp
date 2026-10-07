#!/usr/bin/env node
/**
 * Phase 3a — the `courses` PERMISSION module, proved OFFLINE.
 *
 * The permission matrix (`src/lib/permissions.ts`) is the single source of truth
 * for "who may do what", and every route gates with `can(role, module, action)`.
 * Adding a module is therefore a security-relevant edit: a role that should see
 * nothing must be listed nowhere, and a role that should manage the catalogue
 * must hold `full`. This script is the assertion the Phase 2 `departments` /
 * `programs` modules were reviewed against, now made runnable for `courses`:
 *
 *   1. INVENTORY. `MATRIX`'s keys are exactly the modules this script knows, so a
 *      module added without recording it here fails rather than drifting.
 *   2. THE COURSES ENTRY. `MATRIX.courses` is exactly SCHOOL_ADMIN `full`,
 *      BRANCH_ADMIN `full`, REGISTRAR `view` — and it does NOT list SUPER_ADMIN.
 *   3. EVERY EXISTING ROLE against the new key, for every action. The expected
 *      answer per role is written out below, so a role that is not listed gets
 *      NO access and the implication table is pinned at the same time.
 *   4. SUPER_ADMIN passes by SHORT-CIRCUIT, proved as such: `can()` returns true
 *      for every action while `MATRIX.courses.SUPER_ADMIN` is `undefined` — so
 *      the grant comes from `can()`'s early return, not from a matrix entry.
 *   5. `requirePermission()` agrees: it throws `PermissionError` for a refusal
 *      and a missing session, and returns quietly for a grant.
 *
 * `can()`'s implication table is unchanged by Phase 3 and is pinned on purpose:
 * `full` implies every other action — INCLUDING `billing`, which only matters for
 * the `platformBilling` module (where neither SCHOOL_ADMIN nor BRANCH_ADMIN is
 * listed, so a school admin still cannot reach platform billing). The expected
 * table below is the truth as implemented, not a wish.
 *
 *   node scripts/verify-college-permissions.mjs
 *
 * Needs no database, no server and no network, so it carries no
 * `requireEmulator()` guard and runs on plain `node`.
 */

import { registerHooks } from "node:module";

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

const { MATRIX, can, requirePermission, PermissionError } = await import("../src/lib/permissions.ts");

/** Every module key the matrix must carry — frozen, so a new one cannot slip in. */
const FROZEN_MODULES = [
  "studentTeacherInfo", "feePayment", "attendanceMarks", "teachingMaterial",
  "systemSettings", "admission", "library", "communication", "platformBilling",
  "branches", "staff", "departments", "programs", "courses",
];

/** Every role in the `Role` union (src/lib/db.ts) — the exhaustive list to test. */
const ALL_ROLES = [
  "SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "TEACHER",
  "GUARDIAN", "STUDENT", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK",
];

/** Every action in the `Action` union — the exhaustive list to test. */
const ALL_ACTIONS = [
  "view", "viewOwn", "viewOwnChild", "viewOwnClass", "entry", "full", "pay",
  "upload", "billing",
];

/** The one module this phase adds. */
const MODULE = "courses";

const ALL = [...ALL_ACTIONS];
const VIEW_IMPLIED = ["view", "viewOwn", "viewOwnChild", "viewOwnClass"];

/**
 * The expected answer for every role × action, written out rather than derived,
 * so the assert is a check on the implementation and not a restatement of it.
 */
const EXPECTED = {
  SUPER_ADMIN: ALL,
  SCHOOL_ADMIN: ALL,
  BRANCH_ADMIN: ALL,
  REGISTRAR: VIEW_IMPLIED,
  TEACHER: [],
  GUARDIAN: [],
  STUDENT: [],
  ACCOUNTANT: [],
  LIBRARIAN: [],
  FRONT_DESK: [],
};

let failures = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (scope, msg) => {
  failures += 1;
  console.log(`  ❌ [${scope}] ${msg}`);
};
const sameSet = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const sameDeep = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log("=== Phase 3a college permissions (offline) ===");

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. inventory — the matrix carries exactly the known modules");
{
  const actual = Object.keys(MATRIX);
  const missing = FROZEN_MODULES.filter((m) => !actual.includes(m));
  const extra = actual.filter((m) => !FROZEN_MODULES.includes(m));
  const empty = actual.filter((m) => !MATRIX[m] || Object.keys(MATRIX[m]).length === 0);

  if (missing.length) bad("inventory", `matrix is missing module(s): ${missing.join(", ")}`);
  if (extra.length) bad("inventory", `matrix has module(s) this script does not know: ${extra.join(", ")} — add them to FROZEN_MODULES deliberately`);
  if (empty.length) bad("inventory", `module(s) with no role entry at all: ${empty.join(", ")}`);
  if (!missing.length && !extra.length && !empty.length) {
    ok(`${actual.length} module(s), matching the frozen list; every one carries at least one role`);
  }
}

/* ------------------------------------------------------------------------ 2 */

console.log("\n2. the courses entry — SCHOOL_ADMIN/BRANCH_ADMIN full, REGISTRAR view, no SUPER_ADMIN key");
{
  const entry = MATRIX[MODULE];
  if (!entry) {
    bad("entry", `MATRIX.${MODULE} does not exist`);
  } else {
    const wantRoles = ["BRANCH_ADMIN", "REGISTRAR", "SCHOOL_ADMIN"];
    const gotRoles = Object.keys(entry);
    if (!sameSet(gotRoles, wantRoles)) {
      bad("entry", `MATRIX.${MODULE} lists ${JSON.stringify(gotRoles.sort())}, expected exactly ${JSON.stringify(wantRoles)}`);
    }
    if (!sameDeep(entry.SCHOOL_ADMIN, ["full"])) bad("entry", `SCHOOL_ADMIN = ${JSON.stringify(entry.SCHOOL_ADMIN)}, expected ["full"]`);
    if (!sameDeep(entry.BRANCH_ADMIN, ["full"])) bad("entry", `BRANCH_ADMIN = ${JSON.stringify(entry.BRANCH_ADMIN)}, expected ["full"]`);
    if (!sameDeep(entry.REGISTRAR, ["view"])) bad("entry", `REGISTRAR = ${JSON.stringify(entry.REGISTRAR)}, expected ["view"]`);
    if ("SUPER_ADMIN" in entry) {
      bad("entry", "MATRIX.courses lists SUPER_ADMIN — it must NOT, so the grant stays the can() short-circuit and not a matrix entry");
    }
    // The three college modules are the same shape by design; a drift is a bug.
    if (!sameDeep(entry, MATRIX.departments) || !sameDeep(entry, MATRIX.programs)) {
      bad("entry", `MATRIX.${MODULE} differs from the identical departments/programs modules`);
    }
    if (failures === 0) ok(`MATRIX.${MODULE} = ${JSON.stringify(entry)} — identical to departments and programs, no SUPER_ADMIN entry`);
  }
}

/* ------------------------------------------------------------------------ 3 */

console.log("\n3. every existing role × every action against the new key");
{
  let checked = 0;
  let problem = null;
  for (const role of ALL_ROLES) {
    const want = EXPECTED[role];
    for (const action of ALL_ACTIONS) {
      checked += 1;
      const got = can(role, MODULE, action);
      const expect = want.includes(action);
      if (got !== expect) {
        problem = `can(${role}, "${MODULE}", "${action}") = ${got}, expected ${expect}`;
        break;
      }
    }
    if (problem) break;
  }
  if (problem) bad("roles", problem);
  else {
    ok(
      `${checked} role×action cell(s): SCHOOL_ADMIN and BRANCH_ADMIN hold full (all ${ALL_ACTIONS.length} actions), ` +
        `REGISTRAR holds view (+ its ${VIEW_IMPLIED.length - 1} narrower viewOwn* scopes) and nothing more, and ` +
        `${ALL_ROLES.length - 3} other role(s) get NO access`
    );
  }

  // A role that is not a role at all gets nothing.
  for (const bogus of [null, undefined, "", "not-a-role", "school_admin"]) {
    if (can(bogus, MODULE, "view") !== false) bad("roles", `can(${JSON.stringify(bogus)}, "${MODULE}", "view") did not refuse`);
  }
}

/* ------------------------------------------------------------------------ 4 */

console.log("\n4. SUPER_ADMIN passes by short-circuit, not by a matrix entry");
{
  const allTrue = ALL_ACTIONS.every((a) => can("SUPER_ADMIN", MODULE, a) === true);
  const noEntry = MATRIX[MODULE] && MATRIX[MODULE].SUPER_ADMIN === undefined;
  if (!allTrue) bad("short-circuit", "SUPER_ADMIN is refused at least one action on the new module");
  else if (!noEntry) bad("short-circuit", "SUPER_ADMIN holds a MATRIX.courses entry, so this is not a short-circuit proof");
  else ok(`SUPER_ADMIN passes all ${ALL_ACTIONS.length} actions while MATRIX.${MODULE}.SUPER_ADMIN is undefined — the grant is can()'s early return`);
}

/* ------------------------------------------------------------------------ 5 */

console.log("\n5. requirePermission() agrees — throws on refusal, silent on grant");
{
  const throws = (fn) => {
    try {
      fn();
      return false;
    } catch (e) {
      return e instanceof PermissionError;
    }
  };
  const problems = [];
  if (!throws(() => requirePermission({ role: "TEACHER" }, MODULE, "view"))) problems.push("TEACHER view did not throw PermissionError");
  if (!throws(() => requirePermission(null, MODULE, "view"))) problems.push("a missing session did not throw PermissionError");
  if (!throws(() => requirePermission({ role: "REGISTRAR" }, MODULE, "full"))) problems.push("REGISTRAR full did not throw PermissionError");
  if (throws(() => requirePermission({ role: "REGISTRAR" }, MODULE, "view"))) problems.push("REGISTRAR view wrongly threw");
  if (throws(() => requirePermission({ role: "SCHOOL_ADMIN" }, MODULE, "full"))) problems.push("SCHOOL_ADMIN full wrongly threw");
  if (throws(() => requirePermission({ role: "SUPER_ADMIN" }, MODULE, "full"))) problems.push("SUPER_ADMIN full wrongly threw");
  if (problems.length) for (const p of problems) bad("requirePermission", p);
  else ok("refusals throw PermissionError (TEACHER, missing session, REGISTRAR full); grants pass (REGISTRAR view, SCHOOL_ADMIN full, SUPER_ADMIN full)");
}

/* ------------------------------------------------------------------------ 5b */

console.log("\n6. platformBilling is untouched — a school admin still cannot reach platform billing");
{
  if (can("SCHOOL_ADMIN", "platformBilling", "view") !== false) bad("platformBilling", "SCHOOL_ADMIN reached platformBilling.view");
  else if (can("SCHOOL_ADMIN", "platformBilling", "billing") !== false) bad("platformBilling", "SCHOOL_ADMIN reached platformBilling.billing");
  else if (can("BRANCH_ADMIN", "platformBilling", "billing") !== false) bad("platformBilling", "BRANCH_ADMIN reached platformBilling.billing");
  else if (can("SUPER_ADMIN", "platformBilling", "billing") !== true) bad("platformBilling", "SUPER_ADMIN was refused platformBilling.billing");
  else ok("SCHOOL_ADMIN/BRANCH_ADMIN refused platformBilling (even `billing`, which `full` implies inside its own module); SUPER_ADMIN allowed");
}

console.log(
  failures === 0
    ? `\n✅ COLLEGE PERMISSIONS OK — MATRIX.${MODULE} = SCHOOL_ADMIN full / BRANCH_ADMIN full / REGISTRAR view; every other role refused; SUPER_ADMIN by short-circuit`
    : `\n❌ ${failures} permission failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
