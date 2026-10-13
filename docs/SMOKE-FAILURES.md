# `smoke-all` failure analysis — four failing checks (read-only)

**Scope.** Analysis of four failures from `node scripts/smoke-all.mjs` run against a local server +
the Firestore emulator (`demo-ss-test`, freshly seeded with `npm run seed`).

**Method.** Code reading only. No script was run, no server started, no database read, nothing
changed or committed. Every claim below cites a file + symbol/line. Anything that cannot be settled
from the code is marked **UNVERIFIED**.

**Branch/HEAD when analysed:** `college-support` @ `e538e74`.

---

## Verdicts at a glance

| # | Check | Verdict |
|---|-------|---------|
| 1 | `/print/marksheet/st_ba9912…ef66` — missing "Academic Marksheet" | **LIKELY TEST-DATA ARTIFACT** (stale hard-coded demo student id) |
| 2 | `/print/report-card/Z1lw7KL79rR0Wv22MfU9/st_ba9912…ef66` — missing "Grading scale" | **LIKELY TEST-DATA ARTIFACT** (stale hard-coded demo exam id) |
| 3 | `/teacher/marks` @390 — input "not a real editable `<input type="number">`" | **LIKELY TEST-DATA ARTIFACT** (seeded exam is `published`, which the page deliberately locks) |
| 4 | `/teacher/marks` @1440 — input "not editable at desktop width" | **LIKELY TEST-DATA ARTIFACT** (same root cause as #3) |

**None of the four is caused by the `college-support` branch** — see section **c** below
(`git diff --stat 79e06b0..HEAD` over every involved path reports no page/grading change at all).

---

## c) Did the branch touch any involved file? — **NO** (verbatim output)

```
$ git log --oneline 79e06b0..HEAD
e538e74 test: seed runs against the emulator without credentials
e31822e test: standalone emulator config
25c439f test: extend emulator guard to maintenance scripts
e31f454 test: emulator-only guard for verify scripts
b88a2f3 merge: production line (96f4762) into college-support
bff12a8 docs: integration analysis
2fda7a4 phase 0: institutionType (SCHOOL|COLLEGE|BOTH)
1f480dc docs: college plan and decisions
96f4762 revert(login): drop the /login shared-cache header — ineffective on App Hosting and unsafe to cache
f03ce26 perf(login): let the CDN answer the sign-in document and drop its two link prefetches
701c8af feat(firestore): configuration-driven database selection

$ git diff --stat 79e06b0..HEAD -- src/app/print src/app/teacher/marks src/lib/grading.ts src/lib/grading-store.ts src/lib/grades.ts scripts/smoke-all.mjs scripts/lib/headless.mjs
 scripts/smoke-all.mjs | 3 +++
 1 file changed, 3 insertions(+)

$ git diff --stat 79e06b0..HEAD -- src/app/print src/app/teacher src/lib/grading.ts src/lib/grading-store.ts src/lib/grades.ts src/app/api/exams src/app/api/marks
(empty — no output)
```

The only change to `scripts/smoke-all.mjs` in the whole range is the emulator-only guard:

```diff
+import { requireEmulator } from "./lib/guard.mjs";
+
 const PORT = process.env.SMOKE_PORT || "3000";
+requireEmulator();
```

That adds a *precondition to running* (the environment must look like a loopback emulator,
`scripts/lib/guard.mjs` → `requireEmulator()`), not an assertion. It cannot change what any check
observes.

**Answer: NO.** No file in `src/app/print/**`, `src/app/teacher/marks`, the grading code
(`src/lib/grading.ts`, `src/lib/grading-store.ts`, `src/lib/grades.ts`) or the exams/marks APIs was
touched by any commit since `79e06b0`. `scripts/lib/headless.mjs` was not touched either. All four
failures are therefore **pre-existing behaviour or pre-existing fixture/seed mismatches**, not
regressions introduced by college support.

---

## a) What `smoke-all` checks, and where the ids and expected strings come from

**Print checks** — `scripts/smoke-all.mjs:104-113` and `:226-231`:

```js
const DEMO = {
  studentId: process.env.SMOKE_STUDENT_ID || "st_ba99122920f48693f156f2b16e57ef66",
  examId:    process.env.SMOKE_EXAM_ID    || "Z1lw7KL79rR0Wv22MfU9",
};
const PRINT_PAGES = {
  "school-admin": [
    [`/print/marksheet/${DEMO.studentId}`, "Academic Marksheet"],
    [`/print/report-card/${DEMO.examId}/${DEMO.studentId}`, "Grading scale"],
  ],
  guardian: [[`/print/marksheet/${DEMO.studentId}`, "Academic Marksheet"]],
};
```

```js
for (const [p, marker] of PRINT_PAGES[role.label] || []) {
  const r = await get(role.host, p, cookie);
  if (r.status !== 200) bad(role.label, p, `HTTP ${r.status}…`);
  else if (ERROR_MARKERS.some((m) => r.body.includes(m))) bad(role.label, p, "error marker in HTML");
  else if (!r.body.includes(marker)) bad(role.label, p, `rendered but missing "${marker}"`);
  else console.log(`  ✅ ${p} (${marker})`);
}
```

- **Provenance of the ids:** *only* `process.env.SMOKE_STUDENT_ID` / `SMOKE_EXAM_ID`, falling back to
  the two literals above. **Nothing is read from the seed and nothing is looked up through an API.**
  Neither variable is documented anywhere: `grep -rn "SMOKE_STUDENT_ID\|SMOKE_EXAM_ID" docs scripts *.md`
  matches only `scripts/smoke-all.mjs:105-106`.
- **Provenance of the expected strings:** literals in `PRINT_PAGES` — not from the pages' own text.
- **The reporting is role-blind:** `bad()` (`scripts/smoke-all.mjs:116-119`) prints
  ``  ❌ ${route} — ${detail}`` with **no role prefix** (the role only enters the `fails[]` array). The
  same URL swept for two roles prints two identical ❌ lines.
- **Sessions used:** school-admin `principal@sunrise.edu` on `school.localhost:<port>`;
  guardian `guardian1@demo.com` on `parents.localhost:<port>` (`scripts/smoke-all.mjs:63-68`).

**Teacher-marks checks (headless):** `scripts/smoke-all.mjs:566-573, 796-865` — see section **d**.

### Are the ids in the failing URLs real for this emulator seed? — **almost certainly stale**

Both ids are *format-plausible* but **generated fresh on every seed of an empty database**:

- Student ids are `st_<32 hex>`: `scripts/seed.mjs:75` `studentDoc(qrToken) => \`st_${qrToken}\`` and
  `:318` `const qrToken = randomHex(16)` = `crypto.randomBytes(16).toString("hex")` — **random, not
  deterministic**.
- Exam ids are Firestore auto-ids: `scripts/seed.mjs:492` `const ref = db.collection("exams").doc();`
  — a new 20-char id per fresh seed (`Z1lw7KL79rR0Wv22MfU9` is exactly that shape).

The two defaults are **legacy captured values**, not derived at run time. Hard evidence that
`st_ba9912…ef66` was captured from an earlier seeded database: the sibling read-only audit artifact
`scripts/_tmp-final-check.mjs:20` maps exactly this id to a seed student:

```js
const SEED_IDS={ … "st_ba99122920f48693f156f2b16e57ef66":"Ayan Rahman", "st_bf1a4966a131f0805aa94e368000ee9a":"Mim Akter", … };
```

`Ayan Rahman` is the seed's **Class 1 / Section A / roll 1** student
(`scripts/seed.mjs:294`, admission no `SUN-2026-1A-001`) whose guardian e-mail is
`guardian1@demo.com` (`:294`, linked to a guardian user at `:373-375`). The same two literals also
appear, verbatim, in the stale copies `_perf-remediation/cutover-wt/scripts/smoke-all.mjs:92-93`
and `_perf-remediation/login-p0-wt/scripts/smoke-all.mjs:92-93` — i.e. they are a fixed constant
carried through the project's history, which is why `scripts/smoke-all.mjs:102` claims (wrongly, for
a fresh emulator) that "the demo tenant's ids are stable".

**Consequence:** the id resolves *only* against the database it was captured from. Re-running `seed`
against the **same still-populated** emulator keeps the same ids (the seed is idempotent: students
are matched by `admissionNo` at `scripts/seed.mjs:315` and only created when missing; the exam is
matched by `(schoolId, classId, name)` at `:490`). But a fresh/cleared emulator produces brand-new
student ids and a brand-new exam id → both print URLs point at documents that do not exist.

**UNVERIFIED:** I was not allowed to read the emulator, so "the ids are stale" is *inferred* from
the failure symptom + the code above, not observed. Section **f** gives the two-minute browser
confirmation, and the discriminating evidence you can check in your own smoke output is in the box
below.

> **Cross-check your output.** Because `PRINT_PAGES.guardian` sweeps the **same marksheet URL**
> (`scripts/smoke-all.mjs:113`) and the guardian is Ayan Rahman's linked owner
> (`guardianUserId` — `src/lib/auth.ts:228-237`, `guardianOwnsStudent`), a stale id must produce a
> **second, identical** ❌ line for the guardian role (`bad()` prints no role, so the two lines are
> byte-identical). If your run shows the marksheet ❌ **twice**, the id is stale — it is not a
> role/permission problem. If it appears only once, tell me and the analysis changes: for a student
> that exists, both roles render the very same document.

---

## b) What the page renders instead — exact strings

### `/print/marksheet/[studentId]` — `src/app/print/marksheet/[studentId]/page.tsx`

| Condition | Rendered text | Line |
|---|---|---|
| no session, no such student, student of another school, or a guardian who does not own the child | **`Marksheet not found.`** | `:10` |
| student exists but `classId` is null, **no exam for the student's class(+section)**, or **no marks on any of those exams** | **`No marks have been recorded for this student yet.`** | `:11` |
| success | `Academic Marksheet · {year}` (the header pill) | `:226` |

All three return **HTTP 200** — the not-found/empty branches are plain JSX, not `notFound()`. That
is exactly why the smoke message is "rendered but missing", not "HTTP 404": the marker check
(`:230`) is the only thing that catches it, and it is a sound check because the string
`Academic Marksheet` appears **only** on the success path (`:226`).

### `/print/report-card/[examId]/[studentId]` — `src/app/print/report-card/[examId]/[studentId]/page.tsx`

| Condition | Rendered text | Line |
|---|---|---|
| `!exam`, `!student`, wrong school, or (guardian) not the owner / unpublished / class mismatch | **`Report card not found.`** | `:9` |
| success | `Grading scale — {scheme.name}` | `:204` |

**This page has no empty state.** Its grading-scale block sits in the unconditional success return,
so even an exam with **zero marks** still prints `Grading scale — …`. Therefore the marker can be
missing **only** via the `NOT_FOUND` branch at `:9` — i.e. `!exam || !student` (a school mismatch is
excluded here, because the school id is deterministic: `schoolDoc(slug) => s_${sha1(slug)}`,
`scripts/seed.mjs:73`). **Failure 2 therefore proves that `Z1lw7KL79rR0Wv22MfU9` (or the student id)
does not exist in the database that was swept.** That is an airtight, code-only deduction.

### `/teacher/marks` — `src/app/teacher/marks/page.tsx`

| Condition | Rendered | Line |
|---|---|---|
| exam picked and published | amber banner `⚠ This exam is published — marks are locked. Unpublish it from the Exams module to edit.`; every mark input carries the HTML `disabled` attribute | `:180-183`, `:238` |
| no exam/sheet picked | `EmptyState` "No sheet loaded" / "Select an exam to load its subject sheet." | `:245-249` |

---

## d) Checks 3 & 4 — selector, condition, and whether the seed can satisfy them

**What the headless test does** (`scripts/smoke-all.mjs`):

1. `page.goto(/teacher/marks)`, wait for `document.querySelectorAll('select').length > 0` (`:797-798`),
   then `pickExam` (`:566-573`) picks the **first `<select>`** (the Exam picker) and dispatches
   `change` on the **first option that has a non-empty value**.
2. Phone (`:799-812`): wait for `.ss-marks-row`; then
   `editable: !!input && input.tagName === 'INPUT' && input.type === 'number' && !input.disabled`
   where `input = rows[0].querySelector('input')`. If the sheet never rendered → "the exam sheet never
   rendered after picking an exam" (`:821`); if there is no input → "no mark input in row 1" (`:824`);
   else if not editable → **"the mark input is not a real editable `<input type="number">`"** (`:825`).
3. Desktop @1440 (`:843-859`): `editable: !!input && input.type === 'number' && !input.disabled`;
   failure text **"the mark input is not editable at desktop width"** (`:859`).

**Your reported messages are the `!editable` branches, not the missing-data branches.** That is the
decisive clue: `.ss-marks-row` **did** render and row 1 **did** contain an `<input>` — otherwise you
would have seen "the exam sheet never rendered…" / "no mark input in row 1" instead.

**Why `editable` is false — the page disables the field for a published exam:**

```js
// src/app/teacher/marks/page.tsx:128-129
const activeExam = exams.find((e) => e.id === examId);
const locked = !!activeExam?.published;
//                                              :238
<input className="input min-h-11 w-full text-center …" type="number" … disabled={locked} />
```

The element is a genuine `<input type="number">` with `onChange` and `value={val}`; it is simply
`disabled` because the chosen exam is published.

**And the seed publishes the only exam** — `scripts/seed.mjs`:

```js
:492  const ref = db.collection("exams").doc();          // the sole seeded exam
:502    published: false,
…
:529  if (!exam.published) {
:530    await db.collection("exams").doc(exam.id).update({ published: true, publishedAt: day(-5) });
:531  }
```

`pickExam` then selects the first (and only) exam option — "First Term Examination 2026 — Class 1
(published)" — which sets `locked = true` and disables every mark input. **Both the phone and the
desktop failure are this one fact.**

**Is it a data precondition rather than a code defect?** Yes — but the precondition that is unmet is
the *opposite* of "no exam/marks assigned to `teacher@sunrise.edu`". The seed **does** produce the
data an input can render from:

- `/api/exams` (GET) admits `TEACHER` and returns the school's exams unfiltered by teacher
  (`src/app/api/exams/route.ts`), so the seeded exam is listed.
- `/api/exams/[id]` (GET) admits `TEACHER` and returns `subjects` (the sheet columns) and `students`
  (Class 1-A roster, `orderBy roll`) — `src/app/api/exams/[id]/route.ts`.
- The seed gives Class 1-A two students (Ayan Rahman roll 1, Mim Akter roll 2 — `scripts/seed.mjs:294-295`)
  and 7 marks each (`:509-528`).

So the sheet renders, with disabled inputs. **This is a fixture/spec mismatch between the seed and
the smoke suite, not a page bug:** the seed publishes the exam, and the app intentionally locks marks
entry for published exams.

**UNVERIFIED:** whether an *unpublished* exam makes the two checks pass could not be exercised (no
run allowed). The code says `disabled={locked}` with `locked` false ⇒ enabled inputs, and the phone
assertion additionally wants `inputH >= 44` (`min-h-11`, `:239`) — both satisfied.

---

## e) Evidence per verdict

**#1 marksheet — LIKELY TEST-DATA ARTIFACT.**
`Academic Marksheet` exists only at `src/app/print/marksheet/[studentId]/page.tsx:226`, on the
success path. The failure means the page took `NOT_FOUND` (`:10`) or `EMPTY` (`:11`). For a real
Class 1-A student the success path is guaranteed: the exam is seeded for `Class 1` / section
`Class 1-A` (`scripts/seed.mjs:492-505`) and filtered by that same class+section in the page
(`:65-72`), and the marks are seeded for every Class-1 student (`:509`). So the id does not resolve →
stale (provenance in section a). *Secondary possibility:* if the id turns out to be **valid** but
belongs to a **Class 1-B** student (e.g. Tahsin Ahmed, `scripts/seed.mjs:296`), the page renders
`EMPTY` — the exam is section-scoped to 1-A while marks are seeded for all of Class 1. Either way
the fix is the fixture, not the page.

**#2 report card — LIKELY TEST-DATA ARTIFACT.** Airtight: the page has no empty state, so the
missing marker can only come from `Report card not found.` (`:9`) ⇒ `!exam || !student`. The exam id
is a Firestore auto-id minted at `scripts/seed.mjs:492` and therefore new on every fresh seed.

**#3/#4 teacher marks — LIKELY TEST-DATA ARTIFACT.** The check's own error text (not "no mark input
in row 1") proves the row and the `<input>` rendered; `disabled={locked}`
(`src/app/teacher/marks/page.tsx:238`) with `locked = !!activeExam?.published` (`:129`) and a seed
that force-publishes the exam (`scripts/seed.mjs:529-531`) is the only combination that produces
exactly these two messages.

**Not LIKELY CAUSED BY THE COLLEGE-SUPPORT BRANCH for any of the four** — the diff in section **c**
is empty for every involved path except the 3-line guard.

---

## f) Manual confirmation in the browser, and the correct re-run

### 0. Prerequisites (same as the run you did)

The app/shell must carry the emulator environment, or `requireEmulator()` (`scripts/lib/guard.mjs`,
called at `scripts/smoke-all.mjs:31`) exits 1 before any check:

```bash
export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
export FIREBASE_PROJECT_ID=demo-ss-test
unset FIRESTORE_DATABASE_ID FIREBASE_CLIENT_EMAIL FIREBASE_PRIVATE_KEY SMOKE_ORIGIN BASE BASE_URL
```

Server on `:3123` (or whatever `SMOKE_PORT` you used). Emulator UI: `http://127.0.0.1:4000/firestore`
→ pick project **`demo-ss-test`**.

### 1. Read the *real* ids out of the emulator UI

- **Student id:** Firestore → collection **`students`** → open the document whose field
  `admissionNo == "SUN-2026-1A-001"` (**Ayan Rahman**, Class 1-A, the student the default belongs to).
  The value to copy is the **document ID** (shown in the document header / path `students/<ID>`), not
  a field — it looks like `st_` + 32 hex chars.
- **Exam id:** collection **`exams`** → the single document (field `name == "First Term Examination 2026"`,
  `classId` = Class 1, `published == true`) → copy its document ID (20 characters).

### 2. Confirm failure 1 by eye

Log in at `http://school.localhost:3123/login` as `principal@sunrise.edu` / `School@123`, then open

- `http://school.localhost:3123/print/marksheet/<the id you copied>`

and compare with the failing URL. What you see tells you which branch fired:

- sheet prints with the **"Academic Marksheet · 2026"** pill → **the default id is stale** (this is the
  confirmation), because the same page with the correct id must succeed;
- **"Marksheet not found."** → the id does not exist → stale;
- **"No marks have been recorded for this student yet."** → the student exists but has no exam/marks
  for their class+section (the Class-1-B case above).

Then open the failing URL **verbatim** — `…/print/marksheet/st_ba99122920f48693f156f2b16e57ef66` — and
you will see whichever of those two strings applies.

**Guardian twin:** log in at `http://parents.localhost:3123/login` as `guardian1@demo.com` /
`Guardian@123` (Ayan Rahman's linked guardian, `scripts/seed.mjs:294,373-375`) and open the same
`/print/marksheet/<Ayan's id>` — it must print. If the school-admin URL fails and this one prints,
that contradicts the code and the cause is elsewhere; check whether your smoke output had the
marksheet ❌ line **twice** (once per role).

### 3. Confirm failure 2 by eye

Still as `principal@sunrise.edu`, open

- `http://school.localhost:3123/print/report-card/<exams doc id>/<students doc id>`

→ a full report card with **"Grading scale — …"**. Then open the failing pair
`…/report-card/Z1lw7KL79rR0Wv22MfU9/st_ba99…ef66` → **"Report card not found."** The page cannot render
anything else with a bad id.

### 4. Re-run smoke-all with the correct ids

```bash
SMOKE_PORT=3123 \
SMOKE_STUDENT_ID=st_<32hex from students/SUN-2026-1A-001> \
SMOKE_EXAM_ID=<20-char id from exams/First Term Examination 2026> \
node scripts/smoke-all.mjs
```

Checks 1 and 2 should go green. Checks 3 and 4 will **still fail** (see next step) — the ids do not
affect them.

### 5. Confirm failures 3 & 4 by eye, then clear the data precondition

Log in at `http://teacher.localhost:3123/login` as `teacher@sunrise.edu` / `Teacher@123` → `/teacher/marks`.
Choose **"First Term Examination 2026 — Class 1 (published)"**. You will see:

- the amber banner `⚠ This exam is published — marks are locked. Unpublish it from the Exams module to edit.`
- two student cards (Ayan Rahman, Mim Akter) whose **Marks** fields are greyed out and cannot be typed into.

In DevTools: `document.querySelector('.ss-marks-row input').disabled` → `true`, and
`.type` → `"number"`. That is exactly what `editable` in the smoke check tests (`smoke-all.mjs:811,852`),
so the failure is the `disabled` term, not the tag or the type.

To clear it: as `principal@sunrise.edu` → `http://school.localhost:3123/dashboard/exams` → open
"First Term Examination 2026" → **unpublish** (PATCH `published: false`,
`src/app/api/exams/[id]/route.ts`). Reload `/teacher/marks` → inputs become editable. Re-running
`node scripts/smoke-all.mjs` then satisfies `@390` and `@1440`. (`SMOKE_HEADLESS=0` skips both checks
instead — `scripts/smoke-all.mjs:532-534`.)

**Durable fix (NOT applied — this is analysis only, nothing was changed).** Pick one and I can
implement it: (a) stop `scripts/seed.mjs:529-531` from force-publishing the exam, or seed a second,
unpublished exam; (b) make the smoke checks choose an **unpublished** exam (search the Exam `<select>`
for an option without `(published)`) rather than the first option with a value; (c) accept a locked
sheet as a pass and assert `disabled === true` plus `min-h-11` instead. Until one of those lands,
`smoke-all` cannot be ALL GREEN after a fresh `npm run seed`, and the two hard-coded `DEMO` defaults
cannot be green on any emulator they were not captured from.

---

## Unverified / limitations

- **The emulator was never read** (by design), so "the ids are stale" is a code-plus-symptom inference,
  not an observation. Steps 1-3 above settle it in two minutes.
- **Whether the run that produced your four failures also printed a fifth, identical
  (guardian) marksheet line** is unknown from the summary. The code says it must have; if it did not,
  that single fact would redirect the investigation.
- **Whether `SMOKE_STUDENT_ID` / `SMOKE_EXAM_ID` were exported** in your shell is unknown; if they were,
  the "stale default" conclusion does not apply to failures 1 and 2 and the ids themselves need to be
  checked against the emulator.
- **The emulator's actual contents** (does a `students` doc with `SUN-2026-1A-001` exist; which
  document id it has; the exam's document id and `published` flag) were not inspected.
- **`scripts/seed.mjs` was not run**, so "a fresh seed yields new ids" follows from
  `randomHex(16)` / `.doc()` in the source, not from an observed run.
- The report makes **no claim about the production `amar-e-school` data**; the same literals also
  exist in `_perf-remediation/{cutover-wt,login-p0-wt}/scripts/smoke-all.mjs`, so which database they
  were originally captured from is not established.
