# 🗂️ Project Progress & Session Resume

> **Read me first** in any new session working on this project.
> Keep this file updated at the end of each working session so the next one resumes instantly.

**Project:** Smart School ERP & Parent Communication System (Multi-Tenant SaaS)
**Location:** GitHub — `github.com/shufayetahamedt4-collab/smart-school-erp` (any clone works — see "Working from a different PC/device" below)
**Last updated:** 2026-09-24 (late evening) — Firestore region migration CUTOVER COMPLETE & verified; production runs on `smart-school-db` (asia-southeast1)

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

### Rollback procedure (keep until archive retirement)
- Set `FIRESTORE_DB_ID: "(default)"` in `apphosting.yaml`, push → one rollout (~5–10 min) back to the africa database. Local dev: remove the var from `.env`.
- The africa database is untouched and current as of the **final delta copy 2026-09-24 ~18:52 UTC+6** (after it, writes land only in the new DB). Data written to the new DB between cutover and a rollback would need a reverse copy first (run `migrate-firestore.mjs` with source/target swapped, or accept the loss for throwaway data).
- `scripts/migrate-firestore.mjs` / `verify-firestore-parity.mjs` are permanent tools — re-runnable any time (the copy is idempotent upserts; parity fails loudly).

### Notes for future sessions
- **2026-10-08 (≈2 weeks after cutover): delete the africa-south1 `(default)` database** after one last parity spot-check — until then it is the free rollback insurance. Deletion needs delete-protection OFF (it is).
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
