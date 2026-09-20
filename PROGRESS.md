# 🗂️ Project Progress & Session Resume

> **Read me first** in any new session working on this project.
> Keep this file updated at the end of each working session so the next one resumes instantly.

**Project:** Smart School ERP & Parent Communication System (Multi-Tenant SaaS)
**Location:** `E:\SmartSchoolERP`
**Last updated:** 2026-09-21

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
