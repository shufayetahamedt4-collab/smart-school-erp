# Phase 7e-pre — a college payment can never be recorded twice

Branch `integration/main-into-college`, commit `cac825c` + this phase. Emulator only
(`127.0.0.1:8080`), app on `http://school.localhost:3000`, no Cloud call anywhere.

## What the phase does

A retry, a second tab or a double submit must never record a college fee payment
twice. Three small changes carry it:

| where | what |
|---|---|
| `src/lib/db.ts` | `collegePaymentLedgerId(schoolId, key)` + one additive `idForCreate` entry: a ledger entry whose `meta.collegePaymentKey` is set gets the id `le_cp_<sha1(tenant\|key)>`. School ledger writes carry no such meta key and keep their random id. |
| `src/lib/ledger.ts` | `confirmCollegePayment` takes an OPTIONAL `idempotencyKey`. With none, nothing changes. With one: the ledger entry for `(tenant, key)` is read first — same charge+amount+method → the FIRST result (`replay: true`, no write); anything else → a visible 409. Otherwise the payment is accepted inside the SAME `$guardedUpdate` transaction, which also stamps the charge (`idempotency`, plus a bounded `idempotencyKeys` list) with the receipt, so a request that never saw the first reply is still answered from it. Unkeyed behaviour and the over-payment rule are untouched. |
| `src/app/api/college-fees/payments/route.ts` | accepts the optional key (8–120 chars, refused by name if unusable), returns `replayed: true` for a replay and audits only the real write. |
| `src/app/dashboard/college-fees/page.tsx` + `src/lib/college-fees-view.ts` | one key per ATTEMPT (`newPaymentKey` → `crypto.randomUUID`), kept across a failure/retry and cleared only on success or when the charge, amount or method changes. |

## Proof 1 — the API (`scripts/verify-college-fees-api.mjs`, 95 → 112 checks)

`api-new-code-112-of-112.txt` — 112/112 with 17 new checks: the replay (same
receipt, same due, one ledger row, no new receipt number, the charge untouched),
10 SIMULTANEOUS requests with one key (one row, one receipt, +100.00 once), 10
simultaneous requests with different keys (never above the billed amount, the
over-payment refusal still holding, the exact remainder settling), the same key
with a different amount/method/charge refused 409, the same key in ANOTHER tenant
independent, no key behaving exactly as before, an unusable key refused 400.

`api-previous-code-101-of-112.txt` — the SAME verifier against the previous code:
**11 of the 17 fail**, including `10 simultaneous same-key requests` →
**10 payments, 10 ledger rows, the whole ৳1,000 charge paid**.

## Proof 2 — a real browser (`scripts/_tmp-7e-proof.mjs`, temporary + gitignored)

One headless Chrome over CDP; the STORE (firebase-admin) is the judge, not the page.

| PNG | what is visible |
|---|---|
| `payment-form-before-submit.png` | the Dues & generation tab, `ZZ Iso College Student A` picked, the charge `ZZ Iso Fee Head A — Year 1`, **10.00** typed, the pay button armed. |
| `payment-after-quick-double-mouse-click.png` | the notice `Recorded ৳10.00 — CRCP-8610821630. Still due: ৳9,929.00 (partly paid).` and the Dues row `PAID ৳4,124.00` — one 10.00, not 20.00. |
| `payment-after-two-clicks-one-task.png` | the notice `Recorded ৳10.00 — CRCP-8611120634 …` and the Dues row `PAID ৳4,134.00` — two clicks in ONE JS task, one 10.00. |
| `dues-after-retry-one-payment.png` | the student's charges/payments after the dropped-response retry. |
| `ledger-after-retry.png` | the shared ledger with the college rows (`College payment — … CASH CRCP-… ৳10.00 Confirmed`). |

`browser-proof-run.txt` — the full run: ALL CHECKS PASSED, with the store numbers
(charge `paidAmount` 61 → 71 → 81 → 101, one ledger row and one audit row per
10.00) and the retry answering `status=200 replayed=true` with the FIRST receipt
(`CRCP-8611519996` = the ledger row's own `meta.receiptNo`).

## What this proof does NOT claim

- The second **mouse** press found the button already disabled/re-rendered 60 ms
  after the first, so on that path the client's busy guard — not the key — is what
  prevented a second request. The key is the backstop, and the same-task path
  (where the guard cannot help) is proved.
- The app's read cache can serve a dues figure a few seconds stale; the driver
  therefore picks the charge from the store. That staleness is a pre-existing
  issue (`verify-read-cache`, 1 known failure).
- A crash between the charge stamp and the ledger append leaves the ledger without
  that entry; a later retry is answered as a replay from the stamp (no double
  payment) but does not repair the missing entry.
