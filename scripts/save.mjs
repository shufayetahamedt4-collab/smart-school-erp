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
 * Safety: refuses to commit if anything that looks like a secret
 * (.env*, *service-account*, *.pem) is staged. Fix .gitignore, then re-run.
 *
 * If the repo isn't initialized / git identity is missing, git steps are
 * skipped gracefully with a clear message.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkpoint, progressLogPath } from "./progress.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = path.join(ROOT, "scripts", "session-state.json");
const LOG = progressLogPath();
const posix = (p) => p.split(path.sep).join("/");

// Patterns that must NEVER be committed, even if .gitignore misses them.
const SECRET_RE = /(service-account|\.env(\.|$)|\.pem$|private[-_]?key)/i;

const msg = process.argv.slice(2).join(" ").trim() || "progress checkpoint";

// 1) checkpoint line
checkpoint("SAVE", msg);

// 2) git commit (best interruption protection)
let gitHead = null;
let committed = false;
let gitReason = null;

function runGit(args, opts = {}) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

try {
  // Is this even a repo?
  runGit(["rev-parse", "--is-inside-work-tree"]);
  // Is git identity configured? (git commit fails without it)
  try {
    runGit(["config", "user.email"]);
  } catch {
    gitReason = "git user.name/user.email not configured — set it (git config user.email \"you@x.com\"), then re-run save";
  }

  if (!gitReason) {
    const dirty = runGit(["status", "--porcelain"]).trim();
    if (dirty) {
      runGit(["add", "-A"]);

      // ⛔ SECRET GUARD — abort if anything sensitive is staged.
      const staged = runGit(["diff", "--cached", "--name-only"]).trim();
      const bad = staged.split("\n").filter((f) => f && SECRET_RE.test(f));
      if (bad.length) {
        console.error("  ❌ REFUSED to commit — these look like secrets:");
        for (const f of bad) console.error("       " + f);
        console.error("  → add them to .gitignore (or remove from disk), then re-run npm run save.");
        process.exit(1);
      }

      runGit(["commit", "-m", `progress: ${msg}`]);
      committed = true;
    }
  }
  gitHead = runGit(["rev-parse", "--short", "HEAD"]).trim();
} catch (e) {
  gitReason = gitReason || `git error: ${String(e?.stderr || e?.message || e).trim().slice(0, 200)}`;
}

// 3) machine-readable snapshot (folded into the same commit via amend)
let logLines = 0;
try {
  logLines = readFileSync(LOG, "utf8").split("\n").filter(Boolean).length;
} catch {}
const state = { savedAt: new Date().toISOString(), step: msg, gitHead, logLines };
writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));

try {
  // Amend keeps the snapshot + log inside the same progress commit.
  // Edge case: if the process dies between the commit above and this amend,
  // the snapshot stays uncommitted on disk — resume.mjs will flag it, so
  // recovery is still safe. (Don't "simplify" this into a second commit.)
  runGit(["add", "--", posix(path.relative(ROOT, STATE_FILE)), posix(path.relative(ROOT, LOG))]);
  runGit(["commit", "--amend", "--no-edit"]);
} catch {
  // nothing staged to amend (or no git) — harmless
}

console.log(`  🗂️  session-state.json → ${state.savedAt}`);
if (gitReason) {
  console.log(`  ⚠️  commit skipped: ${gitReason}`);
  console.log("  → your changes are NOT committed — fix git, then re-run npm run save");
} else {
  console.log(committed ? "  ✅ committed to git" : "  ✅ working tree clean (nothing to commit)");
}
console.log("  → resume anytime with:  npm run resume");
