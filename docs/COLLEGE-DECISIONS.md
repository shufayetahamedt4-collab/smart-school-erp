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

## 10. Phase 3 decisions (courses before terms, and the re-scoping of plan-Phase-3)

Phase 3 delivers the **academic catalogue under a program**: courses, the program→course mapping,
and the program's term shape. It delivers **no** course registration, **no** student enrolment,
**no** attendance, **no** grading and **no** fees. This is a deliberate **re-scoping** of
`docs/COLLEGE-PLAN-DELTA.md` §6, recorded here because the delta's own table still reads as if the
next step were "semester = extended class".

- **D-3-1 — the catalogue precedes the term rows, and the delta's Phase 3 is deferred.** The delta's
  **Phase 3** ("semester = extended class, per-program ladder") is **deferred to Phase 5**; its
  premise — that `classes` carry a stored `mode` — does not hold (see the corrections below). The
  **catalogue half** of the delta's **Phase 4** ("courses") is **pulled forward** into Phase 3; the
  *registration* and *approval* halves stay in Phase 4. The delta's requirement to add `mode` to
  `subjects` is **dropped**: courses are a separate, program-owned collection and inherit the college
  context from their program, so no school subject file is touched.
- **D-3-2 — a term is an INTEGER in Phase 3.** `programCourses.termNumber` and (later)
  `students.termNumber` are plain integers validated against the program's derived term count. There
  is **no `programTerms` collection** in Phase 3. Term **rows** arrive in Phase 5 together with the
  promotion ladder, when a term needs its own dates, registration window and cap. Deriving the term
  list from `termSystem` + `durationYears` is sufficient — and only sufficient — while a term has no
  identity of its own.
- **D-3-3 — Phase 3 touches no school file.** `classes`, `sections`, `subjects`, `students`,
  `attendance`, `students/promote`, `grading`/`grading-store`, `routine`/`timetableSlots` and the
  `exam`/`marks` routes are **not modified** by Phase 3. `students.programId` and
  `students.termNumber` are **deferred to Phase 4 (enrolment)**; the Phase 4 preflight must re-verify
  that adding them then still needs **no backfill** (both nullable, absent meaning "not a college
  student"), the same "missing = the old behaviour" convention as §1 and §4.
- **D-3-4 — the term shape and its guard.** `program.termSystem` is `YEARLY | SEMESTER`, default
  `YEARLY`. It is editable **only while the program has no course mappings**; once a mapping exists
  a `termSystem` change is refused with **409**. Lowering `durationYears` **below the highest mapped
  `termNumber`** is also refused with **409** — never silently orphan a mapping. Raising
  `durationYears` stays allowed while it is within the existing `1..6` bound.
- **D-3-5 — `DIPLOMA` default duration.** The program form's `SUGGESTED_YEARS` gains
  `DIPLOMA` → **2**, alongside the existing level defaults (HSC 2, Degree 3, Honours 4, Masters 1).
  This is a **form default only** — the API still accepts any whole number in `1..6`.
- **D-3-6 — courses are a SEPARATE collection (Option A).** A `courses` collection, program-scoped,
  with an **optional** `creditHours`, is chosen over a `subjects` type flag: it keeps every school
  code path (`subjects`, marks, routine, exams) byte-identical, which is the whole point of this
  phase. **OPEN DECISION, to be locked before Phase 4:** whether college **marks** and **attendance**
  attach to a `course` or keep using the school `subject` spine. The standing preference is
  **separate college collections** (e.g. `courseAttendance`) and **never** altering the school
  `attendance` key — `attendance` is upserted on a `studentId_date` unique key, so one row per pupil
  per day; per-course attendance cannot be retro-fitted onto it without breaking school attendance.

### The reconciled phase list (single source of truth)

| Phase | One-line scope |
|---|---|
| **3-pre** | The college-route guard: one exported list of college API segments, plus an offline verifier that fails when a listed handler omits `requireCollege` first, or when an unlisted college directory appears. |
| **3a** | The data layer: `courses` (and `programCourses`) in `COLS`/`RELS` with hand-written accessors; the `courses` permission module and its `can()` assertion. |
| **3b** | The course catalogue API — program-scoped, `requireCollege` first, 404 on a foreign id, 400 on a foreign id in a body, audit rows. |
| **3c** | The program's term shape and the program→course map: `program.termSystem`, derived terms, `programCourses`, and the `PATCH`/`DELETE` guards of D-3-4. |
| **3d** | The college course/department/program pages, the nav item behind `requires:"COLLEGE"`, the school-nav deep-equal snapshot, a production-less `next build`, and screenshots. |
| **3e** | Isolation proof: fixture and tenant/branch harness additions, **baseline first**, the same shape as Phase 2h. |
| **4** | Course registration + approval (the delta's Phase 4 remainder), and `students.programId`/`termNumber` at enrolment. |
| **5** | Terms as rows: `classes` gain their program/term identity and the per-program promotion ladder (the deferred delta Phase 3). |
| **6** | Credit-weighted GPA/CGPA + transcript (the delta's Phase 5). |
| **7** | College fee basis (the delta's Phase 6). |
| **8a/8b/8c** | College dashboard / reports / import (the delta's Phase 7a/7b/7c). |

The delta's phase numbers are kept where the scope is unchanged and renumbered only where the scope
moved, so no phase silently changes meaning.

### Corrections to `docs/COLLEGE-PLAN-DELTA.md`, recorded deliberately

Three statements in the delta are contradicted by the shipped code or by the repository itself. They
are corrected here so a later reader does not inherit them:

1. **`classes.mode` does not exist.** The delta's §6 says the delta's Phase 3 needs it ("Classes need
   `mode`"), and its §3 describes `mode` as stored on `classes`/`subjects`/`students`. **No such field
   exists:** `src/app/api/classes/route.ts` creates `{ schoolId, name, order, branchId }`, and
   `RELS.classRoom` in `src/lib/db.ts` lists school/sections/students/assignments/routines/homeworks/
   exams only. Phase M shipped **key-scoping** (`modeScopedKey`, `currentSessionKey`) and the cookie
   model, **not** stored `mode` on core rows — which §4 of this document already calls "a later
   phase". Deferring the delta's Phase 3 is therefore safe, *provided* this is recorded, which it now
   is.
2. **"The data layer pushes only one equality filter to Firestore" is outdated.** The delta's §3
   uses it to justify storing `mode`. `src/lib/query-diagnostics.ts` `pushdownConditionsFor` pushes
   **every** scalar equality (and scalar `in`), sorted; a field is skipped only when it names a
   *relation*. The recommendation to store `mode` still stands — the stated *reason* does not.
3. **`docs/COLLEGE-PLAN.md` is absent from this repository.** The plan's own A–I detail was delivered
   as chat prose and never written to disk (see this document's preamble), so the delta's §6 table is
   the **only** in-repo evidence for phases 4–8. Anything in a phase-4+ preflight that depends on
   A–I detail must **re-supply** it rather than recall it.

## 11. Phase 3e decisions (the isolation proof)

Phase 3e delivers **no product surface**. It is the isolation proof the §10 phase table promises:
fixture and tenant/branch harness **additions**, run **baseline first**, in the same shape as Phase 2h —
the college branch confinement already asserted for `departments`/`programs`, now extended to the
catalogue delivered by 3b/3c/3d (`courses` and the `programCourses` mapping). It changes **no**
application source: only `scripts/isolation-fixture.mjs`, `scripts/verify-branch-isolation.mjs`,
`scripts/verify-tenant-isolation.mjs` and this document.

- **D-3e-1 — the baseline is part of the phase, not a formality.** The two isolation harnesses are run
  **unchanged** on a wiped-and-reseeded emulator *before* any edit, and their result is recorded
  (52 pass / 0 fail for `verify-tenant-isolation`, 29 pass / 0 fail for `verify-branch-isolation`).
  A post-edit run is only meaningful against that recorded baseline, and every added assertion must
  show up as an **addition** — no existing 2h or Phase 2 assertion is removed, reworded or weakened.
- **D-3e-2 — the COLLEGE fixture gains three courses and two mappings.** Three `courses` under the
  COLLEGE tenant — one per branch-bound department (A, B) and one under the **branch-less**
  department (the `deptNone` analogue, so a `BRANCH` scope must not reach it) — plus **one mapping per
  branch** (`programCourses` on program A and on program B). The BOTH tenant gains one `courses` row,
  one `programs` row and one `programCourses` row, so the probes have a genuine **foreign** course id
  *and* a genuine **foreign** mapping id to prove as NOT FOUND.
- **D-3e-3 — the branch proof mirrors 2h exactly.** A `BRANCH_ADMIN` sees only its own branch's
  courses; it cannot `PATCH`/`DELETE` another branch's course (403), cannot map into another branch's
  program or remove its mapping (403), and cannot touch the branch-less course (403) — which a
  `SCHOOL_ADMIN` can (200). Mappings follow the **program's** branch, so the mapping guards and the
  program guards agree by construction.
- **D-3e-4 — no 403 oracle.** A foreign-tenant course id or mapping id answers **404** and the foreign
  row is asserted **unchanged**; a foreign `courseId` in a mapping `POST` answers the **same 400** as a
  non-existent id. A caller can never learn, from the status, whether a row exists in another tenant.
- **D-3e-5 — the SCHOOL gate is asserted explicitly.** `verify-tenant-isolation` already sweeps
  `/api/courses` across the fixture school's admin/teacher/student (where a 403 is counted as "no
  access for this role", not as a pass) and now also carries its own explicit assertion that a SCHOOL
  tenant receives **403 with zero data** from `/api/courses` — so a wall of 403s cannot be mistaken
  for a clean pass, and an empty 200 would fail.
- **D-3e-6 — cleanup is proven, not assumed.** `isolation-fixture.mjs clean` gains `courses` and
  `programCourses` in its prefix-sweep `owned` list, and the fixture stays `requireEmulator()`-guarded
  and `zziso-`-prefixed, so a 3e run cannot touch production and leaves no catalogue row behind.

## 12. Phase 4a decisions (the student's college identity at enrolment)

Phase 4a delivers the first half of plan-Phase 4 (`docs/COLLEGE-DECISIONS.md` §10, reconciled table):
an optional **program** and **term** on a student, so the registration phase (4b) knows which term
list applies. It adds no new screen and no new collection — only two nullable fields, one shared
helper, and the guards around them.

- **D-4a-0 — D-3-6 is LOCKED.** The open decision recorded in §10 is now closed at its standing
  preference: college marks and attendance will live in **separate college collections** (e.g. a
  future `courseAttendance`), and the school `attendance` key — upserted on a `studentId_date`
  unique key, one row per pupil per day — is **never** altered. Phase 4 does not depend on that
  work; the decision is recorded here so a later phase does not reopen it.
- **D-4a-1 — `students.programId` / `students.termNumber`, both nullable.** No backfill and no
  migration: a student without a `programId` is simply "not a college student", the same
  `missing = the old behaviour` convention as §1 and D-3-3. Existing rows — and every school
  tenant — are untouched.
- **D-4a-2 — one shared helper, in `src/lib/college-enrollment.ts`.** `resolveCollegeEnrolment()` is
  the single place that decides the college half: it calls `requireCollege({ schoolId })` on the
  **target tenant** first, then validates the program (same tenant, `ACTIVE`), the branch
  (`canAccessBranch`), and the term (via `college-terms.ts`). It lives in `src/lib`, not under a
  college API segment, so `scripts/verify-college-routes.mjs` rule 3 (which forbids a literal
  `requireCollege(`/college-model call in a non-college `src/app/api` directory) stays strict and
  **unexempted** — the `students` routes import the helper and never spell the gate themselves.
- **D-4a-3 — a SCHOOL tenant is refused, never silently ignored.** A request that names a program or
  a term against a tenant with no `institutionType` answers **403** from the gate, exactly like the
  college routes. The helper is invoked **only** when the request names a program or a term, so a
  plain school student create/patch never reaches the gate.
- **D-4a-4 — the school path is byte-identical.** Because the fields are written **only when
  actually set**, a school student's stored document and API response gain no new keys; "absent"
  reads as `null` for the college pages (D-3-3). The school-student POST/PATCH response is captured
  before the change and compared deep-equal after it.
- **D-4a-5 — a program with enrolled students cannot be deleted.** `DELETE /api/programs/[id]`
  answers **400** while any `students.programId` equals the id, the same shape as the
  still-has-mappings guard of Phase 3c — replacing the `LATER PHASE` placeholder comment that stood
  in this exact spot.
