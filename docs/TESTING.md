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
npx firebase emulators:start --only firestore
```

`firebase.json` carries:

```json
"emulators": {
  "firestore": { "host": "127.0.0.1", "port": 8080 },
  "singleProjectMode": true
}
```

so Firestore comes up on **127.0.0.1:8080**. Add `,storage` to `--only` and a `"storage"`
emulator block only if you are exercising upload paths.

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
| `FIREBASE_CLIENT_EMAIL` | The emulator needs no credentials. |
| `FIREBASE_PRIVATE_KEY` | The emulator needs no credentials. |
| `SMOKE_ORIGIN` | Pointing it at a deployment makes the HTTP half of a script write to that deployment regardless of the emulator. Must be **unset or loopback**. |
| `BASE` / `BASE_URL` | Same reason as `SMOKE_ORIGIN`. Must be **unset or loopback**. |

In short, the guard requires all of the following:

- `FIRESTORE_EMULATOR_HOST` is set and resolves to a loopback host
  (`localhost`, `127.0.0.0/8`, or `::1`);
- `FIRESTORE_DATABASE_ID` is unset;
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
real credentials or a real project. They terminate immediately, before reading credentials,
building a Firestore/HTTP client, or opening a network connection:

| Script | Behaviour |
|---|---|
| `scripts/wire-env.mjs` | Reads the **production** `service-account.json` and writes its credentials into `.env`. Prints `[SAFETY] This script targets the production environment and must never be run by an agent.` and `process.exit(1)`. |
| `scripts/verify-deployed-rules.mjs` | Hard-codes the real project (`amar-e-school`) and deploys/reads its security rules. Exits immediately. |
| `scripts/migrate-firestore.mjs`, `scripts/verify-firestore-parity.mjs` | Production Firestore cutover/parity tools. **Not present on this branch** (`origin/main` only); if ever ported here they must be hard-blocked the same way. |

Production migration, cutover and parity scripts are **never agent-runnable** — regardless of
environment.

## 6. Why

- The app's database is chosen in `src/lib/firebase.ts` (`getDb()`): `FIRESTORE_DATABASE_ID` set
  ⇒ a named Cloud database; unset ⇒ `(default)`. `FIRESTORE_EMULATOR_HOST` overrides both and
  routes everything to the local emulator.
- Production sets `FIRESTORE_DATABASE_ID=smart-school-db`. Copying that value (or a
  `SMOKE_ORIGIN`/`BASE_URL` pointing at the App Hosting URL) into a local shell is the one
  realistic way a "test" run corrupts live data. The guard exists to make that impossible.
