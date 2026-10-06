# Integration Analysis — mobile-redesign, college-support and the production line

**Type:** read-only analysis. No branch, no commit, no script, no database touched.
**Date:** 2026-10-06. **Author:** Buffy (Codebuff).
**Subject:** how to reconcile three divergent lines and how to get a safe test target.

Everything below is read from this repository's own object database. Line/file claims are backed by
`git` commands; judgement calls and anything I could not confirm are marked **unverified**.

---

## 0. The three lines

| Line | Tip | Meaning |
|---|---|---|
| Production | `origin/deploy/app-hosting` = **`96f4762`** | what is deployed; contains the Firestore cutover |
| Mobile work | `mobile-redesign` = **`79e06b0`** | teacher + guardian mobile redesign; `college-support` was cut from here |
| College work | `college-support` = **`2fda7a4`** | `79e06b0` + docs `1f480dc` + phase 0 `2fda7a4` |

**Divergence base:** `git merge-base 79e06b0 origin/deploy/app-hosting` = **`45c7401`** (2026-10-01).

```
                        45c7401  (feat: redesign exams & results page)
                       /        \
  e96dea8 … 79e06b0 ──┘          └── 701c8af ── f03ce26 ── 96f4762   (= origin/deploy/app-hosting)
        (mobile-redesign)                                       (production)
```

- `college-support` is **3 commits behind** production and **10 ahead** (`git rev-list --count`).
- The 3 production commits it lacks are the *whole* post-divergence production history:
  - **`701c8af`** (2026-10-05) `feat(firestore): configuration-driven database selection` — `apphosting.yaml`, `src/lib/firebase.ts`
  - **`f03ce26`** (login) — `next.config.mjs`, `src/components/LoginForm.tsx`, `src/components/PortalChooser.tsx`
  - **`96f4762`** (revert of the login cache header) — `next.config.mjs`
- Because `96f4762` reverts `f03ce26`'s `next.config.mjs`, the **net** production-side diff since `45c7401` is only **4 files**:
  `apphosting.yaml`, `src/components/LoginForm.tsx`, `src/components/PortalChooser.tsx`, `src/lib/firebase.ts`
  (`git diff --stat 45c7401 origin/deploy/app-hosting` → 4 files, +20/−4).

---

## 1. What mobile-redesign has and deploy/app-hosting lacks

`git log --oneline origin/deploy/app-hosting..79e06b0` — the 8 commits plus the backup commit, newest first:

| Commit | Date | Subject | Feature group (mine) |
|---|---|---|---|
| `79e06b0` | 2026-10-06 13:06 | backup: working tree before college-support planning | **bundles everything below** |
| `c5849cb` | 2026-10-03 00:29 | chore: ignore local audit artifacts | housekeeping |
| `9f2393f` | 2026-10-03 00:28 | fix: exclude parameterized APIs from warm-up | dashboard/perf |
| `009e3b0` | 2026-10-03 00:28 | feat(guardian): use AppShell for parent portal | guardian redesign |
| `033c4b2` | 2026-10-03 00:06 | fix(guardian): polish mobile parity and child switching | guardian redesign |
| `c19a3fe` | 2026-10-02 22:02 | feat(guardian): complete mobile app redesign | guardian redesign |
| `7567918` | 2026-10-02 20:51 | test: guard warmed APIs against parameter-free GET failures | tests |
| `e96dea8` | 2026-10-02 15:58 | feat(teacher): complete mobile app redesign | teacher redesign |

`79e06b0` is a **single backup commit of the whole working tree** (56 files), so its files cannot be
attributed to a feature by commit; they are grouped below by path. Total union
(`git diff --name-only origin/deploy/app-hosting 79e06b0`) = **114 files**.

### Group A — Teacher mobile redesign (`e96dea8`, plus `79e06b0` for the deeper tree)

- `src/app/teacher/*` (16 pages: `page.tsx`, `attendance`, `classes`, `grades`, `homework`, `leaves`,
  `marks`, `meetings`, `messages`, `notifications`, `quizzes`, `remarks`, `resources`, `results`, `ai`,
  `layout.tsx`)
- `src/components/AppShell.tsx` **(added)**, `AppShell.module.css` **(added)**, `MobileTabBar.tsx` **(added)**,
  `MobileMoreSheet.tsx` **(added)**, `MobileSheet.tsx` **(added)**, `app-nav.ts` **(added)**,
  `app-ui.tsx` **(added)**, `GradingSchemeEditor.tsx`, `InstallApp.tsx`, `NotificationBell.tsx`,
  `NotificationsCenter.tsx`, `ChatPanel.tsx`
- `src/lib/assistant/*` **(added)**, `src/app/api/assistant/route.ts` **(added)**
- `src/app/globals.css`, `scripts/lib/headless.mjs` **(added)**, `scripts/smoke-all.mjs`

### Group B — Guardian mobile redesign (`c19a3fe`, `033c4b2`, `009e3b0`, `79e06b0`)

- `src/app/parent/*` (18 pages) + `src/app/parent/ai/page.tsx` **(added)**
- `src/app/parent/layout.tsx` (now uses `AppShell`, `009e3b0`)
- reuses Group A's `AppShell.tsx`, `ChatPanel.tsx`, `InstallApp.tsx`, `NotificationsCenter.tsx`

### Group C — Dashboard / perf / shared client (`79e06b0`)

- `src/app/dashboard/page.tsx`, `src/app/dashboard/students/[id]/page.tsx`, `src/app/api/stats/route.ts`
- `src/components/Shell.tsx`, `src/components/nav.ts`, `src/lib/client.ts`, `src/lib/route-data.ts`,
  `src/lib/stats-cache.ts`, `src/lib/db.ts`, `src/lib/query-diagnostics.ts` **(added)**, `src/lib/auth.ts`
- `src/lib/__tests__/query-pushdown.test.ts` **(added)**, `__tests__/warm-endpoints.test.ts` **(added from `7567918`)**

### Group D — Admission intake (`79e06b0`)

- `src/app/api/admissions/intake/route.ts`, `src/lib/admission.ts`, `scripts/verify-admission-intake.mjs`

### Group E — Academic sessions (`79e06b0`)

- `src/lib/academic.ts` **(added)**, `src/app/api/academic-sessions/route.ts` **(added)**,
  `.../[id]/route.ts` **(added)**, `.../[id]/set-current/route.ts` **(added)**,
  `src/app/dashboard/academic-sessions/page.tsx` **(added)**, `scripts/verify-academic-sessions.mjs` **(added)**

### Group F — Bulk import (`79e06b0`)

- `src/lib/import/{fields,normalize,plan,request,write}.ts` **(all added)**
- `src/app/api/import/students/{commit,preview,template}/route.ts` **+** `[batchId]/{route,undo,credentials}/route.ts` **(all added)**
- `src/app/dashboard/students/import/page.tsx` **+** `import/[batchId]/page.tsx` **(added)**
- `src/app/print/guardian-credentials/[batchId]/page.tsx` **(added)**
- `scripts/verify-bulk-import.mjs`, `verify-branch-isolation.mjs`, `verify-qr-credentials.mjs` **(added)**

### Group G — Promotion (`79e06b0`)

- `src/app/api/students/promote/route.ts` (modified — the file **exists** on production in an older form),
  `src/app/api/students/alumni/route.ts`, `src/app/dashboard/promotion/page.tsx`,
  `scripts/verify-promotion-rollover.mjs` **(added)**

### Group H — Onboarding (`79e06b0`)

- `src/app/api/onboarding/route.ts` **(added)**, `src/app/dashboard/onboarding/page.tsx` **(added)**,
  `scripts/verify-onboarding-monitor.mjs` **(added)**

### Group I — Lifecycle + enroll + family (`79e06b0`)

- `src/app/api/students/[id]/lifecycle/route.ts` **(added)**, `src/lib/enroll.ts` **(added)**,
  `src/lib/family.ts` **(added)**, `scripts/verify-enroll-paths.mjs` **(added)**

### Group J — Other (`79e06b0`, `c5849cb`)

- `.gitignore`, `src/app/globals.css`, `src/app/api/auth/login/route.ts`, `src/app/api/students/route.ts`,
  `scripts/verify-{cache-scoping,phase7-e2e}.mjs` **(added)**

**Production-absent files** (`git cat-file -e origin/deploy/app-hosting:<path>` fails):
`AppShell.tsx` **(NO/MOBILE:yes)**, `app-ui.tsx` **(NO/yes)**, `academic.ts` **(NO/yes)**, `enroll.ts` **(NO/yes)**,
`family.ts` **(NO/yes)**, `import/*` **(NO/yes)**, `onboarding/route.ts` **(NO/yes)**, `lifecycle/route.ts` **(NO/yes)**.
**Present on production** (older revision): `nav.ts`, `Shell.tsx`, `db.ts`, `grading-store.ts`,
`routine-config.ts`, `exams-cache.ts`, `client.ts`, `api/classes/route.ts`, `api/subjects/route.ts`,
`api/stats/route.ts`, `students/promote/route.ts`.

---

## 2. Overlap with what production changed since 45c7401 — predicted conflicts

Production-side files changed since `45c7401`: `apphosting.yaml`, `src/components/LoginForm.tsx`,
`src/components/PortalChooser.tsx`, `src/lib/firebase.ts`.

Per-side comparison against the merge base (`git diff --quiet 45c7401 <side> -- <file>`):

| File | changed by production? | changed by mobile-redesign? | Verdict |
|---|---|---|---|
| `apphosting.yaml` | **YES** | NO | production wins, **no conflict** (mobile never touched it) |
| `src/lib/firebase.ts` | **YES** | NO | production wins, **no conflict** |
| `src/components/LoginForm.tsx` | **YES** | **YES** | both sides → check, see below |
| `src/components/PortalChooser.tsx` | **YES** | **YES** | both sides → check, see below |
| `next.config.mjs` | no (net zero) | NO | no conflict |

`comm -12` of the two sides gives exactly **`LoginForm.tsx` and `PortalChooser.tsx`** — the only
genuine both-sides files. However, the two sides made the **identical** change: the blob hashes in
`git diff 45c7401 origin/deploy/app-hosting` and `git diff 45c7401 79e06b0` are the same
(`LoginForm  b615470..8fb248f`, `PortalChooser 8d87b71..6059efa`) — i.e. `79e06b0` already contains the
production login `prefetch={false}` fix, and `git diff --name-status origin/deploy/app-hosting 79e06b0`
does **not** list those two files at all.

**Verified in-memory merge** (old-form `git merge-tree`, which writes no objects):

```
git merge-tree 45c7401 origin/deploy/app-hosting 79e06b0   →  conflict markers: 0   "changed in both": 0
git merge-tree 45c7401 origin/deploy/app-hosting 2fda7a4   →  conflict markers: 0
```

**Prediction: merging mobile-redesign (or college-support) into the production line produces zero
conflicts.** The merge keeps production's `firebase.ts` and `apphosting.yaml` (the DB-selection
change), because mobile-redesign never modified those files.

---

## 3. Does mobile-redesign assume the `(default)` database?

Not *actively* — it simply **predates** the selection, which is worse in a different way.

- `src/lib/firebase.ts` on `79e06b0` is the **pre-selection** version:
  ```ts
  export function getDb(): Firestore {
    if (!_db) _db = getFirestore(adminApp());   // <- no database argument
    return _db;
  }
  ```
- `apphosting.yaml` on `79e06b0` declares only `FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL /
  FIREBASE_PRIVATE_KEY / JWT_SECRET / FIREBASE_STORAGE_BUCKET / APP_URL` — **no `FIRESTORE_DATABASE_ID`**.
- `git grep -n "(default)" 79e06b0 -- src scripts apphosting.yaml firebase.json` → **only three
  unrelated UI labels** (`Current session (default)`, `Whole class (default)`, `indigo (default)`).
  No database reference anywhere.
- Every script on the mobile side uses bare `getFirestore()` (see §6). None reads any DB-id variable.

**Conclusion:** nothing in mobile-redesign *conflicts* with `FIRESTORE_DATABASE_ID` at the code level —
mobile simply lacks both the field and the variable. Consequence: **deploying the mobile-redesign line
without merging production into it would silently revert the app to `(default)` (africa-south1)**,
re-introducing the ~3 s cross-region reads, and would also drop the login work. This is an operational
risk, not a merge conflict.

---

## 4. Option A — integrate mobile-redesign into production first, then college-support

### Steps (recommended; none run here)

```bash
git fetch --all                                    # refresh refs
git checkout -b integrate/prod-mobile origin/deploy/app-hosting

# 1) bring the mobile work onto the production line (zero conflicts, verified above)
git merge --no-ff mobile-redesign -m "merge: mobile redesign onto production line"

# 2) prove it compiles and builds
node node_modules/typescript/bin/tsc --noEmit
node node_modules/next/dist/bin/next build

# 3) rebase the two college commits on top (zero conflicts, verified above)
git checkout college-support
git rebase integrate/prod-mobile          # replays 1f480dc then 2fda7a4
```

If a linear history is preferred over a merge commit, the equivalent is
`git checkout -b integrate/prod-mobile origin/deploy/app-hosting && git cherry-pick e96dea8^..79e06b0`
(replays the 8 commits), then the rebase in step 3. **The merge is lower-risk** and preserves the exact
mobile blobs; `git merge-tree` already shows it is clean.

### Expected conflicts

**None.** Verified with `git merge-tree` (§2). Production's `firebase.ts` / `apphosting.yaml` survive
because mobile-redesign does not touch them; `LoginForm.tsx` / `PortalChooser.tsx` are byte-identical
on both sides.

### Risks

1. **Rebase rewrites history.** `git rebase integrate/prod-mobile` re-creates `1f480dc` / `2fda7a4` with
   new hashes. `college-support` has no remote yet, so nothing shared is disturbed — but the SHAs in
   the Phase 0 report become stale. A merge of `integrate/prod-mobile` into `college-support` keeps the
   original SHAs; pick one deliberately.
2. **Production deploy is not performed by this.** The integrated branch must be deployed through App
   Hosting with `FIRESTORE_DATABASE_ID=smart-school-db` still set; losing that variable reverts the DB.
   **Unverified:** that the App Hosting secret/variable lives on the branch or on the backend config —
   `apphosting.yaml` on production carries `- variable: FIRESTORE_DATABASE_ID`, but its value is
   supplied by the console, so I cannot confirm it from the repo.
3. **`origin/main` has a *different* cutover implementation** (`FIRESTORE_DB_ID`, plus `firebase.json`
   dual targets `(default)` + `smart-school-db`, plus `scripts/migrate-firestore.mjs` /
   `verify-firestore-parity.mjs`) that is **not** on production. Merging mobile→production does not
   address that; the two env-var schemes (`FIRESTORE_DB_ID` vs `FIRESTORE_DATABASE_ID`) must eventually
   be reconciled (see §7).
4. **Mobile work is big** (114 files). Build/typecheck is the only cheap proof; there is no test suite
   coverage for most of it.

### How to verify without touching production data

- `git merge-tree` in-memory (already done) — predicts conflicts with zero writes.
- `tsc --noEmit` + `next build` on the integrated tree (this repo's standard gate; both pass today on
  `college-support`).
- Run the app **locally with `FIRESTORE_DATABASE_ID` unset** → resolves to `(default)`, which is the
  retired database (**unverified** how stale it is, but it is not the live one). Better: see §6.
- Deploy to a **non-production App Hosting rollout** (a separate backend/revision) and probe
  `GET /api/health`; do not point any script at the production URL.
- Never start a local server with `FIRESTORE_DATABASE_ID=smart-school-db` — that is the documented
  benchmarking practice (`_perf-remediation/LOGIN-PAYLOAD-AUDIT.md:25`) and it writes **live** data.

---

## 5. Option B — move only the college commits (docs + Phase 0) onto production

```bash
git checkout -b college-on-prod origin/deploy/app-hosting
git cherry-pick 1f480dc 2fda7a4      # docs, then phase 0
```

Phase 0 itself would be fine: every file it touches exists on production —
`src/app/api/schools/route.ts`, `src/app/api/schools/[id]/route.ts`, `src/app/api/auth/me/route.ts`,
`src/components/Shell.tsx`, `src/app/admin/schools/[id]/page.tsx`, `src/app/admin/schools/page.tsx`
(all confirmed present on `origin/deploy/app-hosting`), plus the new `src/lib/institution.ts`.

**What breaks — the college plan's later phases are written against mobile-only code.** From
`docs/COLLEGE-PLAN-DELTA.md`:

| Delta section | Depends on (mobile-only unless noted) | Prod status |
|---|---|---|
| §2 current session key | `src/lib/academic.ts:21`, `:46-47` (`currentSessionKey`) | **absent on prod** |
| §2 fee defaults | `src/lib/enroll.ts:185-202` (`enrollStudent` → `createStudentFees`) | **absent on prod** |
| §2 bulk import | `src/lib/import/fields.ts:50` (`IMPORT_FIELDS`) | **absent on prod** |
| §4 switcher placement | `Segmented` from `src/components/app-ui.tsx` (later moved to `~:155-190`) | **absent on prod** |
| §5 teacher switcher | `src/components/AppShell.tsx` (teacher/guardian shell) | **absent on prod** |
| §6 Phase 1 | `src/components/AppShell.tsx` | **absent on prod** |
| §6 Phase 3 | `src/app/api/students/promote/route.ts` (promotion ladder) | **present but older** — the college promotion work assumes the mobile rewrite |
| §6 Phase 7c | `src/lib/import/fields.ts` (import columns) | **absent on prod** |
| §1 / Phase M | `src/lib/grading-store.ts`, `src/lib/routine-config.ts`, `src/lib/academic.ts` (mode-suffixed keys) | two present, **`academic.ts` absent** |

So Option B does not merely "lose a few files": **it deletes the foundation of Phase M, Phase 1,
Phase 3, Phase 7c** (the switcher component, the teacher shell, the session/import/enroll libraries,
and the promotion ladder). Those phases would have to be **re-planned** to build against production's
older code — re-implementing `app-ui.tsx`/`AppShell.tsx`, or reworking §4/§5 to the pre-redesign `nav.ts`
+ `Shell.tsx` patterns, and re-deriving the session/import/enroll seams.

**Also note:** Option B produces a college-support branch whose *runtime* is the production line
(correct DB, correct login) but whose *plan* targets code that will not exist there — a documentation
landmine for every subsequent phase.

---

## 6. Safe test target

### 6.1 What exists today

- The **app** selects the database through `src/lib/firebase.ts` (`getDb()`): `FIRESTORE_DATABASE_ID`
  set ⇒ `getFirestore(adminApp(), databaseId)`; unset ⇒ `(default)`. Production sets it to
  `smart-school-db`.
- The **scripts** do not participate in that decision at all:
  - **35 files import `firebase-admin`**; of those, **32 scripts call bare `getFirestore()`** (no
    database argument). Full list: `_qa-verify.mjs`, `_tmp-audit-scan{,-2}.mjs`, `_tmp-final-check.mjs`,
    `_tmp-orphan-{map,scan}.mjs`, `audit-counts.mjs`, `backfill-child-schoolid.mjs`, `check-seed.mjs`,
    `clean-legacy-notifications.mjs`, `fix-fee-paidamount.mjs`, `isolation-fixture.mjs`,
    `seed-kit-demo.mjs`, `seed-marksheet-demo.mjs`, `seed.mjs`, `sweep-demo-junk-fees.mjs`, and
    `verify-{academic-sessions,admission-intake,branch-isolation,bulk-import,cache-scoping,
    class-sessions,enroll-paths,guardian-child,notifications,onboarding-monitor,phase7-e2e,
    promotion-rollover,qr-credentials,routine-config,tenant-isolation,user-secrets,write-integrity}.mjs`.
  - The initialization pattern is uniform: `loadEnv()` → `initializeApp({ projectId:
    process.env.FIREBASE_PROJECT_ID, credential: cert({…FIREBASE_CLIENT_EMAIL…FIREBASE_PRIVATE_KEY}) })`
    → `const db = getFirestore();` (e.g. `scripts/verify-academic-sessions.mjs:15,35-44`).
    `scripts/isolation-fixture.mjs` uses `service-account.json` / `applicationDefault()` instead
    (`:15,23,25`).
  - **None** reads `FIRESTORE_DATABASE_ID` (`grep -rln FIRESTORE_DATABASE_ID scripts/` → empty, on every
    branch including production).

### 6.2 The two write paths, and why "local" is not automatically safe

| Path | Destination | Why |
|---|---|---|
| Script → **HTTP** → app | whatever DB the **target server** resolves | `BASE`/`BASE_URL`/`SMOKE_ORIGIN` default to `localhost`, but a production origin (or a local server started with `FIRESTORE_DATABASE_ID=smart-school-db`) writes live data |
| Script → **Admin SDK** (`db.collection(...).set/update/delete`) | **always `(default)`** | bare `getFirestore()` ignores `FIRESTORE_DATABASE_ID`; the SDK resolves `(default)` |

Because many verify scripts use the direct SDK for **assertions and cleanup** (e.g.
`scripts/verify-cache-scoping.mjs:105,185,238-256`, `scripts/verify-admission-intake.mjs:360-396`,
`scripts/verify-branch-isolation.mjs:209-225`), pointing only the *app* at a test database produces
**divergent state**: writes land in the test DB while cleanup/assertions hit `(default)`, i.e. false
pass/fail plus stray documents. Both halves must move together.

### 6.3 Option 6a — a separate non-production database in the same project

Feasible, but requires a **code change on the script side**:

1. Create a second named database in `amar-e-school` (e.g. `smart-school-test`). *Creating it is a
   write to the project — outside this read-only task; must be approved.*
2. Point the **test server** at it: run with `FIRESTORE_DATABASE_ID=smart-school-test`
   (`getDb()` already honours it — no app code change).
3. Make the **scripts** honour the same switch. Least-churn shape: one new shared module
   `scripts/lib/admin-db.mjs` that calls `loadEnv()`, initializes the app, reads
   `FIRESTORE_DATABASE_ID`, and exports a `db` built with `getFirestore(app, dbId)`. Then replace
   `getFirestore()` with that import in the 32 files, and route `isolation-fixture.mjs` through it too.
4. Add a **production guard** in that helper: abort when the resolved target is the production DB
   (`FIREBASE_PROJECT_ID === "amar-e-school"` **and** database is `smart-school-db`), or when the HTTP
   base/SMOKE_ORIGIN looks like the App Hosting host. This is the single most valuable safety net.
5. Seed the test DB (`scripts/seed.mjs`) — the verify scripts assume the demo dataset
   (`principal@sunrise.edu`, `s@…` school ids in `verify-tenant-isolation.mjs`, etc.).

Cost: ~32 small edits + one helper. No new runtime dependency.

### 6.4 Option 6b — the Firestore emulator (cleanest, but currently blocked)

The app is **already emulator-aware**: `src/lib/firebase.ts:56` treats `FIRESTORE_EMULATOR_HOST` as
"credentials available", and `INSTALL.md:155-172` documents running the whole app with no Firebase
account via `npx firebase emulators:start --only firestore` + `FIRESTORE_EMULATOR_HOST=localhost:8080`.

Key advantage: **the emulator needs no script edits.** The Admin SDK routes to the emulator when
`FIRESTORE_EMULATOR_HOST` is set, so all 32 bare `getFirestore()` scripts follow it automatically, and
the app follows it too — one variable aligns both write paths.

**Blockers / caveats:**

- **Java is not installed** (`java -version` → *command not found*), and `INSTALL.md` step 1 states the
  emulator needs it. **The emulator cannot run on this machine until a JRE is installed.** This is the
  decisive drawback for the current environment.
- `firebase.json` has **no `emulators` block**, so `emulators:start` would use defaults (port 8080) or
  require a config edit.
- The Firebase CLI is present at `node_modules/.bin/firebase`, but its shim needs `node` on `PATH`
  (`firebase --version` → `exec: node: not found`); with only portable Node on this machine it must be
  run with Node on `PATH` or via `npx`.
- The emulator starts **empty** → `npm run setup`/`seed.mjs` must seed it first; file-upload paths need
  `--only firestore,storage` and `FIREBASE_STORAGE_BUCKET`.
- `.firebase/amar-e-school` (933 MB) is deploy cache (`functions` 929 MB, `hosting` 3.7 MB), **not**
  emulator data — so there is no pre-existing emulator dataset to reuse.
- **Unverified:** that `getFirestore(adminApp(), databaseId)` (the production code path) coexists
  cleanly with `FIRESTORE_EMULATOR_HOST`. Locally the variable is unset, so the app takes the plain
  `getFirestore(adminApp())` branch and the emulator is honoured; the combined case was not run.

### 6.5 Recommendation for the test target

- **Short term (no new infra, no Java):** Option 6a with a guard, but only if creating a second database
  is approved. Until then, the only strictly-safe local configuration is a server whose
  `FIRESTORE_DATABASE_ID` is unset/blank (→ `(default)`) **and** scripts restricted to read-only
  (`verify-deployed-rules.mjs` is the sole read-only verify script) — i.e. do not run the mutating ones.
- **Best target overall:** the **emulator** (6b), once Java is installed — it is the only option where
  a single environment variable makes *every* write path, HTTP and direct SDK, land somewhere disposable.
- **Never:** production URL `smart-school-erp-1--amar-e-school.asia-southeast1.hosted.app`, or
  `FIRESTORE_DATABASE_ID=smart-school-db`.

---

## 7. Recommendation

**Do Option A** (integrate mobile-redesign into the production line, then rebase the two college
commits). Reasons, in order:

1. It is **conflict-free and provable** — `git merge-tree` shows 0 conflicts for both merges, and the
   only both-sides files are already byte-identical.
2. It preserves the **Firestore cutover** (`701c8af`) and the login work (`f03ce26`, `96f4762`) instead
   of silently reverting them (§3).
3. It keeps the college plan's foundations — `app-ui.tsx` (`Segmented`), `AppShell.tsx`,
   `academic.ts`, `enroll.ts`, `family.ts`, `import/*`, `promote` — which Option B would delete from
   under Phases M/1/3/7c (§5).
4. Production already runs the mobile work's *sibling* code path (production is `45c7401` + the 3
   commits), so the integration is a merge of two branches that agree on 110 of 114 files.

**Order of steps**

1. Decide **Option A vs B** (below).
2. Create `integrate/prod-mobile` from `origin/deploy/app-hosting`; **merge `mobile-redesign`** (no
   conflicts expected).
3. `tsc --noEmit` + `next build` on the integrated tree.
4. Rebase (or merge) `college-support` onto it so `1f480dc` + `2fda7a4` sit on the production line.
5. Set up the **safe test target** (§6) before running any `verify-*`/`smoke-all` script.
6. Only then resume the college plan (Phase M next).
7. Separately, reconcile `origin/main`'s older `FIRESTORE_DB_ID` / dual-`firebase.json` line with
   production's `FIRESTORE_DATABASE_ID` — do not let two cutover schemes coexist.

**Decisions I need from you**

1. **Option A or Option B?** (Recommend A.)
2. **Rebase or merge** for the college commits — rebase rewrites the two Phase 0 SHAs; merge keeps them.
3. **Is the mobile redesign intended to ship to production?** All 114 files, or only teacher/guardian
   (Groups A/B) with dashboard/perf (Group C) left out? Nothing in the repo says.
4. **Test target:** approve a **second named database** in `amar-e-school`, or install **Java** for the
   emulator? (Emulator preferred; Java is the blocker.)
5. **`origin/main` reconciliation** — when, and which env-var name wins (`FIRESTORE_DATABASE_ID`).
6. **`docs/COLLEGE-PLAN.md`** was never saved; do you want the original A–I plan written to disk
   (I can only do that from your earlier message, not from the repo).

---

## Unverified items

- The **live** value of `FIRESTORE_DATABASE_ID` on the serving revision — read from
  `_perf-remediation` reports, not from the console/deployment.
- Whether App Hosting carries the variable **on the backend config** or the branch (§4 risk 2).
- Whether `getFirestore(app, databaseId)` + `FIRESTORE_EMULATOR_HOST` coexist cleanly (§6.4).
- Whether `.firebase` ever held emulator data (it holds deploy cache only now).
- Which of `MIGRATION-PHASE3-CUTOVER-REPORT.md` and `.blocked.md` is final (both dated 2026-10-05).
- Per-file attribution inside `79e06b0`, which is a single working-tree backup commit.
- Whether the mobile-redesign branch is meant to be deployed at all.
