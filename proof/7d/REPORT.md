# phase 7d — screens (proof/7d)

Stage rules honoured: no code change, no commit, no push. Branch `integration/main-into-college` @ `77a1b18`.
Emulator only. No verifier was run during this stage — only the emulator, the app and one browser.
`proof/` was not committed during this stage. **Record status (2026-10-14):** the Phase 7
evidence records (the `REPORT.md` files and the plain-text transcripts) are committed now, and binary
media is ignored — the rule is [../README.md](../README.md).

## Environment

```
FIRESTORE_EMULATOR_HOST=127.0.0.1:8080
FIREBASE_PROJECT_ID=demo-ss-test
FIRESTORE_DATABASE_ID=''   FIRESTORE_DB_ID=''    (must be empty)
JWT_SECRET set: yes
setup exit=0   seed-kit-demo exit=0   isolation-fixture create exit=0
app started AFTER the wipe (not before), /api/health 200
sentinel round-trip: id 7d-screens-1791776692572 | exists: true | read back over HTTP ok
/api/health firestore: {"ok":true,"readMs":320}
```

## Data — every write made through the app's own HTTP APIs, then read back over HTTP

* **College tenant** `zz-iso-college`: 2 approved registrations (`zziso-col-reg-a/-b`), 3 fee heads
  (Tuition Fee/TERM, Lab Fee/TERM, Transport/monthly), 6 structure rows for term 1
  (`6 rows · ৳58,000.00 in rows · ৳91,000.00 once cadences bill`), 1 discount — 10% proposed by the
  **ACCOUNTANT** (201) and approved by the **COLLEGE ADMIN** (`status=APPROVED`), charges generated for
  both students, 1 partial payment (Tuition, `amountMinor=1080000`, receipt `CRCP-7684631994`,
  `paid=10800 due=10800 status=PARTIAL`), payment config: 3 channels + BDT + note.
* **School tenant** (Sunrise) and **Both tenant** `zz-iso-both` used for the wizard-success and ledger shots.

## Screens (desktop 1440x900, real Chrome over CDP, PWA install banner dismissed, skeletons settled)

| file | one line — what is visible |
|---|---|
| [college-fees-heads-collegeadmin.png](college-fees-heads-collegeadmin.png) | College admin → College Fees → **Fee heads**: college sidebar (ACADEMICS/FINANCE, "College Fees"), the 3 real heads with bucket/cadence/state/due day, `+ Add fee head`, Edit/Delete per row. |
| [college-fees-structure-collegeadmin.png](college-fees-structure-collegeadmin.png) | **Fee structure**: programme+term pickers, "Price a head for this term", `6 rows · ৳58,000.00 in rows · ৳91,000.00 once cadences bill`, real rows (Transport ৳1,500 / Tuition ৳24,000 / Lab ৳3,500 …), Delete per row. |
| [college-fees-dues-collegeadmin.png](college-fees-dues-collegeadmin.png) | **Dues & generation**: "Charges are DERIVED…", `Run preview (writes nothing)` + `Commit these`, both students (ZZ4D-COL-A/B) with billed/waived/paid/due/status, Discounts & waivers showing the approved 10% award. |
| [college-fees-config-collegeadmin.png](college-fees-config-collegeadmin.png) | **Payment config**: "…the college's own — the school's fee settings are neither read nor extended", BDT, payment note, 3 channels (bKash (college) 01711-000000, Dutch-Bangla Bank 1021-0000-0000, Pay at the college office), Save/Add/Remove. |
| [wizard-success-college.png](wizard-success-college.png) | Wizard success, **COLLEGE** tenant: "Your college is ready!", "College: 1 department(s), 1 programme(s), 7 course(s).", buttons = **Open dashboard only** (no "School settings"). |
| [wizard-success-school.png](wizard-success-school.png) | Wizard success, **SCHOOL** tenant: school wording kept (class/section/subject line) and "School settings" present. |
| [wizard-success-both.png](wizard-success-both.png) | Wizard success, **BOTH** tenant: both sentences and both buttons. |
| [ledger-college-tenant.png](ledger-college-tenant.png) | College-tenant ledger: "College fee payments and waivers post to this same ledger…", separate **COLLEGE COLLECTED / COLLEGE WAIVERS / COLLEGE LATE FEES** rails, the 2 real entries each badged **College**, school figures kept at ৳0 and never added to the college ones. |
| [ledger-school-tenant.png](ledger-school-tenant.png) | School-only tenant ledger: no College section, no college rail, no College badge. |
| [college-fees-registrar-readonly.png](college-fees-registrar-readonly.png) | REGISTRAR on College Fees: page renders read-only — **no** Add / Edit / Record payment / Commit control anywhere. |
| [college-fees-accountant.png](college-fees-accountant.png) | ACCOUNTANT on the same page: the write controls are present (Add fee head, Propose award, Record payment, Commit these charges). |
| [college-fees-teacher-visit.png](college-fees-teacher-visit.png) | Direct visit to `/dashboard/college-fees` as TEACHER → bounced to sign-in (refused, not an empty page). |
| [college-fees-guardian-visit.png](college-fees-guardian-visit.png) | Direct visit as GUARDIAN → same bounce/refusal. |
| [college-fees-payment-recorded-notice.png](college-fees-payment-recorded-notice.png) | College admin records a partial payment through the UI; the on-screen result notice shows the single receipt. |
| [college-fees-partial-payment-doubleclick.png](college-fees-partial-payment-doubleclick.png) | The payment button clicked again ~70 ms later: still one payment / one receipt on the page — no second charge, no double receipt. |
| [college-fees-registrar-barehost-bounced-to-login.png](college-fees-registrar-barehost-bounced-to-login.png) | The registrar's bare-host visit landing on the sign-in page (same refusal, unauthenticated host). |

The four `01-…` – `04-…` files date from the earlier session and are **not** part of this clean-state run.
`college-fees-tab-and-nav.webm` is the earlier sidebar/tabs recording; **no (f) video was recorded** —
the double-click clip did not reproduce reliably, so per instruction it was skipped.

## Look-at items on these screens (reported, not fixed)

OCR-derived, so the ৳ glyph garbling in the raw text ("bio,800", "\u000710,800") is the Windows OCR
failing the taka sign, **not** a rendering defect. What is worth a human eye:

1. [ledger-college-tenant.png](ledger-college-tenant.png) — the school-side empty state reads
   **"No payments yet"** while a college payment of ৳10,800 sits directly below it on the same page.
   For a college tenant that wording reads as if the ledger is empty; something like "No school payments yet"
   would say what it means. **Wording issue on a college screen.** (needs a human eyeball to confirm the panel)
2. [ledger-college-tenant.png](ledger-college-tenant.png) — the explanatory sentence reads
   "College College fee payments and waivers post to this same ledger." A duplicated leading word
   (badge + sentence starting with the same word, or a stray label) — **worth confirming visually.**
3. [college-fees-structure-collegeadmin.png](college-fees-structure-collegeadmin.png) — the intro sentence and the
   basis help line look clipped mid-sentence: "…is not in v1 and is refused by" ends the OCR line with no object,
   and "The structure is one row per programme" / "x term" / "x head" breaks so the "x" looks like a stray line
   start. **Possible cut-off text** — needs a human read.
4. [college-fees-dues-collegeadmin.png](college-fees-dues-collegeadmin.png) — the summary chip above the commit
   buttons (2 students · 2 charges · billed/paid/due ৳0) is the **preview** result, but it sits right next to the
   committed per-student figures (৳24,750 / ৳27,500), so the zeros read like a wrong total. **Reads ambiguously.**

---

# 7d remainder — the print pages and the four look-at items (2026-10-13)

HEAD `e5ee07d`, same branch, emulator only (`127.0.0.1:8080`, `demo-ss-test`), app on `:3000`,
fixture created and the app restarted after it. **Uncommitted working tree** — nothing was staged,
committed or pushed. This section records the second half of 7d: D-7-17's two print pages, the links
that reach them, and the disposition of the four look-at items above.

## The print pages (D-7-17)

| route | what it is | guard chain |
|---|---|---|
| `/print/college-fee-statement/[studentId]` | one student's charges, dues and payments for a term (`?term=2`) or the whole programme; each term's footer names the structure rows that priced it **and the instant each took effect**, and the page prints its own print date | session → the student's tenant (a foreign id is NOT FOUND, never a 403 oracle) → `collegeGateDecision` (a SCHOOL tenant renders "college tenants only") → `canReadCollegeFees` (the D-7-18 v1 read allow-list, the SAME rule the API applies) → `canAccessBranch` |
| `/print/college-fee-receipt/[chargeId]` | ONE confirmed college payment, `?receipt=CRCP-…` selecting which when a charge was paid in instalments; the charge's own billed/paid/due at print time, the head label the admin chose, and the rate that priced it | the same chain, keyed by the charge's `schoolId`/`branchId` |

Both read through 7c's own loaders (`loadCharges` / `loadStructure` / `loadCollegeFeeConfig`) in
process, so a print can never disagree with `GET /api/college-fees/dues`; a receipt is read from the
shared ledger by its ONE tag (`feeId: null` + `meta.collegeFeeId`), and asking for a receipt number the
charge does not hold prints *nothing* rather than a different payment under that number.

Proved offline by `verify-college-fees-page.mjs` **sections 14–16** (the routes existing, the
guard chain including the *returning* `if`, the single definition of both hrefs in the view module, the
`?term=` reader's junk handling, term grouping and per-term totals, the scope line, `structureRateText`
**and** `structureEffectiveAt` read *and printed*, `chargeTotals`, the per-charge tag match,
`pickReceiptEntry`'s "the asked-for payment or the newest", and the pages not re-inlining their paths).
Section **16** was added on 2026-10-13 during the pre-commit review, when the reviewer found that the
copy item below was **not** pinned by any assertion: it now carries six source-level text pins (the
complete intro and Basis sentences, the OLD clipped fragments' absence, and the preview label bound to
the dry-run flag). The whole file re-ran **366/366** — see [../7f/production-build.txt](../7f/production-build.txt)
for the batch that ran the 360-check version; the 366-check run is recorded at the end of
`mutate-restored.txt` in this directory.

## The four look-at items

| # | item (from the list above) | disposition | evidence |
|---|---|---|---|
| 1 | the school-side empty state read "No payments yet" on a college tenant's ledger | **FIXED** in `cac825c` (phase 7d-fix) — the panel now says "No school payments yet" whenever the page holds college money | `src/app/dashboard/ledger/page.tsx:120`, screenshot `../7d-fix/ledger-college-tenant.png` |
| 2 | "College College fee payments…" (the badge word repeated) | **FIXED** in `cac825c` — the sentence no longer repeats the badge word | `src/lib/college-fees-view.ts` (the 7d-screens comment at the fix), `../7d-fix/ledger-college-tenant.png` |
| 3 | the Fee-structure intro and the Basis help line looked clipped mid-sentence | **FIXED here** — both are complete sentences now: "One row per programme, per term and per head. The programme's own term shape bounds the term number." and "Per-credit pricing is not in v1 — it is refused by name." | `src/app/dashboard/college-fees/page.tsx`; the page's copy is a client render (the SSR HTML is a loading shell), so it is pinned at **source level** by `verify-college-fees-page.mjs` **section 16** (added 2026-10-13 after the reviewer found this row claimed a pin that did not exist) and mutation-proved (M4/M5 below) — **no new screenshot**; the wording is visible on the next screenshot pass |
| 4 | the preview chip's zeros sitting beside the committed money read like a wrong total | **FIXED** in `cac825c` — the Dues header sums the rows the table renders through one pure helper (`duesScopeText`), the Term pricing table shows a pricing total instead of a phantom "due" (`structureRowsText`), and the preview panel is labelled **"Preview (nothing written)"** | `verify-college-fees-page.mjs` sections 11–12 (the phantom-total check is explicitly a text pin: it asserts the OLD charge-shaped string as the thing the tab used to print), plus section 16, which pins the label itself and that only the dry-run branch says it |

Nothing in the two print pages exposes another tenant's or another branch's money: the ledger search
is keyed by the `schoolId` read off the student/charge the page has already authorized, and
`scripts/verify-college-fees-data.mjs`'s ledger-reader audit now **names both pages** — so a future page
that reads the shared ledger still fails until someone reviews it (check 10, 11/11).

## Mutation proofs for these print-page checks (2026-10-13)

Each mutation was made in the working tree, the verifier run, and the file restored to its **exact
bytes** (`sha1sum -c` OK afterwards). Transcripts: `mutate-1-…txt`, `mutate-2-…txt`, `mutate-3-…txt`,
`mutate-restored.txt` in this directory.

| # | mutation (representative incorrect behaviour) | where | expected | observed | restored |
|---|---|---|---|---|---|
| 1 | the statement page no longer **confines the read to the caller's branch** | `src/app/print/college-fee-statement/[studentId]/page.tsx` (the `canAccessBranch` line deleted) | the guard-chain check fails | `verify-college-fees-page` **1 ❌ of 360** — `statement: confines the read to the caller's branch` | yes — sha1 identical, 360 PASSED |
| 2 | the receipt page **ignores the `?receipt=` number** and prints the newest payment under it | `src/app/print/college-fee-receipt/[chargeId]/page.tsx` (`pickReceiptEntry(payments, receiptParam)` → `(payments, undefined)`) | the one-payment rule fails | **1 ❌ of 360** — `the receipt page uses the one picker, ON the number it was asked for` | yes — sha1 identical |
| 3 | **any** college payment matches **any** charge (`isCollegePaymentEntryFor` drops the id comparison) | `src/lib/college-fees-view.ts` (the tag comparison → `return true`) | the tag checks fail | **1 ❌ of 360** — `a payment on ANOTHER charge does not` | yes — sha1 identical |
| 4 | the Fee-structure intro **re-clipped** to its old phrasing | `src/app/dashboard/college-fees/page.tsx` (the `subtitle` string) | the two intro copy pins fail | **2 ❌ of 366** — `the Fee-structure intro is the complete sentence` and `…and the OLD, clipped phrasing is gone` (`mutate-4-copy-reclipped.txt`) | yes — sha1 identical |
| 5 | the preview label **dropped** to plain `"Preview"` | `src/app/dashboard/college-fees/page.tsx` (the `dryRun` ternary) | the two label pins fail | **2 ❌ of 366** — `the preview panel names itself` and `…and only the dry-run branch says it` (`mutate-5-preview-label-changed.txt`) | yes — sha1 identical |

Rows 1–3 were captured against the file at **360 checks**, before section 16 existed; rows 4–5 against
**366**. **No transcript was rewritten** to match a number — the counts above are read from the files in
this directory, and the script's own count line is what moved when section 16 was added.

The restored run is `✅ college fees page verification PASSED — 366 checks.` (`mutate-restored.txt`,
whose first block is the original 360-check restoration and whose last block is the post-section-16 one).
**No assertion was weakened, skipped or deleted** — the failures above are the checks doing their job.

## What this section does NOT claim

- Items 1, 2 and 4 were fixed BEFORE this session (in `cac825c`); this section records where, not that
they were re-done.
- Item 3 is pinned at the source level, not by a fresh screenshot: the college fee page is a client
  component whose server HTML is a loading shell, so the rendered sentence cannot be read from HTTP.
- The four `01-…`–`04-…` screenshots and `college-fees-tab-and-nav.webm` from the earlier session are
  still the visual record of the screens themselves; the two print pages have no screenshot in this
  session — their evidence is the offline verifier plus the production-build role probe (which renders
  both pages over HTTP against a real production binary and asserts the tenant's own money is on them).

## Teardown

```
ports 3000/4000/4400/8080/9222: 0 listeners
node.exe 0 | java.exe 0 | bun.exe 1 (untouched)
my headless Chrome: 0 processes left (16 other chrome.exe were yours and were left alone)
10 leftover ss-headless temp profile dirs removed
git status -sb: unchanged — only the pre-existing untracked docs/ and proof/; HEAD still 77a1b18; no commit
```
