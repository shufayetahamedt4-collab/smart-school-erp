#!/usr/bin/env node
/**
 * dev-guard.mjs — refuse to start a second `next dev` in the same checkout.
 *
 * Why: `.next/` is keyed to the DIRECTORY, not the port. Two dev servers
 * started from this folder fight over the same build cache — the newer one
 * rewrites/clears manifests and chunk files the older one is still serving.
 * The browser then dies with:
 *
 *   ChunkLoadError: Loading chunk app/<route>/page failed
 *   (error: http://localhost:3000/_next/static/chunks/app/<route>/page.js)
 *
 * and the server stderr shows `ENOENT ... .next\server\app\...\route.js`,
 * which also makes unrelated API routes return 500. (Observed 2026-09-20.)
 *
 * What it does:
 *   1. Takes a lockfile (.dev-server.lock, gitignored) keyed to the checkout.
 *      A live PID in the lock → refuse. A dead PID → stale lock, take over.
 *   2. Pre-checks the chosen TCP port so you get a clear message instead of
 *      Next.js's EADDRINUSE wall — or worse, silently binding another port.
 *   3. On success, spawns `next dev` (or your command) and keeps the lock
 *      until the child exits, releasing it via an exit hook.
 *
 * Usage:
 *   node scripts/dev-guard.mjs                 # next dev on PORT (default 3000)
 *   node scripts/dev-guard.mjs -p 3100         # forwarded to next dev
 *   node scripts/dev-guard.mjs -- <any cmd>    # guard an arbitrary command
 *   node scripts/dev-guard.mjs --check         # report only, start nothing
 *
 * PORT=0 note: this environment exports PORT=0, which `next dev` obeys when
 * no -p flag is given (it binds an unpredictable port). The guard therefore
 * REQUIRES an explicit port: pass -p <port> (or set GUARD_PORT).
 *
 * Recovery, if a ChunkLoadError already happened:
 *   1. netstat -ano | findstr :3000        (see who is listening; note PIDs)
 *   2. taskkill /PID <pid> /F              (kill EVERY dev server of this folder)
 *   3. rmdir /s /q .next                   (delete the clobbered build cache)
 *   4. node scripts/dev-guard.mjs -p 3000  (start exactly ONE server)
 *   5. Hard-reload the browser (Ctrl+Shift+R). A plain reload is not enough
 *      while two servers were alive.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOCK = path.join(ROOT, ".dev-server.lock");
const NEXT_DIR = path.join(ROOT, ".next");

const args = process.argv.slice(2);
const checkOnly = args.includes("--check");
if (checkOnly) args.splice(args.indexOf("--check"), 1);

/** Port resolution: -p flag > GUARD_PORT env > fail (never trust PORT=0). */
function resolvePort(list) {
  const i = list.indexOf("-p");
  if (i !== -1 && list[i + 1]) return Number(list[i + 1]);
  const j = list.findIndex((a) => a.startsWith("--port"));
  if (j !== -1) {
    const eq = list[j].split("=")[1];
    if (eq) return Number(eq);
    if (list[j + 1]) return Number(list[j + 1]);
  }
  if (process.env.GUARD_PORT) return Number(process.env.GUARD_PORT);
  return null;
}

/** Is something already LISTENING on this port? Cheap connect probe. */
function portBusy(port, host = "127.0.0.1", timeoutMs = 800) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    const done = (busy) => {
      sock.destroy();
      resolve(busy);
    };
    sock.setTimeout(timeoutMs);
    sock.once("connect", () => done(true));
    sock.once("timeout", () => done(false));
    sock.once("error", () => done(false));
    sock.connect(port, host);
  });
}

/** PID liveness (works on Windows and POSIX without extra deps). */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but not ours
  }
}

function readLock() {
  try {
    return JSON.parse(readFileSync(LOCK, "utf8"));
  } catch {
    return null;
  }
}

function takeLock(info) {
  writeFileSync(LOCK, JSON.stringify(info, null, 2));
}

function releaseLock() {
  try {
    const cur = readLock();
    if (cur && cur.pid === process.pid) unlinkSync(LOCK);
  } catch {}
}

const RECOVERY = [
  "",
  "  Recovery (if the app already shows ChunkLoadError / API 500s):",
  "    1. netstat -ano | findstr :3000          # list dev-server PIDs",
  "    2. taskkill /PID <pid> /F                # kill EVERY server of this folder",
  "    3. rmdir /s /q .next                     # delete the clobbered build cache",
  "    4. node scripts/dev-guard.mjs -p 3000    # start exactly ONE server",
  "    5. Hard-reload the browser (Ctrl+Shift+R)",
  "",
].join("\n");

async function main() {
  mkdirSync(ROOT, { recursive: true });

  // ---- 1. lockfile check -------------------------------------------------
  const lock = readLock();
  if (lock?.pid && pidAlive(lock.pid)) {
    console.error(`
✋ REFUSED: a dev server is already running for this checkout.

  Lock:      ${LOCK}
  PID:       ${lock.pid} (alive, started ${lock.startedAt})
  Port:      ${lock.port}
  Command:   ${lock.cmd}

  Why this matters: .next/ is keyed to this DIRECTORY, not the port. A second
  dev server here corrupts the first one's build cache mid-serve — the browser
  gets ChunkLoadError and API routes start 500ing (ENOENT in .next\\server).
${RECOVERY}`);
    process.exit(2);
  }
  if (lock) {
    console.log(`[dev-guard] stale lock (pid ${lock.pid} is gone) — taking over.`);
  }

  // ---- 2. command resolution ----------------------------------------------
  // Default: run the local Next.js binary via the current node executable —
  // a bare `next` does not resolve outside npm scripts on all setups.
  const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
  const dash = args.indexOf("--");
  const cmd = dash !== -1 ? args[dash + 1] : process.execPath;
  const rawArgs = dash !== -1 ? args.slice(dash + 2) : [NEXT_BIN, "dev", ...args];
  const label = dash !== -1 ? `${cmd} ${rawArgs.join(" ")}` : `next dev ${args.join(" ")}`;
  const port = resolvePort([...args]);

  if (!port) {
    console.error(`
✋ REFUSED: no explicit port.

  This environment exports PORT=0; \`next dev\` without -p obeys it and binds an
  unpredictable port. Always pass one:

    node scripts/dev-guard.mjs -p 3000
`);
    process.exit(2);
  }

  if (await portBusy(port)) {
    const probeLock = readLock();
    console.error(`
✋ REFUSED: port ${port} is already in use.

  Another process is listening there${probeLock?.pid ? ` (lock says pid ${probeLock.pid}: ${probeLock.cmd || "unknown"})` : ""}.
  Starting a second "next dev" on this folder is exactly how the build cache
  got corrupted last time — fix the existing server instead.
${RECOVERY}`);
    process.exit(3);
  }

  if (checkOnly) {
    console.log(`[dev-guard] OK — lock free, port ${port} free. Safe to start: ${label}`);
    process.exit(0);
  }

  // ---- 3. take lock + spawn ----------------------------------------------
  takeLock({
    pid: process.pid,
    port,
    cmd: label,
    startedAt: new Date().toISOString(),
    cwd: ROOT,
  });

  for (const sig of ["exit", "SIGINT", "SIGTERM", "uncaughtExceptionMonitor"]) {
    try {
      process.on(sig, releaseLock);
    } catch {}
  }

  console.log(`[dev-guard] lock taken (pid ${process.pid}, port ${port}) — starting: ${label}`);
  const child = spawn(cmd, rawArgs, { stdio: "inherit", shell: dash !== -1 && process.platform === "win32", cwd: ROOT });
  child.on("exit", (code) => {
    releaseLock();
    process.exit(code ?? 0);
  });
  child.on("error", (err) => {
    console.error(`[dev-guard] failed to start "${cmd}": ${err.message}`);
    releaseLock();
    process.exit(1);
  });
}

main().catch((e) => {
  console.error(`[dev-guard] ${e?.message || e}`);
  process.exit(1);
});
