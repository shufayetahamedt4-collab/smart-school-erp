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
  `node scripts/verify-college-fees-data.mjs` (**9 checks**).

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
  `SMOKE_PORT=3000 node scripts/verify-college-fees-api.mjs` (**86 checks**).

**One ordering rule the college fee verifiers share with the demo-school ones.** A verifier that reads a row an
earlier verifier created *through the app* is safe (the app's own writes clear its memo), but one that reads a row
created **and deleted** by an earlier verifier can still see the deleted row in the memo for up to 150 s. That is
why `verify-tenant-isolation.mjs` now builds its cross-tenant college fee spine **over HTTP** instead of seeding
it raw — raw seeding is invisible to the very read used as the positive control — and why the demo-school
verifiers (`verify-bulk-import.mjs`, `verify-admission-intake.mjs`) must run **before** the onboarding verifiers,
which create and delete `ONB-*` students in the demo school. The same rule as "restart the app after an emulator
wipe".

Also in 7c: `isolation-fixture.mjs` gains a college `ACCOUNTANT` (the one staff role D-7-18 admits as a writer and
the role that may propose but never approve) and a **school-scoped** sweep of the five college fee collections, so
a fee spine built over HTTP (server-generated `cf_…`/`r_…`/`cfc_…` ids) is cleaned as well as the
`zziso-`-prefixed rows.

Already guarded: `smoke-all.mjs` and the full `verify-*.mjs` suite.

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
