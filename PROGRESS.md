# 🗂️ Project Progress & Session Resume

> **Read me first** in any new session working on this project.
> Keep this file updated at the end of each working session so the next one resumes instantly.

**Project:** Smart School ERP & Parent Communication System (Multi-Tenant SaaS)
**Location:** `E:\SmartSchoolERP`
**Last updated:** 2026-09-18

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
