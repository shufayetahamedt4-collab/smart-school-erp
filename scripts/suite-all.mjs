#!/usr/bin/env node
/**
 * suite-all.mjs — the ONE self-contained runner for the `verify-*.mjs` suite.
 *
 * The suite used to be driven by a wrapper outside the repository (a temp
 * `fullrun.mjs`), which is why three verifiers could never pass inside it: the
 * wrapper exported neither `BASE`/`BASE_URL` nor `SMOKE_PORT`, so
 * `verify-exams-invalidation` dialled a dead port (58497) and `qa-phase23` /
 * `qa-certificates` dialled another (64512) instead of the running app. This
 * script makes the harness a first-class part of the repo and fixes exactly that
 * (docs/PILOT-FIX-2.md §8), without editing a single verifier's checks.
 *
 *   node scripts/suite-all.mjs                     the whole suite
 *   SUITE_ONLY=verify-fees-totals node scripts/suite-all.mjs   just these
 *   SUITE_FROM=verify-guardian-child node scripts/suite-all.mjs  resume here
 *   SUITE_PURE=0 node scripts/suite-all.mjs        skip the offline batch
 *
 * What it guarantees, per verifier:
 *   - a clean, freshly seeded emulator (wipe → `seed.mjs` → `isolation-fixture.mjs
 *     create`) and an app RESTARTED after that wipe, so no verifier inherits a
 *     document another one created (or deleted) — the rule behind the
 *     order-sensitive group (`verify-sweep-routes`, `verify-admission-intake`,
 *     and the bulk-import/onboarding pair, which must run BEFORE the onboarding
 *     verifiers that create and delete `ONB-*` students in the demo school);
 *   - the kit catalogue stocked (scripts/seed-kit-demo.mjs) for the two verifiers
 *     that read the demo catalogue — `verify-admission-intake` has crashed for
 *     want of it;
 *   - BASE, BASE_URL, SMOKE_PORT and VERIFY_PORT all pointing at the app it
 *     started, in the verifier's environment;
 *   - `verify-college-fees-api` LAST — it resets its own tenant through
 *     `firebase-admin`, which cannot invalidate the app's pull memo, so a
 *     verifier after it could read a row it had just deleted
 *     (docs/TESTING.md, "Why verify-college-fees-api runs LAST").
 *
 * It prints, for every verifier, its exit code and the count the SCRIPT ITSELF
 * printed (its own summary line — the wrapper's ✅ counter is not a count), and
 * it exits non-zero if any verifier failed outside the documented reds:
 * `verify-read-cache` and `verify-routine-config` are known reds, and
 * `qa-certificates` carries one known failure (its credential-gated orphan
 * sweep), which the emulator-only rule forbids fixing.
 *
 * Logs: $SUITE_LOG_DIR (default <tmp>/sspr/suite-logs) — one file per verifier,
 * plus `progress.log` and `results.json`.
 */
import { spawn, spawnSync, execSync } from "node:child_process";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, openSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = process.env.SUITE_PORT || "3000";
const EMULATOR_PORT = 8080;
const PROJECT = process.env.FIREBASE_PROJECT_ID || "demo-ss-test";
const OUT = process.env.SUITE_LOG_DIR || join(tmpdir(), "sspr", "suite-logs");
mkdirSync(OUT, { recursive: true });
const PROGRESS = join(OUT, "progress.log");

/* ------------------------------------------------------------- the suite list */

/** Offline and pure: no emulator, no server, no socket. */
const PURE = [
  "verify-college-gate",
  "verify-college-fees-logic",
  "verify-college-fees-data",
  "verify-college-results-data",
  "verify-college-results-page",
  "verify-college-fees-page",
  "verify-college-promotion-logic",
  "verify-college-promotion-page",
  "verify-college-grading-logic",
  "verify-college-routes",
  "verify-college-terms",
  "verify-onboarding-seed",
  "verify-database-id",
  "verify-nav-scope",
  "verify-registration-status",
  "verify-college-permissions",
  // ca-0 — the college attendance allow-list: it imports the pure module and
  // pins ca-0's boundary (no consumer, no collection, no school path).
  "verify-college-attendance-access",
];

/**
 * The documented order. `verify-college-fees-api` stays LAST (see the header);
 * `verify-fee-reconciliation` (pilot P2c) joins the fee group after
 * `verify-school-fee-idempotency`.
 */
const SERVER = [
  "verify-pilot-hardening",
  "verify-mode-foundation",
  "verify-user-secrets",
  "verify-onboarding-monitor",
  "verify-tenant-isolation",
  "verify-branch-isolation",
  // 7e — the BOTH tenant's two halves never mix in a read. It WRITES (one college
  // head/structure/charge, which is what makes "identical with and without college
  // charges present" a measurement), so it runs with the isolation group and
  // before verify-college-fees-api, which resets its own tenant LAST.
  "verify-mode-mixing",
  // 8-pre — the course↔teacher link. It WRITES (one college teacher row per
  // assertion, which is what makes "one row per pair" a measurement) and deletes
  // everything it created, so it runs with the college group and before
  // verify-college-fees-api, which resets its own tenant LAST.
  "verify-course-teachers",
  "verify-college-enrollment",
  "verify-course-registrations",
  "verify-enroll-paths",
  "verify-enrollment-fees",
  "verify-fees-totals",
  "verify-school-fee-idempotency",
  "verify-fee-reconciliation",
  "verify-qr-credentials",
  "verify-notifications",
  "verify-grading",
  "verify-guardian-child",
  "verify-read-cache",
  "verify-routine-config",
  "verify-cache-scoping",
  "verify-invalidation",
  "verify-exams-invalidation",
  "verify-write-freshness",
  "verify-write-integrity",
  "verify-academic-sessions",
  "verify-class-sessions",
  "verify-bulk-import",
  "verify-admission-intake",
  "verify-onboarding-type",
  "verify-promotion-rollover",
  "qa-phase23",
  "qa-certificates",
  "verify-phase7-e2e",
  "verify-college-results-api",
  "verify-college-promotion-api",
  "verify-college-promotion-lease",
  "verify-sweep-routes",
  "verify-college-fees-api", // LAST — it resets its own tenant
];

/** Verifiers that read the demo catalogue and need its shelves stocked. */
const KIT = new Set(["verify-admission-intake", "verify-write-integrity"]);

/** Documented, expected non-zero exits. Anything else is a real failure. */
const KNOWN_RED = {
  "verify-read-cache": "known red — 17 route(s) still pay full latency",
  "verify-routine-config": "known red — calendar-gated (see PILOT-FIX-2 §2.2)",
  "qa-certificates": "known red — its credential-gated orphan sweep (1 failure)",
};

/* ------------------------------------------------------------------ the env */

const CHILD_ENV = { ...process.env };
delete CHILD_ENV.FIRESTORE_DATABASE_ID; // a named CLOUD database: never for a suite run
delete CHILD_ENV.FIRESTORE_DB_ID; // its documented alias
Object.assign(CHILD_ENV, {
  SMOKE_PORT: PORT,
  VERIFY_PORT: PORT,
  BASE: `http://127.0.0.1:${PORT}`,
  BASE_URL: `http://127.0.0.1:${PORT}`,
  DEV_EMULATOR_PORT: PORT,
  FIRESTORE_EMULATOR_HOST: `127.0.0.1:${EMULATOR_PORT}`,
  FIREBASE_PROJECT_ID: PROJECT,
  // Empty (not deleted): Next.js fills an ABSENT variable from `.env`, so a live
  // key or a production secret would walk back in. See scripts/dev-emulator.mjs.
  FIREBASE_CLIENT_EMAIL: "",
  FIREBASE_PRIVATE_KEY: "",
  JWT_SECRET: process.env.JWT_SECRET || "",
  PAYMENT_WEBHOOK_SECRET: "",
  DB_QUERY_DIAG: "",
});

const say = (line) => {
  console.log(line);
  appendFileSync(PROGRESS, `${line}\n`);
};
const sh = (cmd, opts = {}) => {
  try {
    return execSync(cmd, { encoding: "utf8", timeout: 30000, ...opts });
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`;
  }
};

/* ------------------------------------------------------- emulator and app --- */

function pidsOnPorts(ports) {
  const out = sh("netstat -ano");
  const pids = new Set();
  for (const line of out.split("\n")) {
    for (const p of ports) {
      if (new RegExp(`:${p}\\s`).test(line) && /LISTENING/.test(line)) {
        const parts = line.trim().split(/\s+/);
        const pid = String(parts[parts.length - 1] || "").replace(/\r/g, "");
        if (/^\d+$/.test(pid) && pid !== "0") pids.add(pid);
      }
    }
  }
  return [...pids];
}
// /T kills the whole tree: the port owner is usually the `next dev` child, while
// its `dev-emulator.mjs` parent (and any npx shim) would otherwise survive and
// keep serving with a stale memo. Single slashes — this runs under node (cmd.exe).
const killPids = (pids) => {
  for (const pid of pids) sh(`taskkill /PID ${pid} /T /F`);
};

const waitFor = async (cond, tries, gapMs, label) => {
  for (let i = 0; i < tries; i += 1) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  throw new Error(`timeout waiting for: ${label}`);
};
const portListening = (port) => () => pidsOnPorts([port]).length > 0;
const portFree = (port) => () => pidsOnPorts([port]).length === 0;

async function wipeEmulator() {
  // Order matters: the firebase-tools wrapper (4000/4400) respawns its java child
  // when only the child is killed, so the wrapper tree goes FIRST.
  killPids(pidsOnPorts([4000, 4400]));
  await new Promise((r) => setTimeout(r, 3000));
  killPids(pidsOnPorts([EMULATOR_PORT, 5000, 9199, Number(PORT)]));
  await waitFor(portFree(EMULATOR_PORT), 20, 1000, `emulator port ${EMULATOR_PORT} to free`);
  const log = openSync(join(OUT, "emulator.log"), "a");
  const child = spawn("npx", ["firebase", "emulators:start", "--only", "firestore", "--project", PROJECT], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    shell: true,
    env: CHILD_ENV,
  });
  child.unref();
  await waitFor(portListening(EMULATOR_PORT), 60, 2000, `emulator ${EMULATOR_PORT} to listen`);
  await new Promise((r) => setTimeout(r, 5000));
}

function runScript(name, args = []) {
  const run = spawnSync(process.execPath, [`scripts/${name}.mjs`, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: CHILD_ENV,
    timeout: 900000,
  });
  const out = `${run.stdout || ""}\n${run.stderr || ""}`;
  writeFileSync(join(OUT, `${name}.log`), out);
  return { status: run.status, out };
}

/** The clean state every server-backed verifier starts from. */
function resetState(name) {
  const seed = runScript("seed");
  if (seed.status !== 0) throw new Error(`seed.mjs failed:\n${seed.out.slice(-1500)}`);
  const fixture = runScript("isolation-fixture", ["create"]);
  if (fixture.status !== 0) throw new Error(`isolation-fixture.mjs failed:\n${fixture.out.slice(-800)}`);
  if (KIT.has(name)) {
    const kit = runScript("seed-kit-demo");
    if (kit.status !== 0) throw new Error(`seed-kit-demo.mjs failed:\n${kit.out.slice(-800)}`);
    say(`(kit shelves stocked for ${name})`);
  }
}

async function restartApp(cycle) {
  killPids(pidsOnPorts([Number(PORT)]));
  await waitFor(portFree(Number(PORT)), 20, 1000, `app port ${PORT} to free`);
  const log = openSync(join(OUT, `app-${cycle}.log`), "w");
  const child = spawn(process.execPath, ["scripts/dev-emulator.mjs"], {
    cwd: ROOT,
    detached: true,
    stdio: ["ignore", log, log],
    shell: false,
    env: CHILD_ENV,
  });
  child.unref();
  // Readiness is a real sign-in: /api/health answers 503 in emulator mode by
  // design (it names the absent cloud credentials). A stale generation — old
  // memo, dead emulator — answers the login with 401, so this also proves the
  // app that is serving actually sees the freshly seeded database.
  const ready = async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "principal@sunrise.edu", password: "School@123" }),
        signal: AbortSignal.timeout(30000),
      });
      return r.status === 200;
    } catch {
      return false;
    }
  };
  await waitFor(ready, 60, 2000, `app at ${PORT} to answer a sign-in`);
  const holders = pidsOnPorts([Number(PORT)]);
  if (holders.length !== 1) throw new Error(`app: expected 1 holder of :${PORT}, found ${holders.join(",") || "(none)"}`);
}

/* ------------------------------------------------------------------ reporting */

/**
 * The count the SCRIPT ITSELF printed — its own summary line, in the many shapes
 * the suite uses (`PASSED — 255 checks`, `RESULT: 69/69`, `260/260`, `17 PASS`,
 * `160 passed, 0 failed`, `36/0`, …). The wrapper's ✅ tally is NOT a count (it
 * counts a summary line as one more check).
 */
function ownCount(out) {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  // (1) The script's own SUMMARY line — a number that describes its outcome.
  //     Read from the TAIL only, and never from a per-check line: a check whose
  //     DETAIL happens to contain "80/100" or "passed=true" is not a count.
  const checkLine = /^(?:\[PASS\]|\[FAIL\]|(?:PASS|FAIL|ok)[ \t]{2,})/i;
  const tail = lines.slice(-12).filter((l) => !checkLine.test(l));
  const summary = [
    /\bPASSED\b[^A-Za-z0-9]{0,8}\d/i,
    /^=*\s*RESULT[:\s]/i,
    /^TOTAL:.*\d/i,
    /\b\d+\s*\/\s*\d+\s*checks?\b/i,
    /\b\d+\s+checks?\b/i,
    /\b\d+\s+PASS\b/,
    /\b\d+\s+passed\b/i,
    /\b\d+\s+(?:failure|fail)s?\b/i,
  ];
  for (const p of summary) {
    for (let i = tail.length - 1; i >= 0; i -= 1) {
      if (p.test(tail[i])) return tail[i].slice(0, 120);
    }
  }
  // (2) A script with no numeric summary still counts its own checks, one line
  //     each (`  PASS  …` / `[PASS]` / `  FAIL  …`) — that IS its own count.
  const passLines = lines.filter((l) => /^(?:\[PASS\]|PASS\b|ok\b)/i.test(l)).length;
  const failLines = lines.filter((l) => /^(?:\[FAIL\]|FAIL\b)/i.test(l)).length;
  if (passLines || failLines) return `${passLines} PASS / ${failLines} FAIL (the script's own lines)`;
  // (3) Last resort: the ✅/❌ markers it printed (the summary line counts once).
  const ok = (out.match(/✅/g) || []).length;
  const fail = (out.match(/❌/g) || []).length;
  return `${ok} ✅ / ${fail} ❌ markers`;
}

/* ----------------------------------------------------------------------- run */

const ONLY = (process.env.SUITE_ONLY || "").split(",").map((s) => s.trim()).filter(Boolean);
const FROM = process.env.SUITE_FROM || "";
const SKIP_PURE = process.env.SUITE_PURE === "0";
if (ONLY.length) {
  const unknown = ONLY.filter((n) => !PURE.includes(n) && !SERVER.includes(n));
  if (unknown.length) {
    console.error(`SUITE_ONLY names a script that is not in the suite: ${unknown.join(", ")}`);
    process.exit(2);
  }
}
// The one ordering rule this runner enforces on itself, whatever it was asked to run.
if (ONLY.length && ONLY.includes("verify-college-fees-api") && ONLY[ONLY.length - 1] !== "verify-college-fees-api") {
  console.error("verify-college-fees-api must run LAST (it resets its own tenant).");
  process.exit(2);
}

say(`suite-all: ${PURE.length} offline + ${SERVER.length} server-backed verifier(s); app :${PORT}, emulator :${EMULATOR_PORT}`);
say(`logs: ${OUT}`);

const results = [];
const record = (r) => {
  results.push(r);
  writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 1));
  const known = KNOWN_RED[r.name];
  const verdict = r.exit === 0 ? "ok" : known ? "KNOWN-RED (allowed)" : "FAILED";
  say(`${r.name.padEnd(32)} exit=${String(r.exit).padStart(3)}  ${String(r.ok).padStart(4)}✅ ${String(r.fail).padStart(3)}❌  ${String(r.secs).padStart(4)}s  ${verdict}`);
  say(`${" ".repeat(32)} own="${r.own}"${known && r.exit !== 0 ? `\n${" ".repeat(32)} ${known}` : ""}`);
};

const runList = (list) => {
  for (const name of list) {
    const started = Date.now();
    const r = runScript(name);
    record({
      name,
      exit: r.status,
      ok: (r.out.match(/✅/g) || []).length,
      fail: (r.out.match(/❌/g) || []).length,
      secs: Math.round((Date.now() - started) / 1000),
      own: ownCount(r.out),
    });
  }
};

if (!SKIP_PURE) runList(PURE);

const serverFrom = FROM && SERVER.includes(FROM) ? SERVER.indexOf(FROM) : 0;
const serverList = ONLY.length ? ONLY.filter((n) => SERVER.includes(n)) : SERVER.slice(serverFrom);

for (const name of serverList) {
  const started = Date.now();
  let r;
  try {
    await wipeEmulator();
    resetState(name);
    await restartApp(name);
    r = runScript(name);
  } catch (e) {
    r = { status: -1, out: `HARNESS ERROR: ${String(e.message || e).slice(0, 1200)}` };
    writeFileSync(join(OUT, `${name}.log`), r.out);
    say(`${name}: HARNESS ERROR — ${String(e.message || e).split("\n")[0].slice(0, 200)}`);
  }
  record({
    name,
    exit: r.status,
    ok: (r.out.match(/✅/g) || []).length,
    fail: (r.out.match(/❌/g) || []).length,
    secs: Math.round((Date.now() - started) / 1000),
    own: ownCount(r.out),
  });
}

const failed = results.filter((r) => r.exit !== 0 && !KNOWN_RED[r.name]);
const knownRed = results.filter((r) => r.exit !== 0 && KNOWN_RED[r.name]);
const totalOk = results.reduce((a, r) => a + r.ok, 0);
const totalFail = results.reduce((a, r) => a + r.fail, 0);
say("");
say(`TOTAL: ${results.length} verifier(s), ${totalOk} ✅ / ${totalFail} ❌ markers, ${results.filter((r) => r.exit === 0).length} exit 0`);
say(`known reds (allowed): ${knownRed.map((r) => r.name).join(", ") || "(none reported this run)"}`);
say(`unexpected failures: ${failed.map((r) => `${r.name}(exit ${r.exit})`).join(", ") || "(none)"}`);
process.exit(failed.length ? 1 : 0);
