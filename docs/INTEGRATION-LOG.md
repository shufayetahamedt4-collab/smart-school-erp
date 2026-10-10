# Integration log — `origin/main` merged into the college line

**Branch:** `integration/main-into-college` (scratch; created from `college-support` @ `632fb0f`)
**Merged:** `origin/main` @ `f4ed2a5` (10 commits, merge base `b3b7a04` `fix(api): pre-push QA findings …`)
**Shape:** `git merge --no-ff --no-commit origin/main` — a **clean trial merge produced exactly 10
conflicted files / 13 hunks, and no others** (reproduced in a throwaway worktree, see "How the list was
proved"). Nothing was staged from a conflicted index; each file below was resolved by hand.

**Principle applied throughout:** keep **both** lines. A feature is only "resolved" when the school
side (onboarding wizard, plan limits, CSV import/export, certificate templates, timetable builder,
region cutover) *and* the college side (institution types, mode foundation, college gate, departments /
programmes / courses / terms, course registration, college identity, promotion ladder + 6-pre) both
work. Where both sides changed the same function the union was written and marked as such.

---

## The 10 conflicted files

### 1. `PROGRESS.md`
- **School side (origin/main):** the 243-line school/SaaS progress log (2026-09-18 → 2026-09-24,
  ending with the region-migration session and its rollback procedure).
- **College side:** the same log forked forward with ~1,150 lines of college session entries.
- **Kept:** origin/main's text **verbatim**, plus a 20-line closing section ("College support lives in
  its own document") appended at the bottom. That section points at `docs/COLLEGE-STATUS.md` (the
  full college story: phases, commit hashes, verifier counts, remaining work), `docs/COLLEGE-DECISIONS.md`
  and `docs/COLLEGE-PLAN-DELTA.md`, restates the phase-6-pre naming rule, and records this merge.
- **Why:** PROGRESS.md is the *school/SaaS* product's "read me first" and now carries the college line
  only as a pointer — this was the instructed resolution ("keep main's text and append a short pointer").
  The college entries are **not lost**: they live on `college-support` and in
  `docs/COLLEGE-STATUS.md`, which is the designated record for them. This is the one place where
  content physically moved out of a file; it is deliberate and disclosed in the merged file itself.

### 2. `apphosting.yaml`
- **School side:** `FIRESTORE_DB_ID: smart-school-db` (the cutover switch) + `minInstances: 1`.
- **College side:** `FIRESTORE_DATABASE_ID: smart-school-db`, `FIREBASE_STORAGE_BUCKET`,
  `ALLOW_LIVE_FIRESTORE: "1"` + `minInstances: 1` (taken from main's perf session).
- **Kept:** the college side's block — `FIRESTORE_DATABASE_ID` (canonical), the storage bucket and the
  live-Firestore opt-in — plus main's `minInstances: 1` (same value, so nothing to choose).
  `FIRESTORE_DB_ID` is **not** set here.
- **Why:** one variable name in the deployment config, one behaviour. Both names resolve to the same
  database in `src/lib/firebase.ts` (below), so production reads `smart-school-db` either way; setting
  one name avoids two switches that could disagree. `ALLOW_LIVE_FIRESTORE` must be present or the
  runtime guard refuses to build a client in production.

### 3. `scripts/isolation-fixture.mjs`
- **School side:** credential init (`service-account.json` → `applicationDefault()`) and
  `getFirestore(undefined, process.env.FIRESTORE_DB_ID || "(default)")`.
- **College side:** the same file with the emulator-only init *and* the whole college fixture
  (COLLEGE / BOTH / registrations-only tenants, departments, programmes, courses, mappings, students,
  registrations) plus the college collections in the cleanup sweep.
- **Kept:** the college version, i.e. `requireEmulator()` + `initializeApp({ projectId })` +
  `getFirestore()`; main's two lines are deliberately **not** used.
- **Why:** this script writes throwaway fixture documents; it is emulator-only by design, and a named
  Cloud database is exactly what it must never touch. The new `FIRESTORE_DB_ID` rule in
  `scripts/lib/guard.mjs` closes the hole main's env name would otherwise have opened.

### 4. `scripts/verify-tenant-isolation.mjs`
- **School side:** credential init + `FIRESTORE_DB_ID` selection.
- **College side:** emulator-only init + the college sweep (13 routes incl. `/api/departments`,
  `/api/programs`, `/api/courses`), the college gate probes, the cross-tenant course-registration
  probes and the downgrade probes.
- **Kept:** the college version (same reason as #3). **Every** college check is intact; nothing from
  main's side of this file was a *check* — its only additions were the two init lines.
- **Count note:** the merged run reports **75 original isolation checks + the college block** (the
  college additions were already on `college-support`); main added no new assertions here, so the
  count is unchanged from the college baseline. The final line reads "13 swept routes".

### 5. `src/app/api/certificates/route.ts`
- **School side:** cross-school student certificate read → **403** (and main's QA suite
  `scripts/qa-certificates.mjs` asserts exactly that).
- **College side:** the *same* condition but answered **404**, plus a guardian-ownership check and a
  teacher-`viewOwnClass` check.
- **Kept:** the union — guardian ownership, staff-school check, teacher scope — with the staff-school
  case answering **403**.
- **Why:** the two conditions were identical, so only the status code differed and only one can be
  returned. `qa-certificates.mjs` (school side, from main) asserts 403; no college verifier asserts 404
  for this case. A student that does not exist still gets 404 from the lookup above, so existence is
  not leaked for ids that don't exist. See "Results" for the college suites that cover this route.

### 6. `src/app/api/onboarding/route.ts` — **add/add**
- **School side:** the **tenant onboarding wizard** (`GET`/`POST /api/onboarding`; the Super-Admin
  §3.3 flow, with the extend-mode admin-step rule from `0f9c5f3`).
- **College side:** the **Guardian Onboarding Monitor** (Phase 5, read-only: status derivation, summary,
  filters, branch isolation, orphaned accounts, print-slip eligibility).
- **Kept:** main's wizard at **`/api/onboarding`** unchanged (byte-identical to origin/main's file —
  verified with `git diff origin/main -- src/app/api/onboarding/route.ts`, empty).
  The college monitor moved to **`/api/guardian-onboarding`** (`src/app/api/guardian-onboarding/route.ts`),
  byte-for-byte the old file apart from a path-note comment (verified by a path-normalised diff: the only
  difference is the added comment).
- **Callers updated:** `src/app/dashboard/onboarding/page.tsx` (the monitor UI),
  `scripts/verify-onboarding-monitor.mjs`, `scripts/verify-phase7-e2e.mjs`,
  and the frozen API-surface list in `scripts/verify-college-routes.mjs` (`guardian-onboarding` added).
- **Why:** the wizard has its own page (`/onboarding/page.tsx`) and its own callers, so keeping the
  wizard path and moving the monitor is the smaller change; the monitor's URL is internal to the app
  (only the page calls it), so no external contract breaks. Both features work; the wizard keeps the
  path its verifier and QA suites expect.

### 7. `src/app/api/students/route.ts`
- **Conflict:** the import line only.
  - School side: `import { writeGuard, planLimitGuard } from "@/lib/subscription";`
  - College side: `scopeWhere`, `queryId`, `resolveBranchId`, `writeGuard` imports.
- **Kept:** the **union** — all of college's imports **plus** `planLimitGuard`. The rest of the file
  auto-merged (no other hunk), so the college GET scoping/`queryId`/branch drill-down and main's
  `POST` plan-limit enforcement now both exist in one file.

### 8. `src/components/Shell.tsx`
- **School side:** the old monolithic shell whose `NAVS` array is inline; across its 10 commits it
  added **four** items (`/dashboard/timetable`, `/dashboard/billing`, `/dashboard/import-export`,
  `/dashboard/certificate-templates`) and the three icons they use.
- **College side:** the shell refactored to import `navForRole`/`groupNavFor` from `./nav` (all
  items, groups and role gating live in `src/components/nav.ts`), plus the account menu, mode switch
  and skeleton handling.
- **Kept:** the college `Shell.tsx` **as-is** (identical to `college-support`), and main's four items
  were added to **`src/components/nav.ts`** for both `SCHOOL_ADMIN` and `BRANCH_ADMIN`, with their
  group mapping (`timetable` → academics, `billing` → finance, `import-export` +
  `certificate-templates` → operations).
- **Proof nothing was dropped:** `git diff <merge-base> origin/main -- src/components/Shell.tsx` is
  **exactly** those 3 icon imports + 4 nav rows (7 added lines, 0 removed) — all 7 are accounted for
  in `nav.ts`. `scripts/nav-scope-snapshot.json` was regenerated for the four new items and its
  `capturedFrom` field records that they came from `f4ed2a5`, so `verify-nav-scope` keeps its meaning.

### 9. `src/lib/db.ts`
- **School side:** `certificateTemplate: "certificateTemplates"` in `COLS` + its `RELS` entry + the
  `prisma.certificateTemplate` model registration.
- **College side:** the bulk-import collections, the college collections (departments, programmes,
  courses, programme-courses, course registrations, terms…), `promotionRun`, and the `$claim` /
  `$renewOwned` / `$releaseOwned` helpers.
- **Kept:** the **union** — `certificateTemplate` was woven into `COLS`, `RELS` and `prisma` beside
  the college entries; no existing body from either side was removed. (Two stray conflict marker
  lines that a first pass had left in `COLS`/`prisma` were removed before staging.)
- **Verification:** every line either side *added* against the merge base is present in the result
  (added-line audit: 0 missing from either side).

### 10. `src/lib/firebase.ts`
- **School side:** `if (!_db) _db = getFirestore(adminApp(), process.env.FIRESTORE_DB_ID || "(default)");`
  (the cutover switch; comment mentions `.freebuff/migration/`).
- **College side:** the live-Firestore guard (`assertLiveFirestoreAllowed()` / `ALLOW_LIVE_FIRESTORE`)
  and `FIRESTORE_DATABASE_ID` selection.
- **Kept:** the guard **and** the configuration-driven selection, with a documented alias:
  `const databaseId = process.env.FIRESTORE_DATABASE_ID || process.env.FIRESTORE_DB_ID;` — unset ⇒ the
  project's `(default)` database (the rollback database). Canonical name: `FIRESTORE_DATABASE_ID`;
  `FIRESTORE_DB_ID` is accepted as an explicit alias and is documented in the file, in
  `apphosting.yaml`, in `scripts/lib/guard.mjs` and in `docs/ENVIRONMENTS-AND-SECRETS.md`.
- **No production behaviour had to be chosen:** both names point at `smart-school-db`. The only
  difference is which name wins when *both* are set (canonical), and that never happens in the
  deployment because `apphosting.yaml` sets only the canonical one.

---

## Guard hardening this merge made necessary

Main's ten commits taught 12 utility/QA scripts to read `FIRESTORE_DB_ID`. On the college side the
emulator guard (`scripts/lib/guard.mjs`, `requireEmulator()`) is what keeps fixture-writing scripts
off a live database. Merging main's switch without touching the guard would have left a hole: an
emulator run with `FIRESTORE_DB_ID` exported could have selected the named Cloud database. Therefore:

- `scripts/lib/guard.mjs` now **also** refuses when `FIRESTORE_DB_ID` is set, with the same
  fail-closed wording as for `FIRESTORE_DATABASE_ID`.
- `requireEmulator()` was added to the scripts that write fixtures/data and previously relied only on
  credentials: `scripts/seed.mjs`, `scripts/check-seed.mjs`, `scripts/_qa-verify.mjs`,
  `scripts/audit-counts.mjs`, `scripts/backfill-child-schoolid.mjs`.
- The **migration tools from main are added files on this branch**, so they brought main's
  production behaviour with them. `docs/TESTING.md` §5 requires production-targeted scripts to fail
  closed here, while `PROGRESS.md` records these two as permanent operator tools — so both now
  refuse to start (exit 1, `[SAFETY]` banner) unless the operator deliberately sets
  `ALLOW_LIVE_FIRESTORE=1`, the **same opt-in the app itself uses**. That keeps them re-runnable for a
  human running the cutover and impossible to run by accident.
  (`scripts/qa-certificates.mjs`, `qa-phase23.mjs`, `qa-phase3.mjs`, `qa-cleanup-users.mjs` are main's
  QA suites: they are left as main wrote them — their credential-dependent sweeps (storage,
  orphaned-user cleanup) simply skip themselves when no live credentials are present, which is why
  `qa-certificates.mjs` reports its one credential-dependent cleanup step as failed under the
  emulator-only env; see the results section.)
- The app-side guard in `src/lib/firebase.ts` (`ALLOW_LIVE_FIRESTORE`) is unchanged and still the only
  way the running app reaches live Firestore.

---

## How the list was proved

- A throwaway worktree (`/tmp/wt-college` @ `college-support`) re-ran `git merge --no-ff --no-commit
  origin/main`: **10 files, 13 hunks, no others** — matching this list exactly (the add/add for
  `api/onboarding` shows as `AA`).
- Added-line audit: for every file **both** sides touched (21 files), every line each side *added*
  relative to the merge base was looked for in the merged tree. The only additions absent are:
  - the two `FIRESTORE_DB_ID` init lines in the two isolation scripts (replaced by the emulator-only
    init — see #3/#4),
  - main's three `firebase.ts` lines (replaced by the alias-aware line, see #10),
  - main's four `apphosting.yaml` lines (replaced by the single canonical variable, see #2),
  - three comment lines and the 404 line in `certificates/route.ts` (see #5),
  - main's seven `Shell.tsx` lines (moved into `nav.ts`, see #8),
  - `PROGRESS.md`'s college entries (see #1).
  Nothing else from either side is missing.

---

## Results — merged branch vs the recorded college-support baseline

Every run below is on this branch, against the local Firestore emulator
(`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, `FIREBASE_PROJECT_ID=demo-ss-test`,
`FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` empty, `FIRESTORE_DATABASE_ID` / `FIRESTORE_DB_ID`
unset), with the app restarted from the merged tree, re-seeded (`npm run setup`) and with a fresh
`isolation-fixture` create.

### The usual ten — identical to baseline, check for check

| Verifier | Baseline | Merged | Fail |
|---|---|---|---|
| `verify-college-enrollment` | 40 | **40** | 0 |
| `verify-course-registrations` | 50 | **50** | 0 |
| `verify-registration-status` | 9 | **9** | 0 |
| `verify-tenant-isolation` | 75 | **75** | 0 |
| `verify-branch-isolation` | 52 | **52** | 0 |
| `verify-college-gate` | 3 | **3** | 0 |
| `verify-college-permissions` | 7 | **7** | 0 |
| `verify-college-routes` | 3 | **3** | 0 |
| `verify-nav-scope` | 7 | **7** | 0 |
| `verify-college-terms` | 8 | **8** | 0 |

**`verify-tenant-isolation` stays at 75 — no new checks.** origin/main's side of that file added no
assertions: its only additions were the two credential/FIRESTORE_DB_ID init lines, deliberately not
used (see #4). The college block's own count (75, sweeping 13 routes) is therefore the merged total.

### Promotion + foundation — identical to baseline

| Verifier | Baseline | Merged | Fail |
|---|---|---|---|
| `verify-college-promotion-logic` | 12 | **12** | 0 |
| `verify-college-promotion-api` | 100 | **100** | 0 |
| `verify-college-promotion-page` | 18 | **18** | 0 |
| `verify-college-promotion-lease` | 113 | **113** | 0 |
| `verify-promotion-rollover` ×10 | 50 each | **50 each (10/10 runs)** | 0 |
| `verify-mode-foundation` | 64 | **64** | 0 |

### School-side suites that came in with the merge (origin/main's own coverage)

| Script | Source | Result |
|---|---|---|
| `scripts/qa-phase23.mjs` | origin/main | **36 passed, 0 failed** — onboarding wizard (create + extend + duplicate-admin rejection), CSV import dryRun/commit/re-import, export CSVs, plan-limit 402s (students *and* `/api/admissions?action=enroll`), billing usage/invoice |
| `scripts/qa-phase3.mjs` | origin/main | **18 passed, 0 failed** — timetable builder (teacher double-booking 409, replace-swap), substitution finder, printable TC/character certificates |
| `scripts/qa-certificates.mjs` | origin/main | **39 passed, 1 failed** — the failure is the final **credential-gated orphaned-user sweep** (`else fail("orphaned user sweep", "no Firebase credentials — run with --env-file=.env")`), which cannot run under the emulator-only rule. All 39 content checks pass, including *cross-school certificate read rejected (403)*, *cross-school PATCH/DELETE rejected (404)*, *guardian cannot read another child (403)*. The equivalent sweep was performed directly against the emulator instead (3 orphan QA users removed). |
| `scripts/qa-cleanup-users.mjs` | origin/main | Not run as-is: it hard-requires live `FIREBASE_*` credentials and exits 1 without them. Its emulator-scoped equivalent (same email patterns) was run by hand: 3 orphaned QA users removed. |
| `scripts/verify-firestore-parity.mjs` | origin/main | Production-only tool (compares the two LIVE named databases). It now **fails closed** without `ALLOW_LIVE_FIRESTORE=1`. Run once before the guard was added, under the emulator env, it produced a vacuous "PARITY OK" over zero collections — it proves nothing on the emulator and was not counted as evidence. |
| `scripts/migrate-firestore.mjs` | origin/main | Production cutover copier; same fail-closed guard. Not run (it copies between the live databases). |

### College/school regression verifiers also re-run

| Script | Result |
|---|---|
| `verify-bulk-import` | **117 passed, 0 failed** (see the note below) |
| `verify-onboarding-monitor` | **44 passed, 0 failed** — against the **renamed** `/api/guardian-onboarding` path |
| `verify-phase7-e2e` | **160 passed, 0 failed** — import/undo/credentials/print end-to-end |

### Types and build

| Check | Baseline | Merged |
|---|---|---|
| `npx tsc --noEmit` | 0 errors | **0 errors** |
| `next build` | exit 0, `Generating static pages (164/164)` | **exit 0, `Generating static pages (175/175)`** |

**Why 175, and why that is not 164 + 6.** The route table grew by **13 entries, and nothing was
lost** (a route-set diff against the baseline build shows 0 routes only in the baseline):

- **6 new page routes** (all origin/main): `/onboarding`, `/dashboard/billing`,
  `/dashboard/import-export`, `/dashboard/certificate-templates`, `/dashboard/timetable`,
  `/print/certificate/[studentId]`. Legend census: static pages 84 → 89, dynamic pages 16 → 17.
- **7 new API routes**: six from origin/main (`/api/certificate-templates`,
  `/api/certificate-templates/[id]`, `/api/export`, `/api/import/students`, `/api/import/teachers`,
  `/api/subscription/billing`) plus `/api/guardian-onboarding` — the college monitor's new path,
  which is an added route because the old `/api/onboarding` path is now the wizard's.
- Next's `Generating static pages` counter went 164 → 175 (+11). That counter counts *rendered
  pages*, not route-table rows: it did not equal the legend entry count in the baseline either
  (164 vs 100 non-API routes). The six new page routes are 6 of the 11; the remaining 5 are
  prerender instances Next counts for dynamic segments. Nothing regressed: no page or API route
  from the baseline disappeared.

### Wizard smoke (step 5)

A throwaway script (`.freebuff/wizard-smoke.mjs`, not committed) created a tenant of type **SCHOOL**
through the Super Admin API (`POST /api/schools` → 201, `institutionType: "SCHOOL"`), then drove the
§3.3 wizard the way its own route/QA suite does: `GET /api/onboarding?schoolId=` (super) →
sign in as the new tenant's admin → `GET /api/onboarding` (own school) → `POST /api/onboarding`
**extend mode** with a class (2 sections), a subject and fee settings → `GET` again shows
`onboarded: true` with progress. **15 passed, 0 failed**, then the tenant and its admin user were
deleted.

**Is the wizard institution-type aware today? No — and this merge did not make it so.** The wizard
carries no `institutionType` in its status payload, and posting `institutionType: "COLLEGE"` to it is
ignored (the tenant stays `SCHOOL`). Creating the tenant's *type* is institution-aware (the Super
Admin API validates and stores it, and the admin UI gained an institution-type field from the college
side); the wizard itself is next-stage work, as expected.

### One failure found and driven to root cause

`verify-bulk-import` first reported **113 passed / 4 failed**. The four failures were all the same
symptom: rows that duplicate an *existing* admission number were classified `ALREADY_IMPORTED`
("already imported by this roster") instead of `DUPLICATE_ADMISSION_NO`. Cause: the verifier selects
the "existing student" it duplicates, and the row it selected
(`ISO-OTHER-1791546071350`, name `Scale Dup 1791546090395`) was a **leftover test student from a
verify run that was killed mid-flight** (its id, `st_imp…`, is an import-pipeline deterministic id, so
the preview correctly recognised it as this roster's own earlier import). It is emulator test
residue, not product behaviour: after deleting that one orphan document the suite is
**117 passed / 0 failed**, twice in a row. No check was weakened, skipped or deleted.

---

## Superseded local-main commits

Two commits on the local `main` line (`deploy/app-hosting`) are **superseded on this branch — do not
re-apply them**: their effect is already here, written as equivalent changes rather than as the same
patch, so cherry-picking either would duplicate a fix rather than restore one. Both are additionally in
this branch's ancestry, so nothing is missing; this note exists so a later reader does not "restore"
them by hand.

- **`25547a0`** `fix(attendance): Section=All no longer sends sectionId=undefined; API normalizes legacy
  param` (2026-09-20). Equivalent here: `queryId()` in `src/lib/utils.ts`, which reads the literal
  `"undefined"` / `"null"` query values as "no filter", with `src/app/api/attendance/route.ts` reading
  `sectionId` through it.
- **`70d0176`** `fix(auth): /api/auth/me resolves the QR guardian synthetic session instead of 401`
  (2026-09-20). Equivalent here: the QR synthetic-session branch at the top of
  `src/app/api/auth/me/route.ts` (a signed session whose id is `qr-<studentId>` resolves to a read-only
  identity built from the claims and the linked student, with no user-document lookup).
