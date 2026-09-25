/**
 * Stop the app started by `npm run app` / start.cmd.
 *
 *   npm run app:stop        (or double-click stop.cmd on Windows)
 *
 * It reads the PID the launcher recorded (.app.pid). If that file is gone — a
 * reboot, or a process started by hand — it falls back to whatever is listening
 * on the app's port, so "the port is still busy" is never a dead end.
 */
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PID_PATH = path.join(ROOT, ".app.pid");

function readEnv() {
  const out = {};
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return out;
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^"|"$/g, "");
  }
  return out;
}

const port = Number(process.env.APP_PORT || readEnv().APP_PORT || 3000);

/** PIDs listening on the app's port (Windows via netstat, POSIX via lsof). */
function pidsOnPort() {
  const pids = new Set();
  try {
    if (process.platform === "win32") {
      const out = execFileSync("netstat", ["-ano"], { encoding: "utf8" });
      for (const line of out.split(/\r?\n/)) {
        if (!line.includes("LISTENING")) continue;
        const cols = line.trim().split(/\s+/);
        if (cols[1]?.endsWith(`:${port}`)) pids.add(Number(cols[cols.length - 1]));
      }
    } else {
      const out = execFileSync("lsof", ["-ti", `tcp:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" });
      for (const pid of out.split(/\s+/)) if (pid) pids.add(Number(pid));
    }
  } catch {
    // netstat/lsof missing or nothing listening — nothing to do
  }
  pids.delete(0);
  return [...pids];
}

function kill(pid) {
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/F"]);
    } catch {
      return false;
    }
  }
  return true;
}

const targets = new Set();
if (existsSync(PID_PATH)) {
  const pid = Number(readFileSync(PID_PATH, "utf8").trim());
  if (pid) targets.add(pid);
}
for (const pid of pidsOnPort()) targets.add(pid);

if (!targets.size) {
  console.log(`✅ Nothing is running on port ${port}.`);
  if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
  process.exit(0);
}

let stopped = 0;
for (const pid of targets) {
  if (kill(pid)) {
    stopped++;
    console.log(`🛑 Stopped process ${pid}`);
  }
}
if (existsSync(PID_PATH)) unlinkSync(PID_PATH);
console.log(stopped ? "✅ Amar E School is stopped." : `⚠️  Could not stop ${[...targets].join(", ")} — close it in Task Manager.`);
