# Pilot P2c — the fee reconciliation report, the suite runner, and the guardian-child review

Branch `integration/main-into-college`, parent `72ef9a3` (the P2 close-out). This report is the
untracked record of the stage; the tracked artifacts are:

| path | what |
|---|---|
| `src/app/api/fees/reconciliation/route.ts` | **new** — `GET /api/fees/reconciliation`, read-only, admin-only, school-scoped |
| `scripts/verify-fee-reconciliation.mjs` | **new** — the guarded verifier (56 checks; 65 with `--mutations`) |
| `scripts/suite-all.mjs` | **new** — the suite runner, now in the repository |
| `scripts/verify-college-fees-data.mjs` | +8 lines — the ledger-reader audit records the new reader (mandated by that check) |
| `docs/TESTING.md` | +36 lines — the route, the verifier, the runner |

Untouched, by instruction: `confirmPayment`, `confirmCollegePayment`, `ledger.ts`, `db.ts`, every
other money path, `apphosting.yaml`, `main` / `origin/main` / `college-support`.

---

## A. `verify-guardian-child.mjs` — the review (read-only)

`git diff 824e80d..HEAD -- scripts/verify-guardian-child.mjs` is **27 insertions, 6 deletions in two
hunks**. Nothing was deleted from the file's check set; one predicate was repaired and one check was
replaced by the P1a product change.

**Hunk 1 (lines 139-149): the "stranger" predicate was repaired, not loosened.**

```diff
-const foreignChild = allStudents.find(
-  (s) => s.guardianUserId !== guardianUser.id && s.familyId !== defaultChild.familyId && s.id !== defaultChild.id
-);
+const sameFamily = (a, b) =>
+  (a.familyId && b.familyId && a.familyId === b.familyId) ||
+  (a.guardianUserId && a.guardianUserId === b.guardianUserId);
+const foreignChild = allStudents.find((s) => s.id !== defaultChild.id && !sameFamily(s, defaultChild));
```

The old predicate required `s.familyId !== defaultChild.familyId`, and the seed sets **no** `familyId`
on anyone — so on a clean database `undefined !== undefined` is false and **no** student could ever be
the stranger: the script exited 1 before running a single check. The new predicate still requires a
student who is not this child and not this family (a different `familyId` **or** a different
`guardianUserId`), so the "stranger" is still a stranger.

**Hunk 2 (lines 365-388): one check replaced, exactly as P1a intended.** The old check asserted a
guardian *could* start a payment on a family-linked sibling's fee (`201` + `studentId`). P1a closed
`POST /api/payments` to families ("Online payment is not available. Please pay at the school office."),
so the check now asserts that refusal (`403`) plus a new one ("the refused sibling payment created no
payment intent"). This is the documented product change (docs/PILOT-FIX-1.md item 3), not an isolation
change: the sibling link is still proved by the fee list, the student page, the certificate and the
leave request around it.

**Is "a guardian cannot read another student's data" still asserted? YES — every one of the six
isolation checks survives, byte-identical to the pre-P1a file (only line numbers shifted):**

| check (current line) | assertion |
|---|---|
| `scripts/verify-guardian-child.mjs:261` | "guardian /api/fees never returns another family's fee" |
| `:272` | "?studentId=&lt;another family's child&gt; returns nothing" |
| `:296` | "guardian cannot open another family's child page" — **403** |
| `:301` | "certificate for another family's child is refused" — **403** |
| `:305` | "book issues asked for another family's child come back empty" |
| `:329` | "leave request naming another family's child is refused" |
| `:336` | "chat cannot be opened for another family's child" |
| `:401` | "guardian cannot start a payment on another family's fee" — **403** |

**Verdict: no isolation check was removed, replaced or weakened. No STOP condition.** The verifier is
green in the full run below (`exit=0`, "25 PASS").

---

## B. The fee reconciliation report

### Path — and why it cannot collide

`GET /api/fees/reconciliation` at `src/app/api/fees/reconciliation/route.ts`.

The `/api/fees/[id]` family is `[id]/route.ts` (GET/PATCH/DELETE) and `[id]/pay/route.ts` (POST). Its
**static siblings already shadow the dynamic segment**: `fees/settings`, `fees/generate`,
`fees/reminders`. Next.js resolves a static segment before `[id]`, so the only thing `reconciliation`
can ever shadow is a fee whose document id is the literal string `"reconciliation"` — and no id
generator in this app produces one (seeded fees are Firestore auto-ids, app-created ones are `fee_…`;
`paymentKeyFrom`/`schoolPaymentIds` ids are `fee_…`-scoped too).

The alternative — a new top-level directory such as `/api/fee-reconciliation` — would be **rejected by
the existing college-route guard**: `scripts/verify-college-routes.mjs` asserts that every top-level
directory under `src/app/api` is either a listed college segment or in its frozen non-college list.
Staying inside `fees/` keeps that guard green **without editing it**.

### Who may read it (the role matrix, proven live)

| role | result |
|---|---|
| `SCHOOL_ADMIN` | **200** |
| `ACCOUNTANT` (school-wide) | **200** — it holds `feePayment full` in `src/lib/permissions.ts`, read-only here |
| `SUPER_ADMIN` with `?schoolId=` | **200** (its own tenant is `null`, so it must name one; `400` without) |
| `REGISTRAR` | **403** — it has fee *read* but the report is an accounting view |
| `TEACHER`, `STUDENT`, `GUARDIAN` | **403**, and **no fee row** in the body |
| `ACCOUNTANT` confined to a branch | **403** — the report is school-wide; a branch-confined session must not read another branch's money |
| unauthenticated | **401** |

`isBranchScoped()` and `can(role, "feePayment", "view")` are both consulted, so the role set and the
permission matrix can never drift apart.

### What it reports

For every fee of the caller's school it compares the header with the two row families that justify it
(`payment` rows by `feeId`; `ledgerEntry` rows with `kind=PAYMENT, status=CONFIRMED`) and reports one
entry per applicable class:

| class | meaning | fixture in the verifier |
|---|---|---|
| `fee_above_sums` | `paidAmount > Σ payment rows` — a lost append: the header moved, the rows did not | `zzrec-fee-above-…` (paid 50000 / rows 0) |
| `payment_ledger_mismatch` | `Σ payment rows ≠ Σ CONFIRMED ledger rows` | `zzrec-fee-mismatch-…` (30000 vs 0) |
| `sums_above_fee` | a sum exceeds what was billed — an over-collection the **keyless clamp** swallowed | `zzrec-fee-over-…` (150000 rows on a 100000 fee) |

Each entry carries the ids, integer amounts (`feeAmount`, `paidAmount`, `paymentSum`, `ledgerSum`,
`delta`, `rowDelta`, `overFee`), the row counts, up to five CONFIRMED ledger ids and their receipt
numbers, and the fee's **keyed stamp** when P2 left one (`stamp.receiptNo` / `paidAmount` /
`feeStatus` / `at` — the raw idempotency key is a client token and never leaves the API). `counts` and
`clean` are per page; `total` is the native count of the school's fees.

### Read cost, honestly stated (and reported in the payload)

Per call: **1 native count** (Firestore count aggregation, 0 documents) + **F fee documents** (the
school's fee headers — the data layer has no keyset pagination, so enumerating the page's ids costs
that read; it is memoized by `db.ts` for the pull TTL) + **the page's rows only**: payments and
CONFIRMED PAYMENT ledger entries for ≤`limit` fees, batched **≤30 fee ids per query** (Firestore's `in`
limit, which is also this shim's pushdown limit). The ledger is never read whole, and no collection
outside `fee` / `payment` / `ledgerEntry` is touched. `readCost.queries` = `2 + 2 × ⌈scanned/30⌉`.
Paging is a **keyset over fee document ids** (`limit` default 200, max 500; `cursor` = the last id of
the previous page; walk with `nextCursor` until `hasMore` is false).

### The verifier — `scripts/verify-fee-reconciliation.mjs` (56 checks)

Guarded (`requireEmulator()`), run against the emulator with the app up, self-cleaning (every fixture is
`zzrec-…`, deleted in a `finally`, then swept by stamp). It proves: the three drift classes with exact
amounts and classes; a **real keyed payment** through `POST /api/fees/[id]/pay` produces **no** drift;
a clean fee is never reported; the keyset walk is exact (21 pages of 3 cover all 62 fee ids once, the
cursor is always the page's last id, the reported read cost equals the rows that exist for that page);
another tenant's fees never appear while the same read by a super admin for that school does show them;
the role matrix above; the route writes nothing (content hash of `fees`/`payments`/`ledger` **plus** the
total document count of every collection, before/after, after first proving the database quiescent so a
late `after()` audit write cannot be mistaken for ours); and statically that the route has no write call
site, names no college model, and keys every ledger read by a school fee id. A college-tagged ledger
entry (`feeId: null` + `meta.collegeFeeId`) written among the fixtures changes **no** number of the
report.

### Mutation proof (not vacuous) — `--mutations`, 65 checks

| reversal | observed | restored (sha256) |
|---|---|---|
| drop class (i) (`if (false)`) | the reported drift disappears → check fails | `f3e73d2a…` → `f3e73d2a…` ✓, behaviour returns |
| drop the tenant scope (`feeWhere = {}`) | another tenant's fee appears in this school's report | ✓, and it disappears again |
| allow `GUARDIAN` | the guardian's read answers **200** | ✓, back to 403 |
| make it write (`prisma.fee.update`) | the money books' hash changes (`26617d2f…` → `4ec0efd8…`) | ✓, hash stable again; the probe field is removed |

Each reversal is applied to the route file, the matching check is shown to FAIL, the file is restored,
and the sha256 of the restored file equals the original. The route's final sha256 is
`f3e73d2aca420de0342ff4ae2d7964a5b787e2a46067584e474909b59836dec9`.

---

## C. The suite runner

**Where the wrapper lived.** The established full-suite wrapper was **outside the repository**, in the
session's temp directory (`%TEMP%/sspr/fullrun.mjs`, with `suite.mjs` as the small per-name variant).
That is the root cause of the three "harness" failures recorded in docs/PILOT-FIX-2.md §8: it exported
neither `BASE`/`BASE_URL` nor `SMOKE_PORT`, so `verify-exams-invalidation` dialled a dead
`localhost:58497`, and `qa-phase23` / `qa-certificates` dialled a dead `localhost:64512`. §8 already
named the fix this stage implements. Per the instruction (add-only when the wrapper is outside the
repo), the runner is a **new** file, `scripts/suite-all.mjs`; no existing verifier's checks were touched
(the one edit to a verifier is the audit-list registration below, which that check itself demands).

**What it does per verifier:** wipe the emulator (`firebase emulators:start --only firestore --project
demo-ss-test`), `seed.mjs`, `isolation-fixture.mjs create`, and — for `verify-admission-intake` and
`verify-write-integrity` — `seed-kit-demo.mjs`; then **restart the app** and wait until it answers a
real sign-in as `principal@sunrise.edu` (not `/api/health`, which is 503 in emulator mode by design),
then run the verifier **alone** with `SMOKE_PORT` / `VERIFY_PORT` / `BASE` / `BASE_URL` all pointing at
that app and `FIREBASE_CLIENT_EMAIL` / `FIREBASE_PRIVATE_KEY` blanked (an empty variable blocks `.env`
from reinstating a live key — `scripts/dev-emulator.mjs`'s own rule). The per-verifier reset is what
makes the order-sensitive group deterministic (`verify-sweep-routes`, `verify-admission-intake`, and the
bulk-import/onboarding pair, which must run before the onboarding verifiers that create and delete
`ONB-*` students in the demo school). `verify-college-fees-api` stays **LAST** (it resets its own tenant
through `firebase-admin`, which cannot invalidate the app's pull memo). The runner prints each verifier's
exit code and **its own count line**, and exits non-zero on any failure outside the documented reds.

### The one full run (final files, 2026-10-13 11:01 → 11:41)

`node scripts/suite-all.mjs` — **54 verifiers, 654 ✅ / 1 ❌ markers, 51 exit 0**, in 40 minutes.

```
TOTAL: 54 verifier(s), 654 ✅ / 1 ❌ markers, 51 exit 0
known reds (allowed): verify-read-cache, verify-routine-config, qa-certificates
unexpected failures: (none)
```

| # | verifier | exit | the script's own count | vs docs/PILOT-FIX-2.md |
|---|---|---|---|---|
| 1 | verify-college-gate | 0 | 4 ✅ markers | 4 ✓ |
| 2 | verify-college-fees-logic | 0 | 21 check(s) | 21 ✓ |
| 3 | verify-college-fees-data | 0 | 11 check(s) | 11 ✓ |
| 4 | verify-college-results-data | 0 | 8 check(s) | 8 ✓ |
| 5 | verify-college-results-page | 0 | 106 checks | 106 ✓ |
| 6 | verify-college-fees-page | 0 | 255 checks | **255 ✓** |
| 7 | verify-college-promotion-logic | 0 | 12 check(s) | 12 ✓ |
| 8 | verify-college-promotion-page | 0 | 18 check(s) | 18 ✓ |
| 9 | verify-college-grading-logic | 0 | 13 check(s) | 13 ✓ |
| 10 | verify-college-routes | 0 | 3 rule sections (4 ✅ markers) | 3 ✓ |
| 11 | verify-college-terms | 0 | 9 ✅ markers | 9 ✓ |
| 12 | verify-onboarding-seed | 0 | 87/87 checks | 87 ✓ |
| 13 | verify-database-id | 0 | 8 check(s) | 8 ✓ |
| 14 | verify-nav-scope | 0 | 10 ✅ markers | 9 (documented ±1 convention artifact) |
| 15 | verify-registration-status | 0 | 10 ✅ markers | 10 ✓ |
| 16 | verify-college-permissions | 0 | 8 ✅ markers | 8 ✓ |
| 17 | verify-pilot-hardening | 0 | **260/260 checks passed** | **260 ✓** (183 offline / 260 live) |
| 18 | verify-mode-foundation | 0 | 65 ✅ markers | 65 ✓ |
| 19 | verify-user-secrets | 0 | 10 PASS | 10 ✓ |
| 20 | verify-onboarding-monitor | 0 | 44 PASS | 44 ✓ |
| 21 | verify-tenant-isolation | 0 | 107 ✅ markers | 107 ✓ |
| 22 | verify-branch-isolation | 0 | 72 PASS | 73 (72 PASS + summary) ✓ |
| 23 | verify-college-enrollment | 0 | 40 PASS | 41 (40 PASS + summary) ✓ |
| 24 | verify-course-registrations | 0 | 50 PASS | 51 (50 PASS + summary) ✓ |
| 25 | verify-enroll-paths | 0 | 17 PASS | **17** ✓ |
| 26 | verify-enrollment-fees | 0 | 19 PASS | **19** ✓ |
| 27 | verify-fees-totals | 0 | 15 PASS + `ALL GREEN` | 15 ✓ |
| 28 | verify-school-fee-idempotency | 0 | **69/69 checks passed** | **69 ✓** |
| 29 | verify-fee-reconciliation | 0 | **56 checks** (`--mutations`: 65) | new |
| 30 | verify-qr-credentials | 0 | 18 PASS | 18 ✓ |
| 31 | verify-notifications | 0 | 46 PASS | 46 ✓ |
| 32 | verify-grading | 0 | 39 PASS | 39 ✓ |
| 33 | verify-guardian-child | 0 | 25 PASS | 25 PASS + summary ✓ (see §A) |
| 34 | verify-read-cache | **1** | known red | unchanged known red ✓ |
| 35 | verify-routine-config | **1** | `2 failure(s), 1 skipped` | unchanged known red (calendar form) ✓ |
| 36 | verify-cache-scoping | 0 | 15 PASS | 16 (15 + summary) ✓ |
| 37 | verify-invalidation | 0 | 8 PASS | 9 (8 + summary) ✓ |
| 38 | verify-exams-invalidation | 0 | 9 ✅ markers | **was exit 1 in P2 — now 9, exit 0 ✓ (the runner fix)** |
| 39 | verify-write-freshness | 0 | 4 PASS | 4 ✓ |
| 40 | verify-write-integrity | 0 | all checks passed · 2 skipped | 30 PASS + 3 skipped ✓ |
| 41 | verify-academic-sessions | 0 | 13 PASS | 14 (13 + summary) ✓ |
| 42 | verify-class-sessions | 0 | 56 PASS | 57 (56 + summary) ✓ |
| 43 | verify-bulk-import | 0 | 117 PASS | 118 (117 + summary) ✓ |
| 44 | verify-admission-intake | 0 | **52 PASS** (kit stocked) | **52** ✓ |
| 45 | verify-onboarding-type | 0 | 44 passed, 0 failed | 44 ✓ |
| 46 | verify-promotion-rollover | 0 | 50 PASS | 51 (50 + summary) ✓ |
| 47 | qa-phase23 | 0 | **36 passed, 0 failed** | **was exit 1 in P2 — now 36/0, exit 0 ✓ (the runner fix)** |
| 48 | qa-certificates | **1** | **40 passed, 1 failed** | 40/1 known red ✓ (was exit 1 for a missing `BASE`; now the script's own known failure) |
| 49 | verify-phase7-e2e | 0 | 160 passed, 0 failed | 160 ✓ |
| 50 | verify-college-results-api | 0 | 77 checks | 78 (77 + summary) ✓ |
| 51 | verify-college-promotion-api | 0 | 100 PASS + summary | 101 (100 + summary) ✓ |
| 52 | verify-college-promotion-lease | 0 | 113 PASS + summary | 114 (113 + summary) ✓ |
| 53 | verify-sweep-routes | 0 | **46 ✅** | 46 ✓ (clean state each time) |
| 54 | verify-college-fees-api (**LAST**) | 0 | **112/112 checks passed** | **112 ✓** |

Every frozen baseline in the task statement holds: `verify-school-fee-idempotency` 69,
`verify-pilot-hardening` 260, `verify-college-fees-api` 112, `verify-college-fees-page` 255,
`verify-guardian-child` per §A, and the 53-row table's counts (the ±1 rows are the summary-line
convention PILOT-FIX-2 §2.1 already documents, visible here as "N PASS" vs "N + summary").

Two P2 harness failures are now fixed by construction, not by editing a check:
`verify-exams-invalidation` 0/9 (was `ECONNREFUSED ::1:58497`) and `qa-phase23` 36/0 (was a dead
`64512`); `qa-certificates` now reaches its own known red (40/1) instead of crashing.

### The one existing-verifier edit this stage required

`verify-college-fees-data.mjs` step 10 holds the **audited** list of the shared ledger's readers and
fails when a new file reads `prisma.ledgerEntry`. The new route is such a reader, so the check failed
until the reader was reviewed and recorded — which is exactly what that check instructs ("a NEW reader
must be reviewed (does it show college money? is that intended?), and the audit ... updated"). The
review: **no college money can appear** — every ledger query in the route is keyed by a fee id taken
from the school's own fee rows, and a college entry carries `feeId: null` + `meta.collegeFeeId`
(D-7-12). The list gained one entry with that reasoning; the assertion itself is untouched (any
*other* new reader still fails it). The verifier was re-run standalone: 11/11, exit 0.

---

## D. What could not be verified, and the decisions this leaves

- **Production was never touched.** The report is emulator-verified only (the stage's rule). Its reads
  are ordinary Firestore queries, so nothing about it is emulator-specific, but no live tenant was read.
- **`/api/fees/reconciliation` is an API with no screen.** Nothing in the dashboard calls it yet; the
  screens that could (the Fees page, the ledger page) and the branch-scoped question are decisions, not
  facts, and are listed below.
- **The demo seed's own fee rows are drift.** `scripts/seed.mjs` writes `paidAmount` on the fee header
  and **no** `payment` row at all; its ledger mirror (seed.mjs:655-680) then writes a CONFIRMED PAYMENT
  entry for the first **10** fees only — `.limit(10)`, an arbitrary draw — so those fees have
  `paymentSum = 0` against a positive `ledgerSum`/`paidAmount` and are legitimately reported under BOTH
  `fee_above_sums` and `payment_ledger_mismatch`. On a freshly seeded database that is ~28 `fee_above_sums`
  (every seeded PAID header: 56 fees, the even rolls plus every admission fee) and 4-6 mismatches
  depending on which 10 fees the draw returns (run 1: 4, the run above: 6). This is a true finding about
  the demo data, not a route defect — the verifier asserts on its own fixture ids and on
  signature-equality, never on the school-wide counts — but it does mean a pilot's first look will show
  those hits. A decision is needed on whether the seed (or `scripts/fix-fee-paidamount.mjs`) should be
  what makes a fresh demo database reconcile cleanly.
- **The verifier's no-write proof is scoped to one process.** It proves the *route* writes nothing
  across every call it makes; it does not instrument Firestore itself.
- **`verify-nav-scope` prints 10 ✅ markers where PILOT-FIX-2 records 9.** That script prints no summary
  line, so both numbers are counting conventions (P2's is the one its table used for the other
  no-summary scripts); the script's own output is unchanged between the two runs.

### Decisions for the owner
1. **Should the reconciliation report have a screen?** (An admin-only "Money check" page under
   Settings, or a column on the Fees page.) Today it is API-only.
2. **Should a branch-confined ACCOUNTANT read it, scoped to their branch?** I refused it (school-wide
   report → school-wide money); the alternative is a branch filter, which is a product decision.
3. **Should the seeded demo fees carry rows, so a fresh database reconciles clean?** Otherwise the first
   real look at a pilot tenant will show ~28 "lost append" hits that are really seed placeholders.
4. **Should the runner be the documented way in** (replacing the temp `fullrun.mjs` for good, with the
   `SUITE_ONLY`/`SUITE_FROM` resume flags used during long stages)? `docs/TESTING.md` now describes it.
