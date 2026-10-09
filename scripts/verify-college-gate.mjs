#!/usr/bin/env node
/**
 * Phase 2 — the COLLEGE feature gate, proved OFFLINE.
 *
 * Two independent claims, both checkable with no database, no server and no
 * network (so this script carries no `requireEmulator()` guard):
 *
 *   1. The **decision table** of the gate. `collegeGateDecision(value)` must
 *      ALLOW exactly the tenants that run a college (COLLEGE, BOTH) and DENY a
 *      SCHOOL tenant — including every absent/empty/unknown value, which
 *      normalize to SCHOOL. This is the pure half of `requireCollege()`
 *      (`src/lib/auth.ts`); the async, DB-resolving half is exercised over HTTP
 *      by the isolation harnesses once the routes exist (Phase 2c/2d).
 *
 *   2. The **nav-layer invariant** for the college destinations
 *      (`/dashboard/departments`, `/dashboard/programs`, `/dashboard/courses`)
 *      and the exact table of who may see them: the registry carries every one
 *      of them for exactly the three
 *      college-facing roles (SCHOOL_ADMIN, BRANCH_ADMIN, REGISTRAR) and for no
 *      other role; a SCHOOL tenant lists none of them in NO mode; a COLLEGE or
 *      BOTH tenant lists all of them, and only in COLLEGE mode. Phase 2e/3d marked them,
 *      so this half is no longer vacuous — it is what keeps a stray marker, a
 *      wrong mode or a wrong-role mark from shipping.
 *
 *   node scripts/verify-college-gate.mjs
 *
 * Since Phase 2e the nav layer checks BOTH halves for a college item — the
 * active mode AND whether the tenant can run a college at all (`hasCollege`) —
 * so even a stale `ss_mode` cookie cannot surface a college link to a school
 * tenant. Mode stays UI context and this stays presentation: `can()` and
 * `requireCollege()` are the only enforcement (claim 1 here, plus the route
 * sweeps in 2c/2d).
 */

import { registerHooks } from "node:module";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension,
 * so this local, synchronous hook retries a failed relative specifier with `.ts`
 * appended — the same approach as `verify-nav-scope.mjs`, scoped to this process.
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

const { NAVS, navForRole } = await import("../src/components/nav.ts");
const {
  INSTITUTION_TYPES,
  MODES,
  collegeGateDecision,
  hasCollege,
  normalizeInstitutionType,
} = await import("../src/lib/institution.ts");

/** The college-only destinations Phase 2 introduces (2e/3d; the promotion page marked by 5c). */
const COLLEGE_HREFS = ["/dashboard/departments", "/dashboard/programs", "/dashboard/courses", "/dashboard/registration", "/dashboard/college-promotion"];
/** The only roles that carry them. */
const COLLEGE_ROLES = ["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR"];

/** Can this tenant run a college at all? Absent/unknown values normalize to SCHOOL. */
const collegeCapable = (type) => hasCollege(normalizeInstitutionType(type));

let failures = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (scope, msg) => {
  failures += 1;
  console.log(`  ❌ [${scope}] ${msg}`);
};

console.log("=== Phase 2 college gate (offline) ===");

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. decision table — ALLOW only college-capable tenants");
{
  const cases = [
    ["COLLEGE", "ALLOW"],
    ["BOTH", "ALLOW"],
    ["SCHOOL", "DENY"],
    // Missing / partial / hostile values: everything that is not a college-capable
    // literal must read as SCHOOL and therefore DENY.
    [undefined, "DENY"],
    [null, "DENY"],
    ["", "DENY"],
    ["college", "DENY"], // wrong case
    ["UNIVERSITY", "DENY"],
    [123, "DENY"],
    [{}, "DENY"],
  ];
  let problem = null;
  for (const [value, want] of cases) {
    const got = collegeGateDecision(value);
    if (got !== want) {
      problem = `collegeGateDecision(${JSON.stringify(value)}) = ${got}, expected ${want}`;
      break;
    }
  }
  // Every named type must agree with normalizeInstitutionType + hasCollege.
  for (const type of INSTITUTION_TYPES) {
    const want = type === "COLLEGE" || type === "BOTH" ? "ALLOW" : "DENY";
    if (collegeGateDecision(type) !== want) problem ??= `${type} did not map to ${want}`;
  }
  if (problem) bad("decision", problem);
  else
    ok(
      `${cases.length} raw values + all ${INSTITUTION_TYPES.length} types decide correctly ` +
        `(missing ⇒ SCHOOL ⇒ ${collegeGateDecision(undefined)})`
    );
  if (normalizeInstitutionType(undefined) !== "SCHOOL") bad("decision", "absent value did not normalize to SCHOOL");
}

/* ------------------------------------------------------------------------ 2 */

console.log("\n2. nav layer — the college hrefs reach a college-capable tenant in COLLEGE mode only");
{
  const roles = Object.keys(NAVS);
  const modes = [...MODES];
  const types = [undefined, null, "SCHOOL", "COLLEGE", "BOTH"];
  let problem = null;

  // (0) Registry shape: both college hrefs, for exactly the three college roles.
  const carriers = roles.filter((r) => (NAVS[r] || []).some((i) => COLLEGE_HREFS.includes(i.href)));
  if (JSON.stringify([...carriers].sort()) !== JSON.stringify([...COLLEGE_ROLES].sort())) {
    problem = `the registry carries a college href for ${JSON.stringify(carriers)}, expected exactly ${JSON.stringify(COLLEGE_ROLES)}`;
  }
  for (const role of carriers) {
    const got = (NAVS[role] || []).filter((i) => COLLEGE_HREFS.includes(i.href)).map((i) => i.href);
    if (JSON.stringify(got) !== JSON.stringify(COLLEGE_HREFS))
      problem ??= `${role} carries ${JSON.stringify(got)}, expected both college hrefs`;
    for (const item of NAVS[role] || []) {
      if (COLLEGE_HREFS.includes(item.href) && item.requires !== "COLLEGE")
        problem ??= `${role} ${item.href}: requires=${JSON.stringify(item.requires)}, expected "COLLEGE"`;
    }
  }

  // (a)/(b) Exhaustive: a college href is listed exactly when the scope is both
  // college-capable AND in COLLEGE mode — and the carrier's list is complete.
  let checked = 0;
  outer: for (const role of roles) {
    const registryCollege = (NAVS[role] || []).filter((i) => COLLEGE_HREFS.includes(i.href)).map((i) => i.href);
    for (const mode of modes) {
      for (const type of types) {
        checked += 1;
        const present = navForRole(role, type, mode)
          .filter((i) => COLLEGE_HREFS.includes(i.href))
          .map((i) => i.href);
        const collegeScope = mode === "COLLEGE" && collegeCapable(type);
        const expect = collegeScope ? registryCollege : [];
        if (JSON.stringify(present) !== JSON.stringify(expect)) {
          problem = `${role} type=${type} mode=${mode}: college hrefs ${JSON.stringify(present)}, expected ${JSON.stringify(expect)}`;
          break outer;
        }
      }
    }
  }

  // (c) The decision table, stated flatly — type × mode → "does this role's nav
  // list the college destinations?". Includes an absent type and an absent mode.
  const TABLE = [
    ["SCHOOL", "SCHOOL", false],
    ["SCHOOL", "COLLEGE", false],
    ["BOTH", "SCHOOL", false],
    ["COLLEGE", "SCHOOL", false],
    [undefined, "SCHOOL", false],
    [undefined, undefined, false],
    [null, "COLLEGE", false],
    ["COLLEGE", "COLLEGE", true],
    ["BOTH", "COLLEGE", true],
  ];
  let rows = 0;
  if (!problem) {
    table: for (const [type, mode, expectCollege] of TABLE) {
      for (const role of roles) {
        rows += 1;
        const carrier = COLLEGE_ROLES.includes(role);
        const present = navForRole(role, type, mode).some((i) => COLLEGE_HREFS.includes(i.href));
        const want = expectCollege && carrier;
        if (present !== want) {
          problem = `table type=${type} mode=${mode} role=${role}: college href ${present ? "listed" : "absent"}, expected ${want ? "listed" : "absent"}`;
          break table;
        }
      }
    }
  }

  if (problem) bad("nav", problem);
  else
    ok(
      `${checked} role×type×mode scope(s): college hrefs appear if and only if the tenant is college-capable and the mode is ` +
        `COLLEGE; registry carries both for exactly ${COLLEGE_ROLES.join(", ")}; ${rows}-row decision table agrees`
    );
}

/* ------------------------------------------------------------------------ 3 */

console.log("\n3. SCHOOL-tenant nav is the registry, unchanged (no-op)");
{
  let problem = null;
  for (const role of Object.keys(NAVS)) {
    const registry = NAVS[role] || [];
    const want = registry.filter((i) => !i.requires || i.requires === "SCHOOL");
    const got = navForRole(role, "SCHOOL", "SCHOOL");
    const pair = (list) => list.map((i) => [i.href, i.label]);
    if (JSON.stringify(pair(got)) !== JSON.stringify(pair(want))) {
      problem = `${role}: SCHOOL/SCHOOL nav differs from the registry's school items`;
      break;
    }
  }
  if (problem) bad("school-noop", problem);
  else ok(`${Object.keys(NAVS).length} roles: SCHOOL tenant sees exactly the registry's school items`);
}

console.log(
  failures === 0
    ? "\n✅ COLLEGE GATE OK — decision table correct, college nav confined to COLLEGE mode"
    : `\n❌ ${failures} college-gate failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
