/**
 * Sign-in attempt limiting — the pure decision layer (pilot P1b, item A).
 *
 * Three entry points can be brute-forced: the sign-in route, the QR/PIN entry
 * (`POST /api/qr/verify`) and the forgot-password request. All three are limited
 * by the SAME rule, decided HERE, in one small pure function set, for the same
 * reason `src/lib/pilot-guards.ts` keeps its questions pure:
 *
 *   1. The rule has to be provable OFFLINE — no server, no database, no clock —
 *      by `scripts/verify-pilot-hardening.mjs`, which imports this module
 *      directly and walks a decision table.
 *   2. The app runs on up to 10 Cloud Run/App Hosting instances, so the counters
 *      cannot live in process memory. This file therefore decides NOTHING about
 *      storage: it turns a stored row into a verdict, and a stored row plus one
 *      more failure into the next row. `src/lib/login-attempts-store.ts` is the
 *      only thing that touches Firestore, and it does the read-modify-write
 *      inside a real transaction.
 *
 * It imports `node:crypto` (for the counter-key digest) and nothing else — no
 * prisma, no firebase, no next. Nothing here is a secret: the key that is stored
 * is a HASH of the identifier, so the counter rows themselves never hold an
 * email address or a phone number.
 */

import { createHash } from "node:crypto";

/* ------------------------------------------------------------------ the limits */

/** How long a window lasts, for every counter, everywhere. */
export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

export interface AttemptWindow {
  /** Failures tolerated inside one window. Reaching it LOCKS the key. */
  max: number;
  windowMs: number;
}

/**
 * The primary defence: 8 failures per 15 minutes for one identifier (an email,
 * a phone number, or a QR token). Keyed on the identifier so a single account
 * cannot be ground down, whatever the attacker's address pool.
 */
export const IDENTIFIER_LIMIT: AttemptWindow = { max: 8, windowMs: ATTEMPT_WINDOW_MS };

/**
 * The secondary defence: 30 failures per 15 minutes from one client address.
 * Deliberately looser than the identifier limit — it is a backstop against one
 * host spraying many DIFFERENT identifiers, and it must never be the thing that
 * locks a shared school NAT out of a working sign-in.
 */
export const IP_LIMIT: AttemptWindow = { max: 30, windowMs: ATTEMPT_WINDOW_MS };

/** The three limited entry points. A scope namespaces a counter's key. */
export type AttemptScope = "login" | "qr" | "forgot";

export const ATTEMPT_SCOPES: AttemptScope[] = ["login", "qr", "forgot"];

/** `identifier` is one account/credential; `ip` is one client address. */
export type AttemptKind = "identifier" | "ip";

export const ATTEMPT_LIMITS: Record<AttemptKind, AttemptWindow> = {
  identifier: IDENTIFIER_LIMIT,
  ip: IP_LIMIT,
};

/**
 * ONE message for every refusal, whoever the caller is and whether or not the
 * account exists. Revealing "that email is locked" would turn the limiter into
 * an account-enumeration oracle, and a different message for a known identifier
 * would do the same in one request. Callers must NOT append anything to it.
 */
export const LOCKOUT_MESSAGE = "Too many failed attempts. Please wait a few minutes and then try again.";

/* ------------------------------------------------------------------- the keys */

/**
 * How an identifier is normalised before it is counted.
 *
 * Emails are compared the way the sign-in route compares them (trimmed and
 * lower-cased), and anything without an `@` is treated as a phone number and has
 * the punctuation people actually type removed — `+880 1712-345678` and
 * `+8801712345678` are the same human, so they must be the same counter. An
 * empty identifier normalises to `""` and is never counted (the route answers
 * 400 for it before the limiter is consulted).
 */
export function normalizeIdentifier(raw: unknown): string {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return "";
  if (value.includes("@")) return value;
  return value.replace(/[\s()\-.]/g, "");
}

/**
 * The counter key for one (scope, kind, value) triple.
 *
 * Only the SHA-256 digest of the value is stored, so a counter row cannot be
 * read back into an email address, a phone number or a QR token, and the rows
 * are useless to anyone who steals a database dump. The digest is peppered with
 * a fixed domain string so the same value under two scopes/kinds can never
 * collide by construction.
 */
export function counterKey(scope: AttemptScope, kind: AttemptKind, value: string): string {
  const digest = createHash("sha256").update(`smartschool-attempt:${scope}:${kind}:${value}`).digest("hex");
  return `rl:${scope}:${kind}:${digest}`;
}

/* --------------------------------------------------------------- the client ip */

/** Minimal shape of a `Headers` object, so this stays testable without one. */
export interface HeaderReader {
  get(name: string): string | null;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/;
const IPV6 = /^[0-9a-f:]+$/i;

/** A plausible literal address — anything else is discarded, never trusted. */
function isAddress(value: string): boolean {
  if (IPV4.test(value)) return value.split(".").every((part) => Number(part) <= 255);
  if (IPV6.test(value) && value.includes(":")) return true;
  return false;
}

/**
 * The client address a request is counted against, or `"unknown"`.
 *
 * The rule, and why: this app is served by Cloud Run / Firebase App Hosting
 * behind Google's front ends. The front end APPENDS the address it actually saw
 * to `X-Forwarded-For`, so the LAST entry is the one written by the trusted hop;
 * anything a client sends itself sits to its LEFT and is not trustworthy. So the
 * last syntactically valid entry wins, never the first — taking the first would
 * let anyone reset their own counter by sending `X-Forwarded-For: 1.2.3.4`.
 *
 * With no (or an unusable) header — which in practice means a local dev or
 * emulator request, since the front end always adds one — every such request
 * shares the single `"unknown"` bucket. That is the safe direction: an unknown
 * address is counted with every other unknown address rather than exempted. The
 * identifier limit is the primary defence regardless, so a shared bucket can
 * never be the difference between guessing and not guessing ONE account.
 */
export function clientIp(headers: HeaderReader | null | undefined): string {
  const raw = headers && typeof headers.get === "function" ? headers.get("x-forwarded-for") : null;
  if (!raw) return "unknown";
  const parts = String(raw)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const candidate = parts[i].replace(/^\[|\]$/g, "").trim();
    if (isAddress(candidate)) return candidate;
  }
  return "unknown";
}

/* ------------------------------------------------------------- the decision table */

/** The stored shape of one counter: a count and the instant its window opened. */
export interface AttemptCount {
  count: number;
  firstAtMs: number;
}

/**
 * The counter inside a stored row, or `null` when there is none.
 *
 * Defensive on purpose: the row comes back from Firestore, so a truncated,
 * hand-edited or foreign document must read as "no counter" (i.e. nothing is
 * locked) rather than as a number a stale window could never clear.
 */
export function counterOf(row: unknown): AttemptCount | null {
  const value = row && typeof row === "object" ? (row as any).value : null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const count = Number((value as any).count);
  const firstAtMs = Number((value as any).firstAtMs);
  if (!Number.isFinite(count) || count <= 0) return null;
  if (!Number.isFinite(firstAtMs) || firstAtMs <= 0) return null;
  return { count, firstAtMs };
}

export interface LockoutState {
  /** True when the window is live AND its failure count has reached the limit. */
  locked: boolean;
  /** Seconds to wait, for a `Retry-After` header. 0 when not locked. */
  retryAfterSec: number;
  /** Failures counted in the live window (0 when there is none). */
  count: number;
}

/** True when `attempt`'s window has run out by `nowMs` (so it no longer counts). */
export function windowExpired(attempt: AttemptCount, nowMs: number, window: AttemptWindow): boolean {
  return nowMs - attempt.firstAtMs >= window.windowMs;
}

/** Whole seconds left in a live window, rounded UP, never negative. */
export function retryAfterSeconds(attempt: AttemptCount, nowMs: number, window: AttemptWindow): number {
  const left = attempt.firstAtMs + window.windowMs - nowMs;
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/**
 * The verdict for a stored row: is this key locked, and for how much longer?
 *
 * A window that has run out is NOT a lockout — it is a clean slate, even if the
 * row still sits in the database waiting to be overwritten by the next failure.
 */
export function lockoutState(row: unknown, nowMs: number, window: AttemptWindow): LockoutState {
  const attempt = counterOf(row);
  if (!attempt || windowExpired(attempt, nowMs, window)) return { locked: false, retryAfterSec: 0, count: 0 };
  const locked = attempt.count >= window.max;
  return {
    locked,
    retryAfterSec: locked ? retryAfterSeconds(attempt, nowMs, window) : 0,
    count: attempt.count,
  };
}

export interface FailureOutcome {
  /** The row to store: the incremented count inside its (possibly new) window. */
  value: AttemptCount;
  locked: boolean;
  retryAfterSec: number;
}

/**
 * The row after ONE MORE failure.
 *
 * A failure inside a live window increments the count; the first failure after
 * the window ran out opens a NEW window (count 1, window starting now), which is
 * what makes the limit "per 15 minutes" rather than "ever". `max` is inclusive:
 * the failure that brings the count TO the limit is itself a lockout, so an
 * identifier gets `max` tries and the last of them is already refused.
 */
export function afterFailure(row: unknown, nowMs: number, window: AttemptWindow): FailureOutcome {
  const attempt = counterOf(row);
  const base = !attempt || windowExpired(attempt, nowMs, window) ? { count: 0, firstAtMs: nowMs } : attempt;
  const value: AttemptCount = { count: base.count + 1, firstAtMs: base.firstAtMs };
  const locked = value.count >= window.max;
  return { value, locked, retryAfterSec: locked ? retryAfterSeconds(value, nowMs, window) : 0 };
}
