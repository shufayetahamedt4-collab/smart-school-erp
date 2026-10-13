# Phase 7e — isolation and the Q3 mode-mixing proof

Branch `integration/main-into-college`, HEAD `e5ee07d` (verified current before this phase began).
Emulator only (`127.0.0.1:8080`, project `demo-ss-test`), app on `http://127.0.0.1:3000`, no Cloud call
anywhere. Every 7e change was **uncommitted** in the working tree while this phase ran (this phase commits
nothing). **Record status (2026-10-14):** the 7e work is committed (`f542405` code, `efb97c0` docs) and
this record with it — see [../README.md](../README.md).

## What 7e owes (docs/COLLEGE-DECISIONS.md §24.7 "7e")

> `scripts/isolation-fixture.mjs` gains the four new collections in its `owned` prefix-sweep;
> `verify-tenant-isolation` and `verify-branch-isolation` are re-run **baseline first** with every new
> assertion an **addition**; the COLLEGE gate is asserted explicitly (a SCHOOL tenant gets 403 with
> zero data); **the Q3 mode-mixing condition is proved here with its own checks** — school-mode fee
> totals, the school-mode fee list and `/api/stats`' fee payload are identical with and without
> college charges present, no college row appears in any school-mode read, no school row in any
> college-mode read, and a BOTH tenant's two halves each show only their own money; and the
> untouched-by-Phase-7 harnesses are re-run to identical counts — `verify-fees-totals` 15/15, …

Where each requirement is met, and by what:

| requirement | how it is met | where |
|---|---|---|
| the fixture owns the new collections | the five `collegeFee*`/`collegeDiscount` collections were already in the sweep (7c); **7e adds the money both halves need** | `scripts/isolation-fixture.mjs` |
| COLLEGE gate, explicit | a SCHOOL tenant is 403-with-zero-data on the college fee read **and** the write, and its print pages say "college tenants only" | `scripts/verify-role-probe.mjs` §C (was already pinned for the API by `verify-college-fees-api`; the **screens and print pages** are new here) |
| **Q3: school read identical with and without college money** | **measured in the run**: the school fee list and `/api/stats`' fee payload are captured, a college head + structure + charge are created for the same tenant, and the two captures are compared **byte for byte** | `scripts/verify-mode-mixing.mjs` §4 |
| Q3: no college row in a school-mode read | exact assertions on both the fee list and the stats payload (ids, titles, the college's own 45,000/30,000), in **both** modes | `scripts/verify-mode-mixing.mjs` §1–§2, `scripts/verify-fees-totals.mjs` |
| Q3: no school row in a college-mode read | the dues read and its rows, checked for the school ids, titles and amounts | `scripts/verify-mode-mixing.mjs` §3, `scripts/verify-fees-totals.mjs` |
| Q3: a BOTH tenant's two halves, each their own money | school 17,000/8,000/9,000 vs college 45,000/15,000/30,000, both non-empty, neither appearing in the other's read | `scripts/verify-mode-mixing.mjs`, `scripts/verify-fees-totals.mjs` |
| Q3: the shared ledger's ONE tag is what separates them | the school entry keeps `feeId` and no college tag; the college entry is `feeId: null` + `meta.collegeFeeId` + its own `CRCP-` receipt | `scripts/verify-mode-mixing.mjs` §5 |
| cross-tenant isolation | a foreign student is the same 404 as a ghost id, in both directions, and the tenant-wide ledger of one tenant holds none of the other's rows | `scripts/verify-mode-mixing.mjs` §6 |
| cross-branch isolation | **already pinned** by `verify-branch-isolation`'s "college fees — branch admin confinement (7c)" section (own-branch heads/structure/payment, 403 on another branch's charge) — re-run unchanged, count recorded below | `scripts/verify-branch-isolation.mjs` |
| `verify-fees-totals` keeps its school contract | the 15 school checks are untouched and still pass; the college checks are **additions** | `scripts/verify-fees-totals.mjs` |
| untouched harnesses re-run to identical counts | see the table in §"Baseline-first re-runs" | — |

**Why a BOTH tenant had to gain real money.** `verify-college-fees-api` already proves a *college-only*
tenant's (empty) school read does not move when college money appears. That is necessary and not
sufficient: a tenant with no school money cannot show that school money stays out of the college read,
nor that its own school total is unaffected by a college write. The fixture's BOTH tenant therefore
seeds **both halves**, with deliberately non-overlapping amounts (the school's 12,000 + 5,000 against
the college's 45,000) so a failure says *which* half's money came back.

## What 7e changed

| file | change |
|---|---|
| `scripts/isolation-fixture.mjs` | **additions only**: the BOTH tenant gains a school fee spine (`feeSettings`, two `fees`, one `payments`, one school `ledger` entry) and a college fee spine (head, structure row, `cfc_…` config, one `collegeFees` charge, one **tagged** college `ledger` entry), plus the three refused-role users (`TEACHER`, `GUARDIAN`, `STUDENT`) the role probe needs **inside a college-capable tenant**. Every row is `mark()`ed, so `clean` removes exactly what the fixture wrote. |
| `scripts/verify-mode-mixing.mjs` | **new** (33 checks) — the Q3/BOTH proof above: the measured before/after, both modes on both halves, the ledger tag, cross-tenant. |
| `scripts/verify-fees-totals.mjs` | the fifteen school checks are untouched; **+9 checks** add the college half of the same money rule on the BOTH tenant (finite money, the fixture's own charge, totals that are exactly their own rows, and neither half's money in the other's read). The college half SKIPS loudly when the fixture is absent (a hosted run) rather than reporting an unrun check as green. |
| `scripts/suite-all.mjs` | `verify-mode-mixing` joins the SERVER list after `verify-branch-isolation` (it WRITES one college charge, and `verify-college-fees-api` must stay last). |

## Baseline-first re-runs (actual commands, exit codes, counts)

Run against the local emulator only, each verifier preceded by a fresh fixture and an app restart (the
`suite-all` discipline: `isolation-fixture.mjs create`, then the app restarted after it), the app on
`:3000`, `SMOKE_PORT=3000`.

| verifier | command | exit | the script's own count |
|---|---|---|---|
| `verify-mode-mixing` | `node scripts/verify-mode-mixing.mjs` | **0** | **33/33** — PASSED (`baseline-verify-mode-mixing-33-of-33.txt`) |
| `verify-fees-totals` | `node scripts/verify-fees-totals.mjs` | **0** | **24 PASS / 0 FAIL** = the **15** school checks (unchanged, the recorded school baseline) + **9** college additions (`baseline-verify-fees-totals-24-checks.txt`) |
| `verify-tenant-isolation` | `node scripts/verify-tenant-isolation.mjs` | **0** | **106** ✅ — `ISOLATION CONFIRMED — no cross-school data in any of the 13 swept routes` (`verify-tenant-isolation.txt`) |
| `verify-branch-isolation` | `node scripts/verify-branch-isolation.mjs` | **0** | **73** PASS (`verify-branch-isolation.txt`) |
| `verify-college-fees-api` (LAST — it resets its own tenant) | `node scripts/verify-college-fees-api.mjs` | **0** | **112/112** (`verify-college-fees-api.txt`) |
| `verify-role-probe` (D-7-18, production build) | `PROBE_ORIGIN=http://127.0.0.1:3111 node scripts/verify-role-probe.mjs` | **0** | **24/24** — see [../7f/REPORT.md](../7f/REPORT.md) |

**No assertion was edited, weakened, skipped or deleted anywhere.** `verify-tenant-isolation` and
`verify-branch-isolation` are re-run **unchanged**; their college-fee coverage already exists
(`verify-branch-isolation`'s branch-confinement section, and `verify-college-fees-api`'s SCHOOL-tenant
403 / unauthenticated 401 / foreign-404-no-oracle matrix), so 7e's *new* coverage lives in the two
verifiers above and in the role probe rather than in edits to those two files. That is a decision, not
an omission, and the counts above are the evidence that they still pass.

Offline (no emulator, no server) re-runs of the 7d/7e-adjacent verifiers, all exit 0:
`verify-college-fees-page` **360** in the 7f batch (**366** since section 16 added its six copy pins — [../7d/REPORT.md](../7d/REPORT.md)),
`verify-college-fees-data` **11**, `verify-college-fees-logic` **21**, `verify-college-routes` **22**, `verify-college-grading-logic` **13**,
`verify-college-results-page` **106**, `verify-onboarding-seed` **87**, `verify-database-id` **17**,
`verify-nav-scope`, `verify-college-gate`, `verify-college-permissions` — all OK. The first four were
re-run offline after the `verify-fees-totals` false-green fix (see the correction note below);
`verify-nav-scope`, `verify-college-gate` and `verify-college-permissions` were not re-run and stand
on the original transcript: [../7f/production-build.txt](../7f/production-build.txt).

## Mutation proofs — each new critical check was made to fail, then restored

Every mutation is local, in the working tree or against the throwaway emulator fixture, and was
reverted immediately; the verifier was re-run afterwards to show green again. All four are transcripts
in this directory. **The counts in the table are read from those transcripts, not estimated** — the
mutation-4 row therefore carries two numbers, because its transcript (a dev-server run) and its
production-build re-enactment legitimately differ by exactly check F. The review of 2026-10-13 found
this table had undercounted rows 1 and 4; both were corrected against the files, and no transcript was
altered.

| # | mutation (representative incorrect behaviour) | where | expected | observed | restored |
|---|---|---|---|---|---|
| 1 | the school fee read **appends the tenant's college charges** (`prisma.collegeFee.findMany` shaped into `/api/fees`) | `src/app/api/fees/route.ts` | school-read checks fail | `verify-mode-mixing` **5 ❌ of 33** (the own-rows check, the school-totals check, the no-college-money check, the stats check, and — the leak's knock-on — the after-the-write byte-identical check) and `verify-fees-totals` **2 FAIL** — `mutate-1-school-read-leak-*.txt` | yes — the file is byte-identical to HEAD afterwards |
| 2 | the college dues read **appends the tenant's school fees** | `src/app/api/college-fees/dues/route.ts` | college-read checks fail | `verify-mode-mixing` **2 ❌** (`totals are exactly its own rows`, `the school's rows are still absent`) and `verify-fees-totals` **2 FAIL** — `mutate-2-college-read-leak-*.txt` | yes |
| 3 | the fixture's **school ledger entry is tagged as college money** (`meta.collegeFeeId` on a row that has a `feeId`) | the emulator store, via a temporary gitignored `scripts/_tmp-7e-store-mutate.mjs` | ledger-tag checks fail | `verify-mode-mixing` **3 ❌** (`the school's own entry keeps its feeId and carries NO college tag`, `every college-tagged row has NO school feeId`, `no row carrying a school feeId is college-tagged`) — `mutate-3-school-ledger-row-tagged.txt`; restored → **33/33 PASS** (`mutate-3-restored.txt`) | yes |
| 4 | `GUARDIAN` added to the college fee **read** allow-list | `src/lib/college-fees-access.ts` | the role checks fail | `verify-role-probe` **4 ❌ of 24** in the transcript — the three role checks (`all three are 403 on the college fee read` → `[403,200,403]`, and both print-page refusal checks) **plus check F** ("the build that answered"), because that run dialled the **dev server**, whose page carries no `.next/BUILD_ID`. **Re-enacted on a real production build (2026-10-13, build `fAPnqL2DcE_P65Ormou9k`) → 3 ❌ of 24**, exactly the three role checks — [../7f/mutate-guardian-read-allowlist-recheck.txt](../7f/mutate-guardian-read-allowlist-recheck.txt) | yes |

**One caveat, stated rather than hidden.** Mutation 3's failure appears only AFTER the app's in-process
read memo refreshes (~30 s + 120 s grace, `src/lib/db.ts` — the pre-existing behaviour behind
`verify-read-cache`'s documented red). The first attempt therefore read the un-mutated rows and passed;
the proof above is the cache-safe form (app **restarted** between the mutation and the run), and the
"restored" run is green. A mutation that a stale memo could hide is a real property of this app, not of
the check: the check reads the API, and the API is what serves the memo.

## What could NOT be run, and why

- **The whole `suite-all.mjs` in one pass.** Its 50-verifier run wipes the emulator and restarts the
  app for every verifier (hours on this machine). The verifiers above were run individually under the
  SAME discipline (fresh fixture + restart), and the untouched harnesses were re-run to their recorded
  counts in batches (see [../7f/REPORT.md](../7f/REPORT.md) §D).
- **`verify-read-cache`** — known red (latency assertion, `42 route(s) still pay full latency` on the
  dev server this session vs the `17` in the 7c record; dev-mode latency varies with route compilation,
  and the check is documented as red either way).
- **`verify-routine-config`** — known red (`2 failure(s), 1 skipped` — the seeded routines are
  section-scoped while the class-wide read returns `sectionId == null` rows; calendar-gated, unchanged
  by Phase 7).
- **`qa-certificates`** — `40 passed, 1 failed`, the long-documented credential-gated orphan sweep that
  the emulator-only rule forbids fixing.
- **A hosted-mode run.** `SMOKE_ORIGIN=…` was not used: no deployment is involved in 7e, and the
  college half of `verify-fees-totals` deliberately skips where there is no fixture tenant.

## Reproduce it

```
# emulator only
npx firebase emulators:start --only firestore --project demo-ss-test &
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-ss-test
node scripts/seed.mjs
node scripts/isolation-fixture.mjs create
node scripts/dev-emulator.mjs                       # dev, :3000  (restart AFTER the fixture)
export SMOKE_PORT=3000 VERIFY_PORT=3000
node scripts/verify-mode-mixing.mjs                 # 33/33
node scripts/verify-fees-totals.mjs                 # 24 checks, ALL GREEN
node scripts/verify-tenant-isolation.mjs            # 106 ✅
node scripts/verify-branch-isolation.mjs            # 73 PASS
node scripts/verify-college-fees-api.mjs            # 112/112  (LAST)
```

## Correction note (2026-10-13, pre-commit review)

A read-only review found four documentation/verifier issues; the full record is
[../7f/REPORT.md](../7f/REPORT.md) §D-ter. Three touch this report:

- **The mutation table above now matches its transcripts.** Row 1 reads **5 ❌ of 33** (the transcript's
  own `FAILED — 5 of 33`), row 2 keeps the **2 ❌ of 33** / `2 CHECK(S) FAILED` its two transcripts
  report, row 3 the **3 ❌ of 33** of `mutate-3-school-ledger-row-tagged.txt`, and row 4 carries both of
  its numbers — **4 ❌ of 24** against the dev server (check F included: that page has no
  `.next/BUILD_ID`) and the **3 ❌ of 24** its production-build re-enactment reports. **No transcript was
  altered** to make it agree.
- **`verify-fees-totals.mjs` can no longer report a skipped college half as green.** A local run without
  `scripts/.qa-fixtures.json` now counts the missing prerequisite as a failure and exits non-zero; the
  hosted path keeps its loud SKIP and its exit code. Re-checked in three conditions —
  [../7f/fees-totals-fixture-present-recheck.txt](../7f/fees-totals-fixture-present-recheck.txt)
  (**24 PASS / 0 FAIL**, exit 0),
  [../7f/fees-totals-fixture-missing-recheck.txt](../7f/fees-totals-fixture-missing-recheck.txt)
  (**15 PASS + 1 counted failure**, `1 CHECK(S) FAILED`, exit 1, no `ALL GREEN`) and
  [../7f/fees-totals-hosted-skip-recheck.txt](../7f/fees-totals-hosted-skip-recheck.txt) (SKIP, exit 0).
- The D-7-18 role probe is **untracked until this change is committed** — `PROGRESS.md` and the 7f report
  now say that instead of calling it committed code.

The four offline verifiers listed above were re-run in the same pass — page **366**, data **11**,
logic **21**, routes **22**, all exit 0 ([../7f/offline-verifiers-recheck.txt](../7f/offline-verifiers-recheck.txt)).
