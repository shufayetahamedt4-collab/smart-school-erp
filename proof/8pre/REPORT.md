# proof/8pre — Phase 8-pre, the course↔teacher link

**Built and verified 2026-10-14** on `integration/main-into-college`, working tree from `af65774`
(the pre-merge record). Emulator only (`127.0.0.1:8080`, project `demo-ss-test`); nothing deployed and
nothing pushed. The decision record is [docs/COLLEGE-DECISIONS.md](../../docs/COLLEGE-DECISIONS.md)
**§25 (D-8P-1…D-8P-7)**; the owner's ruling that made this `8-pre` is Q8 (2026-10-11) in §24.9, and
D-CA-4 in §24.8.

## Why it existed at all

At `6a7a31f` the college could not answer "who teaches this course?":

```
$ grep -rn "teacherId" src/app/api/courses src/app/api/course-registrations src/lib/college-*.ts
(no matches)
$ grep -n "programCourse:" -A 3 src/lib/db.ts     # the mapping row's fields
{ schoolId, programId, courseId, termNumber, requirement }   # and nothing more
```

Two consequences were already recorded (§24.8, D-CA-4): v1 attendance marking is staff-only, and BOTH
teacher-facing college surfaces (a teacher marking their own course register, and the post-v1
per-course teacher view of results) are blocked on the same missing link. Q8 made the link `8-pre` —
the FIRST step of Phase 8.

## What was built

| file | what it is |
|---|---|
| `src/lib/course-teachers.ts` | **new, pure (no imports at all).** The derived id `ct_<courseId>_<teacherId>` (both halves required + trimmed; an empty half THROWS), the strict assignee allow-list `["TEACHER"]`, `normaliseTeacherIds`, and the two refusal sentences. |
| `src/lib/db.ts` | `COLS.courseTeacher → "courseTeachers"` (caller-supplied derived id ⇒ NO `idFor`/`idForCreate` entry, the `promotionRun` shape), a NEW `RELS.courseTeacher` key (`school`/`branch`/`course`/`teacher`, every fk a STORED field), and the `prisma.courseTeacher` accessor. **No pre-existing RELS body edited.** |
| `src/app/api/courses/[id]/teachers/route.ts` | **new.** `GET` list / `POST` assign / `DELETE` unassign, in the college guard order, audited (`COURSE_TEACHER_ASSIGN` / `COURSE_TEACHER_UNASSIGN`), idempotent on re-assign. |
| `src/app/api/courses/[id]/route.ts` | one guard added to `DELETE`: a course with a teacher assigned is refused 400 (`COURSE_TEACHER_DELETE_BLOCK`) so no link row can be orphaned. |
| `scripts/verify-college-routes.mjs` | `courseTeacher` added to `COLLEGE_MODEL_RE` — a STRENGTHENING (`\b` keeps `course` from matching it), so a school route cannot reach a college link unnoticed. |
| `scripts/verify-college-fees-data.mjs`, `scripts/verify-college-results-data.mjs` | `courseTeacher` added to `LATER_MODELS`, so their recorded pre-7b / pre-6b baselines still reproduce. |
| `scripts/verify-course-teachers.mjs` | **new.** The proof: offline pins + the live HTTP matrix. |
| `scripts/suite-all.mjs` | the new verifier joins the college group, before `verify-college-fees-api` (which resets its own tenant LAST). |

## The run

```
$ SUITE_ONLY=verify-course-teachers node scripts/suite-all.mjs     # 16 offline siblings + this one
verify-course-teachers           exit=  0    55✅   0❌    37s  ok
                                 own="✅ COURSE TEACHERS OK — 54 checks: the derived id, the store entry,
                                      the guard order, and the live matrix (assign/idempotent/list, the
                                      refusals, branch + tenant confinement, unassign, the course-delete block)"
TOTAL: 17 verifier(s), 211 ✅ / 0 ❌ markers, 17 exit 0
known reds (allowed): (none reported this run)
unexpected failures: (none)
```

The state was fresh, as the suite requires: **wipe → `npm run setup` → `node scripts/seed.mjs` →
`node scripts/seed-kit-demo.mjs` → `node scripts/isolation-fixture.mjs create` → the app started AFTER
the wipe.** The runner's own line reads **55 ✅** for **54 checks**: the extra ✅ is this script's own
final summary line, the marker-vs-check accounting the suite documents (`verify-college-fees-page`'s
366 checks read as 1 ✅ marker the same way).

### Offline — the module is IMPORTED, the tree is pinned

```
1. the derived id — one row per pair, the id IS the uniqueness rule
  ✅ the prefix is `ct_` — ct_
  ✅ the id is `ct_` + the course id + the teacher id — ct_zziso-col-course-a_t_zziso-user-teacher
  ✅ the same pair always derives the same id (a re-assign addresses one row)
  ✅ a different course or a different teacher is a different row
  ✅ whitespace around either half is trimmed, so ` c1 ` and `c1` are one row
  ✅ an empty half THROWS rather than deriving an id shared by every caller — 5/5 refused
2. the assignee rule — a course is taught by a TEACHER account, and nothing else
  ✅ the allow-list is exactly [TEACHER]
  ✅ TEACHER is assignable
  ✅ every other role/absent value is refused (12 probed) — none accepted
3. the id-list normaliser — duplicates are one teacher, blanks are typos
  ✅ trims, drops duplicates and blanks, keeps the first-seen order
  ✅ a non-array is an empty list (never a throw)
4. the store — one collection, one relation block, no derived-id entry
  ✅ COLS maps courseTeacher to "courseTeachers"
  ✅ no second model shares that collection name
  ✅ neither idFor nor idForCreate has a courseTeacher entry (the caller supplies the id)
  ✅ RELS.courseTeacher exists with school/branch/course/teacher, every fk a stored field
  ✅ every relation target is a registered model
  ✅ no pre-existing RELS body was touched: `course` and `teacher` do not name the link
  ✅ and both kept the relations they had before 8-pre — school,branch,department,programCourses,registrations
  ✅ the prisma shim exposes courseTeacher (the ONE way to reach the row)
5. the API — the college guard order, the derived id, the audit
  ✅ the link lives in the `courses` college segment (src/app/api/courses/[id]/teachers/route.ts)
  ✅ it exports GET, POST and DELETE — GET,POST,DELETE
  ✅ getSession() → requireCollege() → can()/prisma in every handler
  ✅ the id is derived with the module's own helper (never re-implemented)
  ✅ the write is guarded (writeGuard) and audited
  ✅ a foreign course id is NOT FOUND, never a 403 oracle
  ✅ a non-teacher account is refused by the module's own sentence
  ✅ an existing assignment answers `already: true` and writes nothing
6. the course DELETE is blocked while a teacher is assigned
  ✅ the delete reads prisma.courseTeacher.count and returns the module's block message
  ✅ the block message is imported from the module, not re-typed
7. the link is wired into the guards that must know about it
  ✅ COLLEGE_MODEL_RE lists courseTeacher — department|program|programCourse|course|courseResult|courseTeacher|collegeFeeHead|…|collegeDiscount
  ✅ scripts/verify-college-fees-data.mjs drops courseTeacher by name — "collegeDiscount", "courseTeacher"
  ✅ scripts/verify-college-results-data.mjs drops courseTeacher by name — …, "courseTeacher"
8. no school surface, and no wider payload
  ✅ only the `courses` segment reaches prisma.courseTeacher (no school API file does) — none
  ✅ the pure module imports nothing (no prisma, no next/server)
  ✅ the existing course list/update payloads were not widened (the link has its own endpoint)
```

### Live — the HTTP matrix against the COLLEGE fixture tenant

```
9. live: assign, list, refuse, unassign (COLLEGE fixture tenant)
  ✅ an unauthenticated read is 401 · an unauthenticated assign is 401
  ✅ the tenant's admin reads an empty list for a course with no teacher — HTTP 200 rows=0
  ✅ the admin assigns a teacher (201) — teacherId=t_zziso-ct-a-…-user
  ✅ the stored row id is the DERIVED id and the row carries the course's branch + the actor —
     id=ct_zziso-col-course-a_t_zziso-ct-a-…-user branchId=zziso-col-br-a
  ✅ the list resolves the teacher's name and email in one read
  ✅ re-assigning the same teacher is a 200 no-op: `already` true and no new document — rows 0→1
  ✅ another tenant's teacher, a non-TEACHER account, a ghost id and a missing id are all 400 with no row written
  ✅ another tenant's course and a ghost course are the SAME 404, with no row written
  ✅ the BOTH tenant's admin is admitted on its OWN course but cannot attach the college tenant's teacher (400, no row)
  ✅ the REGISTRAR reads (200) and is refused both writes (403)
  ✅ ACCOUNTANT, TEACHER, GUARDIAN and STUDENT are all 403 on read AND write
  ✅ a SCHOOL tenant's admin is refused by the college gate (403, no data)
  ✅ a BRANCH_ADMIN cannot reach another branch's course (403) or attach another branch's teacher (403) —
     course=403 foreignTeacher=403 ownTeacher=200
  ✅ unassign removes the row (and repeating it is 404) — the collection is back where it started — rows 0→0
  ✅ a course created for the probe is there (201) — id=r_…
  ✅ deleting a course that still has a teacher is refused (400, the module's own sentence) —
     "Cannot delete a course that still has a teacher assigned. Remove the assignment first."
  ✅ once the teacher is removed the same delete succeeds — HTTP 200
  ✅ every link row this run created is gone (the fixture's own data is untouched) — rows 0 → 0
```

The refused roles sign in on their OWN sector host (AGENTS.md RULE 1): the college roles on
`school.localhost`, a TEACHER on `teacher.localhost`, a GUARDIAN on `parents.localhost`, a STUDENT on the
hub — a teacher sent to `school.localhost` is refused by `sectorMismatch` (403) before the route under
test is reached, which would have proved the wrong rule. The first draft of this verifier did exactly
that and was corrected.

## Nothing else moved — the regression run beside it

```
$ SUITE_ONLY=verify-mode-mixing,verify-college-enrollment,verify-course-registrations,verify-college-permissions,verify-college-fees-api node scripts/suite-all.mjs
verify-mode-mixing               exit=  0   33 checks
verify-college-enrollment        exit=  0   40 PASS / 0 FAIL
verify-course-registrations      exit=  0   50 PASS / 0 FAIL
verify-college-permissions       exit=  0    8 markers
verify-college-fees-api (LAST)   exit=  0   112/112
TOTAL: 20 verifier(s), 193 ✅ / 0 ❌ markers, 20 exit 0     (the 15 offline siblings included)
```

Offline, on the same tree: `verify-college-routes` **exit 0 — 23 college route file(s), 50 gated
handler(s)** (was 22 / 47: the link adds one file with three handlers, and the count is what that
verifier PRINTS, so it is not a moved baseline); `verify-college-fees-data` **11 checks** and
`verify-college-results-data` **8 checks**, both exit 0 with their recorded baselines reproducing
(`COLS 79 entries, RELS 75 models (75 bodies), prisma 79 accessors` — dropping the later-phase models
reproduces the pre-7b / pre-6b hashes, **bodies included**); `verify-nav-scope` exit 0 (the nav snapshot
`scripts/nav-scope-snapshot.json` is unchanged — 8-pre adds no nav entry);
`npm run typecheck` (`tsc --noEmit`) **0 errors**.

## What this does NOT prove

- **No teacher-facing read exists.** The link is a staff-only API: v1 attendance marking is still
  staff-only, and a teacher reading their own courses is the register's own step (D-CA-7's ca-3/ca-4).
- **No screen.** Nothing renders the link yet; the admin picker belongs with the course screens, so the
  nav snapshot is deliberately untouched.
- **No attendance.** `courseAttendance` (D-CA-1) and everything after it — ca-0…ca-6 — is not built.
- **The four known-failing browser checks and the two documented latency/gate reds are untouched** by
  this change and were not re-measured here.
