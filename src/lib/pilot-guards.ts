/**
 * Pilot hardening guards (pilot-fix-1) — pure, dependency-free, Edge-safe.
 *
 * The one question these answer is "is THIS process a production deployment?",
 * and it is deliberately a pure function of an env object, for three reasons:
 *
 *  1. Authentication hangs off it (a deployment with no `JWT_SECRET` must refuse
 *     to sign or accept a session), so the decision has to be provable OFFLINE —
 *     with no process state, no server and no database — by
 *     `scripts/verify-pilot-hardening.mjs`.
 *  2. The Edge middleware uses it, so it must import nothing (no `node:*`, no
 *     prisma, no Next).
 *  3. It must never read a secret at module scope: `next build` imports this
 *     file on a machine that has no deployment secrets, and a build must not
 *     need any.
 *
 * Production is `NODE_ENV === "production"` on a host that is NOT pointed at the
 * local Firestore emulator. The emulator exception is what keeps the
 * emulator/dev harness working: the harness runs with `FIRESTORE_EMULATOR_HOST`
 * set, so it is never treated as production even if it is served from a
 * production build.
 */

/** Anything shaped like `process.env` — kept loose so tests can pass a literal. */
export type EnvLike = Record<string, string | undefined> | undefined | null;

/** True only for a real deployment: production, and not the local emulator. */
export function isProductionEnv(env: EnvLike): boolean {
  const e = env || {};
  if (e.NODE_ENV !== "production") return false;
  // A harness against the local Firestore emulator is not a deployment. This is
  // the one exception, and it is stated by the emulator's own variable.
  if (e.FIRESTORE_EMULATOR_HOST) return false;
  return true;
}

/**
 * The development-only session secret.
 *
 * It exists so an offline install, the emulator harness and the seeded
 * verification suites can sign in with no configuration. It is NEVER used on a
 * deployment without `JWT_SECRET`: `effectiveSessionSecret()` returns `null`
 * there, and everything that signs or verifies a session refuses.
 */
export const DEV_SESSION_SECRET = "smart-school-erp-secret-change-me-in-production";

/** The one message for a deployment that cannot sign or verify sessions. */
export const SESSION_SECRET_MISSING =
  "JWT_SECRET is not set on this deployment, so sessions cannot be signed or verified. " +
  "Set JWT_SECRET to a long random string in the deployment's environment and redeploy. " +
  "GET /api/health reports what this process can see.";

/** The explicitly configured secret, or null when there is none. */
export function sessionSecret(env: EnvLike): string | null {
  const value = String(env?.JWT_SECRET ?? "").trim();
  return value ? value : null;
}

/** True when this deployment MUST NOT fall back to the development secret. */
export function sessionSecretFatal(env: EnvLike): boolean {
  return sessionSecret(env) === null && isProductionEnv(env);
}

/**
 * The secret to sign/verify with, or **null when this deployment has none**.
 *
 * `null` is the fail-closed answer: the caller must refuse to sign a session and
 * must treat every presented cookie as unauthenticated. Outside production an
 * unset secret still resolves to the development secret, exactly as before.
 */
export function effectiveSessionSecret(env: EnvLike): string | null {
  const explicit = sessionSecret(env);
  if (explicit) return explicit;
  return sessionSecretFatal(env) ? null : DEV_SESSION_SECRET;
}

/* ------------------------------------------------------------------ tenants */

/** Minimum admin password length a deployment accepts (pilot-fix-1 item 5). */
export const MIN_ADMIN_PASSWORD = 8;

/**
 * The wizard's development-only admin default.
 *
 * Reachable ONLY when `isProductionEnv()` is false — `resolvedWizardAdminPassword`
 * returns before it is consulted on a deployment. Keeping it here (rather than in
 * the route) is what lets the route have no default at all while the emulator
 * harness keeps creating tenants without spelling out a password.
 */
export const DEV_ONBOARDING_ADMIN_PASSWORD = "School@123";

/**
 * Why this admin password is unacceptable, or null when it is fine.
 *
 * On a deployment the password must be provided EXPLICITLY and be at least
 * `MIN_ADMIN_PASSWORD` characters — a new tenant may never be created with a
 * built-in default that somebody could guess. Outside production there is no
 * rule, so every existing harness keeps working unchanged.
 */
export function adminPasswordProblem(env: EnvLike, password: unknown): string | null {
  if (!isProductionEnv(env)) return null;
  const value = String(password ?? "");
  if (value.length >= MIN_ADMIN_PASSWORD) return null;
  return `Set an admin password of at least ${MIN_ADMIN_PASSWORD} characters — a new school is never created with a built-in default password.`;
}

/**
 * The password a newly created admin account gets.
 *
 * A deployment must supply one (`ok: false` otherwise); the emulator harness may
 * omit it and receive the development default.
 */
export function resolvedWizardAdminPassword(
  env: EnvLike,
  password: unknown
): { ok: true; password: string } | { ok: false; error: string } {
  const problem = adminPasswordProblem(env, password);
  if (problem) return { ok: false, error: problem };
  const value = String(password ?? "");
  return { ok: true, password: value || DEV_ONBOARDING_ADMIN_PASSWORD };
}
