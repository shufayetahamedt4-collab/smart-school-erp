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
