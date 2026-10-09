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
"has college data" real: `schoolHasCollegeData(schoolId)` counts this tenant's **own** departments,
programs and **`courseRegistrations`** with a `schoolId`-scoped query, and fails safe (a store read
error reads as "has data"), so the downgrade is now **blocked** whenever college rows exist and
allowed only when there are none. **Q7 is ANSWERED (2026-10-08)** — see `docs/COLLEGE-PLAN-DELTA.md`
§8 Q7: "no college data" means exactly no **departments**, no **programs** and no
**`courseRegistrations`**, which is what commit `3ba4600` implements. **`courses` and
`programCourses` are *not* counted**, and neither `classes.mode` nor college `mode` rows in
fees/exams are counted, because those fields **do not exist** in this codebase (§10 corrections
below). Superseded wording:
~~`schoolHasCollegeData(schoolId)` counts this tenant's **own** departments and programs with a
`schoolId`-scoped query~~.
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
  **SUPERSEDED 2026-10-08 (ruling):** "deferred to Phase 5" is no longer accurate. Phase 5 is
  **redefined** — it carries the per-program promotion ladder for **college students**, advancing
  `students.programId`/`termNumber` and reusing the registration permission module — and the delta's
  "semester = extended class" premise is **dropped outright, not deferred**: there are **no term
  rows, no new collection, and `classes` are untouched** (Phase 5 row below).
- **D-3-2 — a term is an INTEGER in Phase 3.** `programCourses.termNumber` and (later)
  `students.termNumber` are plain integers validated against the program's derived term count. There
  is **no `programTerms` collection** in Phase 3. Deriving the term
  list from `termSystem` + `durationYears` is sufficient — and only sufficient — while a term has no
  identity of its own. **SUPERSEDED 2026-10-08 (ruling):** term **rows** never arrive — Phase 5 is
  redefined and introduces **no `programTerms` collection** either. `termNumber` therefore stays an
  integer derived from `termSystem` + `durationYears`, advanced on `students.termNumber` by the
  Phase 5 promotion ladder. Superseded sentence: ~~Term **rows** arrive in Phase 5 together with the
  promotion ladder, when a term needs its own dates, registration window and cap.~~
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
| **5** | **Redefined 2026-10-08 (ruling):** the per-program promotion ladder for **college students** — advancing `students.programId`/`termNumber` — reusing the registration permission module. **No term rows, no `programTerms` collection, and `classes` untouched.** ~~Terms as rows: `classes` gain their program/term identity and the per-program promotion ladder (the deferred delta Phase 3).~~ |
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

## 13. Phase 4b decisions (course registration + approval)

Phase 4b delivers the second half of plan-Phase 4 (`docs/COLLEGE-DECISIONS.md` §10, reconciled
table): the registration and approval of a student for a programme's mapped courses. It is **API
only** — no page, no nav entry, no fixture or isolation change (those are 4c and 4d). It adds a new
collection `courseRegistrations`, a dependency-free status machine, one permission module, and two
route files.

- **D-4b-1 — the status machine is one module.** `src/lib/registration-status.ts` is the ONE place
  that defines PENDING/APPROVED/REJECTED, and `isBlockingRegistration(status)` (PENDING or APPROVED)
  is the single rule behind every guard below — so "a REJECTED row never blocks anything" is stated
  once. It is dependency-free, like `college-terms.ts`, and `scripts/verify-registration-status.mjs`
  pins it offline.
- **D-4b-2 — the `registration` permission module.** `MATRIX.registration` gives `SCHOOL_ADMIN`,
  `BRANCH_ADMIN` and `REGISTRAR` **`full`** — a registrar creates a registration AND approves it, so
  all three college-facing roles manage the whole lifecycle. No student self-service in this phase.
- **D-4b-3 — the row.** `courseRegistrations`: `schoolId`, `branchId`, `studentId`, `courseId`,
  `programId`, `termNumber`, `status`, `requestedById`, `decidedById`, `decidedAt`. `programId` is
  repeated (not only reached through the student) and `branchId` is **stored**, inherited from the
  student's programme exactly as a course inherits its department's branch — so branch scoping
  (`scopeWhere`) and `canAccessBranch` filter the row directly. A branch-less programme yields a
  branch-less row, reachable only by a school-scope session.
- **D-4b-4 — the server derives programme and term.** The request names `studentId` + `courseId`
  (and an optional `termNumber`). `programId` comes from the student's enrolment (4a) and
  `termNumber` from the programme→course mapping (3c); an explicitly supplied `termNumber` that
  disagrees is a **400**, never silently ignored. The student's OWN `termNumber` is not required to
  match — any term the course is mapped to is allowed.
- **D-4b-5 — one duplicate rule.** `(studentId, courseId, termNumber)` is unique among the rows that
  still hold a place (PENDING/APPROVED) — a second one is **409**. A REJECTED row never blocks a
  re-registration for the same triple.
- **D-4b-6 — approval is a status transition, and decided is terminal.** `PATCH` decides a PENDING
  row (`APPROVED`/`REJECTED`) and writes `decidedById`/`decidedAt`; a decided row answers **409**.
  `DELETE` withdraws a PENDING row; deleting an APPROVED/REJECTED row is **409**. There is no re-open
  of an APPROVED row in this phase.
- **D-4b-7 — the guard order, `requireCollege` first.** Every handler: session (401) → target
  `schoolId` (400) → `requireCollege` on the TARGET tenant (403) → `can(role, "registration", …)`
  (403) → `writeGuard` on mutations (402) → load-by-id with `row.schoolId === schoolId` else **404**
  → `canAccessBranch(row.branchId)` (403). A foreign/missing `studentId`/`courseId` in a BODY is the
  **same 400** as a non-existent id — never a 404 oracle.
- **D-4b-8 — an un-enrol or a programme change is refused while a registration holds a place.**
  The rule lives in `src/lib/college-enrollment.ts` (`guardProgramChange`), so the `students` routes
  call only the helper and never name a college model — `scripts/verify-college-routes.mjs` check 3
  stays strict and unexempted. It changes Phase 4a-2 behaviour: `PATCH { programId: null }` is now
  **409** (instead of 200) when a PENDING/APPROVED registration exists; REJECTED does not block, and
  a student with no registrations is unchanged.
- **D-4b-9 — a mapping or a course cannot be deleted under a registration.** The program→course
  mapping `DELETE` answers **400** while a PENDING/APPROVED registration exists for that
  (programme, course, term); `DELETE /api/courses/[id]` answers **400** while a PENDING/APPROVED
  registration references the course (defence in depth). REJECTED does not block.
- **D-4b-10 — a dangling course never crashes a read.** A course deleted after its mapping was
  removed can still be referenced by a REJECTED row; the list and the one-row `GET` return the row
  with the course shown as unavailable (`courseAvailable: false`).
- **D-4b-11 — student DELETE is blocked while a registration holds a place (closed by 4b-2).**
  `DELETE /api/students/[id]` returns **409** while the student has a PENDING or APPROVED
  registration; REJECTED rows do not block and are left in place. The guard is a college-side helper
  in `src/lib/college-enrollment.ts` (`guardStudentDelete`) that decides from the TARGET tenant's
  `institutionType`, so the students route still names no college model (D-4b-7) and a SCHOOL
  tenant's student DELETE is byte-identical — one extra `schools` read to learn the type, and the
  `courseRegistrations` collection is never read for a non-college tenant. The dangling-read rule
  (D-4b-10) still keeps a leftover REJECTED row harmless.
- **D-4b-12 — no SCHOOL path is altered.** `db.ts` (COLS/RELS/prisma), `permissions.ts`
  (`ModuleKey`/`MATRIX`) and `college-routes.ts` (`COLLEGE_API_SEGMENTS`) change **additively** only;
  `subjects`/`mode` and the school `attendance`/marks spine are untouched (D-3-6 stays locked). The
  school-student POST/PATCH response is captured before the change and compared deep-equal after.

## 14. Phase 4c decisions (the registration page + nav)

Phase 4c is the UI half of plan-Phase 4 (`docs/COLLEGE-DECISIONS.md` §10): the `/dashboard/registration`
page and its nav entry. It changes **no API, no `db.ts`, no `permissions.ts` and no fixture** — the 4b
API already exposes everything the screen needs (`GET`/`POST /api/course-registrations`,
`PATCH`/`DELETE /api/course-registrations/[id]`), alongside the existing `GET /api/students` and
`GET /api/programs/[id]/courses`.

- **D-4c-1 — one page, one href.** `src/app/dashboard/registration/page.tsx` is reachable at
  `/dashboard/registration`; its nav item carries `requires:"COLLEGE"` for exactly `SCHOOL_ADMIN`,
  `BRANCH_ADMIN` and `REGISTRAR`, grouped under `academics` in `SCHOOL_GROUP_OF` — the same shape
  `/dashboard/courses` took in 3d (D-2e-2).
- **D-4c-2 — the page gates before it reads.** Session loading → non-college refusal → role refusal
  (`can(role, "registration", "view")`), each BEFORE any request, so a SCHOOL tenant (including on a
  cold `ss_me_v1` cache) and a role without the permission reach the network for nothing. The API
  remains the real gate (`requireCollege` + `can`).
- **D-4c-3 — create derives programme and term.** The picker reuses `GET /api/students` (tenant +
  branch scoped via `scopeWhere`) and renders only name, admission number and programme; the page then
  loads only that programme's mapped courses (`GET /api/programs/[id]/courses`) and POSTs
  `{ studentId, courseId }`. The term shown is the mapping's term and is never sent — the server
  derives it (D-4b-5).
- **D-4c-4 — filters are client-side.** Programme, term, status and student-name filtering all run in
  memory over the single tenant/branch-scoped list; the list API is used unchanged.
- **D-4c-5 — PENDING acts, terminal rows do not.** Approve/Reject/Withdraw are offered only on a
  PENDING row; APPROVED and REJECTED are terminal (the server answers 409) and no re-open is built —
  a rejected attempt is a NEW registration, which the duplicate rule already allows (D-4b-6).
- **D-4c-6 — a dangling row is readable, not actionable.** `studentName: null` renders as
  "— (student deleted)" and `courseAvailable: false` marks the course unavailable with the row's
  actions disabled — D-4b-10 and D-4b-11 carried through to the screen, never a crash.
- **D-4c-7 — the school nav is unchanged, proven.** `navForRole` for every role under a SCHOOL tenant
  and a BOTH tenant in SCHOOL mode is snapshotted before the nav edit and compared deep-equal after;
  the two nav verifiers gain the new href in `COLLEGE_HREFS` and nothing else, and the frozen
  `nav-scope-snapshot.json` is untouched.

## 15. Phase 5a decisions (the per-program promotion ladder — pure logic)

Phase 5 was **redefined** by ruling (recorded in §10 and in `docs/COLLEGE-PLAN-DELTA.md` §6): the
per-program promotion ladder for **college students**, advancing `students.programId`/`termNumber`.
**No term rows, no new collection, and `classes` untouched.** Phase 5 is staged 5a → 5b → 5c:

- **5a (this section)** — the pure ladder logic plus an offline verifier. No route, no UI, no write.
- **5b** — the promotion API: a preview, then an apply, in a **new college API segment**
  `college-promotion` (added to `COLLEGE_API_SEGMENTS`).
- **5c** — the page and its nav item, at a **new href** `/dashboard/college-promotion`.

The decisions below were taken up front and are **final**; 5a implements the pure half of them.

- **D1 — the API lives in a NEW college segment.** `src/app/api/college-promotion/…`, added to
  `COLLEGE_API_SEGMENTS` in the same change that creates it (the 3b/4b precedent). It is **not** a
  branch of `/api/students/promote`: `scripts/verify-college-routes.mjs` check 3 forbids a
  non-college `src/app/api` directory from touching `prisma.program`, so the ladder's DB half cannot
  live in the school route's directory.
- **D2 — no marker field and no retain.** Idempotency is **structural**: the cohort is defined by an
  exact `termNumber`, so after an advance a re-run of the same `fromTermNumber` selects nobody. There
  is **no** `promotionSessionId`-style marker for the ladder, and **no `retain` action** in Phase 5.
- **D3 — the cohort is strict.** A student is in the cohort only when `programId` **and**
  `termNumber` both equal the target position.
- **D4 — only students with a programme.** A student with no `programId` is never promoted by the
  ladder; the **school ladder is untouched** and keeps selecting every student of a class by
  `classId`. Because `POST /api/students` writes `classId` and `programId` independently, one student
  may hold **both**, so the preview must **warn** about every cohort member that also holds a
  `classId` — an operator then sees that the school ladder may move the same student too.
- **D5 — the last term graduates.** At the programme's final term the action is `graduate` and the
  caller stamps `status = "ALUMNI"` (the school ladder's existing terminal value). A graduating run
  is reported separately in the preview (`graduating`), and a graduating row carries no destination
  term.
- **D6 — course progress is not consulted.** No pass/fail or completeness rule exists for college
  students (college marks are deferred and locked to separate collections, D-3-6 / D-4a-0). The
  preview may show a student's **pending-registration count as information only** — it never excludes
  anybody and never blocks a promotion.
- **D7 — registrations are untouched.** A promotion writes only the student's own fields; existing
  `courseRegistrations` rows keep their `termNumber`, and nothing is carried forward or reset. (The
  duplicate rule is per `(studentId, courseId, termNumber)` — D-4b-5 — so the next term's
  registrations are new rows.)
- **D8 — a NEW href for the college ladder.** `/dashboard/college-promotion`, `requires:"COLLEGE"`
  for `SCHOOL_ADMIN`, `BRANCH_ADMIN` and `REGISTRAR`, grouped `academics` (5c). The school
  `/dashboard/promotion` item is left exactly as it is.
- **D9 — the ladder is independent of the academic session.** A term advance has no `sessionId`
  dimension and no target session; terms are positions on a programme, not calendar rows.
- **D10 — the write path mirrors the school ladder.** The 5b route uses `audit(…)`,
  `invalidateStats`, `invalidateReferenceCache` and ≤400-operation `prisma.$transaction` slices,
  exactly as `students/promote` does.
- **D11 — the ladder's isolation checks live in its OWN new verifier.** The new branch/tenant
  isolation checks are added to the ladder's API verifier, **not** to
  `verify-tenant-isolation.mjs` / `verify-branch-isolation.mjs`, so the established counts (75 / 52)
  stay identical.

**Consequence of the permission ruling:** Phase 5 reuses the **`registration`** permission module (no
new module, so `MATRIX`'s frozen inventory is unchanged). `MATRIX.registration` is `full` for
`SCHOOL_ADMIN`, `BRANCH_ADMIN` **and** `REGISTRAR`, so **a REGISTRAR may apply** a promotion — unlike
the school ladder, which gates on `studentTeacherInfo`.

### 5a — what was built, and what it deliberately does not touch

`src/lib/college-promotion.ts` is the pure ladder: it takes a programme's `termCount` (derived by
`college-terms.ts` and **passed in** — never re-implemented here, which is the drift that module's
header warns against) and a cohort of students, and decides each student's action (D5) and
non-action. It is **dependency-free** like `college-terms.ts`, `registration-status.ts` and
`institution.ts` — no `import`, no prisma, no `node:`, no React — so the verifier, a client component
and Edge code can all import it.

It does **not** touch `src/app/api` (no route yet), `src/components/nav.ts`, `src/lib/permissions.ts`,
`src/lib/db.ts` (no collection, no `COLS`/`RELS` entry), `src/lib/college-routes.ts`, `classes`, or
`src/app/api/students/promote`.

`scripts/verify-college-promotion-logic.mjs` is **offline** (no `requireEmulator()` guard) and pins the
module in exactly **12 checks**: the no-import property, the two-action inventory (no `retain`), the
absence of any marker/session surface, the term tables, the strict cohort, the `classId` warning, the
info-only pending count, the preview tallies and the `graduating` rule, and purity (no mutation, no
registration/session surface).

## 16. Phase 5b decisions (the promotion API — preview and apply)

Stage 5b implements the API half of the ladder decided in §15. **D1–D11 stand unchanged**; what
follows records how each decided rule is kept, and the contract 5c builds on.

**The surface.** `src/app/api/college-promotion/route.ts` — a new college API segment,
`college-promotion`, added to `COLLEGE_API_SEGMENTS` in the same change that creates it (D1). Two
handlers:

- `GET /api/college-promotion?programId=<id>&fromTermNumber=<n>` → the preview: the programme, the
  position, `termCount`, `graduating`, the cohort `rows` (each with `action`, `toTermNumber`,
  `graduating`, `classIdWarning`, `pendingRegistrationCount`), `count` and the `counts` tallies. All of
  it comes from `buildCollegePromotionPreview` in `src/lib/college-promotion.ts`; the route supplies
  only the derived term count and the rows.
- `POST /api/college-promotion` with `{ programId, fromTermNumber }` → apply. The body names a
  **position**, never rows: the cohort is recomputed server-side from `(programId, termNumber)`, so
  client-supplied ids and preview output are ignored by construction.

**Guard order** (mirrors `programs`/`courses`, and is what the offline guard
`scripts/verify-college-routes.mjs` checks statically): `getSession()` → target `schoolId` →
`requireCollege({ schoolId })` (403 for a SCHOOL tenant) → `can(role, "registration", "full")` (403) →
`writeGuard(schoolId)` on POST (PRD §12.1). A **REGISTRAR may therefore apply** (the permission
consequence recorded in §15). Reads are scoped by `scopeWhere` (tenant, plus the session's branch when
it is branch-scoped), and a branch admin cannot reach a programme outside its branch
(`canAccessBranch`).

**How each decision shows up in the code.**

- **D2/D3 — strict cohort, no marker.** The cohort is one `prisma.student.findMany` with `programId`
  **and** `termNumber` equality (plus `ON_ROLL_STUDENT`); after an advance nobody remains at
  `fromTermNumber`, so a re-run selects nobody. There is no marker field, no `retain`, and no
  `excludeIds`/`graduateIds` in the contract.
- **D4 — the school ladder is untouched.** The route never selects on `classId`; it carries
  `classIdWarning` through the preview so an operator sees that a student in both ladders may be moved
  by `/api/students/promote` as well.
- **D5 — the last term graduates.** When `fromTermNumber === termCount` the write is
  `{ status: "ALUMNI" }` (the school ladder's existing terminal value) and the response reports
  `graduating: true` with `toTermNumber: null`.
- **D6 — course progress is info only.** `pendingRegistrationCount` is per student, **term-filtered**,
  and counted from the programme's PENDING registrations at that position; it never removes anybody
  from the cohort and never blocks the run.
- **D7 — registrations are untouched.** A promotion writes only `termNumber` (or `status`); every
  `courseRegistration` keeps its own programme, term and status.
- **D9 — no session coupling.** No `sessionId` is read or written, and there is no target session.
- **D10 — the write path mirrors the school ladder.** Queued `prisma.student.update` operations are
  flushed with `prisma.$transaction` in ≤400-operation slices, then `audit("COLLEGE_PROMOTION", …)`,
  `invalidateStats(schoolId, "students")` and `invalidateReferenceCache(schoolId)`.

**What 5b deliberately does not touch.** `src/lib/college-promotion.ts` (unchanged — no bug was
found), `src/app/api/students/promote` and therefore the school ladder's behaviour, `classes`,
`src/lib/permissions.ts` (no new module), `src/lib/db.ts` (no collection, no `COLS`/`RELS` entry),
`src/components/nav.ts`, and the two isolation harnesses. Because the ladder's own branch/tenant
checks live in its own verifier (D11), `verify-tenant-isolation.mjs` and `verify-branch-isolation.mjs`
were **not** edited and keep their 75 / 52 counts exactly.

**Its verifier.** `scripts/verify-college-promotion-api.mjs` is emulator-backed (HTTP against the
COLLEGE fixture tenant) and pins the API in exactly **47 checks**: the preview shape; the strict
cohort (another term, ALUMNI/TRANSFERRED and another tenant's rows all excluded); the `classId`
warning and the info-only, term-filtered pending count; branch confinement (a branch-A admin's cohort
excludes a branch-B student of the same programme, and it cannot reach a branch-B programme); the 400s
(missing programme/term, `0`, past the end, non-numeric, and a FOREIGN programme id byte-identical to
a ghost — never a 404 oracle); anonymous 401 / wrong-role 403; a SCHOOL tenant 403 with zero rows
written, and a refused apply writing nothing at all; the advance (a branch admin moves only its own
branch, then the school-scope admin moves the remaining row); the structural no-op re-run;
registrations untouched; and the last-term graduation to ALUMNI applied by a REGISTRAR, with a re-run
graduating nobody. It creates and removes every row it writes (a `zzcp-` prefix) — including the audit
rows its own programme creates produced — and leaves nothing behind. (The count has since grown: 5b-2
added two document-count checks, 47 → 49, and 5b-3 added the shrink-guard checks — see §17.)

## 17. Phase 5b-2 / 5b-3 decisions (refusal proofs + the programme shrink guard)

Phase 5b-2 and 5b-3 close the four items the Phase 5b audit left open (Q1–Q3). The rulings are
recorded here as the decisions; **5c is not started**.

**Q1 — the pending-registration figure stays ROW-BASED (option a).** `pendingRegistrationCount`
counts PENDING `courseRegistrations` **rows** at the position — a count of course requests, not of
students — and it is INFO ONLY (D6): it never blocks a promotion and it does not follow the student.
No route or module changes. **For 5c, label it "pending course requests"** (not a student count) in
the UI, so a student holding two PENDING rows reads as two.

**Q2 — the "writes nothing" proofs also count documents (5b-2).** The two refusal checks ("a
REFUSED apply writes nothing" and "a SCHOOL tenant's apply writes zero rows") now also bracket the
refused request with a **tenant document count** — `students`, `programs`, `courseRegistrations` and
`auditLogs` (excluding `action: "LOGIN"`, which the verifier's own five sign-ins write) — so a stray
create or destroy shows up even when no tracked field changed. This is a **verifier-only** change
(`scripts/verify-college-promotion-api.mjs`); no `route.ts` and no `college-promotion.ts` file moved.
47 → 49 checks.

**Q3 — issue 1 is fixed: a programme shrink may not strand an on-roll student (5b-3).** In
`PATCH /api/programs/[id]`, a change that **LOWERS** the programme's derived term count is now
refused with **409** while any ON-ROLL student of that programme still sits beyond the new last term.

- **The derivation is cited, not re-implemented.** The term count is
  `termCount(durationYears, termSystem) = durationYears × termsPerYear(termSystem)`
  (`src/lib/college-terms.ts`) — one term per year YEARLY, two SEMESTER. The guard compares the
  **current** count with the **effective** count (the request's `durationYears`/`termSystem` merged
  over the stored row) and fires only when `next < current`.
- **The student set.** One `prisma.student.findMany` scoped to the programme's `schoolId` **and**
  `programId`, with `ON_ROLL_STUDENT` reused verbatim (`src/lib/db.ts`: `status` notIn
  `ALUMNI`/`TRANSFERRED`) — so ALUMNI and TRANSFERRED never block. Any `termNumber > nextTermCount`
  refuses; branch confinement is unchanged (enforced earlier on the programme by `canAccessBranch`).
- **The message names the new last term and the count:** e.g. `This would end the programme at Year 2
  (2 term(s)), but 1 on-roll student(s) are already beyond it. Move them within the programme first.`
- **Order and blast radius.** The guard runs **after** the Phase 3c mapping-aware guard (kept exactly
  as it was, order included) and before the write, so a bad body is still a 400 and a mapped programme
  still answers the mapping 409 first. No other behaviour of the route changed (create, delete, other
  fields, permission order, response shapes).
- **Q3 issues 2, 3 and 4 are deliberately NOT changed.** The SUPER_ADMIN 400 vs sibling `?schoolId=`
  inconsistency stays as is; the cosmetic "1 to 0" 400 message stays as is; the read-cost note needs no
  change now.

**Its verifier additions (5b-3).** `scripts/verify-college-promotion-api.mjs` gains the shrink-guard
section: 409 + nothing written when an on-roll student sits beyond the new end; 200 when nobody is
beyond; 200 when only ALUMNI/TRANSFERRED are beyond; 200 when growing; the FOREIGN programme still
404 on PATCH and a branch-A admin still 403 on a branch-B programme. The verifier now runs exactly
**61 checks** (47 → 49 in 5b-2, → 61 in 5b-3) and still leaves zero `zzcp-` rows behind.

**What 5b-3 does not touch.** `students/promote`, `classes`, `college-routes.ts`, `permissions.ts`,
`nav.ts`, `db.ts` (no collection/`COLS`/`RELS` entry), `college-promotion.ts`, the two isolation
harnesses (75 / 52 unchanged) and every other verifier — the existing programs/college verifiers keep
their counts exactly.

## 18. Phase 5c decisions (the college promotion page + nav)

Phase 5c is the UI half of plan-Phase 5 (§15): the `/dashboard/college-promotion` page and its nav
entry. It changes **no API** — the 5b ladder (`GET`/`POST /api/college-promotion`) already exposes
everything the screen needs — and touches no `db.ts`, `permissions.ts`, `college-routes.ts`,
`college-promotion.ts`, programs route, school promote route or class model.

- **D-5c-1 — one page, one href.** `src/app/dashboard/college-promotion/page.tsx` is reachable at
  `/dashboard/college-promotion` (D8); its nav item carries `requires:"COLLEGE"` for exactly
  `SCHOOL_ADMIN`, `BRANCH_ADMIN` and `REGISTRAR` — the three roles that hold `registration` **full**
  (§16) — and is grouped under `academics` in `SCHOOL_GROUP_OF`, the same shape `/dashboard/courses`
  took in 3d and `/dashboard/registration` in 4c. The school `/dashboard/promotion` item is
  untouched.
- **D-5c-2 — the page gates before it reads.** Session loading → non-college refusal → role refusal
  (`can(role, "registration", "full")`), each BEFORE any request, so a SCHOOL tenant and a role
  without the permission reach `GET /api/programs` and `GET /api/college-promotion` for nothing. Both
  ladder handlers need `registration` full (not view), so the page gates on that same level.
- **D-5c-3 — the client sends a POSITION, never rows.** Apply POSTs only
  `{ programId, fromTermNumber }`; student ids and preview output are never sent, because the cohort
  is recomputed server-side (D2/D3). This is what makes a re-run a structural no-op, and it is a
  property of the page, not merely of the route.
- **D-5c-4 — an explicit two-step apply.** The button opens a confirmation dialog that restates the
  programme, the term ("term X of N"), the number of students and whether the run graduates them; only
  then is the POST issued. While in flight the button is disabled (no double-submit). The server's own
  report is shown, then the preview is re-fetched — which is now empty, the cohort having moved off the
  term.
- **D-5c-5 — the preview names the position and the destination.** It shows the programme name and
  "term X of N", the cohort rows, the tallies (`counts.advance` / `counts.graduate`), and the
  destination — the next term, or an explicit **"graduating run"** banner on the programme's LAST term,
  where every row's action is `graduate` (D5). ALUMNI is never mixed with an advance.
- **D-5c-6 — D4 is surfaced per row.** A cohort member that also holds a `classId` is flagged ("also
  enrolled in a school class: school promotion may advance this student too"), so an operator sees
  that the unrelated SCHOOL ladder (`/api/students/promote`) may advance that student as well.
- **D-5c-7 — D6 is labelled as §17 requires.** The pending figure is "pending course requests", never
  "pending students": the per-row line reads "N pending course requests at this term" and the cohort
  aggregate "N pending course requests in this cohort", both carrying the 5c tooltip (one request =
  one course; one student may have several; it is not a student count and does not block or follow a
  promotion). Row-based, per §17 Q1.
- **D-5c-8 — the school nav is unchanged, proven; one verifier list, no new checks.** The new item is
  `requires:"COLLEGE"`, so `navForRole` still yields the frozen pre-Phase-1 list for every school-only
  scope. `scripts/verify-nav-scope.mjs` proves it — its `COLLEGE_HREFS` gains the new href so its
  marked-set invariant stays exact — and that is the **only** verifier changed: **no new checks, count
  still 7**. `verify-college-gate.mjs` (its own frozen list), `verify-college-routes.mjs`, the two
  isolation harnesses (75 / 52) and every other verifier are untouched and keep their counts.

**Verification note (5c).** The existing verifiers are static or HTTP-over-the-API and cannot render a
React page, so the page has **no automated offline coverage**: the ladder's server contract is (the 5b
API verifier, 61 checks), the nav invariants are (nav-scope 7 / college-gate 3 / college-routes 3), and
`tsc` (0 errors) plus the production `next build` (162 → 163 pages, `/dashboard/college-promotion`
prerendered) prove it compiles and builds. The page itself was confirmed by an **interactive browser
check** against the logged-in COLLEGE fixture on `school.localhost:3000`: it rendered at
`/dashboard/college-promotion` with its "College Promotion" nav item present, the preview showed the
position ("term 1 of 2"), the tallies, the destination and the cohort row, the confirmation dialog
restated the programme, the term and the student count, the apply returned 200 with the success message
and a re-fetched (now empty) preview with the button disabled, and the final term showed the
**graduating run** banner with `Graduate → ALUMNI` rows — no console or network errors. That check was
**manual and is not part of the suite**, so no automated test guards against a future regression in the
page's markup; that is the honest limit of 5c's verification.

## 19. Phase 5d decisions (the whole-programme ladder)

Phase 5d adds a **whole-programme** run on top of the single-position ladder: ONE request
advances every term's cohort by exactly one step, and the programme's final term graduates. It is a
`GET` plan plus a `POST` run under the SAME `college-promotion` segment, and the 5c page grows one
card that opens the plan for review before anything is written.

- **D-5d-1 — the ordering rule lives on the SERVER, descending.** "Advance every term" must move
  each cohort exactly ONE step. Applying the positions ASCENDING would re-sweep the students it had
  just moved — a student advanced 1 → 2 would be picked up again by the step for term 2 and pushed
  onward, cascading the whole programme to graduation in one run. The run therefore walks the
  positions **descending** (`termCount` first, graduating it, then `termCount-1`, … down to 1).
  Cohorts are disjoint (a student holds exactly one `termNumber`), so walking downward guarantees
  every position sees its ORIGINAL cohort and every student moves exactly once. The rule is **not**
  in the browser: the page sends only `{ programId }`, so a client cannot reorder the ladder.
  **PROVEN** by the API verifier — after a run each cohort has moved exactly one step
  (1→2, 1→2, 2→3, 3→ALUMNI), and a second run moves each ACTIVE student one step more.
- **D-5d-2 — a new route in the SAME college segment.**
  `src/app/api/college-promotion/ladder/route.ts` (`GET` plan + `POST` run). The single-position
  contract of `/api/college-promotion` is untouched, so the 5b verifier's checks are unaffected. The
  new file sits inside the already-listed `college-promotion` segment, so
  `scripts/verify-college-routes.mjs` check 2 (that walk is recursive) gates it: 10 → **11 route
  files**, 22 → **24 gated handlers**, the guard's own check count still 3. No edit to
  `college-routes.ts` was needed.
- **D-5d-3 — the shared DB half is extracted so the cohort rule exists ONCE.**
  `src/lib/college-promotion-server.ts` now holds `resolveProgramme`, `resolveLadder`, `readCohort`,
  `readPendingCounts` and `PROMOTION_BATCH`; both routes import them. A `route.ts` may not export a
  helper for a sibling route (Next.js validates a route module's exports), so the shared code has to
  live outside `src/app/api`. This is a **pure move** of code that lived in
  `college-promotion/route.ts`; that route's behaviour is unchanged, which its checks continue to
  prove. `src/lib/college-promotion.ts` stays import-free (its verifier still fails on an `import`).
- **D-5d-4 — the plan is a preview of EVERY step.** `GET …/ladder?programId=` returns the terms
  ASCENDING, one entry per term with its cohort rows, its destination (the next term, or `null` for
  the graduating step) and the per-step plus aggregate tallies (`advance`/`graduate`/`classIdWarnings`/
  `pendingRegistrations`, the last two carried from D4/D6). A programme with **0** resolvable terms is
  a 400 ("no ladder to run") — the same "cannot decide" reading `college-promotion.ts` gives a 0
  count, never a silent no-op.
- **D-5d-5 — one audit row for the whole run.** The run writes with the 5b path
  (`prisma.$transaction` in ≤400-operation slices) but audits ONCE per run (`COLLEGE_PROMOTION` with
  `scope: "PROGRAMME_LADDER"`, `termCount` and the totals), then `invalidateStats` +
  `invalidateReferenceCache`. The per-step report is the response's `steps`, returned ASCENDING for
  the reader; the writes happened descending.
- **D-5d-6 — a ladder re-run is NOT a per-position no-op.** Unlike a single position (whose re-run
  selects nobody, D2), re-running the ladder is a legitimate SECOND advance: it moves every ACTIVE
  student one more step. The verifier pins that — and that ALUMNI/TRANSFERRED stay untouched across
  two runs — instead of asserting an idempotency the operation does not have.
- **D-5d-7 — unchanged surface.** No `db.ts`, `permissions.ts`, `college-routes.ts`,
  `college-promotion.ts`, programs route, school promote route or class model change; the isolation
  harnesses keep 75 / 52 and every other verifier keeps its count (nav-scope still 7,
  college-permissions 7, college-terms 8, promotion-logic 12). The API verifier grows **61 → 84**
  checks (23 new, all in the ladder section).

**Verification (5d).** All of it is HTTP in `scripts/verify-college-promotion-api.mjs`: the plan's
shape and per-step cohorts, the strict/ON_ROLL exclusions, the aggregate tallies, the per-step guards
(anonymous 401, ACCOUNTANT 403, SCHOOL 403, missing/foreign 400, branch confinement), the descending
ordering proved by "moved exactly one step", the untouched ALUMNI/TRANSFERRED students and
registrations, the shifted plan after a run, a second run, and both refusals writing nothing. The new
route is statically gated by `verify-college-routes.mjs`. The page's ladder UI is covered by `tsc`,
`next build` and an interactive browser pass — **not** by the suite.

## 20. Phase 5d-2 decisions (the whole-programme ladder fails safely)

5d shipped the ladder knowing it was **not atomic**: it committed in ≤400-op slices and, if a later
step threw after an earlier one had landed, the run left a partial state, answered an unstructured
500, wrote **no** audit row, and left the UI showing a stale plan — and a re-run then double-advanced
the cohorts that had already moved. 5d-2 fixes the failure path without changing the happy path.

- **D-5d2-1 — NO cap and NO refusal: a ladder of any size must run.** 5d-2 deliberately does **not**
  introduce an "abort before write when the run exceeds one batch" rule: a real programme can exceed
  400 students, and refusing to promote them would be a regression. A step's writes still go out in
  ≤400-op slices (D10), so a 405-student term is written as 400 + 5. **PROVEN** — the verifier builds
  a 2-term programme with **405** students at term 1 and 1 at term 2 and the run completes: 405
  advanced, 1 graduated, 0 failed, every one of the 405 ON-ROLL at term 2 and only the term-2
  original retired.
- **D-5d2-2 — flush at the END of each step, never mid-step across a term boundary.** The ops array
  is now per-step: a step collects its own ops and flushes them when the step finishes, so a slice can
  never mix two terms' writes. A step may still need several ≤400 slices (405 students), and that is
  acceptable because the SINGLE-POSITION cohort is idempotent (D2): re-applying a half-written
  position selects only the students still at that term, so it completes the step without advancing
  anybody twice.
- **D-5d2-3 — a mid-run failure is CAUGHT and answered with a STRUCTURED 500.** The response body is
  `{ error: <human report>, data: { programId, termCount, status, promoted, graduated, failed,
  completed[], failedStep, remainingTerms[], finishTerms[], reason } }`, where `completed` are the
  steps that landed (term + advanced/graduated counts), `failedStep` is the step whose flush threw,
  `remainingTerms` are the terms never attempted (descending), and `finishTerms` is the descending
  order to complete them. **Status 500, not 207 — and the reason is code, not taste:** the shared
  client (`src/lib/client.ts`) treats every 2xx as success, returning only `body.data` and never
  throwing, so a 207 would silently take the UI's success path and hide the failure; 500 keeps it on
  the error path, and `error` carries the whole report for the operator.
- **D-5d2-4 — the failure is AUDITED, and the success audit grew the per-step breakdown.** The
  success row is now `COLLEGE_PROMOTION` / `scope: "PROGRAMME_LADDER"` / `status: "OK"` with a
  `steps[]` array, so a run is reconstructable server-side. A failed run writes the SAME shape with
  `status: "PARTIAL"` (something landed) or `"FAILED"` (nothing did), plus `completed`, `failedStep`,
  `remainingTerms` and the `reason`. The audit is **best effort**: `audit()` already swallows its own
  failure, and the call is additionally wrapped so an audit problem can never mask the original write
  error. **PROVEN** — after an injected mid-run failure the row exists with `status: "PARTIAL"`, the
  completed term 3 and `remainingTerms: [1]`.
- **D-5d2-5 — the page's error path is not stale.** On failure the page closes the run modal, shows
  the server's structured message, and **re-fetches BOTH the plan and the position preview** — the
  refresh is `{ silent: true }` so it does not wipe the message the run just set. The success path is
  unchanged. The run modal also carries a one-line warning that two runs at once can advance the same
  cohort twice.
- **D-5d2-6 — a partial failure is finished with the SINGLE-POSITION route, descending.** The
  message tells the operator to complete the FAILED term and then the not-attempted terms with
  `POST /api/college-promotion` (descending), and never to re-run the ladder. Re-running the LADDER
  is what double-advances: the steps that landed have moved students into the next term's cohort, so
  a ladder re-run would move them again, whereas the single-position route re-selects only who is
  still at the position (idempotent, D2). **PROVEN** — after the injected failure, applying term 2
  then term 1 completes the ladder with every student moved EXACTLY once (f1→2, f2→3, f3 graduated
  once) and the plan then names exactly those two already-moved students, which is why a ladder
  re-run is forbidden.
- **D-5d2-7 — CONCURRENCY: NO run lock, recorded as a KNOWN LIMITATION.** Investigated read-only:
  `src/lib/db.ts` exposes no create-only and no preconditioned write — `create` is `ref.set(...)`,
  `update` is `set(..., { merge: true })`, `$transaction(array)` is one `WriteBatch`, and its callback
  form is **not** transactional — and a per-programme lock needs exactly that (a create-only claim or
  a compare-and-set with an expiry). Adding the primitive means editing `db.ts` (explicitly out of
  scope for 5d-2) or reaching around the shim with raw Firestore inside a route, which is not "small
  and safe". It was therefore **not built**: two concurrent ladder runs (double-click, two admins, a
  retry) can still double-advance, and that is stated plainly in the run modal. This is a real,
  accepted limitation, not a claim of safety.
- **D-5d2-8 — the forced-failure TEST SEAM is production-inert and not request-reachable.** A
  deterministic mid-run failure cannot be produced over HTTP (every write the ladder makes is a valid
  single-field update), so `ladderFault()` reads a JSON file from the **OS temp directory** naming a
  programme and a term. It is DOUBLE-gated: (1) `NODE_ENV === "production"` returns null before any
  read, so a production build can never inject a fault whatever is on disk; (2) the fault comes from
  a FILE, never from the request — no header, body or query parameter can reach it — and the file
  names the EXACT programme id, so in practice it can only ever be the throwaway programme the
  verifier made. The file is not a build input and lives outside the app. Its effect (500 + structured
  body + audit) is **PROVEN** by the run; its production inertness rests on the `NODE_ENV` guard and
  the absence of any request input, and was **not** executed against a production build.
- **D-5d2-9 — unchanged surface.** No `db.ts`, `permissions.ts`, `nav.ts`, `college-routes.ts`,
  `college-promotion.ts`, programs route, school promote route or class model change, and the
  single-position route's behaviour is untouched (its own 5b checks still prove it). Every other
  verifier keeps its count: `verify-college-terms` 8, `verify-college-gate` 3,
  `verify-college-routes` 3, `verify-college-permissions` 7, `verify-college-enrollment` 40,
  `verify-course-registrations` 50, `verify-registration-status` 9, `verify-nav-scope` 7,
  `verify-tenant-isolation` 75, `verify-branch-isolation` 52, `verify-college-promotion-logic` 12,
  `verify-promotion-rollover` 50 × 10 runs, `tsc` 0 errors.

**Verification (5d-2).** `scripts/verify-college-promotion-api.mjs` grows **84 → 100** checks (16
new): the SUCCESS audit row now carrying `status: "OK"` and the per-step breakdown; the injected
mid-run failure returning HTTP 500 with `status: "PARTIAL"`, the completed term, the failed term and
`remainingTerms`/`finishTerms`, plus an error string that names all three and points at the
single-position route; the failure being audited; the completed step having really landed while the
failed step and the untouched term wrote nothing; finishing with the single-position route and every
student advancing EXACTLY once (no double-advance); and a 405-student ladder completing across more
than one slice. The cleanup check now also fails if the fault file is left behind. The new route logic
stays statically gated by `verify-college-routes.mjs` (11 route files / 24 handlers, unchanged). The
page's error path remains covered by `tsc` and `next build`, **not** by the suite.

## 21. Phase 6-pre decisions (the promotion page verified offline; the ladder made safe)

Phase 5 is finished and pushed (`a770a03`). Four items were still open. Phase 6-pre closes the three
that are code, in **three separate commits**, and defers the fourth:

1. **6-pre 1 (commit 1)** — the promotion page's view logic extracted and verified **offline**.
2. **6-pre 2 (commit 2)** — an atomic per-programme LEASE on the whole-programme ladder (concurrency).
3. **6-pre 3 (this commit)** — refuse a ladder re-run while the last run for the programme is PARTIAL/FAILED.
- **Item 4 is DEFERRED** — `retain` (hold a student at the same term) and the fail/unfinished-course
  rule. The fail half waits for a results/grades phase: no college marks exist today, and college
  marks are locked to separate collections (D6, D-3-6). Nothing in 6-pre builds it.

Scope is fixed across all three commits: **no change** to `students/promote`, `classes`,
`permissions.ts`, `nav.ts`, `college-routes.ts` (no new route is allowed), `college-promotion.ts`,
the programs routes or any school code path, and **no existing verifier changes its count** except
`verify-college-promotion-api.mjs` (allowed to grow) plus the new verifiers. The isolation
harnesses stay at 75 / 52.

### 6-pre 1 — the page's logic, proved offline

- **D-6pre-1 — the page's non-visual decisions live in `src/lib/college-promotion-view.ts`.**
  Which warnings appear, the D6 pending phrasing (and the 1-vs-N singular), the disabled predicates
  and the handler guards, the failure phrasing, the confirmation verb and destination, the server's
  report turned into the operator's sentence, and the list of what the failure path re-fetches. The
  module is **dependency-free** — no `import`, no `require(`, no prisma, no `node:`, no React — the
  same property `college-promotion.ts`, `college-terms.ts` and `registration-status.ts` hold, so a
  verifier, a client component and Edge code can all import it. **PROVEN** —
  `scripts/verify-college-promotion-page.mjs`, 13 checks, offline.
- **D-6pre-2 — the wording did not move in meaning.** Every string the module now owns is
  **byte-identical** to the literal it replaced in the page (26 fragments checked against
  `git show HEAD:`), so this is a move, not a rewrite: the rendered text is unchanged.
- **D-6pre-3 — the page must be seen to CONSUME the module.** The verifier fails if the page stops
  importing the module, stops using its names, or re-inlines a literal the module owns — so the
  extraction cannot silently regress into a duplicate copy that drifts.
- **D-6pre-4 — a REAL BROWSER TEST IS STILL NOT DONE, and §21 says so plainly.** Nothing here mounts
  the page: the verifier has no DOM, no React, no browser and no server, and no browser driver is a
  dependency of this project (adding one means a new dependency *and* a browser download). **PROVEN**:
  the page's logic. **NOT PROVEN**: that the page renders, that a click issues the right request,
  that a real sign-in reaches it, or that the API round trip behaves in a browser. Extracting the
  logic narrows what an untested UI can get wrong; it does not replace that test.

**Verification (6-pre 1).** New: `scripts/verify-college-promotion-page.mjs` — **13 checks**, offline
(no emulator guard). Nothing else can move by construction: the new module is imported by one client
component and one new offline script, and no route, `db.ts`, collection or schema is touched.
`tsc` 0 errors; `next build` 164/164 (unchanged). Every existing verifier was re-run and kept its
count: enrollment 40, course-registrations 50, registration-status 9, tenant 75, branch 52,
college-gate 3, college-permissions 7, college-routes 3, nav-scope 7, college-terms 8,
promotion-logic 12, promotion-api 100, promotion-rollover 50 × 10 runs.

### 6-pre 2 — the whole-programme ladder's lease

- **D-6pre-5 — ONE new primitive, ONE new collection, and nothing else.** `src/lib/db.ts` gains
  `$claim` (with its `ClaimResult` type) plus the `promotionRun` → `promotionRuns` `COLS` entry and
  the matching `prisma.promotionRun` model. That is the whole exception, granted for this commit
  only: `create`, `update`, `upsert`, `$transaction`, every existing `COLS`/`RELS` entry and every
  existing exported symbol are untouched, so every school code path is byte-for-byte unchanged.
  `$claim` is the one write the shim never had — `create` is `set`, `update` is merge, and the array
  form of `$transaction` carries no read, so none of them can say *take this row ONLY IF it is free*.
  It runs inside a real Firestore transaction (read, then conditional write), so the check and the
  take are one step.
- **D-6pre-6 — the lease is per `(school, programme)`, claimed after every guard and before the
  first cohort read, and released in a `finally`.** One row per pair (its id is a hash of both), so
  a second run of the same programme addresses the same row. A live lease makes the next run a
  **409 with ZERO writes** ("Another run is in progress for this programme."), proved twice: a
  per-student term/status snapshot AND a tenant document count bracketing the refused request. The
  lease lasts `LADDER_LEASE_MS` = **2 minutes** (one constant); a row whose `expiresAtMs` has passed
  is **abandoned, not held**, and may be taken over — a crashed run cannot wedge a programme. The
  claim happens AFTER `requireCollege`/`can`/`writeGuard`, so a 403 takes no lease.
  > **NOTE (2026-10-09, superseded by §22 / D-6pre4-2).** The window is no longer **2 minutes**,
  > and "long enough for a whole run" was the wrong shape: a run could outlive it and be taken over
  > mid-flight, double-advancing a cohort. The run now RENEWS before every step and every ≤400-op
  > slice, and the constant is **30 s** — a window that only has to cover ONE slice. The paragraph
  > above is kept as the history of the decision, not as the current rule. The rest of D-6pre-6
  > (per-programme, claimed after every guard, before the first cohort read, released in a
  > `finally`) still holds.
- **D-6pre-7 — a run that COMPLETED releases the lease, so the next run is still allowed.** The
  `finally` finalises the row on SUCCESS and on FAILURE alike: `status` OK / PARTIAL / FAILED,
  `finishedAt`, `completed[]`, `remainingTerms[]`, `reason` and `releasedAtMs`, with `expiresAtMs`
  cleared. A run after a SUCCESSFUL run therefore stays allowed — the run-#2 check in
  `verify-college-promotion-api.mjs` passes **unchanged** — and a failed run records *why* without
  blocking anything yet (commit 3 reads those fields).
- **D-6pre-8 — a second CONCURRENT run is refused, not queued behind the first, and that is what
  makes the guarantee real.** A lease alone is not enough: the Firestore SDK re-runs a conflicting
  transaction, so a loser would simply wait out the winner's lease and then claim a free row — an
  ordinary second run, advancing the cohort twice. So the claim also refuses a row whose
  `releasedAtMs` is *after* the instant the attempt began: that row was still HELD while this
  request was arriving. A row released BEFORE the attempt began is an ordinary, deliberate re-run
  and is allowed (D-6pre-7). **PROVEN**: two POSTs fired without awaiting give exactly one 200 and
  one 409, and every student advances exactly once.
- **D-6pre-9 — the single-position apply is deliberately NOT leased.** It is idempotent by
  construction (D2/D3) and it is the documented way to FINISH a partially applied ladder, so leasing
  it would break the very recovery the ladder's own structured 500 tells the operator to perform.
  Residual, and recorded rather than hidden: a deliberate single-position apply fired at the same
  moment as a ladder run is still possible — the lease serialises whole-programme runs against each
  other, not against that. **NOT PROVEN**: that a single-position apply cannot interleave with a
  live ladder run.
- **D-6pre-10 — the page's standing warning was made true.** It claimed the opposite of the new
  guarantee ("there is no run lock"); it now states the guarantee, and
  `verify-college-promotion-page.mjs` fails if the old claim returns. The GET plan is unaffected and
  the structured-500 contract is unchanged.

**Verification (6-pre 2).** New: `scripts/verify-college-promotion-lease.mjs` — **40 checks**, over
HTTP, against the isolation fixture, creating and cleaning up all of its own rows (programmes,
students, an ACCOUNTANT, and the lease rows). It was chosen over growing
`verify-college-promotion-api.mjs` so that the established API count stays exactly **100**. Every
existing count is identical to the parent (`5847f26`), measured BOTH ways (parent restored through
`git stash` for the baseline, then the working tree for the after-run): enrollment 40,
course-registrations 50, registration-status 9, tenant 75, branch 52, college-gate 3,
college-permissions 7, college-routes 3, nav-scope 7, college-terms 8, promotion-logic 12,
promotion-api 100, page 13, rollover 50 × 10 runs. `tsc` 0 errors; `next build` 164/164.

### 6-pre 3 — a failed run blocks the ladder until it is finished

- **D-6pre-11 — the failed run's WORK LIST is the rule, and it is recorded, never
  inferred.** The row already carried `completed[]` and `remainingTerms[]`; it now also
  carries `finishTerms[]` — the FAILED term plus the terms never attempted, DESCENDING (the
  documented finishing order). The ladder refuses a re-run while the programme's last run is
  `PARTIAL`/`FAILED` AND that list is non-empty: **409**, naming the outstanding terms and
  telling the operator to finish with the single-position route, descending. The decision comes
  from the row's own writes and deliberately NOT from a student's `termNumber`: the finishing
  walk RE-FILLS the terms below it (apply term 1 and students sit at term 2 again), so a term
  number cannot tell "not finished" from "finished and refilled".
- **D-6pre-12 — the single-position route strikes off the term it applied, and THAT is how the
  block lifts.** After a successful apply, `markProgrammeTermFinished` removes that term from
  the row's `finishTerms`; when the list empties the row becomes `OK` (`resolvedAt`,
  `resolvedBy: "SINGLE_POSITION"`) and the ladder is allowed again. It changes NOTHING about
  that route: it runs after the apply has written and audited, it only ever touches a row whose
  status is `PARTIAL`/`FAILED`, only a term that is actually on the list (a re-apply is a
  no-op), and it swallows every error — the route's behaviour, audit and response stay
  byte-for-byte as before. **PROVEN**: after a forced failure the ladder is 409 with zero
  writes; applying the failed term strikes it off and the block STANDS; applying the last
  outstanding term unblocks it, and every student ends advanced exactly once.
- **D-6pre-13 — the block is checked AFTER authorization and BEFORE the lease.** An
  unauthorized caller still gets its 403 (it must never learn a programme's run state), a
  blocked request takes no lease and writes nothing, and the check cannot be fooled by a race:
  the lease release and the `PARTIAL` status are the SAME update, so a row this read sees as
  free is a row whose status is already settled.
- **D-6pre-14 — only PARTIAL/FAILED blocks, and only while work is outstanding.** A clean `OK`
  run records an empty list, so run-after-run is unchanged (the run-#2 checks in
  `verify-college-promotion-api.mjs` and the lease verifier pass untouched). The GET plan
  exposes the state ADDITIVELY (`data.runBlock`: `blocked`, `status`, `finishTerms`,
  `remainingTerms`, `stoppedAtTermNumber`, `message`), and the page shows that sentence and
  disables Run through the 6-pre-1 module (`ladderBlocked`, `ladderBlockTerms`,
  `ladderBlockNote`, plus a `blocked` input on `ladderRunDisabled`) — the modal states the
  refusal BEFORE it can happen, instead of letting the operator press Run into a 409.

**Verification (6-pre 3).** No `db.ts` change at all (the stage-2 row already had room).
`scripts/verify-college-promotion-lease.mjs` grows **40 → 54 checks**: the plan exposes the
block, a re-run is a 409 with zero writes, an unauthorized caller is 403 rather than told the
state, another programme is unaffected, and the recovery strikes the terms off one at a time and
unblocks — with every student advanced exactly once. `scripts/verify-college-promotion-page.mjs`
grows **13 → 14** (the note's wording, the terms descending, and `blocked === true` as the only
lock, plus the page consuming it). Every OTHER count is identical to the parent (`74bf386`),
which was measured on that tree by its own verification run: enrollment 40, course-registrations
50, registration-status 9, tenant 75, branch 52, college-gate 3, college-permissions 7,
college-routes 3, nav-scope 7, college-terms 8, promotion-logic 12, promotion-api **100**,
rollover 50 × 10 runs. `tsc` 0 errors; `next build` 164/164.


## 22. Phase 6-pre 4 / 6-pre 5 decisions (the lease made correct; the permanent-block wedges removed)

This section records the two fixes made after a **read-only review** of `5847f26`, `74bf386` and
`d8e12a2`. The review found, and this section must not quietly lose, that as shipped at `d8e12a2`:
the finalise released the row **unconditionally**, so a run that had lost its lease could clear a
successor's live lease and let a third run in; the lease was **never renewed**, so a long run could
be taken over mid-flight; the block read **failed open**, so a store error let a re-run double-advance
a half-applied ladder; `finishTerms` could drop the top term when the run failed before attempting
any step; an empty outstanding term could **wedge** a programme with no affordance on the page; and a
programme shrink/delete left its run row behind. 6-pre 4 fixes the lease. 6-pre 5 removes the wedges.

### 6-pre 4 — the lease is renewed, owned and fail-closed

- **D-6pre4-1 — the release is OWNED, not unconditional.** `finaliseProgrammeRun` now runs
  `prisma.$releaseOwned`, a transaction that compares the caller's claim key — `ownerId` **and**
  `acquiredAtMs`, the same pair `$claim` wrote — and finalises the row ONLY if it still matches. A
  run whose lease was taken over writes NOTHING: it cannot clear a successor's `expiresAtMs`, cannot
  overwrite its `status`, and cannot let a third run in through a lease it no longer holds. The
  refusal is REPORTED (`released: false` + a reason) and logged server-side; it is deliberately not
  surfaced in the response, whose shape is part of the structured-500 contract. **PROVEN**: with a
  foreign, live lease planted mid-run, the row afterwards still carries that holder, a live
  `expiresAtMs` and `IN_PROGRESS` — the stale finalise touched nothing.
- **D-6pre4-2 — the lease is RENEWED (heartbeat) before every step and every ≤400-op slice, and the
  TTL only has to cover ONE slice.** `renewProgrammeRun` (`prisma.$renewOwned`) re-checks the key and
  re-stamps the expiry in one transaction. `LADDER_LEASE_MS` becomes **30 s** — one constant, said
  here as this phase requires — replacing the 2-minute "longer than a whole run" window that was the
  wrong shape. Why 30 s: the longest gap between two renewals is one cohort read plus one slice
  write. **Measured** on the local emulator: a 400-op `WriteBatch` (the exact slice `flushStep`
  commits) took 195 ms cold and 23 / 14 ms warm, and the slow-run check's three-step run under an
  800 ms window completed in ~1.66 s with a rival refused — the window covers a slice with two
  orders of magnitude to spare. A production worst case (cold Cloud Firestore, a full 400-op batch,
  contention, a slow runtime) is **NOT PROVEN** — reasoned about, not measured — and a crashed run is
  recoverable in 30 s rather than two minutes. **PROVEN**: a run that OUTLIVES its own window while
  renewing is not taken over (the rival gets 409) and completes 200.
- **D-6pre4-3 — two new `db.ts` primitives and nothing else.** `$renewOwned` and `$releaseOwned`
  (plus `OwnedKey`, `OwnedResult`, `ownedBy`) are ADDED; `$claim` gains an options argument
  (`ttlMs`). No other symbol, `COLS`/`RELS` entry or behaviour changes, so every school code path and
  every non-promotion verifier count stays identical — measured, below. Both new writes are
  transactions for the same reason `$claim` is: the comparison and the write must be one step, or a
  renewal could resurrect a lease a successor has already taken.
- **D-6pre4-4 — the block read FAILS CLOSED.** A store error while reading the programme's run state
  is no longer swallowed and read as "not blocked" (which would let a re-run double-advance exactly
  when the store is unhealthy). The ladder does not start: the POST answers **503** with a message
  that says nothing was written, and it takes NO lease, reads NO cohort and writes NOTHING — not even
  an audit row. `no row = no block` is unchanged, so the ordinary first run of a programme is
  untouched. **PROVEN**: 503 with a tenant-wide document-count bracket around it, then the SAME
  programme runs normally once the read is healthy again.
- **D-6pre4-5 — a run that attempted NO step records EVERY term, and the message never names a term
  it did not attempt.** The work list was derived from `attemptedTerm ?? termCount`, which dropped
  the top term and could lift the block with the last term never applied; it is now built from the
  attempted term when there is one, and from `termCount` down to 1 when there is not. The failure
  sentence no longer interpolates a `?`. **PROVEN** by forcing the fault onto the FIRST step the
  descending walk attempts (term `termCount`): the 500 carries `status: "FAILED"`, `finishTerms`
  `[3,2,1]`, no student moved, the row records the same full list, and the message says "stopped at
  term 3". **NOT PROVEN, and stated rather than papered over**: the `attemptedTerm === null` branch
  itself is not reachable over HTTP — `attemptedTerm` is assigned at the top of the loop, before
  anything that can throw — so that half of the fix is defensive, and the check above proves the
  observable requirement (every term listed, the right term named) instead.
- **D-6pre4-6 — losing the lease mid-run ABORTS the run.** A failed renewal throws, which enters the
  ordinary failure path: nothing further is written, the structured 500 names the steps that landed
  (`completed`), the term that stopped it and the terms never attempted, and the release is the owned
  one (D-6pre4-1), so a successor's row is left alone. **PROVEN**: after the first committed slice the
  row is handed to a foreign holder; the run ends with `completed [3]`, `finishTerms [2,1]`, term 3
  graduated, terms 2 and 1 untouched — no double-advance — and the holder's lease is still live.
- **D-6pre4-7 — the test-only seam was extended, not replaced.** The §20 temp-file fault seam (a
  production build ignores it, and the values come from a file in the OS temp directory — never from
  a request) gains `leaseTtlMs`, `noRenew`, `stepDelayMs`, `stealAfterSlice` and `failBlockRead`, so
  a short window, a slow run, a mid-run takeover and an unreadable block are all reachable
  deterministically over HTTP. It cannot be triggered by a user, and the verifier deletes the file.
- **D-6pre4-8 — what did NOT change.** The structured-500 contract (status codes, the `data` shape,
  the 500-not-207 reasoning), the single-position route (still deliberately unleased, still
  idempotent), the run-#2 semantics, and every school code path. `students/promote`, `classes`,
  `permissions.ts`, `nav.ts`, `college-routes.ts` (no new route file), `college-promotion.ts` and the
  other programs routes are untouched.

**Verification (6-pre 4).** Measured BOTH ways in one session: the parent (`d8e12a2`) restored through
`git stash` for the baseline, then the working tree for the after-run. Environment: the local Firestore
emulator only (`npm run dev:emulator`, `FIREBASE_PROJECT_ID=demo-ss-test`,
`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`), a **sentinel round-trip** first (write → read → delete,
`write+read=true deleted=true`), the seed AND the isolation fixture created, the app RESTARTED after
the edit (and again between the two halves), the `zzcp-/zzls-` leftover scan run BEFORE the baseline —
**0 stray rows** (the 37 `zziso-` rows present are the fixture this run created) — and `next build`
run LAST, with dev stopped first. Every run individually:

| suite | parent `d8e12a2` | after 6-pre 4 | expected |
|---|---|---|---|
| `verify-college-enrollment` | 40 | 40 | 40 |
| `verify-course-registrations` | 50 | 50 | 50 |
| `verify-registration-status` | 9 | 9 | 9 |
| `verify-tenant-isolation` | 75 | 75 | 75 |
| `verify-branch-isolation` | 52 | 52 | 52 |
| `verify-college-gate` | 3 | 3 | 3 |
| `verify-college-permissions` | 7 | 7 | 7 |
| `verify-college-routes` | 3 | 3 | 3 |
| `verify-nav-scope` | 7 | 7 | 7 |
| `verify-college-terms` | 8 | 8 | 8 |
| `verify-college-promotion-logic` | 12 | 12 | 12 |
| `verify-college-promotion-api` | 100 | 100 | 100 |
| `verify-college-promotion-page` | 14 | 14 | 14 |
| `verify-college-promotion-lease` | 54 | **79** | grows (the new lease checks) |
| `verify-promotion-rollover` ×10 | 50/0 ×10 | 50/0 ×10 | 50 pass, 0 fail each |
| `npm run typecheck` | 0 errors | 0 errors | 0 |
| `npm run build` | 164 pages | 164 pages | 164 |

`verify-college-promotion-lease.mjs` grows **54 → 79 checks** (25 new). The new sections — the
long-run heartbeat, the mid-run takeover plus the stale finalise, the fail-closed read, and the
first-step work list — create and clean up their own programmes, students and lease rows, and the
cleanup checks still pass: no `zzls-` row left, no `promotionRuns` row left, and no seam file left.

### 6-pre 5 — the permanent-block wedges are removed

- **D-6pre5-1 — an OUTSTANDING term whose on-roll cohort is EMPTY can be marked finished, and
  nobody is promoted.** The wedge: a failed run's `finishTerms` is the only thing that can lift the
  block, and a term with no students has no apply that can strike it off — the single-position route
  would apply to nobody. The page now offers an explicit **"Mark term N finished"** press, shown only
  for a term that is in the outstanding list AND whose previewed cohort is empty; it sends the same
  position the apply would (`POST /api/college-promotion`), which the SERVER recomputes, writes
  nothing for, audits, and strikes off the work list (`markProgrammeTermFinished`). The predicates are
  the stage-1 module's (`markFinishedEligible`, `markFinishedTitle`, `markFinishedNote`,
  `markFinishedButtonLabel`, `markFinishedMessage`), and every sentence says plainly that the press
  promotes no one. The ORDINARY apply is NOT relaxed: `applyDisabled` still disables it for an empty
  cohort whatever the work list says — the strike-off is its own button, never a loosening of that
  rule. This also covers the case where the best-effort strike-off of a term that DID have students
  was lost. **PROVEN** offline (7 eligibility states + the wording) and over HTTP: an apply on an
  empty outstanding term is 200 with `promoted`/`graduated` both 0, and the term leaves the list.
- **D-6pre5-2 — the escape hatch is an AUDITED ABANDON on the existing ladder route.** No new route
  file: a POST of `{ programId, abandonRun: true, reason }` is handled by the same handler, AFTER the
  same guards (`getSession` → `requireCollege` → `can(role, "registration", "full")` → `writeGuard`),
  so a 403 learns nothing about the programme's state — and BEFORE the block read, because an
  abandoned programme IS a blocked one and this path must not be refused by the very rule it exists
  to escape. The reason is REQUIRED and at least **10 characters** (`ABANDON_REASON_MIN`; the page
  uses the same number only to disable the button early — the server enforces). Only a row whose
  status is `PARTIAL`/`FAILED` can be abandoned; anything else — a clean `OK` run, or a LIVE
  `IN_PROGRESS` lease that belongs to a run still working — is a **409**, never a race. It writes
  `status: "ABANDONED"` with `resolvedAt`, `resolvedBy: "ABANDONED"` and the reason, KEEPS
  `finishTerms` as the record of what was owed, and preserves the previous failure text on
  `failureReason` (the abandon must not erase the history it replaces). It moves **NO student**, and
  it writes exactly **ONE** `COLLEGE_PROMOTION` audit row carrying the reason, the outstanding terms
  and the actor. An `ABANDONED` row is **NOT a block** (`readProgrammeRunBlock` refuses only on
  `PARTIAL`/`FAILED`), so the ladder is usable again immediately and a later run will advance the
  terms that never ran — which is exactly what the page's confirmation says, bluntly. **PROVEN**:
  403 for an ACCOUNTANT, 400 with no reason and with a 9-character one, 409 on an `OK` row and on a
  live one, 200 on `PARTIAL` with no student moved and a single audit row added, then a ladder run
  is 200; and a foreign programme id is the run's own 400, never a 404.
- **D-6pre5-3 — WHO may abandon: exactly the roles that may RUN the ladder.** The hatch takes no new
  permission decision — it follows the run's own ruling, `can(role, "registration", "full")`, which
  this project's matrix (`src/lib/permissions.ts`) grants to **SCHOOL_ADMIN, BRANCH_ADMIN and
  REGISTRAR** (and `SUPER_ADMIN` by the `can()` short-circuit). Every other role — ACCOUNTANT,
  TEACHER, GUARDIAN, STUDENT, and a `BRANCH_ADMIN` outside the programme's branch (the resolver
  confines the programme by branch) — is refused, and the refusal happens after the same gate, so it
  reveals nothing. Stated plainly because "who can give up on a run" is a decision, not an
  implementation detail: **a REGISTRAR may abandon**, the same way a REGISTRAR may run and finish the
  ladder.
- **D-6pre5-4 — the run row is reconciled when the PROGRAMME it describes shrinks or is deleted.**
  The row is addressed by a hash of `(schoolId, programId)`, so no prefix scan can find it, and a
  work list naming a term the programme no longer has would block it FOR EVER (the single-position
  route would refuse that term). Two best-effort helpers in the shared server module —
  `reconcileProgrammeRunAfterShrink` and `deleteProgrammeRunRow` — are called from
  `src/app/api/programs/[id]/route.ts` AFTER its own write has succeeded, and only for a shrink
  (`nextTermCount < currentTermCount`) or after a delete. They never change that route's response,
  status or audit, and a failure to write the row is swallowed. **PROVEN**: shrinking a 3-term
  programme to 2 filters term 3 out of `(3,2,1)` → `(2,1)` while the run stays `FAILED`, the block
  then stands on the remaining two, the two EMPTY terms finish it (D-6pre5-1) and the ladder runs
  again; deleting a programme removes its row. **NOT PROVEN, and stated rather than implied**: the
  branch that EMPTIES the list and sets `OK`/`resolvedBy: "RECONCILE"` is defensive — it can only
  fire when the new term count falls below the LOWEST outstanding term, and every work list contains
  term 1 while `parseDuration` allows 1..6 years, so it is unreachable over the shipped routes. It
  exists so a hand-written or future row cannot wedge a programme.
- **D-6pre5-5 — what did NOT change.** `students/promote`, `classes`, `permissions.ts`, `nav.ts`,
  `college-routes.ts` (still no new route file), `college-promotion.ts`, `college-promotion/route.ts`
  (the single-position route), the structured-500 contract, the lease semantics of 6-pre 4, and
  every other programs route and school code path. The only programs-route edit is the two reconcile
  calls above, after its own successful write.

**Verification (6-pre 5).** Measured BOTH ways in the same session, the parent being this
section's own commit 1 (`8b9948c`, restored through `git stash` for the baseline) and the working
tree for the after-run. The environment is the one 6-pre 4 used: emulator only
(`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, `FIREBASE_PROJECT_ID=demo-ss-test`), the seed and the
isolation fixture in place, the app RESTARTED after the edit and again between the two halves, the
`zzcp-/zzls-` leftover scan run before the baseline (**0 stray rows**), and `next build` run LAST
with dev stopped first (restarted afterwards). Every run individually:

| suite | parent `8b9948c` | after 6-pre 5 | expected |
|---|---|---|---|
| `verify-college-enrollment` | 40 | 40 | 40 |
| `verify-course-registrations` | 50 | 50 | 50 |
| `verify-registration-status` | 9 | 9 | 9 |
| `verify-tenant-isolation` | 75 | 75 | 75 |
| `verify-branch-isolation` | 52 | 52 | 52 |
| `verify-college-gate` | 3 | 3 | 3 |
| `verify-college-permissions` | 7 | 7 | 7 |
| `verify-college-routes` | 3 | 3 | 3 |
| `verify-nav-scope` | 7 | 7 | 7 |
| `verify-college-terms` | 8 | 8 | 8 |
| `verify-college-promotion-logic` | 12 | 12 | 12 |
| `verify-college-promotion-api` | 100 | 100 | 100 |
| `verify-college-promotion-page` | 14 | **16** | grows (the new offline checks) |
| `verify-college-promotion-lease` | 79 | **106** | grows (the new HTTP checks) |
| `verify-promotion-rollover` ×10 | 50/0 ×10 | 50/0 ×10 | 50 pass, 0 fail each |
| `npm run typecheck` | 0 errors | 0 errors | 0 |
| `npm run build` | 164 pages | 164 pages | 164 |

`verify-college-promotion-lease.mjs` grows **79 → 106 checks** (27 new) and
`verify-college-promotion-page.mjs` **14 → 16** (2 new). The abandon checks cover all four
dimensions: authorization (403), the reason (400 twice), the row's status (409 on `OK` and on a live
lease), success (200, no student moved, one audit row, then a ladder run), TENANT (a foreign id is the
run's own 400) and BRANCH — a branch-A admin against a branch-B programme gets **403, not the 409 its
finished run would give**, which is what proves the branch check runs first. The new lease sections — the empty
outstanding term, the audited abandon, and the shrink/delete reconciliation — create and clean up
their own programmes, students and run rows, and the cleanup checks still pass: no `zzls-` row left,
no `zzcp-` row left (the scan now covers both prefixes), no `promotionRuns` row for any programme it
leased, and no seam file left. As in 6-pre 4, the page's own limits stand: a real browser test of the
two new controls is still **NOT DONE** — the offline checks pin their decisions (eligibility, the
reason minimum, the wording), not their rendering.
