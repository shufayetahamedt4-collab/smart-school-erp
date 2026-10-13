/**
 * Firestore database selection — ONE decision, in a pure module.
 *
 * `FIRESTORE_DATABASE_ID` is the CANONICAL name (docs/ENVIRONMENTS-AND-SECRETS.md).
 * `FIRESTORE_DB_ID` is a documented ALIAS: it is origin/main's cutover-switch name
 * (docs/INTEGRATION-LOG.md), kept working so the migration tooling and any
 * operator shell that still exports it select the same database.
 *
 * Both names resolve to the SAME database, so with only one of them set — the
 * real deployment sets exactly one — the behaviour is unchanged:
 *
 *   - neither set (or set to "" / whitespace) => `null`, which opens the
 *     project's "(default)" database. That is the ROLLBACK database, and no code
 *     change is needed to roll back.
 *   - only one set => that value selects the database.
 *   - both set to the same value => that value (they agree).
 *   - both set and DIFFERENT => this module THROWS. Silently picking one would
 *     open a database the operator did not ask for, so the app fails loudly at
 *     the first Firestore use instead of reading or writing the wrong one.
 *
 * It is deliberately DEPENDENCY-FREE — no firebase, no `node:` import, nothing to
 * resolve — so it can be imported from the app, from a server route and from the
 * offline verifier (`scripts/verify-database-id.mjs`) alike. It takes the
 * environment as an argument (defaulting to `process.env`) so it never has to be
 * mocked to be tested.
 *
 * pilot P3 — THE FALLBACK IS GONE. `resolveDatabaseId` keeps its contract
 * exactly (a blank value still resolves to `null`), but a LIVE environment may
 * no longer act on that: `liveDatabaseProblem` / `assertNamedDatabaseId` refuse
 * a missing, blank or literal "(default)" name by name, with no opt-in flag to
 * turn the refusal off. The emulator is unchanged — its own "(default)" is the
 * local database, and `scripts/lib/guard.mjs` already forbids a NAMED database
 * in an emulator run.
 */

/** The canonical variable name. */
export const DATABASE_ID_VAR = "FIRESTORE_DATABASE_ID";

/** The documented alias for {@link DATABASE_ID_VAR} (origin/main's cutover name). */
export const DATABASE_ID_ALIAS_VAR = "FIRESTORE_DB_ID";

/**
 * The literal name of the project's default database — the one pilot P3 refuses.
 * It is a real database id (the Cloud SDK accepts it); it is simply never
 * allowed to be chosen by this app any more.
 */
export const DEFAULT_DATABASE_ID = "(default)";

/** A blank value (`undefined`, `null`, `""`, or only whitespace) means "not set". */
function readVar(env: Record<string, string | undefined>, name: string): string | null {
  const raw = env[name];
  if (raw === undefined || raw === null) return null;
  const value = String(raw);
  return value.trim() ? value : null;
}

/**
 * Resolve the Firestore database id from the environment.
 *
 * @param env the environment to read (defaults to `process.env`).
 * @returns the database id to open, or `null` for the project's "(default)"
 *          database (the rollback database).
 * @throws when BOTH names are set and disagree — the message names both
 *         variables and their values, and says which name is canonical.
 */
export function resolveDatabaseId(env: Record<string, string | undefined> = process.env): string | null {
  const canonical = readVar(env, DATABASE_ID_VAR);
  const alias = readVar(env, DATABASE_ID_ALIAS_VAR);

  if (canonical && alias && canonical !== alias) {
    throw new Error(
      `Conflicting Firestore database configuration: ${DATABASE_ID_VAR}="${canonical}" and ` +
        `${DATABASE_ID_ALIAS_VAR}="${alias}" are both set but disagree. ` +
        `${DATABASE_ID_VAR} is the canonical name and ${DATABASE_ID_ALIAS_VAR} its alias — ` +
        `set only one of them, or set both to the same value. Refusing to guess which ` +
        `database to open.`
    );
  }

  return canonical || alias || null;
}

// ---------------------------------------------------------------------------
// pilot P3 — never open "(default)"
// ---------------------------------------------------------------------------
//
// The owner's decision: the ONLY database this app may use is the named one
// (`smart-school-db`). There is deliberately NO opt-in flag: the refusal below
// is unconditional for a live environment, because a flag would only be a way to
// re-arm the accident it exists to prevent.
//
// Everything here is still pure (no imports, no clock, no network) and still
// takes the environment as an argument, so `scripts/verify-database-id.mjs` can
// pin it offline.

/** True when this environment is pointed at the local Firestore emulator. */
export function isEmulatorEnvironment(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.FIRESTORE_EMULATOR_HOST;
  return raw !== undefined && raw !== null && String(raw).trim() !== "";
}

/**
 * The LIVE refusal, as operator-facing text — `null` when the environment may
 * open a database.
 *
 * The two names are resolved first, so the alias and "both set and different"
 * rules are applied exactly as before; only then is the RESULT judged. A live id
 * that is missing/blank, or the literal "(default)", is refused.
 */
export function liveDatabaseProblem(env: Record<string, string | undefined> = process.env): string | null {
  // The emulator's own "(default)" is the local database: unchanged behaviour.
  if (isEmulatorEnvironment(env)) return null;

  const id = resolveDatabaseId(env);
  if (!id) {
    return (
      `Refusing to open the "${DEFAULT_DATABASE_ID}" Firestore database: this environment must NAME its database. ` +
      `Set ${DATABASE_ID_VAR} (or its alias ${DATABASE_ID_ALIAS_VAR}) to the database id — for this product that is ` +
      `"smart-school-db". Removing the variable is no longer a rollback: use the hosting console's Rollback button ` +
      `(docs/ENVIRONMENTS-AND-SECRETS.md).`
    );
  }
  if (id === DEFAULT_DATABASE_ID) {
    return (
      `Refusing to open the Firestore database "${id}": ${DATABASE_ID_VAR} (or its alias ${DATABASE_ID_ALIAS_VAR}) must ` +
      `name a REAL database — "smart-school-db", not "${DEFAULT_DATABASE_ID}". The "${DEFAULT_DATABASE_ID}" fallback was ` +
      `removed (pilot P3); rollback is the hosting console's Rollback button, not this variable.`
    );
  }
  return null;
}

/**
 * The database id the Admin SDK must be given, or a thrown refusal — the ONE
 * entry point the app and the live-capable scripts use.
 *
 * Live ⇒ always a real name (never `null`, never "(default)").
 * Emulator ⇒ whatever the environment resolved (a name when one is set, else the
 * emulator's own "(default)"), so local development does not change.
 */
export function assertNamedDatabaseId(env: Record<string, string | undefined> = process.env): string {
  const problem = liveDatabaseProblem(env);
  if (problem) throw new Error(problem);
  // The emulator reaches the fallback; a conflicting pair still throws in here.
  return resolveDatabaseId(env) || DEFAULT_DATABASE_ID;
}
