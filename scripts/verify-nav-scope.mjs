#!/usr/bin/env node
/**
 * Phase 1 — tenant-aware navigation, MECHANISM ONLY.
 *
 * Proves the claim Phase 1 is allowed to make: `navForRole(role, institutionType,
 * mode)` is a **no-op for every tenant** — nothing is marked, nothing is
 * overridden, so it returns `NAVS[role]` *by reference* for every role and every
 * `{institutionType, mode}` pair, and a `SCHOOL` tenant's navigation is not
 * merely equal to yesterday's, it IS yesterday's array.
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
 * WHEN A LATER PHASE ADDS CONTENT: the moment the first `requires` marker or the
 * first `NAV_LABEL_OVERRIDES` entry exists, the identity half of check 3 stops
 * being true by design (a marked item is filtered out of some scopes, so the
 * function must return a copy). That phase must relax the assertion to deep
 * equality and record the change — do not "fix" it by removing the check.
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
const { INSTITUTION_TYPES, MODES, NAV_LABEL_OVERRIDES, navLabelFor } = await import(
  "../src/lib/institution.ts"
);

const SNAPSHOT = JSON.parse(
  readFileSync(new URL("./nav-scope-snapshot.json", import.meta.url), "utf8")
);

/** The mobile tab counts frozen before this phase (`mobileTabsFor` short labels). */
const FROZEN_MOBILE_TABS = { TEACHER: 4 };

let failures = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (scope, msg) => {
  failures += 1;
  console.log(`  ❌ [${scope}] ${msg}`);
};
const pairs = (items) => items.map((i) => [i.href, i.label]);

console.log("=== Phase 1 nav scope (mechanism only) ===");
console.log(`snapshot: ${SNAPSHOT.capturedFrom}`);
console.log(`roles=${SNAPSHOT.roles.length} items=${Object.values(SNAPSHOT.navs).reduce((a, b) => a + b.length, 0)}`);

/* ------------------------------------------------------------------------ 1 */

console.log("\n1. nothing carries a `requires` marker");
{
  let problem = null;
  for (const role of SNAPSHOT.roles) {
    const items = NAVS[role];
    if (!items) {
      problem = `${role} is missing from NAVS`;
      break;
    }
    const marked = items.filter((i) => Object.prototype.hasOwnProperty.call(i, "requires"));
    if (marked.length) {
      problem = `${role}: ${marked.length} item(s) marked (${marked.map((i) => i.href).join(", ")})`;
      break;
    }
  }
  if (problem) bad("requires", problem);
  else ok(`${SNAPSHOT.roles.length} roles: no nav item declares a requires marker`);
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

console.log("\n3. every role × {SCHOOL,COLLEGE,BOTH} × {SCHOOL,COLLEGE} is unchanged");
console.log("   (identity for SCHOOL and BOTH+SCHOOL — D21; deep equality elsewhere)");
{
  const TYPES = ["SCHOOL", "COLLEGE", "BOTH"];
  const MODES_ = ["SCHOOL", "COLLEGE"];
  const identityScopes = new Set(["SCHOOL|SCHOOL", "SCHOOL|COLLEGE", "BOTH|SCHOOL"]);
  let problem = null;
  let compared = 0;
  let identical = 0;
  let deepOnly = 0;

  outer: for (const role of SNAPSHOT.roles) {
    const want = SNAPSHOT.navs[role];
    for (const type of TYPES) {
      for (const mode of MODES_) {
        compared += 1;
        const got = navForRole(role, type, mode);
        if (JSON.stringify(pairs(got)) !== JSON.stringify(want)) {
          problem = `${role} ${type}/${mode}: navigation differs from the pre-Phase-1 snapshot`;
          break outer;
        }
        if (identityScopes.has(`${type}|${mode}`)) {
          if (got !== NAVS[role]) {
            problem = `${role} ${type}/${mode}: expected NAVS[role] by reference (no-op scope)`;
            break outer;
          }
          identical += 1;
        } else {
          deepOnly += 1;
        }
      }
    }
  }
  if (problem) bad("matrix", problem);
  else
    ok(
      `${compared} combinations (${SNAPSHOT.roles.length} roles × 3 types × 2 modes) all match the snapshot; ` +
        `${identical} returned the registry's own array by reference, ${deepOnly} compared deep-equal`
    );
}

/* ------------------------------------------------------------------------ 4 */

console.log("\n4. an absent institution type and an absent mode behave as SCHOOL");
{
  let problem = null;
  let n = 0;
  for (const role of SNAPSHOT.roles) {
    for (const [type, mode] of [
      [undefined, undefined],
      [undefined, "COLLEGE"],
      ["SCHOOL", undefined],
      [null, null],
    ]) {
      n += 1;
      const got = navForRole(role, type, mode);
      if (got !== NAVS[role]) problem = `${role} (${String(type)}/${String(mode)}): not the registry's own array`;
      else if (JSON.stringify(pairs(got)) !== JSON.stringify(SNAPSHOT.navs[role])) problem = `${role}: content differs`;
      if (problem) break;
    }
    if (problem) break;
  }
  if (problem) bad("absent values", problem);
  else ok(`${n} absent/raw value combinations (Super Admin, QR sessions, first paint) all return the registry array`);
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

console.log("\n6. grouping is unchanged, both from the registry and from the filtered array");
{
  let problem = null;
  let grouped = 0;
  let nulled = 0;
  outer: for (const role of SNAPSHOT.roles) {
    const want = SNAPSHOT.groups[role];
    const fromRegistry = groupNavFor(role);
    const flat = (g) => (g ? g.map((k) => [k.key, k.label, k.items.map((i) => i.href)]) : null);

    if (want === null) {
      if (fromRegistry !== null) {
        problem = `${role}: expected null groups`;
        break outer;
      }
      nulled += 1;
    } else {
      if (JSON.stringify(flat(fromRegistry)) !== JSON.stringify(want)) {
        problem = `${role}: groups differ from the snapshot`;
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
      const injected = groupNavFor(role, navForRole(role, type, mode));
      if (want === null) {
        if (injected !== null) {
          problem = `${role} ${type}/${mode}: expected null groups from the injected array`;
          break outer;
        }
      } else if (JSON.stringify(flat(injected)) !== JSON.stringify(want)) {
        problem = `${role} ${type}/${mode}: injected-array grouping differs from the snapshot`;
        break outer;
      }
    }
  }
  if (problem) bad("grouping", problem);
  else
    ok(
      `${grouped} panel roles grouped identically for the registry call and for all 4 injected scopes; ` +
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
console.log("✅ nav scope verification PASSED — Phase 1 changes nothing for any tenant.");
