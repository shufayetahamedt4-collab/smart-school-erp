# Phase 1 — Decision Worksheet (nav + terminology)

**Type:** decision worksheet. **No implementation.** Phase 1 has NOT started; Phase M is FROZEN.
**Date:** 2026-10-07. **Author:** Buffy (Codebuff).
**Purpose:** list every decision Phase 1 needs before a line of code can be written, with the evidence
behind each question, so the phase can start the moment the blanks are filled.

**Why this file exists.** `docs/COLLEGE-PLAN.md` (the original A–I plan) was never committed to this
repository — `git log --all --diff-filter=D -- docs/COLLEGE-PLAN.md` is empty, and grepping every
commit in `git rev-list --all` for `navForRole|NAV_LABEL_OVERRIDES` returns **only**
`docs/COLLEGE-PLAN-DELTA.md`. So the *mechanism* of Phase 1 is documented and the *content* is not.
This worksheet separates the two: §0 is already settled by the docs and is **not** open for
discussion; §1 onward are the blanks.

**How to answer.** Write in the `Answer:` line under each decision. `—` means "no change / not
applicable". If a decision is genuinely undecidable without the missing plan, answer
"re-issue COLLEGE-PLAN.md" and it will be recovered from there instead.

**Evidence tags.** `[D]` repository docs · `[C]` current code (file:line) · `[NS]` not specified.

---

## 0. Already fixed — NOT open questions

These are documented; they are listed so the worksheet is not re-litigating them.

1. **Function and signature.** `navForRole(role, institutionType, mode)` — `[D] docs/COLLEGE-PLAN-DELTA.md` §4.
2. **Label override key.** `NAV_LABEL_OVERRIDES[institutionType][mode][href]`, living in
   `src/lib/institution.ts` (dependency-free "like `sectors.ts`"), with `NAVS` keeping its literal
   SCHOOL labels untouched — `[D]` §4.
3. **Grouping consumes the filtered array.** `groupNavFor` must bucket the *filtered* items — `[D]` §4.
4. **New markers are optional.** `NavItem` gains an optional marker; items are not required to carry one — `[D]` §4.
5. **Phase 1's files.** `src/components/nav.ts`, `src/components/Shell.tsx`, `src/components/AppShell.tsx`,
   `src/lib/institution.ts` — `[D]` §6.
6. **SCHOOL tenants change in no way.** Existing school tenants "behave and look identical to before
   College support"; the acceptance test is the §3 checklist items 5–6 (payloads byte-identical,
   switcher absent with no markup diff) — `[D] docs/COLLEGE-DECISIONS.md` §2, `docs/COLLEGE-PLAN-DELTA.md` §3.
7. **No screen ever mixes both modes' rows** — `[D]` §1 of the delta, §3 of the decisions doc.
8. **Mode is UI context, never authorization.** `can()` (`src/lib/permissions.ts:153`) and tenant
   isolation stay the only enforcement — `[D] docs/COLLEGE-DECISIONS.md` §3.
9. **No API change in Phase 1.** Mode already reaches the client: `src/app/api/auth/me/route.ts` returns
   `institutionType`, `allowedModes`, `mode` (Phase M). Nav is client-rendered.
10. **Phase M stays frozen.** `MODE_COOKIE` is written only at `src/app/api/mode/route.ts:67` and read
    only at `src/lib/auth.ts:80`; `resolveActiveMode()` is referenced from 8 files (its definition in `auth.ts` plus 7 callers: the `me`, `exams`, `mode` and `stats` routes, `academic.ts`, `grading-store.ts`, `routine-config.ts`); the stats/exams cache keys and the
    mode-scoped settings keys are not touched by Phase 1.
11. **No immediate page-data refetch on mode switch** (user instruction, and the frozen Phase M behaviour).

---

## 1. College navigation content

### D1. The college navigation item table
**Question:** for every college-only nav entry, what is its `href`, `label`, module group and icon?
**Evidence:** `[NS]` — no college href appears anywhere in the repo or its history; all refs grepped for
`departments|programs|semester` under `src/components` returned zero hits. `[D]` §4 promises
"new hrefs mapped in `SCHOOL_GROUP_OF`" but never lists them.
**Options:** (a) re-issue the missing plan's nav section; (b) supply the table directly here.
**Answer:**

| # | href | label | group (module key) | icon (lucide) |
|---|---|---|---|---|
| 1 | | | | |
| 2 | | | | |
| 3 | | | | |
| 4 | | | | |
| 5 | | | | |
| … | | | | |

### D2. Which routes exist — or may be pre-referenced
**Question:** may Phase 1 link to pages that later phases create, or must every nav href point at an
existing route on the day Phase 1 lands?
**Evidence:** `[C]` `src/app/dashboard/{departments,programs,semesters,courses,registration,registrations,transcripts}`
are all **ABSENT**. `[D]` §6 assigns departments/programs to Phase 2, semesters/classes to Phase 3,
courses/registration to Phase 4 — i.e. the destinations arrive *after* the nav that would link to them.
**Options:** (a) Phase 1 ships no new hrefs and each later phase adds its own nav entry + `SCHOOL_GROUP_OF`
mapping (the phase then does two small edits instead of one); (b) Phase 1 pre-maps hrefs for pages that
do not exist yet (links 404 until the later phase lands); (c) Phase 1 gates the whole college nav block
behind a marker until the pages exist.
**Answer:**

### D3. Is there a new module group for college?
**Question:** do the college entries fit inside the existing seven module keys
(`overview, academics, people, finance, communication, operations, system`), or is a new module key
added (e.g. a "College" section) with its own label/icon/accent/tint?
**Evidence:** `[C]` `src/components/nav.ts:228` `SCHOOL_GROUP_ORDER`, `:230` `SCHOOL_GROUP_META` (7 keys);
unmapped hrefs silently fall back to `operations` (`nav.ts:293`).
**Answer:**

### D4. Order of college entries
**Question:** in which position does each college entry sit inside its group?
**Evidence:** `[C]` `groupNavFor` preserves **item order within a group** and the fixed group order, so
position is decided by the order of the `NAVS` array itself.
**Answer:**

### D5. Which roles see college entries
**Question:** for each of the six panel roles — `SCHOOL_ADMIN`, `BRANCH_ADMIN`, `REGISTRAR`,
`ACCOUNTANT`, `LIBRARIAN`, `FRONT_DESK` — which college entries become visible?
**Evidence:** `[C]` each role has its own `NAVS` array with different lengths
(SCHOOL_ADMIN 34, BRANCH_ADMIN 33, REGISTRAR 7, ACCOUNTANT 8, LIBRARIAN 3, FRONT_DESK 4), and
`BRANCH_ADMIN` already carries different labels for shared hrefs ("My Branch", "Branch Staff").
**Answer:**

| Role | College entries it gains |
|---|---|
| SCHOOL_ADMIN | |
| BRANCH_ADMIN | |
| REGISTRAR | |
| ACCOUNTANT | |
| LIBRARIAN | |
| FRONT_DESK | |

---

## 2. The `requires` marker

### D6. `requires` schema
**Question:** what is the type of `NavItem.requires`?
**Evidence:** `[NS]` — the delta names the marker once ("an optional `requires` marker per `NavItem`",
§4) with no type, no example and no enum. The vocabulary available in `institution.ts` today is
`InstitutionType` (`:22`), `Mode` (`:28`), `MODES` (`:27`), `allowedModes` (`:66`).
**Options:** (a) `requires?: Mode`; (b) `requires?: Mode[]`; (c) `requires?: { modes?: Mode[]; types?: InstitutionType[] }`;
(d) `requires?: string` feature key (a third vocabulary, existing nowhere today).
**Answer:**

### D7. `requires` semantics
**Question:** does the marker filter by **mode**, by **institutionType**, or by both, and how do they combine?
**Evidence:** `[D]` §4 says nav is filtered by "institution type + active mode"; `[NS]` on how a single
marker expresses both.
**Options:** (a) mode only — a COLLEGE tenant's mode is coerced to COLLEGE, so type falls out for free;
(b) type only — mode never enters the marker; (c) both, evaluated as an AND.
**Answer:**

### D8. Meaning of an item with no marker
**Question:** is an unmarked item visible in every type/mode (default-visible), or hidden until marked?
**Evidence:** `[D]` §4 calls the marker optional and says `NAVS` labels are untouched — implying
`NAVS` stays the SCHOOL list and college entries are the marked ones. `[NS]` explicitly.
**Options:** (a) unmarked = visible everywhere (college entries are the marked ones) — SCHOOL tenants are
a no-op by construction; (b) unmarked = school-only, every item must be marked (requires marking ~126
existing entries across 9 roles — a large, risky diff).
**Answer:**

### D9. `requires` value table
**Question:** for each existing/college item, what is its `requires` value?
**Evidence:** `[NS]` — this is the missing list.
**Answer:**

| Role | href | requires value |
|---|---|---|
| | | |

### D10. Direction of filtering in a COLLEGE tenant
**Question:** in a COLLEGE tenant (not BOTH), do school-only items disappear, or does "COLLEGE" only mean
"no school-*specific* items are hidden"?
**Evidence:** `[D]` decisions §2 states a COLLEGE tenant runs "College only"; `[NS]` whether e.g.
`Library & Books`, `Gallery`, `Messages`, `Reports` count as school-specific or as shared tenant features.
**Options:** (a) explicit list of what a COLLEGE tenant keeps; (b) everything without a school-only marker stays.
**Answer:**

---

## 3. Terminology

### D11. The label override table
**Question:** for every label that changes, what is the college-mode wording — and which labels are
explicitly confirmed **unchanged**?
**Evidence:** `[NS]` — the only mapping-shaped thing in the repo is the override **key**
(`[institutionType][mode][href]`, delta §4 line 151). No mapping exists in any commit or branch.
Candidate labels a reader might expect to change (a *question*, not a proposal):
`Classes & Sections`, `Academic Sessions`, `Subjects`, `Routine`, `Exams & Results`, `Grading & GPA`,
`PTM Slots`, `Promotion & Alumni`, `Bulk Import`, `Guardian Onboarding`, `Parents App`, `Library & Books`.
**Answer:**

| href | current label | COLLEGE label | unchanged? |
|---|---|---|---|
| `/dashboard/classes` | Classes & Sections | | |
| `/dashboard/academic-sessions` | Academic Sessions | | |
| `/dashboard/subjects` | Subjects | | |
| `/dashboard/routine` | Routine | | |
| `/dashboard/exams` | Exams & Results | | |
| `/dashboard/grades` | Grading & GPA | | |
| `/dashboard/meetings` | PTM Slots | | |
| `/dashboard/promotion` | Promotion & Alumni | | |
| `/dashboard/students/import` | Bulk Import | | |
| `/dashboard/onboarding` | Guardian Onboarding | | |
| `/dashboard/guardian-app` | Parents App | | |
| `/dashboard/library` | Library & Books | | |
| … | | | |

### D12. Do group (module) labels change?
**Question:** in college mode, do the module headers themselves get different wording, and does the
module set change?
**Evidence:** `[C]` `SCHOOL_GROUP_META` (`nav.ts:230`) gives each module a literal label
("Overview", "Academics", "People", "Finance", "Communication", "Operations", "System"). The override
key documented in §4 is `[institutionType][mode][href]` — keyed by **href**, so it does not cover module
labels.
**Options:** (a) module labels unchanged; (b) a second override table keyed by module; (c) college gets
its own module set (see D3).
**Answer:**

### D13. Override scope across the four tenant/mode combinations
**Question:** confirm the intended value for each combination — and confirm that **BOTH + SCHOOL mode
carries no override at all**.
**Evidence:** `[D]` §3 checklist 5 ("SCHOOL-only tenants pay nothing") and `[D]` decisions §2.
**Answer:**

| institutionType | mode | overrides applied |
|---|---|---|
| SCHOOL (or absent) | SCHOOL | none — confirm: |
| COLLEGE | COLLEGE | |
| BOTH | SCHOOL | none — confirm: |
| BOTH | COLLEGE | |

### D14. Teacher / Guardian label changes
**Question:** do any `/teacher/*` or `/parent/*` labels change in Phase 1?
**Evidence:** `[D]` §6 puts `AppShell.tsx` in Phase 1's file list; `[D]` decisions §5 and the frozen
Phase M decisions say **no** teacher or guardian switcher. `[NS]` whether their *labels* change.
**Answer:**

---

## 4. Threading mode through the consumers

### D15. `groupNavFor` signature
**Question:** does `groupNavFor` receive the filtered items (`groupNavFor(role, items?)`) or re-resolve
them (`groupNavFor(role, institutionType, mode)`)?
**Evidence:** `[D]` §4 only says it "consumes the filtered array". `[C]` its only caller is
`src/components/Shell.tsx:350`.
**Options:** (a) inject the items — keeps grouping pure and the omitted-argument path identical to today;
(b) re-resolve inside — fewer call-site changes, two sources of the same rule.
**Answer:**

### D16. Shell: nav becomes mode-reactive without any refetch
**Question:** confirm that the sidebar re-renders from `me.mode` on switch, with **no** added fetch,
reload or `router.refresh()`.
**Evidence:** `[C]` `Shell.tsx:342` (`NAVS[effRole]`), `:350` (`groupNavFor(effRole)`, memo deps
`[effRole]`), `:226 useMe`, `:270-289 setMode` (updates `me` in place). `[D]` user instruction: no
immediate page-data refetch.
**Answer:**

### D17. AppShell / app-nav: does the Teacher or Guardian nav change at all?
**Question:** if yes, which entries, and is the `smoke-all` assertion update authorised?
**Evidence:** `[C]` `AppShell.tsx:68-70` (`appTabsFor`, `appMoreItemsFor`, `NAVS[effRole]`),
`app-nav.ts:31 TAB_DEFS`, `:47 isAppRole`, `:56 appTabsFor`, `:78 appMoreItemsFor`.
`[C]` `scripts/smoke-all.mjs:442,456` asserts `tabs ∪ More === NAVS[role]` **exactly**, and
`tabs.length === 4` with an AI tab for both app roles — any college-only app destination breaks that
check, so updating it is a deliberate, justified test change, not a convenience.
**Answer:**

### D18. Dead mobile components
**Question:** confirm `MobileTabBar.tsx` / `MobileMoreSheet.tsx` are left untouched.
**Evidence:** `[C]` grep across `src` for both names returns **no importers**; `MOBILE_TAB_HREFS`
(`nav.ts:356`) has only TEACHER and is consumed only by the dead `mobileTabsFor` path. The live phone
nav is `AppShell`'s own bar + two `BottomSheet`s.
**Answer:**

### D19. Parameter source: `institutionType` or `allowedModes`?
**Question:** Phase 1 filters on `institutionType` (the documented signature) — leaving
`me.allowedModes` unused — or on `allowedModes` (available and equivalent, but a deviation from the
documented signature)?
**Evidence:** `[D]` §4 signature takes `institutionType`; `[C]` `me.allowedModes` is declared in
`Shell.tsx:53` and consumed nowhere except the APIs. `allowedModes(type)` is already exported
(`institution.ts:66`).
**Answer:**

### D20. Super Admin
**Question:** confirm the platform console nav (5 entries, no school context) is never mode-filtered.
**Evidence:** `[C]` `/admin/layout.tsx` → `Shell role="SUPER_ADMIN"`; a Super Admin session has no
`schoolId`, so `institutionType` is absent ⇒ normalizes to SCHOOL ⇒ already a no-op.
**Answer:**

---

## 5. Acceptance and verification

### D21. Definition of "SCHOOL nav is unchanged"
**Question:** is the criterion hrefs + labels + order + group membership (a structural diff), or does it
also include the DOM/element-count baseline the mobile work pinned?
**Evidence:** `[D]` §3 checklist 5–6; `[C]` `MobileTabBar.tsx` comments reference "the element counts the
T0 baseline pinned for ≥768px"; `smoke-all.mjs:416` asserts no `ss-chrome`/`ss-app-tabbar` markup in
`/teacher` server HTML.
**Answer:**

### D22. Where the nav verification lives, and with which runner
**Question:** a new `scripts/verify-nav-scope.mjs`, or an extension of `smoke-all.mjs` — and is `bun`
acceptable as the runner?
**Evidence:** `[C]` `smoke-all.mjs:427-435` dynamically imports the TypeScript modules and **SKIPS** the
partition check under plain `node` ("run this script with bun to exercise it") — a skipped check is not a
passing check, so the nav assertions must run under a runner that loads TS.
**Answer:**

### D23. Does Phase 1 need a live BOTH-tenant browser pass?
**Question:** is the in-process matrix (pure functions over static data, no emulator, no server) sufficient
for sign-off, or is a live BOTH tenant required (switcher → nav flips, no reload)?
**Evidence:** `[C]` the nav functions are pure and importable; Phase M's own sign-off used a temporary
BOTH tenant (`zz-ui-both`) created in the emulator and deleted afterwards.
**Answer:**

---

## 6. Boundary confirmations

### D24. Mechanism-only Phase 1?
**Question:** if the college content cannot be supplied, should Phase 1 ship the **mechanism alone**
(`navForRole` + optional marker + override table, all empty — provable no-op for every tenant), with the
content landing in the phases that add the routes?
**Evidence:** `[D]` §6 assigns the mechanism to Phase 1 and the destinations to Phases 2–4.
**Answer:**

### D25. Confirm the untouched set
**Question:** confirm Phase 1 touches none of: `src/app/api/**` (incl. `api/mode/route.ts`),
`src/app/api/auth/me/route.ts`, `src/middleware.ts`, `src/lib/db.ts`, `src/lib/subscription.ts`,
`src/lib/permissions.ts`, any `src/app/*/layout.tsx`, the Phase M cache/config helpers, any core-row writer.
**Evidence:** `[D]` §4/§6 file lists; `[D]` decisions §3; `[C]` a nav-only change needs none of them.
**Answer:**

### D26. Anything else Phase 1 owns that is not nav or terminology?
**Question:** does the missing plan place anything else in Phase 1 (sector/app naming, portal titles,
print-page labels, the `NOTIFICATIONS_HREF`/`PROFILE_HREF` maps)?
**Evidence:** `[D]` §6 gives Phase 1 the one-line scope "tenant-aware nav + terminology";
`[C]` `nav.ts:316,329` also hold per-role href maps that a college renaming could plausibly touch; `[NS]`.
**Answer:**

---

## 7. Decisions carried over from the delta's own open questions

### D27. Teacher switcher (`§8 Q3`)
**Question:** confirmed deferred — Phase 1 relabels teacher nav but adds no mode control?
**Evidence:** `[D]` decisions §5 ("Later phase"); frozen Phase M decision 3 ("Teacher switcher: NOT implemented").
**Answer:**

### D28. Guardian mode control / badge (`§8 Q4`, `§8 Q12`)
**Question:** guardian gets no control (the selected child implies the mode) — and is a read-only mode
badge in scope for Phase 1 or a later phase?
**Evidence:** `[D]` decisions §5, delta §5; recommended defaults are explicitly **not approved**.
**Answer:**

### D29. Recovering the missing source
**Question:** can `docs/COLLEGE-PLAN.md` be re-issued (its sections A–I, specifically the navigation and
terminology section) so these blanks are answered from the authoritative source rather than decided ad hoc?
**Evidence:** the file was never committed; only the delta's D/§-level statements survive.
**Answer:**

---

## 8. Exit criteria — when Phase 1 may start

Phase 1 is unblocked when, at minimum, **D1, D5, D6/D7/D8 and D11** are answered (items + roles +
marker semantics + labels), and **D2** decides the sequencing of hrefs against later phases. D12–D26
then resolve mechanically; D27–D29 are confirmations.

**Minimum viable unblock (if the plan cannot be re-issued):** answer D2 as (a) plus D24 as "mechanism
only" — then Phase 1 can ship a provable no-op mechanism, and each later phase adds its own nav entry,
`requires` value and label override as it creates the route.

**Status: BLOCKED — MISSING SOURCE REQUIREMENT.** No implementation attempted, no file changed other
than this worksheet, Phase M untouched.
