# Phase 7f — the finished record (college fees, 7a → 7f)

Branch `integration/main-into-college`, HEAD `e5ee07d` at the start of the phase and **still the HEAD
at the end** (7d's remainder, 7e and 7f were **uncommitted working-tree changes** at the time; nothing was
staged, committed, pushed or deployed then). **Record status (2026-10-14):** committed — `f542405` code
and verifiers, `efb97c0` docs, this record with them; see [../README.md](../README.md). Emulator only (`127.0.0.1:8080`, `FIREBASE_PROJECT_ID=demo-ss-test`),
no Cloud call anywhere, no production environment variable, secret or deployment setting touched.

Format: the §22 / §23.7.1 shape (the counts table, the re-run table, the known reds, what could not run).

---

## A. The Phase 7 additions, and the suites that grew

| suite | before Phase 7 | after 7f | why it moved |
|---|---|---|---|
| `verify-college-fees-logic` (7a, offline) | — (new) | **21** | presets, cadence → billing events, term totals, per-student derivation, the deterministic `cf_…` id, percent + fixed waivers, finite-money normalisation |
| `verify-college-fees-data` (7b, offline) | — (new) | **11** | the four `collegeFee*` collections in `COLS`/`RELS`/prisma as a purely additive change; the school spine untouched; the ledger's readers are the audited set; the college entry is tagged and writes no school `payment` row |
| `verify-college-fees-api` (7c, HTTP) | — (new) | **112** | the 8 routes / 17 handlers: guard order, the 403/400/404 matrix, generation dry-run + idempotence, integer-minor payments with over-payment refused, awards propose/approve with no self-approval, the staff matrix, and the 7e-pre idempotency probes |
| `verify-college-fees-page` (7d, offline) | — (new) | **366** (360 before section 16 — see §D-ter) | the screen's decisions, the ledger badge, the two print pages, the receipt's one-payment rule, the four 7d-fix UX items, the **7d remainder** (the statement/receipt routes, their guard chain, their hrefs), and the **copy pins** section 16 added for the 7d copy fixes |
| `verify-mode-mixing` (7e, HTTP, **new this phase**) | — (new) | **33** | the Q3 proof: the school half byte-identical with and without college money, both halves in both modes, the ledger tag, cross-tenant |
| `verify-role-probe` (D-7-18, **new this phase**) | — (new) | **24** | the production-build role/permission probe of the college fee screen and both print pages |
| `verify-fees-totals` | **15** | **24** | +9: the college half of the same money rule on the BOTH tenant (the 15 school checks are unchanged — that is the recorded school baseline) |
| `verify-tenant-isolation` | 97 (6f record) | **106** ✅ | unchanged by 7e (re-run only) |
| `verify-branch-isolation` | 65 (6f record) | **73** PASS | unchanged by 7e (re-run only; its college-fee branch-confinement section came in with 7c) |
| `next build` | 185 pages | **187 pages** | 7d's two D-7-17 print routes: `/print/college-fee-statement/[studentId]`, `/print/college-fee-receipt/[chargeId]` |

## B. Commits, and the files this phase touched

**Commits: none.** `git log -1` is `e5ee07d` (the audited HEAD) before and after. Per the phase's
constraints nothing was staged or committed; the change set below is the working tree.

| file | state | what it carries |
|---|---|---|
| `src/app/print/college-fee-statement/[studentId]/page.tsx` | **new** | D-7-17 statement: session → tenant → college gate → `canReadCollegeFees` → branch, live rows, per-term totals, the rate footer naming each structure row and its effective date, the student's own payments read from the shared ledger by its ONE tag |
| `src/app/print/college-fee-receipt/[chargeId]/page.tsx` | **new** | D-7-17 receipt: one confirmed payment (`?receipt=CRCP-…` selects which), the charge's own billed/paid/due at print time, the rate that priced it, the same guard chain |
| `src/lib/college-fees-view.ts` | modified (+179) | the pure decisions both pages and the screen use: the two print hrefs, `statementTermValue`/`statementTerms`/`statementScopeText`, `isCollegePaymentEntryFor`/`paymentReceiptNo`/`pickReceiptEntry`, `structureRateText`/`structureEffectiveAt`, `chargeSettlementText` |
| `src/app/dashboard/college-fees/page.tsx` | modified (+64) | the Dues tab links each row's statement and the just-recorded payment's receipt; the receipt state is cleared when another student is picked; the Fee-structure subtitle and the Basis hint are complete sentences (7d look-at item 3) |
| `scripts/verify-college-fees-page.mjs` | modified (+194) | sections 14/15: the two print pages, their guard chain, their hrefs, the term grouping/scope arithmetic, and the receipt's one-payment rule |
| `scripts/verify-college-fees-data.mjs` | modified | the ledger-reader audit now names the two print pages (reviewed: tenant-keyed reads, tag-filtered) + the header text |
| `scripts/verify-college-fees-api.mjs` | modified | the ledger-reader audit prose records the same review |
| `scripts/isolation-fixture.mjs` | modified (+105) | 7e: the BOTH tenant's school + college money spines and the three refused-role users |
| `scripts/verify-fees-totals.mjs` | modified (+100) | 7e: the college half, as additions |
| `scripts/verify-mode-mixing.mjs` | **new** | 7e |
| `scripts/verify-role-probe.mjs` | **new** | D-7-18 |
| `scripts/suite-all.mjs` | modified | registers `verify-mode-mixing` after `verify-branch-isolation` (`verify-college-fees-api` stays LAST) |

Also on the working tree, unchanged by this phase but part of the fee line: 7a's
`src/lib/college-fees.ts`, 7b's four models in `src/lib/db.ts`, 7c's eight route files,
`src/lib/college-fees-access.ts`, `src/lib/college-fees-server.ts`, and the D-7-12/I-7-13 addition to
`src/lib/ledger.ts` (all committed earlier on this branch).

## C. Verifiers — names, counts, exit codes (all on the final working tree)

**C1. This phase's own evidence**

| verifier | exit | count | transcript |
|---|---|---|---|
| `node scripts/verify-mode-mixing.mjs` | **0** | **33/33 PASSED** | [../7e/baseline-verify-mode-mixing-33-of-33.txt](../7e/baseline-verify-mode-mixing-33-of-33.txt) |
| `node scripts/verify-fees-totals.mjs` | **0** | **24 PASS / 0 FAIL** (15 school + 9 college) | [../7e/baseline-verify-fees-totals-24-checks.txt](../7e/baseline-verify-fees-totals-24-checks.txt) |
| `node scripts/verify-college-fees-page.mjs` | **0** | **366** | offline; 360 in the production-build batch, +6 from section 16 (§D-ter) |
| `node scripts/verify-college-fees-data.mjs` | **0** | **11** | `../7e/verify-college-fees-data` in the same batch |
| `node scripts/verify-college-fees-api.mjs` (LAST) | **0** | **112/112** | [../7e/verify-college-fees-api.txt](../7e/verify-college-fees-api.txt) |
| `node scripts/verify-tenant-isolation.mjs` | **0** | **106** ✅ | [../7e/verify-tenant-isolation.txt](../7e/verify-tenant-isolation.txt) |
| `node scripts/verify-branch-isolation.mjs` | **0** | **73** PASS | [../7e/verify-branch-isolation.txt](../7e/verify-branch-isolation.txt) |
| **`PROBE_ORIGIN=http://127.0.0.1:3111 node scripts/verify-role-probe.mjs`** | **0** | **24/24** against **production build `J8dv3wQUnWhHl5Yxf2rz_`** — and **re-run independently the same day** at 24/24 against a second build, `bTZhoZ8u8HFwxegmI4rKq` | [production-role-probe-24-of-24.txt](production-role-probe-24-of-24.txt), [production-role-probe-24-of-24-recheck.txt](production-role-probe-24-of-24-recheck.txt) |
| `npm run typecheck` (`tsc --noEmit`) | **0** | **0 errors** | [production-build.txt](production-build.txt) |
| `npm run build` (`next build`) | **0** | **187/187** static pages — the two new print routes listed as dynamic | [production-build.txt](production-build.txt) |

**C2. The existing school regression baseline — re-run, identical**

| suite | count this run | recorded baseline |
|---|---|---|
| `verify-fees-totals` (school half, unchanged) | **15** PASS | 15 |
| `verify-enrollment-fees` | **19** checks (20 lines = 19 + its summary), `ENROLMENT FEES OK` | 19 |
| `verify-school-fee-idempotency` | **69/69** | 69 |
| `qa-phase23` | **36 / 0** | 36 / 0 |
| `verify-grading` | exit 0 — **38** checks + summary, `PASS — the grading system is editable…` | 38 / 0 |
| `verify-mode-foundation` | exit 0 — **64** checks + summary, `PASSED` | 64 / 0 |
| `verify-pilot-hardening --offline` | **183/183** | 183 / 0 |
| `verify-course-registrations` | **200/200** | 200 |
| `verify-college-routes` | **22** (route files/handlers re-counted) | 22 |
| `verify-nav-scope` | exit 0 — `school output is the frozen registry, and the college items stay behind the COLLEGE gate` | — |
| `verify-college-gate`, `verify-college-permissions`, `verify-onboarding-seed` (**87**), `verify-database-id` (**17**), `verify-college-grading-logic` (**13**), `verify-college-results-page` (**106**), `verify-college-fees-logic` (**21**) | all exit 0 | as recorded |

(The recorded Phase 6/7c baselines for `verify-tenant-isolation` and `verify-branch-isolation` — 97 and
65 — were measured before 7c's college fee route sweep landed; the 106 / 73 above are those two suites
as they stand on this branch, re-run unchanged by 7e.)

**No school assertion was edited anywhere in Phase 7.** `verify-nav-scope` still reports the non-college
nav deep-equal to the frozen snapshot. `verify-enroll-paths`, `verify-admission-intake` and the other
server-backed suites that no Phase 7 file touches were **not re-run in this session** — listed in §F
rather than counted here.

## D. The production-build role/permission probe (D-7-18) — **RUN, and it passes**

This was the go-live item open since 6f ("A production-build role probe of the college screens — not
run"). It is now run, against a real production binary:

```
npm run build                                   exit 0   187/187 pages
NODE_ENV=production npx next start -p 3111      emulator env, FIREBASE_CLIENT_EMAIL/KEY empty
PROBE_ORIGIN=http://127.0.0.1:3111 node scripts/verify-role-probe.mjs    exit 0   24/24
```

The probe is a **real verifier file in this change set** (`scripts/verify-role-probe.mjs` — untracked while
this phase ran, exactly like every other file in Phase 7 until the change was committed, and committed
on 2026-10-14; it is
the phase's own code, not a scratch script, the 7c-follow-up lesson), and it reports WHICH build answered: it reads `.next/BUILD_ID` and requires the
served page to embed it, so a dev-server run fails exactly that one check by design
([role-probe-against-a-dev-server.txt](role-probe-against-a-dev-server.txt)).

What it proves, over HTTP and on the served pages:

- **authorized college access** — the tenant's admin renders its OWN charge (৳45,000.00) and its
  `CRCP-` receipt (৳15,000.00) on the two print pages; the ACCOUNTANT and the read-only REGISTRAR reach
  the screens and the print pages; the ACCOUNTANT is past the write gate (a 400 from validation) while
  the REGISTRAR is refused (403);
- **unauthorized school-tenant rejection** — a tenant with no college half is 403-with-zero-data on the
  read and the write, and its print pages say "available to college tenants only" with no college money
  in the HTML;
- **role boundaries** — TEACHER, GUARDIAN and STUDENT are refused **inside a college-capable tenant**
  (403 + the D-7-18 read refusal on both print pages, 403 on the write) while their own school fee read
  still works;
- **authentication** — no session renders "…not found." and the APIs answer 401/403;
- **tenant isolation** — a foreign student or charge is the SAME answer as a ghost id, in both
  directions, with no foreign money in the HTML.

## D-bis. The probe's PRECONDITION — found by re-running it (2026-10-13)

§D records the probe at 24/24. It was re-run this session against a **second production build**
(`npm run build` exit 0, 187/187 pages, `.next/BUILD_ID = bTZhoZ8u8HFwxegmI4rKq`,
`NODE_ENV=production npx next start -p 3111`) and **failed 4 checks the first time** — and that failure
is worth keeping, because it names a precondition the tables above did not state.

**What happened.** The re-run followed the order §C1's tables are written in: fixture created, the
verifiers run (with `verify-college-fees-api` LAST), then the probe. But `verify-college-fees-api.mjs`
**deliberately resets the BOTH tenant's college fee spine** — line 264, `await resetCollegeFees(\`${P}both\`)`
— so the spine the probe asserts against (the fixture's ৳45,000 charge, its `CRCP-900001` ledger entry)
was gone by the time the probe ran. Nothing about the role matrix had regressed: the probe correctly
reported an empty college half (`the admin's print statement renders the tenant's OWN charge` ❌,
`the admin's print receipt renders THAT payment` ❌, and the two “authorized, empty” print-page checks ❌
for the ACCOUNTANT and REGISTRAR). The route decisions, the SCHOOL-tenant refusal and the
TEACHER/GUARDIAN/STUDENT refusal all still passed — 20 of 24.

**The fix was the order, not the probe.** `node scripts/isolation-fixture.mjs create` (exit 0) restores
the college spine; the probe then passed **24/24 on the same build in the same session**, and the whole
sequence is kept verbatim (both the failed attempt and the pass) in
[production-role-probe-24-of-24-recheck.txt](production-role-probe-24-of-24-recheck.txt). No assertion,
no page and no route was changed to make it pass — the acceptance criterion is about the role matrix,
and that matrix was green throughout.

**The order to reproduce the 24/24, therefore:**

```
node scripts/isolation-fixture.mjs create                # the college spine exists
PROBE_ORIGIN=http://127.0.0.1:3111 node scripts/verify-role-probe.mjs   # 24/24
node scripts/verify-college-fees-api.mjs                 # LAST — it resets ${P}both's college spine on purpose
# (a further probe run after this one needs `isolation-fixture create` again)
```

The recorded `production-role-probe-24-of-24.txt` run was made with the spine in place (that is why it
passed); the recheck file records both states so a reader can tell which one they are looking at.

**The probe's role checks were also mutation-proved on a production build this session**, so that "24/24"
is not a vacuous pass (re-running 7e's mutation 4, `proof/7e/mutate-4-guardian-added-to-read-roles.txt`):
`COLLEGE_FEES_READ_ROLES` was given `"GUARDIAN"` in `src/lib/college-fees-access.ts`, the app rebuilt
(`fAPnqL2DcE_P65Ormou9k`), and the probe **failed 3 of 24** — `all three are 403 on the college fee read`
became `[403,200,403]`, and both print pages stopped rendering the refusal. The file was then restored
byte-identically (`sha1sum -c` OK, `git diff` empty), rebuilt (`tjRUuwGvujOhe_dYHTjb5`) and the probe
re-run to **24/24**. Transcript: [mutate-guardian-read-allowlist-recheck.txt](mutate-guardian-read-allowlist-recheck.txt).

**Also re-run this session, unchanged and green** (all HTTP, emulator only, app on `:3000`, each preceded
by a fixture create/restart):

| verifier | exit | observed | matches the record above |
|---|---|---|---|
| `verify-mode-mixing` | 0 | 33/33 PASSED | yes |
| `verify-fees-totals` | 0 | 24 PASS / 0 FAIL (15 school + 9 college) | yes |
| `verify-tenant-isolation` | 0 | 106 ✅ | yes |
| `verify-branch-isolation` | 0 | 73 `PASS` lines (72 checks + its summary) | yes |
| `verify-college-fees-api` | 0 | 112/112 | yes |
| `verify-college-fees-page` / `-data` / `-logic` / `-routes` (offline) | 0 | 366 / 11 / 21 / 22 | yes (360 in the batch above; section 16 came later — §D-ter) |
| `verify-mode-foundation` | 0 | PASSED | yes |
| `verify-grading` | 0 | PASS | yes |
| `verify-enrollment-fees` | 0 | OK (19 checks) | yes |
| `verify-pilot-hardening --offline` | 0 | 183/183 | yes |
| `verify-school-fee-idempotency` | 0 | 69/69 | yes |
| `qa-phase23` | 0 | 36 passed / 0 failed | yes (it needs `BASE`/`BASE_URL` — without them it dials a dead random port and prints `0 passed, 1 failed`) |
| `npm run typecheck` | 0 | 0 errors | yes |

## D-ter. The pre-commit corrections (2026-10-13, after the read-only review)

A read-only review of this working tree found four documentation/verifier issues. All four were fixed
before commit-selection; **no business logic, API contract, authorization rule or calculation changed**,
and no transcript was rewritten.

**1. Two new source-level checks for the 7d copy fixes (`verify-college-fees-page.mjs` section 16).**
The review found that [proof/7d/REPORT.md](../7d/REPORT.md) claimed the item-3 copy was "pinned by the
source-level check" when **no assertion mentioned it** (`grep -rn "per term and per head" scripts/*.mjs`
was empty). The college fee page is a client render, so the sentence cannot be fetched over HTTP; the
file now carries **six** pins in the same style section 12 already uses for the phantom total: the
complete intro and Basis sentences, the OLD clipped fragments' `absence`, and the preview label bound to
its dry-run branch. Count **360 → 366**. Mutation-proved: re-clipping the intro fails **2 of 366**, and
so does dropping the label (`proof/7d/mutate-4-copy-reclipped.txt`, `-5-preview-label-changed.txt`),
both files restored byte-identically (`sha1sum -c` OK) and the verifier back to **PASSED — 366 checks.**
Re-run once more at the close of the pre-commit pass: **366 PASSED**, exit 0, in a batch with
`verify-college-fees-data` (**11**), `-logic` (**21**) and `-routes` (**22**), all exit 0 —
[offline-verifiers-recheck.txt](offline-verifiers-recheck.txt).

**2. `verify-fees-totals.mjs` can no longer report a skipped college half as green.** The review found
that a local run without `scripts/.qa-fixtures.json` printed a SKIP and then still printed `ALL GREEN`
and exited 0, as if the 9 college checks had run. Smallest safe change: in a **local** run the missing
prerequisite is now a counted failure with the fixture command in its message; a **hosted** run
(`SMOKE_ORIGIN` set) keeps the previous loud SKIP and its exit code. Measured:

| condition | command | exit | observed |
|---|---|---|---|
| fixture **present** (local) | `SMOKE_PORT=3000 node scripts/verify-fees-totals.mjs` | **0** | **24 PASS / 0 FAIL**, `ALL GREEN` — the 15 school + 9 college checks exactly as before |
| fixture **missing** (local) | same, with `scripts/.qa-fixtures.json` moved aside | **1** | **15 PASS** (the school baseline) + 1 counted failure, `1 CHECK(S) FAILED`, **no `ALL GREEN`** |
| fixture **missing**, hosted path | `SMOKE_ORIGIN=http://127.0.0.1:3000 …` | 0 | prints the `SKIP  the college half …` line exactly as before; **no** counted college-half failure |

The fixture file was restored byte-identically (`sha1sum -c` OK).

Re-checked end-to-end at the close of the pre-commit pass, in the same three conditions (transcripts
[fees-totals-fixture-present-recheck.txt](fees-totals-fixture-present-recheck.txt) — **24 PASS / 0 FAIL**,
exit 0; [fees-totals-fixture-missing-recheck.txt](fees-totals-fixture-missing-recheck.txt) — the
**15 school PASS + 1 counted failure**, `1 CHECK(S) FAILED`, exit 1, no `ALL GREEN`;
[fees-totals-hosted-skip-recheck.txt](fees-totals-hosted-skip-recheck.txt) — the SKIP line, exit 0).
The recheck pass ran `isolation-fixture create` first (the file is generated with fresh credentials each
run), so the fixture in the tree is the one matching the freshly seeded emulator rather than the earlier
session's bytes; no verifier result depends on the old bytes.

**3 and 4. Two claims corrected in the record.** This report no longer calls `verify-role-probe.mjs`
"committed code" (it was untracked while the phase ran; it was committed on 2026-10-14 — §D), and
[proof/7e/REPORT.md](../7e/REPORT.md)'s mutation table was reconciled with its own transcripts
(mutation 1: **5 of 33**, not 4; mutation 4's transcript is **4 of 24** against a **dev server** — check F
included — against the **3 of 24** its production-build re-enactment reports).

## E. Isolation and the BOTH-tenant Q3 evidence

See [../7e/REPORT.md](../7e/REPORT.md). The short version: on the fixture's **BOTH** tenant — whose two
halves the fixture now populates with non-overlapping amounts — the school fee list and `/api/stats`'
fee payload were captured, a college head + structure + charge were then created for the same tenant,
and both captures came back **byte-identical** (33/33 checks), while the college half gained exactly the
new charge's money and no school row appeared in it. The ledger keeps the two apart by its ONE tag, and
four mutations (a school-read leak, a college-read leak, a mis-tagged ledger row, and `GUARDIAN` added
to the read allow-list) each made the suite fail before being restored.

## F. Checks that did NOT run, and why

- **The full `suite-all.mjs` in one invocation.** Its 50 verifiers each wipe the emulator and restart the
  app; that is hours here. The same verifiers were run individually under the same discipline (fresh
  fixture + restart) — including every one the plan names for 7e.
- **`verify-read-cache`** — known red: `FAIL — 42 route(s) still pay full latency on a repeat read`
  this session (the record's `17` is the same dev-mode latency assertion; the count varies with dev
  route compilation). Pre-existing, unchanged, and no Phase 7 assertion depends on it.
- **`verify-routine-config`** — known red: `2 failure(s), 1 skipped` (the seed writes section-scoped
  routines; the class-wide read returns `sectionId == null` rows). Unchanged since before Phase 6.
- **`qa-certificates`** — `40 passed, 1 failed`: the credential-gated orphan sweep the emulator-only
  rule forbids fixing.
- **A hosted/Cloud run of the probe.** No deployment was used or made; the probe ran against a local
  production build over the emulator, which is the environment every phase's evidence uses.
- **`verify-phase7-e2e`, `verify-bulk-import`, `verify-admission-intake`, the promotion suites and the
  remaining server-backed verifiers** were not re-run in this session (they were green at `e5ee07d`'s
  audit and no Phase 7 change touches their paths — the changed files are the two print pages, the fee
  page/view, and scripts). Recorded as *not re-run here* rather than as passing.

## G. Known unresolved issues (unchanged, and NOT introduced by Phase 7)

1. The four `smoke-all.mjs` browser checks and `verify-read-cache`/`verify-routine-config` stand as
   documented reds (`docs/SMOKE-FAILURES.md`).
2. The app's in-process read memo can serve a ~30 s-stale read (the reason mutation 3's first attempt
   was masked). A multi-instance go-live question, recorded in `PROGRESS.md`.
3. `POST /api/schools` still writes a school `feeSetting` for a brand-new college-only tenant
   (7-pre item 1, an open item).
4. The bulk-import fast path (`src/lib/import/write.ts`, `ensureFeeSetting()`) raises the school's
   default fee setting outside `enrollStudent` — a college import (Phase 9c) would still bill 1500/5000
   (7-pre-2's open item (i)).
5. v1 scope by owner ruling: no guardian/student/teacher college fee view, no per-credit pricing, no
   standing scholarships, no PDF archival, no dunning automation (§24.6).
6. `firestore.indexes.json`'s `schoold` field typo is fixed in the file but still live in both
   databases (`COLLEGE-STATUS.md` §7).
7. No Firestore index was added for the college fee uniqueness queries (the repo declares none for the
   comparable college queries; the shim filters in memory).
8. **Harness ordering (found by the 2026-10-13 re-run, §D-bis):** the D-7-18 probe needs the fixture's
   college spine, and `verify-college-fees-api` (the verifier documented as LAST) resets that spine on
   purpose. Running the probe after it — without re-creating the fixture — fails 4 checks with an empty
   college half. The probe itself is unchanged and correct; the order is the thing to respect.

## H. The verdict

**Phase 7 is complete, including 7e and 7f** — 7d's print pages and UX remainder, 7e's isolation and
Q3 mode-mixing proof with mutation-proved checks, the D-7-18 production-build role probe (24/24 against
build `J8dv3wQUnWhHl5Yxf2rz_`), and this record — with the two known-red verifiers and the unre-run
suites listed explicitly above rather than counted as passes.
