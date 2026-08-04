# 🎓 Smart School ERP & Parent Communication System

A **multi-tenant SaaS** platform for kindergartens, pre-schools, private schools and coaching institutes. It unifies school management, teacher workflows and guardian communication in one responsive web application.

Built with **Next.js 15 (App Router)**, **TypeScript**, **Firebase** (Firestore + Cloud Storage) and **Tailwind CSS 4**.

---

## ✨ Features

| Module | Highlights |
|---|---|
| **Authentication** | JWT sessions, role-based access, bcrypt password hashing, OTP/PIN QR login |
| **Super Admin** | School create/delete/activate, subscription status, revenue dashboard, global settings, audit logs |
| **School Admin** | Students, teachers, classes, sections, subjects, routine, exams, notices, fees, ID cards, reports |
| **Teacher** | Attendance, daily remarks (quick ratings), homework publishing, exam marks entry, result publishing, parent messages |
| **Guardian / Parent Portal** | QR-code login, daily report, attendance, homework, remarks, results, report card PDF, fees, notices, performance graphs |
| **QR System** | Unique QR per student; guardian verifies with PIN or registered phone number |
| **Exam & Grades** | BD-style grading (A+→F), GPA, positions, subject-wise marksheet, printable report card |
| **Fees** | Monthly/admission fees, partial payments, receipts, payment history, due tracking |
| **Reports** | Student list, attendance, exam, fee, teacher & class reports with **PDF** and **Excel** export |
| **Printables** | Student **ID card** with photo + QR + school logo, and **PDF report cards** |
| **Security** | School data isolation, role permissions, file upload validation (Cloud Storage), audit logging |
| **Future-ready** | Notification hooks (SMS/push/email), AI remark generator & progress summaries, bKash/Nagad/card payments |

---

## 🚀 Quick Start

### Prerequisites

- **Node.js 20+** and npm
- A **Firebase project** (free Spark tier is fine) with **Cloud Firestore** and **Cloud Storage** enabled

### 1. Create a Firebase project & service account

1. Go to [Firebase Console](https://console.firebase.google.com) → **Add project**.
2. In **Build → Firestore Database**, create a database (production mode).
3. In **Build → Storage**, get started with Cloud Storage.
4. In **Project settings → Service accounts**, click **Generate new private key** (downloads a JSON file).

### 2. Configure environment variables

Copy `.env.example` to `.env` and fill in the values from the service-account JSON:

```bash
cp .env.example .env
```

| Variable | From | Example |
|---|---|---|
| `FIREBASE_PROJECT_ID` | service account `project_id` | `smart-school-erp` |
| `FIREBASE_CLIENT_EMAIL` | service account `client_email` | `firebase-adminsdk-xxxxx@smart-school-erp.iam.gserviceaccount.com` |
| `FIREBASE_PRIVATE_KEY` | service account `private_key` (keep the `\n` escapes or paste as a JSON string) | `-----BEGIN PRIVATE KEY-----\n...` |
| `JWT_SECRET` | your own | any long random string |
| `APP_URL` | your public origin | `http://localhost:3000` |

> 💡 Easiest: keep the downloaded JSON as `service-account.json` at the project root and set `GOOGLE_APPLICATION_CREDENTIALS=./service-account.json` — the app auto-detects it.

### 3. Deploy Firestore & Storage security rules

```bash
npm install -g firebase-tools
firebase login
firebase use <your-project-id>
firebase deploy --only firestore:rules,storage
```

### 4. Seed demo data

```bash
npm install
npm run setup        # seeds Firestore (idempotent — safe to re-run)
```

### 5. Run the app

```bash
npm run dev        # http://localhost:3000
```

Or run a production server:

```bash
npm run build && npm run start
```

---

## 🔑 Demo Accounts

| Role | Email | Password |
|---|---|---|
| **Super Admin** | `admin@smartschool.com` | `Admin@123` |
| **School Admin** | `principal@sunrise.edu` | `School@123` |
| **Teacher** | `teacher@sunrise.edu` | `Teacher@123` |
| **Guardian** | `guardian1@demo.com` | `Guardian@123` |

**QR login:** open `/qr/<token>` on any student's page (token is visible on the student detail page) and verify with the student's **PIN** or the guardian phone number.

Seed data includes 1 demo school, 5 classes, 2 sections each, 7 subjects, 4 teachers, **14 students**, 8 days of attendance, a full exam with marks, notices, routine, messages and 56 fee records.

---

## 🧱 Project Structure

```
src/
├── app/
│   ├── admin/            # Super admin console (schools, revenue, settings)
│   ├── dashboard/        # School admin console (all management modules)
│   ├── teacher/          # Teacher panel (attendance, remarks, homework, marks)
│   ├── parent/           # Guardian portal
│   ├── qr/               # QR landing + token verification
│   ├── print/            # Printable ID cards & report cards
│   └── api/              # REST API routes (auth, students, exams, fees, …)
├── components/           # Shared UI (Shell, ui, MessagesPanel, PrintActions)
├── lib/                  # auth, firebase, Firestore data layer, grades, QR, helpers
└── middleware.ts         # Role-based route guarding (JWT)
scripts/
├── setup.mjs             # One-command Firestore seed
└── seed.mjs              # Idempotent demo data seeder (Firestore)
```

---

## 🔌 API Overview

All routes live under `/api/*`, return `{ data }` or `{ error }`, and require a session cookie (`ss_token`).

| Area | Routes |
|---|---|
| Auth | `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` |
| Schools | `GET/POST /api/schools`, `GET/PATCH/DELETE /api/schools/[id]` |
| Students | `GET/POST /api/students`, `GET/PATCH/DELETE /api/students/[id]` |
| Teachers | `GET/POST /api/teachers`, `GET/PATCH/DELETE /api/teachers/[id]` |
| Classes/Sections/Subjects | `GET/POST /api/classes`, `/api/sections`, `/api/subjects` |
| Routine | `GET/POST /api/routines` |
| Attendance | `GET/POST /api/attendance` (query by `classId`, `sectionId`, `date`) |
| Remarks | `GET/POST /api/remarks` |
| Homework | `GET/POST /api/homework`, `PATCH/DELETE /api/homework/[id]`, `POST /api/homework/[id]/submit` |
| Exams | `GET/POST /api/exams`, `GET/PATCH/DELETE /api/exams/[id]` |
| Marks | `POST /api/marks` (bulk upsert with automatic grade/GPA calc) |
| Notices | `GET/POST /api/notices` |
| Fees | `GET/POST /api/fees`, `POST /api/fees/[id]/pay`, `GET/PUT /api/fees/settings` |
| Messages | `GET/POST /api/messages` |
| Guardians | `GET /api/guardians` |
| QR | `GET /api/qr/[token]`, `POST /api/qr/verify` |
| Uploads | `POST /api/uploads` (validated, max 10 MB → Cloud Storage) |
| Stats | `GET /api/stats` (dashboard widgets) |
| Settings | `GET/PUT /api/settings` |

---

## 🗄️ Database (Firestore)

- **Provider:** Cloud Firestore (NoSQL document database)
- **Data layer:** `src/lib/db.ts` exposes a **Prisma-compatible API** (`findMany`, `findUnique`, `findFirst`, `upsert`, `create`, `update`, `$transaction`, `include`/`select`, `orderBy`, `count`, `deleteMany`) backed by Firestore — so all route business logic is unchanged.
- **Collections:** `schools`, `users`, `teachers`, `students`, `classes`, `sections`, `subjects`, `assignments`, `routines`, `attendance`, `remarks`, `homeworks`, `submissions`, `exams`, `marks`, `notices`, `feeSettings`, `fees`, `payments`, `messages`, `auditLogs`, `settings`
- **IDs:** deterministic (e.g. users keyed by email hash, attendance by `studentId_date`) so seeds and upserts are idempotent
- **Isolation:** every tenant record carries `schoolId`; all queries filter by the session's school
- **Files:** student photos & homework attachments go to **Cloud Storage**, not local disk (App Hosting filesystems are ephemeral)

### Scripts

```bash
npm run setup        # one-command seed (Firestore)
npm run seed         # (re)seed demo data
```

---

## ☁️ Deployment Guide (Firebase App Hosting)

1. **Push the code to a Git repo** (GitHub):

   ```bash
   git init
   git add .
   git commit -m "Firebase edition"
   ```

2. **In Firebase Console → Build → App Hosting**, click **Get started**, connect your GitHub repo, and create a backend (defaults in `apphosting.yaml` are ready — the app builds with `npm ci && npm run build` and serves with `npm run start`).

3. **Add env vars** in App Hosting → your backend → **Environment variables** (from the same values as `.env`):
   - `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY` (JSON-escaped `\n`), `JWT_SECRET`, `APP_URL=https://<your-domain>`

4. **Deploy** the backend; App Hosting gives you a `https://<backend>--<project>.web.app` URL, and you can add a custom domain under **Settings**.

5. **Re-verify rules**: `firebase deploy --only firestore:rules,storage` once more after any rules change.

> ⚠️ Server-side Firestore access uses the Admin SDK, so **Firestore security rules** below only guard direct client access — keep them restrictive (see `firestore.rules`). `JWT_SECRET` must stay consistent across all instances.

---

## 🧪 Validation Commands

```bash
npm run typecheck     # tsc --noEmit
npm run build         # production build (type-safe)
```

---

## 🛠️ Troubleshooting

- **`Could not load the default credentials`** — set `GOOGLE_APPLICATION_CREDENTIALS=./service-account.json` (or the three `FIREBASE_*` env vars). The service account needs **Cloud Datastore User** (or Owner) + **Storage Admin**.
- **Login fails in production over plain HTTP** — the session cookie is `Secure` in production; serve over HTTPS (or temporarily set `NODE_ENV=development`).
- **`FIREBASE_PRIVATE_KEY` parse error** — ensure newlines are literal `\n` inside the JSON string (do not paste raw newlines).
- **Composite-query errors** — the data layer deliberately pushes only **one** equality filter down to Firestore and does the rest in memory, so it never requires composite indexes.
- **Uploads fail on App Hosting** — the uploads route writes to Cloud Storage; make sure Storage rules allow `write` for the admin service account path.
