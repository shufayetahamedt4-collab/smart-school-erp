# Pre-merge verification record — `integration/main-into-college`

**Date:** 2026-10-14 · **Branch:** `integration/main-into-college` · **HEAD:** `6a7a31f` ·
**Mode:** Firestore emulator only (`127.0.0.1:8080`, project `demo-ss-test`), no `src/` or `scripts/`
edit, nothing deployed, nothing pushed to `main` / `origin/main` / `college-support`.

This is the record of one full stage, run on this exact tree. Every number below was measured today;
where a number differs from an earlier document it says so instead of quoting the older figure.

## 0. How the runs were made (clean state every time)

`scripts/suite-all.mjs` was driven from a clean state: **wipe → `npm run setup` → `node scripts/seed.mjs`
→ `node scripts/seed-kit-demo.mjs` → `node scripts/isolation-fixture.mjs create` → the app is started
AFTER the wipe**, and the runner repeats that per verifier (it also kills anything on its port first).
`JWT_SECRET`, `PAYMENT_WEBHOOK_SECRET`, `DB_QUERY_DIAG` are exported empty, `FIRESTORE_DATABASE_ID`
and its alias are deleted, `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` empty — the same environment
`scripts/dev-emulator.mjs` documents, so no live key can walk back in through `.env`.

Full-suite wall clock: **11:58 → 12:45** (≈47 min, including every wipe/seed/app restart).
The six non-zero exits were then **re-run ALONE from that same clean state** (one verifier per run);
so were the three documented reds.

## 1. The full suite — every verifier individually

`node scripts/suite-all.mjs` — its own total line:
**55 verifier(s), 617 ✅ / 6 ❌ markers, 49 exit 0**; unexpected failures: `verify-pilot-hardening`,
`verify-class-sessions`, `verify-sweep-routes`; known reds: `verify-read-cache`,
`verify-routine-config`, `qa-certificates`.

*count* is the repo's rule: the number the **script itself prints** (its own summary line) where it
prints one — otherwise the runner's ✅ marker count, which is normally **checks + 1** (the script's own
final summary line is itself a ✅). That ±1 is the "summary-line artifact" the P2 table lists.

| # | verifier | count (script's own line) | ✅ / ❌ | exit | s | documented |
|---|---|---|---|---|---|---|
| 1 | `verify-college-gate` | 4 markers | 4 / 0 | 0 | 0 | 4 (P2 §1) — same |
| 2 | `verify-college-fees-logic` | 21 checks | 22 / 0 | 0 | 0 | 21 (TESTING/COLLEGE-STATUS) — same |
| 3 | `verify-college-fees-data` | 11 checks | 12 / 0 | 0 | 1 | 11 (TESTING) — same |
| 4 | `verify-college-results-data` | 8 checks | 9 / 0 | 0 | 0 | 8 (TESTING) — same |
| 5 | `verify-college-results-page` | 106 checks | 1 / 0 | 0 | 0 | 106 (COLLEGE-STATUS) — same |
| 6 | `verify-college-fees-page` | 366 checks | 1 / 0 | 0 | 1 | 366 (COLLEGE-STATUS) — same (P2's 255 is older) |
| 7 | `verify-college-promotion-logic` | 12 checks | 13 / 0 | 0 | 0 | 12 (TESTING) — same |
| 8 | `verify-college-promotion-page` | 18 checks | 19 / 0 | 0 | 0 | 18 (TESTING) — same |
| 9 | `verify-college-grading-logic` | 13 checks | 14 / 0 | 0 | 0 | 13 (TESTING) — same |
| 10 | `verify-college-routes` | 4 markers | 4 / 0 | 0 | 0 | 22 route files / 4 markers (COLLEGE-STATUS) — same |
| 11 | `verify-college-terms` | 9 markers | 9 / 0 | 0 | 0 | 9 (P2 §1) — same |
| 12 | `verify-onboarding-seed` | 87/87 checks | 1 / 0 | 0 | 0 | 87 (TESTING/7f) — same |
| 13 | `verify-database-id` | 17 checks | 19 / 0 | 0 | 0 | 17 (7f) — same (P2's 8 is older) |
| 14 | `verify-nav-scope` | 10 markers | 10 / 0 | 0 | 0 | 9 (P2 §1) + summary — same |
| 15 | `verify-registration-status` | 10 markers | 10 / 0 | 0 | 0 | 10 (P2 §1) — same |
| 16 | `verify-college-permissions` | 8 markers | 8 / 0 | 0 | 0 | 8 (P2 §1) — same |
| 17 | `verify-pilot-hardening` | **FAIL: 183/184** | 183 / 1 | **1** | 56 | 260 (P2 §1) — see §2 |
| 18 | `verify-mode-foundation` | 65 markers | 65 / 0 | 0 | 59 | 65 (P2 §1) — same |
| 19 | `verify-user-secrets` | 10 PASS | 0 / 0 | 0 | 102 | 10 (P2 §1) — same |
| 20 | `verify-onboarding-monitor` | 44 PASS | 1 / 0 | 0 | 65 | 44 (P2 §1) — same |
| 21 | `verify-tenant-isolation` | 107 markers (= 106 checks + summary) | 107 / 0 | 0 | 124 | 106 (COLLEGE-STATUS) — same |
| 22 | `verify-branch-isolation` | 72 PASS | 1 / 0 | 0 | 105 | 72 checks / 73 lines incl. summary — same |
| 23 | `verify-mode-mixing` | 33 checks | 34 / 0 | 0 | 58 | 33 (COLLEGE-STATUS) — same |
| 24 | `verify-college-enrollment` | 40 PASS | 1 / 0 | 0 | 66 | 40 (P2 §1) — same |
| 25 | `verify-course-registrations` | 50 PASS | 1 / 0 | 0 | 78 | 50 (P2 §1) — same |
| 26 | `verify-enroll-paths` | 17 PASS | 1 / 0 | 0 | 58 | 17 (P2 §2.1) — same |
| 27 | `verify-enrollment-fees` | 19 PASS | 1 / 0 | 0 | 58 | 19 (P2 §2.1) — same |
| 28 | `verify-fees-totals` | 24 PASS (15 school + 9 college) | 0 / 0 | 0 | 61 | 24 (COLLEGE-STATUS) — same (P2's 15 is older) |
| 29 | `verify-school-fee-idempotency` | 69/69 | 0 / 0 | 0 | 70 | 69 (TESTING/P2) — same |
| 30 | `verify-fee-reconciliation` | **56 checks** | 1 / 0 | 0 | 65 | 53 (TESTING §P2c) — **differs, +3** |
| 31 | `verify-qr-credentials` | 18 PASS | 1 / 0 | 0 | 62 | 18 (P2 §2.1) — same |
| 32 | `verify-notifications` | 46 PASS | 0 / 0 | 0 | 64 | 46 (P2 §2.1) — same |
| 33 | `verify-grading` | 39 PASS | 0 / 0 | 0 | 67 | 39 (P2 §2.1) — same |
| 34 | `verify-guardian-child` | 25 PASS | 1 / 0 | 0 | 62 | 25 (P2 §2.1) — same |
| 35 | `verify-read-cache` | **0 PASS / 1 FAIL** | 0 / 0 | **1** | 77 | known red 0 pass / 1 fail — same (see §3) |
| 36 | `verify-routine-config` | **30 PASS / 2 FAIL / 1 SKIP** | 0 / 1 | **1** | 92 | 30/2/1skip (COLLEGE-STATUS) — same (see §3) |
| 37 | `verify-cache-scoping` | 15 PASS | 1 / 0 | 0 | 59 | 15 (P2 §2.1) — same |
| 38 | `verify-invalidation` | 8 PASS | 1 / 0 | 0 | 50 | 8 (P2 §2.1) — same |
| 39 | `verify-exams-invalidation` | 9 markers | 9 / 0 | 0 | 51 | 9 (P2 §2.1) — same |
| 40 | `verify-write-freshness` | 4 PASS | 0 / 0 | 0 | 48 | 4 (P2 §2.1) — same |
| 41 | `verify-write-integrity` | **32 PASS · 2 skipped** | 1 / 0 | 0 | 60 | 30 PASS + 3 skip (P2 §2.1) — **differs** |
| 42 | `verify-academic-sessions` | 13 PASS | 1 / 0 | 0 | 56 | 13 (P2 §2.1) — same |
| 43 | `verify-class-sessions` | **56 PASS (alone)** | 0 / 1 | **1** | 117 | 56 (P2 §2.1) — same; in-suite 4 clock-gated fails (§2) |
| 44 | `verify-bulk-import` | 117 PASS | 1 / 0 | 0 | 90 | 117 (P2 §2.1) — same |
| 45 | `verify-admission-intake` | 52 PASS | 1 / 0 | 0 | 64 | — (P2 crashed; no documented count) |
| 46 | `verify-onboarding-type` | 44 passed | 0 / 0 | 0 | 66 | 44 (P2 §2.1) — same |
| 47 | `verify-promotion-rollover` | 50 PASS | 1 / 0 | 0 | 75 | 50 (P2 §2.1) — same |
| 48 | `qa-phase23` | 36 passed / 0 failed | 0 / 0 | 0 | 67 | 36/0 (P2 §1) — same |
| 49 | `qa-certificates` | **40 passed / 1 failed** | 0 / 0 | **1** | 66 | known red 40/1 — same (see §3) |
| 50 | `verify-phase7-e2e` | 160 passed / 0 failed | 0 / 0 | 0 | 127 | 160/0 (P2 §1) — same |
| 51 | `verify-college-results-api` | 77 checks | 1 / 0 | 0 | 70 | 77 (TESTING) — same |
| 52 | `verify-college-promotion-api` | 100 checks | 1 / 0 | 0 | 72 | 100 (TESTING) — same |
| 53 | `verify-college-promotion-lease` | 113 checks | 1 / 0 | 0 | 82 | 113 (TESTING) — same |
| 54 | `verify-sweep-routes` | **43 ✅ / 3 ❌ (46/46 alone)** | 43 / 3 | **1** | 55 | 43 pass / 3 fail order-sensitive — same (see §2) |
| 55 | `verify-college-fees-api` | 112/112 | 1 / 0 | 0 | 100 | 112 (TESTING/COLLEGE-STATUS) — same |

## 2. The six non-zero exits, each re-run ALONE from clean state

Three of them are environment-gated (they went green when run alone) and three are the documented reds;
every one of the six was re-run alone from clean state before it was called anything.

| verifier | in the suite | alone from clean state | verdict |
|---|---|---|---|
| `verify-pilot-hardening` | exit 1, FAIL 183/184 | **exit 0, PASS 260/260 (101 s)** | not a code failure |
| `verify-class-sessions` | exit 1, 4 failures | **exit 0, 56 PASS / 0 FAIL (123 s)** | not a code failure |
| `verify-sweep-routes` | exit 1, 43 ✅ / 3 ❌ | **exit 0, 46 ✅ / 0 ❌ (53 s)** | order/clock-sensitive |
| `verify-read-cache` | exit 1 | exit 1, 20 PASS / 1 FAIL (53 s) | documented red (§3) |
| `verify-routine-config` | exit 1 | exit 1, 30 PASS / 2 FAIL / 1 SKIP (80 s) | documented red (§3) |
| `qa-certificates` | exit 1 | exit 1, 40 passed / 1 failed (42 s) | documented red (§3) |

**`verify-pilot-hardening`** — the one failing check is the live gate, not an assertion:
`❌ [live] no server answered on http://127.0.0.1:3000 — start the app (SMOKE_PORT) and re-run, or pass
--offline`. It is the FIRST server-batch verifier, so it is the first thing to fetch the app the runner
had just restarted; that window's app log shows `✓ Ready in 4.7s`, `✓ Compiled /api/auth/login in
1631ms`, `POST /api/auth/login 200 in 3560ms` and `/login` still compiling (4.9 s) when the fetch gave
up. Its own count is therefore 184 (183 + the fail) instead of 260: the aborted live block never
printed its remaining checks. Run alone, with an app that is warm because the runner already probed it,
it passes **260/260** — the documented count, reproduced.

**`verify-class-sessions`** — all four failures are clock-gated reads of "today's" periods:
`the office board expects the teacher now — Period 5 · 11:45–12:30`, `once started it is no longer
'not started' — missing=true`, `the office board marks the period declined — declinedNow=false`, `a
finished period is no longer flagged missing — missing=true`. The suite reached this verifier at 12:30,
the exact minute Period 5 ends; alone (12:51) the same script prints **56 PASS / 0 FAIL**.

**`verify-sweep-routes`** — the two failing checks are `attendance rows well-formed` under `admin` and
under `teacher` (the same shape problem the class-sessions run above had just left behind); its own
line is `❌ 2 check(s) failed`. This is the order-sensitive verifier the suite documents; alone it is
**46/46, exit 0**.

## 3. Known reds — today's numbers

| red | today | evidence | documented |
|---|---|---|---|
| `verify-read-cache` | exit 1 · in the suite **0 PASS / 1 FAIL**, `FAIL — 51 route(s) still pay full latency on a repeat read` · alone **20 PASS / 1 FAIL**, `31 route(s) …` | the same single assertion both times; 20 of the 51 routes did improve on a fresh app | `0 pass / 1 fail`, 51 routes — identical |
| `verify-routine-config` | exit 1 · **30 PASS / 2 FAIL / 1 SKIP** (both in the suite and alone, 80 s alone) | the two failures are the class-wide read: `the class-wide routine loads — 0 lesson(s) for Class 1`, `the removed lessons are really gone — 0 lesson(s) left`; the skip is `the roster follows a section override` | 30/2/1skip is the closed-gate form (32/3 when its section 7 runs) — identical |
| `qa-certificates` | exit 1 · **40 passed / 1 failed** | `[FAIL] orphaned user sweep — no Firebase credentials — run with --env-file=.env` (credential-gated; the emulator-only rule forbids fixing it) | 40/1 — identical |
| `verify-sweep-routes` | in the suite **43 ✅ / 3 ❌**; alone **46/46** | see §2 | 43/3 order-sensitive — identical |
| the four browser checks | **NOT re-measured today** | `scripts/smoke-all.mjs` headless checks (two `/print/*` pages, two `/teacher/marks`) are outside `suite-all.mjs`; last re-confirmed 2026-10-11 (COLLEGE-STATUS §7, docs/SMOKE-FAILURES.md) | still known-failing, unverified now |

## 4. Production-mode proof — build, `next start`, the probe ×3

**Build:** `npm run build` **exit 0**, `✓ Compiled successfully in 23.8s`, **`✓ Generating static pages
(187/187)`**, then `Linting and checking validity of types` clean. (A second build after the probes:
exit 0, 12.3s, again **187/187**.)

**The server the probe dialled:** `NODE_ENV=production … next start -p 3101` with **`JWT_SECRET` empty**
and `PAYMENT_WEBHOOK_SECRET` unset, started **three separate times**, one per probe run. Each
start's own log shows `✓ Ready in 882 ms / 829 ms / 845 ms` and its own
`[auth] refusing to sign in: JWT_SECRET is not set on this deployment …` +
`[payments] refusing a webhook: PAYMENT_WEBHOOK_SECRET is not set …` — i.e. the fail-closed deployment
shape was really in force.

**The probe:** `PILOT_PROD_URL=http://127.0.0.1:3101 node scripts/verify-pilot-hardening.mjs --offline`

| run | server | result |
|---|---|---|
| 1 | fresh start #1 | **PASS: 188/188 checks passed** |
| 2 | fresh start #2 | **PASS: 188/188 checks passed** |
| 3 | fresh start #3 | **PASS: 188/188 checks passed** |

The three outputs are **byte-identical except one line** — the node PID inside the
`MODULE_TYPELESS_PACKAGE_JSON` warning (`node:7228` / `node:18772` / `node:13324`). Nothing else differs.

**The dev-secret cookie check is deterministic now: 3/3 today.** In all three runs the log carries
`✅ the dev-secret cookie is NOT accepted on a deployment without JWT_SECRET`, together with
`✅ sign-in answers 503 with the actionable JWT_SECRET message` and `✅ /api/health reports the missing
JWT_SECRET on a deployment`.

**The one historical intermittent failure, as recorded.** [proof/p2/REPORT.md](../proof/p2/REPORT.md)
"Step 0" investigated exactly this check and could not reproduce it: a temporary worktree of `a4ec49e`
(P1b) and of `fbf0c70` (P1c) were each `npm run build`-ed and started with `NODE_ENV=production PORT=3101
npx next start` and `.env`'s `JWT_SECRET` line stripped, then the same probe was run in the same
worktree, same host, same port:

| commit | probe | "the dev-secret cookie is NOT accepted" |
|---|---|---|
| `a4ec49e` (P1b) | `PILOT_PROD_URL=http://127.0.0.1:3101 … --offline` | PASS — 177/177 |
| `fbf0c70` (P1c) | same command, same worktree | PASS — 188/188 |

The conditions of the one failure were therefore: **the redirect came back with an ABSOLUTE Location**
(`http://localhost:3101/login?next=…`, i.e. the `localhost` host spelling) instead of the RELATIVE
`location: /login?next=%2Fdashboard` the check requires — recorded via the raw response on the
`fbf0c70` server, which returned `HTTP/1.1 307 Temporary Redirect` + the relative Location. Repeating
with `localhost` and with a raw `curl` on both host spellings gave the relative Location and 188/188
both times, and `src/middleware.ts`, `src/lib/sectors.ts` and `src/lib/pilot-guards.ts` are byte-identical
between `a4ec49e` and `fbf0c70` (`git diff --stat` empty) with the check unedited in both revisions. No
cause was ever found; it has not recurred in this stage (3/3) and did not recur in the P2 worktree runs.

## 5. The D-7-18 role probe on the production build

`PROBE_ORIGIN=http://127.0.0.1:3111 node scripts/verify-role-probe.mjs`, per docs/TESTING.md: the app
is a **production build** (`next start`, `NODE_ENV=production`) against the emulator with a signing
secret so the matrix can sign in, on a **fresh fixture**
(`isolation-fixture create`) and **BEFORE** `verify-college-fees-api` (which resets the fixture's
college spine). The probe's own §F proves it: `.next/BUILD_ID` exists and the served page embeds it —
**build id `jGbpg7-9cNwsAB_nOvRvA`** (the 7f record ran build `bTZhoZ8u8HFwxegmI4rKq`; a rebuild, same 24
checks).

**Result: `✅ ROLE PROBE OK — 24 checks`** — the full matrix, each group green:

| group | result |
|---|---|
| A · authentication (no session, no data) | anonymous print statement → `Statement not found.`, no money (200); anonymous receipt → `Receipt not found.` (200); `/api/college-fees/dues` → **401**; `/api/fees` → **403** |
| B · authorized college access | the tenant's admin gets the screen (200, an app shell); their print statement renders the tenant's OWN charge **৳45,000.00** and its rate footer; their receipt renders THAT payment (**CRCP-** receipt, **৳15,000.00**); ACCOUNTANT and the read-only REGISTRAR both reach the read (200/200) and both print pages; ACCOUNTANT may write (400 from validation, i.e. past the gate), REGISTRAR is **403** |
| C · a tenant with no college half | a SCHOOL tenant's admin: college fee read **403 with zero data**, write **403**, its print page says `available to college tenants only` with no college money, and its receipt page renders no other tenant's payment |
| D · TEACHER / GUARDIAN / STUDENT inside a college-capable tenant | all three **403** on the read; both print pages render the same refusal with the tenant's charge **nowhere in the HTML**; all three **403** on the write (never a 400 — the gate is first); the TEACHER's own school fee read is untouched (200, 2 rows) |
| E · another tenant's student or charge | a foreign student id is the SAME 404 body as a ghost id (no oracle), the reverse direction identical, a missing charge → `Receipt not found.` with no money, another tenant's student → `Statement not found.` |

## 6. Build count and typecheck, reported separately

- **Page count: 187/187** static pages generated (`✓ Generating static pages (187/187)`), build exit 0.
  The 7f record's build also read 187/187 — unchanged.
- **`npm run typecheck` (`tsc --noEmit`): exit 0, no diagnostics** (run after the probes; the earlier
  run in this stage was also exit 0).

## 7. Anything that differs from the documented baselines (one line each)

1. `verify-fee-reconciliation` — **56 checks today vs TESTING.md §P2c's 53** (+3; the script's own
   counter is the source of truth, and nothing in this stage edited it).
2. `verify-write-integrity` — **32 PASS + 2 skipped today vs P2's 30 PASS + 3 skipped** (the same
   script, two more PASS lines, one fewer skip).
3. `verify-pilot-hardening` — **184 checks (183/1) in its suite position vs the documented 260/260**,
   because its live block aborted on the cold server; **260/260 reproduced when run alone** (§2).
4. Four verifiers read *higher* than the older P2 table but identical to the newest records
   (COLLEGE-STATUS / 7f / TESTING): `verify-college-fees-page` **366** (not 255), `verify-database-id`
   **17** (not 8), `verify-fees-totals` **24** (not 15), `verify-college-routes` **4 markers**.
5. `verify-tenant-isolation`'s **107 ✅ markers = the documented 106 checks + its summary line**; the
   same accounting explains 22/21, 12/11, 9/8 etc. in §1. No verifier lost a check.

Nothing else moved: the other 50 verifiers print the count the docs record, and the three documented
reds print exactly what COLLEGE-STATUS records for them.

## 8. What this stage did NOT verify

- **The four browser checks** (headless `smoke-all.mjs`): not run — they are outside `suite-all.mjs`,
  so their known-failing status is carried over from 2026-10-11, not re-measured here.
- **Anything deployed.** Emulator only: no live Firestore was opened (`ALLOW_LIVE_FIRESTORE` unset,
  `FIRESTORE_EMULATOR_HOST` always set for the suites and the role probe), nothing was deployed and
  nothing was pushed to `main`, `origin/main` or `college-support`.
- **The production-probe check's historical cause.** The one intermittent dev-secret-cookie failure is
  recorded in proof/p2 without a cause and did not reproduce in 3/3 runs today (§4).
