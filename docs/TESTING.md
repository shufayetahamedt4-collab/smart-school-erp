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
