# ENVIRONMENTS-AND-SECRETS.md — every variable, where it lives, how to rotate it

**Type:** operations reference. **No secret value appears in this file, and none should ever be
added to it.**

**Date written:** 2026-10-09. **Branch:** `college-support`. **HEAD when written:** `dc0e970`.

**Sources read to build this list:** `apphosting.yaml`, `netlify.toml`, `.env.example`,
`scripts/deploy-guide.md`, and every `process.env.*` reference under `src/`. Only variable **names**
and non-secret configuration are reproduced; those non-secret values are already committed in
`apphosting.yaml` and are marked as such.

---

## 1. Where each variable is stored

| Store | What lives there | Who can change it |
|-------|------------------|-------------------|
| **Google Cloud Secret Manager** (project `amar-e-school`) | `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `JWT_SECRET` — referenced as `secret:` from `apphosting.yaml` | Console → Secret Manager. New version = rotation. |
| **`apphosting.yaml`** (committed) | Non-secret values: `FIRESTORE_DATABASE_ID`, `FIREBASE_STORAGE_BUCKET`, `APP_URL`, `ALLOW_LIVE_FIRESTORE` | A code change + deploy. |
| **Netlify site environment** (`amar-e-school-demo`) | The six Firebase/app vars, set per `netlify.toml` | `npx netlify-cli env:set …`, then a new deploy. |
| **Local `.env`** (git-ignored) | Real values for local dev | You, on disk. Never committed. |
| **GitHub / git** | `.env.example` only — an **empty template** | Committed on purpose. |

Verified in the repo: `.env` and every `.env.*` except `.env.example` are ignored
(`.gitignore:13-16`); `service-account.json`, `*-service-account*.json` and `*.pem` are ignored
(`.gitignore:18-21`). `git ls-files` shows **no** tracked `.env`, `service-account.json` or `.pem`.

---

## 2. Must never change

| Variable | Consequence of changing it |
|----------|----------------------------|
| **`JWT_SECRET`** | It signs every session. **Changing it signs out every user on every host at once.** It must be one stable value everywhere the app runs (App Hosting, Netlify, local) — see `scripts/deploy-guide.md` and `netlify.toml`. Rotate only deliberately, as an incident response, and expect every user to log in again. |
| **`FIRESTORE_DATABASE_ID`** | Points at the live database. Changing it in production repoints the whole app at a different database. Only ever changed as a planned cutover/rollback. |
| **`FIREBASE_*` credentials** | The Admin SDK cannot reach Firestore without them; every data route then returns an empty 500. If the service-account key is revoked, all hosts must be updated together. |

`FIREBASE_STORAGE_BUCKET` is **not** a secret (the bucket name is already in the web-app config),
but it matters: if it is wrong or unset the Admin SDK assumes `<projectId>.appspot.com`, which does
not exist for this project, and every photo / ID-card / attachment URL 404s.

---

## 3. Full inventory

### 3a. Required to reach Firestore (secret)

| Name | Purpose | App Hosting | Netlify | Local `.env` |
|------|---------|-------------|---------|--------------|
| `FIREBASE_PROJECT_ID` | Project id | Secret Manager | Site env | yes |
| `FIREBASE_CLIENT_EMAIL` | Service-account email | Secret Manager | Site env | yes |
| `FIREBASE_PRIVATE_KEY` | Service-account private key (keep the `\n` escapes) | Secret Manager | Site env | yes |
| `JWT_SECRET` | Signs session cookies | Secret Manager | Site env | yes |

On App Hosting, Application Default Credentials would also cover the three Firebase vars — but the
current setup uses the explicit secrets, so treat them as required.

### 3b. App configuration (non-secret; committed in `apphosting.yaml`)

| Name | Value in `apphosting.yaml` | Notes |
|------|---------------------------|-------|
| `FIRESTORE_DATABASE_ID` | `smart-school-db` | Unset → `(default)` = the rollback database (`src/lib/firebase.ts:59-68`). |
| `FIREBASE_STORAGE_BUCKET` | `amar-e-school.firebasestorage.app` | Wrong value 404s every upload/download URL. |
| `APP_URL` | `https://smart-school-erp-1--amar-e-school.asia-southeast1.hosted.app` | Public origin for QR links and storage URLs. **Must match the real host**; `scripts/deploy-guide.md` still describes the older placeholder step (its Phase 5 is stale — the real URL is now committed). |
| `ALLOW_LIVE_FIRESTORE` | `"1"` | The fail-closed guard: without an emulator host **and** without `ALLOW_LIVE_FIRESTORE=1`, `getDb()` refuses to open a live database (`src/lib/firebase.ts:45-56`). |

### 3c. Optional / feature variables (may be unset)

| Name | Purpose |
|------|---------|
| `APP_DOMAIN` / `NEXT_PUBLIC_APP_DOMAIN` | Registrable domain for sector subdomains (`src/lib/sectors.ts`, `src/middleware.ts`). Unset in local dev. |
| `EMAIL_PROVIDER`, `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_API_URL`, `RESEND_API_KEY` | Password-reset OTP delivery. With no key, the app falls back to a dev-console adapter that **refuses to print codes in production**. |
| `PAYMENT_WEBHOOK_SECRET` | Verifies payment webhooks. |
| `PLAY_STORE_URL`, `ANDROID_APP_PACKAGE`, `ANDROID_TEACHER_APP_PACKAGE`, `ANDROID_CERT_SHA256`, `ANDROID_TEACHER_CERT_SHA256` | Android App Links / Play listing. See `.env.example`. |
| `DB_READ_CACHE_MS`, `DB_READ_GRACE_MS`, `STATS_CACHE_SERVE_MS` | Read-cache tuning. On serverless hosts with several instances these can serve a stale read; `scripts/deploy-guide.md` suggests `0` for correctness there. |
| `PORT` | Local dev port (read by Next, not by app code). |
| `NODE_ENV` | Standard. Drives the production-only seam guard in `src/lib/college-promotion-seam.ts`. |

### 3d. Diagnostics / platform-provided (never set by hand in production)

| Name | Notes |
|------|-------|
| `DB_QUERY_DIAG`, `DB_QUERY_DIAG_HIGH_CARDINALITY` | Dev-only query diagnostics. |
| `FIRESTORE_EMULATOR_HOST` | Set **only** for the local emulator; its presence is what lets the app skip the live-database guard. |
| `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_CLOUD_PROJECT`, `K_SERVICE`, `FUNCTION_TARGET`, `GAE_SERVICE` | Platform/ADC detection (`src/lib/firebase.ts` `adcAvailable`). Do not set. |
| `COMMIT_REF`, `GIT_COMMIT`, `NETLIFY` | Build metadata injected by the host. Do not set. |

### 3e. Local dev-only, in scripts (not app config)

`SMOKE_ORIGIN`, `SMOKE_PORT`, `SMOKE_STUDENT_ID`, `SMOKE_EXAM_ID` (in `scripts/smoke-all.mjs`) are
local testing knobs, not deployment variables. `FIRESTORE_EMULATOR_HOST` and
`FIREBASE_PROJECT_ID=demo-ss-test` are printed by the emulator runs.

---

## 4. Key-rotation checklist

Applies to `FIREBASE_PRIVATE_KEY` / `FIREBASE_CLIENT_EMAIL` (a service-account key) and to
`JWT_SECRET` (session signing). **Do these in order, and update every host before the old value is
disabled.**

1. **Decide and announce.** `JWT_SECRET` rotation logs out everyone — do it in a quiet window.
2. **Create the new value** first; keep the old one valid.
   - Service account: Cloud Console → IAM & Admin → Service Accounts → `firebase-adminsdk-…` →
     Keys → **Add key**. Download the JSON. **Never paste it into chat or a file in the repo.**
   - `JWT_SECRET`: generate a new long random string.
3. **Update the host configs**, all of them:
   - **App Hosting:** Secret Manager (or backend → Settings → Environment variables). Adding a new
     **version** of the same secret name is the clean way.
   - **Netlify:** `npx netlify-cli env:set NAME "<value>"` — from a local file or the terminal, never
     a chat. Remember: **a variable change only takes effect on the next deploy.**
   - **Local `.env`:** update it so dev matches.
4. **Redeploy** every host so the new value is live. Confirm via `GET /api/health` on each host
   (it reports which variables are *present*, never their value).
5. **Smoke-test** each app: sign in on `admin.`, `school.`, `teacher.`, `parents.` hosts (or the hub),
   load a data screen, upload one file.
6. **Disable/delete the old value** only after every host is confirmed on the new one.
7. **Record** the rotation date and which hosts were updated, in your operations log.
8. **Never** commit a value, echo it in a terminal you share, or store it in `apphosting.yaml`.

Rotation for the *non-secret* config (`APP_URL`, `FIRESTORE_DATABASE_ID`, `FIREBASE_STORAGE_BUCKET`)
is a `apphosting.yaml` edit + redeploy, and must respect the "never change" notes in §2.

---

## 5. Before every deploy

- [ ] **`npm run typecheck`** exits 0.
- [ ] **`npm run build`** succeeds and the static-page count matches the expected number
      (currently **164**), so a route was not silently dropped.
- [ ] **The verifier suite passes** on the emulator (see `docs/COLLEGE-STATUS.md` §Safety for the
      current counts).
- [ ] **`git status` is clean** of stray files, and **no `.env`, `service-account.json`, or `*.pem`
      is staged or committed.**
- [ ] **No secret value is in a changed file.** Quick check: `git diff --cached | grep -iE "BEGIN .*PRIVATE KEY|JWT_SECRET="`.
- [ ] **`APP_URL`** matches the host actually being deployed to (QR links and file URLs depend on it).
- [ ] **Variable changes deploy with the change** (App Hosting and Netlify both need a redeploy for a
      new/changed variable to take effect).
- [ ] **`JWT_SECRET` is unchanged** unless this deploy is a deliberate rotation.
- [ ] **`FIREBASE_STORAGE_BUCKET` is set** to `amar-e-school.firebasestorage.app` (else uploads 404).
- [ ] **Post-deploy smoke**: open `GET /api/health` and confirm `ok: true`, then sign in on a sector
      host and load a data screen.

---

## 6. Secret hygiene — findings from a read-only scan

Command run (tracked files):

```
git grep -nIE "BEGIN (RSA |EC )?PRIVATE KEY" -- . ':!node_modules'
```

Result: **no real key.** The only matches are documentation/templates that literally contain the
placeholder text `-----BEGIN PRIVATE KEY-----\n...`:

- `.env.example:9` — template comment.
- `README.md:58` — table example.
- `scripts/setup.mjs:55` — writes a placeholder into a generated `.env`.
- `scripts/resume.mjs:119` — checks a value *contains* the marker to detect a real key (logic, not a
  value).

A search for `client_email` / `iam.gserviceaccount.com` / `AIza…` API keys found only **placeholder**
emails (`firebase-adminsdk-xxxxx@smart-school-erp.iam.gserviceaccount.com`,
`…@your-project.iam.gserviceaccount.com`) in `README.md`, `scripts/setup.mjs`.

The three untracked docs (`AGENTS.md`, `docs/PHASE1-DECISION-WORKSHEET.md`,
`docs/SMOKE-FAILURES.md`) contain **no** secret-looking value.

**Report:** no real-looking secret value was found in any tracked or untracked file. A git-ignored
`.env` (holding live values) and possibly a git-ignored `service-account.json` exist on the local
disk — that is expected; they are ignored and were not read.

---

## 7. Things this repo could not verify

- Whether Secret Manager currently holds all four secrets, and their versions — **to be confirmed in
  the console.**
- Whether the Netlify site still has all six variables set, and its current site name — **console.**
- Whether any *extra* variables exist on a host that are not in the repo (a common drift source) —
  **console.**
- Whether `ALLOW_LIVE_FIRESTORE=1` is set on every production host (App Hosting sets it; Netlify's
  does not run app code the same way) — **console.**
- The real values in the local `.env` — **not read, by design.**
