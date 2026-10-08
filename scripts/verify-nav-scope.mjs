#!/usr/bin/env node
/**
 * Phase 1 — tenant-aware navigation, MECHANISM ONLY.
 *
 * Phase 1 installed the tenant-aware mechanism as a provable no-op; Phase 2e is
 * the first phase to consume it, marking the two college destinations
 * (`/dashboard/departments`, `/dashboard/programs`) for the three college-facing
 * roles. That is exactly the change docs/COLLEGE-DECISIONS.md §8 ("shelf life")
 * said the first content phase would have to record, so the assertions below now
 * prove what still has to hold for every tenant:
 *
 *   - a SCHOOL tenant's navigation is the frozen pre-Phase-1 registry, item for
 *     item — in EVERY mode, and for absent/unknown institution types too;
 *   - a college-capable tenant sees the two extra destinations only in COLLEGE
 *     mode, only for a role that carries them, and never in school mode;
 *   - `navForRole` hands back the registry's own array exactly where nothing was
 *     filtered (the six unmarked roles), and a fresh copy everywhere else.
 *
 * Read-only and offline. It imports the navigation modules directly (this
 * machine's Node strips the TypeScript types) and reads the frozen pre-Phase-1
 * snapshot that sits next to it, captured from `406ee9b:src/components/nav.ts`
 * before this phase edited the file. It touches no database, no server and no
 * network, which is why it carries **no `requireEmulator()` guard** — see
 * docs/COLLEGE-DECISIONS.md §8 ("Phase 1 decisions").
 *
 *   node scripts/verify-nav-scope.mjs
 *
 * RECORDED BY PHASE 2e: the phase that marks its first item must relax the
 * Phase-1 identity assertion, and this file now does — checks 1, 3, 4 and 6 each
 * asserted a *no-op* property ("nothing is marked", "the registry is returned by
 * reference", "the grouping is untouched") that a marked item necessarily
 * falsifies. They were re-stated, not removed: each one still fails loudly if a
 * marker appears on an unexpected href, mode or role, if a school-only scope
 * drifts from the frozen pre-Phase-1 snapshot, or if `navForRole` returns the
 * registry array where it must return a copy. Do not delete them.
 */

import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions (`from "../lib/institution"`). Node's own ESM
 * resolver requires the extension, so this local, synchronous hook retries a
 * failed relative specifier with `.ts` appended. It is scoped to this process
 * — nothing is installed, no loader flag is needed, and the application code is
 * left exactly as the bundler expects it.
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

const { NAVS, navForRole, groupNavFor, mobileTabsFor, moreItemsFor } = await import(
  "../src/components/nav.ts"
);
const {
  INSTITUTION_TYPES,
  MODES,
  NAV_LABEL_OVERRIDES,
  hasCollege,
  navLabelFor,
  normalizeInstitutionType,
} = await import("../src/lib/institution.ts");

const SNAPSHOT = JSON.parse(
  readFileSync(new URL("./nav-scope-snapshot.json", import.meta.url), "utf8")
);

/** The mobile tab counts frozen before this phase (`mobileTabsFor` short labels). */
const FROZEN_MOBILE_TABS = { TEACHER: 4 };

/**
 * Phase 2e and 3d mark exactly these destinations with `requires: "COLLEGE"`, for
 * exactly these three roles. Check 1 asserts the marked set equals that product,
 * so a stray marker (or a missing one) fails loudly; checks 3, 4 and 6 use the
 * same list as the definition of "a college item".
 */
const COLLEGE_HREFS = ["/dashboard/departments", "/dashboard/programs", "/dashboard/courses"];
const COLLEGE_ROLES = ["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR"];

/** Can this tenant run a college at all? Absent/unknown values normalize to SCHOOL. */
const collegeCapable = (type) => hasCollege(normalizeInstitutionType(type));

/** Should a registry item be listed for this `{institutionType, mode}` pair? */
const visibleIn = (item, type, mode) =>
  !item.requires ||
  (item.requires === mode && (item.requires !== "COLLEGE" || collegeCapable(type)));

let failures = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (scope, msg) => {
  failures += 1;
  console.log(`  ❌ [${scope}] ${msg}`);
};
const pairs = (items) => items.map((i) => [i.href, i.label]);

console.log("=== nav scope (school-output proof + college marks) ===");
console.log(`snapshot: ${SNAPSHOT.capturedFrom}`);
console.log(`roles=${SNAPSHOT.roles.length} items=${Object.values(SNAPSHOT.navs).reduce((a, b) => a + b.length, 0)}`);

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. the only `requires` markers are the two college destinations, on the three college roles");
{
  const marked = [];
  const byRole = new Map();
  let problem = null;
  for (const role of SNAPSHOT.roles) {
    const items = NAVS[role];
    if (!items) {
      problem = `${role} is missing from NAVS`;
      break;
    }
    const hits = items
      .filter((i) => Object.prototype.hasOwnProperty.call(i, "requires"))
      .map((i) => i.href);
    if (hits.length) byRole.set(role, hits);
    for (const href of hits) marked.push(`${role}:${href}`);
    if (!COLLEGE_ROLES.includes(role) && hits.length)
      problem ??= `${role} carries a requires marker but is not a college-facing role`;
    for (const item of items) {
      if (Object.prototype.hasOwnProperty.call(item, "requires")) {
        if (item.requires !== "COLLEGE")
          problem ??= `${role} ${item.href}: requires=${JSON.stringify(item.requires)}, expected "COLLEGE"`;
        if (!COLLEGE_HREFS.includes(item.href))
          problem ??= `${role} marks ${item.href}, which is not a college destination`;
      }
    }
  }
  // The marked set must be the full product — no extra mark, and none missing.
  const want = COLLEGE_ROLES.flatMap((role) => COLLEGE_HREFS.map((href) => `${role}:${href}`));
  if (!problem) {
    if (marked.length !== want.length)
      problem = `${marked.length} marked item(s), expected ${want.length}: ${want.join(", ")}`;
    else for (const key of want) if (!marked.includes(key)) problem = `${key} is not marked`;
  }
  if (problem) bad("requires", problem);
  else
    ok(
      `${marked.length} marker(s) = ${COLLEGE_HREFS.length} college hrefs × ${COLLEGE_ROLES.length} roles, all ` +
        `requires:"COLLEGE"; the other ${SNAPSHOT.roles.length - COLLEGE_ROLES.length} roles carry none`
    );
}

/* ------------------------------------------------------------------------ 2 */

console.log("\n2. the label override table is empty in every cell");
{
  let problem = null;
  const entries = [];
  for (const type of INSTITUTION_TYPES) {
    for (const mode of MODES) {
      const cell = NAV_LABEL_OVERRIDES[type]?.[mode];
      const keys = cell ? Object.keys(cell) : [];
      entries.push(`${type}/${mode}=${keys.length}`);
      if (keys.length) problem = `${type}/${mode} holds ${keys.length} override(s): ${keys.join(", ")}`;
    }
  }
  // The accessor must also answer "no override" for raw/absent values.
  for (const [href, type, mode] of [
    ["/dashboard/classes", undefined, undefined],
    ["/dashboard/subjects", "SCHOOL", "SCHOOL"],
    ["/dashboard/classes", "BOTH", "COLLEGE"],
    ["/dashboard/classes", null, "COLLEGE"],
  ]) {
    const v = navLabelFor(href, type, mode);
    if (v !== undefined) problem = `navLabelFor(${href}, ${type}, ${mode}) returned ${JSON.stringify(v)}`;
  }
  if (problem) bad("overrides", problem);
  else ok(`NAV_LABEL_OVERRIDES empty (${entries.join(" · ")}) and navLabelFor falls through to undefined`);
}

/* ------------------------------------------------------------------------ 3 */

console.log("\n3. every role × {SCHOOL,COLLEGE,BOTH} × {SCHOOL,COLLEGE} is the registry filtered for that scope");
console.log("   (and every school-only scope — school mode, or a tenant that cannot run college — is still the frozen pre-Phase-1 list)");
{
  const TYPES = ["SCHOOL", "COLLEGE", "BOTH"];
  const MODES_ = ["SCHOOL", "COLLEGE"];
  let problem = null;
  let compared = 0;
  let identical = 0;
  let copies = 0;
  let schoolOnly = 0;

  outer: for (const role of SNAPSHOT.roles) {
    const registry = NAVS[role];
    for (const type of TYPES) {
      for (const mode of MODES_) {
        compared += 1;
        const got = navForRole(role, type, mode);
        const want = registry.filter((i) => visibleIn(i, type, mode));
        if (JSON.stringify(pairs(got)) !== JSON.stringify(pairs(want))) {
          problem = `${role} ${type}/${mode}: navigation differs from the registry filtered for this scope`;
          break outer;
        }
        // School output proof: a school-only scope (school mode, or a tenant that
        // cannot run a college whatever the mode) is the frozen pre-Phase-1 list.
        if (mode === "SCHOOL" || !collegeCapable(type)) {
          schoolOnly += 1;
          if (JSON.stringify(pairs(got)) !== JSON.stringify(SNAPSHOT.navs[role])) {
            problem = `${role} ${type}/${mode}: school-only scope differs from the pre-Phase-1 snapshot`;
            break outer;
          }
        }
        // Identity survives exactly where nothing was dropped or relabelled.
        if (want.length === registry.length) {
          if (got !== registry) {
            problem = `${role} ${type}/${mode}: nothing was filtered, so the registry array must be returned by reference`;
            break outer;
          }
          identical += 1;
        } else {
          if (got === registry) {
            problem = `${role} ${type}/${mode}: items were filtered, so a copy must be returned`;
            break outer;
          }
          copies += 1;
        }
      }
    }
  }
  if (problem) bad("matrix", problem);
  else
    ok(
      `${compared} combinations (${SNAPSHOT.roles.length} roles × 3 types × 2 modes) all match the scope's filtered registry; ` +
        `${schoolOnly} school-only scopes equal the pre-Phase-1 snapshot; ${identical} by reference, ${copies} as copies`
    );
}

/* ------------------------------------------------------------------------ 4 */

console.log("\n4. an absent institution type and an absent mode behave as SCHOOL");
{
  const CASES = [
    [undefined, undefined],
    [undefined, "COLLEGE"],
    ["SCHOOL", undefined],
    [null, null],
  ];
  let problem = null;
  let n = 0;
  outer: for (const role of SNAPSHOT.roles) {
    const registry = NAVS[role];
    const want = registry.filter((i) => !i.requires);
    for (const [type, mode] of CASES) {
      n += 1;
      const got = navForRole(role, type, mode);
      if (JSON.stringify(pairs(got)) !== JSON.stringify(pairs(want))) {
        problem = `${role} (${String(type)}/${String(mode)}): raw/absent values must behave as SCHOOL`;
        break outer;
      }
      if (JSON.stringify(pairs(got)) !== JSON.stringify(SNAPSHOT.navs[role])) {
        problem = `${role} (${String(type)}/${String(mode)}): not the pre-Phase-1 school list`;
        break outer;
      }
      const expectIdentity = want.length === registry.length;
      if (expectIdentity && got !== registry) {
        problem = `${role} (${String(type)}/${String(mode)}): expected the registry's own array`;
        break outer;
      }
      if (!expectIdentity && got === registry) {
        problem = `${role} (${String(type)}/${String(mode)}): expected a filtered copy`;
        break outer;
      }
    }
  }
  if (problem) bad("absent values", problem);
  else
    ok(
      `${n} absent/raw value combinations (Super Admin, QR sessions, first paint) all read as SCHOOL ` +
        `and hide every college item — including an absent type with mode=COLLEGE`
    );
}

/* ------------------------------------------------------------------------ 5 */

console.log("\n5. an unknown role still yields an empty list");
{
  const got = navForRole("NOT_A_ROLE", "BOTH", "COLLEGE");
  if (!Array.isArray(got) || got.length !== 0) bad("unknown role", `expected [], got ${JSON.stringify(got)}`);
  else if (groupNavFor("NOT_A_ROLE") !== null) bad("unknown role", "groupNavFor should still return null");
  else ok('navForRole("NOT_A_ROLE", …) → [] and groupNavFor → null (as `NAVS[role] || []` always did)');
}

/* ------------------------------------------------------------------------ 6 */

console.log("\n6. grouping: school buckets unchanged, college items land in `academics`, nothing lost or duplicated");
{
  const flat = (g) => (g ? g.map((k) => [k.key, k.label, k.items.map((i) => i.href)]) : null);
  /** The snapshot shape, with the college items removed and emptied groups dropped. */
  const stripCollege = (g) =>
    g
      ? g
          .map((k) => ({ key: k.key, label: k.label, items: k.items.filter((i) => !COLLEGE_HREFS.includes(i.href)) }))
          .filter((k) => k.items.length)
          .map((k) => [k.key, k.label, k.items.map((i) => i.href)])
      : null;
  /** `[groupKey, href]` for every college item the grouped list actually carries. */
  const collegeIn = (g) =>
    g ? g.flatMap((k) => k.items.filter((i) => COLLEGE_HREFS.includes(i.href)).map((i) => [k.key, i.href])) : [];

  let problem = null;
  let grouped = 0;
  let nulled = 0;
  outer: for (const role of SNAPSHOT.roles) {
    const want = SNAPSHOT.groups[role];
    const fromRegistry = groupNavFor(role);

    if (want === null) {
      if (fromRegistry !== null) {
        problem = `${role}: expected null groups`;
        break outer;
      }
      nulled += 1;
    } else {
      // Drop the college items and the registry grouping is the frozen one again.
      if (JSON.stringify(stripCollege(fromRegistry)) !== JSON.stringify(want)) {
        problem = `${role}: groups (minus the college items) differ from the snapshot`;
        break outer;
      }
      // The items it does carry are exactly the marked ones, and all in `academics`.
      const marked = collegeIn(fromRegistry).map((x) => x[1]);
      const expectMarked = NAVS[role].filter((i) => COLLEGE_HREFS.includes(i.href)).map((i) => i.href);
      if (JSON.stringify(marked) !== JSON.stringify(expectMarked)) {
        problem = `${role}: registry grouping lists ${JSON.stringify(marked)}, expected ${JSON.stringify(expectMarked)}`;
        break outer;
      }
      if (collegeIn(fromRegistry).some(([key]) => key !== "academics")) {
        problem = `${role}: a college item was grouped outside \`academics\``;
        break outer;
      }
      grouped += 1;
    }

    // D15 — the injected-array path must agree for every scope.
    for (const [type, mode] of [
      ["SCHOOL", "SCHOOL"],
      ["COLLEGE", "COLLEGE"],
      ["BOTH", "SCHOOL"],
      ["BOTH", "COLLEGE"],
    ]) {
      const nav = navForRole(role, type, mode);
      const injected = groupNavFor(role, nav);
      if (want === null) {
        if (injected !== null) {
          problem = `${role} ${type}/${mode}: expected null groups from the injected array`;
          break outer;
        }
        continue;
      }
      if (JSON.stringify(stripCollege(injected)) !== JSON.stringify(want)) {
        problem = `${role} ${type}/${mode}: injected-array grouping (minus the college items) differs from the snapshot`;
        break outer;
      }
      // Whatever college items the scope shows must be grouped in `academics`…
      const visible = nav.filter((i) => COLLEGE_HREFS.includes(i.href)).map((i) => i.href);
      const placed = collegeIn(injected).map((x) => x[1]);
      if (JSON.stringify(placed) !== JSON.stringify(visible)) {
        problem = `${role} ${type}/${mode}: grouped ${JSON.stringify(placed)} college item(s), nav lists ${JSON.stringify(visible)}`;
        break outer;
      }
      if (collegeIn(injected).some(([key]) => key !== "academics")) {
        problem = `${role} ${type}/${mode}: a college item was grouped outside \`academics\``;
        break outer;
      }
      // …and the groups must still be an exact partition of the injected list.
      const hrefs = injected.flatMap((k) => k.items.map((i) => i.href));
      if (hrefs.length !== nav.length || new Set(hrefs).size !== nav.length) {
        problem = `${role} ${type}/${mode}: groups are not a partition of the injected nav (${hrefs.length} vs ${nav.length})`;
        break outer;
      }
    }
  }
  if (problem) bad("grouping", problem);
  else
    ok(
      `${grouped} panel roles: registry + all 4 injected scopes group identically once the college items are removed, ` +
        `every visible college item lands in \`academics\`, and the groups stay a partition; ` +
        `${nulled} non-panel roles (and any unknown role) still return null`
    );
}

/* ------------------------------------------------------------------------ 7 */

console.log("\n7. the mobile helpers still derive from the registry (untouched)");
{
  let problem = null;
  for (const role of SNAPSHOT.roles) {
    const nav = NAVS[role];
    const tabs = mobileTabsFor(role);
    const more = moreItemsFor(role);
    const wantTabs = FROZEN_MOBILE_TABS[role] ?? 0;
    if (tabs.length !== wantTabs) problem = `${role}: ${tabs.length} tab(s), expected ${wantTabs}`;
    // Every mobile destination is one of the role's own nav hrefs …
    for (const item of [...tabs, ...more]) {
      if (!nav.some((n) => n.href === item.href)) problem = `${role}: ${item.href} is not in NAVS[${role}]`;
    }
    // … and tabs + More is still a partition of that array.
    const hrefs = new Set([...tabs, ...more].map((i) => i.href));
    if (hrefs.size !== tabs.length + more.length) problem = `${role}: a destination appears twice`;
    if (hrefs.size !== nav.length) problem = `${role}: ${hrefs.size} reachable, ${nav.length} exist`;
    if (problem) break;
  }
  if (problem) bad("mobile helpers", problem);
  else ok("tabs + More still partition each role's own nav (TEACHER 4 + 10, everyone else 0 tabs)");
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ nav scope verification FAILED — ${failures} group(s) with problems.`);
  process.exit(1);
}
console.log("✅ nav scope verification PASSED — school output is the frozen registry, and the college items stay behind the COLLEGE gate.");
