/**
 * Sign-in attempt limiting — the Firestore half (pilot P1b, item A).
 *
 * The decision itself lives in `src/lib/login-attempts.ts` (pure, offline
 * provable). This module is only the storage: it reads a counter, writes one
 * back, and clears one, against the `settings` collection through the Firestore
 * shim.
 *
 * Why `settings` and why a transaction:
 *
 *  - The app runs on up to 10 instances. An in-memory counter would give each
 *    instance its own private allowance, so the limit would be "8 per 15 minutes
 *    PER INSTANCE" — useless. The counters therefore live in Firestore, like the
 *    password-reset codes and the 2FA challenges already do.
 *  - A counter is a read-modify-write, and the two halves must not be separable,
 *    or two simultaneous failures read the same count and write the same count+1
 *    (a lost update — the classic way a limiter silently allows double the
 *    attempts). `prisma.$guardedUpdate` is this codebase's real
 *    `runTransaction`: the read and the conditional write are one atomic step.
 *    `prisma.$transaction`'s CALLBACK form is only sequential, so it is NOT used
 *    here; its ARRAY form cannot read at all.
 *  - The CHECK deliberately does not use the ordinary read path either. Reads
 *    through `prisma.*` are memoised for 30 s (with 120 s of stale-while-
 *    revalidate), so an ordinary `findUnique` can hand back the count a previous
 *    request has already exceeded. The probe below reads the document inside the
 *    transaction, which is never served from that memo.
 *
 * A FAILURE TO REACH THE STORE MUST NOT BLOCK A VALID SIGN-IN. Every function
 * here answers "not locked" and logs `[auth] …` when the store errors: the
 * alternative is that a Firestore hiccup locks every user out of the product,
 * which is a far worse failure than a limiter that briefly under-counts. The
 * identifier limit remains the primary defence, and the log line is how an
 * operator sees that it was skipped.
 */

import { prisma } from "@/lib/db";
import {
  ATTEMPT_LIMITS,
  counterKey,
  afterFailure,
  clientIp,
  lockoutState,
  type AttemptKind,
  type AttemptScope,
  type HeaderReader,
} from "@/lib/login-attempts";

/** The settings-row id rule, mirrored from `src/lib/db.ts` (`set_<key>`). */
const settingDocId = (key: string): string => `set_${key}`;

export interface LimitVerdict {
  /** True when this request must be refused with 429. */
  locked: boolean;
  /** Seconds for the `Retry-After` header (0 when not locked). */
  retryAfterSec: number;
  /**
   * True when ANY counter row for this request exists. A successful sign-in
   * only pays for a delete when there is something to delete, so the ordinary
   * "nothing was ever wrong here" login stays exactly as cheap as it was.
   */
  tracked: boolean;
}

function keysFor(scope: AttemptScope, identifier: string, ip: string): { kind: AttemptKind; key: string }[] {
  return [
    { kind: "identifier", key: counterKey(scope, "identifier", identifier) },
    { kind: "ip", key: counterKey(scope, "ip", ip) },
  ];
}

const ALLOW: LimitVerdict = { locked: false, retryAfterSec: 0, tracked: false };

/**
 * A fresh read of one counter, inside a real transaction.
 *
 * `$guardedUpdate` is asked to DECLINE the write; the row it found comes back as
 * `holder`, and nothing at all is written. That is a read-only transaction in
 * plainer clothes, and it is the one read path in the shim that cannot be served
 * from the read memo. `reason: "ERROR"` means the store itself failed.
 */
async function readCounter(key: string): Promise<{ ok: boolean; row: unknown }> {
  const result = await prisma.$guardedUpdate("setting", settingDocId(key), () => ({
    ok: false,
    error: "read-only probe",
  }));
  if (result.reason === "ERROR") return { ok: false, row: null };
  return { ok: true, row: result.holder ?? null };
}

/** True when any counter row for this request is already on file. */
function anyRow(rows: { ok: boolean; row: unknown }[]): boolean {
  return rows.some((r) => r.row !== null && r.row !== undefined);
}

/**
 * Is this request already locked out? Called BEFORE any password work, so a
 * locked identifier costs one read and no bcrypt, and so a locked identifier is
 * refused even when the password is right.
 */
export async function checkAttemptLimit(
  scope: AttemptScope,
  identifier: string,
  headers: HeaderReader | null | undefined
): Promise<LimitVerdict> {
  const keys = keysFor(scope, identifier, clientIp(headers));

  // The identifier is the primary defence, so it is read (and can refuse) first;
  // the address counter is only consulted when the identifier is clean.
  const rows: { ok: boolean; row: unknown }[] = [];
  for (const { kind, key } of keys) {
    const read = await readCounter(key);
    if (!read.ok) {
      console.error("[auth] the sign-in attempt store could not be read — allowing this attempt");
      return ALLOW;
    }
    rows.push(read);
    const state = lockoutState(read.row, Date.now(), ATTEMPT_LIMITS[kind]);
    if (state.locked) return { locked: true, retryAfterSec: state.retryAfterSec, tracked: true };
  }
  return { ...ALLOW, tracked: anyRow(rows) };
}

/**
 * Count ONE failed attempt against both counters, atomically, and report whether
 * that attempt has now locked either of them.
 *
 * The increment is a callback `$guardedUpdate`, so the count read and the count
 * written are one step in the store: ten simultaneous wrong passwords produce a
 * count of ten, not ten counts of one.
 */
export async function noteFailedAttempt(
  scope: AttemptScope,
  identifier: string,
  headers: HeaderReader | null | undefined
): Promise<LimitVerdict> {
  const keys = keysFor(scope, identifier, clientIp(headers));
  let verdict: LimitVerdict = { locked: false, retryAfterSec: 0, tracked: true };

  for (const { kind, key } of keys) {
    const window = ATTEMPT_LIMITS[kind];
    const result = await prisma.$guardedUpdate("setting", settingDocId(key), (row: any) => ({
      ok: true,
      data: { key, value: afterFailure(row, Date.now(), window).value },
    }));
    if (result.reason === "ERROR") {
      console.error("[auth] the sign-in attempt store could not be written — this attempt is not counted");
      return { locked: false, retryAfterSec: 0, tracked: true };
    }
    const state = lockoutState(result.row, Date.now(), window);
    if (state.locked) verdict = { locked: true, retryAfterSec: state.retryAfterSec, tracked: true };
  }
  return verdict;
}

/**
 * A success clears the IDENTIFIER's counter (never the address's — one account
 * signing in does not excuse a different account's failures from the same host).
 *
 * Only the identifier row is touched, and only when the caller saw one, so a
 * normal sign-in pays nothing at all.
 */
export async function clearAttempts(scope: AttemptScope, identifier: string): Promise<void> {
  const key = counterKey(scope, "identifier", identifier);
  // `deleteMany` and not `delete`: the shim's single-row `delete` reads
  // `where.id` only, so `delete({ where: { key } })` silently targets the
  // document named "undefined" and leaves the counter in place — which is
  // exactly the bug the live half of verify-pilot-hardening.mjs caught (the
  // counter survived a successful sign-in). `deleteMany` resolves the id
  // through the model's own id rule (`set_<key>`), the same way the 2FA
  // challenge is cleared in the sign-in route.
  // A delete of a key that is not there is a no-op in Firestore; the catch is
  // here so a store failure can never fail a sign-in that already succeeded.
  await prisma.setting.deleteMany({ where: { key } }).catch(() => null);
}
