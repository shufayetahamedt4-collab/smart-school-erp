# 🗂️ Project Progress & Session Resume

> **Read me first** in any new session working on this project.
> Keep this file updated at the end of each working session so the next one resumes instantly.

**Project:** Smart School ERP & Parent Communication System (Multi-Tenant SaaS)
**Location:** `E:\SmartSchoolERP`
**Last updated:** 2026-09-30

---

## 🔁 Session — 2026-09-30 (whole-project bug sweep: tenancy, orphaned money, idempotency — and the queryId/500 lesson)

**Input:** "go through the whole project and find bugs" → a systematic sweep (security/tenancy, data
integrity, money math), each candidate verified against code and live probes, clear-cut bugs fixed
and the rest reported. Follow-ups: fix student-delete orphans, sweep the demo's junk fees, validate
fee-period vs category cadence, and audit the screens that build query URLs by hand.

### 1. Write-integrity bugs fixed in the API routes

- **Remarks appended on every save.** `POST /api/remarks` used `create()` with a random id, so saving
  the same pupil's day twice kept both rows and the sheet showed whichever came back first. It now
  upserts on the canonical id `rm_<studentId>_<YYYY-MM-DD>` (new `remarkId()` export in `lib/db.ts`),
  validates the roster, sweeps legacy duplicates, returns `{saved, replaced}`, and GET loads the
  day's remarks separately (the old `take:1` include had no `orderBy`, so it could show the replaced
  value).
- **Fee generation was neither idempotent nor cadence-aware.** `/api/fees/generate` now derives a
  deterministic row id per (student, category, period) — `fee_<studentId>_<hash>` — and skips rows
  that already exist; a `periodShapeOk` gate refuses to bill a MONTHLY category under `2026` or a
  YEARLY one under `2026-09`, returning the skipped heads in a `mismatched` array (dry-run preview,
  result and audit log all carry it). The Structure page renders an amber warning and a conditional
  footer ("Nothing to bill — the selected fee does not bill for PERIOD.").
- **Leave decisions were re-decidable.** `PATCH /api/leave-requests` now 400s on a bad `decision`
  and 409s on a non-PENDING request instead of silently REJECTing it again.
- **Cross-tenant writes and deletes.** `POST /api/payments` (fee's schoolId), `POST /api/fees`
  (student's schoolId) and `POST /api/books/issues` (borrower exists + same school) all 404 on a
  foreign id; `DELETE` on subjects/assignments/notices/students is guarded by a school-scoped
  `findUnique` before the cascade, and the cascade `deleteMany`s carry `schoolId` too.
- **Marks roster + subject gap.** `POST /api/marks` drops rows for pupils not on the sheet and —
  when the sheet has no declared columns — restricts `subjectId`s to the school's own subjects
  (previously any id passed when no columns were declared).
- **Attendance POST** scopes its student pull by `schoolId` and writes only branch-visible pupils,
  so the returned `count` matches what was actually written.

### 2. Deleting a pupil no longer orphans the books (DELETE /api/students/[id])

The old delete removed the identity doc alone: fees kept showing due, a stale fee could still be
"paid", and the ledger kept money against a pupil nobody could see. The delete now resolves rows
across 20 collections and commits in 400-op chunks: pupil-owned rows go **with** the pupil (fees,
attendance, daily remarks, submissions, marks, quiz attempts, leave requests, payments, intents,
installments, notifications, messages, meeting bookings, health records, SMS logs — plus the
pupil's login user and its devices/notifications); money/history rows **survive** with the link cut
to null (ledgerEntry → also `feeId:null`, bookIssue → also `fineFeeId:null`, complaint,
conversation, admission). Ends with `invalidateStats(schoolId, "all")` and an audited `STUDENT_DELETE`
carrying the cascade counts. Note: the Students UI only soft-deactivates — this hard delete is
API-level defence (and the harness below proves it).

### 3. Demo data repaired

`scripts/sweep-demo-junk-fees.mjs` (new; dry-run by default, refuses rows that have payments,
intents, installments or a non-FEE ledger entry) removed 32 junk rows — 16 × "maggie — 2026-09" and
16 × "Yearly Study Tour 2026 — 2026-09" — and their 32 FEE ledger entries. The demo sits at
**76 fee rows · billed ৳151,700 · paid ৳98,700 · due ৳53,000**, and the `maggie` category was
deleted through the app's own audited `DELETE /api/fee-categories` (remaining heads: Milad
ONE_TIME, Yearly Study Tour 2026 YEARLY). The junk-fee drift noted on 2026-09-29 is resolved.

### 4. The hand-built query-URL audit, the `queryId` hardening — and the 500 it caused

- **Audit:** most client pages already go through `qs()` (teacher/attendance, dashboard/students,
  dashboard/reports, fees, ledger, admissions); routine/promotion guard their class filter; the
  parent app filters client-side; `guardianChildId()` rejects any id that is not this family's, so
  guardians cannot leak through a literal "undefined". Two real client bugs: **teacher/remarks**
  templated `sectionId=undefined` into the URL (now `qs()`), and **dashboard/id-cards** fetched
  `/api/students?classId=` for the placeholder option — returning the whole school — now skipped
  when no class is chosen.
- **Server side:** `queryId(sp, key)` treats `""`/`"undefined"`/`"null"` as *no filter* and is used
  by the students / attendance / remarks / resources / timetable-slots / homework / exams / gallery
  / routines / fees routes, so a stale client can no longer turn a junk param into a filter whose
  value is that word.
- **The regression and the lesson:** `queryId` was first placed in `src/lib/client.ts`, which
  starts with `"use client"`. Importing a client-only module from route handlers **500s at runtime
  while `tsc` and `next build` both stay green** — every hardened route went down, including
  unfiltered baselines. `queryId` now lives in the server-safe `src/lib/utils.ts` and the 10 routes
  import it from there. Lesson: never let a route import from a `"use client"` module — the
  compiler will not catch it; only a live probe did.

### 5. New harness: scripts/verify-write-integrity.mjs (7 sections)

Remark replace-not-append (+ legacy sweep + sheet read) · leave decisions terminal/explicit ·
cross-tenant write refusals (payments/fees/books/remarks/attendance/marks + unknown subject) ·
delete school-scoping (unknown ids → 404) · the full pupil-delete cascade across 18 collections
(owned rows gone, history survives with links null, login user gone, deleted pupil unbilleable) ·
fee-generation idempotency with a cadence-chosen period (YEARLY → `1900`, else `1900-01`) · the
cadence gate (YEARLY + monthly period → wouldBill 0 + named in `mismatched`). Everything it creates
it removes by document reference; probes use `1900-01` / `2001-01-01` sentinels.

### Verified

After the queryId fix: ✅ `tsc --noEmit` 0 errors · ✅ `next build` clean (132 pages) · ✅
`smoke-all.mjs` ALL GREEN · ✅ `verify-write-integrity.mjs` ALL GREEN (one flake: the login-user
check failed once and passed on re-run; an isolated repro showed `loginRemoved:true` and the user
gone — a transient Firestore read, not code) · ✅ `verify-fees-totals.mjs` ALL GREEN at the new
totals · ✅ a 14-URL junk-param probe (`=undefined`/`=null`) across the school and teacher hosts —
all 200 with junk meaning *no filter* (attendance 400s only when `classId` itself is missing, by
design) · ✅ browser: `/teacher/attendance` with All sections loads 5 pupils and sends a clean URL
(no `sectionId` at all), Section A sends a real id and loads 3.

Earlier in the session, before the queryId edit, the same route batch also passed
`verify-user-secrets.mjs`, `verify-tenant-isolation.mjs` and `verify-guardian-child.mjs`.

### Validation commands to re-run next session

```bash
BUN="$LOCALAPPDATA/Programs/@codebufffreebuff-desktop/resources/bun/bun.exe"
cd <project root>            # this checkout; no Node.js on PATH — always use "$BUN"
"$BUN" x tsc --noEmit        # typecheck
"$BUN" x next build          # production build
("$BUN" x next start -p 3000 > /tmp/sserp-start.log 2>&1 & echo $! > /tmp/sserp.pid)
SMOKE_PORT=3000 "$BUN" scripts/smoke-all.mjs              # run harnesses ONE at a time (slow)
SMOKE_PORT=3000 "$BUN" scripts/verify-write-integrity.mjs
SMOKE_PORT=3000 "$BUN" scripts/verify-fees-totals.mjs
SMOKE_PORT=3000 "$BUN" scripts/verify-user-secrets.mjs
"$BUN" scripts/isolation-fixture.mjs create                # fixture for the next two
SMOKE_PORT=3000 "$BUN" scripts/verify-tenant-isolation.mjs
SMOKE_PORT=3000 "$BUN" scripts/verify-guardian-child.mjs
"$BUN" scripts/isolation-fixture.mjs clean && rm -f scripts/.qa-fixtures.json
# stop the server when done (find the pid with: netstat -ano | grep ":3000" | grep LISTENING):
taskkill //F //PID "$(cat /tmp/sserp.pid)"
```

`.env` holds the live demo's Firebase credentials — local runs mutate the demo data; every harness
cleans up after itself by document reference.

### Still open

- **Nothing is committed or pushed from this session** — the working tree carries the whole batch
  (~24 modified files + the two new scripts). The repo has no git identity configured; earlier
  sessions set `GIT_AUTHOR_*`/`GIT_COMMITTER_*` per command with the repo author
  `Faysal Ahmed Himel`.
- The Firebase App Hosting rollout has not been re-run for this batch.

---

## 🔁 Session — 2026-09-29 (fees part 7: the whole household's dues — and a sweep that proves no secret leaks)

**Input:** "Go through the whole project. We have works to do," → a plan was approved: close the two
open fees defects from part 5 (multi-child `/api/fees`, the un-swept `prisma.user.*` call sites),
verify with the harnesses, commit, no deploy.

### 1. A family with two children only saw one child's fees — fixed at the source

`GET /api/fees` was the **last** self-service route still resolving "the" child with its own inline
`students.find(s => s.guardianUserId === session.id)` instead of lib/auth's family resolver, so
`guardian1@demo.com` (Ayan + Ayesha Rahman) was served one child's rows: the other child's dues were
invisible *and* looked unpayable on `/parent/fees`, while `/api/payments` would have taken the money.

- **`api/fees`** — the GUARDIAN branch now scopes by `guardianChildren(session)`, the one definition of
  "this family's children" (§5.4). `?studentId=` narrows the list to one child and is honoured **only**
  when that child really is this session's (a guessed id can neither widen nor redirect the list); a QR
  session still resolves to its one child. The STUDENT branch is unchanged.
- **`api/stats`** — the guardian's dues figure is family-wide too, so the dashboard and the Fees page
  are the same money. Attendance/homework/remarks stay the acting child's.
- **`parent/fees`** — every row is labelled with its child, a chip per child shows what that child owes
  (All children · Ayan ৳4,400 · Ayesha ৳1,100), the table gains a Student column when there is more than
  one child, the two header cards say what they are scoped to, and the pay dialog names the child.
- **`api/payments`** GET (a guardian's own intent list) is family-wide for the same reason.
- Two dead helpers at the top of `api/fees` (`paymentRowsFor`, `installmentRowsFor` — the GET body has
  its own pulls) were removed.

Verified live on `next start -p 3000` as `guardian1@demo.com`: `/api/fees` returns **12 rows over both
children** (Ayesha 5 fees · ৳8,600 billed · ৳1,100 due + Ayan 7 fees · ৳10,900 · ৳4,400), `/api/stats`
= `{due: 5500, total: 12}` — the same ৳5,500 the page shows — `?studentId=<Ayesha>` narrows to her 5
rows, and `?studentId=<another family's child>` returns nothing. In the browser Ayan's ৳4,400 now has
Pay / Pay-half buttons (the exact "invisible and unpayable" complaint), the chips filter the table, and
the dialog reads *Exam Fee · Ayan Rahman · ৳800 due · Send to: bKash · 01711-000000*.

### 2. The `passwordHash` sweep is now a harness, not a manual review

`/api/guardians` and `/api/staff` were patched by hand last session; the other `prisma.user.*` call
sites had never been audited. There are 40 today.

- **`publicUser()`** (`lib/auth.ts`) is now the single definition of what may leave the API about a user
  account (it strips `passwordHash`, `twoFactorSecret`, `totpSecret`, `backupCodes`/`backupHashes`).
  `api/staff` (GET/POST/PATCH) and `api/guardians` (GET/POST) use it instead of four hand-written
  spreads. A blanket strip inside `lib/db.ts conv()` was rejected on purpose: `auth/login` and the 2FA
  verify path legitimately need `passwordHash`/`twoFactorSecret` out of that same read funnel.
- **`scripts/verify-user-secrets.mjs`** (new) — signs in as each demo role on its own host, deep-scans
  every API response for a forbidden key or a bcrypt `$2a$` **value**, requires a guardian to never
  receive `qrPin`/`qrToken` (staff legitimately may — the student page prints the QR identity), and
  **write-probes** the create/update responses: it creates a staff account, resets its password,
  soft-deletes it, then removes the probe document and reads it back. It self-tests its scanner first,
  because a guard that cannot fail is not a guard.

Result: **ALL GREEN** — super-admin 5/6, school-admin 29/30, teacher 17/19, guardian 19/21 routes
scanned clean (the rest are param-gated or another role's), including the `api/staff` POST → PATCH →
DELETE responses and `/api/students/<child>` read as a guardian.

### 3. `smoke-all` was reporting a stale expectation, not a bug

The hub sweep expected 200 on `/qr` and `/s/sunrise`. On a host that *has* a guardian address
(localhost in development, or a deployment with `APP_DOMAIN`) the middleware deliberately hands both to
the Parents App — a 307 to `parents.<host>` **is** the correct answer there, and the harness now asserts
that handoff while keeping 200 as the expectation for a single-address deployment. `ALL GREEN` after.

### 4. Environment — read this before running anything here

This checkout sits on a machine with **no Node.js on PATH**: `npm`, `npx` and `tsc` do not exist. The
Bun 1.4.2 bundled with the desktop app runs the project fine, so verification here is
`"$LOCALAPPDATA/Programs/@codebufffreebuff-desktop/resources/bun/bun.exe" node_modules/next/dist/bin/next build`
(and `node_modules/typescript/bin/tsc --noEmit`), with the `.mjs` harnesses run the same way plus
`SMOKE_PORT`. `.env` holds the live `amar-e-school` credentials, so a local run and the deployed demo
share one Firestore — harnesses clean up after themselves by document reference.

### Verified
- ✅ `tsc --noEmit` 0 errors · ✅ `next build` success (132 pages, under Bun)
- ✅ `verify-user-secrets.mjs` ALL GREEN — scanner self-test, ~70 routes over four roles, 3 write probes
- ✅ `verify-fees-totals.mjs` ALL GREEN (guardian now 12 rows · ৳19,500 billed · ৳5,500 due, family-wide)
- ✅ `verify-guardian-child.mjs` ALL GREEN, new checks included: `/api/fees` spans the family,
  `?studentId=` narrows/refuses, admin and guardian agree, **dashboard dues === Fees page rows**
  (13 rows · ৳9,821), roster 16 → 16, fixture removed
- ✅ `smoke-all.mjs` ALL GREEN · ✅ browser run as the two-child guardian: 0 console errors, all 200s

### Still open
- The demo tenant has drifted and carries junk fee rows — "maggie — 2026-09", and *Yearly Study Tour
  2026* billed twice under periods `2026` and `2026-09`. Left alone on purpose; worth a tidy-up session.
- `/api/stats` is now family-wide for fees while attendance/homework/remarks stay on the acting child.
  Deliberate (the alternative is two screens disagreeing about money), but a child switcher on the
  dashboard would be a product decision, not a bug fix.
- The live Netlify site still serves the pre-session build; deploying is the next step when wanted.

---

## 🚀 Netlify deploy — the whole project is live

**Site:** https://amar-e-school-demo.netlify.app (project `amar-e-school-demo`, id
`ffc1dfd3-01d5-4cb9-9260-0e98b0e5fe88`, team `shufayetahamed1`).

`netlify.toml` at the repo root is the deploy file for the whole app: `[build] command = "npm run build"`
with `publish = ".next"`, `NODE_VERSION = "22"`, `NEXT_TELEMETRY_DISABLED = "1"`, an explicit
`[[plugins]] package = "@netlify/plugin-nextjs"` (the runtime that turns the App Router build into
Netlify Functions + edge middleware — bare package name only, the CLI rejects `@version` here), and
CDN `[[headers]]` for `/_next/static/*` (immutable), `/sw.js` and `/manifest.json` (no-cache).

Env vars on the site (all seven already set): `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`,
`FIREBASE_PRIVATE_KEY`, `FIREBASE_STORAGE_BUCKET`, `JWT_SECRET`, `APP_URL`, `NODE_VERSION`. Netlify
has no Application Default Credentials, so without these the Admin SDK cannot reach Firestore.

Deployed with `npx netlify deploy --build --prod` (builds locally, uploads `.next`; ~2m30s).

### Verified live
- `GET /api/health` → `ok:true`, Firestore reachable, every env var present, `appUrl` correct.
- Login as `principal@sunrise.edu` → 200; `/dashboard`, `/dashboard/fees`,
  `/dashboard/fees/structure`, `/dashboard/fees/payments` all 200.
- `GET /api/fee-categories` → `Yearly Study Tour 2026` (YEARLY/OTHER) at ৳1,000 across all 5 classes.
- Guardian `guardian6@demo.com` → `/parent`, `/parent/fees` 200; `/api/fees` shows 5 rows, billed
  ৳9,800 / due ৳4,800, including **Yearly Study Tour 2026 — 2026 · ৳1,000 · due 25 Oct 2026 · UNPAID**.
- `GET /api/stats` → ৳151,700 billed / ৳97,700 paid / ৳54,000 due — identical to local.
- `SMOKE_ORIGIN=https://amar-e-school-demo.netlify.app node scripts/verify-fees-totals.mjs` → **ALL GREEN**.

Note: `APP_DOMAIN` is unset, so the deployment runs as the host-agnostic hub (all roles sign in on one
URL and land on their own home). The per-sector subdomains (`school.`/`parents.`/`teacher.`/`admin.`)
need a real custom domain wired to the site; they are not available on the `*.netlify.app` host.

---

## 🔁 Session — 2026-09-27 (fees, part 6: a school-wide one-off fee, from the catalogue to the guardian's screen)

**Input:** "Create a new fee called Yearly Study Tour 2026. For all classes, 1000 taka, due date
10-25-2026. Then open the parents sector, I wanna see if both are connected."

Done end to end on the running local server (`npx next start -p 3123`; a build was re-run first, so
`.next` matches the working tree).

- **Created** category `Yearly Study Tour 2026` (`r_303ded5113a8c75c`, bucket `OTHER`, frequency
  `YEARLY`, active) with `amounts` = **৳1,000 for all five classes** (Class 1–5).
- **Billed it once** via `POST /api/fees/generate` with `period: "2026"`, `dueDate: "2026-10-25"`:
  dry-run `wouldBill: 16 · total ৳16,000`, then wrote **16 fee rows** (one per enrolled student), and
  a re-run returned `created: 0 · skipped: 16` — idempotency holds. Each row carries `paidAmount: 0`,
  `status: UNPAID`, `feeType: OTHER`, `categoryId`, `dueDate` and its own `FEE` ledger entry.
- **Verified the connection in the Parents App** (guardian `guardian6@demo.com` → child Arif Hossain,
  `parents.localhost:3123/parent/fees`): the dashboard's *Fees due* moved ৳3,800 → **৳4,800 / 5 fee
  records**, and the Fee records table gained a row **"Yearly Study Tour 2026 — 2026" · ৳1,000 · ৳0
  paid · due 25 Oct 2026 · Unpaid** with `Pay ৳1,000` and `Pay half (৳500)`. The API agrees (same row,
  `dueDate` `2026-10-25T00:00:00.000Z`).
- **Admin side**: `/dashboard/fees/structure` lists the category "Active" with ৳1,000 against each of
  Class 1–5. `GET /api/fee-categories` matches.
- **Housekeeping**: the leftover QA accountant is gone (`/api/staff` = the baseline 9 rows, no
  `passwordHash` on any row); the forward-looking conjunction in the create call was normalised to a
  plain hyphen in the category note.

This is the first end of the fees chain that started in part 3 — *catalogue → bill → guardian pays* —
walked with a brand-new fee that nobody hand-wrote into the database.

**Still open (unchanged):** the multi-child `/api/fees` defect from part 5 (a guardian with two
children sees only one child's dues) — visible again here, since billing covered both Ayan and Ayesha
Rahman.

---

## 🔁 Session — 2026-09-26 (fees, part 5: opening the Parents App — and two things it exposed)

**Input:** "Open the guardian sector, I wanna see how their payment sector looks now."

Opened the Parents App on `parents.localhost` and verified the part-4 work in the browser: the
**How to pay** card lists the school's channels (bKash 01711-000000 Merchant, Nagad 01811-111111,
Dutch-Bangla Bank with A/C + routing, School counter) with the guardian note, and the Pay dialog shows
`Full ৳1,500 / Half ৳750 / Other amount`, *"Part-payment is allowed — pay what you can now, the rest
stays due."* and **"Send to: bKash · 01711-000000 · Merchant"**. On a child with dues (Arif Hossain,
৳3,800 outstanding across three fees) each unpaid row carries `Pay ৳1,500` plus `Pay half (৳750)`.
The demo channels were re-seeded for this look and are **placeholders** — editable on
`/dashboard/fees/payments`.

### Two real defects the walkthrough exposed

1. **A family with two children only sees one child's fees.** `guardian1@demo.com` (Kamrul Rahman) has
   two children — `/api/parent/siblings` returns *Ayan Rahman* and *Ayesha Rahman* — but `/api/fees`
   resolves the guardian to a **single** student (its own inline `find`, not the shared
   `guardianChildIds`) and serves only Ayesha's rows. Ayan's ৳2,300 of dues are therefore invisible and
   unpayable from the Fees page, even though `/api/payments` (which uses `guardianChildIds`) would
   happily accept a payment for him. `/api/auth/me` and `/api/parent/siblings` then disagree with
   `/api/fees` about which child the screen is about.
2. **`/api/guardians` and `/api/staff` shipped every account's bcrypt hash to the browser.** Both read
   `prisma.user.findMany(...)` with no `select`, and the Firestore shim returns whole documents — so
   `GET /api/guardians` returned `passwordHash` for 10 guardians and `GET /api/staff` for 9 staff
   (plus the POST/PATCH responses for the row just created or edited). Since the demo shares one
   password, a leaked hash is a leaked account. Fixed by stripping the field before the response in
   both routes (`data.map(({ passwordHash, ...rest }) => rest)` and the same on the create/update
   returns), which keeps every other key — verified live: hashes gone, `studentOf` and `branch` still
   present for all rows.
   *Not yet audited:* the remaining ~30 `prisma.user.*` call sites. Most use an explicit `select`
   (`/api/teachers`, `/api/auth/me`) or stay server-side, but this is worth a sweep.

### State

`tsc` clean, `npm run build` clean, `verify-fees-totals` and `smoke-all` ALL GREEN after the fix.

---

## 🔁 Session — 2026-09-26 (fees, part 4: where the money goes, and part-payment as a first-class move)

**Input:** "For online payment, School admin can set their Bkash, Nagad, Bank account numbers which
will be connected to parents… and sometimes some parents give partial fees, it's a BD tradition. In fee
collection this option should be there — suppose a fee is 500, but parent paid 200, 300 due."

### Part-payment already worked — the numbers were never wrong

`lib/ledger.ts confirmPayment()` already did `newPaid = min(billed, paid + amount)` and set `PARTIAL`
when `newPaid < billed`, and the guardian's Pay dialog already had an editable amount. It *had* been
used for real: **৳2,000 collected through the Parents App today** (৳100 + ৳1,400 on a Monthly Fee,
৳500 on an Admission Fee), leaving the demo at ৳135,700 billed · ৳97,700 paid · ৳38,000 due with the
fees page and `/api/stats` still agreeing exactly.

What was missing was that nothing about it was *deliberate*: no split button, no "৳X stays due" line,
and an over-payment was **silently clamped** (`Math.min`), so `confirmPayment` wrote the fee up to the
billed amount while the payment row and the ledger recorded the larger figure — collected money in the
ledger that the fee did not account for. `/api/fees/[id]/pay` did not even clamp: it recorded whatever
was handed to it.

### What was built

- **Payment channels (§10.2)** — `src/lib/fee-channels.ts`: a channel is `{ kind: MOBILE|BANK|CASH,
  label, methods[], number, accountType, accountName, bankName, branch, routingNumber, instructions,
  enabled }`. One channel can serve several methods (a bKash merchant account → `BKASH`), and a channel
  with no method is a valid walk-in counter. `channelDestination()` renders the one line a parent reads.
  Stored on the existing `feeSetting` doc under `channels` (an array of plain objects — the shim's
  `clean()` recurses into both), so no new collection.
- **`/api/fees/settings`** now reads/writes `channels` + `paymentNote` alongside the fee defaults, and a
  partial write only touches the keys sent. Access widened from `role === "SCHOOL_ADMIN"` to
  `can(role, "feePayment", "full")` so the sub-school admin and an assigned accountant can maintain
  them too.
- **`/dashboard/fees/payments`** — the admin screen: add/edit/remove channels, choose which methods each
  answers, show/hide, plus a note for guardians. Sidebar entry for SCHOOL_ADMIN, BRANCH_ADMIN, ACCOUNTANT.
- **Parents App** — a "How to pay" card listing the school's channels (with the note), and the Pay
  dialog now shows **"Send to: <channel>"** with the destination for the chosen method. The method list
  is driven by the channels the school published (so no bKash option until a bKash number exists), and
  falls back to the built-in sandbox list when nothing is configured.
- **Part-payment made explicit** — parents get `Full ৳500 / Half ৳250 / Other amount` and the line
  **"Part-payment: ৳200 now, ৳300 stays due on this fee."**; a `Pay half` shortcut sits under each
  unpaid row. The admin's Collect dialog gained the same buttons, hint and limit.
- **Over-payment is refused, not silently rewritten** — both `/api/fees/[id]/pay` and `/api/payments`
  now return `400 "That is more than the ৳N still due on this fee."` instead of clamping.

### Verified end to end

Against `next start -p 3123`, admin on `school.localhost`, guardian on `parents.localhost`:
four channels configured (bKash merchant, Nagad, Dutch-Bangla Bank, School counter) and visible on the
admin table and the guardian's "How to pay" card; the Pay dialog rendered
`Send to: bKash · 01711-000000 · Merchant …` and offered only bKash/Nagad/Bank (the published methods).
A ৳500 test fee, part-paid **৳200 by the guardian** → fee `PARTIAL`, paid 200, and the row switched to
**Pay ৳300** — the exact scenario in the request. Over-paying ৳400 against the remaining ৳300 was
refused with 400 on **both** the guardian path and the admin Collect path, while the counter's own
৳100 part-collection succeeded (200 bKash + 100 cash = 300 paid, 200 due). All test rows were then
removed (fee, 2 payments, 2 intents, 3 ledger, 2 audit) and the channels reverted to empty, leaving the
demo exactly as the user's own data had it. `tsc` clean, `npm run build` clean,
`verify-fees-totals` and `smoke-all` ALL GREEN — the new page and `/api/fees/settings` are in the sweep.

### Worth remembering

- **A blank channel list is a legitimate state**, not an error: the Pay dialog falls back to the
  sandbox method list and tells the parent to pay at the office. Don't make the method list depend on
  configuration existing.
- `/api/fees` returns `settings` (including `channels`) to every role that can read fees, which is how
  the Parents App gets them — deliberately, since these are the school's published payment details.

---

## 🔁 Session — 2026-09-26 (fees, part 3: the school defines its own fee heads, class by class)

**Input:** "Who is controlling these fees? There are various types of fees — weekly exam fees, monthly
monthly exam fees, yearly exam fees… from class to class fees vary. School admin can fully customise
their fees and add various categories, class-wise. I want they can add options too. These will be
connected to parents sector, because they will collect the fees from them. And sub school admin has
the same facilities and anyone assigned to control this part can control."

### What was missing

Fees could be *collected* and (since part 2) one at a time *added*, but there was no way for a school
to say what its fees **are**. Nothing in the product let an admin define a fee head, price it
per class, or bill a whole month's fees — so "Weekly Exam Fee", "Monthly Exam Fee", "Yearly Exam
Fee" and every local variant had to be typed in student by student. `/api/fee-templates` existed
(per-class line items) but had no UI and no way to turn a template into actual money owed.

### What was built

- **`feeCategory`** — a new shim model (`feeCategories` collection, registered in `lib/db.ts`). A
  category is a fee head the school invents: `name`, `bucket` (the ledger line — TUITION / ADMISSION
  / EXAM / TRANSPORT / HOSTEL / LIBRARY_FINE / LATE_FEE / OTHER), `frequency` (WEEKLY / MONTHLY /
  TERM / YEARLY / ONE_TIME), `optional` (elective, e.g. transport), `active`, an optional `dueDay`,
  a note, and **`amounts`: a `{ classId: amount }` map** — that map is how one fee head is ৳100 in
  Class 1 and ৳150 in Class 2. A class with no entry is simply not charged that fee.
- **`/api/fee-categories`** (GET/POST/PATCH/DELETE) — full CRUD. GET returns the catalogue *and* the
  class list in one request so the editor can draw one amount box per class (and so an ACCOUNTANT —
  who is not allowed to read `/api/classes` — still gets the grid). All four verbs sit behind
  `can(role, "feePayment", "full")`, the same gate as `/api/fee-templates`; the catalogue exposes
  every class's pricing, so it is staff-only, not guardian-readable.
- **`/api/fees/generate`** — turns the catalogue into money owed: `{ categoryIds, classIds?, period,
  dueDate?, dryRun? }`. It walks each chosen category's class amounts, finds the enrolled students in
  those classes and writes an ordinary `fee` row per student (`UNPAID`, `paidAmount: 0`, plus
  `categoryId` and `period`), posting a `FEE` entry to the central ledger for each. It is
  **idempotent** — a `(student, category, period)` triple is billed at most once, so re-running a
  month tops up late enrolees instead of double-charging. `dryRun` returns the exact plan without
  writing a row.
- **`/dashboard/fees/structure`** — the admin screen, with a **New fee** dialog (name, ledger type,
  how it recurs, optional/active, due day, note, and a per-class amount grid) and a **Bill a month**
  panel (pick fees, month, due date, optionally limit to some classes → Preview → Bill). Added
  "Fee structure" to the sidebar for SCHOOL_ADMIN, BRANCH_ADMIN and ACCOUNTANT.

### Why the parents sector needed no work

A generated row is just a `fee`. So it appears in the Fees page, in `/api/fees` for the guardian's
child, in the student's dues, in reports and in the ledger without a single change to any of them —
the Parents App already reads fees. Class scoping rides on `resolveBranchId` / `scopeWhere` for
sub-school (branch) admins, and "anyone assigned to control this" is the existing permission
matrix, not a new hard-coded role list.

### Verified end to end (against `next start -p 3123`, as the demo school admin)

- Created "Monthly Exam Fee (QA)" priced ৳100 for Class 1 and ৳150 for Class 2. The empty-state
  page, the dialog, the per-class grid and the catalogue table all rendered.
- **Preview** (dry run) planned **8 fees · ৳950** — 5 Class-1 students × ৳100 + 3 Class-2 × ৳150 — and
  wrote nothing (`/api/fees` still 60 rows). The ৳950 total is the proof that the class-wise amounts
  are actually applied.
- **Bill** created exactly those 8 rows; **re-running the same month created 0** (8 skipped), while a
  *different* month previewed a fresh 8 — idempotency confirmed.
- **Parents App**: signed in as `guardian1@demo.com` on `parents.localhost`; the new fee appears with
  a Pay button and the guardian's totals moved ৳6,500 → ৳6,600 billed, ৳2,000 → ৳2,100 due.
- **RBAC**: a guardian gets **403** on the catalogue, on create and on generate (and still sees their
  own 2 fee rows). A temporary **ACCOUNTANT** account created through Staff & Roles could reach
  `Fee structure` in the sidebar, GET the catalogue (all 5 classes), POST a category (201), run a
  dry-run (5 to bill) and delete it (200) — so an assigned staff member really does control this part.
- All test data was removed afterwards (fees, ledger entries, audit rows, the category, the QA
  account) and the demo tenant re-checked at baseline: 60 fee rows, billed ৳135,700 · paid ৳95,700 ·
  due ৳40,000, ledger 19 entries, 0 fee categories.
- `tsc --noEmit` clean, `npm run build` clean, `verify-fees-totals` and `smoke-all` ALL GREEN. Both
  the new page and `/api/fee-categories` are now part of the smoke sweep.

### Worth remembering

- **A read can be ~30s stale.** Right after a bulk write, `/api/fees` served a partly-updated snapshot
  (64 rows) before settling at 68 — the memoized collection pull, not a bug in the writer. Restart the
  server (or wait out the TTL) before believing a count straight after a bulk change.
- `/api/classes` still refuses ACCOUNTANT; that is why the catalogue route returns the class list
  itself rather than making the UI call `/api/classes`.
- Billing is explicit, never scheduled. If a school wants "bill every month automatically", that is a
  cron/scheduled-function decision, not something hidden inside this screen.

---

## 🔁 Session — 2026-09-26 (fees, part 2: the fix is live — and admins can finally add a fee)

**Input:** continuation of "run the school admin. We have to do works in fees."

### The live deploy landed

The fees fix (`951f334`) had been pushed and a rollout started when the previous turn was stopped,
so the rollout result was unknown at session start. It had landed:

- `SMOKE_ORIGIN=<live> node scripts/verify-fees-totals.mjs` → **ALL GREEN** (15 checks), every money
  field finite, `paid + due === billed`, `/api/stats` agreeing with the fee list.
- Live demo numbers: **billed ৳135,700 · paid ৳95,700 · due ৳40,000** — the same figures as local.
- `SMOKE_ORIGIN=<live> node scripts/smoke-all.mjs` → ALL GREEN across every role.
- On the live School Admin **Fees** screen the header reads `৳95,700 collected · ৳40,000 outstanding`
  above rows with real values (e.g. Ayesha Rahman: ৳5,000 bill, ৳4,500 paid, ৳500 due, `PARTIAL`).

### What was missing in Fees

The page could *collect* a payment and edit fee settings, but an admin could **not add a fee** to a
student at all — the only fees that existed came from admission. The API was already ahead of the
UI: `POST /api/fees` accepted a fee (title, amount, type, due date, optional installment plan) and
posted a `FEE` entry to the ledger. Tellingly, `dashboard/fees/page.tsx` already imported the `Plus`
icon and never used it — the button had been planned and never wired.

### The change (one file)

`src/app/dashboard/fees/page.tsx` — an **Add fee** action in the page header opens a dialog with a
student picker (lazy-loaded from `/api/students`, same pattern as the library page), title, type
(MONTHLY / ADMISSION / EXAM / TRANSPORT / LIBRARY / OTHER), amount, due date and an installment
count. Installments split the amount evenly with the rounding remainder on the last row, spaced
monthly from the due date, so the parts still sum to the whole. The submit button stays disabled
until a student, a title and an amount above zero are present.

### How it was verified

Against a local `next start -p 3123`, signed in as the school admin: the dialog opened, the student
list loaded (16 students), the disabled→enabled gate behaved, and submitting created the fee
(`POST /api/fees` → `201`, then the list reloaded). Reading the record back: amount ৳900, `UNPAID`,
`paidAmount` 0, with **three installments #1=৳300 (Sep 26) · #2=৳300 (Oct 26) · #3=৳300 (Nov 26)
summing to exactly ৳900**, plus one `FEE 900` ledger entry.

Local and live share one Firestore project, so the test fee was removed again (fee + installments +
ledger + audit rows) and the totals were re-checked back to baseline: 60 rows, billed ৳135,700,
paid ৳95,700, due ৳40,000, ledger 19 entries — `verify-fees-totals` and `smoke-all` ALL GREEN.
`tsc --noEmit` clean and `npm run build` succeeds.

### State

The change is **uncommitted** (one file). Push it and start an App Hosting rollout to take it live.

---

## 🔁 Session — 2026-09-26 (fees: a NaN was eating every total)

**Input:** "run the school admin. We have to do works in fees."

### The bug

The School Admin **Fees** page showed `৳0 collected · ৳0 outstanding` above a table of 60 rows
carrying ৳1,500 / ৳5,000 amounts. The dashboard and the branch monitor said ৳0 too. Nobody could
trust a single money figure in the app.

Root cause, three layers deep:

1. **Data.** Fee rows existed with `paidAmount` **missing** (key absent), `null`, or **NaN** stored.
   NaN is a legal Firestore double, and JSON turns it into `null` on the way out, which is why the
   API looked like it was returning nulls.
2. **Reader.** `Number(undefined)` is `NaN`, and one `NaN` poisons an entire `reduce` —
   `0 + 1 + NaN = NaN` — so every total rendered through `fmtMoney(NaN)` = **৳0**. The table looked
   fine only because each cell was formatted on its own.
3. **Writer.** `lib/ledger.ts confirmPayment()` computed
   `Math.min(Number(fee.amount), Number(fee.paidAmount) + paid)` and wrote the result back — so the
   first payment confirmed against a row without `paidAmount` **stored NaN permanently**.
   `applyLateFees()` had the same shape for the late-fee amount.

### The fixes

- **`src/lib/utils.ts`** gained `money(v)` (any money field → finite number, also handling `"1,200"`),
  `feeDue(f)` and `sumMoney(rows, pick)`. They are now used in every place money is summed:
  `/dashboard/fees`, `/parent/fees`, `/dashboard/students` + `[id]`, `/dashboard/ledger`,
  `/api/stats` (3 sites), `/api/branches`, `/api/student/me`, `/api/payments`.
- **`/api/fees` GET** normalises `amount`/`paidAmount` to numbers on the way out, so no consumer can
  inherit a null again. **POST** now writes `paidAmount: 0, status: "UNPAID"` explicitly.
- **Writers fixed:** `lib/ledger.ts` (payment confirmation + late fee) uses `money()` on both sides
  and clamps to the billed amount; fee creation in `lib/admission.ts`, `api/books/issues` (2 sites),
  `api/students` (createMany) always writes `paidAmount: 0` now.
- **`scripts/verify-fees-totals.mjs`** (new) — proves it, against a running server: every row finite,
  `paid + due === billed`, `/api/stats` agrees with the fee list, the guardian view and the ledger
  stay finite. Supports `SMOKE_PORT` and `SMOKE_ORIGIN`.
- **`scripts/fix-fee-paidamount.mjs`** (new) — dry-run by default, `--apply` to write. Repairs stored
  rows by summing the fee's own **payments** (the ledger is the source of truth) and recomputing
  `status`. Applied to the demo tenant only: 2 rows. One of them was an `Admission Fee` that had a
  real ৳4,500 payment recorded but a `NaN` in `paidAmount` — that money was invisible; it is now
  `PARTIAL` with ৳4,500 paid. The other had no payments and became `UNPAID` with ৳0 paid.

### Result on the demo school

`৳95,700 collected · ৳40,000 outstanding` (billed ৳135,700 over 60 fees), the same numbers from
`/api/stats`, `tsc --noEmit` clean, `verify-fees-totals` and `smoke-all` ALL GREEN.

### Worth remembering

- **Never sum money with raw `Number()`.** It is one missing field away from printing ৳0.
- Other schools in the project (fixture/QA tenants) still hold malformed rows. The audit script
  reports them: `node scripts/fix-fee-paidamount.mjs` (scope with `--school <id>`). They were left
  untouched on purpose — they are not this demo's data.

---

## 🔁 Session — 2026-09-26 (dark mode removed: "the grey background is back")

**Input:** "The grey background is back again, remove it permanently, it dims the texts."

### Root cause (not the same bug as last time)

The page background was not slate-50 again — it was **dark mode switching itself on**.
`ThemeToggle` read `prefers-color-scheme` on mount and persisted the result, so any visitor whose
OS/browser was in dark mode got `html[data-theme="dark"]` → `body { background: #0b1220 }`.
The dark palette only ever repainted `body` plus `.card`/`.input`/`.btn`/`.th`/`.td`, while every
screen is written in light-only Tailwind utilities. The result on the live teacher dashboard:
near-black page with dark-on-dark headings ("My classes", stat values) — literally dimmed text.

### What changed

- **Dark mode is gone**, on purpose. Deleted `src/components/ThemeToggle.tsx` and its only use
  (the Shell header), removed every `html[data-theme="dark"]` rule from `globals.css`, and left a
  comment there explaining why it must not be reintroduced by flipping a few tokens back.
- `:root { color-scheme: light }` is now documented as deliberate: it also stops dark scrollbars
  and dark form controls for dark-OS visitors.
- Last page-level grey backgrounds removed: `/qr`, `/qr/<token>` and `/welcome` are `bg-white`
  now (the print pages keep their slate backdrop — that is a print surface, not an app screen).

### Verified

- With the browser emulating a **dark OS**: `data-theme` is absent, `body` is `rgb(255,255,255)`,
  `color-scheme: light`, and no dark-mode toggle remains.
- `tsc --noEmit` clean; `SMOKE_PORT=3123 node scripts/smoke-all.mjs` ALL GREEN.
- Live App Hosting rollout of the same commit re-verified (`/api/health` + all four logins + smoke).

### Known, left alone deliberately

- Secondary metadata is `text-slate-400` in places (~2.6:1 on white at 12px). Below AA, but it is
  a deliberate de-emphasis style, not the background bug — sweep it separately if it is wanted.
- Dark mode is a PRD §14.2 feature. Removing it is a product decision, reversible in git, and cheap
  to bring back properly (Tailwind `dark:` variants over every screen) if anyone asks for it again.

---

## 🔁 Session — 2026-09-26 (live: Firebase App Hosting)

**Input:** get the project live and verify it truly works, not just that a deploy said "done".

### Live URL (working, verified)

**https://smart-school-erp-1--amar-e-school.asia-southeast1.hosted.app**

- Backend `smart-school-erp-1`, project `amar-e-school`, region `asia-southeast1`.
- App Hosting builds **only from GitHub**, so the working tree was committed on a dedicated
  branch `deploy/app-hosting` (local `main` left untouched) and rolled out from there:
  `npx firebase apphosting:rollouts:create smart-school-erp-1 --git-branch deploy/app-hosting --force`.
- Secrets (`FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `JWT_SECRET`)
  plus the non-secret `FIREBASE_STORAGE_BUCKET=amar-e-school.firebasestorage.app` and
  `APP_URL` live in `apphosting.yaml`; `runConfig.minInstances: 1` keeps an instance warm
  (rolling out the branch had briefly regressed it to 0 — fixed in `780ef09`, re-rolled out).

### Verified on the live host, after the final rollout

- `/api/health` → 200 `ok:true`, `problems:[]`, one real Firestore read (~3.3s cold, sub-second warm),
  `runtime.host="google-cloud"`. Polled for ~5 min through the rollout: **no downtime, no 5xx**.
- All four demo logins return 200 and land on the right app: super admin → `/admin`,
  school admin → `/dashboard`, teacher → `/teacher`, guardian → `/parent`.
- `SMOKE_ORIGIN=https://smart-school-erp-1--amar-e-school.asia-southeast1.hosted.app node scripts/smoke-all.mjs`
  → **ALL GREEN** (hub pages, every role's pages + GET APIs, print/marksheet).
- Routes that used to 404 in the first (stale) build now behave correctly: protected pages 307 →
  `/login`, `/s/sunrise` 200, `/login` renders `name="identifier"`.

### Why Netlify was dropped

The live Netlify site is an anonymous drop (not in the user's account), and the user's own team has
**visitor access (SSO) forced on at the account level** — every unauthenticated hit gets a 401
redirect to `app.netlify.com/edge-access`. That toggle only exists in the Netlify UI, and the API
refused every attempt to lift it (`updateSite`, `updateAccount`, `createSite` with `sso_login:false`).
App Hosting has no such gate and needs no extra env-var plumbing.

### Open decisions (not blocking)

- `deploy/app-hosting` is currently **10+ commits behind `origin/main`** (certificate templates,
  timetable builder, billing enforcement, onboarding wizard, CSV import/export, `FIRESTORE_DB_ID`).
  13 files overlap with this branch's changes — merge deliberately, do not blind-merge.
- The 401-protected Netlify site `amar-e-school-demo` can be deleted from the Netlify UI whenever.
- Live and local share the same Firestore project (`amar-e-school`), so live testing mutates demo data.

---

## 🔁 Session — 2026-09-25 (install-and-run-it-on-your-PC edition)

**Input:** make the whole project something anybody can install and run on their own PC.

### What a school now needs to do: two double-clicks

- **`install.cmd`** (Windows, not admin) → `scripts/install-windows.ps1`: checks Node 20+ (and says
  the exact `winget install OpenJS.NodeJS.LTS` line if it is missing), creates `.env` from the
  template, takes **one** Firebase service-account JSON (drag it into the window), generates a fresh
  `JWT_SECRET`, sets `APP_PORT`/`APP_HOST`, runs `npm ci`, seeds the demo school, builds, and offers a
  desktop shortcut. Every step is skippable (`-SkipSeed -SkipBuild -SkipInstall -NoShortcut -Yes`).
- **`start.cmd` / `stop.cmd`** → `scripts/launch.mjs` / `scripts/stop.mjs` (`npm run app`,
  `npm run app:stop` on macOS/Linux): starts the built app in the background, logs to `app.log`, waits
  for the first HTTP 200, records the PID and opens the browser; stop kills it by PID, falling back to
  whatever holds the port.
- **`INSTALL.md`** is the end-user guide: what to install, the three Firebase console clicks, the demo
  logins, where the data lives, how to let phones on the school network use it (`APP_HOST=0.0.0.0`),
  how to run with **no Firebase account at all** (local Firestore emulator — `FIRESTORE_EMULATOR_HOST`
  now counts as "credentials available" in `firebaseConfigProblem()`), plus troubleshooting.

The app binds to **127.0.0.1** by default, so installing it on one PC does not serve the staff area to
whoever is on the same wifi.

### Two Windows traps found by actually running the installer here

1. **Windows PowerShell 5.1 decodes `.ps1` files with the system codepage** unless they carry a UTF-8
   BOM, so the box-drawing characters in the output became a *syntax error* on this machine. The
   script is now ASCII-only (see the note at the top of it).
2. `Get-Content`/`Set-Content -Encoding utf8` **rewrote `.env` with a BOM and mojibake'd the em-dashes
   in its comments** (plus CRLF). Both halves now go through `System.IO.File` with an explicit
   `UTF8Encoding($false)`, and the installer was re-run to confirm the only difference to the original
   `.env` is the two appended lines.

Verified end to end: installer (with `-SkipInstall -SkipSeed -NoShortcut`) → `[ok]` at every step and a
clean `.env` diff; `npm run app` → 200 on `/login` and `/api/health`, `✓ Ready in 305ms`, PID written,
loopback-only; `npm run app:stop` → process stopped, PID file removed, second run reports "nothing is
running"; `scripts/smoke-all.mjs` **ALL GREEN** afterwards. `.gitignore` now ignores every `.env`
variant except the template and the run artifacts (`.app.pid`, `app.log`), and the deploy zip refuses
any `.env*` entry other than `.env.example`.

---

## 🔁 Session — 2026-09-25 (live Netlify sign-in: "Request failed")

**Symptom:** on `https://wonderful-salmiakki-295cd1.netlify.app/login` every sign-in answered
*"Request failed"*.

### What it actually was

Not a login bug: **no data route on that deployment can reach Firestore.** Measured from outside —
`/api/public/schools` 500, `/s/sunrise` 500, `POST /api/qr/verify` 500, `POST /api/auth/login` 500
(empty body), while `/welcome` (pure static) is 200 and `/api/auth/me` correctly 401s. A Netlify site has
no Application Default Credentials, so without the three `FIREBASE_*` variables there is no way to
authenticate at all, and the empty 500 is all the browser can report — hence "Request failed".

### Fixes so the next deploy explains itself

- **`GET /api/health`** (new, unauthenticated, reports *presence* only, never values): lists which
  variables this process can see, a human-readable `problems` array and the result of one real Firestore
  read (`firestore.readMs`, or the error). `200` = configured and reachable, `503` = something is missing.
- **`firebaseConfigProblem()`** in `lib/firebase.ts`: detects "no service-account vars *and* no ADC
  available on this host" (App Hosting/Cloud Run exposes `K_SERVICE`, so it stays quiet there).
- **`POST /api/auth/login`** now answers that message as JSON with `503` — and any other unexpected
  exception as `{ error: "The server could not complete the sign-in: …" }` — so the form shows the reason
  instead of "Request failed". Error paths are unchanged: wrong password 401, cross-app account 403.
- Deploy guide gained a **step 0** (diagnose with `/api/health`) and the note that env changes only apply
  to a *new* deploy.

Tested both ways: with the local `.env` present `/api/health` is `200` and Firestore reads in 3.3s; with
`.env` moved aside it is `503` listing exactly what is missing, and sign-in returns that same sentence.

### Light theme: white, not grey

The owner found the grey page background washed out the text. The page background is now white
(`body` and the app shell, `/login`, `/apply`, the guardian entry) and the muted tokens were darkened:`.label` slate-600 → slate-800, `.td` slate-700 → slate-800, `.th` slate-500 → slate-600 + 700 weight,
placeholders slate-400 → slate-500, `.btn-secondary`/`.tr-hover` hover slate-50 → slate-100. On the dark
brand panels (sign-in, hub directory) the copy moved slate-300/400 → slate-200/300. Card definition now
comes from the border + shadow rather than from a darker page behind them.

Verified: `npx tsc --noEmit` clean, `next build` 128/128, `scripts/smoke-all.mjs` **ALL GREEN**,
login 401/403 paths intact, and the computed colours read back from the running app (body `#fff`, label
slate-800, dark-panel copy slate-200).

---

## 🔁 Session — 2026-09-25 (single-address deployments: the hub is now a way in)

**Input:** the owner deployed the app to a host with no subdomains and the platform address answered with
*"App addresses aren't configured for this host"* — four greyed-out cards and no sign-in field.

### The dead end

`/login` rendered `PortalChooser` on every host that isn't a sector host. On `localhost` that is the
intended directory (each card links to `admin.localhost` …), but on a **single-URL deployment** — a bare
IP, a `<site>.netlify.app`, App Hosting's default URL — `sectorHostFor()` has no domain to build a
subdomain from, so it returned `null` for all four apps: every card said "Address not configured" and the
page offered no way in at all. Meanwhile those same hosts **already served every app** (the hub guards in
`middleware.ts` are role-based, and `sectorMismatch()` in `/api/auth/login` deliberately skips
host-scoped checks when `resolveSector()` is null), so the app was refusing the door it had left open.

### The fix

`login/page.tsx` now picks the honest shape for the host: if the four apps have routable addresses
(`APP_DOMAIN`, or `<label>.localhost` in development) it renders the directory as before; if they do not,
it renders `LoginForm` in a new **hub mode** — one sign-in form for the whole platform, every demo
account, the QR guardian entry, and a note that `APP_DOMAIN` + the four subdomains are an optional
upgrade. The account decides which app opens (`/api/auth/login` → `homeForRole()`), and the post-sign-in
warm list is chosen from the returned role instead of the host. The amber notice and the
"Address not configured" state are gone from `PortalChooser` (they are now unreachable — the directory is
only rendered when every card has a real address).

Verified: `127.0.0.1:3123/login` is a form (all four demo accounts) and `principal@sunrise.edu` lands on
`/dashboard` with **no console errors**; `school.localhost:3123/login` is still the School Admin screen
and still refuses a guardian account (*"This account signs in to the Guardian Portal"*);
`localhost:3123/login` is still the directory with `admin.localhost` links. `scripts/smoke-all.mjs` gained
a **platform address** block that asserts all of the above on every run (`ALL GREEN`).

### The install banner was eating the bottom of every page

Found while driving the sign-in screen: `InstallBanner` is a `fixed inset-x-0 bottom-4` wrapper, so it
covered the full width of the bottom ~80px and swallowed clicks there — the last demo-account card could
not be clicked at all, and the same band is dead space on every other page. The wrapper is now
`pointer-events-none` with `pointer-events-auto` on the card (and on the iOS help popup), and the sign-in
form column reserves `pb-24` so its last card clears the banner.

### Packaging (`make-zip.ps1`)

A deploy zip of the current folder now builds from `git ls-files -co --exclude-standard` — everything
committed **plus** everything untracked but not ignored, which is what a git-based build would receive,
including the features that were never committed. No `node_modules`, `.next`, `.env`,
`service-account.json`, `scripts/session-state.json`, logs or Gradle `build/` output; the script then
reads the archive back and fails if a required file is missing or anything secret-shaped is inside.
Output: `smart-school-erp-deploy-<date>.zip` (300 files, ~0.7 MB) in the project root.

---

## 🔁 Session — 2026-09-25 (Whole-project bug sweep + browser run)

**Input:** the owner asked for a bug sweep of the whole project and a preview run.

### 1. A guardian with two children resolved to a different child on every screen

One login covers a household (§5.4 family link), but the self-service routes each picked "the" child
with a bare `prisma.student.findFirst({ where: { guardianUserId: session.id } })`. Firestore returns
those documents in an arbitrary order, so the portal home, fees, attendance, results and materials could
name **different children on the same screen set**, and a request that *named* a child was either refused
(the second child looked like a stranger's) or, worse, trusted blindly:

- `POST /api/chat` accepted any `studentId` from the same school → a parent could open a thread as
  another family's child.
- `POST /api/homework/[id]/submit` did the same for staff, writing another tenant's submission.
- `POST /api/payments` refused a sibling's fee as if it were a stranger's (`403`), so a family could not
  pay the second child at all.
- `GET /api/ledger` was **always empty for the STUDENT role** (it looked the student up by
  `guardianUserId`).

`lib/auth.ts` now owns the answer: `guardianChildren()` (linked ∪ family, sorted earliest-admitted first),
`guardianChildIds()`, `guardianChildId(session, requestedId?)` (honours a requested child **only if it is
this guardian's**, otherwise no child) and `resolveActingStudent(session, requestedId?)`. Converted:
auth/me, stats, fees-side of payments (GET/POST), payments/mock-complete, ledger, certificates,
leave-requests (GET lists every child of the family; POST files against the named child), books/issues,
meetings (GET+POST), resources, exams, exams/[id], chat, homework submit, complaints; `students/[id]` and
the print pages now share `guardianOwnsStudent`, and certificates gained the missing school check.

### 2. `/admin/billing` crashed the whole console

Four subscriptions (and four invoices) reference schools that no longer exist; the table read `s.school.id`
and React's error boundary took over: *"Application error: a client-side exception has occurred"*
(`TypeError: Cannot read properties of null (reading 'id')`). The row now renders safely ("Deleted school",
Renew/Switch disabled) instead of taking the page down.

### 3. The Teacher app's "View" button did nothing

`teacher/results` linked to `/dashboard/exams/<id>` — another app's area, which the teacher host bounces
cross-origin. Next logged *"Failed to fetch RSC payload … Falling back to browser navigation"* and the
click landed on the teacher's own home. It now links to `/teacher/marks?examId=<id>`, a deep link the marks
screen honours (reads the query on the client so the page stays static).

### Verified

- ✅ `npx tsc --noEmit` 0 errors · ✅ `npx next build` success (128/128 pages).
- ✅ `SMOKE_PORT=3123 node scripts/smoke-all.mjs` — **ALL GREEN**; `verify-admission-intake.mjs` green;
  `BASE=http://127.0.0.1:3123 node scripts/verify-tenant-isolation.mjs` — **ISOLATION CONFIRMED**
  (fixture created + cleaned, 18 docs).
- ✅ **`scripts/verify-guardian-child.mjs` (new, 18 checks)** — one family, two children: the same child on
  every screen and on every repeat call; stats agree with the admin's view of that child; a family-linked
  sibling is reachable (student page, certificate, leave request, payment intent) while a stranger's child
  is refused everywhere (`403`/empty); the probe fixture is deleted by document reference and the demo
  child's link restored (roster 16 → 16).
- ✅ **Browser run (~60 routes, client-side)**: every school-admin, teacher and parent page plus the
  platform console, checking the console + network of each — 0 errors and 0 non-200 responses after these
  fixes. Before them: the billing crash, the three failed RSC prefetches on `teacher/results`, and
  `GET /api/remarks → 400` noise from the teacher warm list (kept: the prefetch swallows it).

---

## 🔁 Session — 2026-09-25 (Admissions module gets the very same intake form)

**Input:** the owner asked that a new admission in the **Admissions** sector use *the exact same form with
the same information fields* as the New Admission form in the **Students** sector.

### 1. One form, two entry points (`components/AdmissionIntakeForm.tsx`, **new**)

The intake form that used to live inside `dashboard/students/new` moved out **verbatim** into a shared
client component. `dashboard/students/new` is now a three-line wrapper, and the new route
`dashboard/admissions/new` renders the same component — the two entry points therefore *cannot* drift
apart; there is no second field list to keep in sync. Only navigation is parameterised
(`cancelHref`/`cancelLabel`, an optional extra button on the success screen, the heading); **no field was
added, removed or renamed on either side**, which is the point of the request.

### 2. What the Admissions list now offers (`dashboard/admissions`)

- **New admission** (the only entry point) → `/dashboard/admissions/new`, i.e. the shared form: one submit
  writes the student (+ QR credentials), the guardian login, the family/sibling link, the admission +
  monthly fee, the discount (auto-approved for an admin, PROPOSED for the desk), the money taken at the
  counter and the books/uniform/ID card, and files the pipeline record as **ENROLLED** via
  `POST /api/admissions/intake`.
- **The small enquiry modal is gone for good** (same session, owner's call). It had been broken since the
  API was re-shaped: `POST /api/admissions` *without* an `action` is the **public** form (`/apply`, §4.1
  step 1) and demands a `schoolId` in the body, which a staff page never sends — so every "Create
  applicant" click died with `400 {"error":"School is required."}`, and because the page-level `ErrorNote`
  sat *behind* the modal it looked like a silent failure. With the full form one click away in this same
  module, the second, smaller form (and its dead state/handler) was deleted rather than patched. The
  pipeline in the detail panel is untouched: records that arrive from the public online form still start at
  ENQUIRY and walk applied → docs/test → seat → fee → enrolled.

### 3. Plumbing

`/dashboard/admissions/new` added to `lib/route-data.ts` (warms `/api/classes` + `/api/admissions/intake`
on hover/sign-in, same as `/dashboard/students/new`) and to `scripts/smoke-all.mjs`'s school-admin sweep.

### Verified

- ✅ `npm run typecheck` — 0 errors · ✅ `npm run build` — success; route table shows
  `/dashboard/admissions/new` at **138 B / 128 kB** First Load JS next to `/dashboard/students/new` at
  **137 B / 128 kB** (same component, same chunk).
- ✅ **`.freebuff/verify-intake-form-parity.mjs` (new, CDP-driven)** — a real headless Chrome signs in as
  the seeded school admin *on the school host* (the cookie is Secure+HttpOnly, so only a browser on
  localhost can hold it), opens both routes and diffs the rendered DOM: **10/10 GREEN** — 29 Field labels
  in the same order, 49 input/select/textarea controls with matching tag/type/options, 6 identical card
  sections, same heading, and the *only* difference is the back link (`Students → /dashboard/students` vs
  `Admissions → /dashboard/admissions`). The list page is covered too: the header carries **exactly one**
  action ("New admission" → the shared form) and no "Quick enquiry" / "Create applicant" text survives
  anywhere — a regression guard for this removal.
  Screenshots: `.freebuff/form-parity-{students-new,admissions-new,admissions-list}.png`.
- ✅ `SMOKE_PORT=3000 node scripts/smoke-all.mjs` — **ALL GREEN**, including the new
  `/dashboard/admissions/new` (every page and GET API route swept, each role on its own host).

---

## 🔁 Session — 2026-09-24 (New Admission — one action, the whole intake)

**Input:** the owner asked that `/dashboard/students/new` stop being an "Add Student" form and become
the desk's real intake — the admission fee and the money taken at the desk, the child's blood group,
a discount with an approval path, "is a sibling already studying here?", and the books/uniform kit
driven by live stock — all from one submit.

### 1. The form the desk actually fills in (`dashboard/students/new`, rewritten)

Student (incl. blood group, previous school, birth certificate, roll, photo), guardian (relation,
phone, emergency contact, email, optional login + initial password), **sibling search** (name /
admission no / guardian phone — a hit is linked, not retyped), fees (**prefilled from the class's Fee
Template** when it has one, else the school's Fee Settings), discount (PERCENT/FIXED + reason + note;
**auto-APPROVED for an admin, only PROPOSED for the front desk/accountant**), payment collection
(method + reference), and the kit: every catalogue item with its **live availability**, "Hand over
now" / "Later" per item, uniform size and ID card. The footer states what the submit will do, and the
COLLECTING figure moves as the discount is typed (৳5,000 → ৳4,500 for 10%).

### 2. One submit, everything written (`api/admissions/intake`, new)

- POST on the **admission permission module** (front desk yes, teacher refused); GET serves the form's
data (fee defaults + live kit).
- Refuses: no class (or a class from another school), a section that does not belong to the class, a
  login requested without an email, **a discount larger than the fee**, and a **duplicate child**
  (same guardian phone + same name → "already enrolled … open that student instead of admitting them
  twice").
- Writes student (with QR token/PIN), guardian account (**reused** when the email already has one),
  sibling family link, admission fee + first monthly fee, discount, payment + receipt, ledger, kit
  issues and the admission record (ENROLLED) — then returns a **work list** of what happened and what
  is still pending. Printable receipt: `/print/admission-receipt/[admissionId]` (**new**).

### 3. Kit is inventory, not a checkbox

`issueKitAtAdmission` (`lib/admission.ts`) re-checks availability **at the moment of issue** (two desks
can both be looking at "1 left") and refuses what is not on the shelf; anything that cannot be handed
over comes back in `unavailable`/`unknown` and is *reported* — in the work list ("Out of stock, could
not hand over: …") and on the receipt ("To hand over later: …"). The form disables "Hand over now" on
a zero-stock item and offers only "Later". Nothing is dropped silently any more.
`scripts/seed-kit-demo.mjs` (**new**) seeds a Class-1 kit whose stock deliberately includes one empty
shelf, so that path is exercised.

### 4. Family link (§5.4) — and the two pipeline bugs it exposed

`linkSiblingFamily` / `findExistingSibling` (**new**) put the new child into the sibling's family (the
sibling's family id wins) and point both children at **one** guardian login, so the guardian portal
lists every child of the household. Along the way: `POST /api/admissions?action=discount` recomputed
the payable as `gross − ONE discount` (it now sums **all approved** discounts), and `ON_ROLL_STUDENT`
(`lib/db.ts`) was added because every seeded student was written **without** a `status` field, so
`status: "ACTIVE"` filters silently hid them from the guardian portal and from promotion — a missing
status now counts as on-roll (intake duplicate guard, `/api/parent/siblings`, promotion).

### 5. "Their child" had to become deterministic

Giving one login a second child broke the guardian's own pages: they resolved the child with a bare
`findFirst({ guardianUserId })`, so the answer flipped to whichever child came back first (in practice
the newest) and the print pages then refused the other one. `smoke-all.mjs` caught exactly that —
*"rendered but missing Academic Marksheet"* (HTTP 200 with the page's own "not found" notice).
`guardianChildIds` / `guardianOwnsStudent` (**new**, `lib/auth.ts`) are now the single definition of
"this family's children" (account link + family id + QR session); `/print/marksheet`,
`/print/report-card` and `/print/id-card` authorize with it, and `/api/parent/siblings` lists that same
set.

### 6. The harness that damaged the demo data — and the guard rail that stops it

`scripts/verify-admission-intake.mjs` (**new**, end-to-end) cleaned up with `where("id", "==", id)`.
But the shim's `create()` **strips an `id` data field** — the id *is* the document id — so those
queries matched nothing: every run leaked 2 students + 2 admissions into the demo school, and the
family link had stamped a `familyId` on the demo student **Ayan Rahman**, which is what made the
guardian's portal resolve a leaked child (the smoke failure above). Repaired, and the harness now
deletes by **document reference** and reads each doc back to prove it is gone, **restores** the demo
sibling's `familyId`/`guardianUserId` to their pre-run values, asserts the demo school's **roster is
identical** afterwards, and re-reads the guardian's portal (waiting out the ~30s read cache) to prove
the guardian still resolves to the same child.

### Verified
- ✅ `npm run typecheck` — 0 errors · ✅ `npm run build` — success (incl. `/print/admission-receipt/[admissionId]`)
- ✅ `node scripts/verify-admission-intake.mjs` — **PASS**: access (desk yes, teacher 403, anon 401),
  fee defaults from Fee Settings, live stock, one-action intake, admin discount APPLIED (500 → collected
  4500), desk discount PROPOSED (collected 5000, payable ignores it) then approved → payable 4500, two
  approved discounts **summed** → 4000, empty shelf refused, sibling family + one login for both
  children, bad input refused with a reason, and cleanup verified (2 students + 2 admissions gone,
  sibling restored, roster unchanged, guardian unchanged)
- ✅ `node scripts/smoke-all.mjs` — **ALL GREEN** (including the guardian print-marksheet entry this bug
  had broken)
- ✅ in the browser (School Admin): admitted **Ayesha Rahman** (Class 1 · A, blood O+) as Ayan's sibling
  in one submit — ৳5,000 fee, 10% sibling discount auto-approved → ৳4,500 collected
  (**RCP-6092345263**), monthly fee ৳1,500, kit handed over (Bangla Book, Summer Uniform, ID card),
  Science Workbook left pending, receipt printed, **no console errors**; the guardian portal then listed
  **both** children (family `fam_st_3148f3a`) and could print either marksheet. That walk-through student
  is left in the demo school (delete the two records to remove it).

---

## 🔁 Session — 2026-09-24 (perceived speed + school-editable grading & GPA)

**Input:** the owner reported that clicking anything (from sign-in onward) takes too long — "click
and boom" — and then asked that the marking system (columns, grading, GPA) be editable by teachers
and the school admin, with the option to add rows/columns and set every number.

### 1. Why it was slow — measured, not guessed

A direct probe of Firestore from this machine (`_fsprobe`, since deleted):

| | time |
|---|---|
| first call in a fresh process | **3.6s** |
| every call after that | **0.55–1.25s** |
| TCP/TLS to Google | ~0.03–0.3s |

So one **round trip** costs ~0.5s, and each page fetches 1–8 things after mount. The previous
session's caching was already working (warm routes answer in **25–46ms**); the whole remaining
problem was the **cold** case: first hit on a route, after the 30s TTL lapsed, or after any write
(writes clear the whole memo). `dev-server.log` (Sep 20) still shows `/api/stats 200 in 17314ms`.

### 2. What changed for speed

- `src/lib/db.ts` — **stale-while-revalidate**: past the TTL a read returns the previous answer
  immediately and refreshes behind the caller (`DB_READ_GRACE_MS`, default 120s, `0` = old
  behaviour). Added **in-flight dedupe** (three panels asking for one collection = one query) and a
  **write-generation guard** plus `pullInflight.clear()` on write, so a read that started before a
  submit can never be handed to a reader after it.
- `src/lib/route-data.ts` (**new**) + `prefetch()` in `lib/client.ts` — hovering a sidebar entry
  fires that page's GETs; after sign-in the whole sector is warmed staggered; returning to the tab
  re-warms (rate-limited). Wired in `Shell.tsx` and `LoginForm.tsx`.
- `Shell.tsx` — the session is kept per tab, so a reload paints the chrome instead of a skeleton;
  cleared on sign-out and on 401.
- `api/auth/login` — an email resolves by its deterministic id (ONE doc read; it used to pull the
  whole `users` collection), the loaded user is reused instead of re-fetched, and the audit write
  overlaps token signing.
- `scripts/bench-routes.mjs` — it was timing dead paths (`/api/leaves`, `/api/results`), so its
  404s at 30ms looked fast while measuring nothing; fixed to the real routes.
- **Do not measure in `next dev`** (per-route compile per first visit). `npm run build && npm start`.

### 3. Grading & GPA (new)

- `src/lib/grading.ts` (**new**, client-safe) — the scheme model: name, `gpaScale`, `passPercent`,
  `failCapsGpa`, and grade **bands** (`grade`, `minPercent`, `gpa`, `remark`). Ships
  `DEFAULT_SCHEME` (Bangladesh National, 5.00) + three presets, `validateScheme`,
  `gradeForScheme`, `gpaOfScheme`, `resolveExamColumns`, `validateColumns`.
- `src/lib/grading-store.ts` (**new**, server) — per-school persistence in `settings` under
  `grading_scheme_<schoolId>`; hidden from the generic `/api/settings` endpoint.
- `api/grading-scheme` (**new**) — GET (any role that can view marks) / PUT / DELETE (reset).
  Writable by **SCHOOL_ADMIN, BRANCH_ADMIN and TEACHER** (`attendanceMarks: entry`); a guardian can
  read but never write. Invalid scales are refused with the reason and never stored.
- `api/exams/[id]/columns` (**new**) — the marks sheet's **columns**: which subjects, each with its
  own full marks (an exam can be five subjects out of 100 plus a project out of 50). A mark leaves
  with its column, and also when the column's full marks change (85/100 is not 85/50).
- Grading moved off the hardcoded scale: `lib/grades.ts` now holds ranking only. `/api/marks` grades
  with the active scheme and refuses marks above a column's full marks; `/api/exams/[id]` **recomputes
  grades on every read**, so editing a band re-grades existing sheets with no re-entry; the report
  card prints the school's own bands, pass mark and remarks.
- UI: `src/components/GradingSchemeEditor.tsx` (**new**, shared by `/dashboard/grades` and
  `/teacher/grades`): scale settings, presets, add/remove/edit band rows, live preview, per-score
  try-out. `dashboard/exams/[id]` gained the column editor and live per-cell grades; `teacher/marks`
  now uses the exam's own sheet and full marks.
- `clean()` in `lib/db.ts` was fixed to strip `undefined` **inside arrays** — a band without a remark
  made the whole write fail with "Cannot use undefined as a Firestore value". That bug affected any
  array-of-objects write, not just grading.

### Verified
- ✅ `npm run typecheck` — 0 errors · ✅ `npm run build` — success (incl. /dashboard/grades, /teacher/grades)
- ✅ `node scripts/verify-grading.mjs` — PASS (access, validation, scheme-driven grading, re-grade on
  edit, columns, over-full rejection, printed report card)
- ✅ `verify-write-freshness.mjs` — PASS · `verify-read-cache.mjs` — PASS (one flaky run: warm 75–116ms
  under load, still ~5× better than a 550ms round trip)
- ✅ `smoke-all.mjs` — ALL GREEN (new pages added to its route list)
- ✅ live: post-TTL reads stay ~40ms instead of 2–4s; in-browser sector warm + hover prefetch observed

### 4. Student marksheet (new — PRD's "subject-wise marksheet")

- `src/app/print/marksheet/[studentId]/page.tsx` (**new**) — the printed subject-wise document the
  family keeps: **subjects down, one column per exam across**, so it reads the same whether a class
  has sat one term or three. Cells show `obtained/full` plus the grade that percentage earns; a
  **Year total** column sits at the right, then a term-by-term summary (total, %, GPA, position,
  result), the year's cumulative GPA / percentage / position / result, the school's own grading scale
  with remarks, and signature blocks. Grades, points and GPA are **recomputed from the live scheme on
  every read**, like the report card.
- Positions rank the exam's **roster** (class + section), the same list the exam sheet uses — ranking
  by "whoever has a mark" let a stray out-of-section mark inflate every classmate's place.
- Guardians see only **published** terms (staff see drafts marked *draft* / *(unpublished)* plus a
  count of hidden ones); a guardian can open only their own child; no session or another school's id
  renders "Marksheet not found". Entries: student page, each row of the exam's Report-cards card, and
  the guardian's Exam Results header ("Year marksheet").
- `scripts/seed-marksheet-demo.mjs` (**new**) — the demo school had a single exam, so a year marksheet
  would print one lonely column. Adds **Monthly Test 2026** (May) and **Half Yearly Examination 2026**
  (Sept) around the seeded First Term, with a fixed (not random) marks table for that class's section.
  Idempotent (`--force` overwrites, `--remove` deletes both exams + their marks). Two demo exams and
  28 marks now exist for Class 1 · Section A; **nothing else was touched** — the seeded First Term,
  the scheme and every other collection are as they were.

### 5. A latent crash fixed on the exam sheet

`dashboard/exams/[id]` called `useMemo` **after** its `if (loading) return …` early returns, so the
hook count changed between the loading and loaded renders and React rejected the whole page
(**error #310 — rendered more hooks than during the previous render**). The hook now sits above the
returns. This is exactly the class of bug `smoke-all.mjs` cannot see: SSR serves the *loading* branch,
so the route answers 200 while the browser shows "Application error". A repo-wide scan for
hook-after-early-return found no other instance.

### Verified (marksheet)
- ✅ `npm run typecheck` — 0 errors · ✅ `npm run build` — success (incl. `/print/marksheet/[studentId]`)
- ✅ `smoke-all.mjs` — ALL GREEN; it now checks **print pages** too (each entry is path + a marker the
  finished document must contain, so a 200 that renders "not found" fails)
- ✅ `verify-grading.mjs` — PASS (unchanged) · demo scheme left on the shipped default,
  `GET /api/grading-scheme` = `default` = `true`
- ✅ numbers hand-checked against the live tenant: Monthly Test 459/700 → GPA 3.57, First Term
  522/700 → 4.14, Half Yearly 464/700 → 3.43, year 1445/2100 → **3.71** with **2nd / 2**
- ✅ in the browser: student page → Marksheet, exam sheet → Marksheet (both students), guardian
  Exam Results → Year marksheet; guardian blocked from the other child (guarded by a second login)
- ✅ guardian/staff difference: temporarily unpublishing a term hid it from the guardian's sheet and
  from the guardian's year total while staff saw it flagged *(unpublished)*; then restored
- ✅ rendered in 18–24 ms warm (first render 5.5 s — cold Firestore); no console errors

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

# harnesses — all expect a running server (`next start -p 3123`, or the port in .env); this shell
# exports PORT=0, so pass the port explicitly and never read process.env.PORT.
# On a machine with no Node.js, run them under the bundled Bun instead:
#   BUN="$LOCALAPPDATA/Programs/@codebufffreebuff-desktop/resources/bun/bun.exe"
#   "$BUN" node_modules/next/dist/bin/next build && "$BUN" node_modules/next/dist/bin/next start -p 3000
#   SMOKE_PORT=3000 "$BUN" scripts/smoke-all.mjs
SMOKE_PORT=3123 node scripts/smoke-all.mjs                 # every role's pages + GET APIs + print pages
SMOKE_PORT=3123 node scripts/verify-fees-totals.mjs         # fees add up: finite money, paid+due=billed, stats agrees
SMOKE_PORT=3123 node scripts/verify-user-secrets.mjs        # no bcrypt hash / 2FA secret / QR credential leaves any API response
SMOKE_ORIGIN=https://… node scripts/verify-fees-totals.mjs  # same checks against a deployment
node scripts/fix-fee-paidamount.mjs                         # audit fee rows for a broken paidAmount (add --apply)
SMOKE_PORT=3123 node scripts/verify-admission-intake.mjs   # desk intake end to end (cleans up after itself)
SMOKE_PORT=3123 node scripts/verify-guardian-child.mjs     # one family, many children: same child everywhere
BASE=http://127.0.0.1:3123 node scripts/verify-tenant-isolation.mjs   # cross-school reads (see fixtures below)
node scripts/isolation-fixture.mjs create                  # …then `clean` when finished
node scripts/verify-grading.mjs                            # grading scheme + columns + report card
node scripts/seed-kit-demo.mjs                             # demo Class-1 kit (incl. one empty shelf)
```
