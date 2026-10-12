# Payments — the school fee idempotency key (pilot P2)

`confirmPayment` (`src/lib/ledger.ts`) now takes an **optional** `idempotencyKey`.
With no key it behaves exactly as before. With one:

- `schoolPaymentIds(schoolId, feeId, key)` (`src/lib/db.ts`) derives a **deterministic**
  `payment` row id and ledger-entry id — `sha1(tenant|fee|key)`, no clock and no randomness —
  so a repeat lands on the same two documents instead of appending new ones;
- the ledger entry is **pre-read** by that id, and a repeat of the same fee + amount + method is
  answered from the payment the first request wrote (`replay: true`) with the original receipt,
  writing nothing;
- the fee's new paid amount is decided **inside** `$guardedUpdate("fee", …)`'s real Firestore
  transaction and **incremented** from the row as it is at that instant, never written as a
  blind absolute value. A keyed over-payment is refused; the keyless path keeps its historical
  clamp, so the webhook and intent callers are unchanged.

The route (`POST /api/fees/[id]/pay`) accepts the key in the body or as `x-idempotency-key`,
rejects a malformed one by name, and skips its courtesy due pre-check for a keyed attempt so a
retry after the fee settled still reaches the record it must answer from. The Collect dialog
(`src/app/dashboard/fees/page.tsx`) disables its button in flight and mints **one key per
attempt**, reusing it across a retry.

## A future gateway webhook

The key is deliberately a plain caller-supplied string, so a later webhook integration passes
the **provider's own transaction id** (bKash/Nagad/Rocket/SSLCommerz `trxID`) straight through
to `confirmPayment`. It does not need a new helper, a new collection or a new transaction
primitive: the same deterministic ids and the same guarded fee write make a redelivered
callback a replay, and two simultaneous deliveries of one provider transaction land on one
payment row.

## What the existing webhook path already covers, and what it still needs

`POST /api/payments/webhook/[provider]` (`src/lib/payments.ts` → `handleWebhook`) already:

- verifies the HMAC signature against `PAYMENT_WEBHOOK_SECRET` and **fails closed** (503) when
  the secret is unset on a deployment;
- looks the intent up by `intentId`/`refNo`, returns `ok` for an intent already `CONFIRMED`,
  and short-circuits a `FAILED` status;
- guards a true replay with `refAlreadyProcessed(schoolId, intentId)` and then `markConfirmed`.

What it still needs before it can carry money on its own:

- **an atomic** replay guard. `refAlreadyProcessed` is a pre-read, and the intent-status check
  is a separate read: two simultaneous deliveries for one intent can both pass them and both
  reach `confirmPayment`. Passing the provider `trxID` as `idempotencyKey` is the fix — it makes
  the decision structural instead of a race — and this stage builds no gateway, so it is a
  design note only.
- **per-provider** secrets (`PAYMENT_WEBHOOK_SECRET` is a single shared value today) and a
  provider-side amount comparison against the intent before confirming.
