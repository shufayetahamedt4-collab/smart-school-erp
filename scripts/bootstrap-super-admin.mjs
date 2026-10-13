#!/usr/bin/env node
/**
 * bootstrap-super-admin.mjs — create the FIRST platform owner account.
 *
 * The owner runs this ONCE, from their own machine, against the deployment's
 * Firestore, to get into the Platform Console the first time: the console needs a
 * SUPER_ADMIN, and a super admin can only be created by a super admin (every
 * route that creates users requires a session). Before this script the only way
 * in was the emulator's seeded demo login, which does not exist on a deployment.
 *
 * It is deliberately the most locked-down script in the repo, because it is the
 * one script that is SUPPOSED to run against real data:
 *
 *   1. `ALLOW_LIVE_FIRESTORE=1` is required. Without it the script refuses
 *      before it opens a connection — the same acknowledgement the app itself
 *      demands before it will talk to a live database.
 *   2. The password comes from `BOOTSTRAP_ADMIN_PASSWORD` or an interactive
 *      prompt, NEVER from the command line (a `--password` argument leaks into
 *      shell history, `ps` output and CI logs), and it is never echoed or
 *      printed — the answer below is read in raw mode and is not shown.
 *   3. It refuses if ANY SUPER_ADMIN already exists. It bootstraps the first
 *      one; it is not a backdoor for adding more, and it is not a reset tool.
 *   4. It refuses a weak password using THE APP'S OWN RULE
 *      (`adminPasswordProblem` in src/lib/pilot-guards.ts — the same function
 *      the tenant wizard enforces, ≥8 characters), not a copy of it.
 *   5. It prints only the email and the new user id, and it prints the TARGET
 *      (emulator or live project) before it writes anything.
 *   6. If the target is LIVE, it asks for the project id again as a confirmation
 *      (`BOOTSTRAP_CONFIRM_LIVE` in a non-interactive shell). A script that can
 *      silently create a platform owner on production is a foot-gun.
 *
 * Usage (the deployment's project — live data):
 *   ALLOW_LIVE_FIRESTORE=1 BOOTSTRAP_ADMIN_PASSWORD='…' \
 *     node scripts/bootstrap-super-admin.mjs --email owner@yourschool.com
 *   ...or omit BOOTSTRAP_ADMIN_PASSWORD and answer the prompt.
 *
 * Usage (local emulator — what this repo's own proof runs):
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8080 FIREBASE_PROJECT_ID=demo-ss-test \
 *     ALLOW_LIVE_FIRESTORE=1 BOOTSTRAP_ADMIN_PASSWORD='…' \
 *     node scripts/bootstrap-super-admin.mjs --email owner@example.com
 *
 * `--self-test` runs the refusal rules offline (no database, no credentials) and
 * is what scripts/verify-pilot-hardening.mjs pins.
 */

import { createHash } from "node:crypto";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadEnv } from "./load-env.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/*
 * The app's own password rule lives in a TypeScript module. Node 24 strips types
 * natively, but the app resolves `.ts` through the bundler, so a plain
 * `import "./src/lib/pilot-guards.ts"` is spelled out below; the hook only adds
 * the extension when the resolver wants one, exactly as the verifiers do.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (error?.code === "ERR_MODULE_NOT_FOUND" && relative && !specifier.endsWith(".ts")) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { adminPasswordProblem, MIN_ADMIN_PASSWORD } = await import("../src/lib/pilot-guards.ts");

/**
 * pilot P3 — the app may only ever open a NAMED database, and this script opens
 * the same database the app does. It therefore uses the SAME decision
 * (`liveDatabaseProblem` / `assertNamedDatabaseId` in src/lib/database-id.ts)
 * rather than a second copy of the rule, which is what keeps the two from ever
 * drifting apart.
 */
const { liveDatabaseProblem, assertNamedDatabaseId, DEFAULT_DATABASE_ID } = await import("../src/lib/database-id.ts");

/** The acknowledgement that gates every write in this repo. */
export const LIVE_FLAG = "ALLOW_LIVE_FIRESTORE";
/** The one accepted spelling of that acknowledgement. */
export const LIVE_FLAG_VALUE = "1";
/** Where the password may come from, in order of preference. */
export const PASSWORD_ENV = "BOOTSTRAP_ADMIN_PASSWORD";
/** The non-interactive live confirmation. */
export const CONFIRM_ENV = "BOOTSTRAP_CONFIRM_LIVE";

/* ---------------------------------------------------------------- the rules */

/**
 * Every reason this run must be refused, in the order the operator should fix
 * them. Empty means "create the account".
 *
 * Pure on purpose: the whole refusal surface (including the live-target
 * confirmation, which this repo's own proof never reaches) is provable offline
 * by passing literals. `env` and `argv` are the only inputs that come from
 * outside, and nothing here reads a file, a socket or a clock.
 *
 * @param {object} input
 * @param {Record<string, string|undefined>} input.env     process.env
 * @param {string[]} input.argv                            args after `node script.mjs`
 * @param {string} input.email                             the --email value ("" when absent)
 * @param {string} input.password                          the resolved password ("" when none)
 * @param {"env"|"prompt"|"none"} input.passwordSource
 * @param {boolean} input.superAdminExists
 * @param {boolean} input.liveTarget                       false when pointed at the local emulator
 * @param {string} input.projectId
 * @param {string} input.liveConfirmation                  what the operator supplied to confirm a live run
 * @returns {string[]}
 */
export function bootstrapProblems(input) {
  const env = input.env || {};
  const argv = input.argv || [];
  const email = String(input.email || "").trim();
  const problems = [];

  // 1. The acknowledgement, first: without it nothing else matters and the
  //    script must not even open a connection.
  if (String(env[LIVE_FLAG] || "") !== LIVE_FLAG_VALUE) {
    problems.push(
      `${LIVE_FLAG}=1 is not set. This script creates a platform owner in a real database, so it refuses to run without that explicit acknowledgement.`
    );
  }

  // 2. Never the command line.
  if (argv.some((arg) => arg === "--password" || arg.startsWith("--password="))) {
    problems.push(
      `Refusing a password on the command line: it leaks into shell history, the process list and CI logs. Put it in ${PASSWORD_ENV}, or answer the prompt.`
    );
  }

  // 3. Which account.
  if (!email) {
    problems.push("--email <address> is required — it is the platform owner's sign-in address.");
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    problems.push(`--email "${email}" is not a valid email address.`);
  }

  // 4. Which password, and is it strong enough — decided by the app's own rule.
  if (!input.password || input.passwordSource === "none") {
    problems.push(
      `No password was provided. Set ${PASSWORD_ENV} or answer the prompt (the password is never accepted as an argument).`
    );
  } else {
    const weak = adminPasswordProblem({ NODE_ENV: "production" }, input.password);
    if (weak) problems.push(weak);
  }

  // 5. Exactly one, and only the first one.
  if (input.superAdminExists) {
    problems.push(
      "A SUPER_ADMIN already exists. This script only bootstraps the FIRST platform owner; it is neither an extra-account creator nor a password reset."
    );
  }

  // 6. A live write is confirmed twice: by the flag, and by naming the project.
  if (input.liveTarget) {
    const confirm = String(input.liveConfirmation || "");
    if (confirm !== String(input.projectId || "")) {
      problems.push(
        `Refusing to write to the LIVE Firestore project "${input.projectId || "(unknown)"}". Re-run with ${CONFIRM_ENV} set to that exact project id, or answer the confirmation prompt.`
      );
    }
  }

  return problems;
}

/** The app's own deterministic user id for an email (`src/lib/db.ts`). */
export function userIdForEmail(email) {
  return `u_${createHash("sha1").update(String(email).trim().toLowerCase()).digest("hex")}`;
}

/** The user document this script creates — byte-for-byte the shape seed.mjs writes. */
export function superAdminDoc({ email, name, passwordHash }) {
  return { email, name, role: "SUPER_ADMIN", active: true, passwordHash };
}

/* -------------------------------------------------------------------- the CLI */

/** Parse `--flag value` / `--flag=value`; unknown flags are reported, not ignored. */
export function parseArgs(argv) {
  const out = { email: "", name: "", help: false, selfTest: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const eq = arg.indexOf("=");
    const flag = eq === -1 ? arg : arg.slice(0, eq);
    const inline = eq === -1 ? null : arg.slice(eq + 1);
    const next = () => (inline !== null ? inline : argv[++i]);
    if (flag === "--email") out.email = String(next() || "");
    else if (flag === "--name") out.name = String(next() || "");
    else if (flag === "--help" || flag === "-h") out.help = true;
    else if (flag === "--self-test") out.selfTest = true;
    else if (flag === "--password") out.unknown.push(flag);
    else out.unknown.push(flag);
  }
  return out;
}

/** True when this process is pointed at the local Firestore emulator. */
function isEmulatorTarget(env) {
  const host = String(env.FIRESTORE_EMULATOR_HOST || "").trim();
  return Boolean(host) && /^(127\.|localhost|\[::1\])/.test(host.replace(/^https?:\/\//, ""));
}

/** Read a secret from a TTY without echoing a single character of it. */
function askHidden(question) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error(`stdin is not a terminal — set ${PASSWORD_ENV} instead of answering the prompt.`));
      return;
    }
    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    const finish = (err, answer) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      if (err) reject(err);
      else resolve(answer);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish(null, value);
        if (ch === "\u0003") return finish(new Error("cancelled"));
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/** Prompt on a TTY; answer `fallback` when there is no terminal. */
function ask(question, fallback = "") {
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      resolve(fallback);
      return;
    }
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    let value = "";
    process.stdout.write(question);
    const finish = () => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === "\r" || ch === "\n") return finish();
        if (ch === "\u0003") return finish();
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    stdin.on("data", onData);
  });
}

/* ------------------------------------------------------------------ self-test */

export const SELF_TEST_CASES = [
  {
    label: "no acknowledgement ⇒ refused",
    env: {},
    argv: ["--email", "owner@school.com"],
    email: "owner@school.com",
    password: "StrongPass@1",
    passwordSource: "env",
    superAdminExists: false,
    liveTarget: false,
    expect: 1,
  },
  {
    label: "with the acknowledgement, the emulator and a good password ⇒ allowed",
    env: { ALLOW_LIVE_FIRESTORE: "1" },
    argv: ["--email", "owner@school.com"],
    email: "owner@school.com",
    password: "StrongPass@1",
    passwordSource: "env",
    superAdminExists: false,
    liveTarget: false,
    expect: 0,
  },
  {
    label: "a password on the command line ⇒ refused",
    env: { ALLOW_LIVE_FIRESTORE: "1" },
    argv: ["--email", "owner@school.com", "--password", "StrongPass@1"],
    email: "owner@school.com",
    password: "StrongPass@1",
    passwordSource: "env",
    superAdminExists: false,
    liveTarget: false,
    expect: 1,
  },
  {
    label: "no --email ⇒ refused",
    env: { ALLOW_LIVE_FIRESTORE: "1" },
    argv: [],
    email: "",
    password: "StrongPass@1",
    passwordSource: "env",
    superAdminExists: false,
    liveTarget: false,
    expect: 1,
  },
  {
    label: "a 7-character password ⇒ refused (the app's own rule)",
    env: { ALLOW_LIVE_FIRESTORE: "1" },
    argv: ["--email", "owner@school.com"],
    email: "owner@school.com",
    password: "1234567",
    passwordSource: "env",
    superAdminExists: false,
    liveTarget: false,
    expect: 1,
  },
  {
    label: "an existing SUPER_ADMIN ⇒ refused",
    env: { ALLOW_LIVE_FIRESTORE: "1" },
    argv: ["--email", "owner@school.com"],
    email: "owner@school.com",
    password: "StrongPass@1",
    passwordSource: "env",
    superAdminExists: true,
    liveTarget: false,
    expect: 1,
  },
  {
    label: "a live target without the project-id confirmation ⇒ refused",
    env: { ALLOW_LIVE_FIRESTORE: "1" },
    argv: ["--email", "owner@school.com"],
    email: "owner@school.com",
    password: "StrongPass@1",
    passwordSource: "env",
    superAdminExists: false,
    liveTarget: true,
    projectId: "amar-e-school",
    liveConfirmation: "",
    expect: 1,
  },
  {
    label: "a live target confirmed with the project id ⇒ allowed",
    env: { ALLOW_LIVE_FIRESTORE: "1" },
    argv: ["--email", "owner@school.com"],
    email: "owner@school.com",
    password: "StrongPass@1",
    passwordSource: "env",
    superAdminExists: false,
    liveTarget: true,
    projectId: "amar-e-school",
    liveConfirmation: "amar-e-school",
    expect: 0,
  },
];

/** Run the offline table; returns the failures (empty when everything holds). */
export function selfTest() {
  const failures = [];
  for (const c of SELF_TEST_CASES) {
    const problems = bootstrapProblems(c);
    const refused = problems.length > 0;
    const want = c.expect > 0;
    if (refused !== want) {
      failures.push(`${c.label}: expected ${want ? "refusal" : "allow"}, got ${refused ? problems[0] : "allow"}`);
    }
  }
  return failures;
}

/* -------------------------------------------------------------------- main() */

async function main() {
  loadEnv();

  if (process.argv.includes("--self-test")) {
    const failures = selfTest();
    for (const f of failures) console.error(`  ❌ ${f}`);
    console.log(
      failures.length
        ? `FAIL: ${SELF_TEST_CASES.length - failures.length}/${SELF_TEST_CASES.length} refusal rules held`
        : `PASS: ${SELF_TEST_CASES.length}/${SELF_TEST_CASES.length} refusal rules held (offline, no database touched)`
    );
    process.exit(failures.length ? 1 : 0);
  }

  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: ALLOW_LIVE_FIRESTORE=1 ${PASSWORD_ENV}='…' node scripts/bootstrap-super-admin.mjs --email <address> [--name "<name>"]`);
    console.log("Creates the FIRST SUPER_ADMIN and prints only its email and user id.");
    process.exit(0);
  }

  const env = process.env;
  const liveTarget = !isEmulatorTarget(env);

  // The password: from the environment, or typed. Never from argv (a `--password`
  // argument is not even parsed — `bootstrapProblems` refuses it below).
  let password = String(env[PASSWORD_ENV] || "");
  let passwordSource = password ? "env" : "none";
  const argvHasPassword = (process.argv.slice(2) || []).some((a) => a === "--password" || a.startsWith("--password="));
  if (!password && !argvHasPassword) {
    try {
      password = await askHidden(
        `Password for ${args.email || "(no --email given)"} — at least ${MIN_ADMIN_PASSWORD} characters, input hidden: `
      );
      passwordSource = password ? "prompt" : "none";
    } catch {
      passwordSource = "none";
    }
  }

  let liveConfirmation = String(env[CONFIRM_ENV] || "");
  if (liveTarget && !liveConfirmation) {
    liveConfirmation = await ask(
      `About to write to LIVE Firestore project "${env.FIREBASE_PROJECT_ID || "(unknown)"}". Type the project id to confirm: `
    );
  }

  // Every refusal that does not need the database, decided BEFORE it is opened.
  const early = bootstrapProblems({
    env,
    argv: process.argv.slice(2),
    email: args.email,
    password,
    passwordSource,
    superAdminExists: false,
    liveTarget,
    projectId: env.FIREBASE_PROJECT_ID,
    liveConfirmation,
  }).filter((p) => !/SUPER_ADMIN already exists/.test(p));

  // pilot P3 — a live run must NAME its database ("(default)" is refused, and so
  // is an unset name). Deliberately part of the EARLY list: the refusal has to
  // happen BEFORE the connection is opened and before any prompt, which is the
  // order verify-pilot-hardening pins ("refuses before it opens a connection").
  // It is a separate call rather than a rule inside `bootstrapProblems` so the
  // app's own decision stays the single source: one rule, two callers.
  const databaseProblem = liveDatabaseProblem(env);
  if (databaseProblem) early.push(databaseProblem);

  if (early.length) {
    console.error("\nREFUSING TO RUN\n");
    for (const p of early) console.error(`  - ${p}`);
    console.error("\nNothing was read and nothing was written.");
    process.exit(1);
  }

  console.log(`target: ${liveTarget ? `LIVE Firestore (project ${env.FIREBASE_PROJECT_ID})` : `the local Firestore emulator at ${env.FIRESTORE_EMULATOR_HOST}`}`);

  const { initializeApp, getApps, cert } = await import("firebase-admin/app");
  const { getFirestore } = await import("firebase-admin/firestore");
  const bcrypt = (await import("bcryptjs")).default;

  if (!getApps().length) {
    if (!liveTarget) {
      initializeApp({ projectId: env.FIREBASE_PROJECT_ID || undefined });
    } else {
      const unescapeKey = (k) => {
        const BS = String.fromCharCode(92);
        return k.includes(`${BS}n`) ? k.split(`${BS}n`).join("\n") : k;
      };
      initializeApp({
        projectId: env.FIREBASE_PROJECT_ID,
        credential: cert({
          projectId: env.FIREBASE_PROJECT_ID,
          clientEmail: env.FIREBASE_CLIENT_EMAIL,
          privateKey: unescapeKey(env.FIREBASE_PRIVATE_KEY || ""),
        }),
      });
    }
  }
  // pilot P3 — open the RESOLVED name, never a bare default. `liveDatabaseProblem`
  // has already refused a live run with no name, so this is either a real named
  // database or — emulator only — the emulator's own "(default)".
  const databaseName = assertNamedDatabaseId(env);
  const db =
    databaseName === DEFAULT_DATABASE_ID ? getFirestore() : getFirestore(undefined, databaseName);

  // The one database read this script makes: is there already an owner?
  const existing = await db.collection("users").where("role", "==", "SUPER_ADMIN").limit(1).get();
  const alreadyThere = !existing.empty;

  const problems = bootstrapProblems({
    env,
    argv: process.argv.slice(2),
    email: args.email,
    password,
    passwordSource,
    superAdminExists: alreadyThere,
    liveTarget,
    projectId: env.FIREBASE_PROJECT_ID,
    liveConfirmation,
  });
  if (problems.length) {
    console.error("\nREFUSING TO RUN\n");
    for (const p of problems) console.error(`  - ${p}`);
    console.error("\nNothing was written.");
    process.exit(1);
  }

  const email = args.email.trim().toLowerCase();
  const id = userIdForEmail(email);
  await db
    .collection("users")
    .doc(id)
    .set(superAdminDoc({ email, name: args.name.trim() || "Platform Owner", passwordHash: bcrypt.hashSync(password, 10) }));

  // ONLY the email and the id: never the password, never the hash.
  console.log("\nSUPER_ADMIN created.");
  console.log(`  email:   ${email}`);
  console.log(`  user id: ${id}`);
  console.log("\nSign in at the Platform Console with that email and the password you just typed.");
  console.log("Keep the password in the deployment's secret manager; it is shown nowhere else.");
}

/* Only run when this file IS the entry point, so it can be imported for test. */
const invokedDirectly =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;

if (invokedDirectly) {
  await main().catch((e) => {
    console.error(`\nbootstrap-super-admin failed: ${e?.message || e}`);
    process.exit(1);
  });
}
