# Testing safely — the emulator-only rule

Every script under `scripts/` that **touches Firestore or calls an application server** must
**never** run against a Cloud database — not this project's and not any other tenant's. That
covers more than the `verify-*` suites:

- **verification suites** — `scripts/verify-*.mjs`, `scripts/smoke-all.mjs` (write fixtures and
  clean up existing rows);
- **seeders** — `scripts/seed.mjs` (`npm run seed`), `scripts/seed-kit-demo.mjs`,
  `scripts/seed-marksheet-demo.mjs`;
- **maintenance writes** — `scripts/backfill-child-schoolid.mjs`,
  `scripts/clean-legacy-notifications.mjs`, `scripts/fix-fee-paidamount.mjs`,
  `scripts/sweep-demo-junk-fees.mjs`;
- **read-only audits** — `scripts/audit-counts.mjs`, `scripts/check-seed.mjs`,
  `scripts/_qa-verify.mjs` (reads can leak live data too, so they are guarded as well);
- **fixtures** — `scripts/isolation-fixture.mjs`;
- **HTTP benchmarks / parity** — `scripts/bench-*.mjs`, `scripts/parity-*.mjs`;
- **setup** — `scripts/setup.mjs` (`npm run setup`), which seeds Firestore.

**Rule: never run any of these without the emulator.**

Each one calls `requireEmulator()` from `scripts/lib/guard.mjs` as its first statement (immediately
after `loadEnv()` where that helper is used, and always **before** the first Firestore client or
`fetch()`). The guard fails closed (`process.exit(1)`) unless the environment is demonstrably a
**local Firestore emulator**. There is no bypass flag and no production escape hatch.

---

## 1. Prerequisites

- **Java (JRE 11+)** — the Firestore emulator requires it. Check with `java -version`.
- **Node on `PATH`** — the Firebase CLI shim needs `node` (this machine ships a portable Node
  only, so add its folder to `PATH` for the session, or invoke the CLI through it).
- The Firebase CLI is already in `node_modules` (`node_modules/.bin/firebase`).

## 2. Start the emulator

**Start the Firestore emulator before running `npm run setup`, `npm run seed`, or any other
database-touching test/verification command.** Nothing in this list may be run first.

```bash
# from the repo root
npx firebase emulators:start --only firestore --project demo-ss-test \
    --config firebase.emulator.json
```

Use the standalone **`firebase.emulator.json`**, which carries only the emulators block:

```json
{
  "emulators": {
    "firestore": { "host": "127.0.0.1", "port": 8080 },
    "singleProjectMode": true
  }
}
```

so Firestore comes up on **127.0.0.1:8080**. The project's main `firebase.json` also lists an
`emulators` block, but it cannot be used here: its `hosting` / web-framework config makes the CLI
demand the webframeworks experiment before it will start, so a Firestore-only run against it fails.
That is why the emulators block lives in a separate, hosting-free config.

The Firestore emulator hosts a **single database per project**, so `FIRESTORE_DATABASE_ID` must
stay **unset** — the emulator has no `smart-school-db`. Add `,storage` to `--only` and a `"storage"`
emulator block (in `firebase.emulator.json`) only if you are exercising upload paths.

## 3. Environment variables

Export **`FIRESTORE_EMULATOR_HOST` to the emulator loopback address** in the shell that runs the
app and the scripts:

```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export FIREBASE_PROJECT_ID=demo-ss-test   # any id; the emulator namespaces by project
```

These must be **unset**:

| Variable | Why it must be unset |
|---|---|
| `FIRESTORE_DATABASE_ID` | It selects a **named Cloud** database (`smart-school-db` in production). Set it and the app talks to real data. The emulator is selected **only** by `FIRESTORE_EMULATOR_HOST`. |
| `FIRESTORE_DB_ID` | The **alias** for `FIRESTORE_DATABASE_ID` (`src/lib/firebase.ts` reads either, the canonical name winning when both are set). It must be unset for the same reason — and `requireEmulator()` rejects it explicitly, so an exported cutover value cannot slip past the guard. |
| `FIREBASE_CLIENT_EMAIL` | The emulator needs no credentials. |
| `FIREBASE_PRIVATE_KEY` | The emulator needs no credentials. |
| `SMOKE_ORIGIN` | Pointing it at a deployment makes the HTTP half of a script write to that deployment regardless of the emulator. Must be **unset or loopback**. |
| `BASE` / `BASE_URL` | Same reason as `SMOKE_ORIGIN`. Must be **unset or loopback**. |

In short, the guard requires all of the following:

- `FIRESTORE_EMULATOR_HOST` is set and resolves to a loopback host
  (`localhost`, `127.0.0.0/8`, or `::1`);
- `FIRESTORE_DATABASE_ID` **and its alias `FIRESTORE_DB_ID`** are unset;
- `FIREBASE_PROJECT_ID`, if set, is only paired with a loopback emulator host;
- `SMOKE_ORIGIN`, `BASE` and `BASE_URL`, if set, resolve to a loopback host;
- `FIREBASE_CLIENT_EMAIL` and `FIREBASE_PRIVATE_KEY` are unset.

The guard rejects any of these that resolves to a non-loopback host, and rejects a non-loopback
`FIRESTORE_EMULATOR_HOST` even when `FIREBASE_PROJECT_ID` is set.

Seed the emulator once it is up:

```bash
npm run setup     # scripts/setup.mjs -> the guard permits it (emulator-only run)
```

Then start the app with the same variables exported and run the scripts normally.

## 4. Guarded (emulator-only) scripts

Newly guarded in this change: `seed.mjs`, `setup.mjs`, `audit-counts.mjs`, `check-seed.mjs`,
`isolation-fixture.mjs`, `backfill-child-schoolid.mjs`, `clean-legacy-notifications.mjs`,
`fix-fee-paidamount.mjs`, `sweep-demo-junk-fees.mjs`, `seed-kit-demo.mjs`, `seed-marksheet-demo.mjs`,
`_qa-verify.mjs`, `bench-routes.mjs`, `bench-stats.mjs`, `parity-diff.mjs`, `parity-diff-qr.mjs`,
`parity-sweep-routes.mjs`.

The institution-type-aware onboarding change adds two verifiers, with deliberately different needs:

- `scripts/verify-onboarding-type.mjs` — **guarded** (`requireEmulator()`). It creates real tenants
  through the wizard API, checks the seeded school/college halves and deletes them again, so it may
  only ever run against the emulator, with the app already up:
  `SMOKE_PORT=3000 node scripts/verify-onboarding-type.mjs`.
- `scripts/verify-onboarding-seed.mjs` — deliberately **unguarded and offline**. It exercises only the
  pure decision table in `src/lib/onboarding-seed.ts` (plus two route files read as text), so it opens
  no socket, writes nothing, and needs neither the emulator nor a server:
  `node scripts/verify-onboarding-seed.mjs`.

Phase 7a (the pure college fee logic) adds one more **unguarded, offline** verifier:

- `scripts/verify-college-fees-logic.mjs` — **deliberately unguarded and offline**, in the shape of
  `verify-college-grading-logic.mjs`. It exercises only the pure decision table in
  `src/lib/college-fees.ts` (head and structure validation, the cadence → billing-events rule, the term
  totals, the charge derivation from an enrolment plus its APPROVED registrations, the discount/waiver
  arithmetic and the dues/payment rules), and it *reads* `src/lib/college-terms.ts` and
  `src/app/api/fee-categories/route.ts` only to pin the term model and the school's own bucket/cadence
  lists against it. It opens no socket, writes nothing, and needs neither the emulator nor a server:
  `node scripts/verify-college-fees-logic.mjs` (**21 checks**).

Phase 7b (the college fee data layer) adds one more **unguarded, offline** verifier:

- `scripts/verify-college-fees-data.mjs` — **deliberately unguarded and offline**, in the shape of
  `verify-college-results-data.mjs`. It reads `src/lib/db.ts` as text (that module imports firebase-admin)
  and pins the four college fee collections, the additive proof (the recorded pre-7b checksums of the `COLS`
  entry list, the `RELS` key list, *every pre-existing `RELS` body* and the prisma accessor list must all
  reproduce once the four new entries are dropped), the relations, the no-derived-id rule, and that no school
  fee route, lib, page, print page or school-fee verifier names a college fee model. It opens no socket, writes
  nothing, and needs neither the emulator nor a server:
  `node scripts/verify-college-fees-data.mjs` (**11 checks**). Two of those eleven were added by
  7c-follow-up and read the ONE shared ledger as TEXT: the code-level readers of that ledger are exactly
  `src/lib/ledger.ts` (its two query helpers), `src/app/api/ledger/route.ts` and
  `src/app/api/export/route.ts` (`?type=ledger`) — a new reader fails until it is added to that list,
  which is what makes the inclusion of college money a reviewed decision — and `confirmCollegePayment`
  must keep writing `feeId: null` + `meta.collegeFeeId`, no school `payment` row, and its own `CRCP-`
  receipt sequence.

Also in 7b: `verify-college-results-data.mjs` (6b's) keeps its **8 checks** and its pre-6b baselines,
but now drops the four later-phase college-fee models (its `LATER_MODELS`) alongside its own `courseResult`,
so a later phase's legitimate addition is not misread as a 6b regression while an edit to a pre-existing
entry still fails it. 7c adds `collegeDiscount` to that later-phase drop list and to 7b's
`verify-college-fees-data.mjs`, so both offline proofs stay additive: the pre-7b checksums still reproduce
**courseResult included**.

Phase 7c (the college fee API) adds one **guarded, HTTP** verifier:

- `scripts/verify-college-fees-api.mjs` — **guarded** (`requireEmulator()`), and it needs the app running and
the college fixture tenant created (`node scripts/isolation-fixture.mjs create`). Unlike the offline pair above,
it drives the eight `/api/college-fees` routes over HTTP against the shared fixture: the D-7-18 role matrix and
its 403/400/404 refusals (each bracketed by a document count), 7a's unit/basis refusals at the API, the visible
`(program, term, head)` 409, idempotent generation with a late-registration top-up, payments in integer minor
units with over-payment refused, **two simultaneous payments that together exceed the due**, the school's
propose/approve award flow with no self-approval, the shared ledger entries, and that no college row appears in
any school fee read. It deletes its own rows on the way out, and it is documented as **run once per app start**:
it resets the tenant through firebase-admin, which cannot invalidate the app's in-process pull memo
(`src/lib/db.ts`, 30 s + 120 s of stale-while-revalidate).
  `SMOKE_PORT=3000 node scripts/verify-college-fees-api.mjs` (**112 checks** — 86 at 7c plus the
  7c-follow-up additions: the three-check staff matrix, where the ACCOUNTANT and the BRANCH_ADMIN reach
  all 17 handlers and the REGISTRAR reaches every read and is 403 on every write, and six ledger-reader
  checks that pin what a school-facing ledger read shows of college money: the tenant's ledger and the
  `?type=ledger` CSV include the college row TAGGED (`feeId: null` + `meta.collegeFeeId`), a student's
  own ledger shows their own college payment, and no school `payment` row is written; plus
  **7e-pre's 17 checks** (`824e80d`) that a college payment can never be recorded twice — a replay of
  one idempotency key, ten simultaneous taps with one key and ten racing keys all leave exactly one
  ledger row per payment that landed, the stored paid amount never exceeds what was billed, and a
  same-key retry carrying a different amount or method is refused).

Pilot P2 adds one more **guarded, HTTP** verifier:

- `scripts/verify-school-fee-idempotency.mjs` — **guarded** (`requireEmulator()`), and it needs the app
  running: 32 offline pins (the deterministic ids, the guarded fee write, the route's key handling)
  plus 37 live concurrency checks (two different keys together, one key simultaneous, one key
  sequential, a retry after the fee settled, 600+600 against 1000, the full amount, keyless), **69/69**.
  It is inserted after `verify-fees-totals` in the suite order, and its record — with the full-suite
  run and the five verifier counts corrected against what the scripts print — is
  [docs/PILOT-FIX-2.md](docs/PILOT-FIX-2.md).

Pilot P2c adds one more **guarded, HTTP** verifier — and the suite runner the earlier runs kept outside
the repository:

- `scripts/verify-fee-reconciliation.mjs` — **guarded** (`requireEmulator()`), and it needs the app
  running: it creates one fee per drift class directly in the emulator and proves each is reported with
  the right class and INTEGER amounts, proves a fee paid through the keyed `POST /api/fees/[id]/pay` path
  is NOT reported, walks the school with `limit` + `cursor` and checks the REPORTED read cost against the
  rows that really exist for each page, proves another tenant's fees never appear (and that the same read
  by a super admin for that other school does show them), checks the role matrix (SCHOOL_ADMIN /
  ACCOUNTANT / SUPER_ADMIN(+`?schoolId`) in; REGISTRAR, TEACHER, STUDENT, GUARDIAN, a branch-confined
  ACCOUNTANT and an unauthenticated caller out, none of them receiving a fee row), and proves the route
  writes nothing (a content hash of the money books plus the total document count of EVERY collection,
  before and after, after first proving the database quiescent). `--mutations` then reverses the route one
  property at a time — drop class (i), drop the tenant scope, allow GUARDIAN, make it write — shows the
  matching check FAIL, and restores the file byte-identical (sha256). **53 checks** (65 with `--mutations`).

Phase 8-pre (the course↔teacher link, docs/COLLEGE-DECISIONS.md §25) adds one **guarded, HTTP**
verifier:

- `scripts/verify-course-teachers.mjs` — **guarded** (`requireEmulator()`), and it needs the app running
  and the college fixture tenant (`node scripts/isolation-fixture.mjs create`). Its OFFLINE half is the
  first in this repository to **import** a pure module rather than re-read it as text (`registerHooks`,
  the `verify-college-gate.mjs` trick): `src/lib/course-teachers.ts` is exercised for real — the derived
  id `ct_<courseId>_<teacherId>`, the strict `["TEACHER"]` assignee allow-list, the list normaliser —
  and the tree is then pinned AS TEXT: `COLS.courseTeacher` with NO `idFor`/`idForCreate` entry, the new
  `RELS.courseTeacher` key, the `prisma` accessor, **that no pre-existing RELS body was touched** (6b's
  and 7b's additive proofs hash them), the route's guard order, the course DELETE's new block, the
  `COLLEGE_MODEL_RE` / `LATER_MODELS` wiring, and that no non-college API file reaches the model. Its
  LIVE half drives `GET`/`POST`/`DELETE /api/courses/[id]/teachers` against the fixture: assign (the
  stored row carries the derived id, the course's branch and the actor), a re-assign that is a `200
  already: true` no-op with the collection count unchanged, the list resolving the teacher's name, the
  foreign-teacher / non-TEACHER-account / ghost-id / missing-id refusals (400, no row), the foreign-course
  and ghost-course 404s, the role matrix (admin-level + REGISTRAR read, REGISTRAR 403 on both writes,
  ACCOUNTANT/TEACHER/GUARDIAN/STUDENT 403 on both), a SCHOOL tenant 403 with no data, branch confinement
  in both directions, unassign (and a 404 on repeating it), and the course DELETE blocked while a teacher
  is assigned and succeeding after — every assertion bracketed by document counts, everything it created
  deleted on the way out. **54 checks.** It is inserted in the suite's college group, BEFORE
  `verify-college-fees-api` (which resets its own tenant LAST); its record is
  [proof/8pre/REPORT.md](../proof/8pre/REPORT.md).

Phase 8 ca-0 (the college attendance allow-list, docs/COLLEGE-DECISIONS.md §26) adds one more
**unguarded, offline** verifier:

- `scripts/verify-college-attendance-access.mjs` — deliberately unguarded and offline, in the shape of
  `verify-college-results-page.mjs`'s access section. It IMPORTS `src/lib/college-attendance-access.ts`
  (`registerHooks`) and exercises the rule for real: the exact allow-lists (WRITE = SUPER_ADMIN /
  SCHOOL_ADMIN / BRANCH_ADMIN; READ = the writers + REGISTRAR; no ACCOUNTANT), the full role × direction
  truth table (raw junk refused), the measured proof that the rule is narrower than the school's
  `attendanceMarks` module (`can()` admits TEACHER `entry`, GUARDIAN `view` and STUDENT `viewOwn`; the
  rule refuses all three), the REGISTRAR read-only, and both refusal sentences. It then pins ca-0's
  boundary as text: no file under `src/` consumes the module yet (ca-3/ca-4 own the consumers), the
  school's `/api/attendance` route is untouched, and `src/lib/db.ts` carries no `courseAttendance` — a
  pin ca-2 removes with the collection. **18 checks.** It is wired into `suite-all.mjs`'s pure list
  beside `verify-college-permissions`.

- `scripts/suite-all.mjs` — the suite runner, now IN the repository. The earlier runs were driven by a
  wrapper in a temp directory, which is exactly why `BASE`/`BASE_URL` never reached
  `verify-exams-invalidation`, `qa-phase23` and `qa-certificates`: each dialled its own dead port instead
  of the running app ([docs/PILOT-FIX-2.md](docs/PILOT-FIX-2.md) §8). It exports `SMOKE_PORT`,
  `VERIFY_PORT`, `BASE` and `BASE_URL` for every verifier, wipes the emulator + `seed.mjs` +
  `isolation-fixture.mjs create` (+ `seed-kit-demo.mjs` for `verify-admission-intake` and
  `verify-write-integrity`) and RESTARTS the app before every server-backed verifier — which is what makes
  the order-sensitive group (`verify-sweep-routes`, `verify-admission-intake`, the bulk-import/onboarding
  pair) deterministic — keeps `verify-college-fees-api` LAST (see below), prints each verifier's exit code
  and **its own count**, and fails on any unexpected non-zero exit. `node scripts/suite-all.mjs`;
  `SUITE_ONLY=a,b`, `SUITE_FROM=<name>` and `SUITE_PURE=0` resume a long run. Logs go to
  `$SUITE_LOG_DIR` (default `<tmp>/sspr/suite-logs`): one file per verifier, plus `progress.log` and
  `results.json`.

Also in P2c: `GET /api/fees/reconciliation` — a READ-ONLY, admin-only, school-scoped report over the
school's own fee book (the drift classes `fee_above_sums`, `payment_ledger_mismatch`, `sums_above_fee`),
whose ledger read is registered in `verify-college-fees-data.mjs`'s ledger-reader audit. It was reviewed
in that audit's terms: every query is keyed by a fee id taken from the school's own fee rows, so a college
entry (`feeId: null` + `meta.collegeFeeId`, D-7-12) can never be returned, summed or displayed.

**One ordering rule the college fee verifiers share with the demo-school ones.** A verifier that reads a row an
earlier verifier created *through the app* is safe (the app's own writes clear its memo), but one that reads a row
created **and deleted** by an earlier verifier can still see the deleted row in the memo for up to 150 s. That is
why `verify-tenant-isolation.mjs` now builds its cross-tenant college fee spine **over HTTP** instead of seeding
it raw — raw seeding is invisible to the very read used as the positive control — and why the demo-school
verifiers (`verify-bulk-import.mjs`, `verify-admission-intake.mjs`) must run **before** the onboarding verifiers,
which create and delete `ONB-*` students in the demo school. The same rule as "restart the app after an emulator
wipe".

**Why `verify-college-fees-api` runs LAST — stated here, because 7d makes it load-bearing.** The suite's order
(`docs/COLLEGE-STATUS.md` §3 records the exact sequence) puts the 7c HTTP verifier **last**, and the reason is
mechanical rather than stylistic: it **resets its own tenant**. Its teardown deletes, through `firebase-admin`,
the fee heads, structure rows, charges, awards and config rows its checks created (and it rebuilds the fixture
tenant's spine). Writing through `firebase-admin` goes straight to Firestore and therefore **cannot invalidate
the app's in-process pull memo** (`src/lib/db.ts`, ~30 s TTL plus 120 s stale-while-revalidate). A verifier that
ran *after* it would therefore be able to read a row the reset had just deleted and fail for a reason that has
nothing to do with the code under test. The same rule is why the demo-school verifiers run before the
onboarding verifiers, and why the app is restarted after every emulator wipe. **Add new college fee verifiers
before it, never after.**

The same rule reaches one more verifier that does not read through the memo: **`verify-role-probe` (D-7-18)
must run before `verify-college-fees-api` too**, because the reset above deletes the fixture's BOTH-tenant
college spine that the probe's `authorized college access` checks assert against. The probe run recorded in
`proof/7f/production-role-probe-24-of-24-recheck.txt` shows both states: 20/24 immediately after the reset,
24/24 after `node scripts/isolation-fixture.mjs create`.

Phase 7d (the college fee screens, the ledger's college badge and the college sidebar) adds one more
**unguarded, offline** verifier:

- `scripts/verify-college-fees-page.mjs` — deliberately unguarded and offline, in the shape of
  `verify-college-results-page.mjs`. It exercises only the pure page layer in `src/lib/college-fees-view.ts`:
  the ONE money helper over integer minor units (zero, one paisa, odd amounts, a huge amount, junk, a negative
  and both currency label shapes), the typed-money reader, the D-7-18 write-control map and the page-state
  gate, the shared ledger's college TAG and its split (never summed) totals, the wizard success screen's
  per-half lines, and the double-submit/refusal rules. It *reads* the three pages, the nav registry
  (`src/components/nav.ts`), the two fee routes and `college-fees-access.ts` as text to pin what the screens
  call and what they must not re-inline. `node scripts/verify-college-fees-page.mjs` (**255 checks** at
  `54e9ea4` — 214 when 7d wrote this line, plus the further checks `cac825c` (7d-fix) added), and it
  is **mutation-proved** — each of these makes it fail, and restoring the file makes it pass again: a REGISTRAR
  shown a write control, a money form that is not disabled while its request is in flight, float arithmetic on
  money in a page, a write control rendered without its `controls.<id>` guard, the ledger's two halves summed
  together, a "School settings" button on a college tenant's success screen, the fee nav entry's
  `requires:"COLLEGE"` marker removed, and the structure read's additive `programmes` payload dropped.

Phase 7d's **remainder** (D-7-17's two print pages, 2026-10-13) grows that same offline verifier — it
stays unguarded, offline and mutation-proved, at **366 checks** (255 at `54e9ea4`; the 7d-remainder batch of 2026-10-13 ran it at **360**, section 16's six copy pins coming after):

- **sections 14–15** pin the two new routes as text — `/print/college-fee-statement/[studentId]` and
  `/print/college-fee-receipt/[chargeId]` exist, each applies the SAME guard chain in the SAME order as
  the API (session → the student's/charge's tenant → `collegeGateDecision` → `canReadCollegeFees` →
  `canAccessBranch`, with the *returning* `if` asserted, not a bare mention), neither imports the
  NextResponse-shaped `requireCollege`, neither writes, neither reaches a school fee surface, both read
  through 7c's own loaders (`loadCollegeFeeConfig` / `loadStructure`, `chargeTotals`), the statement names
  its rates **and the instant each took effect** (read AND printed — a read whose value is dropped fails),
  and the receipt prints ONE payment through the tagged per-charge rule (`pickReceiptEntry` on the number
  it was asked for; the newest only when none was asked for). The pure halves (`statementTermValue`,
  `statementTerms`, `statementScopeText`, `isCollegePaymentEntryFor`, `paymentReceiptNo`,
  `pickReceiptEntry`, `structureRateText`, `structureEffectiveAt`, `chargeSettlementText`, the two
  `…Href` builders) are exercised directly.
- **three mutations, each making it fail, each restored byte-identically** (`sha1sum -c` OK; transcripts
  `proof/7d/mutate-1-…`, `-2-…`, `-3-…`, `mutate-restored.txt`): the statement page's branch confinement
  deleted (`1 ❌ of 360` — the file's count before section 16), the receipt page ignoring the `?receipt=` number
  (`1 ❌`), and `isCollegePaymentEntryFor` matching any charge (`1 ❌`).
  The restored run then was `PASSED — 360 checks.`; with
  section 16 in the file, the same run ends `PASSED — 366 checks.` and its two copy mutations each fail
  `2 ❌ of 366` (proof/7d's rows 4–5).

Phase 7e (the fee rows' isolation and the BOTH-tenant Q3 proof) adds one **guarded, HTTP** verifier and
grows an existing one:

- `scripts/verify-mode-mixing.mjs` — **guarded** (`requireEmulator()`), needs the app and
  `node scripts/isolation-fixture.mjs create`. It is the D-7-12/Q3 condition measured rather than
  assumed, on the ONLY tenant that holds both modes' money at once: it captures the BOTH tenant's school
  fee list and `/api/stats` fee payload, creates a college head + structure row + charge for that same
  tenant **over HTTP**, re-reads the school side and compares **byte for byte** (identical), then checks
  the college half gained exactly the new charge's money and nothing of the school's, that the shared
  ledger keeps the two apart by its ONE tag (`feeId: null` + `meta.collegeFeeId` vs a school `feeId`),
  that the mode cookie is UI context and not a filter, and cross-tenant 404s in both directions.
  `SMOKE_PORT=3000 node scripts/verify-mode-mixing.mjs` (**33 checks**).
- `scripts/verify-fees-totals.mjs` — unchanged in its school contract: the **15 school checks** are the
  same 15 and still pass; **+9 college checks** add the other half of the same money rule on the BOTH
  tenant (finite money, the fixture's own charge, totals that are exactly their own rows, and neither
  half's money in the other's read). **24 PASS / 0 FAIL.** The college half **skips loudly** when the
  fixture is absent (a hosted `SMOKE_ORIGIN=` run) instead of reporting an unrun check as green.
- `scripts/isolation-fixture.mjs` gains the **money both halves need** on the BOTH tenant (a school fee
  spine of 12,000 + 5,000 with one payment and one ledger entry, a college spine of a head, a structure
  row, a `cfc_…` config, one 45,000 charge and one TAGGED ledger entry) plus the three refused-role
  users (`TEACHER`, `GUARDIAN`, `STUDENT`) the D-7-18 probe needs **inside a college-capable tenant**.
  `verify-mode-mixing` joins `suite-all.mjs` **after** `verify-branch-isolation`.

D-7-18 (the role probe on a production build, Phase 7f) adds one more **guarded, HTTP** verifier:

- `scripts/verify-role-probe.mjs` — **guarded** (`requireEmulator()`), needs the app, the fixture, and a
  target: `PROBE_ORIGIN=http://127.0.0.1:3111 node scripts/verify-role-probe.mjs` (**24 checks**). It
  probes the surface a person touches — the college fee **screen** and both **print pages** — over HTTP:
  authentication (no session ⇒ no data, 401/403), authorized college access (admin + ACCOUNTANT +
  read-only REGISTRAR, with the admin's own ৳45,000 charge and `CRCP-` receipt really on the paper), the
  SCHOOL-tenant refusal (403 with zero data; the print pages say "college tenants only"), the
  TEACHER/GUARDIAN/STUDENT refusal **inside a college-capable tenant** while their own school fee read
  still works, and tenant isolation (a foreign id is the SAME 404 as a ghost id, no foreign money in the
  HTML). It also reports **which build answered**: it reads `.next/BUILD_ID` and requires the served page
  to embed it, so a run against a dev server fails exactly that one check by design (see
  `proof/7f/role-probe-against-a-dev-server.txt`). Run it against a production build:
  `npm run build` → `NODE_ENV=production npx next start -p 3111` → the command above.
- **The probe is MANUAL (registered in no suite — `suite-all.mjs` / `smoke-all.mjs` do not, and cannot, run it without a production build) and ORDERING-SENSITIVE: it must run on a freshly created fixture and BEFORE `verify-college-fees-api`.** Its one precondition, found by re-running it (2026-10-13, `proof/7f/REPORT.md` §D-bis): the probe
  asserts the fixture's college spine (its ৳45,000 charge and `CRCP-900001` entry), and
  `verify-college-fees-api` **resets that spine on purpose** (`resetCollegeFees(\`${P}both\`)`). So the
  probe runs **on a freshly created fixture and BEFORE that verifier**; run after it without a re-create,
  it correctly reports an empty college half and fails 4 of 24. Nothing was changed to make it pass.

**One additive 7c payload, named here so nobody hunts for it.** `GET /api/college-fees/structure` now also
returns `programmes` (id, name, term shape) — the picker the 7d screens need. The college fee pages may not use
the school catalogue's `GET /api/programs`: the **ACCOUNTANT**, a D-7-18 writer who owns the college's money,
holds no `programs` permission there, so the ONE college read that owns the programme dimension serves what its
screens pick from. Nothing else about that route changed, and `scripts/verify-college-fees-api.mjs`'s assertions
about it (row counts, rows total, bill total, heads) are unchanged.

Also in 7c: `isolation-fixture.mjs` gains a college `ACCOUNTANT` (the one staff role D-7-18 admits as a writer and
the role that may propose but never approve) and a **school-scoped** sweep of the five college fee collections, so
a fee spine built over HTTP (server-generated `cf_…`/`r_…`/`cfc_…` ids) is cleaned as well as the
`zziso-`-prefixed rows.

Already guarded: `smoke-all.mjs` and the full `verify-*.mjs` suite.

**A verifier's count can have more than one valid value when it is calendar-gated — record both.**
`scripts/verify-routine-config.mjs` is the one that is, and it is the reason two runs can both be
"identical" while printing different numbers. Its section 7 (the roster-follows-a-section-override
checks) reads the demo teacher's periods for **today**; when the teacher has no period that day the
section emits **one `skip` instead of its three checks** (the `!slot` branch). So:

| Day | Printed | Meaning |
|---|---|---|
| section 7 cannot run | **30 pass / 2 fail / 1 skip** ("2 failure(s), 1 skipped") | the two class-wide-read failures, plus the section's skip |
| section 7 runs | **32 pass / 3 fail** | the same two failures plus the three checks section 7 adds (2 pass, 1 fail) |

The failures are the **same class-wide-read defect** in both forms — the seed writes only
section-scoped routines while the route's class-wide read returns the `sectionId == null` rows
(§3's known reds) — so a run that prints the other form is a calendar difference, not a regression.
Never record this verifier as a single number.

## 5. Never agent-runnable — production-targeted scripts

These are **not** guarded with `requireEmulator()` because their deliberate purpose is to touch
real credentials or a real project. They terminate immediately (or refuse to start), before
reading credentials, building a Firestore/HTTP client, or opening a network connection. The
post-merge pair from `origin/main` uses the `ALLOW_LIVE_FIRESTORE=1` opt-in instead of an
unconditional exit, because `PROGRESS.md` records them as permanent cutover tools an operator
must be able to re-run:

| Script | Behaviour |
|---|---|
| `scripts/wire-env.mjs` | Reads the **production** `service-account.json` and writes its credentials into `.env`. Prints `[SAFETY] This script targets the production environment and must never be run by an agent.` and `process.exit(1)`. |
| `scripts/verify-deployed-rules.mjs` | Hard-codes the real project (`amar-e-school`) and deploys/reads its security rules. Exits immediately. |
| `scripts/migrate-firestore.mjs`, `scripts/verify-firestore-parity.mjs` | Production Firestore cutover / parity tools, merged in from `origin/main` by integration 1. Both target the LIVE project (`amar-e-school`: `(default)` africa-south1 ↔ `smart-school-db` asia-southeast1) and read `service-account.json`. They **fail closed**: they refuse to start (exit 1, `[SAFETY]` banner) unless the operator sets `ALLOW_LIVE_FIRESTORE=1` deliberately — the same opt-in `src/lib/firebase.ts` uses to reach live Firestore. |

Production migration, cutover and parity scripts are **never agent-runnable** — regardless of
environment.

## 6. Why

- The app's database is chosen in `src/lib/firebase.ts` (`getDb()`): `FIRESTORE_DATABASE_ID` set
  ⇒ a named Cloud database; unset ⇒ `(default)`. `FIRESTORE_EMULATOR_HOST` overrides both and
  routes everything to the local emulator.
- Production sets `FIRESTORE_DATABASE_ID=smart-school-db`. Copying that value (or a
  `SMOKE_ORIGIN`/`BASE_URL` pointing at the App Hosting URL) into a local shell is the one
  realistic way a "test" run corrupts live data. The guard exists to make that impossible.
