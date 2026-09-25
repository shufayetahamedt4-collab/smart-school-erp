# 🚀 Deployment Guide — Firebase App Hosting

> Follow these in order. Every step is reversible. When in doubt, `npm run resume` tells you where you left off.

**Project:** `amar-e-school` (Firestore + Storage already seeded & rules deployed)
**Repo:** `E:\SmartSchoolERP` — git on `main`, clean tree, secrets gitignored.

---

## Phase 1 — Push code to GitHub (you, ~3 min)

1. Go to **https://github.com/new**
2. Name the repo `smart-school-erp` (keep it **Private** — it contains business logic; no secrets are in it, but private is safest)
3. **Do NOT** check "Add a README / .gitignore / license" (we already have them) — create an **empty** repo
4. Copy the two commands GitHub shows under "…or push an existing repository from the command line", then run them in your terminal:

```bash
cd E:/SmartSchoolERP
git remote add origin https://github.com/<YOUR-USERNAME>/smart-school-erp.git
git branch -M main
git push -u origin main
```

> Security check before pushing: `.env`, `service-account.json`, and `*.pem` are gitignored AND guarded by `scripts/save.mjs`. The only committed `.env` file is `.env.example` (empty template).

---

## Phase 2 — Create the App Hosting backend (you, ~3 min)

**Easiest — Console:**
1. Open **https://console.firebase.google.com/project/amar-e-school/apphosting** → **Get started**
2. **Connect GitHub**: click "Connect GitHub" → authorize the **Firebase App Hosting GitHub app** → grant access to the `smart-school-erp` repo
3. Select repo `smart-school-erp`, branch **`main`**
4. Backend name: `smart-school-erp` · Region: `us-central1` (or closest to your users)
5. It will detect the framework (Next.js) and show the build config — leave defaults, **Deploy**

**CLI alternative** (same result, interactive):
```bash
cd E:/SmartSchoolERP
firebase apphosting:backends:create
```
(It prompts to connect GitHub — a browser window opens for OAuth.)

---

## Phase 3 — Set the secrets (~4 min)

App Hosting reads `apphosting.yaml`, which references these **secrets** (stored in Google Cloud Secret Manager). In the console, open your backend → **Settings / Environment variables** → add each:

| Secret name (in yaml) | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | `amar-e-school` |
| `FIREBASE_CLIENT_EMAIL` | from `.env` (service account email) |
| `FIREBASE_PRIVATE_KEY` | from `.env` — the full PEM key (see note) |
| `JWT_SECRET` | from `.env` — your long random string |
| `FIREBASE_STORAGE_BUCKET` | `amar-e-school.firebasestorage.app` — **not a secret**, it is already in `apphosting.yaml` |

> **Bucket name matters.** The Admin SDK assumes `<projectId>.appspot.com` when this is unset, and that
> bucket does **not** exist for this project (verified: only `amar-e-school.firebasestorage.app` exists).
> Without it, uploads write nowhere and every photo/ID-card/attachment URL 404s in production.

**To view the values locally** (run in your terminal — never paste the key into a chat):
```bash
cd E:/SmartSchoolERP
grep FIREBASE_PROJECT_ID .env
grep FIREBASE_CLIENT_EMAIL .env
grep -o 'FIREBASE_PRIVATE_KEY=.*' .env      # long value — copy it fully
grep JWT_SECRET .env
```

> **Private-key format:** paste it exactly as it appears in `.env` (with the literal `\n` escapes inside quotes) — the app un-escapes it (`src/lib/firebase.ts`). Real newlines also work. Do **not** wrap it in extra quotes.

> ⚠️ If you prefer, App Hosting can also use **Application Default Credentials** (no keys needed) when the backend runs on Google Cloud — but the secret approach above is simplest and matches the current setup. Skip `FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` only if you switch to ADC.

---

## Phase 4 — First deploy + get your URL

- Pushing to `main` auto-deploys (GitHub trigger). Or in the console: backend → **Deploy / Rollout**.
- The build runs `npm install && npm run build` (App Hosting auto-detects Next.js). First build ~2–5 min.
- Find your public URL:
  - Console: backend overview shows the **Backend URL**
  - Or: `firebase apphosting:backends:get smart-school-erp`
  - Format: `https://<backend-id>--amar-e-school.<region>.web.app`

---

## Phase 5 — Fix `APP_URL` and redeploy (**important**)

`apphosting.yaml` currently has a placeholder `APP_URL: https://smart-school-erp.web.app`.
**APP_URL is used for QR-code links and file download URLs — it must be the real domain.**

1. Open `apphosting.yaml`, replace the `APP_URL` value with your real backend URL
2. Commit + push (or ask me — I'll do it and run `npm run save`):
```bash
cd E:/SmartSchoolERP
# edit apphosting.yaml → then:
git add apphosting.yaml && git commit -m "deploy: set APP_URL to <real-url>"
git push
```
3. App Hosting rebuilds automatically.

> Later, when you add a custom domain: set `APP_URL` to the custom domain and re-deploy (the app uses it for links + storage URLs).

---

## Phase 6 — Verify (you + me)

- [ ] Open the backend URL → you should land on `/welcome` (marketing + "Install the app")
- [ ] Sign in with demo accounts (Super Admin `admin@smartschool.com` / `Admin@123`, School Admin, Teacher, Guardian)
- [ ] Confirm data loads from Firestore (schools, students, attendance…)
- [ ] On a phone/Chrome: "Install Smart School ERP" banner appears → install → icon on home screen
- [ ] Generate a student QR / ID card → the QR link uses the real URL
- [ ] Upload a student photo → check it's in Storage

---

## Rollback / undo

- **Bad deploy?** Console → backend → **Rollback** to a previous build.
- **Repo mess?** Every `npm run save` commits, so `git log` always shows a clean point.

---

*Generated 2026-08-04. Keep this file updated if the deploy flow changes.*

---

## Alternative — Netlify (test live without git)

Use this when you want the current folder live now, without pushing to GitHub. Netlify deploys the
**local directory** with its own Next.js Runtime: no git, no Cloud Functions API, no Node-version
matching (Netlify builds in its own image), and `netlify.toml` already pins the build.

### 0. Diagnose before you guess — `GET /api/health`

Every data route needs Firestore, so a deployment with no environment fails in the same way
regardless of which screen you try: the API answers a **bare 500 with an empty body**, and the
sign-in form can only report it as *"Request failed"*. `GET /api/health` says what is actually
wrong, and it needs no auth (it reports which variables are *present*, never their values):

```bash
curl -s https://<your-site>.netlify.app/api/health | python -m json.tool
```

```json
{ "ok": false,
  "problems": ["FIREBASE_PROJECT_ID is not set", "…",
               "This server has no Firebase credentials … Set them in the deployment's environment variables (and redeploy)"],
  "env": { "FIREBASE_PROJECT_ID": false, "JWT_SECRET": false, "storageBucket": null },
  "firestore": { "ok": false, "error": "Unable to detect a Project Id in the current environment." } }
```

`503` means something is missing (the `problems` array lists all of it); `200` means every variable is
present *and* a real Firestore read succeeded (`firestore.readMs`). Sign-in itself now returns that same
explanation as JSON instead of an empty 500, so the form shows the reason rather than "Request failed".

Two things worth knowing: adding or changing a variable **only takes effect on the next deploy**, so
set them and redeploy in that order; and `JWT_SECRET` must be one stable value, because changing it
signs every user out.

### 1. Environment variables (this is the part that must not be skipped)

Netlify has no Application Default Credentials, so unlike App Hosting the Firebase credentials are
**mandatory** — without them the Admin SDK cannot reach Firestore at all, every screen is empty, and
sign-in answers `Request failed` (see step 0).

The least error-prone way is to import them straight out of your working `.env` — no copying a
private key by hand, which is the single most common way this step fails (a wrapped or partially
pasted `FIREBASE_PRIVATE_KEY` gives `DECODER routines::unsupported` later):

```bash
npx netlify-cli login
npx netlify-cli link                  # pick the site you deployed to
npx netlify-cli env:import .env       # FIREBASE_* + JWT_SECRET, straight from disk
npx netlify-cli env:set APP_URL "https://<your-site>.netlify.app"   # .env says localhost
npx netlify-cli deploy --build --prod # and a new deploy is what makes them take effect
```

Or set them one at a time:

```bash
npx netlify-cli env:set FIREBASE_PROJECT_ID "amar-e-school"
npx netlify-cli env:set FIREBASE_CLIENT_EMAIL "<from .env>"
npx netlify-cli env:set FIREBASE_PRIVATE_KEY "<from .env — keep the \n escapes>"
npx netlify-cli env:set FIREBASE_STORAGE_BUCKET "amar-e-school.firebasestorage.app"
npx netlify-cli env:set JWT_SECRET "<from .env>"
npx netlify-cli env:set APP_URL "https://<your-site>.netlify.app"
```

`APP_URL` is the public origin used for the guardian invite QR and file URLs — set it to the real
site URL, not localhost. `JWT_SECRET` must be one stable value or every session is invalidated.

### 2. Deploy

```bash
npx netlify-cli login                  # once, opens the browser
npx netlify-cli deploy --build --prod  # builds locally, uploads, prints the live URL
```

The first run offers to create/link a site — let it. Later runs are one command. `netlify-cli`
`deploy --build` runs the same `npm run build`, so the `netlify.toml` `NODE_VERSION` applies.

### 3. Verify it live

```bash
SMOKE_ORIGIN=https://<your-site>.netlify.app node scripts/smoke-all.mjs
```

That sweeps every page and GET API for all four roles against the deployed URL. Then open the site in
one browser tab per role — the harness sees HTTP statuses only, so a client-side crash needs the
browser console (the `/admin/billing` crash found earlier was exactly that kind).

### 4. One URL first, subdomain apps later

The deployed URL is the **hub**: on a bare/unknown host the app is host-agnostic, so signing in as the
Super Admin, school admin, teacher or guardian each lands in that role's own area of the same site.
To give the four apps their own hostnames, add `school.`, `parents.`, `teacher.`, `admin.` as domain
aliases of the same Netlify site and set `APP_DOMAIN` to the registrable domain — sector routing keys
off the first label of the hostname (`src/lib/sectors.ts`), and `requestHost()` already prefers
`x-forwarded-host`, which is what Netlify's proxy sends in front of a serverless function.

### Netlify-specific notes

- Function instances are ephemeral and can run several at once: the in-process read cache
  (`DB_READ_CACHE_MS`/`DB_READ_GRACE_MS`) can serve a stale read after a write. Set both to `0` for
  correctness, or accept the short window.
- The Firestore round trip (~0.5–1.25s, first call after a cold start ~3.6s) is unchanged; a cold
  function adds to that on the first request. Netlify caps a synchronous function at 10s, so the very
  first hit after an idle period (cold function **and** cold Firestore) is the one request that can
  brush that ceiling — warm requests are 25–46ms of server time. If you see a timeout on the first
  click of the day, that is why, and a paid instance-warming setting or a shared read cache is the
  fix rather than an app change.
- The seeded Android shells point at the app origins; if the testing domain changes, update their
  WebView URL and the `ANDROID_*` asset-links env vars.
