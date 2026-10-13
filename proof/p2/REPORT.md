# pilot P2 — school fee payment idempotency and lost-update fix

Commit `9d8fb22` on `integration/main-into-college`, parent `fbf0c70`. Pushed; `rev-list --left-right --count HEAD...origin/…` = `0 0`.

The browser proof's own generated transcript — four PNGs and the full DOM text under each — lives in
[BROWSER-PROOF.md](BROWSER-PROOF.md), because the proof script writes that file itself and will
overwrite anything parked at this path.

## Files changed

`git diff --stat HEAD~1 HEAD` — exactly six files:

| file | why |
|---|---|
| `src/lib/ledger.ts` | the guarded fee write: keyed replay, in-transaction due re-check |
| `src/lib/db.ts` | the compare-and-set helper the guarded write needs |
| `src/app/api/fees/[id]/pay/route.ts` | accepts and forwards the idempotency key |
| `src/app/dashboard/fees/page.tsx` | one key per attempt, in-flight disable |
| `docs/PAYMENTS-DESIGN.md` | new: the design note for the change |
| `scripts/verify-school-fee-idempotency.mjs` | new: 69 checks (32 offline pins + 37 live) |

## Step 0 — the P1c probe's one failing check

**Finding: neither pre-existing NOR a regression — it does not reproduce.**

A temporary git worktree of `a4ec49e` was created outside the repo, its `node_modules` junctioned to
the main worktree's (package.json/lock are identical between the two commits), `.env` copied with the
`JWT_SECRET` line stripped, then `npm run build` and `NODE_ENV=production PORT=3101 npx next start`
(no `JWT_SECRET`). The SAME probe command was run in the SAME worktree against both commits, same
host and port:

| commit | probe | "the dev-secret cookie is NOT accepted" |
|---|---|---|
| `a4ec49e` (P1b) | `PILOT_PROD_URL=http://127.0.0.1:3101 … --offline` | **PASS — 177/177** |
| `fbf0c70` (P1c) | same command, same worktree | **PASS — 188/188** |

Raw response from the `fbf0c70` server: `HTTP/1.1 307 Temporary Redirect` + `location: /login?next=%2Fdashboard`
(a RELATIVE Location — what the check requires). Repeating with `PILOT_PROD_URL=http://localhost:3101`
and with a raw `curl` on both host spellings gave the same relative Location and 188/188.

`src/middleware.ts`, `src/lib/sectors.ts` and `src/lib/pilot-guards.ts` are **byte-identical** between
`a4ec49e` and `fbf0c70` (`git diff --stat a4ec49e fbf0c70 --` on those three files is empty), and the
check itself is byte-identical in both verifier revisions. Nothing changed that could turn the
redirect absolute, and the earlier run's absolute `http://localhost:3101/login?next=…` is not
produced by this environment in either revision. The check was left unedited.

## The problem, re-measured after the fix (live, emulator)

`scripts/verify-school-fee-idempotency.mjs` — **69/69** (32 offline pins + 37 live). Every scenario on
a fresh ৳1000 fee:

| # | scenario | fee | payment rows | ledger PAYMENT | verdict |
|---|---|---|---|---|---|
| a | two DIFFERENT keys, simultaneous ৳500+৳500 | ৳1000/PAID | 2, distinct receipts | ৳1000 (2) | **PASS** |
| b | ONE key, simultaneous | ৳500/PARTIAL | **1** | ৳500 (1) | **PASS** — same receipt both times, replay flagged |
| c | ONE key, sequential retry | ৳500/PARTIAL | **1** | ৳500 (1) | **PASS** — original receipt, `replay: true` |
| c2 | ONE key, retry after the fee settled | ৳1000/PAID | 1 | ৳1000 | **PASS** — 200, not "already fully paid" |
| d | two different keys, simultaneous ৳600+৳600 vs ৳1000 | ৳600/PARTIAL | **1** | ৳600 (1) | **PASS** — one succeeds, the loser refused by name |
| e | full ৳1000, ONE key, simultaneous | ৳1000/PAID | **1** | ৳1000 (1) | **PASS** |
| f | keyless single ৳500 | ৳500/PARTIAL | 1 | ৳500 | **PASS** — no replay flag, shape unchanged |
| f2 | keyless simultaneous ৳500+৳500 | **৳1000/PAID** | 2 | ৳1000 | **PASS** — the lost update is gone |

Keyless before/after, plainly: **before** two simultaneous keyless ৳500s left the fee at
**৳500/PARTIAL** (the lost update) with 2 payment rows and a ৳1000 ledger — the fee disagreed with
its own ledger. **After**, the fee reads **৳1000/PAID** and the ledger still records ৳1000 across the
same 2 rows. The row count and the ledger are unchanged; only the fee, which was WRONG, is now right.
Keyless callers (webhook `handleWebhook`, `CashProvider`, `admitStudent`, admissions intake) still get
the historical clamp and the same 3-key response shape — no `replay` field is added for them.

## Browser proof — [BROWSER-PROOF.md](BROWSER-PROOF.md), PNGs in this directory

**13/13 checks (`BROWSER PROOF COMPLETE`, exit 0).** A double-click on **Record** produced exactly ONE
৳500 payment on a ৳1000 fee (checks 8 and 9: `1 rows`, `paid 500`); mid-flight the button was
`disabled=true` and read `Recording…` (checks 6 and 7); the row then read
`৳1,000   ৳500   ৳500   Partial   RCP-3658461084` (check 10); and a submit against a fee settled
server-side was refused BY THE SERVER and shown verbatim as **`This fee is already fully paid.`**
(checks 11 and 12), recording no extra payment (check 13).

The run was reproduced from scratch on 13 Oct on a fresh emulator (`demo-ss-test`; wipe → `seed.mjs`,
14 students / 56 fee records → `dev-emulator.mjs` on :3000) to regenerate the transcript after an
earlier draft of this file was overwritten by the proof script: the same 13/13 and the same four
assertions held, and [BROWSER-PROOF.md](BROWSER-PROOF.md) carries the four PNGs' DOM text.

## Mutation proofs — each reversal flips a pin, each restore byte-identical

| # | mutation | FAILED pins | |
|---|---|---|---|
| i | drop the pre-read replay | `off-13` | ✅ |
| ii | restore the blind absolute write | `off-9`, `off-32` | ✅ |
| iii | drop the in-transaction re-check of the remaining due | `off-10`, `off-11` | ✅ |
| iv | remove the in-flight disable | `off-27` | ✅ |
| v | make the key non-deterministic | `off-3` | ✅ |

Restoring each mutation left the worktree `sha256` of `ledger.ts` / `db.ts` / `fees/page.tsx` exactly as
before: `ca166726ea63370c` / `d3461445170e7197` / `2fc9cf10624af3b2` (re-confirmed unchanged this turn).
Mutation (ii) initially did NOT flip —
the pin was matching the KEYLESS clamp — so `off-9` was tightened to the exact keyed statement and
`off-32` added.

## Safety proofs

- Every other export of `ledger.ts` is **byte-identical between the parent commit `fbf0c70` and the fix
  commit `9d8fb22`** by sha256 of its body:

  | export | sha16 (parent and fix) |
  |---|---|
  | `postToLedger` | `605f9d2803f2081b` |
  | `ledgerForStudent` | `afc5891d3870cd3c` |
  | `ledgerForSchool` | `2cad06e040988245` |
  | `refAlreadyProcessed` | `b850cfd53a133de8` |
  | `collegeReceiptNo` | `eb582f8ff6e72711` |
  | `confirmCollegePayment` | `f7da6442d9983f85` |
  | `paymentKeyFrom` | `408b9fa762c3b726` |
  | `applyLateFees` | `26de945f71a56d29` |
  | `LedgerInput` | `8096f44e41b475f5` |

  `confirmPayment` itself goes `0b472d04fb2450b0` → `3227d1e7f80b5fbc` — it differs, as it must. The
  comparison is deliberately parent-against-fix: a HEAD-against-worktree run is vacuous once the fix
  *is* HEAD.
- `git diff --stat HEAD~1 HEAD` = the six files above and nothing else; `git diff --stat` against the
  worktree is empty; `proof/` and the two pre-existing untracked docs stay unstaged.
- `src/lib/db.ts`'s worktree bytes differ from the HEAD blob only by line endings (2547 CRLF pairs in
  the worktree, LF in the blob; equal after normalization) — `git diff` reports no change, so this is
  cosmetic, not a hidden edit.
- `confirmCollegePayment`, the guardian/payment-intent flow and admissions-intake BEHAVIOUR are
  untouched. Admissions intake calls `confirmPayment` keylessly: with no key it takes the keyless
  clamp path unchanged (reported, not edited).

## The full suite — one run, 52 verifiers, clean state

Wipe → `seed.mjs` → `isolation-fixture.mjs create` → app restart, then all 52 in the documented order
with `verify-college-fees-api` LAST. `verify-school-fee-idempotency` was inserted after
`verify-fees-totals`.

**Baselines that must stay identical — all confirmed:**

| verifier | expected | observed |
|---|---|---|
| `verify-pilot-hardening` offline / live | 183 / 260 | **183/183** / **260** ✅ |
| `verify-guardian-child` | 26 | 26 ✅ |
| `verify-qr-credentials` | 19 | 19 ✅ |
| `verify-college-fees-api` (LAST) | 112 | **112/112** ✅ |
| `verify-college-fees-page` | 255 | **255 checks** ✅ |
| `verify-fees-totals` | 15 | ALL GREEN ✅ |
| `verify-enroll-paths` | 17 | 17 ✅ |
| `verify-admission-intake` (alone, kit stocked) | 52 | **52, exit 0** ✅ |
| `verify-enrollment-fees` | 19 | 19 ✅ |
| `qa-phase23` (with `BASE`) | 36/0 | **36 passed / 0 failed** ✅ |
| `qa-certificates` (with `BASE`) | 40/1 | **40 passed / 1 failed** (credential-gated orphan sweep) ✅ |
| `verify-college-routes` | 3/0 | 3/0 ✅ |
| `verify-routine-config` | either calendar form | `2 failure(s), 1 skipped` = 30/2/1skip ✅ |
| `tsc` / `next build` | 0 errors / 186 pages | **0 errors / 186/186 pages** ✅ |

**Non-zero exits in that run, each classified — none caused by this change:**

| verifier | why | evidence |
|---|---|---|
| `verify-read-cache` | **known red**, documented 0 pass / 1 fail | identical (17 slow routes) — unchanged |
| `verify-routine-config` | **known red**, the calendar form | the two class-wide-read failures, 1 skip — unchanged |
| `verify-exams-invalidation` | harness: defaults to `BASE=http://localhost:58497`, which the wrapper never sets | re-run with `BASE=http://127.0.0.1:3000` → **exit 0, all green** |
| `qa-phase23` | harness: defaults to `BASE=http://localhost:64512` | re-run with `BASE` → **36/0** |
| `qa-certificates` | same harness port default | re-run with `BASE` → **40/1** |
| `verify-admission-intake` | needs the kit stocked (`seed-kit-demo.mjs`), and must run alone | stocked + re-run alone → **52, exit 0** |
| `verify-sweep-routes` | reads `attendance` via `BASE_URL` (default `localhost:3000`); order-sensitive against rows earlier verifiers leave | re-run **alone from a clean wipe → 46 ✅, exit 0** |

The two `verify-sweep-routes` failures were `attendance rows well-formed` — attendance data, which no
file in this diff touches (a direct API read found **0** malformed rows).

## What could not be verified

- The suite wrapper does not export `BASE`/`BASE_URL`, so `qa-phase23`, `qa-certificates` and
  `verify-exams-invalidation` cannot pass inside it as written; they were each re-run individually with
  `BASE` and reproduced their documented forms. A future stage could teach the wrapper to pass
  `BASE=BASE_URL=http://127.0.0.1:${SMOKE_PORT}` and stock the kit before `verify-admission-intake`.
- `qa-certificates`' single failure is the credential-gated orphan sweep, which the emulator-only rule
  forbids.
- A crash window remains by design: if a keyed request's guarded fee write lands and the process dies
  before the two appends, the retry replays from the fee stamp AND re-attempts the create-once appends,
  so the rows are written — but a request that never retries leaves the fee stamped with no ledger
  entry (the same window the pre-P2 code had, only narrower).
- No production deploy probe of the fee screens was run (emulator only).

## What I must decide (for the owner)

1. **Is a keyed over-payment better as a 409 than the route's existing 404?** The route's single
   `catch` returns 404 for every refusal today; the message is verbatim either way. Changing it is a
   contract change, so it was left alone.
2. **Should `verify-sweep-routes` / `verify-admission-intake` be documented as order-sensitive and run
   last-but-one from clean**, or should the runner wipe+seed between them?

---

## P2 close-out — the full suite table, every script (with the five corrections)

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

