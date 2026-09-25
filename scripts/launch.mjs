/**
 * Start Amar E School on this PC and open it in the browser.
 *
 *   npm run app          (or double-click start.cmd on Windows)
 *
 * What it does, in order:
 *   1. reads APP_PORT from .env (default 3000)
 *   2. if the app is already answering on that port, just opens the browser
 *   3. otherwise runs `next start` in the background, logging to app.log
 *   4. waits for the first HTTP 200, then opens the browser
 *   5. writes .app.pid so `npm run app:stop` / stop.cmd can shut it down
 *
 * It talks to the built app (.next/), because that is the thing a school
 * actually runs: it starts in about a second and does not recompile on every
 * click. Run `npm run build`, or install.cmd, if .next is missing.
 */
import { existsSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const PID_PATH = path.join(ROOT, ".app.pid");
const LOG_PATH = path.join(ROOT, "app.log");

/** Minimal .env reader — enough for KEY=value and KEY="quoted value". */
function readEnv() {
  const out = {};
  if (!existsSync(ENV_PATH)) return out;
  for (const line of readFileSync(ENV_PATH, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      value = value.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    }
    out[m[1]] = value;
  }
  return out;
}

const env = readEnv();
const port = Number(process.env.APP_PORT || env.APP_PORT || 3000);
// Loopback by default: a school that installs this on one PC should not be
// serving its staff area to whoever is on the same coffee-shop wifi. Set
// APP_HOST=0.0.0.0 in .env to let other devices on your network use it.
const host = process.env.APP_HOST || env.APP_HOST || "127.0.0.1";
const url = `http://localhost:${port}/login`;

const say = (msg) => console.log(msg);

function openBrowser(target) {
  try {
    if (process.platform === "win32") {
      // `start` is a cmd builtin; the empty "" is the window title it expects.
      spawn("cmd", ["/c", "start", "", target], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [target], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [target], { detached: true, stdio: "ignore" }).unref();
    }
    say(`🌐 Opened ${target}`);
  } catch {
    say(`🌐 Open this in your browser: ${target}`);
  }
}

async function answering(ms = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(ms) });
    return res.status > 0;
  } catch {
    return false;
  }
}

async function waitForBoot(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await answering()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function runningPid() {
  if (!existsSync(PID_PATH)) return null;
  const pid = Number(readFileSync(PID_PATH, "utf8").trim());
  if (!pid) return null;
  try {
    process.kill(pid, 0); // does not signal it, just checks it exists
    return pid;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------------------- main
say("");
say("  ┌──────────────────────────────────────────────┐");
say("  │   Amar E School — School ERP + Parents App   │");
say("  └──────────────────────────────────────────────┘");
say("");

if (await answering()) {
  say(`✅ Already running on port ${port}.`);
  openBrowser(url);
  process.exit(0);
}

if (!existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
  say("❌ The app has not been built yet (.next/ is missing).");
  say("   Windows:  double-click install.cmd");
  say("   Any OS:   npm ci && npm run setup && npm run build");
  process.exit(1);
}

if (!existsSync(ENV_PATH)) {
  say("❌ .env is missing — the app has no database to talk to.");
  say("   Windows:  double-click install.cmd (it writes .env for you)");
  process.exit(1);
}

const nextBin = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
if (!existsSync(nextBin)) {
  say("❌ Dependencies are not installed (node_modules/next is missing).");
  say("   Run:  npm ci");
  process.exit(1);
}

say(`⏳ Starting on port ${port} (log: app.log)…`);
const log = openSync(LOG_PATH, "a");
const child = spawn(process.execPath, [nextBin, "start", "-p", String(port), "-H", host], {
  cwd: ROOT,
  detached: true,
  stdio: ["ignore", log, log],
  env: { ...process.env, APP_PORT: String(port) },
});
child.unref();
writeFileSync(PID_PATH, String(child.pid), "utf8");

if (!(await waitForBoot())) {
  say(`❌ It did not start answering on port ${port} within a minute.`);
  say("   The last lines of app.log usually say why:");
  say(`   ${LOG_PATH}`);
  process.exit(1);
}

say(`✅ Running at ${url}`);
say(
  host === "127.0.0.1" || host === "localhost"
    ? "   Only this PC can reach it (set APP_HOST=0.0.0.0 in .env to share it on your network)."
    : `   Reachable from your network on port ${port} — open http://<this-pc-ip>:${port}`
);
say("");
say("   Sign in with a demo account (the sign-in screen lists them, click to fill):");
say("     School Admin   principal@sunrise.edu  / School@123");
say("     Teacher        teacher@sunrise.edu     / Teacher@123");
say("     Guardian       guardian1@demo.com      / Guardian@123");
say("     Super Admin    admin@smartschool.com   / Admin@123");
say("");
say("   One address serves every app — sign in and you land in yours.");
say("   Stop it again with stop.cmd (Windows) or: npm run app:stop");
say("");
openBrowser(url);
