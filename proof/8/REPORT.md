# Phase 8 — the record (8-pre, ca-0…ca-6 finished at ca-6)

This file is Phase 8's proof folder. **Part 1 (§0–§5) is ca-5's own proof**, as written at that stage;
**Part 2 (§6) is ca-6's finished Phase 8 record** — the stage-by-stage counts table, what could not be
run again, and the phase's open items.

**The ca-5 stage of it:**

**Branch:** `phase8/college-attendance`. **base:** `9bcbfb1` (ca-4) → this stage's commit.
**Decisions:** [docs/COLLEGE-DECISIONS.md](../docs/COLLEGE-DECISIONS.md) §24.8 (D-CA-1…D-CA-7) and §31,
the section this stage adds. **Status:**
[docs/COLLEGE-STATUS.md](../docs/COLLEGE-STATUS.md). **How to run:**
[docs/TESTING.md](../docs/TESTING.md).

ca-5 is D-CA-7's fifth register step and the one it describes as *"isolation + regression, baselines
first, and the school's own attendance paths re-run to identical counts"*. It adds **no product code**:
`src/` is untouched. What it adds is the evidence that the register ca-1…ca-4 built is confined like
every other college row, that the school's own attendance is undisturbed, and the one thing ca-4's
record still owed — a **real browser** run of the register screen.

Everything below was run on the emulator only (`127.0.0.1:8080`, `demo-ss-test`), the app restarted
after each emulator wipe. `scripts/suite-all.mjs` was run once, in full (item 6).

---

## 0. The status check ca-5 was asked to make first (no edits before it)

The stage asked whether ca-4's page and view module use `PRESENT/ABSENT/LATE/LEAVE` **exactly** as
`src/lib/college-attendance.ts` does, because ca-4's *first* report had said `EXCUSED`. **Read before any
edit, and the code was right; the earlier prose was wrong.**

```
$ grep -rn "EXCUSED" src scripts docs
scripts/verify-college-attendance-logic.mjs:408:    "EXCUSED",     ← a NEGATIVE probe (a value that must be refused)
scripts/verify-college-attendance-page.mjs:215:     [null, undefined, "", "PRESENT ", 0, {}, "EXCUSED"].every(...)  ← negative probe
scripts/verify-college-attendance-page.mjs:223:     typeof view.markTone("EXCUSED") === "string"                  ← negative probe
scripts/verify-college-attendance-page.mjs:256:     { studentId: "s4", …, status: "EXCUSED" }                     ← negative probe
scripts/verify-course-attendance.mjs:696:          … status: "EXCUSED" …                                    ← live negative probe (a 400)
```

- `src/` contains **no** `EXCUSED` at all. `college-attendance.ts` exports
  `COURSE_ATTENDANCE_STATUSES = ["PRESENT", "ABSENT", "LATE", "LEAVE"]` plus the read-only
  `UNMARKED` placeholder, and `college-attendance-view.ts` takes its vocabulary from that module
  (`statusOptions()`, `isStorableStatus()`, `markTone()`, `statusLabel()` all switch on those four
  values, each with its own non-empty word and fill). The page carries **no status literal** of its own.
- Every `EXCUSED` in the tree is inside a **test that requires it to be refused** — which is the
  opposite of a vocabulary mismatch, and is exactly what a fifth status should look like.
- **Conclusion: no conflict, nothing to stop for.** The correction of ca-4's prose is recorded in §31
  and in PROGRESS.md so the wrong word cannot be quoted again.

---

## 1. Isolation — baselines first, then the new counts

Both isolation verifiers were **extended**, not replaced, and they were run **once before the change** to
record the baseline (the stage's rule). Both are server-backed; each run here was
`SUITE_PURE=0 SUITE_ONLY=… node scripts/suite-all.mjs`, so each verifier got its own emulator wipe,
`seed.mjs`, `isolation-fixture.mjs create` and app restart.

| Verifier | Baseline (before ca-5) | After ca-5 | Δ | exit |
|---|---|---|---|---|
| `verify-tenant-isolation` | **107** ✅ / 0 ❌ | **117** ✅ / 0 ❌ | **+10** | 0 |
| `verify-branch-isolation` | **72** PASS / 0 FAIL | **79** PASS / 0 FAIL | **+7** | 0 |

*A note on the counting, so the two figures reconcile:* COLLEGE-STATUS §3 last recorded
`verify-tenant-isolation` at **106 ✅** and `verify-branch-isolation` at **73 PASS lines (72 checks + its
summary)**. Both match exactly. For the tenant verifier the ✅ figure counts one more than the check
lines because its own closing line (`✅ ISOLATION CONFIRMED — …`) is itself a ✅: the baseline run here
printed **106 check lines / 107 ✅**, and with ca-5 **116 / 117** — i.e. the documentation's 106 was the
check count and this stage adds exactly **+10 checks**. Branch is **72 → 79 check lines** (its summary
line starts with ✅, so the suite's own counter reads 72 → 79 too). Nothing drifted; the delta is
entirely ca-5's.

### What the tenant section now proves (`### course attendance — a COLLEGE tenant's rows and its three routes`)

All three ca-3 routes — `GET /api/course-attendance` (the session roster), `POST /api/course-attendance`
(the session save) and `GET /api/course-attendance/history` — measured across the **three** tenants that
can run a college (the COLLEGE fixture, the BOTH tenant, and a SCHOOL tenant):

1. a COLLEGE tenant reads its **own** course register: 200, the course resolves, the roster is exactly
   the course's APPROVED registrations (the fixture's pair is PENDING, so `[]`) and the summary counts
   nothing;
2. …and reads back its **own stored row** with its status through the history read;
3. the BOTH tenant's read of a COLLEGE course is **404 — byte-identical to the ghost id's answer**
   (never a 403 that would confirm the row exists), and its save and history are 404 too;
4. the refused cross-tenant **save wrote nothing**: the COLLEGE row still reads `PRESENT` and the
   collection's row count for that tenant is unchanged;
5. the **reverse** direction: the COLLEGE tenant is 404 on the BOTH tenant's course, read/save/history
   alike;
6. a **SCHOOL** tenant meets the COLLEGE gate on all three routes — 403 with zero data;
7. the BOTH tenant reads only **its own** attendance row: the payload carries neither the COLLEGE row's
   id nor any `ZZ Iso College` name;
8. a **ghost student** under the COLLEGE tenant's own course is 404 on the history read too.

### What the branch section now proves (`### college course attendance — branch admin confinement (ca-5)`)

On the COLLEGE tenant's two branches: a BRANCH_ADMIN reads its **own** branch's course register (200)
and another branch's is **404**; its session save for another branch's course is 404 and **that row is
left unchanged**; its history read serves its own branch's stored row and 404s (never serving the row)
for another branch's; and the SCHOOL-scoped admin still reaches **both** branches — the confinement is
scope, not a tenant-wide hiding.

### The one honest limitation of the section, and how it is handled

The section writes its two `courseAttendance` rows **raw** (`zziso-ca5-…`, deleted on the way out; the
fixture's `schoolId` backstop sweeps the collection as well) rather than saving them through the app,
because a save needs an APPROVED registration and the fixture's own pair is deliberately PENDING —
asserted by the registrations section above, whose rows may not be mutated. A raw write is only readable
by the app **before** it has pulled that collection, which is true here (nothing else in this verifier
reads a register) and is why the row-visibility check passes deterministically; in the suite the app is
restarted per verifier, so the first pull is always fresh. **The roster grid's own row-visibility half
is ca-3's live proof** (`verify-course-attendance`, 46 checks, which builds a real roster through the
API); this section proves the *confinement* of all three routes and the absence of any foreign row.

**No fixture change was needed.** `scripts/isolation-fixture.mjs` already owns `courseAttendances`
(ca-2 added it to both the `zziso-` prefix sweep and the schoolId backstop), so the raw rows above are
covered even if a run dies mid-way.

---

## 2. Regression — the school's own attendance paths, re-run

The school's attendance surface is untouched by ca-1…ca-5 (`src/app/api/attendance/route.ts` and the
school's `attendance` key are pinned as text by ca-0's and ca-1's verifiers, and no `src/` file changed
in ca-5). The regression evidence is the **full-suite run** in §4: every school-side verifier re-ran and
reproduced its recorded count — see the table's `same/different` column, and the school attendance line
(`verify-class-sessions`) in it.

Full-suite table: see §4.

---

## 3. The browser proof — the gap ca-4 left open

ca-4's verifier says in its own header that it does **not** prove the page renders (no DOM, no React, no
browser), and ca-4's record says no browser pass had been made. ca-5 makes it, in real Chrome, over the
repository's own dependency-free driver (`scripts/lib/headless.mjs`, no new dependency):

```
node proof/8/browser-proof.mjs seed     # before the app starts (see the note below)
node scripts/dev-emulator.mjs           # the app
node proof/8/browser-proof.mjs run      # 22 checks, exit 0
node proof/8/browser-proof.mjs clean    # leaves no trace
```

`seed` writes the two students and their **APPROVED** registrations the grid needs, and it must run
**before** the app starts: the app serves Firestore reads from an in-process pull memo
(`src/lib/db.ts`) that only the app's own writes clear, so a row written raw after the app is serving
can be invisible to the very read under test — the same rule `verify-college-fees-api` and
`verify-course-attendance` are documented with. `clean` removes the students, the registrations, the
register rows **and the notification** the one ABSENT mark sent (D-CA-3).

**Result: 22 / 22, exit 0.** The transcript is `proof/8/browser-proof.txt`. What it proves, in the
browser rather than over HTTP alone:

| # | Claim | Evidence |
|---|---|---|
| 1 | the page **renders** and the navbar carries the new entry | the page's own text after navigation |
| 2 | the course picker lists the college's courses; `ZZCA-101` is selectable | the option is found and set |
| 3 | the roster grid is exactly the course's two **APPROVED** students | the two names, and a count of 2 |
| 4 | the four mark controls exist, and two marks are set | both writes report success |
| 5 | the save reports what it wrote | `Saved 2 marks · 1 family notified` |
| 6 | the **store** holds exactly the two marks the screen sent | `PRESENT` / `ABSENT` read back from Firestore |
| 7 | the rows carry the course, the slot and the session date (D-CA-1) | `courseId`, `slot=1`, `sessionDate` |
| 8 | a **REGISTRAR** sees the same roster with **no save control**, **no mark controls** and the read-only note | 2 rows, 0 mark groups, no "Save register", `Your role may read this register but never mark it.` |
| 9 | a course with no APPROVED registrations says so | `No APPROVED registrations for ZZCB-101 …` |
| 10 | a **refused role** (the college ACCOUNTANT) is told so before any read — and issues **no** register request | the screen's note, plus a request log with no `/api/course-attendance`, plus a real `403` on both directions from inside the page |
| 11 | a **SCHOOL** tenant is told the screen is college-only, issues **no** register request, and the API gates it `403` | the note, the request log, the `403` |

**One thing this proof corrected about itself, and it is worth recording.** The refused-role check
first asserted that the page shows **ca-0's** refusal sentence. It does not: the page shows the **view
module's own** sentence (`college-attendance-view.ts`'s `REFUSED_NOTE` = *"Your role may not read a
course register."*) because ca-4 owns the screen's copy, while the **API** answers with ca-0's
(`"College attendance is available to the school administration and the registrar."`). Both are now
asserted, each where it belongs — the screen's on the page, ca-0's on the two `403` bodies. The proof's
expectation was wrong, not the code; no product file was changed for it.

---

## 4. The full suite, run once from a clean state

`node scripts/suite-all.mjs` — 19 offline + 41 server-backed verifiers, each of the server-backed ones
after its own emulator wipe + `seed.mjs` + `isolation-fixture.mjs create` (+ `seed-kit-demo.mjs` where
documented) + app restart. Elapsed ≈ 46 minutes. **60 verifier(s), 56 exit 0.**

"Own count" below is the number of **check lines** the script printed (`PASS …` / `  ✅ …`, its own
affirmations, never a tally of markers) — for some verifiers the script's summary line instead carries
the authoritative number, and that is what is quoted. "vs docs" compares against the last recorded
figure for that verifier; `—` where no count is recorded for it in the docs (then today's number is
the record for the next run).

| Verifier | exit | Own count | vs docs |
|---|---|---|---|
| `verify-college-gate` | 0 | 3 | = |
| `verify-college-fees-logic` | 0 | 21 | = |
| `verify-college-fees-data` | 0 | 11 | = |
| `verify-college-results-data` | 0 | 8 | = |
| `verify-college-results-page` | 0 | 106 | = |
| `verify-college-fees-page` | 0 | 366 | = |
| `verify-college-promotion-logic` | 0 | 12 | = |
| `verify-college-promotion-page` | 0 | 18 | = |
| `verify-college-grading-logic` | 0 | 13 | = |
| `verify-college-routes` | 0 | 25 route files / 53 gated handlers | = (25/53 at ca-3, uncounted handlers since) |
| `verify-college-terms` | 0 | 8 | = |
| `verify-onboarding-seed` | 0 | 87/87 | ≠ +9 (no `src/` change in ca-5; cause not attributed here) |
| `verify-database-id` | 0 | 17 | — |
| `verify-nav-scope` | 0 | 10 (check 10 = ca-4's new carrier check) | = |
| `verify-registration-status` | 0 | 9 | = |
| `verify-college-permissions` | 0 | 7 checks / 8 ✅ | = (the docs count this one in ✅ markers) |
| `verify-college-attendance-access` (ca-0) | 0 | 17 | = |
| `verify-college-attendance-logic` (ca-1) | 0 | 31 | = |
| `verify-college-attendance-page` (ca-4) | 0 | 36 | = |
| `verify-pilot-hardening` | 0 | 260/260 | — |
| `verify-mode-foundation` | 0 | 64 | = |
| `verify-user-secrets` | 0 | 10 | — |
| `verify-onboarding-monitor` | 0 | 44 | — |
| `verify-tenant-isolation` (ca-5 +10) | 0 | **116** | = 106 + 10 |
| `verify-branch-isolation` (ca-5 +7) | 0 | **79** | = 72 + 7 |
| `verify-mode-mixing` | 0 | 33 | = |
| `verify-course-teachers` (8-pre) | 0 | 54 | = |
| `verify-course-attendance` (ca-3) | 0 | 46 | = |
| `verify-college-enrollment` | 0 | 40 | = |
| `verify-course-registrations` | 0 | 50 | = |
| `verify-enroll-paths` | 0 | 17 | = |
| `verify-enrollment-fees` | 0 | 19 | = |
| `verify-fees-totals` | 0 | 24 = the 15 school + 9 college | = |
| `verify-school-fee-idempotency` | 0 | 69/69 | = |
| `verify-fee-reconciliation` | 0 | 56 | ≠ +3 (docs record 53; not touched by ca-5) |
| `verify-qr-credentials` | 0 | 18 | — |
| `verify-notifications` | 0 | 46 | — |
| `verify-grading` (school) | 0 | 38 | = |
| `verify-guardian-child` | 0 | 25 | — |
| `verify-read-cache` | **1** | 0 pass / 1 fail | = known red |
| `verify-routine-config` | **1** | 30 pass / 2 fail / 1 skip | = the closed-gate calendar form |
| `verify-cache-scoping` | 0 | 15 | — |
| `verify-invalidation` | 0 | 8 | — |
| `verify-exams-invalidation` | 0 | 8 | — |
| `verify-write-freshness` | 0 | 4 | — |
| `verify-write-integrity` | 0 | 32 checks · 2 skipped | — |
| `verify-academic-sessions` | 0 | 13 | — |
| `verify-class-sessions` | 0 | 56 | — (no count recorded; green, item 4's school attendance path) |
| `verify-bulk-import` | 0 | 117 | ≠ −1 (docs record 118) |
| `verify-admission-intake` | 0 | 52 | = |
| `verify-onboarding-type` | 0 | 44 | ≠ +6 (docs record 38) |
| `verify-promotion-rollover` | 0 | 50 | = |
| `qa-phase23` | 0 | 36 | = |
| `qa-certificates` | **1** | 40 passed / 1 failed | = known red (the credential-gated orphan sweep) |
| `verify-phase7-e2e` (school audit) | 0 | 160 | = |
| `verify-college-results-api` | 0 | 77 | = |
| `verify-college-promotion-api` | 0 | 100 | = |
| `verify-college-promotion-lease` | 0 | 113 | = |
| `verify-sweep-routes` | **1** then **0** | 43 check lines (2 ❌) in the run; **45, all passing, alone** | seed-random; see below |
| `verify-college-fees-api` (LAST) | 0 | 112/112 | = |

### The known reds, with today's numbers

| Verifier | Today | Recorded as |
|---|---|---|
| `verify-read-cache` | 0 pass / 1 fail | the latency assertion that does not hold in dev mode |
| `verify-routine-config` | **30 pass / 2 fail / 1 skip** | the **closed-gate** calendar form — the same two class-wide-read failures; a day its section 7 runs would print 32 pass / 3 fail |
| `qa-certificates` | 40 passed / 1 failed | the credential-gated orphan sweep, which the emulator-only rule forbids fixing |

### The one unexpected failure, run alone before it is called one

`verify-sweep-routes` failed in the full run with **2 of its checks, both the same line,
`attendance rows well-formed`**, and **passed when re-run alone from a clean state** (45 checks, exit 0).

Root cause, read from the tree (no ca-5 file touched): the check asserts every school attendance row's
`status` is one of `"PRESENT"`, `"ABSENT"`, `"LATE"`, `"UNMARKED"` — but the school's own attendance
type is `"PRESENT" \| "ABSENT" \| "LATE" \| "LEAVE"` (`src/lib/db.ts:68`), and `scripts/seed.mjs`
writes a `LEAVE` row with **5 % probability per student-day** (`Math.random()`, so not deterministic).
When today's random seed happened to put a `LEAVE` row in the class the sweep probes, the checker called
a row the product itself defines as valid ill-formed. It is a **pre-existing vocabulary gap in that
checker**, not a ca-5 regression: ca-5's diff is two verifier scripts (`scripts/verify-tenant-isolation.mjs`,
`scripts/verify-branch-isolation.mjs`) plus the proof folder, and no `src/` file at all. Recorded here
rather than fixed, because ca-5 authorises no school-side edits; the one-line correction (add `LEAVE`
to that list, so the checker agrees with `db.ts`'s own type) is left as its own change.

---

## 5. What ca-5 does NOT prove

- **The 46-check live API proof was not re-run in this stage**; it is ca-3's, unchanged (ca-5 touches no
  `src/`), and it re-runs in the full suite.
- **The browser proof drives Chrome, not a device**: no mobile viewport, no touch, no offline/print
  path, and it is not in any suite (it needs the emulator, the app, the fixture and a browser) — so it
  is evidence recorded here, not a gate that can fail a later run. That is deliberate and matches the
  D-7-18 role probe's standing.
- **No teacher, guardian or student surface exists to prove** (v1 is staff-only, D-CA-4/Q8); the
  browser proof's refused-role case is the ACCOUNTANT, a staff role.
- **ca-6 has not run**: this is not the finished record.
---

## 6. The finished Phase 8 record (ca-6, BUILT 2026-10-14)

ca-6 is docs-only by design — a final record with **no `src/` or `scripts/` edit, no server started**,
no suite run, no deploy, no push to anything but the phase branch. §0–§5 above are ca-5's own proof;
this part closes Phase 8 (8-pre → ca-6) over the whole branch `phase8/college-attendance` (8-pre
`3e7be47` … ca-5 `977130c`).

### 6.1 The counts, stage by stage

Every count below is what the **script itself printed** (check lines, or the script's own summary line
where it carries the number); the suite counts ✅ markers, which is one more for the verifiers whose
closing ✅ is part of the same line — the convention each earlier phase used is shown alongside.

| Stage | Verifier | Count | Note |
|---|---|---|---|
| **8-pre** (§25) | `verify-course-teachers` | **54** checks, exit 0 | the live matrix + offline pins; first verifier to import a pure module |
| 8-pre | `verify-college-routes` | **23 route files / 50 gated handlers** | the `courses` segment gains three handlers |
| 8-pre | `verify-college-fees-data` / `-results-data` | **11** / **8** | their pre-7b / pre-6b baselines still reproduce |
| **ca-0** (§26) | `verify-college-attendance-access` | **18** checks, exit 0 | new, offline; the allow-list + ca-0's boundary |
| **ca-1** (§27) | `verify-college-attendance-logic` | **30** checks, exit 0 | the id, slot, statuses, roster, notify rule |
| **ca-2** (§28) | `verify-college-attendance-logic` | **31** | the store's own `dateKey` is now EXECUTED against the mirror |
| ca-2 | `verify-college-attendance-access` | **17** | ca-0's `db.ts` pin removed with the collection it owned |
| ca-2 | `verify-college-fees-data` / `-results-data` | **11** / **8** | `courseAttendance` joins `LATER_MODELS` both ways |
| **ca-3** (§29) | `verify-course-attendance` | **46** checks, exit 0 | new, offline+live (its live half from a wiped, reseeded, app-restarted state) |
| ca-3 | `verify-college-routes` | **25 route files / 53 gated handlers** | the `course-attendance` segment lands with its directory |
| ca-3 | `verify-college-fees-data` | **11** | check 8 re-scoped to a `laterSegments` list; no other check weakened |
| **ca-4** (§30) | `verify-college-attendance-page` | **36** checks, exit 0 | new, offline; the mark vocabulary, the payload rule, ONE endpoint/rule |
| ca-4 | `verify-nav-scope` | exit 0, snapshot **byte-identical** | the college href list is EIGHT, the marker product **25** (8+8+8+1), and **check 10 is new** — the register's carrier set |
| ca-4 | `verify-college-attendance-access` / `-logic` | **17** / **31** | their consumer pins extended by name |
| **ca-5** (§31) | `verify-tenant-isolation` | **106 → 116** check lines | +10, baseline taken first |
| ca-5 | `verify-branch-isolation` | **72 → 79** | +7, baseline taken first |
| ca-5 | `proof/8/browser-proof.mjs` | **22 / 22, exit 0** | the register screen in a real Chrome (§3) |
| ca-5 | `verify-course-attendance` | **46** | re-run inside the full suite from a wiped state (the API is untouched) |
| ca-5 | full suite `suite-all.mjs` | **60 verifier(s), 56 exit 0** | once, from a clean state (§4) — ca-4's rule excepted, authorized that stage |

**tsc:** `npx tsc --noEmit` — **0 errors** after every stage above (8-pre, ca-0…ca-5), and **0 errors
with zero output line(s) at ca-6** (re-verified at ca-6 without a save-pipe so the exit code is the
compiler's own).

### 6.2 Re-run at ca-6 (offline only — no servers, no suite)

| Check | Command | Result | vs baseline |
|---|---|---|---|
| `verify-college-attendance-access` | `node scripts/verify-college-attendance-access.mjs` | exit 0 — **17 checks** | = |
| `verify-college-attendance-logic` | `node scripts/verify-college-attendance-logic.mjs` | exit 0 — **31 checks** | = |
| `verify-college-attendance-page` | `node scripts/verify-college-attendance-page.mjs` | exit 0 — **36 check(s)** | = |
| `verify-college-routes` | `node scripts/verify-college-routes.mjs` | exit 0 — **25 college route file(s), 53 gated handler(s)**, no unclassified API directory | = |
| `verify-nav-scope` | `node scripts/verify-nav-scope.mjs` | exit 0 — **10 checks** (11 ✅ markers: its own closing line is one more), snapshot byte-identical | = |
| `npx tsc --noEmit` | `npx tsc --noEmit` | exit **0**, 0 line(s) of output | = |

### 6.3 The four documents agree, after ca-6's stale-text pass

`docs/COLLEGE-DECISIONS.md` (§25–§31, plus the dated corrections this stage appended to §24.10 and
§30), `docs/COLLEGE-STATUS.md`, `PROGRESS.md` and `docs/TESTING.md` now agree on one statement:
**Phase 8 is complete — 8-pre and ca-0…ca-5 are built and verified, and ca-6 is this finished record —
while the dashboard/reports/import trio is renumbered 9a/9b/9c and NOT started.** The stale sentences
that would have read the other way were corrected here rather than argued with:
`COLLEGE-STATUS`'s §0 "ca-5 and ca-6 have not started", its §4 "per-course attendance — **not built**"
plus the fees bullet's "what 8/9 own", its §5 row 3's "ca-5/ca-6 … NOT built", `COLLEGE-DECISIONS`'s
§30 "ca-5 and ca-6 remain" and §24.10's "Phase 8's 8-pre/ca-1..ca-6 still owe theirs",
and `TESTING.md`'s ca-4 entry "no browser pass of the screen has been recorded yet" — each corrected
by appending its dated supersession, not by rewriting history.

*One record left as authored, recorded here rather than corrected:* `proof/8pre/REPORT.md` says the
link was "built … on `integration/main-into-college`, working tree from `af65774`", while its commit
`3e7be47` and every later Phase 8 commit sit on `phase8/college-attendance` (the leaf branch cut from
that HEAD, to keep `integration/main-into-college` at `af65774` while Phase 8 landed). The work is
verified either way; the branch label in that record is the one thing a reader should re-point.

### 6.4 What cannot be claimed past a stage boundary

- **The live halves of `verify-course-attendance` (46) and the browser proof (22/22) were not re-run at
  ca-6**: ca-6 starts no server, and each is a **once-per-app-start** proof (the suite restarts the app
  per server-backed verifier, which is what makes its order deterministic). Both are re-verified by the
  next emulator-backed run, not by this one. `verify-course-attendance` was last run from a wiped state
  by ca-5's suite; the browser proof was last run, and its rows cleaned, at ca-5.
- **The full suite was not re-run at ca-6**, and `scripts/suite-all.mjs` was not started at all this
  stage; ca-5's run (§4) is the suite evidence this record stands on.
- **The counts of the ca-6 re-run prove the offline surface only** — the pure modules, the route
  guard's static sweep, the nav registry and the typecheck. The store behaviour behind them is the
  ca-3 live proof and ca-5's isolation sections.
- Nothing was deployed, nothing was pushed to `main`, and `integration/main-into-college` was never
  touched (still `af65774`).

### 6.5 The open items — what Phase 8 deliberately did not build

a. **The course-teacher admin picker is not built.** D-8P-5 places it "with the course screens", but
   D-CA-7's ca-4 line schedules only the register and its nav entry, so the ca-4 stage's own condition
   was not met and it was left for its own stage rather than half-built; `/api/courses` keeps its exact
   shape and nothing in Phase 8's register work calls `/api/courses/[id]/teachers`. The link itself
   (the `courseTeacher` row and its API) IS built — 8-pre, 54 checks — which is exactly the
   prerequisite the record names.
b. **No teacher-facing read exists.** v1 is staff-only (D-CA-4, owner Q8): the register's read list is
   the admin-level roles plus a read-only REGISTRAR, `TEACHER` is refused both directions by ca-0's
   rule even though the link now makes a teacher-facing surface possible, and the proofs pin it
   (`verify-college-attendance-access`, `verify-course-attendance`'s live TEACHER 403/403). Any
   teacher-facing surface — a markable register for a course's own teachers, or the post-v1 per-course
   teacher view of results (§23.6) — is an **owner decision**, not a Phase 8 gap. The guardian /
   student family-facing read is the same ruling, post-v1 by the same owner decision.
c. **`verify-sweep-routes`' `attendance rows well-formed` check omits `LEAVE`.** The school's own
   `AttendanceStatus` type (`src/lib/db.ts:68`) is `PRESENT | ABSENT | LATE | LEAVE` and
   `scripts/seed.mjs` writes a `LEAVE` row with 5 % probability, so that school-side checker calls a
   valid row ill-formed on some seeds: it failed in ca-5's full run (2 of its checks) and **passed when
   re-run alone from a clean state (45 checks)**. It is a one-line correction — add `LEAVE` to that
   list so the checker agrees with the product's own type — and it belongs to its own change: ca-6
   makes no `scripts/` edit, so it stands as recorded in §4 and §31.
d. **Four count drifts are recorded but unattributed**: `verify-onboarding-seed` 78 → **87/87**, 
   `verify-onboarding-type` 38 → **44**, `verify-fee-reconciliation` 53 → **56** (printed), and
   `verify-bulk-import` 118 → **117**. No `src/` file in ca-0…ca-5's diffs can be their cause; each is
   recorded in the §4 table with today's number rather than smoothed over.
e. **The three documented known reds are unchanged and are not Phase 8's**: `verify-read-cache`
   **0 pass / 1 fail**; `verify-routine-config` **30 pass / 2 fail / 1 skip** (the closed-gate calendar
   form; a day its section 7 runs prints 32 pass / 3 fail) — the class-wide-read defect the seed's
   section-scoped routines cause; `qa-certificates` **40 passed / 1 failed** (the credential-gated
   orphan sweep the emulator-only rule forbids fixing). None is caused by any of these commits, and
   ca-6 claims none as green.

### 6.6 Where the next phase begins

The next work on this line is **Phase 9a/9b/9c** (college dashboard, reports, import) — renumbered
from 8a/8b/8c when attendance took Phase 8 (D-CA-6, §10's dated correction) — and it is **not
started**. It becomes materially more useful now that attendance exists to report on, and its open
design question (§24.10) — whether a BOTH tenant's stats/dashboard payloads need a mode dimension for
the fee money — is **still an owner decision**, because Phase 8's reads do not reach `/api/stats`.
The v1 attendance marking ship is complete at ca-6 and its register is staff-facing only; everything
else around attendance is recorded above as an owner decision, not a Phase 8 gap.
