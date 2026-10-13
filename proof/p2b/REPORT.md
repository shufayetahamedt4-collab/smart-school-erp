# pilot P2b — admission intake lands once

Branch `integration/main-into-college`, base commit `f007a55` (pilot P2c). Emulator only
(`FIRESTORE_EMULATOR_HOST=127.0.0.1:8080`, project `demo-ss-test`), app on `http://127.0.0.1:3000`
via `scripts/dev-emulator.mjs`. No cloud, no deploy, no `ledger.ts`, no college code.

## What changed (3 tracked files + 1 new verifier + 1 new doc)

| file | change |
|---|---|
| `src/lib/db.ts` | +28 lines: `intakeAdmissionId(schoolId, key)` = `adm_${sha1(schoolId\|key)}`. Deterministic, no clock, no randomness, tenant-scoped. The generic `idFor`/`idForCreate` machinery is untouched, so no other model's ids move. |
| `src/app/api/admissions/intake/route.ts` | +306/-33: an OPTIONAL client key (body `idempotencyKey` or `x-idempotency-key`, 8–120 chars, refused by name); the admission row's id is derived from it and created inside `prisma.$guardedUpdate("admission", …)` (real Firestore transaction — the winner inserts, the loser is handed the winner's row); a request whose row already exists is answered from that record with **200 + `replay: true`** and the ORIGINAL receipt/QR slip, writing nothing; a keyed attempt with no linked student is refused **409** naming the admission; the admission fee is paid through the existing `confirmPayment` with `<key>:admission-fee`; only the key's hash is stored. The **keyless path is byte-for-byte the old create**, and the phone+name pre-read is unchanged. |
| `src/components/AdmissionIntakeForm.tsx` | +34/-6: one key per attempt (`useRef`), reused on a retry, cleared after success; `disabled={saving \|\| …}` on Submit; refusals shown verbatim. |
| `scripts/verify-admission-intake-idempotency.mjs` (new) | 35 offline pins + 69 live checks = **104 checks**, `✅ PASS`. |
| `docs/ADMISSION-IDEMPOTENCY.md` (new) | the design, what a replay returns, what is not covered. |

Bug found and fixed inside this stage's own work (from the live race): `$guardedUpdate`'s refusal
hands back the row's DATA, not its document id, so a race loser answered from the gate holder
reported `admissionId: undefined` and re-read through an undefined id. `answerFromRecord` now takes
the id from the key's own derivation when the row has none (`recordId`), so every message and
re-read names THIS admission. Before the fix: `a-3` FAIL; after: PASS.

## Verifier: 104 checks, not vacuous

`node scripts/verify-admission-intake-idempotency.mjs` — full log in `verifier.txt`
(`offline: 35 pass / 0 fail`, `live: 69 pass / 0 fail`, exit 0; the mutation round trips are the
`mut-*.txt` logs beside it).

Five mutations, each applied to the real source, run, then restored **byte-identical** (sha256 of
`route.ts`, `AdmissionIntakeForm.tsx`, `db.ts` and the verifier match `hashes-before-mutations.txt`):

| # | mutation | round trip |
|---|---|---|
| i | `const attemptAdmissionId = null;` (drop the deterministic id) | FAIL `off-10` |
| ii | delete `if (already) return await answerFromRecord(already);` (skip the replay pre-read) | FAIL `off-12`, `off-13`, `off-14` |
| iii | `${key}:admission-fee` → `${key}:admission-fee:${Date.now()}` (non-deterministic payment key) | FAIL `off-11` |
| iv | `disabled={saving \|\| …}` → `disabled={!form.name \|\| …}` (no in-flight disable) | FAIL `off-33` |
| v | notify the desk from inside `answerFromRecord` (kit/notify on a replay) | FAIL `off-13`, `off-16` **and live** `b-4`, `j-2` (notifications +1 on the replay) |

## Live concurrency (counts of admissions, students, fees, payments, ledger, bookIssues, notifications, users)

| case | result |
|---|---|
| (e) one keyed submit with payment + kit | 201, `replay: false`, admission id = `adm_sha1(schoolId\|key)`; **+1 admission, +1 student, +2 fees, +1 payment, +1 ledger, +1 kit issue, +1 notification** |
| (b) same key, sequential replay | 200, `replay: true`, same admission/student/admissionNo/receipt/qrToken/qrPin; **delta 0 in all eight collections** |
| (h) same key, different child | 409 `This admission key was already used for …`; nothing written |
| (a) two SIMULTANEOUS submits, same key | both answered (201 + 200), exactly one first write, both name the same admission/student, **+1 of each**, one receipt |
| (f) short / whitespace-only key | 400 `idempotencyKey must be between 8 and 120 characters.`; nothing written |
| (k) empty key, (d) no key at all | 201 with no `replay` flag — the old keyless create, and a keyless retry for the same phone+name still hits the old guard (400) |
| (j) key from `x-idempotency-key` | first write 201, replay 200 with the same student and a zero delta |
| (c1) DIFFERENT keys, same phone+name, sequential | first admitted, second refused by the existing phone+name guard (400) |
| (c2) DIFFERENT keys, same phone+name, **simultaneous** | **2 admitted, 0 refused — the documented hole** (the pre-read is not a transaction). Reported, not asserted; `docs/ADMISSION-IDEMPOTENCY.md` says so plainly. Keyless + empty phone was already unguarded and is unchanged. |
| (g) retry after a crash (APPLIED row, stale `startedAt`) | 409 naming the admission id + `nothing new was written`; nothing written |
| (t-1) teardown | all eight collections back to the pre-run counts |

## Browser proof (`proof/p2b/`, one CDP driver, `scripts/lib/headless.mjs`)

17/17 checks — see `BROWSER-PROOF.md` + `browser-dom-text.md` for the DOM text behind each PNG.

| PNG | evidence |
|---|---|
| `01-form-filled.png` | the real `/dashboard/students/new` form with name, Class 1, guardian email, phone, "Collect the admission fee now" |
| `02-in-flight-disabled.png` | button `"Admitting…"`, `disabled=true` **while the request is in flight** (network slowed to 1200 ms) |
| `03-admitted-once.png` | `Student admitted · … · ADM-970155 · Class 1 · payment of 500 confirmed (RCP-7397043081) · Paid ৳500 · CASH · QR PIN (guardian verification)` |

Double-clicking Submit (two real CDP clicks, the second while the first is in flight) sent exactly
**1** POST to `/api/admissions/intake`, created **1** student (14 → 15), **1** admission row, and the
run removed its own 8 records (14 → 14).

> Note for a reviewer: the form defaults to *create the guardian login*, so an email is required —
> without it `submit()` stops client-side and no POST leaves the browser. The first attempt at this
> proof failed for exactly that reason (0 POSTs); the proof now fills the email and asserts it.

## Safety

- `git diff --stat` lists only `src/app/api/admissions/intake/route.ts`, `src/components/AdmissionIntakeForm.tsx`, `src/lib/db.ts` (+305 lines total). New: `scripts/verify-admission-intake-idempotency.mjs`, `docs/ADMISSION-IDEMPOTENCY.md`.
- `git diff --name-only f007a55` for `src/lib/ledger.ts`, `src/lib/enroll.ts`, every `college*` file, `apphosting.yaml`, `src/lib/payments.ts`: **empty** — byte-identical.
- `enroll.ts` behaviour for its other callers: `verify-enroll-paths` **17 PASS**, `verify-admission-intake` **52 PASS**, `verify-fees-totals` **15 PASS** on a fresh seed, and `verify-bulk-import` in the suite run below.
- No Firestore index was needed: the replay pre-read is a `findUnique` on a document id, and the new verifier's own queries are single-field equality.

## Full suite (once, from clean state, `scripts/suite-all.mjs`)

`SUITE_LOG_DIR=<tmp>/sspr/suite-logs node scripts/suite-all.mjs` from clean state (wipe → seed → fixture
→ kit → app restart per verifier). Every verifier exits 0 except the three documented reds; the
counts are the numbers each SCRIPT printed, compared with the P2c table in
[docs/PILOT-FIX-2.md](../../docs/PILOT-FIX-2.md) §2.

| # | verifier | own count (this run) | P2c baseline | verdict |
|---|---|---|---|---|
| 1 | `verify-college-gate` | 4 (3 numbered sections) | 4 | identical |
| 2 | `verify-college-fees-logic` | 21 check(s) | 21 | identical |
| 3 | `verify-college-fees-data` | 11 check(s) | 11 | identical |
| 4 | `verify-college-results-data` | 8 check(s) | 8 | identical |
| 5 | `verify-college-results-page` | 106 | 106 | identical |
| 6 | `verify-college-fees-page` | **255** | **255 (corrected)** | identical |
| 7 | `verify-college-promotion-logic` | 12 check(s) | 12 | identical |
| 8 | `verify-college-promotion-page` | 18 check(s) | 18 | identical |
| 9 | `verify-college-grading-logic` | 13 check(s) | 13 | identical |
| 10 | `verify-college-routes` | **3 rule sections** | **3 (corrected)** | identical |
| 11 | `verify-college-terms` | 9 | 9 | identical |
| 12 | `verify-onboarding-seed` | 87/87 | 87 | identical |
| 13 | `verify-database-id` | 8 | 8 | identical |
| 14 | `verify-nav-scope` | 9 | 9 | identical |
| 15 | `verify-registration-status` | 10 | 10 | identical |
| 16 | `verify-college-permissions` | 8 | 8 | identical |
| 17 | `verify-pilot-hardening` | **260/260** | 260 live (183 offline) | identical |
| 18 | `verify-mode-foundation` | 65 | 65 | identical |
| 19 | `verify-user-secrets` | 10 PASS | 10 | identical |
| 20 | `verify-onboarding-monitor` | 44 PASS | 44 | identical |
| 21 | `verify-tenant-isolation` | 107 | 107 | identical |
| 22 | `verify-branch-isolation` | 72 PASS | 73 markers (72 PASS) | identical |
| 23 | `verify-college-enrollment` | 40 PASS | 41 markers (40 PASS) | identical |
| 24 | `verify-course-registrations` | 50 PASS | 51 markers (50 PASS) | identical |
| 25 | `verify-enroll-paths` | **17 PASS** | **17 (corrected)** | identical |
| 26 | `verify-enrollment-fees` | **19 PASS** | **19 (corrected)** | identical |
| 27 | `verify-fees-totals` | 15 PASS + `ALL GREEN` | 15 | identical |
| 28 | `verify-school-fee-idempotency` | **69/69** | 69/69 | identical |
| 29 | `verify-fee-reconciliation` | **56** | 56 | identical |
| 30 | `verify-qr-credentials` | 18 PASS | 18 (19 markers) | identical |
| 31 | `verify-notifications` | 46 PASS | 46 | identical |
| 32 | `verify-grading` | 39 PASS | 39 | identical |
| 33 | `verify-guardian-child` | **25 PASS** (26 declared) | 25 (26 declared) | identical |
| 34 | `verify-read-cache` | 0/1 — `FAIL 17 route(s) still pay full latency` | known red | **known red, unchanged** |
| 35 | `verify-routine-config` | `2 failure(s), 1 skipped` | known red, both calendar forms | **known red, unchanged** |
| 36 | `verify-cache-scoping` | 15 PASS | 15 | identical |
| 37 | `verify-invalidation` | 8 PASS | 8 | identical |
| 38 | `verify-exams-invalidation` | 9 | 9 (exit 0 with `BASE`) | identical |
| 39 | `verify-write-freshness` | 4 PASS | 4 | identical |
| 40 | `verify-write-integrity` | all checks passed · **2 skipped** | own skip shape (3 skipped) | identical behaviour, own skip count |
| 41 | `verify-academic-sessions` | 13 PASS | 13 | identical |
| 42 | `verify-class-sessions` | 56 PASS | 56 | identical |
| 43 | `verify-bulk-import` | **117 PASS** | 117 | identical |
| 44 | `verify-admission-intake` | **52 PASS** (alone, kit stocked) | **52 (corrected)** | identical |
| 45 | `verify-onboarding-type` | 44/44 | 44 | identical |
| 46 | `verify-promotion-rollover` | 50 PASS | 50 | identical |
| 47 | `verify-sweep-routes` | 46 | 46 (alone, clean wipe) | identical |
| 48 | `qa-phase23` | **36/0** | 36/0 | identical |
| 49 | `qa-certificates` | **40 passed, 1 failed** | **40/1 (known red)** | **known red, unchanged** |
| 50 | `verify-phase7-e2e` | 160 passed, 0 failed | 160 | identical |
| 51 | `verify-college-results-api` | 77 checks | 77 | identical |
| 52 | `verify-college-promotion-api` | 100 PASS | 100 | identical |
| 53 | `verify-college-promotion-lease` | 113 PASS | 113 | identical |
| 54 | `verify-college-fees-api` (**LAST**) | **112/112** | 112 | identical |

Suite footer: `TOTAL: 54 verifier(s), 654 ✅ / 1 ❌ markers, 51 exit 0`; `known reds (allowed):
verify-read-cache, verify-routine-config, qa-certificates`; `unexpected failures: (none)`.
No verifier's count changed and none was edited (`scripts/suite-all.mjs` and every existing
verifier are byte-identical to `f007a55`).

## What could not be verified

- `verify-admission-intake-idempotency` is a NEW verifier and is deliberately NOT wired into
  `scripts/suite-all.mjs`: that file is outside this stage's allowed edit set, so it was left
  byte-identical. It was run on its own (twice, on a fresh seed) — the owner must decide whether to
  add it to the suite list.
- The (c2) residue above is a real, unfixed hole by design: two different keys for the same child in
  the same instant still pass the phone+name pre-read. Closing it would mean transacting on the
  guardian phone + name (a new index and a changed guard for every caller) — a decision for the owner.
- Single-instance only: `$guardedUpdate` is a Firestore transaction, so the create-once gate holds
  across instances; the replay WAIT path (poll up to 15 s) was only exercised within one process.
