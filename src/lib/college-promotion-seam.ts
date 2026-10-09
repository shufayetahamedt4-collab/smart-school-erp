/**
 * The TEST-ONLY seam's production guard, in ONE place (Phase 6-pre 6, §22 D-6pre6-2/3).
 *
 * `src/lib/college-promotion-server.ts` exposes two TEST-ONLY knobs:
 *
 *   - `claimProgrammeRun(…, { ttlMs })`      — a short lease window, so a verifier can
 *                                              outlive a renewal interval deterministically;
 *   - `readProgrammeRunBlock(…, { failRead })` — force the unreadable-store case.
 *
 * They are PUBLIC PARAMETERS on shared library functions, and the pre-push audit
 * (§22, D-6pre6-2) found their inertness rested ENTIRELY on their callers: the ladder
 * route passes them from `qaLeaseSeam()`, which is `NODE_ENV`-gated — but nothing
 * stopped a future caller from forwarding request data into either option and making a
 * test knob live in production.
 *
 * So the guard moved INTO the seam. These helpers return "no override" whenever
 * `NODE_ENV === "production"`, whatever the caller passes.
 *
 * WHY A SEPARATE MODULE — so the guard is PROVABLE, not merely readable.
 * `college-promotion-server.ts` imports the Firestore shim, so no verifier can import
 * it; this module is **dependency-free** (no `import`, no `require(`, no `node:`, no
 * prisma, no React), exactly like `college-promotion.ts` and `college-promotion-view.ts`.
 * `scripts/verify-college-promotion-page.mjs` therefore imports it and RUNS the guard
 * with `NODE_ENV === "production"` — a behavioural check, not a source scan. That is
 * what §22 D-6pre6-3 records.
 *
 * `nodeEnv` is a PARAMETER (defaulting to the real environment) precisely so the check
 * can exercise both environments hermetically, without mutating the process for other
 * checks. Nothing here is request-reachable: the values can only come from code.
 */

/** Is the test-only seam allowed to act at all? Never in a production build. */
export function testSeamEnabled(nodeEnv: string | undefined = process.env.NODE_ENV): boolean {
  return nodeEnv !== "production";
}

/**
 * The lease-window override, or `undefined` when the seam is inert. `undefined` means
 * "use the real constant" (`LADDER_LEASE_MS`, 30 s).
 */
export function seamTtlMs(
  ttlMs: unknown,
  nodeEnv: string | undefined = process.env.NODE_ENV
): number | undefined {
  if (!testSeamEnabled(nodeEnv)) return undefined;
  return typeof ttlMs === "number" && Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : undefined;
}

/** The forced-read-failure override, or `false` when the seam is inert. */
export function seamFailRead(
  failRead: unknown,
  nodeEnv: string | undefined = process.env.NODE_ENV
): boolean {
  return testSeamEnabled(nodeEnv) && failRead === true;
}
