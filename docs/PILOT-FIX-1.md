# pilot-fix-1 — closing the small, high-risk pilot blockers

Branch `integration/main-into-college`, parent `824e80d`. Six fixes, each with a
test and a mutation proof, plus one new verifier
(`scripts/verify-pilot-hardening.mjs`). Nothing here touches the school fee
double-record (`src/lib/ledger.ts`, `src/app/api/fees/[id]/pay`,
`src/app/dashboard/fees`) or any college code — that is the next stage.

Owner decisions this stage implements:

- **Pilot schools take fees at the office only.** Guardians/students cannot pay
  online in the pilot.
- **New tenants get an explicit, strong admin password** — never a built-in
  default.

## The six fixes

### 1. `JWT_SECRET` fails closed

`src/lib/pilot-guards.ts` (new, pure, dependency-free, Edge-safe) holds the one
question everything else hangs off:

```ts
isProductionEnv(env)        // NODE_ENV==="production" AND not the local emulator
sessionSecretFatal(env)     // production && no JWT_SECRET
effectiveSessionSecret(env) // the secret, or NULL when this deployment has none
```

- `src/lib/auth.ts` — `secretKey()` returns `null` when there is no secret;
  `signSession` **throws** rather than mint a session it could not verify, and
  `verifySession` returns `null` for every cookie. The built-in development
  secret is gone from this file.
- `src/middleware.ts` — with no key, every cookie is anonymous (the `jwtVerify`
  call is skipped entirely). The built-in secret is gone from this file too.
- `src/app/api/auth/login/route.ts` — refuses with a **503** and the actionable
  message *before* any password work, so no account is verified on a deployment
  that cannot hold a session.
- Read at **call time**, never at module scope, so `next build` needs no secrets
  and the emulator/dev harness keeps the development secret.

### 2. Payment webhook and mock-complete fail closed

- `src/app/api/payments/webhook/[provider]/route.ts` — with no
  `PAYMENT_WEBHOOK_SECRET` on a deployment the route answers **503**; the
  permissive "no secret ⇒ accept anything" branch is now unreachable in
  production (it stays for the emulator harness only).
- `src/app/api/payments/mock-complete/route.ts` — **disabled on a deployment
  regardless of the secret** (403), not merely when the secret is set.

### 3. Guardian/student self-pay is refused server-side

- `src/lib/payments.ts` — `liveGatewayMethods()` (every provider is a stub with
  `live: false`, so this is `[]` today, which makes "online payment is
  unavailable" a fact rather than a policy), `isSelfServiceRole()`, and the one
  shared message `ONLINE_PAYMENT_UNAVAILABLE`.
- `src/app/api/payments/route.ts` — a GUARDIAN or STUDENT session is refused
  **before** any intent is written, unless a live gateway covers the requested
  method. Staff paths (SCHOOL_ADMIN/ACCOUNTANT create and reconcile) are
  untouched.
- `src/app/api/payments/mock-complete/route.ts` — the same refusal for a family.
- `src/app/parent/fees/page.tsx` — read-only: the Pay button, the
  amount/method checkout, the intent + mock-complete calls and the
  "Payment confirmed" banner are gone, replaced by the office-only notice and
  the published school channels. No orphan `PENDING` intents are created.

### 4. The demo-accounts card is gone in production

- `src/lib/demo-accounts.ts` (new) — the seeded demo logins plus
  `demoAccountsFor(env)`, which returns **`[]`** on a deployment.
- `src/app/login/page.tsx` resolves the list **on the server**;
  `src/components/LoginForm.tsx` takes it as a **prop** and no longer names any
  account, so neither the credentials nor the card are in a production bundle.
  Dev/emulator still render it.

### 5. A new tenant's admin password is explicit and 8+ characters

- `src/app/api/onboarding/route.ts` — no `|| "School@123"` fallback; a
  deployment must be given a password of at least 8 characters, decided before
  the transaction so a bad one is a clean 400.
- `src/app/api/schools/route.ts` (create-school) enforces the same strength
  rule on a deployment.
- `src/app/admin/schools/page.tsx` — the hard-coded default is gone, the field
  is a password input with a hint, and the operator cannot advance with fewer
  than 8 characters.

**Reported, not fixed (a later item):** the teacher/guardian/import default
passwords still exist — `scripts/seed.mjs` (demo data, emulator-only) and the
bulk-import path. They are not reachable from the create-school or onboarding
routes, but they are the same class of default and should be handled next.

### 6. Bare-host roles reach `/dashboard`

`src/middleware.ts` — `BRANCH_ADMIN` and `REGISTRAR` added to the `/dashboard`
roles in `HUB_GUARDS` **and** to `HUB_HOME → /dashboard`. Before this they signed
in successfully and were bounced straight back to `/login` on the bare host —
the only host production serves today. School-sector and parents-host routing are
unchanged.

## Mutation proofs — every check is non-vacuous

`node /tmp/…/mutate.mjs` reverses one fix at a time, runs the verifier, then
restores the file and proves the restore is byte-identical (sha256):

| Item | Mutation | Result |
|---|---|---|
| 1 | `sessionSecretFatal` → `return false` | FAIL 66/70 — "production + no secret is fatal" (+3) |
| 2 | webhook guard → `if (false)` | FAIL 69/70 — "the webhook refuses…" |
| 3 | guardian refusal → `if (role === "__never__")` | FAIL 69/70 — "POST /api/payments refuses a self-service role" |
| 4 | `demoAccountsFor` → always return the list | FAIL 69/70 — "a deployment gets NO demo accounts" |
| 5 | restore `\|\| "School@123"` in the wizard | FAIL 68/70 — "no built-in default left" (+1) |
| 6 | remove `REGISTRAR` from `HUB_HOME` | FAIL 69/70 — "HUB_HOME maps REGISTRAR to /dashboard" |

All six restored **byte-identical**.

## Verification

Environment: the local Firestore emulator only (`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`,
`FIREBASE_PROJECT_ID=demo-ss-test`), the app restarted after every emulator wipe,
each verifier run **alone from clean state** (wipe → `seed.mjs` →
`isolation-fixture.mjs create` → app restart), and `verify-college-fees-api`
**last**.

### The new verifier

| Run | Result |
|---|---|
| `node scripts/verify-pilot-hardening.mjs --offline` | **70/70** |
| live half (emulator + app) | **99/99** |
| `PILOT_PROD_URL=… --offline` (production-mode probe) | **75/75** |

The production-mode probe ran against `next start` with `NODE_ENV=production`
and **no `JWT_SECRET`**:

- a cookie signed with the built-in development secret → `/dashboard` is **307 → /login** (rejected);
- sign-in → **503** naming `JWT_SECRET`;
- `/api/health` reports the missing secret;
- an unsigned gateway webhook → **503**; `mock-complete` → **403**.

Positive controls on a second `next start` **with** a secret: a cookie signed with
that secret → **200**; with a *different* secret → **307 → /login**; with the
development fallback → **307 → /login**.

### The full suite — every verifier, individually

Baselines are the last recorded run; **identical** unless marked otherwise.

| Verifier | Last record | This run | Verdict |
|---|---|---|---|
| `verify-college-gate` | 4/0 | 4/0 | identical |
| `verify-college-fees-logic` | 22/0 | 22/0 | identical |
| `verify-college-fees-data` | 12/0 | 12/0 | identical |
| `verify-college-results-data` | 9/0 | 9/0 | identical |
| `verify-college-results-page` | 107/0 | 107/0 | identical |
| `verify-college-fees-page` | 256/0 | 256/0 | identical |
| `verify-college-promotion-logic` | 13/0 | 13/0 | identical |
| `verify-college-promotion-page` | 19/0 | 19/0 | identical |
| `verify-college-grading-logic` | 14/0 | 14/0 | identical |
| `verify-college-routes` | 4/0 | 4/0 | identical |
| `verify-college-terms` | 9/0 | 9/0 | identical |
| `verify-onboarding-seed` | 87/0 | 87/0 | identical |
| `verify-database-id` | 9/0 | 9/0 | identical |
| `verify-nav-scope` | 10/0 | 10/0 | identical |
| `verify-registration-status` | 10/0 | 10/0 | identical |
| `verify-college-permissions` | 8/0 | 8/0 | identical |
| `verify-pilot-hardening` | — (new) | **99/0** | **new** |
| `verify-mode-foundation` | 65/0 | 65/0 | identical |
| `verify-user-secrets` | 10/0 | 10/0 | identical |
| `verify-onboarding-monitor` | 45/0 | 45/0 | identical |
| `verify-tenant-isolation` | 107/0 | 107/0 | identical |
| `verify-branch-isolation` | 73/0 | 73/0 | identical |
| `verify-college-enrollment` | 41/0 | 41/0 | identical |
| `verify-course-registrations` | 51/0 | 51/0 | identical |
| `verify-enroll-paths` | 18/0 | 18/0 | identical |
| `verify-enrollment-fees` | 20/0 | 20/0 | identical |
| `verify-fees-totals` | 15/0 | 15/0 | identical |
| `verify-qr-credentials` | 19/0 | 19/0 | identical |
| `verify-notifications` | 46/0 | 46/0 | identical |
| `verify-grading` | 39/0 | 39/0 | identical |
| `verify-guardian-child` | 26/0 | 26/0 | identical (re-scoped for item 3, below) |
| `verify-read-cache` | 0/1 | 0/1 | **known red, unchanged** |
| `verify-routine-config` | 30/2 (+1 skip) | 30/2 (+1 skip) | **known red, unchanged** |
| `verify-cache-scoping` | 16/0 | 16/0 | identical |
| `verify-invalidation` | 9/0 | 9/0 | identical |
| `verify-exams-invalidation` | 0/0 (crashed run) | 9/0 | **explained** |
| `verify-write-freshness` | 4/0 | 4/0 | identical |
| `verify-write-integrity` | 33/0 (2 skipped) | 33/0 (2 skipped) | identical |
| `verify-academic-sessions` | 14/0 | 14/0 | identical |
| `verify-class-sessions` | 57/0 | 57/0 | identical |
| `verify-bulk-import` | 118/0 | 118/0 | identical |
| `verify-admission-intake` | 53/0 | 53/0 | identical |
| `verify-onboarding-type` | 44/0 | 44/0 | identical |
| `verify-promotion-rollover` | 51/0 | 51/0 | identical |
| `qa-phase23` | 36/0 | 36/0 | identical |
| `qa-certificates` | 39/1 | 39/1 | **known red, unchanged** (credential-gated orphan sweep) |
| `verify-phase7-e2e` | 160/0 | 160/0 | identical |
| `verify-college-results-api` | 78/0 | 78/0 | identical |
| `verify-college-promotion-api` | 101/0 | 101/0 | identical |
| `verify-college-promotion-lease` | 114/0 | 114/0 | identical |
| `verify-sweep-routes` | 46/0 | 46/0 | identical |
| `verify-college-fees-api` (**LAST**) | 112/0 | 112/0 | identical |

Types and build:

| Check | Result |
|---|---|
| `npm run typecheck` | **0 errors** |
| `npm run build` (dev stopped) | **186/186 pages**, 0 errors |

The doc's earlier `185/185` predates **7d** (`77a1b18` added a college page), so
186 is this HEAD's own count — this stage adds no route. Neither
`principal@sunrise.edu`/`guardian1@demo.com` nor `School@123` appears anywhere
in `.next/static` (items 4 and 5, checked as text).

#### Corrections recorded at the P2 close-out (2026-10-13)

Five of the counts in the table above were the **runner's** line count (it counted each script's
summary line) rather than what the script prints. They are corrected here against two clean runs each
(the P1c clean runs and the P2 suite run of 2026-10-13), with the script's own output as the number:

| verifier | printed (two clean runs) | this table had | why |
|---|---|---|---|
| `verify-college-fees-page` | **255 checks** | 256 | the runner counted the "PASSED — 255 checks" summary line |
| `verify-college-routes` | **3** (three numbered rule sections) | 4 | the runner counted the final "✅ COLLEGE ROUTE GUARD OK" line |
| `verify-enroll-paths` | **17** `PASS` lines | 18 | the extra line was its "✅ PASS — …" summary |
| `verify-admission-intake` | **52** `PASS` lines (clean state, kit stocked) | 53 | the extra line was its "✅ PASS — …" summary |
| `verify-enrollment-fees` | **19** `PASS` lines | 20 | the extra line was its "✅ ENROLMENT FEES OK" summary |

Two other numbers in this table are the verifier's state at P1, not today:

- `qa-certificates` prints **40/1** since P1c added its QR-slip check (the one failure is still the
  credential-gated orphan sweep); the 39/1 recorded in this stage's and the earlier documents predates
  that check.
- `verify-pilot-hardening` is **183 offline / 260 live** today (P1b: 172/231/177; P1c added 11 offline
  and 29 live checks). The 70/99/75 row above is the verifier's first version.

The full P2 record — the keyed school-fee payment fix, the whole-suite run and these attributions — is
[docs/PILOT-FIX-2.md](docs/PILOT-FIX-2.md).

### The two deltas, explained

- **`verify-exams-invalidation` (0/0 → 9/0).** The last record's log is a crash
  (`ECONNREFUSED ::1:58497`) — that harness ran it against the wrong port and
  it never asserted anything. This run is the real pass, 9/0.
- **`verify-guardian-child` (unchanged at 26/0, but re-scoped).** It used to
  prove the family sibling link *through* `POST /api/payments`; item 3 closes
  that route to families, so the check now asserts the **refusal** ("pay at the
  school office") and that it created no intent. The sibling link is still proved
  by the fee-list, student-page, certificate and leave-request checks in the same
  verifier, and every other count is unmoved.

While re-scoping it, a latent bug in the verifier's own fixture guard was fixed:
it chose a "stranger" child with `s.familyId !== defaultChild.familyId`, but the
seed sets no `familyId` on anyone, so the comparison was false for every pair and
the script could only start on leftovers from a previous run. It now uses a
`sameFamily()` helper (shared `familyId` **or** the same guardian login).

Two runs also produced counts that were **not** caused by this diff, verified by
re-running each alone from clean state:

- `verify-class-sessions` failed 4 board-expectation checks in one pass and then
  passed **57/0** on its own — a wall-clock flake (the throwaway "period 99" row
  is timed around `now`, and a seeded period 7 14:15–15:00 overlapped it).
- `verify-write-integrity` showed 31/0 with an extra skip (the library section
  needs a book catalogue). With the documented demo-data seeder
  (`scripts/seed-kit-demo.mjs`) it is 33/0 with the same 2 skips as the last
  record. Same for `verify-admission-intake`'s kit checks (53/0 with the shelves
  stocked).

## Baseline reconciliation (2026-10-12)

`docs/TESTING.md` and `docs/COLLEGE-STATUS.md` recorded counts that predated the
last two commits on this branch. They were corrected here so the frozen
baseline stops contradicting the suite. Both deltas are attributed by counting
the `check(` calls each commit added, not by guessing:

| Recorded in | Was | Is | Cause |
|---|---|---|---|
| `TESTING.md`, `COLLEGE-STATUS.md`: `verify-college-fees-api` | 95 | **112** | `824e80d` (7e-pre, "make a college payment impossible to record twice") added exactly **17** `check(` calls — the idempotency replay, ten simultaneous taps with one key, and ten racing keys. 95 + 17 = 112. |
| `TESTING.md`: `verify-college-fees-page` | 214 | **255** | `cac825c` (7d-fix) added **15** `check(` calls, several inside tables, so one call is many runtime checks. |

Both were confirmed against what the verifiers themselves print at `54e9ea4`
("RESULT: 112/112 checks passed"; "255 checks"), and `verify-college-fees-api`
printed **112 in the previous record's run too**, so it is identical, not drifting.

**`verify-routine-config` is not one number — it is calendar-gated, and BOTH of
its forms are valid.** `docs/COLLEGE-STATUS.md` records it as **32 pass / 3 fail**,
and that is correct on a day its section 7 can run. Section 7 (the
roster-follows-a-section-override checks) reads the demo teacher's periods for
**today** and, when the teacher has no scheduled period for the day, emits **one
`skip` instead of its three checks** (`scripts/verify-routine-config.mjs`, the
`!slot` branch at the top of section 7). On such a day the script prints **30
pass / 2 fail / 1 skip** — its own summary line reading "2 failure(s), 1
skipped" — and that is the form BOTH recorded runs landed on: this stage's and
the immediately preceding record are identical to the line (30 `[PASS]`, 2
`[FAIL]`, 1 skip, and the same two unconditional class-wide-read failures, "the
class-wide routine loads" and "the removed lessons are really gone"). The
failures are the same class-wide-read defect in both forms — the seed writes
only section-scoped routines while the route's class-wide read returns the
`sectionId == null` rows — so only the *number* moves, never the cause. It is
recorded here in both forms so that a future run landing on an open-gate day is
not mistaken for a regression. (An earlier draft of this section called 32/3 a
stale accounting line; that was wrong — the gate explains it.)

## What the production deployment must set

`apphosting.yaml` is **not** edited by this stage. What it must have:

1. **`JWT_SECRET`** — create/populate the `JWT_SECRET` secret in **Secret
   Manager** for the App Hosting backend. The variable is already referenced in
   `apphosting.yaml`; if the secret is missing or blank the app now refuses to
   sign in (503) instead of falling back to the repository's development secret.
   Use a long random string (the local `.env` uses 49 characters).
2. **`PAYMENT_WEBHOOK_SECRET`** — **not currently referenced** in
   `apphosting.yaml`. If the gateway webhook is used in production, add the
   variable (a Secret Manager secret) or the webhook answers 503.
3. Unchanged and still required: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
   `FIREBASE_PRIVATE_KEY` (or ADC), `FIRESTORE_DATABASE_ID`,
   `FIREBASE_STORAGE_BUCKET`, `APP_URL`, `ALLOW_LIVE_FIRESTORE=1`.

No secret value is needed for item 5: production takes the admin password from
the operator and refuses a built-in default.

## Not verified

- No production-deploy probe of the app's other screens was run (emulator only,
  by instruction) — the production behaviour proved here is limited to the
  sign-in/session, webhook, mock-complete and health paths against a real
  `next start`.
- `qa-certificates`' one failure is the credential-gated orphan sweep, which the
  emulator-only rule forbids — unchanged and still unverified.
- `verify-read-cache`'s single latency assertion does not hold in dev mode
  (pre-existing).
