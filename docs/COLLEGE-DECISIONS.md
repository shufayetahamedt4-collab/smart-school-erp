# College Support — Approved Product Decisions

Plain-language record of the decisions that shape College support on the one platform.
These are the source of truth for every later phase. Companion documents:

- `docs/COLLEGE-PLAN.md` — the original A–I architecture plan. **Not saved to this repository**;
  it was delivered as chat prose and never written to disk. It is intentionally absent.
- `docs/COLLEGE-PLAN-DELTA.md` — the delta plan for `institutionType = SCHOOL | COLLEGE | BOTH`.
  It supersedes only the parts of the original plan that this one decision changed; sections A–I
  remain valid everywhere the delta does not contradict them.

---

## 1. One platform, one tenant, an institution type

Every tenant is the **same** product on the **same** backend and database. There is no separate
"college product" and no second tenant model. What changes is a single field on the tenant:

```
schools.institutionType = "SCHOOL" | "COLLEGE" | "BOTH"
```

- **Absent means `SCHOOL`.** A tenant document with no `institutionType` behaves exactly like a
  tenant whose type is `"SCHOOL"`. There is **no backfill and no migration** — every school that
  exists today, and every school document written by any other code path, simply reads as `SCHOOL`.
- The field is only ever written by explicit Super Admin action (creating or editing a tenant).
- Allowed values are exactly three: `SCHOOL`, `COLLEGE`, `BOTH`. Anything else is rejected.

## 2. What each type means

| Type | What the tenant runs | Switcher |
|---|---|---|
| `SCHOOL` | School only. Today's UI, unchanged. | None |
| `COLLEGE` | College only. | None |
| `BOTH` | School **and** college, together, in the same tenant. | A School \| College switcher (Phase M) |

For a `SCHOOL` tenant, **nothing changes**. Existing school tenants must behave and look identical
to before College support. No school-facing, admin-facing, teacher-facing or guardian-facing screen
changes in the foundation phase — the only new UI is the Super Admin tenant control that sets the
type.

## 3. Mode

```
Mode = "SCHOOL" | "COLLEGE"
```

- **Mode is UI context, not security.** It selects which half of a `BOTH` tenant the interface is
  showing. It is never an authorization decision.
- The server must **never** trust a cookie or a `?mode=` query parameter as authorization. Tenant
  isolation, `can()` and the permission matrix remain the only enforcement. A request that asks for
  a mode the tenant's `institutionType` does not allow is refused or filtered — it is never treated
  as a grant of access.
- A `SCHOOL` tenant only ever has the `SCHOOL` mode available; a `COLLEGE` tenant only `COLLEGE`;
  a `BOTH` tenant has both.
- Activation details (an `ss_mode` cookie, a `POST /api/mode` route, `?mode=` on mode-scoped reads)
  are designed in the delta plan and are implemented in **Phase M**, not now.

## 4. Core rows carry a mode later

Core rows — `classes`, `subjects`, `students` — will get a stored `mode` field in a later phase so a
`BOTH` tenant can keep the two halves apart. **Missing `mode` means `SCHOOL`**, exactly like the
tenant field: no backfill, existing school rows keep working untouched, and a `SCHOOL` tenant never
notices the field exists. This is **not** part of the foundation phase.

## 5. People in a `BOTH` tenant

- **Teacher:** gets the switcher only if the teacher actually works in both modes. A teacher who
  works in one mode sees that mode and no switcher. (Later phase.)
- **Guardian:** gets **no** global switcher. The guardian's portal follows the **selected child**:
  the child's mode decides the context. (Later phase.)
- **Super Admin:** chooses the tenant's type. The learner/staff experience inside a `BOTH` tenant is
  defined by the phases that follow.

## 6. Changing a tenant's type — the rule

Type changes are **Super Admin only**, are validated against the three allowed values, and always
write an audit entry. The approved transitions are:

| From → To | Allowed? |
|---|---|
| `SCHOOL` → `BOTH` | **Always allowed.** Adding college to a school never destroys anything. |
| `COLLEGE` → `BOTH` | **Always allowed.** Adding school to a college never destroys anything. |
| `BOTH` → `SCHOOL` | **Only when the tenant has no college data.** |
| `COLLEGE` → `SCHOOL` | **Only when the tenant has no college data.** |

Any other transition (`SCHOOL` → `COLLEGE`, `BOTH` → `COLLEGE`) is **not yet defined** and is
refused with an explicit reason until a later phase gives it a rule. Changing a type to itself is a
no-op.

The point of the restriction is honesty: a tenant that already holds college rows must not be
silently turned into a school-only tenant, or those rows would become unreachable. Phase 2g made
"has college data" real: `schoolHasCollegeData(schoolId)` counts this tenant's **own** departments and
programs with a `schoolId`-scoped query, and fails safe (a store read error reads as "has data"), so
the downgrade is now **blocked** whenever college rows exist and allowed only when there are none.
The pure rule `canChangeInstitutionType` stays in `src/lib/institution.ts`; the DB half lives in
`src/lib/auth.ts` beside `requireCollege`. Setting the type at tenant **creation** accepts all three
values; the
table above governs only **changes**.

## 7. Phase M inherits these

Phase M (the mode switcher) introduces the school | college toggle for `BOTH` tenants. It **inherits
every decision above** and must not restate them differently: mode stays UI context and never
authorization; `SCHOOL`/`COLLEGE` tenants stay switcher-free; the type change rule is unchanged; and
core rows keep the `missing = SCHOOL` convention. Where the delta plan and this document disagree,
this document wins, and the delta plan is corrected.

## 8. Phase 1 decisions (nav + terminology, mechanism only)

Phase 1 makes navigation mode-aware. It is **mechanism only**: it adds no college screen, no link and
no wording, so every tenant sees exactly the navigation it saw before. Approved decisions:

- **D-A — no college nav items.** Phase 1 adds none. Phases 2, 3 and 4 each add their own nav entry,
  `requires` marker, group mapping and label override in the same change that creates the route, so
  no link can ever point at a page that does not exist.
- **D-B — nothing is hidden.** An item without `requires` is visible in every mode. A `COLLEGE`
  tenant therefore still sees today's list until the phases above give it college entries; that
  interim state is intentional.
- **D-C — `NavItem.requires?: Mode`.** An item carrying a marker is visible only when the effective
  mode equals it. Nothing is marked yet, and an absent/unknown mode reads as `SCHOOL`, matching the
  `missing = SCHOOL` convention used everywhere else.
- **D-D — `NAV_LABEL_OVERRIDES` is structure only.** It lives in `src/lib/institution.ts`, keyed
  `[institutionType][mode][href]`, and is **empty** in Phase 1. `SCHOOL`, an absent
  `institutionType` and `BOTH` + `SCHOOL` mode must return the original `NAVS[role]` array
  **reference**, untouched.
- **D-E — no structural expansion.** No new `SCHOOL_GROUP_ORDER` / `SCHOOL_GROUP_META` module, no
  teacher/guardian shell change, and `smoke-all`'s app-nav partition assertion stays untouched.
- **D-F — signature.** `navForRole(role, institutionType, mode)`; it does not consume
  `me.allowedModes`.
- **D15 — `groupNavFor(role, items?)`.** The filtered array is injected through an optional second
  argument, so existing one-argument calls keep working unchanged.
- **D16 — the Shell is wired now.** `Shell.tsx` calls `navForRole` and feeds both the flat list and
  `groupNavFor`; the memo dependencies gain the institution type and the mode. No fetch, no reload
  and no `router.refresh()` is added on a mode switch — the sidebar re-renders from the session
  payload, and page data still refreshes on the next navigation (Phase M, frozen).
- **D21 — the acceptance test.** "Unchanged" means the **same array reference** for `SCHOOL`, an
  absent type and `BOTH` + `SCHOOL`, and deep equality (hrefs, labels, order, group membership)
  everywhere else.
- **D22 — one script proves it.** `scripts/verify-nav-scope.mjs` runs in-process under plain `node`
  (this machine's Node imports the `.ts` modules directly), touches no database and no network, and
  therefore carries no `requireEmulator()` guard.

### Three deviations from the delta plan, recorded deliberately

1. `docs/COLLEGE-PLAN-DELTA.md` §4/§6 give Phase 1 "new hrefs mapped in `SCHOOL_GROUP_OF`" and the
   `AppShell.tsx` change. **D-A and D-E move both to Phases 2–4**, which add each entry together
   with its route. Phase 1 adds no href and touches no app-shell file.
2. The delta's §6 table lists `navForRole` under Phase M. Phase M was implemented and frozen
   **without** it, so the function lands in Phase 1 instead.
3. The delta says a `COLLEGE`-only tenant's nav is the "college list". In Phase 1 it is today's list,
   because the college list is empty by construction (D-A). Not a contradiction — a deferral.

### The reference guarantee has a shelf life

"An absent or `SCHOOL` type returns the original array reference" is a **Phase 1 property only**. It
holds because nothing is marked and nothing is overridden. It stops being true the moment a phase
marks its first item — a marked item is filtered out of some scopes, so the function must return a
copy — or adds its first override. **The first phase to do either must record that change explicitly**
and relax the identity assertion in `scripts/verify-nav-scope.mjs` to a deep comparison, rather than
letting it surface later as an apparent regression.

## 9. Phase 2e decisions (the first nav marking)

Phase 2e is the first content phase: it marks the two college destinations, so this section is the
"record that change explicitly" §8's shelf-life rule asks for.

- **D-2e-1 — the nav layer now filters by tenant type AND mode.** A `requires` marker means "this
  tenant can run this mode, **and** this mode is the active one": a marked item is listed only when
  `hasCollege(normalizeInstitutionType(institutionType))` holds and `requires === normalizeMode(mode)`.
  Absent and unknown types normalize to `SCHOOL`, so they never qualify. **This supersedes Phase 1's
  "the nav layer filters by MODE only"** (stated in `navForRole`'s comment and in
  `scripts/verify-college-gate.mjs`), which was sufficient only while nothing was marked — it leaned
  on `resolveActiveMode()` already coercing a `SCHOOL` tenant to `SCHOOL`. The type half is defence in
  depth: a stale `ss_mode` cookie can no longer surface a college link to a school tenant. Mode stays
  UI context and never authorization — `can()` and `requireCollege()` remain the only enforcement.
- **D-2e-2 — the first `requires:"COLLEGE"` markers.** `/dashboard/departments` and
  `/dashboard/programs`, for `SCHOOL_ADMIN`, `BRANCH_ADMIN` and `REGISTRAR` only (6 markers), both
  mapped to `academics` in `SCHOOL_GROUP_OF`. No other href, mode, role or group is marked, and D-B
  still holds: every unmarked item is visible in every mode.
- **D-2e-3 — `navForRole` returns a copy wherever it filters.** The "original `NAVS[role]` array
  reference" guarantee of §8/D21 is now conditional, not permanent: it survives for the six roles
  that carry no college item, and for the three that do the function must return a fresh array in
  every scope, because a dropped item cannot be filtered in place. "Unchanged" for a school tenant
  is therefore **content** (href, label, order and group membership), still proved item-for-item
  against the frozen pre-Phase-1 snapshot.
- **D-2e-4 — `verify-nav-scope.mjs` checks 1, 3, 4 and 6 were restated, not only check 3.** §8
  anticipated relaxing the identity assertion; in practice **four** checks asserted Phase-1-only
  no-op properties and each failed independently the moment an item was marked — check 1 ("nothing
  carries a `requires` marker"), check 3 (identity for the no-op scopes), check 4 (absent values
  return the registry array by reference) and check 6 ("the registry grouping equals the snapshot").
  All four now assert the post-marking invariant, and each is **stricter** than what it replaced:
  check 1 fails unless the marked set is exactly the 2 hrefs × 3 roles, all `requires:"COLLEGE"`;
  check 3 additionally proves every school-only scope — school mode **or** a non-college-capable type
  — still equals the frozen snapshot; check 4 proves an absent type in COLLEGE mode hides every
  college item; check 6 proves every visible college item is grouped in `academics` and that the
  groups remain an exact partition of the injected list. No assertion was deleted or weakened.
