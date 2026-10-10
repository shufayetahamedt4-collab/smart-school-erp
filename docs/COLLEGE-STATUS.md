# COLLEGE-STATUS.md — the college work, whole story in one place

**Date written:** 2026-10-09. **Updated 2026-10-11 (Phase 6f).**
**Branch:** `integration/main-into-college` — the **school and college lines are merged here** (see §2,
"integration"). The branch that had the story to itself was `college-support`.
**HEAD when first written:** `dc0e970` (`phase 6-pre 6: …`). **HEAD now:** the 6f docs commit you are
reading (Phase 6's "finished" record); the last code commit before it is `fc8ff62`
(`phase 6e: prove the college result rows' tenant and branch isolation`).
**Source of truth for decisions:** [docs/COLLEGE-DECISIONS.md](docs/COLLEGE-DECISIONS.md). Where this
document and that one differ, that one wins.

This document is a **report**, not a plan and not a decision record. It adds no rule. Everything below
is static evidence read from the repository at the HEAD above, plus the verifier counts recorded in
`docs/COLLEGE-DECISIONS.md` §23.7.1. Anything the repository cannot prove is marked **NOT PROVEN**.

---

## 0. How to read this document — the naming rule

Read this before the tables, or the phase names will mislead you.

- The commits labelled **`phase 6-pre 1`** through **`phase 6-pre 6`** are **hardening of Phase 5**
  (the promotion ladder). They are **not** Phase 6. See `docs/COLLEGE-DECISIONS.md` §21–§22.
- The **`safety 1`** commit is **go-live safety work** (a config typo fix, backup/environment/status
  documents, and recording `AGENTS.md`). It is **not a phase**, it is not Phase 7, and it is not the
  start of Phase 6.
- **`scripts/verify-phase7-e2e.mjs` is the SCHOOL-side end-to-end audit** (import / undo / credentials /
  print) that came in with `origin/main`. Its "phase7" is the **school** plan's phase number. It is
  **not** college Phase 7 (the college fee basis), and running it proves nothing about the college line.
- The **real Phase 6** — credit-weighted GPA/CGPA and the transcript — **is FINISHED**: `6a`–`6f`,
  §2 below. Nothing is still "not started" about it.
- The **real Phase 7** (college fee basis) and **Phase 8a/8b/8c** (college dashboard / reports / import)
  have **not started**. The per-programme scale override (D-6-19) is parked **with the owner**.

The numbered college phases in this document are the implementation phases (0, M, 1–5, 6-pre, 6), which
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
  `FRONT_DESK`, `TEACHER`, `GUARDIAN` (plus `STUDENT`).
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

All hashes are on this line, in `git log --oneline` order (newest first within a phase).

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
| **integration** | `cd0e2d5` integration 1: merge `origin/main` into college-support (wizard, plan limits, import/export, certificates) · `b96ca63` integration 2: fail loudly when both database-id variables disagree · `bee9402` docs: record superseded local-main commits · `d497f96` test(scripts): deliver the Host header so host-scoped checks really run · `c4fb047` wizard and new-tenant seed are institution-type aware · `84df90e` onboarding: fix college profile step, submit label and fee defaults · `8354ca1` fix: keep college data access behind the college gate in the onboarding wizard | One line again. The school features (onboarding wizard, plan-limit enforcement, CSV import/export, certificate templates, timetable builder, Firestore cutover) and the college work live on the same branch; every conflict is resolved in [docs/INTEGRATION-LOG.md](docs/INTEGRATION-LOG.md). The wizard now respects the tenant's type. |
| **6 (real) — FINISHED** | `2e0ff07` docs: phase 6 decisions · `cb05811` **6a** pure grading logic (`showGpa`, retake policy, credit-weighted GPA/CGPA, `resolveSchemeFor`) · `0b1a3bb` **6b** register the `courseResults` collection · `f12d227` **6c** the college results API behind the college gate · `e20f4f2` **6c-fix** reads are admin/registrar only · `58d9c85` **6d** college results screen, transcript print page, nav entry · `fc8ff62` **6e** tenant/branch isolation proof for the new rows · 6f this commit (docs) | **Results, GPA/CGPA and the transcript.** A college admin can open the **College Results** screen, see the active scheme's name and scale, enter/adjust a student's course results with retakes, and **print one student's transcript** (`/print/college-transcript/<studentId>`) — term GPA and CGPA are credit-weighted and derived at read time from the tenant's own scheme. Reads are admin-level or REGISTRAR only. |
| **7, 8a/8b/8c** | — | **Not started.** College fee basis; college dashboard/reports/import. |

**Safety / test-infrastructure commits in the same range** (they change no product behaviour):
`25c439f`, `e31f454`, `e31822e`, `e538e74`, `48d8dc5`, `c9b6207`, `e01e321`, `43e8595`, `3e6b702`,
`58a06d1`, `c8c3a57` — emulator-only guards, emulator config, deterministic fixtures, smoke harness
fixes, plus `5f49be9` (refuse live Firestore unless `ALLOW_LIVE_FIRESTORE=1`) and
`8f65b09` / `3ba4600` / `beb3ac3` (data-layer and fixture correctness).

---

## 3. Safety and testing — the counts at 6e / 6f

**Where these numbers come from:** the Phase 6 run recorded in `docs/COLLEGE-DECISIONS.md` §23.7.1 —
the emulator-only, baseline-first run that ended at `fc8ff62`, plus the step-by-step counts in §22 for
the 6-pre work. The doc-only 6f commit changed no code and re-ran nothing. These are the last recorded,
green numbers.

**The college/registration isolation set:**

| Verifier | Pass | Fail |
|---|---|---|
| `verify-tenant-isolation` | 97 | 0 |
| `verify-branch-isolation` | 65 | 0 |
| `verify-college-enrollment` | 40 | 0 |
| `verify-course-registrations` | 50 | 0 |
| `verify-registration-status` | 9 | 0 |
| `verify-college-gate` | 3 | 0 |
| `verify-college-permissions` | 7 | 0 |
| `verify-college-routes` | 3 | 0 |
| `verify-nav-scope` | 8 | 0 |
| `verify-college-terms` | 8 | 0 |

**Phase 6's own suites** (all new in Phase 6 except `verify-grading`, which is the school's):

| Verifier | Pass | Fail |
|---|---|---|
| `verify-college-results` (offline logic, 6a) | 13 | 0 |
| `verify-college-results-data` (6b) | 8 | 0 |
| `verify-college-results-api` (6c) | 77 | 0 |
| `verify-college-results-page` (6d) | 106 | 0 |
| `verify-grading` (school, re-run unchanged) | 38 | 0 |

**The promotion and foundation suites:**

| Verifier | Pass | Fail |
|---|---|---|
| `verify-college-promotion-logic` | 12 | 0 |
| `verify-college-promotion-api` | 100 | 0 |
| `verify-college-promotion-page` | 18 | 0 |
| `verify-college-promotion-lease` | 113 | 0 |
| `verify-promotion-rollover` ×10 | 50 each | 0 |
| `verify-mode-foundation` | 64 | 0 |

**The school-side suites re-run in the same pass:**

| Verifier | Pass | Fail |
|---|---|---|
| `verify-onboarding-seed` | 78 | 0 |
| `verify-onboarding-type` | 38 | 0 |
| `verify-bulk-import` | 118 | 0 |
| `verify-phase7-e2e` (school audit) | 160 | 0 |
| `scripts/qa-phase23.mjs` | 36 | 0 |
| `scripts/qa-certificates.mjs` | 39 | 1 (credential-gated orphan sweep only) |

Build and types:

| Check | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm run build` | `✓ Generating static pages (177/177)` — 177 pages (164 before integration, 175 after the merge; Phase 6's two college routes make 177) |

**Other counts in the tree at this HEAD:** 46 `verify-*.mjs` scripts; 81 `.mjs` files under `scripts/`;
**6** college API segments (`departments`, `programs`, `courses`, `course-registrations`,
`college-promotion`, `course-results`) covering **30** gated handlers.

**Known-failing checks (documented, not fixed, pre-existing, out of Phase 6's scope):**
`verify-read-cache` — 1 fail (a latency assertion that does not hold in dev mode); `verify-routine-config`
— 3 fails (the seed writes only **section-scoped** routines while the route's class-wide read returns
the `sectionId == null` rows). Four browser checks in `scripts/smoke-all.mjs` (the two `/print/*` pages
and two `/teacher/marks` checks) are also known-failing, analysed in
[docs/SMOKE-FAILURES.md](docs/SMOKE-FAILURES.md) (which is untracked and a snapshot, see §8). They are
**not** green, and claiming "the tests are green" would be wrong.

---

## 4. The college-admin journey

Each step is graded **works** / **manual** / **missing** from static evidence and the recorded
verifier runs. Steps graded from the code alone are marked where a live run is needed to be certain.

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
| 16 | Open the **College Results** screen and see the scheme in force | **works** | `/dashboard/results` (college nav) reusing the mode-scoped grading editor; the active scheme's **name and scale** are shown (D-6-6); `verify-college-results-page` (106). |
| 17 | Record / adjust a student's course results, with retakes | **works** | `GET`/`POST /api/course-results` behind the college gate; `maxRetakes` enforced; a re-graded scheme changes the served CGPA with no re-entry (`verify-college-results-api`, 77). |
| 18 | Print one student's transcript | **works** | `/print/college-transcript/<studentId>`; term GPA and CGPA derived at read time; the scheme name, scale, pass mark and print date are printed (D-6-12/D-6-14/D-6-16). |

**Journey gaps that sit outside these 18 steps** (the parts a real college needs and does not have):

- **College fees** — **missing / manual** (real Phase 7 not started; the fee screens are school-shaped).
- **Per-course attendance** — **not built**. School attendance is one row per pupil per day keyed
  `studentId_date`; a per-course version cannot be retro-fitted onto it
  (`docs/COLLEGE-DECISIONS.md` §10, D-3-6). **NOT PROVEN** which model college attendance will use.
- **College-specific guardian content** — **NOT PROVEN** whether the Parents app shows anything
  college-specific, and a per-child guardian transcript view is deliberately out of v1 (owner to
  decide).
- **Per-course teacher view of results** — **NOT PROVEN** / out of v1 (owner to decide).
- **College retain / failed-course rules** — **NOT PROVEN** (no rule recorded in the repo). Phase 6
  records and prints pass/fail but never gates a promotion on it (Q6).
- **Per-programme grade scale** — **not built** (D-6-19; first candidate after v1, owner to confirm).
- **College dashboard / reports / import** — **missing** (Phase 8a/8b/8c).

---

## 5. What is left (leftover list)

| # | Item | Where | Size | Who it blocks | Blocks a sale? |
|---|------|-------|------|---------------|----------------|
| 1 | Real **Phase 7**: college fee basis | `COLLEGE-DECISIONS.md` §10 | Large | College accountant | **Yes** — no college billing |
| 2 | Phase **8a/8b/8c**: college dashboard / reports / import | §10 | Large | College admin | Partly |
| 3 | Per-course college attendance model undecided | `COLLEGE-DECISIONS.md` §10 | Medium | College teachers | **Yes**, for a college running attendance |
| 4 | College fee heads / structures not modelled | fee code (school-shaped) | Medium | College accountant | **Yes** |
| 5 | Post-v1: per-programme scale override (D-6-19) | §23.6 | Small | Owner to confirm | No |
| 6 | Post-v1: per-child guardian view, per-course teacher view | §23.6 | Small–medium | Owner to decide | No |
| 7 | Known-failing checks: `verify-read-cache` (1), `verify-routine-config` (3), four browser checks | `scripts/`; [SMOKE-FAILURES.md](docs/SMOKE-FAILURES.md) | Small–medium | Nobody in production; CI trust | No |
| 8 | Routines missing-`sectionId` read hole (the `verify-routine-config` cause) | `src/app/api/routines/route.ts` + `scripts/seed.mjs` | Small | A future reader | No |
| 9 | Super-admin `POST /api/schools` still writes `feeSetting` for a college tenant | `src/app/api/schools/route.ts` | Small | College admin | No |
| 10 | Wizard success screen says "school"; college sidebar still shows school items | onboarding page, `src/components/nav.ts` | Small | College admin | No |
| 11 | `firestore.indexes.json` `schoold` typo: fixed in the file, still live in both databases | `firestore.indexes.json` + the live DBs | Small | Nobody (the shim sorts in memory) | No |
| 12 | Firestore backup not yet confirmed; the old `(default)` database is the rollback insurance and its archive date (2026-10-08) has passed | `apphosting.yaml`, `src/lib/firebase.ts` | Decision | The operator | No |
| 13 | Go-live: role probe on a **production** build | — | Small | The operator | No |
| 14 | Go-live: production line decision — `origin/main` vs `deploy/app-hosting` | — | Decision | The operator | No |
| 15 | `docs/PHASE1-DECISION-WORKSHEET.md` and `docs/SMOKE-FAILURES.md` are **untracked** and outdated | those files | Small (doc) | A future reader | No |
| 16 | `docs/COLLEGE-PLAN.md` (the original A–I plan) is absent from the repo by design | preamble of `COLLEGE-DECISIONS.md` | n/a | A phase-4+ preflight | No |

Items 7–10 and 15 are cheap documentation/CI/hardening debt; items 1–4 are the real remaining product
work.

---

## 6. The state of the product (one page)

- **Schools are untouched.** A tenant with no `institutionType` reads as a school, its nav stays
  deep-equal to the recorded snapshot, and every school code path stays as it was. This is the central
  promise and it is asserted by verifiers (`verify-nav-scope`, `verify-tenant-isolation` 97,
  `verify-branch-isolation` 65, `verify-grading` 38).
- **A college tenant can be run end to end from departments to a printed transcript:** departments →
  programmes → terms and curriculum → courses → enrolment → registration and approval → promotion
  ladder → results → GPA/CGPA → transcript. All of it sits behind one `requireCollege()` gate,
  enforced by a static verifier that fails the build if a college route forgets it.
- **Authorization never comes from mode.** `can()`, tenant isolation and the permission matrix are the
  only enforcement. A cookie or a `?mode=` value grants nothing. College **reads** are narrower still:
  admin-level roles plus the REGISTRAR only (`src/lib/college-results-access.ts`).
- **Grades are derived, never frozen (v1).** Editing a scheme re-interprets stored marks and reprints
  them; a transcript therefore names the scheme, its scale, the pass mark and the print date, which is
  the recorded mitigation (D-6-12's known limitation).
- **The college work's remaining commercial gap is fees (Phase 7)** plus the dashboard/reports/import
  phase. A college can produce a transcript but cannot yet bill its students.
- **Testing is strong and offline-first.** 46 verifiers, 6 of the college segments guarded, the
  emulator required by design — no script reaches a live database without `ALLOW_LIVE_FIRESTORE=1`. A
  handful of checks are known-failing and documented rather than fixed.

---

## 7. Mistakes and confusion — names that were wrong or misleading

| # | What it said (or implied) | Where | The correct version |
|---|---------------------------|-------|---------------------|
| 1 | `subscriptions` index field `schoold` | `firestore.indexes.json` | The field is **`schoolId`**. Fixed in the file; the misdeclared index is still live in both databases. |
| 2 | `"phase 6-pre 1"` … `"phase 6-pre 6"` mean Phase 6 | commit subjects `5847f26`…`dc0e970` | They are **hardening of Phase 5**. Real Phase 6 (GPA/CGPA + transcript) is `cb05811`…`fc8ff62` and is finished. |
| 3 | The `safety 1` commit is a phase (or Phase 7) | — | It is **go-live safety work**, not a phase and not Phase 7. |
| 4 | `verify-phase7-e2e` is college Phase 7 | `scripts/verify-phase7-e2e.mjs` | It is the **school-side** end-to-end audit that came in with `origin/main`; college Phase 7 (fees) has not started. |
| 5 | The college transcript READ is `/api/students/[id]/transcript` | `COLLEGE-DECISIONS.md` §23.7 (6c row, as first written) | It is `/api/course-results/students/[id]/transcript` — `students` is a frozen non-college segment the route guard refuses. |
| 6 | "Multi-branch / CSV / billing / white-label **not yet**" | `PROGRESS.md` (2026-09-18 session) | Stale. Branches and CSV student import exist; the wizard/billing/export exist on the merged line. |
| 7 | "The tests are green" | — | A few checks are known-failing and documented (§3), not fixed. |
| 8 | Phase numbers 3, 4, 5, 6, 7 mean the same thing everywhere | `COLLEGE-PLAN-DELTA.md` vs `COLLEGE-DECISIONS.md` | The delta's Phase 3 was **deferred then dropped**; its catalogue half moved into implementation Phase 3; its Phase 5 is this document's Phase 6. Only §10 of the decisions document is authoritative. |

---

## 8. NOT PROVEN — items this report cannot settle

- Whether `deploy/app-hosting` or `origin/main` is the production line. **NOT PROVEN** — still an open
  go-live decision.
- Whether the four known-failing browser checks are caused by stale fixtures today (the analysis in
  `SMOKE-FAILURES.md` predates the current `smoke-all.mjs`; that file is also untracked).
- A production-build role probe of the college screens — **not run** (go-live checklist item).
- College retain / failed-course rules — no rule is recorded in the repo.
- College-specific guardian-portal content — not verified.
- Which model a future per-course college attendance uses — no rule recorded.
- The exact school nav item count (two documents disagree: 31 vs 34).
- Whether every item `PROGRESS.md` lists as open is closed by `origin/main`.
