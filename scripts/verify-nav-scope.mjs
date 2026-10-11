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
 *
 * RECORDED BY PHASE 7d (docs/COLLEGE-DECISIONS.md §8 deviation 3 — "a COLLEGE-only
 * tenant's nav is the college list" — and §24.7's 7-pre item 3): the phase that
 * finally makes the college list real has THREE consequences here, and each is a
 * re-statement, never a relaxation:
 *
 *   1. `navForRole` now also drops the **unmarked** items when the tenant can run
 *      a college and the active mode is COLLEGE, so `visibleIn` (this file's model
 *      of the rule) gained that half. Check 3's school-only proof is untouched and
 *      still compares the FROZEN pre-Phase-1 snapshot; check 4 still proves an
 *      absent type/mode reads as SCHOOL, so a school tenant can never be emptied
 *      by a stale `ss_mode` cookie.
 *   2. The college href list gained 7d's ONE new entry (`/dashboard/college-fees`,
 *      D-7-16) for a FOURTH role — the ACCOUNTANT, who holds the D-7-18 write
 *      allow-list and had to be able to reach the screens — so the marker product
 *      is 7 hrefs × 4 roles = 28. Check 9 is new: it asserts that the fee entry is
 *      carried by exactly the D-7-18 read allow-list roles that have a dashboard
 *      nav, and that a college-capable tenant in COLLEGE mode lists the college
 *      list and NOTHING else.
 *   3. That one href is grouped in `finance` (it is money), so check 6 now asserts
 *      the EXACT group of every college href instead of "all of them are
 *      `academics`" — stricter, not looser.
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
// Phase 6d-fix: the v1 READ allow-list the college results API and both pages
// apply. Check 8 asserts the sidebar cannot offer the results entry to a role the
// API would refuse, so nav and API can never drift apart.
const { COLLEGE_RESULTS_READ_ROLES } = await import("../src/lib/college-results-access.ts");
// Phase 7d: the college FEE read allow-list the fee API and the fee screen apply
// (D-7-18). Check 9 asserts the sidebar cannot offer the fee entry to a role the
// API would refuse either way — the read rule and the write rule.
const { COLLEGE_FEES_READ_ROLES, COLLEGE_FEES_WRITE_ROLES } = await import("../src/lib/college-fees-access.ts");

const SNAPSHOT = JSON.parse(
  readFileSync(new URL("./nav-scope-snapshot.json", import.meta.url), "utf8")
);

/** The mobile tab counts frozen before this phase (`mobileTabsFor` short labels). */
const FROZEN_MOBILE_TABS = { TEACHER: 4 };

/**
 * The college destinations (Phase 2e and 3d marked four; Phase 5c adds the
 * promotion page; Phase 6d adds the results screen; Phase 7d adds the fee
 * screens) that carry `requires: "COLLEGE"`, for exactly these roles. Check 1
 * asserts the marked set equals that product, so a stray marker (or a missing
 * one) fails loudly; checks 3, 4 and 6 use the same list as the definition of "a
 * college item".
 *
 * Phase 6d appended `"/dashboard/college-results"`; Phase 7d appended
 * `"/dashboard/college-fees"` and the fourth role (`ACCOUNTANT` — a D-7-18
 * writer who must reach the screens), so the product is 7 hrefs x 4 roles = 28
 * markers. Nothing here was relaxed: the school-output proof in checks 3 and 4
 * compares against the FROZEN pre-Phase-1 snapshot, which contains none of these
 * hrefs, so a SCHOOL tenant's navigation is still asserted byte-identical for
 * every role and mode.
 */
const COLLEGE_HREFS = ["/dashboard/departments", "/dashboard/programs", "/dashboard/courses", "/dashboard/registration", "/dashboard/college-promotion", "/dashboard/college-results", "/dashboard/college-fees"];

/**
 * WHICH college hrefs each role carries — the marker map, and the definition of
 * "a college item" for checks 3, 4 and 6.
 *
 * The three college-facing roles carry all seven (they are the catalogue,
 * registration, promotion, results and fee screens' own users). The ACCOUNTANT
 * carries the ONE money screen: D-7-18 makes the accounts office a college fee
 * WRITER, while it holds no `programs`/`courses`/`registration`/`attendanceMarks`
 * permission at all — so the other six screens are refused by the API and must
 * not be offered. `COLLEGE_ROLES` is therefore the four roles that carry at least
 * one college item, and the product below is 7 + 7 + 7 + 1 = 22 markers, asserted
 * exactly (a stray marker, or a missing one, fails loudly).
 */
const COLLEGE_MARKS = {
  SCHOOL_ADMIN: COLLEGE_HREFS,
  BRANCH_ADMIN: COLLEGE_HREFS,
  REGISTRAR: COLLEGE_HREFS,
  ACCOUNTANT: ["/dashboard/college-fees"],
};
const COLLEGE_ROLES = Object.keys(COLLEGE_MARKS);
/** The roles the D-7-18 read allow-lists name that also own a dashboard nav. */
const collegeReadersOf = (readRoles) => readRoles.filter((role) => SNAPSHOT.roles.includes(role) && role !== "SUPER_ADMIN");

/**
 * The module group each college href must land in (`SCHOOL_GROUP_OF` in
 * `src/components/nav.ts`). Phase 2e–6d all happened to be `academics`; 7d's fee
 * screens are money, so they belong beside the school's fee screens in `finance`.
 * Check 6 asserts this table exactly, which is a strengthening of the old "every
 * college item is grouped in `academics`".
 */
const COLLEGE_GROUP_OF = { "/dashboard/college-fees": "finance" };
const collegeGroupFor = (href) => COLLEGE_GROUP_OF[href] || "academics";

/** Can this tenant run a college at all? Absent/unknown values normalize to SCHOOL. */
const collegeCapable = (type) => hasCollege(normalizeInstitutionType(type));

/**
 * Should a registry item be listed for this `{institutionType, mode}` pair?
 *
 * A MARKED item needs both halves (the active mode must be the one it requires,
 * and the tenant must be able to run it). An UNMARKED item is a SCHOOL item
 * (7d), so a college-capable tenant showing COLLEGE lists none of them — and a
 * tenant that cannot run a college lists them all, whatever a stale mode says.
 */
const visibleIn = (item, type, mode) =>
  item.requires
    ? item.requires === mode && (item.requires !== "COLLEGE" || collegeCapable(type))
    : !(mode === "COLLEGE" && collegeCapable(type));

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

console.log("\n1. the only `requires` markers are the college destinations, on the four college roles");
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
  // The marked set must be the map's product — no extra mark, and none missing.
  const want = COLLEGE_ROLES.flatMap((role) => COLLEGE_MARKS[role].map((href) => `${role}:${href}`));
  if (!problem) {
    if (marked.length !== want.length)
      problem = `${marked.length} marked item(s), expected ${want.length}: ${want.join(", ")}`;
    else for (const key of want) if (!marked.includes(key)) problem = `${key} is not marked`;
  }
  if (problem) bad("requires", problem);
  else
    ok(
      `${marked.length} marker(s) = the recorded map (` +
        `${COLLEGE_ROLES.map((role) => `${role} ${COLLEGE_MARKS[role].length}`).join(" · ")}), all requires:"COLLEGE"; ` +
        `the other ${SNAPSHOT.roles.length - COLLEGE_ROLES.length} roles carry none`
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
  let collegeScopes = 0;

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
        // 7d — the college list. A college-capable tenant in COLLEGE mode offers
        // its college items and NOTHING else: no unmarked (school) item survives,
        // and none of its own marked items went missing.
        if (mode === "COLLEGE" && collegeCapable(type)) {
          collegeScopes += 1;
          const schoolItems = got.filter((i) => !i.requires).map((i) => i.href);
          const missing = registry
            .filter((i) => COLLEGE_HREFS.includes(i.href))
            .map((i) => i.href)
            .filter((href) => !got.some((i) => i.href === href));
          if (schoolItems.length) {
            problem = `${role} ${type}/${mode}: the college list still offers the school item(s) ${schoolItems.join(", ")}`;
            break outer;
          }
          if (missing.length) {
            problem = `${role} ${type}/${mode}: the college list is missing ${missing.join(", ")}`;
            break outer;
          }
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
        `${schoolOnly} school-only scopes equal the pre-Phase-1 snapshot; ${collegeScopes} of them are the college list ` +
        `(college items only); ${identical} by reference, ${copies} as copies`
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

console.log("\n6. grouping: school buckets unchanged, every college item lands in ITS OWN group, nothing lost or duplicated");
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
      // The college items it carries are exactly the marked ones …
      const marked = collegeIn(fromRegistry).map((x) => x[1]);
      const expectMarked = NAVS[role].filter((i) => COLLEGE_HREFS.includes(i.href)).map((i) => i.href);
      if (JSON.stringify(marked) !== JSON.stringify(expectMarked)) {
        problem = `${role}: registry grouping lists ${JSON.stringify(marked)}, expected ${JSON.stringify(expectMarked)}`;
        break outer;
      }
      // … each in its OWN group (7d: the fee screens are money, so they are grouped
      // in `finance` beside the school's fee screens, not in `academics`).
      const misplaced = collegeIn(fromRegistry).find(([key, href]) => key !== collegeGroupFor(href));
      if (misplaced) {
        problem = `${role}: ${misplaced[1]} is grouped in \`${misplaced[0]}\`, expected \`${collegeGroupFor(misplaced[1])}\``;
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
      const collegeScoped = mode === "COLLEGE" && collegeCapable(type);
      if (collegeScoped) {
        // 7d — the college list: every grouped item is a college item, so the
        // college's own groups are the whole sidebar and nothing of the school's
        // survives in them.
        if (injected.some((k) => k.items.some((i) => !i.requires))) {
          problem = `${role} ${type}/${mode}: a school item was grouped into the college list`;
          break outer;
        }
        if (injected.length && injected.reduce((a, k) => a + k.items.length, 0) !== nav.length) {
          problem = `${role} ${type}/${mode}: the college list's groups do not cover its nav`;
          break outer;
        }
      } else if (JSON.stringify(stripCollege(injected)) !== JSON.stringify(want)) {
        problem = `${role} ${type}/${mode}: injected-array grouping (minus the college items) differs from the snapshot`;
        break outer;
      }
      // Whatever college items the scope shows must be grouped in their own group…
      const visible = nav.filter((i) => COLLEGE_HREFS.includes(i.href)).map((i) => i.href);
      const placed = collegeIn(injected).map((x) => x[1]);
      if (JSON.stringify(placed) !== JSON.stringify(visible)) {
        problem = `${role} ${type}/${mode}: grouped ${JSON.stringify(placed)} college item(s), nav lists ${JSON.stringify(visible)}`;
        break outer;
      }
      const offGroup = collegeIn(injected).find(([key, href]) => key !== collegeGroupFor(href));
      if (offGroup) {
        problem = `${role} ${type}/${mode}: ${offGroup[1]} was grouped outside \`${collegeGroupFor(offGroup[1])}\``;
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
        `every visible college item lands in its OWN group (\`academics\`, plus \`finance\` for the fee screens) and the ` +
        `college list keeps no school item; the groups stay a partition; ` +
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

/* ------------------------------------------------------------------------ 8 */

console.log("\n8. the results entry is offered ONLY to the roles v1 lets read it (6d-fix)");
{
  // The read allow-list is the API's own (src/lib/college-results-access.ts), so
  // this check fails the moment the sidebar and the API disagree. SUPER_ADMIN is
  // on the API list but has no /dashboard nav at all (its registry entry is the
  // platform console), so it is expected to carry no college item.
  const allowed = new Set(COLLEGE_RESULTS_READ_ROLES);
  const DASHBOARD_ROLES = SNAPSHOT.roles;
  const HREF = "/dashboard/college-results";
  const carriers = DASHBOARD_ROLES.filter((role) => (NAVS[role] || []).some((i) => i.href === HREF));
  const deniedRoles = ["TEACHER", "GUARDIAN", "STUDENT"];
  let problem = null;

  // Every carrier must be a role the API lets read …
  const offenders = carriers.filter((role) => !allowed.has(role));
  if (offenders.length) problem = `the sidebar offers ${HREF} to ${offenders.join(", ")}, which the v1 read rule denies`;
  // … and no denied role may carry it, in any mode.
  for (const role of deniedRoles) {
    if (problem) break;
    if (carriers.includes(role)) problem = `${role} carries ${HREF}`;
    else {
      for (const [type, mode] of [
        ["COLLEGE", "COLLEGE"],
        ["BOTH", "COLLEGE"],
      ]) {
        if (navForRole(role, type, mode).some((i) => i.href === HREF)) {
          problem = `${role} ${type}/${mode} lists ${HREF}`;
          break;
        }
      }
    }
  }
  // The roles the RESULTS read rule names (and that own a dashboard nav) must keep
  // it — the screen is theirs. (The ACCOUNTANT is deliberately NOT one of them: the
  // results ruling predates the fee screens and does not admit the accounts office.)
  if (!problem) {
    for (const role of collegeReadersOf(COLLEGE_RESULTS_READ_ROLES)) {
      if (!carriers.includes(role)) {
        problem = `${role} lost ${HREF}`;
        break;
      }
    }
  }
  // A SUPER_ADMIN has no dashboard nav, so it must NOT carry it (never a gap:
  // the platform console is its whole registry).
  if (!problem && carriers.includes("SUPER_ADMIN")) problem = "SUPER_ADMIN carries a dashboard college item";

  if (problem) bad("results entry", problem);
  else
    ok(
      `${HREF} is carried by exactly ${carriers.join(", ")} — all on the v1 read allow-list ` +
        `(${COLLEGE_RESULTS_READ_ROLES.join(", ")}); no TEACHER, GUARDIAN or STUDENT lists it in any mode`
    );
}

/* ------------------------------------------------------------------------ 9 */

console.log("\n9. the college FEE entry is offered ONLY to the roles v1 lets read it, and the college list is the college's own (7d)");
{
  // The read allow-list is the API's own (`src/lib/college-fees-access.ts`), so
  // this check fails the moment the sidebar and the API disagree. SUPER_ADMIN is
  // on the API list but has no /dashboard nav at all (its registry entry is the
  // platform console), so it is expected to carry no college item.
  const allowed = new Set(COLLEGE_FEES_READ_ROLES);
  const HREF = "/dashboard/college-fees";
  const carriers = SNAPSHOT.roles.filter((role) => (NAVS[role] || []).some((i) => i.href === HREF));
  const deniedRoles = ["TEACHER", "GUARDIAN", "STUDENT"];
  let problem = null;

  // Every carrier must be a role the API lets read as well as write…
  const offenders = carriers.filter((role) => !allowed.has(role));
  if (offenders.length) problem = `the sidebar offers ${HREF} to ${offenders.join(", ")}, which the v1 read rule denies`;
  // …the ACCOUNTANT — a D-7-18 writer — must be able to REACH the screens…
  if (!problem && !carriers.includes("ACCOUNTANT")) problem = `ACCOUNTANT lost ${HREF}`;
  // …a REGISTRAR must keep it (read-only v1 access)…
  if (!problem && !carriers.includes("REGISTRAR")) problem = `REGISTRAR lost ${HREF}`;
  // …and no denied role may carry it, in any mode.
  for (const role of deniedRoles) {
    if (problem) break;
    if (carriers.includes(role)) problem = `${role} carries ${HREF}`;
    else {
      for (const [type, mode] of [
        ["COLLEGE", "COLLEGE"],
        ["BOTH", "COLLEGE"],
      ]) {
        if (navForRole(role, type, mode).some((i) => i.href === HREF)) {
          problem = `${role} ${type}/${mode} lists ${HREF}`;
          break;
        }
      }
    }
  }
  // SUPER_ADMIN has no dashboard nav, so it must NOT carry it.
  if (!problem && carriers.includes("SUPER_ADMIN")) problem = "SUPER_ADMIN carries a dashboard college item";
  // Every role that may WRITE college fees and has a dashboard nav must be able to
  // reach the screens (D-7-18): a writer who cannot find the page is a defect.
  if (!problem) {
    const unreachable = collegeReadersOf(COLLEGE_FEES_WRITE_ROLES).filter((role) => !carriers.includes(role));
    if (unreachable.length) problem = `${unreachable.join(", ")} may write college fees but cannot reach ${HREF}`;
  }

  // And the college-list property itself, stated on the FEE entry: a college-capable
  // tenant in COLLEGE mode offers the fee screen with no school item beside it.
  if (!problem) {
    for (const type of ["COLLEGE", "BOTH"]) {
      const nav = navForRole("SCHOOL_ADMIN", type, "COLLEGE");
      if (!nav.some((i) => i.href === HREF)) {
        problem = `SCHOOL_ADMIN ${type}/COLLEGE does not list ${HREF}`;
        break;
      }
      const schoolItem = nav.find((i) => !i.requires);
      if (schoolItem) {
        problem = `SCHOOL_ADMIN ${type}/COLLEGE lists the school item ${schoolItem.href}`;
        break;
      }
    }
  }

  if (problem) bad("fee entry", problem);
  else
    ok(
      `${HREF} is carried by exactly ${carriers.join(", ")} — every one of them on the v1 read allow-list ` +
        `(${COLLEGE_FEES_READ_ROLES.join(", ")}), no TEACHER, GUARDIAN or STUDENT lists it in any mode, and a ` +
        `college-capable tenant in COLLEGE mode shows it with no school item beside it`
    );
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ nav scope verification FAILED — ${failures} group(s) with problems.`);
  process.exit(1);
}
console.log("✅ nav scope verification PASSED — school output is the frozen registry, and the college items stay behind the COLLEGE gate.");
