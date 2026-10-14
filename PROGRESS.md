# 🗂️ Project Progress & Session Resume

> **Read me first** in any new session working on this project.
> Keep this file updated at the end of each working session so the next one resumes instantly.

**Project:** Smart School ERP & Parent Communication System (Multi-Tenant SaaS)
**Location:** GitHub — `github.com/shufayetahamedt4-collab/smart-school-erp` (any clone works — see "Working from a different PC/device" below)
**Last updated:** 2026-10-14 — **college Phase 7 is FINISHED AND COMMITTED** (fee basis: logic 7a, data 7b, API 7c, screens + print pages 7d, isolation/Q3 7e, finished record + production-build role probe 7f) on `integration/main-into-college` (`f542405` code + verifiers, `efb97c0` docs, the evidence records in `946e4e3`), where the school and college lines are merged; production still runs on `smart-school-db` (asia-southeast1), and its **live branch is `main`** (`f4ed2a5`). Nothing is left uncommitted but ignored artifacts. **Phase 8 has started on `phase8/college-attendance`**: `8-pre` (the course↔teacher link), **ca-0** (the college attendance allow-list), **ca-1** (the pure attendance logic), **ca-2** (the `courseAttendance` data layer), **ca-3** (the register's API: roster read, session save, per-student history) and **ca-4** (the register screen + its ONE college nav entry — staff-only v1, the REGISTRAR read-only; the D-8P-5 teacher-read question was stopped and ruled on by the owner, §30) are built and verified there; the isolation/regression pass and the finished record (ca-5/ca-6) are next, and the family-facing read stays a post-v1 owner decision. The newest session record is the **2026-10-14 ca-4** block at the bottom of this file.

---

## 🔁 Session — 2026-09-24 #2 (Firestore region migration: africa-south1 → asia-southeast1 — CUTOVER DONE)

**Problem (measured, not guessed):** the Firestore database lived in **`africa-south1` (Johannesburg)** while the App Hosting backend is in **`asia-southeast1` (Singapore)** and users are in Bangladesh. Every query did Singapore→Johannesburg→Singapore: raw Firestore round trips from a Dhaka-area PC measured **567–1,139 ms** (3.7 s first call in a fresh process), prod endpoints flat **~450 ms** regardless of payload. Caching (30 s TTL, stale-while-revalidate) had been masking this; the cold path paid the full tax.

**Chosen strategy:** a **second database in the same project** (`smart-school-db`, `asia-southeast1`, FIRESTORE_NATIVE) — keeps Firebase Auth users, Cloud Storage bucket and the App Hosting backend untouched; cutover is one env var; the old database is never modified so it is its own backup. Multiple databases per project is GA and needs Blaze (the project already is, via App Hosting). `firebase-admin@13` routes named databases (verified with a live NOT_FOUND probe on a fake id).

### What was done (Phases 0–3)
1. **Target created:** `npx firebase firestore:databases:create smart-school-db --location=asia-southeast1` (production/deny-all at birth). Both composite indexes from `firestore.indexes.json` deployed to it — the `subscriptions` one **with its pre-existing `schoold` typo verbatim** (fixing it is a separate cleanup; changing it during migration would 500 that query). Deny-all rules deployed to both databases via `firebase.json` (now declares both).
2. **Copy + parity tools (committed):** `scripts/migrate-firestore.mjs` (recursive incl. subcollections — found the stray `conversations/*/noop`; document ids preserved exactly; BulkWriter; re-runnable upserts; structural guard against ever writing the source; reports any `DocumentReference` fields — the dataset has **zero** DocumentReference/GeoPoint fields) and `scripts/verify-firestore-parity.mjs` (collection-group counts + doc-id SHA-256 digests + deep field-by-field compares incl. Timestamps; fails loudly on any mismatch). Gotcha fixed on the way: a source-client doc ref used as the **write key** makes the RPC flip to the source db (INVALID_ARGUMENT) — keys are rebuilt through the target client.
3. **Parity result: 40/40 collection groups matched on counts AND id digests; 161 deep-compared docs field-identical (users 27, schools 8, settings 17, feeSettings 13, plans 3, certificateTemplates 3 + random docs). Dataset: 1,646 docs / 39 top-level collections — the copy takes ~2 minutes.**
4. **Owner-ordered sequence, all followed:** (1) local test first — dev server with `FIRESTORE_DB_ID=smart-school-db` in `.env` only: login 200, all dashboard endpoints 200, `bench-routes.mjs` green, warm routes 31–382 ms (no push). (2) Delta copy + parity re-run immediately before push. (3) Repo census of default-DB consumers: **no Cloud Functions exist**; all app code flows through `getDb()`; 12 scripts taken from `getFirestore()` directly — **all 12 now honor `FIRESTORE_DB_ID`** with `(default)` fallback. (4) ONE commit, no minInstances change. (5) After rollout: final delta copy, prod smoke, benchmarks.
5. **Cutover commit: `e7222c5`** (pushed 2026-09-24) — `src/lib/firebase.ts` `getDb()` reads `process.env.FIRESTORE_DB_ID || "(default)"`; `apphosting.yaml` sets `FIRESTORE_DB_ID: smart-school-db`; 12 scripts + the two migration tools. Typecheck clean before commit.
6. **Verified prod is on the new DB by WRITES, not config:** `auditLogs` in `smart-school-db` grew 853 → 854+ from prod logins while `(default)` stayed frozen at 837. Login 200, all prod endpoints 200, sessions unaffected (they are HS256 JWT cookies — `verifySession()` reads no Firestore — so **nobody was logged out**).

### Numbers (before → after)

| measurement | before (africa) | after (asia) |
|---|---|---|
| raw Firestore query, this PC, steady state | 567–1,139 ms | **154–173 ms** (5–6×) |
| raw Firestore query, first call in fresh process | 3.7 s | 0.85 s |
| prod `/api/stats` cold cache miss | ~2.8 s | **~0.9 s** |
| prod endpoints, warm | ~450 ms flat | ~440–620 ms (unchanged envelope) |
| local dev warm routes (same machine) | 1.2–3.8 s typical | 31–382 ms |

Warm prod endpoints did NOT get faster because their ~450 ms envelope is the **client↔Singapore HTTP round trip from Bangladesh** — even a bare HTML page costs ~450 ms RTT here. The DB hop inside that envelope is now ~5–20 ms instead of ~500 ms; from Bangladesh the internet's RTT is the floor, and no database change moves physics. Server-side and in-app (via the backend, same region) every query is 25–60× cheaper, so multi-query pages and cache misses benefit most.

### Rollback procedure (keep until archive retirement) — CORRECTED by pilot P3 (`e5ee07d`)

> **Pilot P3 (2026-10-13) supersedes the bullet below.** In a live environment the app now REFUSES to
> open an unnamed or `"(default)"` database (`src/lib/database-id.ts` → `assertNamedDatabaseId`;
> `src/lib/firebase.ts`), with **no opt-in flag**. So **removing or unsetting the variable is no longer a
> rollback — it is a refused start**, and so is setting it to the literal `"(default)"`. **The rollback
> is the App Hosting console's Rollback button**, which serves a previous rollout together with its own
> configuration. **Never unset the variable.**

- ~~Set `FIRESTORE_DB_ID: "(default)"` in `apphosting.yaml`, push → one rollout (~5–10 min) back to the africa database. Local dev: remove the var from `.env`.~~ **Superseded — see the note above.** The africa `(default)` database is no longer reachable by configuration; pointing at it again would need a code change, not a variable.
- The africa database is untouched and current as of the **final delta copy 2026-09-24 ~18:52 UTC+6** (after it, writes land only in the new DB). Data written to the new DB between cutover and a rollback would need a reverse copy first (run `migrate-firestore.mjs` with source/target swapped, or accept the loss for throwaway data).
- `scripts/migrate-firestore.mjs` / `verify-firestore-parity.mjs` are permanent tools — re-runnable any time (the copy is idempotent upserts; parity fails loudly).

### Notes for future sessions
- **2026-10-08 (≈2 weeks after cutover): delete the africa-south1 `(default)` database** after one last parity spot-check — until then it is the free rollback insurance. Deletion needs delete-protection OFF (it is). **P3 correction (2026-10-14):** the configuration fallback that made this "insurance" reachable is gone (see the rollback note above), so this is now an **owner decision, not a scheduled task** — do not delete it without one, and note that restoring it later would take a code change, not an unset variable.
- `FIRESTORE_DB_ID` is now a load-bearing env var: `apphosting.yaml` (prod), local `.env`, and the 12 scripts. A fresh checkout copy-pasting `.env` gets the right database automatically.
- Known CLI bug hit during the work: `firebase deploy --only firestore:indexes` crashes with `TypeError: Cannot read properties of undefined (reading 'map')` in the `--only` filter path (firebase-tools); deploying via the Firestore API directly works, and rules/indexes also deploy per-database from the two-entry `firebase.json` firestore config.
- ~~Remaining perf follow-up~~ **Done 2026-09-24 (commit `7c29f65`): `minInstances: 1`** — one always-warm instance. Measured cold penalty on this backend was small (+150–300 ms on the first request after an 8–20 min idle gap: Firestore channel + container reconnection on top of the ~450 ms RTT envelope); post-change idle-gap probes return at warm speed. Cost: one always-on instance (~$10–15/mo at cpu 1 / 512 MiB).
- The `schoold`→`schoolId` index typo in `subscriptions` is still live in BOTH databases (queried by name from code) — fix needs a code-side field rename + new index + old-index removal, its own session.
- Migration reports (copy + parity JSON, per run) live in `.freebuff/migration/` (not committed).

---

## 🔁 Session — 2026-09-21 #4 (save point: storage rules deployed, everything pushed)

- ✅ **Storage rules deployed to production:** `npx firebase deploy --only storage --project amar-e-school` — compile + release clean. Before deploying, the live rules were fetched via the Firebase Rules API and diffed against the new file: **purely additive** (existing `uploads/` public-read block and deny-all untouched; one new read-only `certificates/{schoolId}/` block). After deploying, the live release was re-fetched and matches (only a trailing newline differs). Temp fetcher script removed after each use.
- ✅ **Everything committed and pushed:** `main` = `origin/main` = `b31569c`. The push triggered the (single) App Hosting build on `smart-school-erp-1`.
- 📄 Added the **"Working from a different PC/device"** checklist (below) so any machine can resume from this exact point.

**Nothing is pending:** working tree clean, no unpushed commits, no undeployed config.

---

## 💻 Working from a different PC/device — resume checklist

The source of truth is **GitHub**, not any one machine. To pick up exactly where this left off:

1. **Clone or pull:** `git clone https://github.com/shufayetahamedt4-collab/smart-school-erp.git && cd smart-school-erp` (or `git pull` in an existing clone).
2. **Restore secrets** — `.env` is deliberately NOT in git (Firebase service creds, JWT_SECRET, APP_URL). Copy it from the other machine by hand (USB / secure channel) into the project root. Without it, `npm run setup` and the Admin-SDK-based scripts/APIs won't run. Never paste secret values into any committed file.
3. **Install:** `npm install` (the lockfile is committed — use npm, not pnpm/yarn).
4. **Read this file top-to-bottom** — newest session section is always at the top; it records what was built, what was verified, and what's next.
5. **Seed only if starting from a fresh Firebase project:** `npm run setup` (idempotent) creates the demo school + demo users (table at the bottom of this file). Skip when pointing at the existing project's Firestore.
6. **Run & verify:** `npm run dev` (Next auto-picks a free port — read it from the `- Local:` startup line). Health checks: `npm run typecheck` (0 errors) and `npm run build`. QA suites (hit a running server): `node scripts/qa-certificates.mjs http://localhost:<port>` (41), `node scripts/qa-phase3.mjs …` (18), `node scripts/qa-phase23.mjs …` (36) — each creates a throwaway school via the real API and cleans up; `node --env-file=.env scripts/qa-cleanup-users.mjs` sweeps orphaned QA users.
7. **Save convention:** end every meaningful step with `npm run save "<what you did>"` — appends to `scripts/session-progress.log`, snapshots `scripts/session-state.json`, auto-commits (fix identity first if needed), then `git push`. Check state anytime with `npm run resume`.
8. **Deploys:** every push to `main` auto-builds on Firebase App Hosting (single backend `smart-school-erp-1`; URL = `APP_URL` in `apphosting.yaml`). Firestore/Storage rules deploy manually via `npx firebase deploy --only storage --project amar-e-school` (requires `firebase login`).
9. **Dev-server gotcha:** never run `npm run build` while `npm run dev` is live — they share `.next` and dynamic routes start 500ing. Restart the dev server after any production build.

Machine-specific run notes (original PC) live in `.freebuff/run.md` in that workspace (not committed).

---

## 🔁 Session — 2026-09-21 #3 (custom certificate templates — no-code per-school design)

### Done this session (typecheck + build green, 41/41 QA + 18/18 + 36/36 regression)

Plan was written and owner-approved before coding. All 9 owner requirements met:

1. **`certificateTemplates` collection** registered in `src/lib/db.ts` (COLS/RELS/facade). Per-school docs: `schoolId`, `type` (TC|CHARACTER), `name`, `isDefault`, `bodyEn`, `bodyBn`, `design`.
2. **Design settings** (`lib/certificate.ts` `CertDesign`): logo, watermark (text/image + opacity 0–1 + 5 positions), seal image, principal & class-teacher signature images, border (double/simple/none), primary color (hex), font (serif/sans/**Noto Sans Bengali** webfonts loaded via React-hoisted <link>), header/footer text, signatory labels, A4 portrait/landscape (print @page hint follows the template).
3. **Safe placeholder engine** (`lib/certificate.ts`): exactly 15 placeholders (studentName, fatherName, motherName, class, section, admissionNo, admissionDate, leaveDate, serialNo, schoolName, dateOfBirth, issueDate, conduct, academicYear, rollNo) + **`[[…]]` conditional clauses** — a clause containing any empty value is dropped entirely (requirement 4), `**bold**`. Bodies are plain text only: HTML rejected at save (`<`/`>`), unknown placeholders rejected, unbalanced/nested `[[ ]]` rejected; resolver escapes nothing-by-default (React text nodes) and QA asserts no `{{` leaks into output.
4. **Missing-data fix in `/api/certificates`:** father/mother derived from `guardianRelation` (FATHER→fatherName, MOTHER→motherName) with the guardian user doc as fallback — previously "son/daughter of —". Built-in bodies rewritten with conditionals (EN + BN).
5. **`/dashboard/certificate-templates`** settings page: template list per type with Default badges, editor (name, default flag, EN body, BN body with **insert-placeholder chips**, all design controls incl. uploads), **live preview using the exact print renderer** + EN/বাং toggle, duplicate/delete/set-default. Nav: "Certificate Templates" (SCHOOL_ADMIN).
6. **Built-in fallback preserved:** `useBuiltIn: true` when a school has no template — renderer falls back to `BUILTIN_CERT_BODIES` + `DEFAULT_CERT_DESIGN`.
7. **Bangla:** `bodyBn` per template, Noto Sans/Serif Bengali loaded, bengali font option, print page EN/বাংলা switcher.
8. **Storage:** `POST /api/uploads?kind=certificate` (admins only) → `certificates/{schoolId}/…`, images only (jpg/png/webp), 2 MB cap; `storage.rules` adds a read-only `certificates/{schoolId}/{fileName}` block. Template validation **rejects any image URL outside `certificates/{schoolId}/`** → cross-school image references impossible.
9. **Admins only:** both template APIs gate on SCHOOL_ADMIN/SUPER_ADMIN (`systemSettings` semantics); SUPER_ADMIN may pass `?schoolId=` to inspect. `[id]` routes resolve the doc then require `tpl.schoolId === session.schoolId` (SUPER_ADMIN exempt) — cross-school PATCH/DELETE → 404 (QA-verified).

**`/api/certificates` hardening (found during planning):** previously any role with `studentTeacherInfo:full` could read ANY student's certificate cross-school. Now: tenant check (`student.schoolId === session.schoolId`, SUPER_ADMIN exempt) + teachers restricted to students of their own assigned classes (`viewOwnClass`) + guardian own-child logic kept. Response now includes `template` (resolved), `values` (15 placeholders), `resolved.en/bn` (plain text), father/mother.

**Shared renderer:** `src/components/CertificateDocument.tsx` — ONE component for editor preview AND print page (identical output; inline hex styles so html2canvas PDFs match). Print page rewritten to consume it.

### Verified
- ✅ `npm run typecheck` 0 errors; `npm run build` — all routes incl. `/api/certificate-templates(+/[id])`, `/dashboard/certificate-templates`, `/print/certificate/[studentId]`
- ✅ `scripts/qa-certificates.mjs` — **41/41**: auth guards, throwaway school + 2 students (FATHER + MOTHER relations) via real import flow, built-in fallback + father/mother derivation + no "—" in output, validation matrix (HTML/unknown-placeholder/cross-school-URL/unbalanced), custom template create/resolve, per-type defaults, PATCH + Bangla resolution, cross-school 404s, teacher 403s, certificate tenant 403, teacher own-class 403, guardian own-child allow + other-child 403, CHARACTER/TC independence, full cleanup (templates, students, classes, subjects, school, 3 orphaned users, storage sweep)
- ✅ Regression: `qa-phase3.mjs` 18/18, `qa-phase23.mjs` 36/36 (certificates route changed)
- ✅ Preview click-through: editor renders (chips/controls/live preview), typed custom body → preview resolved live, saved via UI, print page used the custom template with clean conditional dropping, screenshot verified (serif + maroon double border + toolbar + "Using custom template" note); Bangla toggle verified in QA
- ⚠️ Again hit the `.next` clobbering (ran `npm run build` while dev was live → dynamic routes 500) — server restarted clean on **port 55874**, then all suites passed. **Rule: restart dev after any production build.**

### Notes for future sessions
- Storage rules deployed 2026-09-21 (session #4) — pre-deploy live diff verified additive; post-deploy re-fetch matches. 🔐
- Custom template on the demo school was deleted after QA click-through; demo school is back on built-ins.
- The old inline-designed certificate page is fully replaced; `fmtDate` import removed from it.
- Conduct is still hardcoded "Good" for CHARACTER certs (placeholder `{{conduct}}` exists; a picker is a natural follow-up).
- QA scripts: `qa-phase23.mjs` (36), `qa-phase3.mjs` (18), `qa-certificates.mjs` (41), `qa-cleanup-users.mjs`.
- **Infra:** only App Hosting backend is `smart-school-erp-1` (`https://smart-school-erp-1--amar-e-school.asia-southeast1.hosted.app`); duplicates were deleted 2026-09-21.

---

## 🔁 Session — 2026-09-21 #2 (Phase 3: timetable builder UI §9.2 + printable certificates §9.2)

### Done this session (typecheck + build green, 18/18 QA assertions)

1. **Timetable builder UI** (`/dashboard/timetable`): 8-period × Sun–Fri slot grid per class (+optional section filter). Click a cell → modal to assign subject + teacher; filled cells show subject/teacher/time. Print button (print stylesheet hides chrome). **Substitution finder** modal: pick a date → slots affected by approved teacher leaves + free-teacher suggestions with on-leave flags. Nav: "Timetable Builder".
2. **Server-side double-booking guard** in `POST /api/timetable-slots`: 409 when the same teacher already holds a slot at that day+period (`replaceId` param exempts the cell being replaced so in-place edits work).
3. **Teacher-name resolution fix (pre-existing bug):** teacher docs store no `name` (it lives on the linked `user` doc) — GET slots and the PUT substitution finder now join names via one school-scoped `users` pull. Builder cells + suggestion chips previously showed null names.
4. **Printable certificate page** (`/print/certificate/[studentId]`): TC & Character Certificate from `GET /api/certificates` — serial no., school letterhead (logo/address/phone), double-rule border, seal + signature spaces, PrintActions (print + PDF via html2canvas/jspdf), **client-side TC↔CHARACTER switcher**, Bengali-name support. Linked from student detail page ("Certificate" button).
5. **UI bug found in QA & fixed:** slot-save failure (e.g. 409 clash) set the error message *before* `loadSlots()` which resets it — the clash reason flashed invisible. Order swapped (refresh grid → then set error); modal now stays open with selections intact and the red banner persists.

### Verified
- ✅ `npm run typecheck` — 0 errors; `npm run build` — 131 routes
- ✅ `scripts/qa-phase3.mjs` — 18/18: login guard, slot CRUD, 409 double-booking, replaceId swap, same-teacher-different-period, list with names, substitution finder shape, TC/CHARACTER data (serials, conduct, dates), 404/401 guards; slot cleanup built in
- ✅ Preview click-through: grid renders, modal assign → cell shows "Bangla · Sharmin Sultana", cross-class same-period clash shows banner, remove-slot works; certificate DOM verified (serial CERT-TC-2026-…, body, toolbar)
- ⚠️ Dev-server + `npm run build` on the same `.next` dir conflicts — after running a build, restart `npm run dev` (hit this once; server restarted clean on port 55826)

### Notes for future sessions
- Timetable uses `attendanceMarks:full` permission (existing convention); page lives at `/dashboard/timetable` — distinct from `/dashboard/routine` (period-only subject grid without teachers; consider merging later).
- Certificate conduct value is hardcoded "Good" in `/api/certificates` — a conduct field/picker is a natural follow-up.
- QA scripts so far: `qa-phase23.mjs` (36), `qa-phase3.mjs` (18), `qa-cleanup-users.mjs` (orphan sweep).
- **Infra:** duplicate App Hosting backends `smart-school-erp` (shared repo link → double builds per push) and `test` (orphan, no repo) were deleted on 2026-09-21 with owner approval. `smart-school-erp-1` is the ONLY backend — every push now triggers exactly one build. Live URL: `https://smart-school-erp-1--amar-e-school.asia-southeast1.hosted.app` (= `APP_URL` in apphosting.yaml).

---

## 🔁 Session — 2026-09-21 (Phase 2/3 completion: billing gaps, onboarding wizard §3.3, CSV import/export §12.4)

**Starting state:** working tree clean on `main`, typecheck green. Repo had advanced past the 2026-09-18 notes: PRD §12.1 subscription billing backend already existed (`/api/plans`, `/api/subscriptions`, `/api/subscription/state`, `lib/subscription.ts` with TRIAL→ACTIVE→GRACE→LOCKED lifecycle + `writeGuard()` on tenant writes, `/admin/billing` console, `/print/invoice/[id]`, `/api/subscriptions/invoice/[id]`).

### Done this session (typecheck + build green)

1. **Plan-limit enforcement (§12.1):** `assertPlanStudentLimit()` + `planLimitGuard()` in `lib/subscription.ts` — 402 with upgrade-oriented message when a school exceeds its plan's `maxStudents` (alumni/transferred excluded from the count). Wired into `POST /api/students` and admission `action=enroll`. Unlimited when no plan/no limit.
2. **School-side billing (§12.1):** `GET /api/subscription/billing` (plan, status, daysLeft, usage vs. cap, own invoices — read-only) + `/dashboard/billing` page (plan card, status card, capacity progress bar, invoice table linking to PDF) + "Billing & Plan" nav item.
3. **Onboarding wizard (§3.3):** `GET/POST /api/onboarding` — status endpoint (progress counts classes/subjects/fees, `school.<id>.onboarded` setting) + transactional create-or-extend (school + branding setting + admin account + classes with sections + subjects + feeSetting + Main Campus branch). `/onboarding` — 5-step wizard (profile→admin→classes→subjects→fees) with quick-add presets (Play–KG, Class 1–5, 6–10; section A/B/C toggles; common BD subjects), extend-mode when the admin already has a school (skips admin step, jumps to classes), review + success screens. Linked from Super Admin Schools page ("Setup wizard").
4. **CSV import/export (§12.4):** dependency-free `lib/csv.ts` (RFC-style parser: quotes/escaped quotes, BOM, delimiter sniffing; serializer; alias-tolerant header mapping). `GET/POST /api/import/students` + `/api/import/teachers` — template download, `dryRun` preview with per-row OK/ERROR/SKIP results (dup admission-no/email detection, class/section existence checks, plan-limit pre-check), transactional commit (shared guardian accounts deduped by email, default passwords Guardian@123 / Teacher@123, idempotent guards). `GET /api/export?type=students|teachers|fees|ledger|attendance` (attendance supports from/to). `/dashboard/import-export` console + nav item. Imports respect `writeGuard` + `planLimitGuard`; exports read-only and school-scoped from the session.

### Verified
- ✅ `npm run typecheck` — 0 errors
- ✅ `npm run build` — success, 130 routes (new: /api/onboarding, /api/subscription/billing, /api/import/students|teachers, /api/export, /onboarding, /dashboard/billing, /dashboard/import-export)
- ℹ️ No seed changes needed (features operate on runtime data; §12.1 plans/subscription demo already seeded)

### Next steps (in order)
1. Click-through test: `/onboarding` wizard (new + extend modes), import preview→commit round-trip with the downloaded template, export downloads, plan-limit 402 (set a small `maxStudents` on a plan first).
2. Remaining from §12.x: white-label settings UI polish (§12.2), multi-branch UI (§12.3 schema ready).
3. Remaining Phase 3: timetable builder UI, certificate print page, quizzes UI polish, i18n toggle, calendar UI.
4. Provide credentials when ready: FCM (push), BD SMS, bKash/Nagad/Rocket/Card sandbox, then set `PAYMENT_WEBHOOK_SECRET`.

### Notes for future sessions
- `planLimitGuard()` must be called on any future route that creates ACTIVE students (enrollment paths) — search for `writeGuard(` call sites when adding new ones.
- CSV import maps headers case/space/underscore-insensitively via aliases in the import routes; extend those maps when adding columns.
- `/api/subscription/billing` and `/api/onboarding` accept `?schoolId=` for SUPER_ADMIN; otherwise they use the session school.
- The db facade's `$transaction(fn)` returns `unknown | undefined` to TS — use `(await …)!` when the callback always returns.

---

## 🔁 Session — 2026-09-18 (PRD v1.2 implementation — Phases 0–4)

**Input:** `Smart_School_ERP_Requirements_v1.2_ENGLISH.docx` (17 sections). Working tree was first restored to `origin/main` (previous uncommitted work backed up to `../_uncommitted-backup/`, including the Product Scanner). Then the full PRD plan (approved by owner) was implemented.

### Done this session (all typecheck + build green)

**Phase 0 — Foundation**
1. **Roles (§2):** `Role` now includes `STUDENT`, `ACCOUNTANT`, `LIBRARIAN`, `FRONT_DESK`. Middleware guards `/student`; sub-roles enter `/dashboard` (permission-controlled views, per PRD note under §2).
2. **Permission matrix (§2.1/§14.1):** `src/lib/permissions.ts` — module × role → actions, `can()` + `requirePermission()`; enforced in all new API routes (legacy routes keep their checks).
3. **2FA (§14.1):** `src/lib/twoFactor.ts` — dependency-free TOTP (RFC 6238) + single-use backup codes. Login route now returns a `twoFactorRequired` challenge for SUPER_ADMIN/SCHOOL_ADMIN; login page has the verify step. Enrollment via `POST /api/auth/2fa {action:start|confirm|disable}`. Gradual enforcement: not yet enrolled ⇒ no challenge (grace window).
4. **Future-proof schema (§16.2):** 35 new collections registered in `src/lib/db.ts` (`COLS`, `RELS`, `idFor/idForCreate`, `prisma` facade): admissions, admissionDocuments, discounts, academicSessions, branches, leaveRequests, meetingSlots/Bookings, complaints, gallery, healthRecords, feeTemplates(+Items), installments, **ledger**, paymentIntents, expenseEntries, vendors, payroll, notifications, devices, conversations(+Messages), smsLogs, bookCatalog/Issues/Stock, plans, subscriptions, invoices, resources, quizzes(+questions/attempts), virtualClasses, timetableSlots, substitutions, calendarEvents, twoFactor. Students gain `nameBn`, `birthCertificateNo`, `permanentAddress/currentAddress`, `status` (ACTIVE|ALUMNI|TRANSFERRED), `familyId`, `sessionId`, `branchId`.
5. **Design system (§14.2):** tokens + role accents (Admin=blue, Teacher=green, Guardian=orange), dark mode (`ThemeToggle`, `html[data-theme]`), `.skeleton` classes, notification bell in Shell.
6. **Login portal (§3.2):** forgot-password email-OTP flow (`purpose:"forgot"`, code logged in dev), QR login link, 2FA step. `sendOtpEmail`/SMS provider live in `src/lib/notify.ts` (mock adapters until credentials).
7. **Marketing/onboarding (§3.1/§3.3):** deferred to next session (welcome page exists); onboarding wizard not yet built.

**Phase 1 — USP**
1. **Admission module (§4):** public form `/apply` (no login) → `admissions` pipeline; `src/lib/admission.ts` (strict transitions, class auto-suggest, sibling auto-suggest); `/dashboard/admissions` UI (pipeline actions, doc upload via /api/uploads, discount propose/approve, seat confirm, enroll+pay). Enrollment creates student + guardian account + family link + admission & monthly fees and confirms payment via ledger. Discount approval = Accountant/Front Desk propose → Admin approve (§4.2).
2. **Central ledger + payments (§10):** `src/lib/ledger.ts` — `postToLedger()` (FEE/PAYMENT/DISCOUNT/LATE_FEE/EXPENSE), `confirmPayment()` (fee+payment+ledger atomic, guardian notification), `applyLateFees()` (idempotent), student/school queries. `src/lib/payments.ts` — `PaymentProvider` abstraction: CASH instant, BANK reconciliation (`PATCH /api/payments`), BKASH/NAGAD/ROCKET/CARD intents + idempotent signed webhook `/api/payments/webhook/[provider]` (mock-complete route disabled once `PAYMENT_WEBHOOK_SECRET` set). Guardian **View+Pay** in `/parent/fees` (installments shown). `/dashboard/ledger` analytics (inflow, discounts, late fees, by-method). Fee templates API `/api/fee-templates` (per-class line items §10.3). Reminders runner `/api/fees/reminders` (push+SMS, §10.4).
3. **Communication (§13/§7.1):** notification center (bell, `/api/notifications`, `notifyUsers()` fed by fee/chat/admission/complaint/PTM events); FCM web push (device registration `/api/notifications/devices`, `pushToUsers()` via firebase-admin messaging, SW `push`/`notificationclick` handlers); SMS fallback (`SmsProvider` + `smsLogs`); **two-way chat** `/api/chat` + `ChatPanel` replacing messages pages (teacher↔guardian, per-student context, unread counts, polling); PTM scheduling (`/api/meetings`, staff publish / guardian book); complaints box (`/api/complaints` with status tracking); gallery (`/api/gallery`).
4. **Student records (§5):** sibling linking (`familyId`, `/api/parent/siblings` child list); promotion (§5.2 preview→confirm, exclude failures, `/api/students/promote`); alumni archive (§5.3, never delete, `/api/students/alumni`); TC/character certificate generator data API (`/api/certificates`) — printable page pending.

**Phase 2 (partial):** student panel `/student` (+`/api/student/me`, layout, Shell nav); resources library (§6.2): `/api/resources` (mandatory class/subject tagging, auto-filter for guardian/student, views/downloads analytics, versioning via supersede), teacher upload page, admin + guardian pages; leave management (§9.2) full workflow; multi-branch/CSV/billing/white-label UI **not yet** (schema ready).

**Phase 3 (partial):** timetable slots + substitution suggestions (`/api/timetable-slots` — consumes approved teacher leaves, per plan leave comes first); academic-session/branch/virtual-class/question-bank collections exist. GPS, video integration, AI remarks, i18n, calendar UI **not yet**.

**Phase 4:** health records collection exists (restricted by design); beacon ingestion **not yet**.

**Seed:** `scripts/seed.mjs` extended (idempotent): demo admissions pipeline, ledger entries mirroring seeded fees, a chat conversation, a sample notification — 4 new checkpoints before SEED COMPLETE.

**Rules:** `firestore.rules` comment updated — deny-all unchanged (Admin-SDK-only writes); no client-accessible collections added.

### Verified
- ✅ `npm run typecheck` — 0 errors
- ✅ `npm run build` — success (all routes incl. /student, /apply, /dashboard/admissions|ledger|leaves|meetings|gallery|complaints|promotion|resources, /parent/*, /teacher/*)
- ✅ `node --check scripts/seed.mjs`
- ⚠️ Seed not re-run against live Firestore this session (owner may run `npm run setup`)

### Next steps (in order)
1. Run `npm run setup` (re-seed; idempotent) + `node scripts/check-seed.mjs`.
2. Click-through test: login (2FA enroll an admin via Settings), admission enquiry→enroll, guardian pay (sandbox bKash), chat, notification bell, promotion.
3. Build remaining Phase 2/3 UI: onboarding wizard (§3.3), subscription billing (§12.1), white-label (§12.2), CSV import/export (§12.4), certificate print page, quizzes, timetable builder UI, i18n toggle.
4. Provide credentials when ready: FCM (push), BD SMS, bKash/Nagad/Rocket/Card sandbox, then set `PAYMENT_WEBHOOK_SECRET`.

### Notes for future sessions
- 2FA enrollment is **gradual**: existing admin logins unaffected until they enroll (deliberate grace per plan).
- Payment gateway adapters run in **mock mode** until `PAYMENT_WEBHOOK_SECRET` + merchant env vars are set; the mock-complete route refuses to run once the secret exists.
- All new routes enforce the §2.1 matrix via `can()`; never trust client-sent `schoolId`.
- The old `MessagesPanel` component is still used by `/dashboard/messages`; chat lives in `ChatPanel`.

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

## 🧪 Validation Commands

```bash
npm run typecheck    # tsc --noEmit (0 errors = good)
npm run build        # production build
npm run setup        # idempotent Firestore seed
npm run seed         # same as setup (alias)
```

---

## College support lives in its own document

This file records the **school / SaaS** line. The **college-support** work — institution types
(SCHOOL / COLLEGE / BOTH), the mode foundation, the college gate, departments / programmes / courses /
terms, course registration and approval, student college identity, and the per-programme promotion
ladder with its 6-pre hardening — is documented in full at:

- **`docs/COLLEGE-STATUS.md`** — the whole story: phases and commit hashes, the current verifier
  counts, the 15-step college-admin journey, what is left, and the record of naming mistakes.
- **`docs/COLLEGE-DECISIONS.md`** — the source of truth for every college decision.
- **`docs/COLLEGE-PLAN-DELTA.md`** — the original delta plan (superseded where the decisions doc says so).

**Naming rule:** the commits labelled `phase 6-pre 1`–`6-pre 6` are **hardening of Phase 5**
(the promotion ladder), not Phase 6. The real Phase 6 (credit-weighted GPA/CGPA + transcript) has
**not started**. `docs/COLLEGE-STATUS.md` §0 states this in full.

**Integration note:** branch `integration/main-into-college` merged this line (with the onboarding
wizard, plan-limit enforcement, CSV import/export, certificate templates, the timetable builder and
the Firestore cutover) onto the college work; see **`docs/INTEGRATION-LOG.md`** for every conflict
resolution.

**Rollback-name note (integration 1) — SUPERSEDED by pilot P3 (`e5ee07d`).** The rollback procedure
above says to set `FIRESTORE_DB_ID: "(default)"` in `apphosting.yaml`. After the merge, `apphosting.yaml`
sets the **canonical** name `FIRESTORE_DATABASE_ID: smart-school-db`, and `src/lib/firebase.ts` reads
`FIRESTORE_DATABASE_ID || FIRESTORE_DB_ID` — so the *old* rollback would have had to change
**`FIRESTORE_DATABASE_ID`**; setting `FIRESTORE_DB_ID` alone is ignored while the canonical variable is
still set, and the guard in `scripts/lib/guard.mjs` refuses either name for emulator runs. **P3 removes
the point of all of it: changing OR removing the variable rolls nothing back** — a live start with an
unnamed/(default) database throws by name, and the rollback is the hosting console's Rollback button.

**Database-id guard (integration 2, `b96ca63`; refined by pilot P3, `e5ee07d`):** `src/lib/database-id.ts`
makes `FIRESTORE_DATABASE_ID` the **canonical** name and `FIRESTORE_DB_ID` the **alias**; an unset pair
resolves to `null`, i.e. the project's `(default)` database — **but P3 refuses that result in a live
environment, so removing the variable is NO LONGER the rollback** (`liveDatabaseProblem` /
`assertNamedDatabaseId`; the emulator is unchanged). When **both** are set and
**differ**, the resolver **throws** — the app fails loudly, naming both variables, instead of silently
opening a database the operator did not ask for. For emulator runs `scripts/lib/guard.mjs` refuses
either name, because either one selects a named Cloud database.

**Archive-retirement date:** the same record says **2026-10-08 (≈2 weeks after cutover): delete the
africa-south1 `(default)` database** after one last parity spot-check. That date has now passed. **P3
correction (2026-10-14):** `(default)` is no longer reachable by configuration, so it is not "rollback
insurance" an operator can fall back on — treat its deletion as an **open owner decision**.

---

## 🔁 Session — 2026-10-11 (college Phase 6 finished; the two lines merged)

**What is done since 2026-09-24** (the school/SaaS log above ends there; the college line continued on
its own branch until the merge below):

- **Firestore migration cutover record** — already recorded above (session 2026-09-24 #2): the new
  database `smart-school-db` (asia-southeast1), the parity proof and the rollback procedure.
- **`origin/main` integrated into the college line** — branch `integration/main-into-college`
  (`cd0e2d5`, `docs/INTEGRATION-LOG.md`): the onboarding wizard, plan-limit enforcement, CSV
  import/export, certificate templates, the timetable builder and the region cutover now sit on the
  same branch as the college work. From here the school and college lines are **one line**.
- **The onboarding wizard and the new-tenant seed are institution-type aware** (`c4fb047`, `84df90e`)
  — SCHOOL / COLLEGE / BOTH.
- **College Phase 6 FINISHED (6a–6f)** — the grading scheme's `showGpa` + institution-neutral presets,
  the retake policy, credit-weighted term GPA and CGPA, the college result rows (`courseResults`), the
  results API behind the college gate, the results screen + transcript print page, and the isolation
  proof. Keys: 6a `cb05811`, 6b `0b1a3bb`, 6c `f12d227` (+ `e20f4f2` reads are admin/registrar only),
  6d `58d9c85`, 6e `fc8ff62`, 6f the docs commit. The full record and counts are in
  `docs/COLLEGE-STATUS.md` and `docs/COLLEGE-DECISIONS.md` §23.7.1. **Real Phase 7 (college fee basis)
  and Phase 9a/9b/9c (the dashboard / reports / import trio — renumbered from 8a/8b/8c on 2026-10-11, when attendance took Phase 8) were NOT started at that point.**
- **Harness Host fix** — `d497f96` makes the host-scoped checks really run (they had been silently
  skipping).

**Known pre-existing reds (unchanged by Phase 6, documented not fixed):**

- `verify-read-cache` — **1 fail**: a latency assertion that does not hold in dev mode.
- `verify-routine-config` — **3 fails**: the seed writes only **section-scoped** routines while the
  route's class-wide read returns the `sectionId == null` rows.

**Open items (state at 2026-10-11):**

1. **The harness Host fix is committed** (`d497f96`) — recorded here because the earlier reds were
   partly caused by checks that silently skipped.
2. **Routines missing-`sectionId` read hole** — the `verify-routine-config` cause above: the route's
   class-wide read returns only `sectionId == null` rows, which the seed never writes.
3. **Super-admin `POST /api/schools` still writes `feeSetting` for a college tenant** — a school-shaped
   default on a college.
4. **The wizard's success screen still says "school"** for a college / BOTH tenant.
5. **The college sidebar still shows school items** — the mode-aware nav is not complete for a COLLEGE
   tenant.
6. ~~**`docs/PHASE1-DECISION-WORKSHEET.md` and `docs/SMOKE-FAILURES.md` are untracked and outdated**~~ —
   **CORRECTED 2026-10-14: both files ARE TRACKED** (they entered git in `dfa41aa`, 2026-10-13). They
   are still *snapshots* of an older state, so read them as history, not as current truth.
7. **`firestore.indexes.json` `schoold` typo** — fixed in the file, but the index is queried by name
   and both live databases still carry the misdeclared index; the code-side rename is its own session.
8. **Firestore backup not yet confirmed** — the old `(default)` database is the last copy of the pre-cutover data. **P3 correction (2026-10-14):** it is NOT reachable by an unset variable any more, so it is not the rollback path — the rollback is the hosting console's Rollback button, and archiving or deleting it is an owner decision.
9. **Local `main` has 2 superseded commits** (`25547a0`, `70d0176`) — equivalent changes already exist
   on this branch; do **not** re-apply them (`docs/INTEGRATION-LOG.md`).
10. **Archive date 2026-10-08 has passed** — do **not** delete the old `(default)` database yet; it is
    the last copy of the pre-cutover data, and after P3 there is no configuration path back to it (a
    restore would be a code change).
11. **Go-live: role probe on a production build** — **DONE 2026-10-13 (7f)** against a **local** production build (`npm run build` + `npx next start -p 3111`, `scripts/verify-role-probe.mjs` **24/24**, build `bTZhoZ8u8HFwxegmI4rKq`). Only a **hosted/deployed** run remains undone.
12. ~~**Go-live: production line decision**~~ — **DECIDED (owner console screenshot, 2026-10-11): the
    production line is `main`.** The App Hosting backend `smart-school-erp-1` serves branch `main` with
    automatic rollouts enabled and **no environment-variable overrides in the console**, so
    `origin/main` (`f4ed2a5`) is what is live; `deploy/app-hosting` (`96f4762`) is **NOT** the live
    branch.
13. **Go-live: check whether the in-process read cache can serve stale data across multiple App
    Hosting instances (maxInstances 10)** — the per-instance memo (`src/lib/db.ts`, ~30 s TTL + 120 s
    stale-while-revalidate grace) can answer a read with data another instance has already replaced.

---

## 🔁 Session — 2026-10-13 (college Phase 7 COMPLETE: 7d remainder, 7e, 7f — committed 2026-10-14)

**Where this started.** Branch `integration/main-into-college`, HEAD `e5ee07d` (verified current before
any edit). The task was the rest of College Phase 7: 7d's print pages and its four open UX items, 7e's
isolation + Q3 mode-mixing proof, the D-7-18 production-build role probe, and the 7f record.
**`git log -1` was `e5ee07d` while this work ran: everything below was the working tree at the time —
nothing was staged, committed, pushed or deployed then, and no production secret, environment variable or
deployment setting was touched.** *(Committed afterwards: `f542405` code + verifiers, `efb97c0` docs, the
evidence records in `946e4e3`.)*

### What was built

1. **7d remainder — the two D-7-17 print pages.** `/print/college-fee-statement/[studentId]` (a
   student's charges, dues and payments for a term or the whole programme; per-term totals; the
   structure rows that priced each term **and the instant each took effect**; its own print date) and
   `/print/college-fee-receipt/[chargeId]` (ONE confirmed college payment, `?receipt=CRCP-…` selecting
   one instalment; the charge's own billed/paid/due; the rate that priced it). Both run 7c's own
   loaders in process and apply the SAME guard chain as the API: session → the row's tenant → the
   college gate → the D-7-18 read allow-list → branch. The Dues tab links each row's statement and the
   payment it just recorded.
2. **The four 7d look-at items are all closed.** Items 1, 2 and 4 were already fixed in `cac825c`
   (7d-fix); item 3 (the truncated Fee-structure intro and Basis hint) was completed here, and the
   wording is pinned at source level because the page's copy is a client render.
3. **7e — isolation and the Q3 mode-mixing proof.** `isolation-fixture.mjs` now seeds the BOTH tenant's
   **two halves** with non-overlapping money (school 12,000 + 5,000; college 45,000) plus the three
   refused-role users. New `scripts/verify-mode-mixing.mjs` (**33**) measures the school fee list and
   `/api/stats`' fee payload, creates a college head + structure + charge over HTTP for the same
   tenant, and proves the school side comes back **byte-identical** while the college half gains
   exactly its own new money — plus the ledger's ONE-tag separation and cross-tenant 404s.
   `verify-fees-totals.mjs` grows by **9 college checks** (24 total) with its **15 school checks
   untouched**.
4. **The D-7-18 production-build role probe is RUN** — `scripts/verify-role-probe.mjs` (**24**), a real verifier file in this
   change set (untracked while the phase was under review; **committed 2026-10-14**) covering the
   college fee screen and both print pages (it reports which build answered by
   matching the served page against `.next/BUILD_ID`). Two builds, both green: `J8dv3wQUnWhHl5Yxf2rz_`
   (the phase's first run) and `bTZhoZ8u8HFwxegmI4rKq` (an independent re-run this session).
5. **7f — the record**: `proof/7f/REPORT.md` (counts, files, verifiers with exit codes, the school
   baseline, isolation/Q3, the probe, what could not run, known unresolved issues) and `proof/7e/` with
   the baseline transcripts and four mutation proofs.

### Numbers (verified this session, emulator only, fresh fixture, app restarted after it)

| verifier | exit | count |
|---|---|---|
| `verify-mode-mixing` (new) | 0 | 33 |
| `verify-fees-totals` | 0 | 24 = 15 school (unchanged) + 9 college |
| `verify-tenant-isolation` | 0 | 106 |
| `verify-branch-isolation` | 0 | 73 |
| `verify-college-fees-api` (LAST) | 0 | 112 |
| `verify-role-probe` (production build) | 0 | 24/24 |
| `verify-college-fees-page` (offline) | 0 | 366 (360 in the production-build batch, before section 16) |
| `verify-college-fees-data` / `-logic` / `-routes` (offline) | 0 | 11 / 21 / 22 |
| `npm run typecheck` / `npm run build` | 0 | 0 errors / 187 pages |

**Mutation proofs**: 7e's four (a school-read leak, a college-read leak, a mis-tagged ledger row, and
GUARDIAN added to the read allow-list) plus **three new ones for the print pages** made this session (the
statement's branch guard deleted; the receipt ignoring `?receipt=`; the tag matcher matching any charge) —
each fails its verifier and each file was restored byte-identically (`sha1sum -c` OK).

### Two honest caveats

- **The probe has an ordering precondition** (found by re-running it): it asserts the fixture's college
  spine, and `verify-college-fees-api` resets that spine on purpose, so run the probe **before** it or
  re-create the fixture. Both the failing attempt (20/24) and the pass (24/24) are in
  `proof/7f/production-role-probe-24-of-24-recheck.txt`.
- **`verify-tenant-isolation` / `verify-branch-isolation` read 106 / 73 here, not the 97 / 65** in the
  Phase 6 record — 7c's college fee sweep grew them; they were re-run **unchanged** by 7e.

### The one thing to do next

~~**Review and commit the Phase 7 working tree.**~~ **DONE 2026-10-14** — see the close-out block below.
Then Phase 8 (`8-pre` first — the course↔teacher link) and 9a/9b/9c (college dashboard / reports /
import), plus the two remaining go-live items: a **hosted** role-probe run and the multi-instance
read-cache question (the production-line decision is made — `main`).

---

## 🔁 Session — 2026-10-14 (Phase 7 committed; the documentation drift swept)

**Docs and records only — nothing under `src/` or `scripts/` was touched in this session.**

1. **Phase 7 was committed and pushed** to `integration/main-into-college`: `f542405` (code + verifiers)
then `efb97c0` (docs). `origin/main` is untouched at `f4ed2a5`; nothing was deployed.
2. **The Phase 7 evidence records were committed** (`946e4e3`): `proof/7e/` and `proof/7f/` (the reports and
their text transcripts) and the six `proof/7d/mutate-*.txt` transcripts — so the links the docs make into
`proof/` resolve in a fresh clone. Binary media (PNG/WEBM) is deliberately no longer committed; the rule
is written in `proof/README.md` and in `.gitignore`.
3. **The rollback text was corrected (pilot P3, `e5ee07d`).** Every statement that said "unset
`FIRESTORE_DATABASE_ID` to roll back" is now marked superseded: a live environment REFUSES an unnamed or
`"(default)"` database, and the rollback is the App Hosting console's **Rollback** button.
4. **The production line is recorded as decided:** the **`main`** branch — backend `smart-school-erp-1`,
live branch `main`, automatic rollouts on, **no console variable overrides** (owner console,
2026-10-11). `origin/main` = `f4ed2a5`; `deploy/app-hosting` = `96f4762` and is **not** the live branch.
5. **The "untracked docs" claim was corrected:** `docs/PHASE1-DECISION-WORKSHEET.md` and
`docs/SMOKE-FAILURES.md` **are tracked** (they entered git in `dfa41aa`); the sentences calling them
untracked are fixed here, in `docs/COLLEGE-STATUS.md` and in `docs/ENVIRONMENTS-AND-SECRETS.md`, and the
"Phase 7 is uncommitted" reading is corrected in `docs/COLLEGE-STATUS.md` too.

**One known-red class remains untouched:** the four known-failing browser checks, `verify-read-cache` (1)
and `verify-routine-config` (2/3) are unchanged and are still red; nothing about them is claimed green.

---

## 🔗 Session — 2026-10-14 (Phase 8-pre: the course↔teacher link)

**Code + verifier + records.** `8-pre` is the first step of Phase 8 by the owner's answer Q8
(2026-10-11, docs/COLLEGE-DECISIONS.md §24.8/D-CA-4): the college could not answer "who teaches this
course?" at all — no `teacherId` under `src/app/api/courses`, `src/app/api/course-registrations` or
`src/lib/college-*.ts`. Both teacher-facing college surfaces were blocked on it.

1. **The pure module** — `src/lib/course-teachers.ts`: the derived id
   `ct_<courseId>_<teacherId>` (both halves required and trimmed; an empty half THROWS), the strict
   assignee allow-list (`["TEACHER"]`), a list normaliser, and the two refusal sentences. No imports at
   all, so an offline verifier, a route and (later) a teacher-facing component share one rule.
2. **The store** — `COLS.courseTeacher` → `courseTeachers` (a CALLER-SUPPLIED derived id, so NO
   `idFor`/`idForCreate` entry, like `promotionRun`), a NEW `RELS.courseTeacher` key
   (`school`/`branch`/`course`/`teacher`, every fk a stored field) and the `prisma` accessor. **No
   pre-existing RELS body was touched** — 6b's and 7b's additive proofs hash them, and they still
   reproduce (COLS 79, RELS 75, prisma 79). `branchId` is inherited from the COURSE.
3. **The API** — `GET`/`POST`/`DELETE /api/courses/[id]/teachers` in the college guard order (session →
   target tenant → `requireCollege` → `can(courses, view|full)` → id → `writeGuard` → course-in-tenant
   (404) → `canAccessBranch` → the teacher/role rule), audited, invalidating. Re-assigning is an
   idempotent `200 already: true` that writes nothing; unassigning an unassigned teacher is a 404. No
   new allow-list module: the link is a catalogue write, so it reuses `courses` — which is what makes the
   staff-only ruling structural (REGISTRAR read-only; ACCOUNTANT/TEACHER/GUARDIAN/STUDENT 403).
   `/api/courses/[id]`'s DELETE now refuses a course that still has a teacher (400), so no link row can
   be orphaned.
4. **The guarded lists** — `courseTeacher` joined `COLLEGE_MODEL_RE` (a strengthening) and both additive
   data verifiers' `LATER_MODELS`. `verify-college-routes` now prints **23 route files, 50 gated
   handlers** (was 22/47).
5. **The proof** — `scripts/verify-course-teachers.mjs` (**54 checks**), guarded and HTTP, wired into
   `suite-all.mjs` in the college group before `verify-college-fees-api` (which resets its tenant LAST).
   Offline it IMPORTS the module and pins the tree; live it proves assign/idempotence/list, the
   foreign-teacher + non-teacher + ghost refusals, the foreign-course 404, the role matrix, branch and
   tenant confinement, unassign, and the course-delete block — with bracketed document counts and
   teardown of everything it created.

**Numbers (fresh state: wipe → setup → seed → seed-kit-demo → isolation-fixture → app restarted after
it).** `verify-course-teachers` exit 0, **54 checks**, 37 s. Re-run unchanged beside it:
`verify-mode-mixing` 33, `verify-college-enrollment` 40, `verify-course-registrations` 50,
`verify-college-permissions` 8, `verify-college-fees-api` 112/112, `verify-college-routes` (23/50),
the two data proofs (11 / 8 checks, their recorded baselines intact), `verify-nav-scope` (nav snapshot
unchanged). `npm run typecheck` 0 errors.

**The boundary, stated so it is not over-read:** 8-pre adds the LINK, not a screen and not a
teacher-facing read. v1 attendance marking is still staff-only and the register (ca-0…ca-6) is the next
step. The record is `proof/8pre/REPORT.md`.

---

## 🔁 Session — 2026-10-14 (Phase 8 ca-0: the college attendance allow-list)

**Code + verifier + records.** ca-0 is D-CA-7's first register step (docs/COLLEGE-DECISIONS.md §24.8):
the ONE allow-list module every later attendance route, screen and print page must consult. It exists
because the school's `attendanceMarks` module cannot be the gate — it grants TEACHER `entry`, GUARDIAN
`view` and STUDENT `viewOwn`, so reusing it would let a teacher mark a college register (post-v1,
D-8P-5) and would expose every course register to every family. D-CA-4's ruling is **v1 marking is
staff-only**.

1. **The module** — `src/lib/college-attendance-access.ts` (the results/fees pattern, no imports at all):
   WRITE = SUPER_ADMIN, SCHOOL_ADMIN, BRANCH_ADMIN; READ = the writers + a read-only REGISTRAR; REFUSED
   both directions = TEACHER, GUARDIAN, STUDENT, ACCOUNTANT, LIBRARIAN, FRONT_DESK. No ACCOUNTANT —
   attendance is not money, so the fee rule does not transfer. TEACHER stays out in v1 (D-8P-5).
2. **The proof** — `scripts/verify-college-attendance-access.mjs` (**18 checks**, offline, wired into
   `suite-all.mjs`'s pure list). It IMPORTS the module (`registerHooks`) and pins: purity; the exact
   allow-lists; the full role × direction truth table (raw junk refused); the measured "narrower than
   `attendanceMarks`" proof (the matrix admits TEACHER/GUARDIAN/STUDENT, the rule refuses all three); the
   REGISTRAR read-only; the two refusals; and ca-0's boundary — no file under `src/` consumes the module
   yet, the school's `/api/attendance` route is untouched, and no `courseAttendance` exists in `db.ts`
   (ca-2 owns that pin's removal).
3. **The boundary** — no route, no page, no nav entry, no `COLS`/`RELS` entry, no consumer. The register
   (ca-1…ca-6) is next.
4. **Unchanged beside it (2026-10-14):** `verify-college-permissions` **8** (no new `MATRIX` module — so
   no count change), `verify-nav-scope` exit 0 (snapshot byte-identical), `verify-college-routes`
   **23/50** (no route added), `npx tsc --noEmit` 0 errors.

---

## 🔁 Session — 2026-10-14 (Phase 8 ca-1: the pure college attendance logic)

**Code + verifier + records.** ca-1 states the rules every later attendance step must agree on
(D-CA-1…D-CA-3; Q7/Q8), with no db access, no routes, no screens and no nav.

1. **The module** — `src/lib/college-attendance.ts` (dependency-free, the `course-teachers.ts` /
   `registration-status.ts` design): the derived row id `ca_<courseId>_<dateKey>_<slot>_<studentId>`
   (trimmed parts, an empty part THROWS, an invalid slot THROWS); the date-key mirror of `db.ts`'s local
   `dateKey` (ca-2 owns the export-or-mirror decision and the assertion against the original); the slot
   rule (absent = 1, whole numbers 1..n, junk reads as null); the four statuses verbatim
   (PRESENT/ABSENT/LATE/LEAVE, with UNMARKED as the read-only placeholder, never stored); the
   APPROVED-registration roster (duplicates collapsed, blanks dropped, read by the SAME reader college
   fees bills by); and the notify decision (`shouldNotifyAbsence`: only a NEW absence today, so a
   corrected register never re-mails a family).
2. **The proof** — `scripts/verify-college-attendance-logic.mjs` (**30 checks**, offline, wired into
   `suite-all.mjs`'s pure list). It IMPORTS the module (`registerHooks`) and pins purity; the date-key
   probe table plus the original helper's shape in `db.ts`; the id's composition/trimming/idempotence
   and every throwing case; the slot reader's table; the statuses and refusals; the roster (approved
   only, duplicates, blanks, order, the fees-reader agreement on one probe table); the full notify
   transition table; and ca-1's scope — no route, page or component consumes it yet, and the school's
   own `/api/attendance` never reaches for it.
3. **The boundary** — no `COLS`/`RELS` entry (ca-2), no roster/session API (ca-3), no register screen or
   nav entry (ca-4), no notification sent.
4. **Unchanged beside it (2026-10-14):** `verify-college-attendance-access` **18** (its pins still hold),
   `verify-nav-scope` exit 0 (snapshot byte-identical), `verify-college-routes` **23/50** (no route
   added), `npx tsc --noEmit` 0 errors.

---

## 🔁 Session — 2026-10-14 (Phase 8 ca-2: the courseAttendance data layer)

**Code + verifier + records.** ca-2 is D-CA-7's data-layer step for the college register: the model in
the store, the date-key decision ca-1 left open (D-CA-1), and the guard lists every later step reads.
No route, page, nav entry, fixture row or consumer — those are ca-3/ca-4.

1. **The model** — `src/lib/db.ts`: `COLS.courseAttendance = "courseAttendances"`, a NEW
   `RELS.courseAttendance` key (`school`/`branch`/`course`/`student`; `branchId` inherited from the
   COURSE, exactly as `courseTeacher` inherits it) and the shim accessor `prisma.courseAttendance`. NO
   `idFor`/`idForCreate` entry — the id is the caller's derived
   `ca_<courseId>_<dateKey>_<slot>_<studentId>`. No pre-existing `RELS` body was edited, and both
   additive data proofs still hash them to their recorded baselines.
2. **The date-key decision** — the mirror STAYS in `college-attendance.ts` (importing `db.ts` would break
   its pinned no-imports purity and drag firebase-admin into the ca-4 register screen), and the
   assertion is now real: `verify-college-attendance-logic` reads `db.ts`'s `dateKey` declaration, erases
   its type annotations with Node's own `stripTypeScriptTypes`, executes it with `new Function` and
   compares it with the mirror date by date on the same probe table. **31 checks** (30 + the execution
   check).
3. **The guards** — `courseAttendance` joins `COLLEGE_MODEL_RE` in `verify-college-routes.mjs` (a
   strengthening) and `LATER_MODELS` in BOTH additive data proofs (fees-data now reports COLS 80 /
   RELS 76 / prisma 80, results-data the same, every recorded baseline reproducing);
   `isolation-fixture.mjs` sweeps `courseAttendances` in its owned list AND in its schoolId backstop (a
   derived `ca_…` id dodges the `zziso-` prefix sweep); ca-0's "db.ts carries no `courseAttendance`"
   pin is removed with the change that owns it — `verify-college-attendance-access` **17** (was 18).
4. **The segment is ca-3's** — `COLLEGE_API_SEGMENTS` deliberately does NOT list `course-attendance`
   yet: the route guard fails a listed segment with no directory and the fees data proof pins the list
   to directory-existence, so the entry lands with ca-3's route directory, exactly as `course-results`
   did in 6c and `college-fees` did in 7c. The approved deferral is recorded in §28.
5. **Unchanged beside it (2026-10-14):** `verify-college-fees-data` **11**, `verify-college-results-data`
   **8**, `verify-nav-scope` exit 0 (snapshot byte-identical), `verify-college-routes` **23/50** (no
   route added), `npx tsc --noEmit` 0 errors. `suite-all.mjs`, the emulator and the server were NOT run:
   ca-2 has no HTTP surface.
---

## 🔁 Session — 2026-10-14 (Phase 8 ca-3: the college attendance API)

**Code + verifier + records.** ca-3 is D-CA-7's API step for the college register: the roster read, the
session save and the per-student history, plus the segment entry ca-2 deferred. No screen, no nav entry,
no family-facing read (ca-4…ca-6).

1. **The three operations** — `src/lib/college-attendance-server.ts` (the shared wrapper: `targetSchoolId`,
   `requireCollegeAttendanceRead/Write` over ca-0's rule, the session-date reader, the roster machine over
   ca-1's `approvedRosterStudentIds`, the stored-session map and the summary) and two route files:
   `GET/POST /api/course-attendance` (the register and its save) and
   `GET /api/course-attendance/history` (one student's sessions in one course). Every handler runs the
   college guard order — session → target tenant → `requireCollege` → the ca-0 allow-list → parameters →
   `writeGuard` (save only) → the course/student in-tenant and in-branch (else **404**, never a 403) —
   and `verify-college-routes` now counts **25 route files / 53 gated handlers** (was 23/50).
2. **The save's promises are measured, not asserted** — the derived id
   `ca_<courseId>_<dateKey>_<slot>_<studentId>` is the identity (`upsert({ where: { id } })` inside ONE
   `prisma.$transaction`), every row is validated BEFORE any write (off-roster student, unknown status,
   duplicate student → 400 by name, and a mixed request writes NOTHING), `UNMARKED` is skipped, and the
   slot is IN the key (a second session the same day is a second register). D-CA-3: only a NEW absence
   notifies, through the school's own `notifyGuardianOfStudent`, fire-and-forget, with the copy naming
   the course and the slot and **no link** (no family page exists yet); no real message is ever sent —
   the proof reads the notification rows.
3. **The segment landed with its directory** — `COLLEGE_API_SEGMENTS` gains `course-attendance` in the
   change that creates `src/app/api/course-attendance` (ca-2's recorded deferral, §28 → §29), and
   `verify-college-fees-data` check 8 was re-scoped to a `laterSegments` list (`college-fees`,
   `course-attendance`) with every other check intact — **11** checks, exit 0. ca-0's and ca-1's
   "no consumer yet" scope pins are replaced by the exact consumer set (the wrapper; the two routes plus
   the wrapper) with the reason recorded, and nothing else in those proofs moved (**17** / **31** checks).
4. **No composite index** — every query is scalar equality on one or two fields; the session filter is
   in memory, `firestore.indexes.json` is untouched, and the verifier pins that no `courseAttendance`
   field appears there.
5. **The proof** — `scripts/verify-course-attendance.mjs` (**46 checks**, new, wired into `suite-all.mjs`):
   offline tree pins plus a live HTTP proof from a wiped emulator, `setup` + `seed` + `seed-kit-demo` +
   `isolation-fixture create`, the app restarted after the wipe: every role × read/write (the platform
   SUPER_ADMIN's `?schoolId=` read and mark included — its credentials come from `demo-accounts.ts`, no
   password is written into the verifier), the roster, the
   save and its idempotence, the slot, the whole-request atomicity, the empty-roster course, tenant +
   branch 404s, the history and the new-absence-only notify — all bracketed by document counts, with the
   run's own `zzcta-…` students/registrations/rows/notifications deleted on the way out and the fixture's
   rows untouched. **46/46, exit 0.** It runs once per app start (like `verify-college-fees-api`): its
   fixture rows are written raw, and the app's pull memo can only be invalidated by the app's own writes;
   `suite-all.mjs` wipes + restarts per verifier, so the suite order is unaffected.
6. **Unchanged beside it (2026-10-14):** `verify-course-teachers` **54**, `verify-college-attendance-access`
   **17**, `verify-college-attendance-logic` **31**, `verify-college-results-data` **8**,
   `verify-nav-scope` exit 0 (snapshot byte-identical), `verify-college-permissions` **8**,
   `npx tsc --noEmit` 0 errors. `suite-all.mjs` was NOT run (the stage's rule); the eight verifiers were
   run individually, the two server-backed ones each after their own wipe + seed + fixture + app restart.
---

## 🔁 Session — 2026-10-14 (Phase 8 ca-4: the register screen + nav)

**Stopped on a documented conflict first, then built to the owner's ruling.** D-8P-5 (§25) says "the
teacher-facing read is the register's own step (D-CA-7's ca-4)" while D-CA-4/Q8/§24.6/§23.6, PROGRESS's
own 8-pre note and ca-0's built rule keep v1 staff-only (ca-0 refuses `TEACHER` both ways and cites
D-8P-5 for it; ca-3's live proof pins TEACHER 403/403). The stage was stopped BEFORE any edit and the
question put to the owner, who ruled: **ca-4 is staff-only, and D-8P-5's clause is PLACEMENT, not
scheduling** — a post-v1 teacher read would live in the register's step, but v1 adds none. Recorded in
§30 so the sentence cannot be read back as a v1 commitment.

1. **The screen** — `src/app/dashboard/course-attendance/page.tsx`: course picker (the API's own list),
   date, session slot (default 1), roster grid with the four statuses and an optional remark, one save.
   College-gated before any read (a school-mode tenant and a refused role issue NO request); the API
   stays the real gate. A `REGISTRAR` sees it read-only (no save control); the save button exists only
   when ca-0's WRITE list admits the caller.
2. **The view module** — `src/lib/college-attendance-view.ts` (the `college-results-view.ts` pattern),
   pure, importing ca-1's module and nothing else: the mark vocabulary IS ca-1's four stored statuses
   (`UNMARKED` never an option, never sendable), `rowsToSave` can only send rows the API handed over (ids
   it served, `UNMARKED`/junk skipped and counted, a blank remark → `null`), `slotFromInput` IS
   `readCourseAttendanceSlot`, the save message states written/left-unmarked/notified (D-CA-3's count —
   the screen never decides who is notified), and a refusal keeps the API's own sentence. The page
   therefore carries no status literal and no role list of its own.
3. **The ONE nav entry** — `/dashboard/course-attendance` (`requires: "COLLEGE"`, group `academics`,
   added to `SCHOOL_GROUP_OF` explicitly) for `SCHOOL_ADMIN`, `BRANCH_ADMIN` and `REGISTRAR` — ca-0's
   READ roles that own a dashboard nav. `SUPER_ADMIN` has none (its registry is the platform console)
   and the `ACCOUNTANT` is deliberately not offered it (ca-0 refuses the accounts office).
   **`scripts/nav-scope-snapshot.json` is NOT re-recorded**: it is the frozen PRE-Phase-1 school
   registry, the college items are stripped before every comparison against it, and check 3's school-only
   proof is what would fail if it were edited — D-CA-7's "the nav snapshot unchanged" is correct, and the
   stage's "re-record it" premise is corrected in §30.
4. **The pins** — `verify-nav-scope`: college href list EIGHT, marker product **25** (8 + 8 + 8 + 1),
   exact-group assertion covers `academics`, and **check 10 is new** (the register entry carried by
   exactly ca-0's READ roles with a dashboard nav; never by TEACHER/GUARDIAN/STUDENT/ACCOUNTANT/
   LIBRARIAN/FRONT_DESK in any mode; not by SUPER_ADMIN; not lost by REGISTRAR; every ca-0 WRITE role
   with a dashboard nav can reach it). ca-0's consumer pin now names the wrapper **and** this screen;
   ca-1's names the two routes, the wrapper and the new view module (its direct-consumer scan excludes the
   `-access`/`-view` names by prefix, with the reason recorded). No other check was weakened.
5. **The proof** — `scripts/verify-college-attendance-page.mjs` (**36 checks**, new, offline, wired into
   `suite-all.mjs`'s pure list): the view module's ONE import and purity, the vocabulary and its words and
   tones, the slot reader against ca-1 on a probe table, the payload's subset/order/three-field shape and
   its skipping, the save truth table (including the notification count), the count lines, the summary
   strip, the course label, the refusal wording per status, and — statically — the page's use of ONE rule,
   ONE endpoint, ONE vocabulary. It says in its own header that it does **not** prove the page renders
   (no DOM, no React, no browser), and no browser pass of the screen has been made yet — ca-3's live
   verifier proves the API under it.
6. **The course↔teacher admin picker stays out of ca-4** — D-8P-5 places it "with the course screens" but
   D-CA-7's ca-4 line schedules only the register and its nav entry, so the stage's own condition was not
   met and it was left for its own stage rather than half-built; `/api/courses` keeps its exact shape and
   nothing in this change calls the teacher routes.
7. **Unchanged beside it (2026-10-14):** `verify-course-attendance` **46** (the API was not touched;
   re-run from a clean state, exit 0), `verify-college-attendance-access` **17**,
   `verify-college-attendance-logic` **31**, `verify-college-fees-data` **11**,
   `verify-college-results-data` **8**, `verify-college-routes` **25/53**, `verify-college-permissions`
   **8**, `npx tsc --noEmit` 0 errors. `suite-all.mjs` was NOT run (the stage's rule).
