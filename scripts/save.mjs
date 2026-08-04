/**
 * 💾 Save-progress utility — run after EVERY meaningful step.
 *
 *   npm run save "<what just happened>"
 *
 * Does three things:
 *   1. Appends a timestamped checkpoint to scripts/session-progress.log
 *      (via the shared progress.mjs logger).
 *   2. Writes a machine-readable snapshot to scripts/session-state.json
 *      (savedAt, step, git HEAD, log size) — the file resume.mjs reads.
 *   3. Auto-commits ALL current changes (including the log + snapshot) to git
 *      with a "progress: …" message, so an interrupted session loses nothing.
 *      (Nothing to commit → skips.) The working tree is left CLEAN.
 *
 * If the repo isn't initialized yet, git steps are skipped gracefully.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkpoint, progressLogPath } from "./progress.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = path.join(ROOT, "scripts", "session-state.json");
const LOG = progressLogPath();

const msg = process.argv.slice(2).join(" ").trim() || "progress checkpoint";

// 1) checkpoint line
checkpoint("SAVE", msg);

// 2) git commit (best interruption protection)
let gitHead = null;
let committed = false;
try {
  const dirty = execFileSync("git", ["status", "--porcelain"], {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  if (dirty) {
    execFileSync("git", ["add", "-A"], { cwd: ROOT, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `progress: ${msg}`], { cwd: ROOT, stdio: "ignore" });
    committed = true;
  }
  gitHead = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: ROOT,
    encoding: "utf8",
  }).trim();
} catch (e) {
  console.log("  (git unavailable — commit skipped)");
}

// 3) machine-readable snapshot (folded into the same commit via amend)
let logLines = 0;
try {
  logLines = readFileSync(LOG, "utf8").split("\n").filter(Boolean).length;
} catch {}
const state = {
  savedAt: new Date().toISOString(),
  step: msg,
  gitHead,
  logLines,
};
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

try {
  execFileSync("git", ["add", "--", path.relative(ROOT, STATE_FILE), path.relative(ROOT, LOG)], {
    cwd: ROOT,
    stdio: "ignore",
  });
  execFileSync("git", ["commit", "--amend", "--no-edit"], { cwd: ROOT, stdio: "ignore" });
} catch {
  // no git or nothing to amend — fine
}

console.log(`  🗂️  session-state.json → ${state.savedAt}`);
console.log(committed ? "  ✅ committed to git" : "  ✅ working tree clean (nothing to commit)");
console.log("  → resume anytime with:  npm run resume");
