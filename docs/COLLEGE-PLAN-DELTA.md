# College Plan — DELTA for `institutionType = SCHOOL | COLLEGE | BOTH`

**Scope.** This supersedes only the parts of the College plan affected by one changed product
decision. Sections A–I of the original plan remain valid everywhere not contradicted here.
Base: branch `college-support` @ `79e06b0` (backup commit), working tree read-only.

**The new decision.**
`schools.institutionType = "SCHOOL" | "COLLEGE" | "BOTH"` (absent ⇒ `SCHOOL`).
`SCHOOL` and `COLLEGE` tenants get **no switcher and today's UI**. A `BOTH` tenant gets a
**School | College mode switcher** in the panel header; the whole panel (nav, dashboard, lists,
labels, settings, reports) runs in the selected mode, and **no screen ever mixes both modes' rows**.
Mode is **UI context, not authorization** — `can()`, tenant isolation and `requirePermission()` stay
the only enforcement. Super Admin sets the type at creation and may change it later (→ `BOTH`
always; `BOTH`/`COLLEGE` → `SCHOOL` only when no college data exists — **no departments, no
programs, no `courseRegistrations`**; **Q7 ANSWERED 2026-10-08**, §8).

Anything not verifiable from the repository is marked **unverified**.

---

## 1. Mode storage

### Candidates, judged only on how this codebase would read it

| Option | Readable from Edge middleware | Readable from API routes | Readable from server components | Client churn | Persistence | Verdict |
|---|---|---|---|---|---|---|
| **Cookie `ss_mode`** | Yes — `src/middleware.ts:62` already reads `req.cookies.get(SESSION_COOKIE)`; a second cookie is the same call | Yes — `getSession()` (`src/lib/auth.ts:40`) and `cookies()` | Yes, but see the warning below | None: the browser attaches it to every same-origin `api()` fetch (`src/lib/client.ts:70`) | Per browser | **Recommended** |
| **JWT claim on `ss_token`** | Yes — already decoded, `src/middleware.ts:64-70` | Yes — `verifySession` (`src/lib/auth.ts:31`) | Yes | Every toggle must re-sign the session via `signSession` (`src/lib/auth.ts:23`) and re-issue a 7-day cookie | Per browser, but pinned to session lifetime | Rejected |
| **Per-user setting** (`users.lastMode` / `settings` key) | No (Edge reads no DB) | Yes, but each route pays an extra `prisma.setting.findUnique` | Yes | None | **Per user, across devices** | Use for *memory*, not for the read path |
| **URL parameter only** (`?mode=college`) | Yes | Yes | Yes | Huge: 77 client pages (`grep -rl '"use client"' src/app --include=page.tsx` = 77) navigate by `href`; every `Link`, `ROUTE_DATA` (`src/lib/route-data.ts:19`) and `SECTOR_WARM` (`:102`) key would have to carry it | Shareable | Rejected as the source of truth |

### Recommendation (one design)

1. **Truth** lives on the tenant: `schools.institutionType` (already Phase 0 of the original plan).
2. **Active UI mode** lives in an **httpOnly cookie `ss_mode`** (`"SCHOOL" | "COLLEGE"`), written by
   one new route `POST /api/mode`, which validates the requested mode against the tenant's
   `institutionType` and refuses anything else. Mode is *never* read from the request body for
   authorization.
3. **Mode-scoped list reads additionally carry `?mode=`**, because the client read cache is keyed by
   URL alone — `const key = \`GET ${url}\`` (`src/lib/client.ts:85`) with a 60 s TTL
   (`READ_TTL_MS`, `src/lib/client.ts:29`). With the cookie alone, `/api/classes` would return the
   school list and the college list under the **same** key for up to 60 s. Putting mode in the URL
   fixes the memo, `isFresh` (`:176`) and `prefetch` (`:147`) in one move. The server treats the
   query value as a *filter selector* validated against `institutionType`, never as authorization.
4. **Switching** calls `clearApiCache()` (`src/lib/client.ts:43`, already exported) and rewrites
   `ME_CACHE_KEY = "ss_me_v1"` (`src/components/Shell.tsx:198`, `writeCachedMe` at `:209`) since
   `useMe()` paints the cached session on first frame (`:218`).
5. **Remembering the last mode**: additive `users.lastMode`, written by `POST /api/mode`.
   **Default on first login** = the tenant's type when it is `SCHOOL` or `COLLEGE`; for `BOTH`,
   `user.lastMode ?? "SCHOOL"`. This is the only cross-device memory; the cookie is just the
   per-browser transport.

### Explicit warning that shapes the design

Reading `cookies()` inside a layout switches that route tree to dynamic rendering in the Next.js App
Router. The panel layouts are the obvious place to resolve mode — `src/app/dashboard/layout.tsx:4`
(`<Shell role="SCHOOL_ADMIN">`), `src/app/admin/layout.tsx:3`, `src/app/teacher/layout.tsx:13`,
`src/app/parent/layout.tsx:13` — so **do not** read the cookie there. Read it only where rendering is
already per-request: **API routes** (every one is dynamic) and the switch route. The client learns the
current mode from the `/api/auth/me` payload (extend the `select` at
`src/app/api/auth/me/route.ts:37` and `:76`). *Whether reading `cookies()` in these specific layouts
would actually change caching behaviour here is **unverified** — the design above avoids needing to
find out, which matters because performance work is frozen.*

---

## 2. Keyed-by-`schoolId` state that needs a mode dimension

| State | Key builder / evidence | Mode dimension? | Why | Least invasive way (no change to existing SCHOOL keys) |
|---|---|---|---|---|
| Grading scheme | `schemeKey(schoolId)` → `grading_scheme_<schoolId>`, `src/lib/grading-store.ts:17` | **YES** | A BOTH tenant needs its school scale (`DEFAULT_SCHEME`, gpaScale 5, `src/lib/grading.ts:43`) *and* a college 4.00 credit scale | `schemeKey(schoolId, mode)`: mode `SCHOOL` returns today's exact key; `COLLEGE` returns `grading_scheme_<schoolId>_college` |
| Routine config | `routineConfigKey(schoolId)` → `routine_config_<schoolId>`, `src/lib/routine-config.ts:30` | **YES** | Periods/bells/working days differ (`DEFAULT_ROUTINE_CONFIG`, `:40`) | Same suffix pattern |
| Current academic session pointer | `currentSessionKey(schoolId)` → `school.<schoolId>.current_session`, `src/lib/academic.ts:46-47` | **YES** | The "current year" of a school and a college are different rows (`academicSession`, read by `getCurrentSessionId`, `src/lib/academic.ts:21`) | Keep the existing key for `SCHOOL`; add `school.<schoolId>.current_session_college` |
| Branding blob | `school.<schoolId>.branding`, written at `src/app/api/schools/route.ts:97,107` | **NO** | It is **written but never read** anywhere in `src/`. Verified by classifying every non-comment `branding` hit: the two writes at `src/app/api/schools/route.ts:97,107`, a label string at `src/app/dashboard/settings/page.tsx:79`, and a sector blurb at `src/lib/sectors.ts:62` — **no read path exists**. The UI reads `school.themeColor` / `school.logoUrl` via `src/app/api/schools/[id]/route.ts` GET and the `me.school` payload | Leave untouched; flag the dead write as a pre-existing oddity |
| `feeSetting` (school defaults) | doc id `fs_<schoolId>` (`idFor`, `src/lib/db.ts`), consumed by `enrollStudent` → `createStudentFees` (`src/lib/enroll.ts:185-202`) and `src/app/api/fees/settings/route.ts` | **NO** | "Monthly Fee / Admission Fee" is explicitly school semantics; college billing comes from `feeCategories` (Phase 6) | Do not extend it at all — this is the least invasive option and keeps `fs_<schoolId>` untouched |
| `feeCategories` | collection scoped by `schoolId`; `amounts` is `{classId: amount}` (`src/app/api/fee-categories/route.ts:33` `BUCKETS`, `:34` `FREQUENCIES`, `:51` `fields()`, up to `:55`) | **YES (filter only)** | A category may price only one mode's class set | Filter the returned list by the mode's class set; add an optional `mode` field only if a category must be exclusive to one mode |
| Stats payload cache | `admin\|${session.id}\|${sid}\|${branchId}` (`src/app/api/stats/route.ts:45`), `teacher\|${session.id}\|${schoolId}` (`:141`), `guardian\|${session.id}\|${schoolId}` (`:228`) | **YES** | The payload's `counts`/`fees`/`trend` are computed from mode-scoped rows; without a dimension the school payload is served for college mode | Append `\|${mode}` to the key string; `statsCompute(key, schoolId, produce)` / `statsRefresh` signatures are unchanged |
| Exams list cache | `store` keyed by string, tagged `schoolId` (`src/lib/exams-cache.ts:16-35`); key built in `src/app/api/exams/route.ts` (`cacheKey`) | **YES** | `/api/exams` is mode-filtered | Append mode to the key string |
| Reference reads | `schoolReference(model, schoolId)` (`src/lib/db.ts:1121`), `invalidateReferenceCache(schoolId)` (`:1112`) | **NO** | These are the raw school-wide pulls; they are mode-agnostic and legitimately shared. Filtering belongs in the route | None |
| Pull cache (`pullMemo`) | keyed per model + filter, `src/lib/db.ts` read-cache block (`PULL_TTL_MS` `:730`) | **NO** | Same reason; the mode filter is applied in memory after the pull | None |
| Write generation | `schoolWriteGeneration(schoolId)` (`src/lib/db.ts:816`) | **NO** | A write in either mode *should* drop both modes' payloads — conservative is correct | None |
| Subscription / write gate | `writeGuard(schoolId)` (`src/lib/subscription.ts`) | **NO** | The plan is tenant-wide | None |
| Bulk import | `IMPORT_FIELDS` static (`src/lib/import/fields.ts:50`), batches school-scoped | **NO** | Rows carry `classId`; mode is derived per row | None (Phase 7 adds college columns) |
| Notifications / devices / 2FA / platform `settings` | school- or user-scoped (`src/app/api/settings/route.ts:10-31`) | **NO** | No mode semantics | None |
| Client read memo | `GET ${url}`, `src/lib/client.ts:85` | **YES (by URL)** | Cross-mode stale read within the 60 s TTL | Mode in the URL of mode-scoped reads + `clearApiCache()` on switch |
| `ss_me_v1` session snapshot | `src/components/Shell.tsx:198` | **YES** | The cached `Me` pins the old mode on first paint | Include mode in `Me`; rewrite the cache on switch |

---

## 3. API filtering — stored field vs derived

### Decision: store `mode` on the three *rooted* entities, derive for everything one hop away

| Entity | How mode is known | Evidence / reason |
|---|---|---|
| `classes` | **stored `mode`** | It is the spine (`classRoom`, `RELS.classRoom`, `src/lib/db.ts`) and the root for exams/routine/homework/resources |
| `subjects` | **stored `mode`** | Courses and subjects are created from catalogues that differ per mode (`src/app/api/subjects/route.ts:52`) |
| `students` | **stored `mode`** | `classId` is nullable — the create path writes `classId: body.classId || null` (`src/app/api/students/route.ts:120`), and promotion/retention can leave a student class-less, so a class-derived mode leaves unassigned pupils **unclassifiable — they would surface in both modes** |
| `exams`, `routines`, `homework`, `timetableSlots`, `resources`, `quizzes` | derived from `classId` | Every one already carries a required `classId` (`RELS`, `src/lib/db.ts`) |
| `fees`, `attendance`, `remarks`, `payments`, `leaveRequests`, `bookIssues`, `quizAttempts` | derived from `studentId` | One hop from the student |
| `marks` | derived from `examId` (or `studentId`) | `examMark` id is `m_<exam>_<student>_<subject>` (`idFor`, `src/lib/db.ts`) |
| Missing value anywhere | **`mode ?? "SCHOOL"`** | Mirrors the existing precedent for a never-written field: `ON_ROLL_STUDENT` treats a missing `status` as enrolled (`src/lib/db.ts:42`) — this is what makes the change **backfill-free** |

**Why a stored field is safer than deriving from `programId`**: the data layer pushes only **one**
equality filter to Firestore (documented in `src/lib/auth.ts:137-148`), so a mode filter is an
in-memory predicate either way — it costs nothing to store. Deriving from `programId` only works when
a row is classed, and it also couples "which mode" to "is this a college semester", which breaks the
moment a BOTH tenant has a school-style class with no program.

### Endpoints and pages that would otherwise mix both modes

| Surface (route / page) | Mixes in BOTH? | Filter mechanism |
|---|---|---|
| `GET /api/classes` (`src/app/api/classes/route.ts`) | Yes | `mode` on `classes` |
| `GET /api/sections` (`src/app/api/sections/route.ts`) | Yes | via parent class |
| `GET /api/students` (`src/app/api/students/route.ts`) | Yes | `mode` on `students` |
| `GET /api/subjects` (`src/app/api/subjects/route.ts`) | Yes | `mode` on `subjects` |
| `GET /api/exams`, `/api/exams/[id]` | Yes | via `classId` |
| `GET /api/marks` (write-only route; marks surface through exams) | Yes | via `examId` |
| `GET /api/fees`, `/api/fee-categories`, `/api/fees/settings`, `/api/ledger`, `/api/payments` | Yes | via `studentId`; categories by mode class set |
| `GET /api/attendance` | Yes | via `studentId`/`classId` |
| `GET /api/routines`, `/api/timetable-slots`, `/api/routine-config` | Yes | via `classId`; config key mode-scoped |
| `GET /api/homework`, `/api/remarks`, `/api/quizzes`, `/api/resources` | Yes | via `classId`/`studentId` |
| `GET /api/leave-requests`, `/api/complaints`, `/api/meetings` | Yes | via `studentId`/`classId` |
| `GET /api/notices`, `/api/gallery`, `/api/books` | Yes (tenant-wide content) | optional stored `mode` if notices should be mode-specific — **open question 11** |
| `GET /api/stats` | Yes | mode in cache key + mode-scoped pulls |
| `GET /api/onboarding`, `/api/import/students/*`, `/api/students/alumni`, `/api/students/promote` | Yes | via class/student mode |
| `GET /api/class-sessions?view=roster` | Yes | via class |
| `/dashboard/reports` + its client-side `xlsx` export (`src/app/dashboard/reports/page.tsx:8-19`) | Yes | mode filter on the fetched rows |
| Print pages (server components: `src/app/print/*`) | Yes | mode from the row being printed; no switcher |
| Guardian/Teacher lists (`/parent/*`, `/teacher/*`) | Yes | via the selected child's / teacher's mode (see §5) |

### Verification checklist — "no list leaks the other mode"

1. For every **mode-scoped** GET above, assert every returned row's `mode === requested mode`.
2. Assert every **option list** (class picker, section picker, subject picker, student picker, exam picker) is mode-filtered — the pickers are the easiest place to leak.
3. Assert **cross-mode id access 404s**: a fee/student/exam belonging to the other mode's rows, fetched by id, must not be returned.
4. Assert **cache keys differ**: same URL with `?mode=school` vs `?mode=college` must not share a client memo entry (`src/lib/client.ts:85`) or a stats/exams entry.
5. Assert **SCHOOL-only tenants pay nothing**: with `institutionType` absent, `mode` is coerced to `SCHOOL` and every payload is byte-identical to today.
6. Assert the **switcher is absent** in `SCHOOL`/`COLLEGE` tenants (no markup diff).

---

## 4. Nav / Shell / dashboard

| Concern | Where | Change |
|---|---|---|
| Resolve mode | API routes only (see §1 warning); never in `src/app/*/layout.tsx` | `getSession()` + `cookies()`; mode = cookie, validated against `institutionType` |
| Switcher placement | `src/components/Shell.tsx`, inside `header.ss-appbar` (`:400`), between the school-name block (`div.min-w-0.flex-1`, `:406-420`) and the actions container (`{user && (` at `:422`, `<div className="flex items-center gap-2">` at `:423`) | Renders `Segmented` **only** when `institutionType === "BOTH"` |
| Switcher control | `Segmented` (`src/components/app-ui.tsx:155-190`) | Reused as-is: `brand-bg` on the active option inherits the tenant colour from `applyBrandColor` (`src/components/Shell.tsx:50`); `min-h-11` touch targets already satisfied |
| Nav | `navForRole(role, institutionType, mode)` — new; `NAVS` (`src/components/nav.ts:70-215`) gains an optional `requires` marker per `NavItem` (`:53`) | `groupNavFor` (`:293`) consumes the filtered array; new hrefs mapped in `SCHOOL_GROUP_OF` (`:249-284`) |
| Labels | `src/lib/institution.ts` (new, dependency-free like `src/lib/sectors.ts`) | `NAV_LABEL_OVERRIDES[institutionType][mode][href]` — `NAVS` keeps its literal SCHOOL labels untouched |
| `AppShell` | `src/components/AppShell.tsx` (teacher/parent) | See §5 — decision required |
| Mobile | The same `ss-appbar` is used at every width (`src/components/Shell.tsx:400`; the loading skeleton's copy is at `:344`) | One placement covers desktop and phone |

**SCHOOL-only tenant:** `institutionType` absent ⇒ switcher renders `null`, `mode` coerces to `SCHOOL`,
nav = today's list. **COLLEGE-only tenant:** switcher renders `null`, `mode` coerces to `COLLEGE`,
nav = college list. In both cases the header markup must be otherwise identical — this is checklist
item 6 in §3 and it is the acceptance test for "UI identical for school tenants".

---

## 5. Roles in a BOTH tenant

`Role` is a closed union (`src/lib/db.ts:17-27`) and every route gates with explicit
`[...].includes(session.role)` arrays, so role handling is unchanged by the mode.

### Teacher

| Option | Behaviour | Code impact |
|---|---|---|
| A. Union both modes, no switcher | "My Classes" lists school and college classes together | None — **but it violates the "never mix modes in one screen" rule** |
| B. **Same switcher on the Teacher App** (recommended) | Teacher picks a mode; lists filter to it | `AppShell.tsx` gains the control; teacher endpoints take `?mode=`; `TAB_DEFS`/`appTabsFor` (`src/components/app-nav.ts:31`) unchanged |
| C. Permanent home mode per teacher | Teacher is pinned to one mode | Needs a `teacher.mode` field + a rule for dual-mode teachers — worst fit for a BOTH tenant |
| D. Grouped-not-mixed lists | One screen, two sections with headers | New rendering concept; contradicts "inside a mode everything is single-type" |

**Recommendation: B**, with the teacher's `lastMode` remembered exactly like the admin's.

### Guardian

| Option | Behaviour | Code impact |
|---|---|---|
| **Child determines mode (recommended)** | No switcher. The portal already shows **one child at a time** — `guardianChildren` (`src/lib/auth.ts:122`), the stable default via `childOrderKey` (`:100-105`) and `guardianChildId` (`:188`) — so selecting a child *is* selecting the mode. A guardian with children in both modes switches by changing the child, using the existing picker on `/parent/profile` | None new; `/parent/*` reads filter by the selected child's mode |
| Explicit mode segment on the Parents App | A second control beside the child picker | Redundant state that can contradict the selected child |
| Per-child mode badge | Read-only indicator | Small, additive; useful if option 1's implicit switch confuses users — **open question 4** |

---

## 6. What changes in the existing plan

| Phase (original) | Status | Reason | Files that change beyond the original plan |
|---|---|---|---|
| **Phase 0** — institution type + labels | **MODIFIED** | The field gains a third value and a change-guard | `src/app/api/schools/route.ts` (accept `BOTH`), `src/app/api/schools/[id]/route.ts` (PATCH whitelist at `:65`/`:69-70`, plus the downgrade guard), `src/app/api/auth/me/route.ts` (`:37`, `:76`), `src/components/Shell.tsx` (`Me` type), `src/app/admin/schools/[id]/page.tsx` (select), `src/lib/institution.ts` (new) |
| **Phase M** — *mode foundation* (**NEW**) | **NEW** | Every later phase assumes mode works; it must exist before nav/labels are made mode-aware | **New** `src/app/api/mode/route.ts`; `src/lib/institution.ts` (mode helpers); `src/components/Shell.tsx` (switcher + `ME_CACHE_KEY` rewrite); `src/components/nav.ts` (`navForRole`); `src/lib/client.ts` (append mode to mode-scoped GETs; reuse `clearApiCache`); `src/lib/stats-cache.ts`/`src/app/api/stats/route.ts` (mode in key); `src/lib/exams-cache.ts`/`src/app/api/exams/route.ts` (mode in key); `src/lib/grading-store.ts`, `src/lib/routine-config.ts`, `src/lib/academic.ts` (mode-suffixed keys) |
| **Phase 1** — tenant-aware nav + terminology | **MODIFIED** | Consumes mode as well as institution type | `src/components/nav.ts`, `src/components/Shell.tsx`, `src/components/AppShell.tsx`, `src/lib/institution.ts` |
| **Phase 2** — departments & programs | **UNCHANGED** | College-only screens already gated by institution type; nothing mode-sensitive | — |
| **Phase 3** — semester = extended class, per-program ladder | **MODIFIED** | **Superseded 2026-10-08 (ruling):** the ladder is **per program**, over `students.programId`/`termNumber`, reusing the registration permission module — **no term rows, no new collection, `classes` untouched**. Original reason: ~~Classes need `mode`, and the ladder must be per (mode, program)~~ | **Superseded 2026-10-08:** the `classes` files drop out of this phase; the exact file list is settled in the Phase 5 preflight. Original: ~~`src/app/api/classes/route.ts`, `src/app/api/students/promote/route.ts` (group key), `src/app/dashboard/classes/page.tsx`, `src/app/dashboard/promotion/page.tsx`~~ |
| **Phase 4** — courses + registration + approval | **MODIFIED** | `subjects.mode`; registration inherits the student's mode | `src/app/api/subjects/route.ts`, new `src/app/api/course-registrations/route.ts` |
| **Phase 5** — credit-weighted GPA / CGPA + transcript | **MODIFIED** | The grading scheme becomes mode-scoped in Phase M, so `loadScheme` must take a mode | `src/lib/grading.ts`, `src/lib/grading-store.ts` callers, `src/app/print/{report-card,marksheet}/**` |
| **Phase 6** — college fee basis | **MODIFIED** | Fee config is mode-scoped; `feeSetting` stays school-only by design | `src/app/api/fee-categories/route.ts`, `src/app/api/fees/generate/route.ts`, `src/app/api/fees/route.ts` |
| **Phase 7** — college dashboard / reports / import | **SPLIT** | Three independent deliverables with different risk | **7a** dashboard widgets (`src/app/api/stats/route.ts`, `src/app/dashboard/page.tsx`); **7b** reports + export mode filter (`src/app/dashboard/reports/page.tsx`); **7c** import columns (`src/lib/import/fields.ts`) |

**Order:** `0 → M → 1 → 2 → 3 → 4 → 5 → 6 → 7a → 7b → 7c`.
Phase M sits between 0 and 1 because Phase 1's whole job is to make nav/labels mode-aware.

---

## 7. New risks, riskiest phase, de-risking

### Risks the mode introduces

| Risk | Why it is real here | Mitigation |
|---|---|---|
| **Cross-mode cache bleed** | The client memo is keyed by URL alone (`src/lib/client.ts:85`, 60 s TTL `:29`); stats keys have no mode (`src/app/api/stats/route.ts:45,141,228`); exams cache likewise (`src/lib/exams-cache.ts:16-35`) | Mode in the URL for mode-scoped reads; mode in stats/exams keys; `clearApiCache()` on switch (§1, §3) |
| **Unclassifiable rows leak into both modes** | `students.classId` is nullable; a derived mode cannot classify a class-less pupil | Store `mode` on `classes`/`subjects`/`students`; absent ⇒ `"SCHOOL"` (§3) |
| **Mode drift between cookie and query** | Two places can disagree | Server rule: query wins for filtering, but both must pass the `institutionType` check; a mismatch is a 400, never a silent fallback |
| **Switcher on the wrong shell / wrong tenant** | `Shell` serves admin+super (`src/app/{dashboard,admin}/layout.tsx`), `AppShell` serves teacher+guardian | Switch on `institutionType === "BOTH"` **and** role, not on tenant alone |
| **Downgrade with college data** | `BOTH → SCHOOL` would orphan programs/semesters/registrations | Guard in `PATCH /api/schools/[id]`: refuse unless the tenant has zero college rows (definition: **Q7 — ANSWERED 2026-10-08**, §8) |
| **Perf regression risk** | Performance work is frozen; mode keys touch the hottest caches | Append a dimension only; do not restructure. Assert SCHOOL-tenant payloads and cache hit paths are unchanged |
| **Mode-aware layouts** | Reading `cookies()` in a layout opts the tree into dynamic rendering (**unverified for these layouts**) | Do not read the cookie in layouts (§1) |

### Riskiest phase after this change: **Phase M — mode foundation**

It is riskiest because *every* mode-scoped surface and cache key depends on it, and its failure mode is
the worst one for a multi-tenant product: one mode's rows appearing in the other. Phase 3 remains the
riskiest *domain* phase (per-program ladder, unchanged from the original assessment), but Phase M now
precedes it and is broader.

**De-risk Phase M:** (1) implement `mode ?? "SCHOOL"` coercion first and prove a SCHOOL tenant is a
no-op — same payloads, same nav, no switcher (checklist §3.5–6); (2) add the mode dimension to cache
keys in one commit, with a test that two modes cannot share an entry; (3) build the switcher last,
behind `institutionType === "BOTH"`; (4) never read the cookie in a layout (§1). **Test before
proceeding:** the §3 checklist, plus a SCHOOL-tenant before/after payload diff.

---

## 8. Open questions this decision creates

Recommended defaults are **not approved** — **except Q7, which is ANSWERED (2026-10-08)**.

| # | Question | Recommended default |
|---|---|---|
| 1 | Does switching mode reload the page, or re-render in place? | In place: set cookie → `POST /api/mode` → `clearApiCache()` → `router.refresh()` |
| 2 | Is the active mode per user or per device? | Per user (`users.lastMode`) for memory, per device (cookie) for transport |
| 3 | Does a teacher in a BOTH tenant get the switcher? | Yes, on `AppShell` (§5 option B) |
| 4 | Does a guardian with children in both modes get a mode control? | No — the selected child implies the mode; add a read-only badge if needed |
| 5 | Is the selected mode reflected in the URL (shareable)? | No permanent URL segment; `?mode=` on mode-scoped API reads only |
| 6 | Can a school admin in a BOTH tenant change the type? | No — Super Admin only (`PATCH /api/schools/[id]` platform-only branch) |
| 7 | What exactly counts as "no college data" for a downgrade? | **ANSWERED 2026-10-08:** no **departments**, no **programs**, no **`courseRegistrations`** — nothing else is counted. `courses`/`programCourses` are **not** counted, and `classes.mode` / college `mode` rows in fees/exams **do not exist** in this codebase (commit `3ba4600` is the implementation). Superseded recommended default: ~~No `departments`, no `programs`, no `classes.mode === "COLLEGE"`, no `courseRegistrations`, no college `mode` rows in fees/exams~~ |
| 8 | What happens to users' `ss_mode` when a tenant is downgraded to SCHOOL? | Coerce to `SCHOOL` on next read; ignore an invalid cookie value |
| 9 | Should `mode` be stored on day one, or derived from `programId`? | Stored on `classes`/`subjects`/`students`; derived one hop for the rest (§3) |
| 10 | Does the college side of a BOTH tenant get its own branding (tagline/logo)? | No — branding stays tenant-wide; the dead `school.<id>.branding` write stays untouched |
| 11 | Do notices/gallery/messages need a mode, or stay tenant-wide? | Stay tenant-wide initially; add `mode` only if users report confusion |
| 12 | Do the Parents/Teacher apps show a read-only mode label? | Yes for the teacher app (it has the switcher); guardian app shows the child's mode only |
| 13 | Is a mode switch audited? | Yes — `audit("MODE_SWITCH", …)` via `src/lib/auth.ts:239` |
| 14 | Does switching invalidate server-side caches? | No: mode is a dimension in the keys, so no cross-mode entry exists to invalidate |
| 15 | In a BOTH tenant, which mode owns the "default" landing page? | `users.lastMode ?? "SCHOOL"` |
| 16 | Does a BOTH tenant's subscription/plan need a mode dimension? | No — plan limits stay tenant-wide (`writeGuard`, `src/lib/subscription.ts`) |

---

## Unverified items

- Whether any production tenant would actually be `BOTH` (no production data was read).
- Whether reading `cookies()` in the four panel layouts would change their caching behaviour here
  (avoided by design, §1).
- Whether a college tenant needs its own `grade scale` **preset** beyond the existing
  `GRADING_PRESETS` (`src/lib/grading.ts:60`) — a business question, carried over from the original plan.
- The original plan's `admit cards` finding (feature does not exist) is unchanged.

**No source file was modified. `tsc` was not run because no TypeScript changed.**
