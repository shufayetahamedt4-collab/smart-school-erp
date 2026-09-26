# 🗂️ Project Progress & Session Resume

> **Read me first** in any new session working on this project.
> Keep this file updated at the end of each working session so the next one resumes instantly.

**Project:** Smart School ERP & Parent Communication System (Multi-Tenant SaaS)
**Location:** `E:\SmartSchoolERP`
**Last updated:** 2026-09-26

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

# harnesses — all expect a running `npx next start -p 3123`; this shell exports PORT=0,
# so pass the port explicitly and never read process.env.PORT
SMOKE_PORT=3123 node scripts/smoke-all.mjs                 # every role's pages + GET APIs + print pages
SMOKE_PORT=3123 node scripts/verify-admission-intake.mjs   # desk intake end to end (cleans up after itself)
SMOKE_PORT=3123 node scripts/verify-guardian-child.mjs     # one family, many children: same child everywhere
BASE=http://127.0.0.1:3123 node scripts/verify-tenant-isolation.mjs   # cross-school reads (see fixtures below)
node scripts/isolation-fixture.mjs create                  # …then `clean` when finished
node scripts/verify-grading.mjs                            # grading scheme + columns + report card
node scripts/seed-kit-demo.mjs                             # demo Class-1 kit (incl. one empty shelf)
```
