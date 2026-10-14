# COLLEGE-STATUS.md — the college work, whole story in one place

**Date written:** 2026-10-09. **Updated 2026-10-11 (Phase 7c-follow-up).**
**Updated 2026-10-14 (Phase 7 committed).** Phase 7 is **complete** — including 7e and 7f — and its last
two parts (the 7d remainder, 7e, 7f) are **committed and pushed** on `integration/main-into-college`:
`f542405` code + verifiers, `efb97c0` docs, `946e4e3` evidence records. The sections below carry the
counts that were re-run on 2026-10-13.
**Branch:** `integration/main-into-college` — the **school and college lines are merged here** (see §2,
"integration"). The branch that had the story to itself was `college-support`.
**HEAD when first written:** `dc0e970` (`phase 6-pre 6: …`). **HEAD at the Phase 7 close-out
(2026-10-14):** `946e4e3` — the 7d/7e/7f work was written on `e5ee07d` (`pilot P3: the app can never open
the (default) Firestore database`) and **committed afterwards** (`f542405`, `efb97c0`, `946e4e3`), which
is why some Phase 7 claims below are qualified as *working tree* for the moment they were written. The last
**committed** fee work is `41d4f41` (`phase 7c: the college fee API`) plus the `cac825c` / `824e80d`
7d-fix / 7e-pre commits; `a9d1326` (`phase 7b: college fee data layer`) precedes those. The Phase 6 record
below is kept as it was written, with the fee phases' own numbers added in §3.
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
- The **real Phase 7** (college fee basis, 7-pre → 7f) is **FINISHED** — the logic (7a), the data layer
  (7b), the API (7c), the screens and print pages (7d), the isolation and BOTH-tenant Q3 proof (7e) and
  the finished record with the D-7-18 production-build role probe (7f). Its last three parts were written
  on `e5ee07d` and are now **committed and pushed** (`f542405`, `efb97c0`, `946e4e3`). **Phase 9a/9b/9c** (college dashboard / reports / import; renumbered
  from 8a/8b/8c on 2026-10-11, when attendance took Phase 8) and
  Phase 8 has **STARTED**: its first step `8-pre` — the course↔teacher link (D-CA-4, owner's answer
  Q8) — is **built, verified and recorded** (2026-10-14, below); so are **ca-0**, the attendance allow-list
  module (D-CA-7's first register step, `src/lib/college-attendance-access.ts`, §26), and **ca-1**, the pure
  attendance logic (`src/lib/college-attendance.ts`: the `ca_…` id, the slot, the four statuses, the
  APPROVED roster and the new-absence rule, §27); **ca-2**, the `courseAttendance` data layer (§28), and
  **ca-3**, the register's API — the roster read, the session save and the per-student history (§29) —
  and **ca-4**, the register screen and its ONE college nav entry (§30) are built beside them too.
  ca-5 (isolation + regression, baselines first) and ca-6 (the finished record) have **not started**,
  and the family-facing read stays a post-v1 owner decision — v1 is staff-only (D-CA-4, Q8).
  The per-programme scale override (D-6-19) is parked **with the owner**.

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
| **7-pre** | `cccbd37` a college-only tenant is created without the school fee setting · `19ca065` docs: 7-pre-2 baselines | Nothing new on a college screen. A **COLLEGE** tenant is no longer handed the school's Monthly/Admission fee defaults, and the wizard's success screen names the tenant it made (school / college / institution). |
| **7-pre-2** | `7de74e1` a college enrolment raises no school fee default | A college student is enrolled **without** the school's Admission/Monthly fee rows — one gate in `createStudentFees`, driven by the enrolment and cross-checked against an exactly-`COLLEGE` `institutionType`. A SCHOOL tenant and a BOTH tenant's school half are byte-identical. |
| **7a** | `e492a6d` the pure college fee logic · `c850c0c` docs: the structure row stores unit and basis | Nothing on screen. The pure rules: head and structure validation, the preset table, cadence → billing events, term totals, the charge derivation and its `cf_…` id, and the discount/waiver arithmetic. |
| **7b** | `a9d1326` college fee data layer | Nothing on screen. Four new collections — `collegeFeeHeads`, `collegeFeeStructures`, `collegeFees`, `collegeFeeConfigs` — registered in `src/lib/db.ts` as a purely additive change; no school collection touched. |
| **7c** | `41d4f41` the college fee API (`/api/college-fees`) | Nothing on screen yet (7d owns the pages). The **API**: heads, the programme × term structure, generation (dry-run + idempotent top-up), charges/dues, payments in integer minor units, awards (propose/approve) and the tenant's college payment config — each handler behind `requireCollege` → the D-7-18 allow-list → `writeGuard` on a mutation. |
| **7c-follow-up** | the scripts + docs commits this document belongs to | Nothing user-visible. The shared ledger's **read audit** (every reader enumerated and ruled on, then pinned by checks) and the **permanent staff matrix** (ACCOUNTANT / REGISTRAR / BRANCH_ADMIN proved by the committed suite instead of by hand). |
| **7d (earlier session)** | `cac825c` phase 7d-fix: the college money totals agree with their rows | **The college fee screens**: Fee heads, Fee structure, Dues & generation and Payment config behind the one `requires:"COLLEGE"` nav entry — plus the four UX fixes that commit carries. |
| **7d remainder, 7e, 7f (2026-10-13, committed 2026-10-14)** | `f542405` code + verifiers, `efb97c0` docs, `946e4e3` records | **D-7-17 print pages** (`/print/college-fee-statement/[studentId]`, `/print/college-fee-receipt/[chargeId]`) reached from the Dues tab; **7e's isolation + Q3 mode-mixing proof** (`verify-mode-mixing` 33, `verify-fees-totals` 24 = the unchanged 15 school + 9 college); the **D-7-18 role probe on a production build** (24/24, build `bTZhoZ8u8HFwxegmI4rKq`); and the 7f record in [proof/7f/REPORT.md](../proof/7f/REPORT.md). **Phase 7 is complete, committed and pushed.** |

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

**Added 2026-10-11 (Phase 7c-follow-up)** — the fee line's own numbers. The tables below are the
Phase 6 record; the runs that carry the fee phases are `docs/COLLEGE-DECISIONS.md` §24.7's 7-pre-2 /
7b / 7c / 7c-follow-up notes. In short: `verify-college-fees-logic` **21**, `verify-college-fees-data`
**11** (9 at 7c + the two 7c-follow-up ledger checks), `verify-college-fees-api` **112** (86 at 7c +
the 3-check staff matrix + 6 ledger-reader checks + 7e-pre's 17 payment-idempotency checks), `verify-enrollment-fees` **19**, and
`verify-college-routes` **3** — which now covers **22 college route files / 47 gated handlers** (14/30
before 7c's eight routes).

**Added 2026-10-14 (Phase 8 ca-0)** — the attendance allow-list's own numbers: `verify-college-attendance-access` **18 checks** (new, offline), `verify-college-permissions` **8** unchanged (no new `MATRIX` module), `verify-nav-scope` exit 0 (snapshot byte-identical — no nav entry), `verify-college-routes` **23 route files / 50 gated handlers**, `tsc --noEmit` 0 errors.The record is `docs/COLLEGE-DECISIONS.md` §26.

**Added 2026-10-14 (Phase 8 ca-1)** — the pure logic's own numbers: `verify-college-attendance-logic` **30 checks** (new, offline), `verify-college-attendance-access` **18** unchanged, `verify-nav-scope` exit 0 (snapshot byte-identical), `verify-college-routes` **23 route files / 50 gated handlers**, `tsc --noEmit` 0 errors. The record is `docs/COLLEGE-DECISIONS.md` §27.

**Added 2026-10-14 (Phase 8 ca-2)** — the `courseAttendance` data layer's own numbers: `verify-college-attendance-logic` **31 checks** (the date-key mirror is now asserted by EXECUTING `db.ts`'s own helper, not by a text shape), `verify-college-attendance-access` **17** (ca-0's "db.ts carries no `courseAttendance`" pin is removed with the change that owns it), `verify-college-fees-data` **11** and `verify-college-results-data` **8**, both exit 0 with their recorded baselines intact (COLS 80 / RELS 76 / prisma 80 after the additive model is dropped by name), `verify-nav-scope` exit 0 (snapshot byte-identical — no nav entry), `verify-college-routes` **23 route files / 50 gated handlers** (no route added; the `course-attendance` segment entry is deferred to ca-3, which creates its directory), `tsc --noEmit` 0 errors. No emulator, server or `suite-all.mjs` run: ca-2 has no HTTP surface. The record is `docs/COLLEGE-DECISIONS.md` §28.

**Added 2026-10-14 (Phase 8 ca-4)** — the register screen's own numbers: `verify-college-attendance-page` **36 checks** (new, offline: the mark vocabulary, the save payload's subset rule, the slot reader, the save truth table including D-CA-3's notification count, the refusal wording, and — statically — that the page uses ONE rule, ONE endpoint and ONE vocabulary, with no status literal or role list of its own), `verify-course-attendance` **46** unchanged (the API was not touched; re-run from a clean state), `verify-nav-scope` exit 0 with the frozen snapshot byte-identical (the college href list is EIGHT, the marker product 25, and check 10 is new), `verify-college-attendance-access` **17** and `verify-college-attendance-logic` **31** (their consumer pins extended by name, no check relaxed), `verify-college-fees-data` **11**, `verify-college-results-data` **8**, `verify-college-routes` **25 route files / 53 gated handlers** (no API route added or changed), `verify-college-permissions` **8**, `tsc --noEmit` 0 errors. The record is `docs/COLLEGE-DECISIONS.md` §30, which also records the resolved D-8P-5 conflict (staff-only ca-4; the teacher-facing read is post-v1 and stays with the owner).

**Added 2026-10-14 (Phase 8 ca-3)** — the register API's own numbers: `verify-course-attendance` **46 checks** (new: the offline tree pins plus the live HTTP proof from a wiped, reseeded, app-restarted state), `verify-course-teachers` **54** unchanged, `verify-college-attendance-access` **17** unchanged (its consumer pin now names the ca-3 wrapper), `verify-college-attendance-logic` **31** unchanged (its consumer pin now names the two route files and the wrapper), `verify-college-fees-data` **11** (check 8 re-scoped to a `laterSegments` list — `college-fees` + `course-attendance` — with every other check intact), `verify-college-results-data` **8** unchanged, `verify-college-routes` **25 route files / 53 gated handlers** (23/50 at ca-2), `verify-nav-scope` exit 0 (snapshot byte-identical — no nav entry), `verify-college-permissions` **8** unchanged, `tsc --noEmit` 0 errors. The record is `docs/COLLEGE-DECISIONS.md` §29.

The 7c-follow-up full-suite run (the same 36-step list as the 7b run, with
`verify-college-fees-api` last) reproduced **every** count in this section, the known reds included:
`verify-read-cache` **0 pass / 1 fail**, `verify-routine-config` **32 pass / 3 fail** when its calendar-gated section 7 runs, **30 pass / 2 fail / 1 skip** when it does not (both forms are valid — see the note below), `qa-certificates`
**40 / 1** (the credential-gated orphan sweep — corrected at the P2 close-out, see the note below),
`tsc` 0 errors, and `next build` **185/185** pages
(177 at 6f + 7c's eight college fee routes).

**`verify-routine-config` is calendar-gated, and BOTH of its forms are valid.** Its section 7 (the
roster-follows-a-section-override checks) reads the demo teacher's periods for **today** and, when the
teacher has no scheduled period, emits **one `skip` instead of its three checks**
(`scripts/verify-routine-config.mjs`, the `!slot` branch at the top of section 7). So a day that
section cannot run prints **30 pass / 2 fail / 1 skip** — the script's own line reads
"2 failure(s), 1 skipped" — and a day it does run prints **32 pass / 3 fail**, the three added checks
being 2 pass and 1 fail (the owner's record; the 2026-10-12 runs recorded here have not yet landed on
an open-gate day to re-observe it). **The failures are the same class-wide-read defect in both forms**
— the seed writes only section-scoped routines while the route's class-wide read returns the
`sectionId == null` rows — so only the *number* moves, never the cause. The two unconditional
class-wide-read checks (`the class-wide routine loads`, `the removed lessons are really gone`) fail on
every run; section 7's own checks are what the gate adds or withholds.

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
| `scripts/qa-certificates.mjs` | 40 | 1 (credential-gated orphan sweep only) |

Build and types:

| Check | Result |
|---|---|
| `npm run typecheck` | 0 errors |
| `npm run build` | `✓ Generating static pages (177/177)` — 177 pages (164 before integration, 175 after the merge; Phase 6's two college routes make 177) |

**Other counts in the tree at this HEAD:** 46 `verify-*.mjs` scripts; 81 `.mjs` files under `scripts/`;
**6** college API segments (`departments`, `programs`, `courses`, `course-registrations`,
`college-promotion`, `course-results`) covering **30** gated handlers.

**Updated 2026-10-14 (Phase 8-pre — the course↔teacher link):** **58** `verify-*.mjs` scripts (57 recorded
at the Phase 7 close-out; 8-pre adds `verify-course-teachers`), still **7** college API segments — the
link lives INSIDE the existing `courses` segment, because a link is not a new surface class and D-A's
rule is about which directories are college-only — and that segment now covers **50** gated handlers
across **23** college route files (was 47 across 22; `verify-college-routes` prints the new pair).

**Updated 2026-10-11 (Phase 7c-follow-up):** 50 `verify-*.mjs` scripts, and **7** college API segments
(`college-fees` added) covering **47** gated handlers across **22** college route files.

**Known-failing checks (documented, not fixed, pre-existing, out of Phase 6's scope):**
`verify-read-cache` — 1 fail (a latency assertion that does not hold in dev mode); `verify-routine-config`
— 2 fails, or 3 on a day its section 7 runs (the seed writes only **section-scoped** routines while the route's class-wide read returns
the `sectionId == null` rows). Four browser checks in `scripts/smoke-all.mjs` (the two `/print/*` pages
and two `/teacher/marks` checks) are also known-failing, analysed in
[docs/SMOKE-FAILURES.md](docs/SMOKE-FAILURES.md) (a tracked snapshot of an older state, see §8). They are
**not** green, and claiming "the tests are green" would be wrong.

**Re-confirmed 2026-10-11 (Phase 7c-follow-up)**, from a wiped emulator, a fresh seed and a restarted app,
each red suite run alone: `verify-read-cache` **0 pass / 1 fail** (51 routes "still pay full latency on a
repeat read" — the same single assertion), `verify-routine-config` **32 pass / 3 fail** on the day of
that run and **30 pass / 2 fail / 1 skip** on a closed-gate day (the same class-wide read failures,
byte-identical to the 7b run), `qa-certificates` **40 pass / 1 fail** (the
credential-gated orphan sweep). Nothing here is caused by the fee phases, and no count moved anywhere else.

**Correction recorded at the P2 close-out (2026-10-13):** `qa-certificates` prints **40 pass / 1 fail**
since P1c added its QR-slip check; the 39/1 recorded above and in the earlier documents predates that
check. `verify-routine-config` stays in **both** calendar forms (see its note above). The P2 record — the
keyed school-fee payment fix, its full-suite run and the five verifier counts corrected against what the
scripts print — is [docs/PILOT-FIX-2.md](docs/PILOT-FIX-2.md).

**Updated 2026-10-13 (Phase 7d remainder / 7e / 7f) — the fee line's own counts, re-run on the working
tree.** Emulator only (`127.0.0.1:8080`, `demo-ss-test`), a fresh fixture, the app restarted after it:

| verifier | command | exit | count |
|---|---|---|---|
| `verify-mode-mixing` (**new, 7e**) | `node scripts/verify-mode-mixing.mjs` | 0 | **33** — the BOTH-tenant Q3 proof |
| `verify-fees-totals` | `node scripts/verify-fees-totals.mjs` | 0 | **24** = the **15** school checks (unchanged baseline) + **9** college additions |
| `verify-tenant-isolation` | `node scripts/verify-tenant-isolation.mjs` | 0 | **106** ✅ |
| `verify-branch-isolation` | `node scripts/verify-branch-isolation.mjs` | 0 | **73** `PASS` lines (72 checks + its summary) |
| `verify-college-fees-api` (LAST — it resets its own tenants) | `node scripts/verify-college-fees-api.mjs` | 0 | **112/112** |
| `verify-role-probe` (**new, D-7-18**) | `PROBE_ORIGIN=http://127.0.0.1:3111 node scripts/verify-role-probe.mjs` | 0 | **24/24** against production build `bTZhoZ8u8HFwxegmI4rKq` |
| `verify-college-fees-page` (offline) | `node scripts/verify-college-fees-page.mjs` | 0 | **366** — 105 of them the 7d remainder's print-page sections 14–15, the last 6 section 16's copy pins (**360** in the batch that ran before section 16 existed) |
| `verify-college-fees-data` / `-logic` / `-routes` (offline) | as named | 0 | **11** / **21** / **22** (22 route files, 47 gated handlers) |

Two things a reader should carry away. First, `verify-tenant-isolation` and `verify-branch-isolation`
read **106** and **73** here, not the 97 / 65 in the table above: those two figures were measured at 6f
and 7c's college-fee sweep has grown them since — they were re-run **unchanged** by 7e, which is the
claim that matters. Second, the D-7-18 probe needs the fixture's college spine (its own ৳45,000 charge);
`verify-college-fees-api` resets that spine on purpose (line 264, `resetCollegeFees(\`${P}both\`)`), so
the probe runs **before** it, or after a fresh `isolation-fixture create` — the failure mode and both
runs are recorded in [proof/7f/REPORT.md](../proof/7f/REPORT.md) §D-bis.

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
| 19 | Set up the college's fee heads and its programme · term structure | **works** (screen + API) | **College Fees → Fee heads / Fee structure** (`/dashboard/college-fees`); `/api/college-fees/heads` and `/structure`, each handler behind `requireCollege` → the D-7-18 allow-list → `writeGuard`; a duplicate `(programme, term, head)` is a visible 409. Screens proved by `verify-college-fees-page` (366) and the 7d screenshots. |
| 20 | Generate a student's charges and see what is due | **works** (screen + API) | **Dues & generation** tab: `Run preview (writes nothing)` → `Commit these`, then each student's billed/waived/paid/due; `/api/college-fees/generate` (dry-run + idempotent, tops up on a late APPROVED registration), `/charges`, `/dues`; a charge is always DERIVED, never typed by a client. |
| 21 | Take a college payment, and waive money | **works** (screen + API) | The Dues tab's payment form; `/payments` in integer minor units, over-payment refused, the acceptance re-decided inside a guarded transaction, one TAGGED `PAYMENT` entry in the shared ledger and a college `CRCP-…` receipt; `/discounts` follows the school's propose/approve flow (admin-level decides, never the proposer) and an approved award posts a `DISCOUNT` entry. |
| 22 | Print a student's college fee statement | **works** | `/print/college-fee-statement/[studentId]`, linked from each Dues row (`?term=` narrows it); per-term totals, the structure rows that priced it **and the instant each took effect**, and the print date (D-7-17). Same guard chain as the API: session → tenant → college gate → `canReadCollegeFees` → branch. |
| 23 | Print a receipt for one confirmed college payment | **works** | `/print/college-fee-receipt/[chargeId]`, linked from the payment the admin just recorded (`?receipt=CRCP-…` selects one instalment); prints that ONE payment's receipt number and amount, the charge's own billed/paid/due, and the rate that priced it. Asking for a receipt the charge does not hold prints nothing, never a different payment. |

**Journey gaps that sit outside these 21 steps** (the parts a real college needs and does not have):

- **College fees** — **built end to end (7a → 7f), committed 2026-10-14.** A college admin can now define heads and
  a programme-term structure, preview and commit charge generation, take a payment and propose/approve an
  award, and print a statement or a receipt — all behind the D-7-18 allow-list, with the money landing in
  the ONE shared ledger tagged so the two modes can never be confused. What is *not* built is what 8/9 own:
  a college dashboard, college reports, college import (9a/9b/9c) and per-course attendance. The school's
  own fee screens are unchanged and show no college row.
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
- **College dashboard / reports / import** — **missing** (Phase **9a/9b/9c** — renumbered from 8a/8b/8c on
  2026-10-11; `COLLEGE-DECISIONS.md` §10 carries the dated correction). It follows Phase 8 by decision
  (D-CA-6: dashboards are more useful once attendance exists).

---

## 5. What is left (leftover list)

| # | Item | Where | Size | Who it blocks | Blocks a sale? |
|---|------|-------|------|---------------|----------------|
| 1 | ~~**Phase 7 remainder**~~ — **DONE AND COMMITTED (built 2026-10-13, committed 2026-10-14)**: the fee **screens / print pages** (7d), the fee rows' isolation + Q3 regression proof (7e) and the finished record with the production-build role probe (7f). The logic (7a), the data layer (7b) and the API (7c) were already done | `COLLEGE-DECISIONS.md` §24.7; [proof/7e/REPORT.md](../proof/7e/REPORT.md), [proof/7f/REPORT.md](../proof/7f/REPORT.md) | — | — | No — **committed and pushed (`f542405`, `efb97c0`, `946e4e3`); nothing is left on this row** |
| 2 | Phase **9a/9b/9c** (renumbered from 8a/8b/8c — attendance took Phase 8): college dashboard / reports / import — **comes after Phase 8** by decision (D-CA-6) | §10 | Large | College admin | Partly |
| 3 | ~~Per-course college attendance model undecided~~ — **DECIDED 2026-10-11 (owner, Q1/Q8): it is Phase 8**, and its model is D-CA-1…D-CA-7 — a NEW `courseAttendance` collection keyed `ca_<courseId>_<dateKey>_<slot>_<studentId>`, never retrofitted onto the school's `attendance` key, with `8-pre` (the course↔teacher link) built first and v1 marking staff-only. **`8-pre` IS BUILT AND VERIFIED (2026-10-14)** — the `courseTeacher` row with its derived id, its API and `verify-course-teachers` (54 checks) — so a teacher-facing college surface is possible now, and **ca-0 — the attendance allow-list module (`src/lib/college-attendance-access.ts`) — is BUILT AND VERIFIED (2026-10-14; `verify-college-attendance-access`, 17 checks after ca-2)**, **ca-1 — the pure attendance logic (`src/lib/college-attendance.ts`) — is BUILT AND VERIFIED too (2026-10-14; `verify-college-attendance-logic`, 31 checks after ca-2)**, **ca-2 — the `courseAttendance` data layer — is BUILT AND VERIFIED (2026-10-14, §28: the `COLS`/`RELS`/shim model with no pre-existing body touched, the date-key assertion now executed, and the `course-attendance` API segment deferred to ca-3, which creates its directory)**, and **ca-3 — the register's API (roster read, session save, per-student history; §29) — is BUILT AND VERIFIED (2026-10-14; `verify-course-attendance`, 46 checks: the segment entry landed with its directory and the save notifies only a NEW absence through the school's own guardian path)**, and **ca-4 — the register screen + its ONE college nav entry (§30) — is BUILT AND VERIFIED (2026-10-14; `verify-college-attendance-page`, 36 checks offline, with the nav proof's new check 10 and the frozen nav snapshot byte-identical; the screen is staff-only, the REGISTRAR reads it read-only, and D-8P-5's teacher-facing clause is recorded as placement, not scheduling — v1 adds no teacher read)**; the register's isolation/regression pass and finished record (ca-5/ca-6) and the post-v1 family read are NOT built | `COLLEGE-DECISIONS.md` §24.6/§24.8/§25, §10's dated correction | Medium | College teachers | **Yes**, for a college running attendance |
| 4 | ~~College fee heads / structures not modelled~~ — **DONE (7a/7b/7c)**: modelled, stored and served behind `/api/college-fees` | §24 | — | — | No |
| 5 | Post-v1: per-programme scale override (D-6-19) | §23.6 | Small | Owner to confirm | No |
| 6 | Post-v1: per-child guardian view, per-course teacher view | §23.6 | Small–medium | Owner to decide | No |
| 7 | Known-failing checks: `verify-read-cache` (1), `verify-routine-config` (2, or 3 when its calendar-gated section 7 runs), four browser checks — re-confirmed unchanged 2026-10-11 | `scripts/`; [SMOKE-FAILURES.md](docs/SMOKE-FAILURES.md) | Small–medium | Nobody in production; CI trust | No |
| 8 | Routines missing-`sectionId` read hole (the `verify-routine-config` cause) | `src/app/api/routines/route.ts` + `scripts/seed.mjs` | Small | A future reader | No |
| 9 | ~~Super-admin `POST /api/schools` still writes `feeSetting` for a college tenant~~ — **FIXED in `cccbd37` (7-pre)**: the create now guards `feeSetting` with `wizardAcceptsFees(institutionType)`, so a COLLEGE-only tenant is created without one | `src/app/api/schools/route.ts:105-124` | — | — | No |
| 10 | Wizard success screen says "school"; college sidebar still shows school items | onboarding page, `src/components/nav.ts` | Small | College admin | No |
| 11 | `firestore.indexes.json` `schoold` typo: fixed in the file, still live in both databases | `firestore.indexes.json` + the live DBs | Small | Nobody (the shim sorts in memory) | No |
| 12 | Firestore backup not yet confirmed; the old `(default)` database is the **last copy of the pre-cutover data**, and since **pilot P3 (`e5ee07d`)** it is no longer reachable by configuration — a live start with an unnamed or `"(default)"` database is REFUSED, and the rollback is the App Hosting console's **Rollback** button. Its archive date (2026-10-08) has passed; deletion is an owner decision | `src/lib/database-id.ts`, `src/lib/firebase.ts` | Decision | The operator | No |
| 13 | ~~Go-live: role probe on a **production** build~~ — **DONE (7f, 2026-10-13)** for a **local** production build (`npm run build` + `next start`, 24/24 against build `bTZhoZ8u8HFwxegmI4rKq`). A **hosted** (deployed) run has still not been made | `scripts/verify-role-probe.mjs`; [proof/7f/REPORT.md](../proof/7f/REPORT.md) | Small (hosted run) | The operator | No |
| 14 | ~~Go-live: production line decision~~ — **DECIDED (owner console, 2026-10-11): the live branch is `main`.** Backend `smart-school-erp-1` serves branch `main` with automatic rollouts on and **no console variable overrides**, so **`origin/main` (`f4ed2a5`) is production** and `deploy/app-hosting` (`96f4762`) is **NOT** the live branch (pre-integration snapshot only) | owner console screenshot, 2026-10-11 | — | — | No |
| 15 | ~~`docs/PHASE1-DECISION-WORKSHEET.md` and `docs/SMOKE-FAILURES.md` are **untracked** and outdated~~ — **FIXED (2026-10-14): both files are TRACKED** (they entered git in `dfa41aa`); they stay snapshots of an older state, so read them as history | those files | — | — | No |
| 16 | `docs/COLLEGE-PLAN.md` (the original A–I plan) is absent from the repo by design | preamble of `COLLEGE-DECISIONS.md` | n/a | A phase-4+ preflight | No |

Items 7–10 and 15 are cheap documentation/CI/hardening debt; item 1 (the fee screens) is the real
remaining product work on the fee line, and the dashboard/reports/import trio is 9a/9b/9c.

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
- **The fee line runs end to end — API, screens, print pages and paper — committed 2026-10-14.** Heads, structure,
  generation, dues, payments and awards are served, gated and proved over HTTP (112 checks); the **Fee
  heads / Fee structure / Dues & generation / Payment config** screens and the two D-7-17 **print pages**
  exist and are linked from the Dues tab; the money lands in the ONE ledger the school already reads,
  tagged so the two modes can never be confused; and both halves of that claim are now measured, not
  assumed — `verify-mode-mixing` (33) + `verify-fees-totals` (24) prove a BOTH tenant's two modes never
  mix in a read, and the D-7-18 role probe proves the role matrix on a production build. What is missing
  is the next phase's work: the dashboard/reports/import trio (9a/9b/9c) and per-course attendance (8) —
  whose first step, the `8-pre` course↔teacher link, now exists (2026-10-14, D-CA-4), and whose next
  five, ca-0's attendance allow-list, ca-1's pure logic, ca-2's data layer, ca-3's register API and
  ca-4's register screen + nav entry, are built beside it (§25, §26, §27, §28, §29, §30).
  What is missing *right now* is a commit.
- **Testing is strong and offline-first.** **57** `verify-*.mjs` scripts at the Phase 7 close-out (two of
  them new in that phase — `verify-mode-mixing` for the Q3 proof and `verify-role-probe` for D-7-18) and
  **62** after `8-pre` added `verify-course-teachers` (54 checks), ca-0 added `verify-college-attendance-access` (17 checks after ca-2), ca-1 added `verify-college-attendance-logic` (31 checks after ca-2), ca-3 added `verify-course-attendance` (46 checks) and ca-4 added `verify-college-attendance-page` (36 checks), 8 college API segments (the `course-attendance` entry landed with ca-3's directory — §29)
  guarded, the emulator required by design — no script reaches a live database without
  `ALLOW_LIVE_FIRESTORE=1`. A handful of checks are known-failing and documented rather than fixed, and
  the fee phases' offline proofs pin their own invariants as text where they can (the ledger's readers,
  the college entry's tag, the two print pages' guard chain — each of them mutation-proved, so a check
  that cannot fail is not counted as a check).

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
| 9 | "College fees are done" (7c) — and, since 2026-10-13, "College fees are done" (7f) | commit `41d4f41`, then the 7d-remainder/7e/7f work, committed 2026-10-14 (`f542405` code, `efb97c0` docs, `946e4e3` records) | Both sentences need the same qualifier. **At 7c** the API was proved and **no fee screen existed** (7d owned it). **At 7f** the whole line is built and proved (screens, print pages, isolation/Q3, production-build role probe) and **it is now committed and pushed** (`f542405`, `efb97c0`, `946e4e3`) — the earlier "none of it is committed, `git log -1` is still `e5ee07d`" reading was right for the moment it was written and is superseded now. |
| 10 | The college ledger read is a *school* read, so a college row in it must be a bug | D-7-12 / Q3 | It is the tenant's **ONE** ledger: a college payment and an approved award are legitimately on it, **tagged** (`feeId: null` + `meta.collegeFeeId` / `meta.collegeDiscountId`). What must never show college money is a school **fee** surface, and 7c-follow-up pins both halves. |
| 11 | A role probe in a scratch script is the same as a committed check | 7c-follow-up | The ACCOUNTANT / REGISTRAR / BRANCH_ADMIN matrix was a scratch probe during 7c; 7c-follow-up moved it **into** `scripts/verify-college-fees-api.mjs`, where a mutation (adding REGISTRAR to the write list) makes it fail. |

---

## 8. NOT PROVEN — items this report cannot settle

- ~~Whether `deploy/app-hosting` or `origin/main` is the production line.~~ **RESOLVED 2026-10-11 (owner
  console): `main` is the live branch** — backend `smart-school-erp-1` serves `main` with automatic
  rollouts enabled and no console variable overrides; `origin/main` = `f4ed2a5`, `deploy/app-hosting` =
  `96f4762` (**not** live).
- Whether the four known-failing browser checks are caused by stale fixtures today (the analysis in
  `SMOKE-FAILURES.md` predates the current `smoke-all.mjs`; that file is a **tracked** snapshot, not a
  live report).
- A **hosted** production-build role probe of the college screens. The D-7-18 probe has been **run**
  against a local production build (`bTZhoZ8u8HFwxegmI4rKq`, 24/24, 2026-10-13); no deployment was
  created or dialled, so the deployed environment remains unprobed.
- College retain / failed-course rules — no rule is recorded in the repo.
- College-specific guardian-portal content — not verified.
- Which model a future per-course college attendance uses — no rule recorded.
- The exact school nav item count (two documents disagree: 31 vs 34).
- Whether every item `PROGRESS.md` lists as open is closed by `origin/main`.
- **Every claim about college fees in this document is API-level.** No college fee screen or print page
  exists (7d), so there is no rendered fee page, invoice or receipt to look at — and none is claimed.
- Whether a **BOTH** tenant's school half and college half each show only their own fee money is **7e's**
  condition to prove with checks; 7c-follow-up pins the ledger's readers and the tag, not the two halves.
- Whether the shared read cache can serve a stale ledger read across instances (the ~30 s + 120 s memo,
  `src/lib/db.ts`) is a go-live question this document does not settle.
