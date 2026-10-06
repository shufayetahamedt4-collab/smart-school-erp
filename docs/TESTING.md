# Testing safely — the emulator-only rule

The `scripts/verify-*.mjs` and `scripts/smoke-all.mjs` scripts **write real Firestore
documents** (fixtures, and cleanup/restore of existing rows). They must **never** run against a
Cloud database — not this project's and not any other tenant's.

**Rule: never run these scripts without the emulator.**

Every one of them calls `requireEmulator()` from `scripts/lib/guard.mjs` as its first statement.
The guard fails closed (`process.exit(1)`) unless the environment is demonstrably a **local
Firestore emulator**. There is no bypass flag.

`scripts/verify-deployed-rules.mjs` is **not** guarded — it hard-codes the real project
(`amar-e-school`) and deploys/reads its security rules. It now exits immediately and must never
be run by an agent or in an automated flow.

---

## 1. Prerequisites

- **Java (JRE 11+)** — the Firestore emulator requires it. Check with `java -version`.
- **Node on `PATH`** — the Firebase CLI shim needs `node` (this machine ships a portable Node
  only, so add its folder to `PATH` for the session, or invoke the CLI through it).
- The Firebase CLI is already in `node_modules` (`node_modules/.bin/firebase`).

## 2. Start the emulator

```bash
# from the repo root
npx firebase emulators:start --only firestore
```

`firebase.json` now carries:

```json
"emulators": {
  "firestore": { "host": "127.0.0.1", "port": 8080 },
  "singleProjectMode": true
}
```

so Firestore comes up on **127.0.0.1:8080**. Add `,storage` to `--only` and a `"storage"`
emulator block only if you are exercising upload paths.

## 3. Environment variables

Set these in the shell that runs the app and the scripts:

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
| `SMOKE_ORIGIN` | Pointing it at a deployment makes the HTTP half of a script write to that deployment regardless of the emulator. |
| `BASE` / `BASE_URL` | Same reason as `SMOKE_ORIGIN`. |

The guard rejects any of the last three that resolves to a non-loopback host, and rejects a
non-loopback `FIRESTORE_EMULATOR_HOST` even when `FIREBASE_PROJECT_ID` is set.

Seed the emulator once it is up:

```bash
npm run setup     # scripts/seed.mjs -> the guard permits it (emulator-only run)
```

Then start the app with the same variables exported and run the scripts normally.

## 4. Why

- The app's database is chosen in `src/lib/firebase.ts` (`getDb()`): `FIRESTORE_DATABASE_ID` set
  ⇒ a named Cloud database; unset ⇒ `(default)`. `FIRESTORE_EMULATOR_HOST` overrides both and
  routes everything to the local emulator.
- Production sets `FIRESTORE_DATABASE_ID=smart-school-db`. Copying that value (or a
  `SMOKE_ORIGIN` pointing at the App Hosting URL) into a local shell is the one realistic way a
  "test" run corrupts live data. The guard exists to make that impossible.
