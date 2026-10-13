# pilot P1b — sign-in limiting, the honest forgot-password surface, the first owner, the last defaults

Branch `integration/main-into-college`, parent `c5465cc`. Emulator only. `proof/` is untracked and
was deliberately not committed.

## Environment

```
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080   FIREBASE_PROJECT_ID=demo-ss-test
FIRESTORE_DATABASE_ID / FIRESTORE_DB_ID  unset (a named database selects CLOUD)
wipe = fresh emulator (its data is in memory) → setup.mjs → seed-kit-demo.mjs → isolation-fixture.mjs create
app started AFTER the wipe  ·  /login 200  ·  every verifier run ALONE
```

## The new checks and where they stand

| Verifier | Before P1b | Now | Result |
|---|---|---|---|
| `verify-pilot-hardening --offline` | 70/70 | **172/172** | pass |
| `verify-pilot-hardening` (offline + live, emulator + app) | 99/99 | **231/231** | pass |
| `verify-pilot-hardening --offline` + `PILOT_PROD_URL` (production-mode probe) | 75/75 | **177/177** | pass |
| `verify-user-secrets` | 10 | 10 | pass |
| `verify-qr-credentials` | 19 | 19 | pass |
| `verify-guardian-child` | 26 | 26 | pass |
| `verify-write-integrity` | — | 33 pass, 2 skip | pass |
| `verify-fees-totals` | 15 | 15 | pass |
| `verify-enroll-paths` | 17 | 17 | pass |
| `verify-enrollment-fees` | 19 | 19 | pass |
| `verify-admission-intake` (alone) | 52 | 52 | pass |
| `qa-phase23 http://localhost:3000` | 36/0 | 36/0 | pass |
| `verify-onboarding-type` | 44 | 44/0 | pass |
| `verify-onboarding-monitor` | 44 | 44 | pass |
| `verify-bulk-import` | 117 | 117 | pass |
| `verify-college-routes` | 3/0 | 3/0 | pass |
| `verify-nav-scope` | 9 | 9 | pass |
| `tsc --noEmit` | — | — | exit 0 |
| `next build` (dev stopped) | — | — | exit 0 |
| `verify-routine-config` (known red) | 2 fail / 1 skip | 2 fail / 1 skip | unchanged |
| `qa-certificates` (known red) | 1 fail | 39 pass / 1 fail | unchanged |
| `verify-read-cache` (recorded red 1) | — | **0 fail, all routes cached** | **changed — see below** |

`verify-read-cache` was recorded as a known red of 1. On this tree, against the **production build**
(`next start`), it is fully green: every route serves a repeat read from cache. (Against `next dev` it
reports 51 "slow" routes, which is a dev-mode artefact — dev latency is not a cache measurement.) The
recorded red is therefore **not reproduced**; nothing in P1b touches the read cache.

## Item A — the limiter

The rule is one pure, dependency-free module (`src/lib/login-attempts.ts`) and the only Firestore code
(`src/lib/login-attempts-store.ts`). Counters live in `settings` (so all 10 instances share them) and
every increment is a `$guardedUpdate` read-modify-write. The check reads through `$guardedUpdate` too,
because an ordinary read is served from the 30 s/120 s memo.

- identifier limit 8 / 15 min (primary), client-address limit 30 / 15 min (backstop);
- only FAILED attempts count, and a success clears the identifier's counter;
- 429 + `Retry-After` with one generic sentence, identical for a known and an unknown identifier;
- `X-Forwarded-For`: the **last** syntactically valid entry (Google's front end appends the address it
  saw; anything a client sends itself sits to its left). No usable header ⇒ the shared `"unknown"`
  bucket, never an exemption;
- a store failure **fails open** and logs `[auth] …`. Observed live, when the emulator went away
  mid-stage: `[auth] the sign-in attempt store could not be read — allowing this attempt`, and the
  sign-in then failed on its own merits rather than on the limiter.

## Item B — the dead end, made honest

An administrator can really reset a **staff** and a **teacher** password (Staff & Roles → Edit → Reset
password → `PATCH /api/staff`; TEACHER is in `STAFF_ROLES`). A **guardian has no school-side reset at
all** — `/api/guardians` is GET/POST only and there is no page for it. The sign-in form therefore
stopped announcing "Forgot password?" everywhere:

| App | What it says now |
|---|---|
| School / Teacher | `Forgot your password? Ask your school administrator to reset it.` |
| Parents | `Forgot your password? Use the QR code on your child's ID card — your school can print a new one.` |
| Platform Console | nothing (no school administrator exists there) |

The API branch is kept, but with no email provider configured a deployment now sends **nothing** and
stores **no** `pw_reset_*` record (previously it minted a code, threw it away, and left the row).

## Item C — the first owner

`scripts/bootstrap-super-admin.mjs` refuses without `ALLOW_LIVE_FIRESTORE=1`, refuses `--password` on
the command line, refuses a weak password by the app's own `adminPasswordProblem`, refuses a malformed
`--email`, refuses when any `SUPER_ADMIN` exists, and refuses a LIVE target that was not confirmed by
naming the project. It prints the email and the user id and nothing else.

**Guarded emulator proof: 15/15** (`.freebuff/…`, driven by a temp script): the four refusals, then —
with the seed's own owner moved aside — one real create on the emulator (`SUPER_ADMIN created.` +
`email:` + `user id: u_…`, the password nowhere in the output, bcrypt cost 10, exactly one owner), a
second run refused, then the seed's owner put back and compared field for field. No live database was
contacted at any point.

## Item D — the last defaults (guardians REPORT-ONLY)

- `POST /api/teachers` requires a password (≥ 8, the app's own rule) and never falls back to a literal;
  the page starts empty and cannot submit without one.
- `POST /api/import/teachers` creates each account with `randomBytes(24)` and returns **no** password —
  it returns `passwordNotice`, telling the school to set each one from Staff & Roles.
- Guardian paths are untouched: `POST /api/guardians` still defaults to `Guardian@123`,
  `src/lib/enroll.ts` still exports `DEFAULT_GUARDIAN_PASSWORD`, and the students import still reports
  `defaultGuardianPassword`. Those three are pinned by "REPORT-ONLY" checks so a later stage cannot
  change them by accident.

## Browser proof (one Chrome over CDP, `proof/p1b/`)

Each PNG was captured with the page's own DOM text read alongside it:

| PNG | DOM text that matters |
|---|---|
| `01-school-login-replaces-the-forgot-link.png` | `stillOffersForgotPassword: false` · `Forgot your password? Ask your school administrator to reset it.` |
| `02-parents-app-points-at-the-qr-code.png` | `stillOffersForgotPassword: false` · `Forgot your password? Use the QR code on your child's ID card — your school can print a new one.` |
| `03-the-8th-wrong-password-shows-the-lockout.png` | after 7 API failures (all 401) the **8th, through the form**: `Too many failed attempts. Please wait a few minutes and then try again.` · `session: absent` |
| `04-a-correct-password-is-refused-until-the-window-ends.png` | the **correct** password, through the same form: the same sentence · `session: absent` · still on `/login` |

9/9 browser checks. The limiter rows were then cleared, because the window (correctly) outlived the
proof and would otherwise have locked the demo admin for the later verifiers.

## Mutation proof — every new check fails on the previous code

Each mutation reverts one surface (the file at HEAD, or a targeted edit of a new module), runs the
offline verifier, restores the file and proves the restore is byte-identical (sha256). 40 mutations:
**102/102 new checks** fail under at least one of them, and all 12 touched files came back at their
recorded sha256. One live mutation (`live-all-reverted`, all nine surfaces at once) fails **all 16**
`p1b-*-live` checks.

Two checks were **strengthened** after the battery caught them passing vacuously:
`before(text, a, b)` now requires both anchors to exist (`lineOf` returns −1 for a missing anchor, so
`-1 < n` used to pass), and the two store pins now inspect the function body instead of the whole file
(the doc comment above `readCounter` names `$guardedUpdate`, and `keysFor` also mentions the identifier
kind, so prose alone satisfied them).

The battery also caught **one bug in the battery**: two patch specs for the same file backed it up
twice, so the second "restore" wrote the mutation back and reported byte-identical. It now backs up
once per file, and the run aborts on any sha mismatch.
