# 🗂️ Project Progress & Session Resume

> **Read me first** in any new session working on this project.
> Keep this file updated at the end of each working session so the next one resumes instantly.

**Project:** Smart School ERP & Parent Communication System (Multi-Tenant SaaS)
**Location:** `E:\SmartSchoolERP`
**Last updated:** 2026-08-03

---

## ✅ Current Status

**Firebase migration COMPLETE and VERIFIED.** The app no longer uses Prisma/PostgreSQL — it runs entirely on **Cloud Firestore + Cloud Storage**, and is ready for public deployment via **Firebase App Hosting**.

### What was done this session (Firebase migration)

1. **New data layer** — `src/lib/db.ts` is now a **Prisma-compatible API backed by Firestore** (`findMany`, `findUnique`, `findFirst`, `count`, `create`, `createMany`, `update`, `updateMany`, `upsert`, `delete`, `deleteMany`, `$transaction`, `include`/`select`/`orderBy`/`take`). All 30 API routes + 2 print pages + auth keep their original business logic — only the storage engine changed.
2. **Firebase init** — `src/lib/firebase.ts` (Admin SDK; supports `FIREBASE_PROJECT_ID`/`FIREBASE_CLIENT_EMAIL`/`FIREBASE_PRIVATE_KEY` env vars **or** `GOOGLE_APPLICATION_CREDENTIALS` service-account JSON).
3. **Auth unchanged** — JWT (jose) sessions in the `ss_token` cookie, role guards in `src/middleware.ts`, `audit()` now writes to the `auditLogs` Firestore collection.
4. **Uploads → Cloud Storage** — `POST /api/uploads` now writes student photos / attachments to Firebase Storage instead of local disk (App Hosting filesystems are ephemeral).
5. **Seed rewritten** — `scripts/seed.mjs` seeds Firestore with the same demo data (1 school, 5 classes × 2 sections, 7 subjects, 4 teachers, 14 students, exam+marks, 8 days attendance, notices, routine, messages, 56 fees). Deterministic IDs → **idempotent**.
6. **Removed Postgres** — deleted `prisma/`, `.pgdata/`, `scripts/db.mjs`; package.json now uses `firebase-admin` and dropped `@prisma/client`, `prisma`, `@embedded-postgres/*`. Password hashing stays on `bcryptjs` (pure JS — no native build step on App Hosting).
7. **Config files added** — `firestore.rules`, `storage.rules`, `firebase.json`, `.firebaserc`, `apphosting.yaml`, updated `.env` / `.env.example` / `.gitignore`.
8. **Review-hardening fixes** (from code review): `idFor` now only trusts string `where.id` (avoids garbage ids for `{ id: { in } }`), nested `update` for `oneInverse` relations resolves the child via `where(via, ==, parentId)` instead of silently no-oping, and `setup.mjs`'s `.env` parser now handles multi-line double-quoted values (e.g. a raw PEM key).
9. **Verified green:**
   - ✅ `npm run typecheck` → **0 errors**
   - ✅ `npm run build` → **success** (all routes compiled, middleware included)
   - ✅ `setup.mjs` `.env` parser smoke-tested (single-line, quoted, and multi-line PEM values)
   - ⚠️ Known limitation: `$transaction` callback form runs ops sequentially without rollback (Firestore Admin SDK can't match Prisma's DB transactions); the array form uses an atomic `WriteBatch`. No current route depends on rollback semantics.

### Remaining before going live

- [x] **Firebase project created** — `amar-e-school` (in `.firebaserc`); service account downloaded; `.env` wired. (done 2026-08-03)
- [x] **Deploy rules**: `firebase deploy --only firestore:rules,storage` — done (2026-08-03), rules live on `amar-e-school`.
- [x] **Seed run & verified** against `amar-e-school` — all collections at expected counts, all 10 phases done. Verify anytime: `node scripts/check-seed.mjs`. (done 2026-08-03)
- [ ] **Click-through UI test** on real Firestore (attendance, marks entry, PDF/Excel exports, ID-card & report-card printing, QR login).
- [ ] **Git init + commit**, then deploy via **Firebase App Hosting** (connect GitHub repo, set env vars, deploy).  ← NEXT
- [ ] Later / optional: Phase 5 features (AI remarks & summaries, SMS/push/email, bKash/Nagad/card payments); OpenAPI docs; "remember me".

---

## 🚀 Demo Accounts

| Role | Email | Password |
|---|---|---|
| Super Admin | `admin@smartschool.com` | `Admin@123` |
| School Admin | `principal@sunrise.edu` | `School@123` |
| Teacher | `teacher@sunrise.edu` | `Teacher@123` |
| Guardian | `guardian1@demo.com` | `Guardian@123` |

QR login: `/qr/<token>` + PIN or guardian phone (token on student detail page).

---

## 🖥️ How to Start the App

```bash
cd E:\SmartSchoolERP
# 1. make sure .env has Firebase credentials (see README)
# 2. optional: re-seed Firestore demo data
npm run setup
# 3. run
npm run dev          # dev server  → http://localhost:3000
# or production:
npm run build && npm run start
```

Open **http://localhost:3000** → redirects to login (or dashboard if a session exists).

---

## 🧪 Validation Commands

```bash
npm run typecheck    # tsc --noEmit (0 errors = good)
npm run build        # production build
npm run setup        # idempotent Firestore seed
npm run seed         # same as setup (alias)
```

---

## 🧩 Architecture Notes (for quick orientation)

- **Stack:** Next.js 15 App Router + TypeScript + Firebase Admin SDK (Firestore + Cloud Storage) + Tailwind 4 + Recharts + qrcode + jspdf/html2canvas + xlsx.
- **Roles:** SUPER_ADMIN → `/admin` · SCHOOL_ADMIN → `/dashboard` · TEACHER → `/teacher` · GUARDIAN → `/parent`.
- **Auth:** JWT (jose) in httpOnly cookie `ss_token`; role guards in `src/middleware.ts`. (Kept — not Firebase Auth.)
- **Data layer:** `src/lib/db.ts` = Prisma-shaped API over Firestore. Collections: `schools`, `users`, `teachers`, `students`, `classes`, `sections`, `subjects`, `assignments`, `routines`, `attendance`, `remarks`, `homeworks`, `submissions`, `exams`, `marks`, `notices`, `feeSettings`, `fees`, `payments`, `messages`, `auditLogs`, `settings`. Tenant isolation via `schoolId` on every record.
- **IDs:** deterministic where a natural key exists (user → `u_<sha1(email)>`, attendance → `a_<studentId>_<date>`, marks → `m_<examId>_<studentId>_<subjectId>`, feeSettings → `fs_<schoolId>`), random `r_<hex>` elsewhere → seeds/upserts are idempotent.
- **Query strategy:** one equality filter pushed to Firestore, the rest filtered in memory → no composite indexes needed.
- **Uploads:** Cloud Storage bucket `gs://<project>.appspot.com`, folder `uploads/` — public read via `downloadUrl`, writes via Admin SDK.
- **Key dirs:** `src/app/api/*` (REST), `src/app/*/` (role consoles), `src/lib/` (auth, firebase, db, grades, qr, http, utils), `scripts/` (seed.mjs, setup.mjs).

---

## 🔁 This Session (2026-08-03)

- Full Prisma → Firestore migration as described above.
- Typecheck & production build green after the migration.
- Deploy path chosen: **Firebase App Hosting** (backend defined in `apphosting.yaml`; supports Next.js SSR out of the box).
- Next session: create the Firebase project + service account, wire `.env`, deploy rules, seed, click-through test, then App Hosting deploy.

---

## ⏱️ Moment-to-moment checkpoints (NEW convention — from 2026-08-03)

So interruptions (power cuts etc.) never lose progress again:

- **`scripts/progress.mjs`** — `checkpoint(step, detail)` appends a timestamped line to **`scripts/session-progress.log`**.
- **`scripts/seed.mjs`** now calls `checkpoint()` after **every phase** (13 checkpoints), so an interrupted seed leaves an exact trail.
- **`scripts/check-seed.mjs`** — the "where did we leave off?" tool: reads Firestore and reports per-collection counts + phase status. Run `node scripts/check-seed.mjs` after any interruption, before re-running the seed.
- **`scripts/load-env.mjs`** — shared `.env` loader (single-line + multi-line quoted values incl. PEM keys).

**Rule for future sessions:** after every meaningful step, either the tooling above logs it, or append one line to `PROGRESS.md`. When resuming, run `node scripts/check-seed.mjs` (for seed/data state) and read the last lines of `scripts/session-progress.log`.

---

## 🔁 Session resume — 2026-08-03 (post power-outage)

**Where we left off:** the previous session finished the Firebase migration, created project `amar-e-school`, downloaded the service account, and ran the seed — the Firestore data was already complete. The blocker at the moment of the power cut was a **corrupted `.env` private key** (double-escaped `\n` → `\\n` after running `wire-env.mjs` twice), which made every Admin SDK call fail with `Failed to parse private key`.

**What this session did:**
1. Diagnosed the key corruption byte-by-byte and **regenerated `.env`** from `service-account.json` (run `node scripts/wire-env.mjs` once — do NOT run it twice).
2. Built the checkpoint tooling above; added 13 phase checkpoints to `seed.mjs`.
3. Ran `npm run setup` → **SEED COMPLETE**, all checkpoints logged (see `scripts/session-progress.log`).
4. Ran `node scripts/check-seed.mjs` → all 22 collections match expected counts (homeworks 4 and routines 20 are *by design* — ICT/Social Studies/Religion have no teacher in the seed).

**Next steps (in order):**
1. Deploy rules: `firebase deploy --only firestore:rules,storage` (CLI is logged in as himelfaysalahmed103@gmail.com).
2. `git init` + first commit (project not yet a git repo) — needed for Firebase App Hosting.
3. Click-through UI test on real Firestore: `npm run dev` → http://localhost:3000 (login with the demo accounts below).
4. Connect the GitHub repo to Firebase App Hosting (`apphosting.yaml` already present) and deploy.

> ⚠️ **Never run `node scripts/wire-env.mjs` twice** — it re-escapes an already-escaped key. If `.env` credentials break, re-download the service account or re-wire once and verify with `node scripts/check-seed.mjs`.

---

## 🔁 Session — 2026-08-04 (PWA + go-live prep)

**Goal (from owner):** run the SaaS on my own domain; schools can **download/install the app** from the site; every user's data is collected centrally and managed by Super Admin (owner). Chosen path: installable **PWA** + Firebase App Hosting free URL first, custom domain later. School onboarding stays **super-admin-managed** (panel already has New School flow).

**Done this session:**
1. **PWA icons** — `scripts/generate-icons.mjs` (sharp) → `public/icons/icon-192.png`, `icon-512.png`, `maskable-512.png`, `apple-touch-icon.png`.
2. **Manifest** — `public/manifest.json` (standalone display, theme #4f46e5, maskable icon). Wired via `metadata.manifest` + `appleWebApp` + icons in `src/app/layout.tsx`; `viewport` export adds theme-color + viewport-fit.
3. **Service worker** — `public/sw.js`: network-first navigations with last-page/offline fallback, stale-while-revalidate for static assets, never intercepts `/api/*`. `public/offline.html` fallback page. Registered in `src/components/InstallApp.tsx` (prod only).
4. **Install UI** — `src/components/InstallApp.tsx`: `useInstallPrompt()` hook (beforeinstallprompt + iOS detection + standalone detection), `InstallBanner` floating prompt on every page (dismissible, hidden on /print), `InstallSection` on the welcome page ("Install the app — no app store required").
5. **Landing flow** — `/` now sends anonymous visitors to `/welcome` (marketing + install CTA) instead of straight to /login.
6. **Deploy prep** — `apphosting.yaml` APP_URL placeholder set (update after first deploy); `.gitignore` hardened: added `service-account.json`, `*-service-account*.json`, `*.tsbuildinfo`, `.firebase/` (security: private key must never be committed).
7. Verified: `npm run typecheck` 0 errors, `npm run build` success, PWA assets reachable.
8. **Git repo initialized + first commit** (this is required to connect Firebase App Hosting).

**Next steps (in order):**
1. Push repo to GitHub (owner account), then in Firebase console → App Hosting → create backend from the repo, set secrets (FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL, FIREBASE_PRIVATE_KEY, JWT_SECRET), set APP_URL to the generated `*.web.app` URL, deploy.
2. Click-through UI test on the deployed URL (login with demo accounts), verify PWA install prompt on Android/Chrome.
3. Later: connect custom domain (Domain → App Hosting in Firebase), set APP_URL to it; optional Phase 5 features (AI remarks, SMS/push/email, bKash/Nagad/card payments).

> **Post-review hardening (same session):** SW no longer caches private role pages (/admin, /dashboard, /teacher, /parent, /print, /qr) — offline fallback for those is /offline.html only (privacy fix). `InstallBanner` uses `usePathname()` (no print-page flash). `next.config.mjs` adds `Cache-Control: no-cache` for `/sw.js` + `/manifest.json` so PWA updates propagate fast. Note: SW is only registered in production (`NODE_ENV !== "development"`) — the install button won't appear during `npm run dev`; test PWA with `npm run build && npm start`. Committed as 7ef93e6 + 2nd commit.

---

## 💾 SAVE / RESUME CONVENTION (from 2026-08-04)

**Rule: after EVERY meaningful step, run `npm run save "<what just happened>"`.**

It does three things in one command:
1. Appends a timestamped checkpoint → `scripts/session-progress.log`
2. Writes a machine-readable snapshot → `scripts/session-state.json` (what resume.mjs reads)
3. Auto-commits ALL changes to git with `progress: <msg>` — so a power cut / crash loses **nothing**

**Resuming after any interruption (power cut, crash, new machine):**
```bash
cd E:\SmartSchoolERP
npm run resume          # one screen: last checkpoint, git state, server status, .env sanity, next steps
npm run resume -- --seed  # optional: also checks Firestore seed state (read-only)
# then read PROGRESS.md → do the next item on the list
```

The resume screen also sanity-checks `.env` (the historical #1 blocker was a double-escaped `FIREBASE_PRIVATE_KEY`).

**Snapshot now (PWA + go-live prep done, this session):**
- PWA fully implemented & browser-verified (manifest, SW with privacy fix, icons, install banner + section).
- Git repo initialized on `main` with 2 commits; working tree clean.
- Production build verified; `npm start` running on :3000.
- Deployment to Firebase App Hosting is the ONLY remaining big step (needs owner's GitHub push + console secrets).

> **Hardening (same session):** `save.mjs` now REFUSES to commit if any staged file looks like a secret (`service-account`, `.env*`, `*.pem`, `private_key`) — belt-and-braces on top of `.gitignore`. Tested: normal saves leave a clean tree; a `stripe-secret.env` attack file was refused with exit code 1. `npm run resume` also sanity-checks git identity and reports the exact git error if a commit fails.
