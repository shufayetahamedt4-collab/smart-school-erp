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
 */

/** The canonical variable name. */
export const DATABASE_ID_VAR = "FIRESTORE_DATABASE_ID";

/** The documented alias for {@link DATABASE_ID_VAR} (origin/main's cutover name). */
export const DATABASE_ID_ALIAS_VAR = "FIRESTORE_DB_ID";

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
