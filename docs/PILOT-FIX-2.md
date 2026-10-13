# pilot-fix-2 — a school fee payment can no longer be recorded twice

Branch `integration/main-into-college`, commit `9d8fb22`, parent `fbf0c70`. Emulator only.
`proof/p2/` was untracked while this stage ran and deliberately not committed then; **CORRECTED 2026-10-14: it is tracked now** (the Phase 7 evidence-record commit), so the evidence is durable too — the rule for the directory is [../proof/README.md](../proof/README.md).

## 1. The change, and what proves it

`confirmPayment` (`src/lib/ledger.ts`) used to read the fee, compute the new `paidAmount` in JS and
write the **absolute** value back, so two simultaneous ৳500 payments against a ৳1000 fee both read 0,
both wrote 500: two payment rows, two receipts, a ledger of ৳1000 and a fee that still read
৳500/PARTIAL. A sequential retry simply appended a second payment.

P2 reuses the college 7e-pre pattern on the school path:

- an **optional** `idempotencyKey` (body field `idempotencyKey` or header `x-idempotency-key`;
  present-but-unusable is a **400 by name**, never silently ignored);
- deterministic payment + ledger ids from `(schoolId, feeId, key)` via `schoolPaymentIds()` (`db.ts`);
- a pre-read **replay** that answers a repeat from the ledger entry it wrote (`replay: true`, nothing
  written);
- the fee's new amount decided **inside** `$guardedUpdate("fee", …)` — incremented from the current
  row — and a **keyed over-payment refused**, not clamped;
- the **keyless** callers (webhook, cash intent, admissions intake, enrol) keep the historical clamp
  and their response shape; only the fee write becomes atomic, which is the lost-update fix itself;
- the route skips its courtesy due pre-check for a keyed attempt, so a retry after the fee settled
  still reaches the record it must answer from; the Collect dialog mints **one key per attempt** and
  disables its button in flight.

Files (`git diff --stat HEAD~1 HEAD`, six): `src/lib/ledger.ts`, `src/lib/db.ts`,
`src/app/api/fees/[id]/pay/route.ts`, `src/app/dashboard/fees/page.tsx`,
`docs/PAYMENTS-DESIGN.md` (new), `scripts/verify-school-fee-idempotency.mjs` (new).

Evidence:

| proof | result |
|---|---|
| `scripts/verify-school-fee-idempotency.mjs` | **69/69** — 32 offline pins + 37 live concurrency checks |
| Browser proof (one Chrome over CDP) | **13/13** — a double-click on Record produced exactly one ৳500 payment on a ৳1000 fee; mid-flight `disabled=true` / `Recording…`; a submit on a server-settled fee refused by the server, verbatim `This fee is already fully paid.` |
| Mutation proof | each of five reversals flips a pin; each restore is byte-identical |
| Export safety | every other export of `ledger.ts` byte-identical between `fbf0c70` and `9d8fb22`; `confirmPayment` differs, as it must |

Full detail (scenario table, DOM transcripts, PNGs, mutation table) lives in the now-tracked
`proof/p2/REPORT.md` and `proof/p2/BROWSER-PROOF.md`.

## 2. The full suite — every script, one run (2026-10-13)

Method: wipe the emulator → `seed.mjs` → `isolation-fixture.mjs create` → app started after the wipe →
all scripts in the documented order, `verify-college-fees-api` **last**, `verify-school-fee-idempotency`
inserted after `verify-fees-totals`. Each script has its own log (the run's temp `suite-logs/`) plus the
wrapper summary (53 entries; 51 `verify-*` + 2 `qa-*`).

Counts below are what the **script itself printed**: `PASS`/`[PASS]` check lines plus the script's own
summary line where it prints one. The wrapper's `ok=` counter is only reliable for a few output shapes,
so it is not used as the count. `P1` is the count in [PILOT-FIX-1.md](PILOT-FIX-1.md)'s table. The
systematic −1 against P1 is the P1 runner counting each script's summary line as a check; only the five
marked **corrected** are changed here (they are the five the corrected baselines call out; the same
convention artifact is recorded but not re-numbered for the others in this pass).

| # | script | wrapper exit | printed | vs P1 | verdict |
|---|---|---|---|---|---|
| 1 | `verify-college-gate` | 0 | 4 (runner-count; 3 numbered rule sections printed) | 4 | identical |
| 2 | `verify-college-fees-logic` | 0 | 21 checks (own message) | 22 | identical (summary-line artifact) |
| 3 | `verify-college-fees-data` | 0 | 11 checks (own message) | 12 | identical (summary-line artifact) |
| 4 | `verify-college-results-data` | 0 | 8 checks (own message) | 9 | identical (summary-line artifact) |
| 5 | `verify-college-results-page` | 0 | 106 checks (own summary) | 107 | identical (summary-line artifact) |
| 6 | `verify-college-fees-page` | 0 | **255 checks** | 256 | **CORRECTED — 255** |
| 7 | `verify-college-promotion-logic` | 0 | 12 checks (own message) | 13 | identical (summary-line artifact) |
| 8 | `verify-college-promotion-page` | 0 | 18 checks (own message) | 19 | identical (summary-line artifact) |
| 9 | `verify-college-grading-logic` | 0 | 13 checks (own message) | 14 | identical (summary-line artifact) |
| 10 | `verify-college-routes` | 0 | **3 rule sections** | 4 | **CORRECTED — 3** |
| 11 | `verify-college-terms` | 0 | 9 (runner-count) | 9 | identical |
| 12 | `verify-onboarding-seed` | 0 | 87/87 (own message) | 87 | identical |
| 13 | `verify-database-id` | 0 | 8 checks (own message) | 9 | identical (summary-line artifact) |
| 14 | `verify-nav-scope` | 0 | 9 (runner-count) | 10 | identical (summary-line artifact) |
| 15 | `verify-registration-status` | 0 | 10 (runner-count) | 10 | identical |
| 16 | `verify-college-permissions` | 0 | 8 (runner-count) | 8 | identical |
| 17 | `verify-pilot-hardening` (live) | 0 | **260/260** | 99 (P1's first live form) | **GROWN — 183 offline / 260 live** |
| 18 | `verify-mode-foundation` | 0 | 65 (runner-count; own marker `PASSED`) | 65 | identical |
| 19 | `verify-user-secrets` | 0 | 10 PASS | 10 | identical |
| 20 | `verify-onboarding-monitor` | 0 | 44 PASS | 45 | identical (summary-line artifact) |
| 21 | `verify-tenant-isolation` | 0 | 107 (runner-count) | 107 | identical |
| 22 | `verify-branch-isolation` | 0 | 73 (runner-count; 72 PASS lines + summary) | 73 | identical |
| 23 | `verify-college-enrollment` | 0 | 41 (runner-count; 40 PASS + summary) | 41 | identical |
| 24 | `verify-course-registrations` | 0 | 51 (runner-count; 50 PASS + summary) | 51 | identical |
| 25 | `verify-enroll-paths` | 0 | **17 PASS** | 18 | **CORRECTED — 17** |
| 26 | `verify-enrollment-fees` | 0 | **19 PASS** | 20 | **CORRECTED — 19** |
| 27 | `verify-fees-totals` | 0 | 15 PASS + `ALL GREEN` | 15 | identical |
| 28 | `verify-school-fee-idempotency` | 0 | **69/69** (32 offline + 37 live) | — | **NEW** |
| 29 | `verify-qr-credentials` | 0 | 18 PASS + summary (19 markers) | 19 | identical |
| 30 | `verify-notifications` | 0 | 46 PASS + `ALL GREEN` | 46 | identical |
| 31 | `verify-grading` | 0 | 39 PASS | 39 | identical |
| 32 | `verify-guardian-child` | 0 | 25 PASS + summary (26 declared checks) | 26 | identical |
| 33 | `verify-read-cache` | **1** | `FAIL — 17 route(s) still pay full latency` | 0/1 | **known red, unchanged** |
| 34 | `verify-routine-config` | **1** | `2 failure(s), 1 skipped` = 30/2/1skip | both forms | **known red, unchanged (calendar-gated — see §2.2)** |
| 35 | `verify-cache-scoping` | 0 | 15 PASS + summary | 16 | identical (summary-line artifact) |
| 36 | `verify-invalidation` | 0 | 8 PASS + summary | 9 | identical (summary-line artifact) |
| 37 | `verify-exams-invalidation` | **1** (harness) | wrapper crashed: `ECONNREFUSED ::1:58497` (no `BASE` in the wrapper) | 9 | **explained — re-run alone with `BASE` → exit 0** |
| 38 | `verify-write-freshness` | 0 | 4 PASS | 4 | identical |
| 39 | `verify-write-integrity` | 0 | 30 PASS + 3 skipped | 33 (+2 skip) | identical behaviour (own skip shape) |
| 40 | `verify-academic-sessions` | 0 | 13 PASS + summary | 14 | identical (summary-line artifact) |
| 41 | `verify-class-sessions` | 0 | 56 PASS + `ALL GREEN` | 57 | identical (summary-line artifact) |
| 42 | `verify-bulk-import` | 0 | 117 PASS + summary | 118 | identical (summary-line artifact) |
| 43 | `verify-admission-intake` | **1** (harness) | wrapper crashed in the script (`TypeError` at line 224) — needs the kit stocked and to run alone | 53 | **CORRECTED — 52; explained — re-run alone, kit stocked → 52, exit 0** |
| 44 | `verify-onboarding-type` | 0 | 44/44 (`[PASS]` markers) | 44 | identical |
| 45 | `verify-promotion-rollover` | 0 | 50 PASS + summary | 51 | identical (summary-line artifact) |
| 46 | `verify-sweep-routes` | **1** (harness) | 43 pass / 3 fail (order-sensitive: earlier verifiers' rows) | 46 | **explained — re-run alone from a clean wipe → 46, exit 0** |
| 47 | `verify-phase7-e2e` | 0 | 160 passed, 0 failed; `RESIDUE: CLEAN` | 160 | identical |
| 48 | `verify-college-results-api` | 0 | 77 checks | 78 | identical (summary-line artifact) |
| 49 | `verify-college-promotion-api` | 0 | 100 PASS + summary | 101 | identical (summary-line artifact) |
| 50 | `verify-college-promotion-lease` | 0 | 113 PASS + summary | 114 | identical (summary-line artifact) |
| 51 | `qa-phase23` | **1** (harness) | wrapper crashed (no `BASE`); defaults to `localhost:64512` | 36/0 | **explained — re-run with `BASE` → 36/0** |
| 52 | `qa-certificates` | **1** (harness) | wrapper crashed (no `BASE`); defaults to the same dead port | 39/1 | **explained — re-run with `BASE` → 40/1** (see §2.1) |
| 53 | `verify-college-fees-api` (**LAST**) | 0 | 112/112 (own `RESULT`) | 112 | identical |

Wrapper total: 640 runner-counted checks, 4 fail, 7 scripts with a non-zero exit. Typecheck and build
in the same pass: `tsc` 0 errors; `next build` 186/186 pages.

### 2.1 The five disagreeing verifiers — corrected, with two clean runs each

These are the five whose counts in [PILOT-FIX-1.md](PILOT-FIX-1.md) were the **runner's** line count
(it counts each script's summary line) rather than what the script prints. Each was re-counted in two
independent clean runs — the P1c clean runs (per-script logs) and the P2 suite run above — and the
script's own output is the number. [TESTING.md](TESTING.md),
[COLLEGE-STATUS.md](COLLEGE-STATUS.md) and [COLLEGE-DECISIONS.md](COLLEGE-DECISIONS.md) already carry
three of these; the P1 table is corrected here so it stops contradicting them.

| verifier | printed (2 clean runs) | was recorded as | why the old number |
|---|---|---|---|
| `verify-college-fees-page` | **255 checks** (`node …` summary line: "PASSED — 255 checks") | 256 | runner counted the `PASSED` summary line |
| `verify-college-routes` | **3** (the three numbered rule sections: classification / the gate / no misplaced access) | 4 | runner counted the final `✅ COLLEGE ROUTE GUARD OK` line |
| `verify-enroll-paths` | **17** `PASS` check lines | 18 | extra line was its `✅ PASS — …` summary |
| `verify-admission-intake` | **52** `PASS` check lines (clean state, kit stocked) | 53 | extra line was its `✅ PASS — …` summary |
| `verify-enrollment-fees` | **19** `PASS` check lines | 20 | extra line was its `✅ ENROLMENT FEES OK` summary |

Two corrections beyond the five, from the same evidence:

- **`qa-certificates`: 39/1 → 40/1.** The credential-gated orphan sweep is still its one failure, but
  P1c added one more content check (the legacy import's QR slip for the guardian), so the script now
  prints **40 passed / 1 failed** (`p1c-qa-cert.log`; the P2 re-run with `BASE` reproduced 40/1). The
  39/1 recorded in COLLEGE-STATUS/COLLEGE-DECISIONS/INTEGRATION-LOG predates that check.
- **`verify-pilot-hardening`: 70/99/75 → 183/260.** The numbers in the P1 table are the verifier's
  first version. P1b grew it to 172 offline / 231 live / 177 production-mode, and P1c added 11 offline
  + 29 live checks (its commit message), giving **183 offline / 260 live** — the live 260/260 is in the
  P2 run; the offline 183/183 was re-run in the same pass.

### 2.2 `verify-routine-config` is recorded in BOTH calendar forms

Never one number. Section 7 reads the demo teacher's periods for **today**; when the teacher has no
period that day it emits one `skip` instead of its three checks.

| day | printed | meaning |
|---|---|---|
| section 7 cannot run (this P2 run) | **30 pass / 2 fail / 1 skip** ("2 failure(s), 1 skipped") | the two class-wide-read failures + the skip |
| section 7 runs | **32 pass / 3 fail** | the same two failures + section 7's three checks (2 pass, 1 fail) |

Both forms fail the same two class-wide-read checks ("the class-wide routine loads", "the removed
lessons are really gone") — the seed writes only section-scoped routines while the route's class-wide
read returns the `sectionId == null` rows — so only the number moves, never the cause.

## 3. Callers of `confirmPayment`

`confirmPayment` is called from six places in the current tree. Only the fee route is keyed.

| caller | key today | what a keyless call does after P2 | UI screen that reaches it | double-record risk |
|---|---|---|---|---|
| `POST /api/fees/[id]/pay` (`src/app/api/fees/[id]/pay/route.ts`) | **keyed** (optional; validated 8–120, body or `x-idempotency-key`) | — | `/dashboard/fees` → **Collect** dialog only | none for a repeat with the same key; a different key is a different payment by design |
| `POST /api/payments` → `CashProvider.createIntent` (`src/lib/payments.ts`) | keyless | historical clamp from the current row | none — no page calls `/api/payments` today (the parent portal's pay UI was removed in P1) | yes: two intents/confirmations can both append |
| `PATCH /api/payments` (accountant reconciliation) | keyless | historical clamp | none in the UI (API/scripts) | yes: the intent-status guard is a pre-read; two simultaneous confirms can both append |
| `handleWebhook` (`src/lib/payments.ts`) | keyless, `refAlreadyProcessed` pre-read only | historical clamp | webhook (no UI) | yes: the pre-read is not atomic; two simultaneous deliveries can both append |
| `POST /api/payments/mock-complete` | keyless, `refAlreadyProcessed` pre-read only | historical clamp | disabled in production and for families (P1); staff/API only | yes: same pre-read race |
| `POST /api/admissions/intake` (`route.ts`) | keyless | historical clamp on that student's own fee row | `/dashboard/admissions/intake` (AdmissionIntakeForm) | yes — the whole admission can duplicate; see §4 |
| `enroll()` / `src/lib/admission.ts` (enquiry-pipeline enroll + pay) | keyless | historical clamp | `/dashboard/admissions` pipeline | sequential re-enrol is guarded by pipeline state; a retry of the pay step after a crash double-appends |

Plainly: **the accountant's manual payment screen is `/dashboard/fees`, and it uses
`/api/fees/[id]/pay` only** — the P2 key covers it. The keyless callers a double-click, a retry or a
race can still double-record are the intent/webhook/reconciliation paths above and the admissions
intake. Their *fee* can no longer lose an update (the guarded increment), and the fee cannot be
over-collected through the keyless clamp — but the ledger/payment rows can still take a second append
from a concurrent or retried keyless request, which is why the webhook/mock-complete paths keep their
`refAlreadyProcessed` pre-read (a mitigation, not a guarantee) and why §4 proposes the intake key.

## 4. Admission intake, double-submitted — read-only analysis (candidate P2b)

`POST /api/admissions/intake` creates, in order: the `admission` row (APPLIED) → the student + guardian
login + family link + fee rows through `enrollStudent` → the discount → `confirmPayment` (keyless) on
the admission-fee row → kit → the admission's SEAT_CONFIRMED → ENROLLED transitions → notifications.
Its one duplicate guard reads, **before any write**, ON_ROLL students of the same school with the same
`guardianPhone` and the same lowercased/trimmed name, and refuses a match with a 400 naming the
student. That guard is a pre-read: two simultaneous submits both see nothing and both proceed.

What a double submit does today:

| case | admission | student | guardian login | fee rows | payment | kit |
|---|---|---|---|---|---|---|
| sequential, same phone **and** same name | refused: 400 "… is already enrolled for this guardian phone …" | — | — | — | — | — |
| sequential, no `guardianPhone` on the form (or a name/phone that does not match) | **a second admission** | **a second student** | reused by email (dedupe in `enrollStudent`), not duplicated | a second Admission Fee + Monthly (+ template lines) | **a second receipt, payment row and ledger entry** when `collect` is on | issued again (stock permitting) |
| concurrent (double-click), same phone and name | **two admissions** (both pass the pre-read) | **two students** | reused by email | two sets of fee rows | **two payments**, each against its own fee row | twice |
| retry after a crash mid-request | the route's `done` trail exists; no keyed pre-read, so a retry runs the whole flow again — a second admission unless the guard catches it |

So: a **sequential** double submit is caught only when `guardianPhone` is present and the name matches;
a **concurrent** double submit is not caught at all, and the family can be enrolled twice with the
admission fee collected twice. The P2 payment key does not help, because each submit's `confirmPayment`
targets a different fee row.

A keyed intake (candidate stage **P2b**) would need, at minimum:

1. `src/app/api/admissions/intake/route.ts` — accept/validate the key (same 8–120 rule, body or
   `x-idempotency-key`), pass it as `confirmPayment`'s `idempotencyKey`, and use it for a
   request-level pre-read/replay;
2. `src/lib/db.ts` — a deterministic id helper for the admission/student/fee rows from
   `(schoolId, intake key)` (the 7e-pre `schoolPaymentIds` shape; the existing payment helper covers
   only the payment row);
3. `src/app/api/admissions/intake/route.ts` (its `prisma.admission.create` call) and
   `src/lib/enroll.ts` (`enrollStudent`, which allocates the student + fee ids) — accept deterministic
   ids or a create-once stamp so a retry lands on the same documents;
4. `src/components/AdmissionIntakeForm.tsx` — mint ONE key per attempt and disable the submit in
   flight, reusing it on retry (the `/dashboard/fees` Collect dialog is the model);
5. `scripts/verify-admission-intake.mjs` — a double-submit/concurrency check plus offline pins on the
   route source;
6. no change to `src/lib/ledger.ts` for the payment itself (the key already exists).

## 5. The keyed over-payment response

Exact behaviour of `POST /api/fees/[id]/pay` today, and what changed from `fbf0c70`:

| case | status / body today | vs `fbf0c70` |
|---|---|---|
| (a) fee not found (or another school's fee) | **404** `{"error":"Fee not found"}` | unchanged |
| (b) keyed over-payment refused inside the guarded transaction | **404** `{"error":"That is more than the <due> still due on this fee."}` (the due is the amount still outstanding at the instant of the guarded read; e.g. `…more than the 500 still due…`) | **new refusal**: the old code clamped (`Math.min`) and recorded the larger payment row + ledger entry; keyed attempts now refuse rather than clamp |
| (b') keyed replay after the fee settled | **200** with the original receipt and `replay: true` | **new**: the old route's courtesy pre-check refused it (400 "already fully paid") before any record could answer |
| (c) keyless over-payment | route pre-check: **400** `{"error":"That is more than the <due> still due on this fee."}`; if it slips past the pre-check (concurrency), `confirmPayment` **clamps** to the billed amount and returns **200** — the payment row and ledger still record the full `amount` | same shape as `fbf0c70` (was: pre-check 400, clamp on the race); the clamp is now computed from the current row so it cannot lose an update |
| (c') keyless caller not through the route (webhook, cash intent, intake, enrol) | no refusal — clamped, 200 | same as `fbf0c70` |

**Proposal (not applied):** the route's single `catch` maps every thrown error to **404**, which makes a
keyed over-payment indistinguishable from a missing fee. A cleaner contract is **409 Conflict** for the
in-transaction refusals ("That is more than…", "This fee is already fully paid.", the key conflict),
keeping 404 only for "Fee not found" and 400 for the request-shape errors the route already raises.
Mechanically: give the ledger's refusals a typed marker (a `code` on the thrown error or a small
exported error class) and branch on it in the route's `catch`. This is a **contract change** (the body
text stays verbatim) and was deliberately left to the owner.

## 6. The crash window, and a reconciliation report (proposal only)

Keyed sequence inside `confirmPayment`:

1. guarded fee write commits (paidAmount incremented; the `idempotency` stamp carries the key,
   amount, method, receipt number; the key is appended to the bounded `idempotencyKeys` list);
2. payment row create-once under its deterministic id;
3. ledger PAYMENT entry create-once under its deterministic id;
4. guardian notification (not money).

What a death between the steps leaves, and whether a retry with the same key heals it:

| dies after | state left | retry, same key |
|---|---|---|
| 1 (fee write) | fee stamped paid; **no payment row and no ledger entry** — collected money exists only as the fee's `paidAmount` | **heals**: the guarded read sees the key already taken, the failure branch matches it, `appendKeyedPaymentRows` writes both rows create-once and answers the original receipt (`replay: true`) |
| 2 (payment row, before ledger) | payment row exists, ledger entry missing — the two disagree | **heals**: the row create refuses ("already recorded"), the ledger entry is created; answered from the original receipt |
| 3 (before notify) | money complete; only the notification is missing | **no-op heal** — the replay answers from the record, nothing is written |
| never retried | the same window as before P2, only narrower: a **keyed** fee can be stamped with no rows/ledger entry | — |

Keyless sequence: fee write → `payment.create` (random id) → `postToLedger`. A crash after step 1 or 2
leaves an unkeyed request that **cannot be healed by a retry** — a retry writes another payment row and
another ledger entry (this is the residual double-record for keyless callers), and a crash between the
row and the ledger entry leaves an orphan row that the retry does not reconcile. `refAlreadyProcessed`
helps only the intent/webhook paths that pass a stable `refNo`, and it is a pre-read.

**Proposed (not built): a read-only fee reconciliation report.** For every fee, compare
`paidAmount` against (a) Σ `payment.amount` where `feeId` and (b) Σ `ledgerEntry.amount` where
`feeId`, `kind = PAYMENT`, `status = CONFIRMED`, and report three drift classes:

1. **fee > sums** — a stamped fee with missing appends (a crash after step 1, or a lost append);
2. **Σ payment ≠ Σ ledger** — the two appends disagree (a crash between steps 2 and 3, or an orphan);
3. **sums > fee** — the keyless clamp swallowed an over-collection the ledger still recorded (the
   pre-existing hole in (c)).

Where it could live: a guarded, read-only `scripts/report-fee-reconciliation.mjs` (the
`scripts/fix-fee-paidamount.mjs` pattern: `requireEmulator()`, `--school`, `--json`, report-only), and
only later, if the owner wants it in the product, an admin-only `GET /api/fees/reconciliation` route
(SCHOOL_ADMIN/ACCOUNTANT, tenant-scoped, `no-store`). What it needs: `money()` normalization for every
row, the fee's keyed stamps (`idempotency`, `idempotencyKeys`, `meta.paymentKey`) to attribute each
drift, chunked reads for large schools, and no writes in the report. A repair mode (write `paidAmount`
back to the sums for class 1) is a **separate decision**, never part of the report.

## 7. Safety proofs

- Every export of `ledger.ts` except `confirmPayment` is byte-identical between the parent `fbf0c70`
  and the fix `9d8fb22` (sha256 of each body): `postToLedger`, `ledgerForStudent`, `ledgerForSchool`,
  `refAlreadyProcessed`, `collegeReceiptNo`, `confirmCollegePayment`, `paymentKeyFrom`, `applyLateFees`,
  `LedgerInput`. `confirmPayment` differs, as it must.
- `git diff --stat HEAD~1 HEAD` is exactly the six files above; the worktree diff is empty.
- `confirmCollegePayment`, the guardian/payment-intent flow and admissions-intake behaviour are
  untouched (the intake is keyless and takes the unchanged keyless path — §4).
- `src/lib/db.ts`'s worktree bytes differ from the HEAD blob only by line endings (CRLF vs LF);
  `git diff` reports no change.

## 8. What could not be verified

- The suite wrapper does not export `BASE`/`BASE_URL`, so `qa-phase23`, `qa-certificates` and
  `verify-exams-invalidation` cannot pass inside it; each reproduced its documented form when re-run
  alone with `BASE`. `verify-admission-intake` needs the kit stocked and to run alone;
  `verify-sweep-routes` is order-sensitive. A future stage could teach the wrapper to pass
  `BASE=BASE_URL=http://127.0.0.1:${SMOKE_PORT}` and stock the kit before intake.
- `qa-certificates`' one failure is the credential-gated orphan sweep, forbidden under the
  emulator-only rule.
- No production deploy probe of the fee screens was run (emulator only).
- The crash window in §6 is reasoned from the code and the keyed replay paths; no process was killed
  mid-write to observe it.
