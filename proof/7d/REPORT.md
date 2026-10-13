# phase 7d — screens (proof/7d)

Stage rules honoured: no code change, no commit, no push. Branch `integration/main-into-college` @ `77a1b18`.
Emulator only. No verifier was run during this stage — only the emulator, the app and one browser.
`proof/` is untracked and was deliberately not committed.

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

## Teardown

```
ports 3000/4000/4400/8080/9222: 0 listeners
node.exe 0 | java.exe 0 | bun.exe 1 (untouched)
my headless Chrome: 0 processes left (16 other chrome.exe were yours and were left alone)
10 leftover ss-headless temp profile dirs removed
git status -sb: unchanged — only the pre-existing untracked docs/ and proof/; HEAD still 77a1b18; no commit
```
