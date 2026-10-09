/**
 * Emulator-only safety guard for verify/smoke scripts.
 *
 * These scripts write real Firestore documents (fixtures, and cleanup of
 * existing rows). They must NEVER point at a Cloud database. This guard makes
 * every guarded script fail closed unless the environment is demonstrably a
 * local Firestore emulator — the only disposable target we have.
 *
 * Call it as the first statement after env loading, before `initializeApp()`
 * and before the first `fetch()`. It is pure environment inspection: it never
 * opens a network connection.
 *
 * Rules (ALL must hold):
 *   1. `FIRESTORE_EMULATOR_HOST` is set and its host is loopback
 *      (`localhost`, `127.0.0.0/8`, or `::1`).
 *   2. `FIRESTORE_DATABASE_ID` is unset — it selects a named CLOUD database.
 *   3. `FIREBASE_PROJECT_ID`, when set, is only paired with a loopback emulator
 *      host, so `amar-e-school` can never be pointed at a remote host.
 *   4. `SMOKE_ORIGIN` / `BASE` / `BASE_URL`, when set, point at a loopback host.
 */

/** Strip an optional scheme/path and any port; unwrap IPv6 brackets. */
function parseHost(value) {
  let s = String(value || "").trim();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.split("/")[0];
  if (s.startsWith("[")) {
    const end = s.indexOf("]");
    return end === -1 ? "" : s.slice(1, end).toLowerCase();
  }
  const colon = s.indexOf(":");
  if (colon !== -1 && s.indexOf(":", colon + 1) === -1) s = s.slice(0, colon);
  return s.toLowerCase();
}

/** True for `localhost`, any `127.0.0.0/8` address, or `::1`. */
function isLoopbackHost(host) {
  if (!host) return false;
  if (host === "localhost" || host === "::1") return true;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return false;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return false;
  return parts[0] === 127;
}

/**
 * Fail closed unless the environment is a loopback Firestore emulator.
 * Prints a loud reason and exits with status 1 when any rule is violated.
 */
export function requireEmulator(scriptName = process.argv[1] || "script") {
  const problems = [];

  const rawEmulator = String(process.env.FIRESTORE_EMULATOR_HOST || "").trim();
  const emulatorHost = parseHost(rawEmulator);
  const emulatorIsLoopback = isLoopbackHost(emulatorHost);

  if (!rawEmulator) {
    problems.push("FIRESTORE_EMULATOR_HOST is not set");
  } else if (!emulatorIsLoopback) {
    problems.push(
      `FIRESTORE_EMULATOR_HOST is not loopback (got "${rawEmulator}"; expected e.g. 127.0.0.1:8080)`
    );
  }

  if (String(process.env.FIRESTORE_DATABASE_ID || "").trim()) {
    problems.push(
      "FIRESTORE_DATABASE_ID is set — it selects a named Cloud database and must be unset for emulator runs"
    );
  }

  // INTEGRATION 1: `FIRESTORE_DB_ID` is the documented ALIAS for
  // FIRESTORE_DATABASE_ID (src/lib/firebase.ts reads either; origin/main's cutover
  // switch used this name). Now that the app honours it, the guard must reject it
  // too — otherwise a shell holding the cutover value could point an emulator run
  // at the named Cloud database. docs/INTEGRATION-LOG.md, docs/TESTING.md.
  if (String(process.env.FIRESTORE_DB_ID || "").trim()) {
    problems.push(
      "FIRESTORE_DB_ID is set — it is the alias for FIRESTORE_DATABASE_ID and selects a named Cloud database; it must be unset for emulator runs"
    );
  }

  const project = String(process.env.FIREBASE_PROJECT_ID || "").trim();
  if (project && !emulatorIsLoopback) {
    problems.push(
      `FIREBASE_PROJECT_ID="${project}" may only be used with a loopback FIRESTORE_EMULATOR_HOST`
    );
  }

  for (const key of ["SMOKE_ORIGIN", "BASE", "BASE_URL"]) {
    const raw = String(process.env[key] || "").trim();
    if (!raw) continue;
    if (!isLoopbackHost(parseHost(raw))) {
      problems.push(
        `${key} points at a non-loopback host ("${raw}"); point it at the local emulator-backed server, or unset it`
      );
    }
  }

  if (problems.length) {
    const line = "=".repeat(72);
    console.error(`\n${line}`);
    console.error("REFUSING TO RUN — this script is emulator-only.");
    console.error(`script: ${scriptName}`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nThese scripts write real documents. They may only run against the local");
    console.error("Firestore emulator. Start it and export FIRESTORE_EMULATOR_HOST, e.g.:");
    console.error("  npx firebase emulators:start --only firestore");
    console.error("  export FIRESTORE_EMULATOR_HOST=127.0.0.1:8080");
    console.error("See docs/TESTING.md.");
    console.error(line);
    process.exit(1);
  }

  console.log(`[guard] emulator-only mode OK — FIRESTORE_EMULATOR_HOST=${emulatorHost}`);
}
