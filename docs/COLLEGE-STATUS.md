# COLLEGE-STATUS.md — the college work, whole story in one place

**Date written:** 2026-10-09.
**Branch:** `college-support`.
**HEAD when written:** `dc0e970` (`phase 6-pre 6: restrict abandon to admins, harden test-only
parameters, doc notes`).
**Source of truth for decisions:** [docs/COLLEGE-DECISIONS.md](docs/COLLEGE-DECISIONS.md). Where this
document and that one differ, that one wins.

This document is a **report**, not a plan and not a decision record. It adds no rule. Everything
below is static evidence read from the repository at the HEAD above (file reads, `git log`, targeted
searches). Anything the repository cannot prove is marked **NOT PROVEN**.

---

## 0. How to read this document — the naming rule

Read this before the tables, or the phase names will mislead you.

- The commits labelled **`phase 6-pre 1`** through **`phase 6-pre 6`** are **hardening of Phase 5**
  (the promotion ladder). They are **not** Phase 6. See `docs/COLLEGE-DECISIONS.md` §21–§22: "Phase 5
  is finished and pushed (`a770a03`). Four items were still open. Phase 6-pre closes the three…".
- The **real Phase 6** — **credit-weighted GPA/CGPA and the transcript** — **has NOT started.** It is
  the "Phase 6" row of the reconciled phase list in `docs/COLLEGE-DECISIONS.md` §10.
- This **`safety 1`** commit (the one you are reading) is **go-live safety work**: a config typo fix,
  backup/environment/status documents, and recording `AGENTS.md`. It is **NOT Phase 7** (college
  fees) and it is **not** the start of Phase 6.
- Real Phase 7 (college fee basis) and Phase 8a/8b/8c (dashboard / reports / import) have **not
  started** either.

The numbered college phases in this document are the implementation phases (0, M, 1–5, 6-pre), which
are **not** the same numbers as the plan phases in `docs/COLLEGE-PLAN-DELTA.md`. §10 of the decisions
document reconciles them, and that table is the authority.

---

## 1. The starting point

The college work starts from **`70d0176`, dated 2026-09-20** (`fix(auth): /api/auth/me resolves the QR
guardian synthetic session instead of 401`). At that point the product was a **school** ERP:

- **One platform, separate apps.** Super Admin console (`admin.`), School Admin console (`school.`),
  Teacher app (`teacher.`), Parents app (`parents.`). Rule 1 of `AGENTS.md` holds this sacred.
- **Tenants** are schools. There was **no institution-type concept at all**.
- **Roles:** `SUPER_ADMIN`, `SCHOOL_ADMIN`, `BRANCH_ADMIN`, `REGISTRAR`, `ACCOUNTANT`, `LIBRARIAN`,
  `FRONT_DESK`, `TEACHER`, `GUARDIAN`.
- **Academic spine:** `classes` / `sections` / `subjects`, attendance keyed `studentId_date`, exams
  and marks, fees, routine, library, admissions, notifications, guardians.
- **Data layer:** Firestore behind a hand-written shim (`src/lib/db.ts`), with query push-down and a
  read cache. Multi-branch support exists; a branch is a `branches` row.

**The goal of the college work** (from the decisions document): *teach the one platform to run a
college as well as a school, without changing how any existing school tenant behaves.* A tenant is a
`SCHOOL`, a `COLLEGE`, or `BOTH` (`institutionType`). A document with no `institutionType` reads as a
school, so there is **no backfill and no migration**. "Mode" (`SCHOOL` | `COLLEGE`) is UI context
inside a tenant and is **never** authorization — `can()`, tenant isolation and the permission matrix
stay the only enforcement (`docs/COLLEGE-DECISIONS.md` §3).

---

## 2. Phase-by-phase — commits and what a college admin can do

All hashes are on `college-support`, in `git log --oneline` order (newest first).

| Phase | Representative commits | What a college admin can do after it |
|-------|------------------------|--------------------------------------|
| **prep** | `79e06b0` backup · `1f480dc` docs: college plan and decisions · `bff12a8` docs: integration analysis | Nothing yet. Working-tree backup, the plan and the decisions record. |
| **0** | `2fda7a4` institutionType (SCHOOL\|COLLEGE\|BOTH) · `b88a2f3` merge production line | Nothing user-visible. The tenant-shape field and its normalisation, with school as the default. |
| **M** | `406ee9b` mode foundation (SCHOOL\|COLLEGE switcher for BOTH) | A `BOTH` tenant can switch the visible half (School \| College) from the UI. The mode is a cookie (`MODE_COOKIE`, `ss_mode`) written only by `POST /api/mode`, validated server-side. Settings keys are mode-scoped so a college key cannot disturb a school key. |
| **1** | `993ca60` docs: phase 1 decisions · `95c5d00` phase 1: tenant-aware nav mechanism (no-op) | Nothing new on screen. The nav gains an optional `requires` marker and a mode-aware filter; the school nav is byte-identical (frozen snapshot). |
| **2** | `376e886` gate + tenant-shape store + permissions · `3f30dc3` departments/programs API · `7a81c99` nav items behind the COLLEGE gate · `f0180be` department and program admin pages · `0da0421` gate + isolation verification | **Departments** and **Programmes** pages appear for a college tenant (roles SCHOOL_ADMIN, BRANCH_ADMIN, REGISTRAR). Create/edit/delete, cross-tenant isolation proven. A school tenant sees no new link. |
| **3-pre** | `eb26940` college route guard (single route list + static verifier) | Nothing user-visible. One exported list of college API segments plus an offline verifier that fails if a listed handler forgets `requireCollege()` first. |
| **3a–3e** | `c8e3c3d` store plumbing + courses permission · `24a2e67` courses API behind the gate · `d7df791` percent term system + programCourses mapping and guards · `2ff8874` courses page, term system and curriculum, college nav · `457a242` isolation proof for courses and programCourses | **Courses** page. A programme has a term shape (`YEARLY` \| `SEMESTER`, `durationYears` 1..6) and a curriculum: courses mapped to a term. Term shape or duration can only be changed while it orphans no mapping (else 409). |
| **4** | `973c827` student college identity at enrolment · `ec7b847` explicit unenrol via `programId null` · `489f2ed` course registration and approval API · `ecf236d` block student delete while registrations exist · `b3740b1` registration page and nav · `f2d8d05` isolation proof | **Registration** page. A student is enrolled with a `programId` and `termNumber`; can register for courses; an admin approves or rejects; a student with registrations cannot be deleted; unenrol is explicit. Isolation proven for `courseRegistrations`. |
| **5-pre / 5a / 5b** | `be02822` Q7 answer + Phase 5 redefined · `3809429` pure promotion ladder logic + offline verifier · `8586a2c` college promotion API (preview/apply) · `46e69ec` doc-count proof for refused requests · `3570436` refuse programme shrink while on-roll students sit beyond the new last term | Promotion preview and apply behind the COLLEGE gate. A programme cannot be shrunk while on-roll students would fall outside it. |
| **5c / 5d / 5e** | `84de6a5` promotion page and nav item · `ea751eb` whole-programme ladder (plan + run) · `c75e3db` ladder fails safely (structured partial-failure report, per-step flush) · `a770a03` gate verifier href, pending-request plural | **College Promotion** page. Run the whole programme's ladder: per-position advance, a structured partial-failure report, and a per-step flush so a crash leaves a readable state. |
| **5 hardening ("6-pre")** | `5847f26` 6-pre 1 page logic extracted + verified offline · `74bf386` 6-pre 2 atomic per-programme lease · `d8e12a2` 6-pre 3 refuse ladder re-run after a partial failure · `8b9948c` 6-pre 4 ownership-safe lease with renewal, fail-closed block, complete finishTerms · `609e4b9` 6-pre 5 finish-empty-term, audited abandon, reconcile the run row on programme shrink/delete · `dc0e970` 6-pre 6 restrict abandon to admins, harden test-only parameters | Safe re-run rules, an atomic per-programme lease with renewal, fail-closed when the lease cannot be read, an admin-only abandon, an audited abandon, and "mark a term finished". A REGISTRAR can run the ladder but cannot abandon a run. |
| **6 (real)** | — | **Not started.** Credit-weighted GPA/CGPA + transcript (`docs/COLLEGE-DECISIONS.md` §10, Phase 6 row). |
| **7, 8a/8b/8c** | — | **Not started.** College fee basis; college dashboard/reports/import. |

**Safety / test-infrastructure commits in the same range** (they change no product behaviour):
`25c439f`, `e31f454`, `e31822e`, `e538e74`, `48d8dc5`, `c9b6207`, `e01e321`, `43e8595`, `3e6b702`,
`58a06d1`, `c8c3a57` — emulator-only guards, emulator config, deterministic fixtures, smoke harness
fixes, plus `5f49be9` (refuse live Firestore unless `ALLOW_LIVE_FIRESTORE=1`) and
`8f65b09` / `3ba4600` / `beb3ac3` (data-layer and fixture correctness).

---

## 3. Safety and testing — the current verifier counts

**Where these numbers come from:** `docs/COLLEGE-DECISIONS.md` §"Verification (6-pre 6)", which
records the two-way run on the local Firestore emulator at commit `609e4b9` → `dc0e970`. **They were
not re-run by this `safety 1` commit** (it changes no code, so a re-run would prove nothing new and
would need the emulator). Treat them as the last recorded, green numbers.

The **usual ten** (the college/registration isolation set):

| Verifier | Pass | Fail |
|---|---|---|
| `verify-college-enrollment` | 40 | 0 |
| `verify-course-registrations` | 50 | 0 |
| `verify-registration-status` | 9 | 0 |
| `verify-tenant-isolation` | 75 | 0 |
| `verify-branch-isolation` | 52 | 0 |
| `verify-college-gate` | 3 | 0 |
| `verify-college-permissions` | 7 | 0 |
| `verify-college-routes` | 3 | 0 |
| `verify-nav-scope` | 7 | 0 |
| `verify-college-terms` | 8 | 0 |

The promotion and foundation suites:

| Verifier | Pass | Fail |
|---|---|---|
| `verify-college-promotion-logic` | 12 | 0 |
| `verify-college-promotion-api` | 100 | 0 |
| `verify-college-promotion-page` | 18 | 0 |
| `verify-college-promotion-lease` | 113 | 0 |
| `verify-promotion-rollover` ×10 | 50 each | 0 |
| `verify-mode-foundation` | 64 | 0 |

Build and types:

| Check | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm run build` | `✓ Generating static pages (164/164)` — 164 pages |

**Other counts in the tree at this HEAD:** 38 `verify-*.mjs` scripts; 67 `.mjs` files under
`scripts/`; **12** college/registration/promotion verifiers
(`verify-college-enrollment`, `-gate`, `-permissions`, `-promotion-api`, `-promotion-lease`,
`-promotion-logic`, `-promotion-page`, `-routes`, `-terms`, `verify-course-registrations`,
`verify-promotion-rollover`, `verify-registration-status`).

**Known-failing checks (documented, not fixed):** four browser checks in `scripts/smoke-all.mjs`
(the two `/print/*` pages and two `/teacher/marks` checks). They are analysed in
[docs/SMOKE-FAILURES.md](docs/SMOKE-FAILURES.md) and are recorded as open in `PROGRESS.md`. They are
**not** green, and claiming "the tests are green" would be wrong.

---

## 4. The 15-step college-admin journey

Each step is graded **works** / **manual** / **missing** from static evidence (routes, pages, nav and
verifiers present at `dc0e970`). Steps graded from the code alone are marked where a live run is
needed to be certain.

| # | Step | Status | Evidence / note |
|---|------|--------|-----------------|
| 1 | Super Admin creates a tenant as `COLLEGE` or `BOTH` | **works** | `institutionType` on the tenant; `POST /api/schools` accepts it. |
| 2 | Sign in and, for a `BOTH` tenant, switch School \| College | **works** | `MODE_COOKIE` written only by `POST /api/mode`; resolved server-side; `verify-mode-foundation` (64). |
| 3 | Open **Departments** and manage departments | **works** | `/dashboard/departments` + `/api/departments`; nav `requires:"COLLEGE"`; isolation proven. |
| 4 | Open **Programmes** and manage programmes | **works** | `/dashboard/programs` + `/api/programs`. |
| 5 | Set a programme's term shape and duration | **works** | `termSystem` + `durationYears`; changes refused with 409 once a mapping exists (`verify-college-terms`, 8). |
| 6 | Build the curriculum (map courses to a term) | **works** | `programCourses` under `/api/programs/[id]/courses`. |
| 7 | Open **Courses** and manage the catalogue | **works** | `/dashboard/courses` + `/api/courses`. |
| 8 | Enrol a student with a college identity (`programId`, `termNumber`) | **works** | Student enrolment path; `verify-college-enrollment` (40). |
| 9 | Change or clear a student's programme (explicit unenrol) | **works** | `programId: null` is the explicit unenrol (`ec7b847`). |
| 10 | Student registers for courses | **works** | `/dashboard/registration` + `/api/course-registrations`. |
| 11 | Admin approves / rejects registrations | **works** | Approval API + status reads (`verify-course-registrations`, 50; `verify-registration-status`, 9). |
| 12 | A student with registrations cannot be deleted | **works** | Guard added in `ecf236d`. |
| 13 | Preview and apply a promotion | **works** | Preview/apply API (`verify-college-promotion-api`, 100). |
| 14 | Run the whole-programme ladder safely | **works** | `/dashboard/college-promotion` + `/api/college-promotion/ladder`; lease + fail-closed + partial-failure report (`verify-college-promotion-lease`, 113). |
| 15 | Mark a term finished / abandon a run | **works** | "Finish empty term" and an **admin-only** audited abandon (`609e4b9`, `dc0e970`; `verify-college-promotion-page`, 18). |

**Journey gaps that sit outside these 15 steps** (the parts a real college needs and does not have):

- **Results, GPA/CGPA and the transcript** — **missing** (real Phase 6 not started).
- **College fees** — **missing / manual** (real Phase 7 not started; the fee screens are school-shaped).
- **Per-course attendance** — **not built**. School attendance is one row per pupil per day keyed
  `studentId_date`; a per-course version cannot be retro-fitted onto it
  (`docs/COLLEGE-DECISIONS.md` §10, D-3-6). **NOT PROVEN** which model college attendance will use.
- **College-specific guardian content** — **NOT PROVEN** whether the Parents app shows anything
  college-specific.
- **College retain / failed-course rules** — **NOT PROVEN** (no rule recorded in the repo).

---

## 5. What is left (leftover list)

| # | Item | Where | Size | Who it blocks | Blocks a sale? |
|---|------|-------|------|---------------|----------------|
| 1 | Real **Phase 6**: credit-weighted GPA/CGPA + transcript | `COLLEGE-DECISIONS.md` §10 | Large | College admin, students | **Yes** — no results, no transcript |
| 2 | Real **Phase 7**: college fee basis | §10 | Large | College accountant | **Yes** — no college billing |
| 3 | Phase **8a/8b/8c**: college dashboard / reports / import | §10 | Large | College admin | Partly |
| 4 | Four known-failing browser checks | `scripts/smoke-all.mjs`; [SMOKE-FAILURES.md](docs/SMOKE-FAILURES.md) | Small–medium | Nobody in production; CI trust | No |
| 5 | Per-course college attendance model undecided | `COLLEGE-DECISIONS.md` §10 | Medium | College teachers | **Yes**, for a college running attendance |
| 6 | College fee heads / structures not modelled | fee code (school-shaped) | Medium | College accountant | **Yes** |
| 7 | `firestore.indexes.json` `subscriptions` index is declared but not exercised | `firestore.indexes.json` | Small | Nobody (the shim sorts in memory) | No |
| 8 | `scripts/deploy-guide.md` Phase 5 still describes the old `APP_URL` placeholder step | `scripts/deploy-guide.md:90` | Small (doc) | The operator | No |
| 9 | `docs/PHASE1-DECISION-WORKSHEET.md` is stale (says "Phase 1 has NOT started") | that file | Small (doc) | A future reader | No |
| 10 | `docs/SMOKE-FAILURES.md` is a snapshot at `e538e74`; HEAD has moved and two involved files changed | that file | Small (doc) | A future reader | No |
| 11 | `PROGRESS.md:1494` still says multi-branch / CSV / billing / white-label are "not yet" | `PROGRESS.md:1494` | Small (doc) | A future reader | No |
| 12 | Two deployments stay in step (App Hosting production + Netlify demo) | host configs | Ongoing | The operator | No |
| 13 | The old `(default)` Firestore database still exists as a rollback target — no decision recorded | `apphosting.yaml` comment, `src/lib/firebase.ts` | Decision | The operator | No |
| 14 | `docs/COLLEGE-PLAN.md` (the original A–I plan) is absent from the repo by design | preamble of `COLLEGE-DECISIONS.md` | n/a | A phase-4+ preflight | No |

Items 4, 7, 8, 9, 10, 11 are pure documentation/CI debt and are cheap. Items 1, 2, 3, 5, 6 are the
real remaining product work.

---

## 6. The state of the product (one page)

- **Schools are untouched.** A tenant with no `institutionType` reads as a school, its nav is a frozen
  byte-identical snapshot, and every school code path stays as it was. This is the central promise and
  it is asserted by verifiers (`verify-nav-scope`, `verify-tenant-isolation`,
  `verify-branch-isolation`).
- **A college tenant can be run end to end up to promotion:** departments → programmes → terms and
  curriculum → courses → enrolment → registration and approval → promotion ladder. All of it sits
  behind one `requireCollege()` gate, enforced by a static verifier that fails the build if a college
  route forgets it.
- **Authorization never comes from mode.** `can()`, tenant isolation and the permission matrix are the
  only enforcement. A cookie or a `?mode=` value grants nothing.
- **The college work is genuinely unfinished where it matters commercially:** results/GPA/transcript
  (Phase 6) and college fees (Phase 7) are not started. A college cannot yet produce a transcript or
  bill its students.
- **Testing is strong and offline-first.** 38 verifiers, 12 of them college-related, and the emulator
  is required by design — no script reaches a live database. Four browser checks are known-failing and
  documented rather than fixed.
- **This `safety 1` commit adds operational safety, not features:** the index typo is fixed, and the
  backup, environments/secrets and this status document now exist.

---

## 7. Mistakes and confusion — names that were wrong or misleading

| # | What it said (or implied) | Where | The correct version |
|---|---------------------------|-------|---------------------|
| 1 | `subscriptions` index field `schoold` | `firestore.indexes.json:15` | The field is **`schoolId`**. Fixed in this commit. |
| 2 | `"phase 6-pre 1"` … `"phase 6-pre 6"` mean Phase 6 | commit subjects `5847f26`…`dc0e970` | They are **hardening of Phase 5**. Real Phase 6 (GPA/CGPA + transcript) has not started. |
| 3 | This `safety 1` commit is Phase 7 | — | It is **go-live safety work**, not Phase 7 (college fees). |
| 4 | "Multi-branch / CSV / billing / white-label **not yet**" | `PROGRESS.md:1494` | Stale. Branches and CSV student import exist on `college-support`; the wizard/billing/export exist on `origin/main`. |
| 5 | "The deploy guide's `APP_URL` is a placeholder" | `scripts/deploy-guide.md:90` | Stale. `apphosting.yaml` now holds the real App Hosting URL; the guide's Phase 5 still describes the placeholder step. |
| 6 | "The tests are green" | — | Four browser checks in `smoke-all.mjs` are known-failing and documented, not fixed. |
| 7 | `firestore.indexes.json` "is fine" | `firestore.indexes.json` | It declared a composite index on `schoold` (typo for `schoolId`). Latent misconfiguration, not an outage — the shim sorts in memory, so queries still worked. |
| 8 | Phase 1 "has NOT started; Phase M is FROZEN" | `docs/PHASE1-DECISION-WORKSHEET.md` | Phase 1 landed (`95c5d00`) and phases 2–5 plus 6-pre are done. The worksheet is outdated. |
| 9 | Phase numbers 3, 4, 5, 6, 7 mean the same thing everywhere | `COLLEGE-PLAN-DELTA.md` vs `COLLEGE-DECISIONS.md` | The delta's Phase 3 was **deferred then dropped**; its catalogue half moved into implementation Phase 3. Only §10 of the decisions document is authoritative. |
| 10 | "`classes` carry a stored `mode`" | `COLLEGE-PLAN-DELTA.md` §3/§6 | No such field exists. Phase M shipped key-scoping and the cookie model, not stored `mode` on core rows. |
| 11 | "The data layer pushes only one equality filter to Firestore" | `COLLEGE-PLAN-DELTA.md` §3 | Outdated. `pushdownConditionsFor` pushes every scalar equality (and scalar `in`). |
| 12 | "The scratch files were removed **before** this commit" | `COLLEGE-DECISIONS.md` D-6pre6-4 | They were removed **after** the commit, in post-push housekeeping, and were **never** committed. Fixed in this commit. |

---

## 8. NOT PROVEN — items this report cannot settle

- Which phase numbering is authoritative where `phase 6-pre` and §10's "Phase 6" are read together —
  this document states the rule (§0), but the older commits' subjects cannot be rewritten.
- Whether `deploy/app-hosting` or `origin/main` is the production line. **NOT PROVEN.**
- Whether the four known-failing browser checks are caused by stale fixtures today (the analysis in
  `SMOKE-FAILURES.md` predates the current `smoke-all.mjs`).
- The exact school nav item count (two documents disagree: 31 vs 34).
- College retain / failed-course rules — no rule is recorded in the repo.
- College-specific guardian-portal content — not verified.
- Whether every item `PROGRESS.md` lists as open is closed by `origin/main`.
