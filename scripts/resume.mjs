/**
 * 🚀 Resume utility — "where did we leave off?"
 *
 *   npm run resume
 *
 * Prints a single screen with everything a fresh session needs:
 *   1. The last saved checkpoint + state snapshot (scripts/session-state.json)
 *   2. The most recent checkpoints (tail of scripts/session-progress.log)
 *   3. Git state (last commits + uncommitted changes)
 *   4. Is the dev/prod server running on :3000?
 *   5. .env sanity — the #1 historical blocker was a corrupted FIREBASE_PRIVATE_KEY
 *   6. Pointer to the latest "Next steps" in PROGRESS.md
 *
 * Optional:  npm run resume -- --seed   → also runs node scripts/check-seed.mjs
 * (Firestore read-only; reports seed phase status).
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const STATE_FILE = path.join(ROOT, "scripts", "session-state.json");
const LOG = path.join(ROOT, "scripts", "session-progress.log");
const ENV_FILE = path.join(ROOT, ".env");

const line = (s = "") => console.log(s);
const hr = () => console.log("  " + "─".repeat(58));

function readEnv() {
  try {
    return readFileSync(ENV_FILE, "utf8");
  } catch {
    return "";
  }
}

function envValue(env, key) {
  const m = env.match(new RegExp(`^${key}\\s*=\\s*(.*)$`, "m"));
  if (!m) return null;
  return m[1].trim().replace(/^["']|["']$/g, "").replace(/\\n/g, "\n");
}

async function serverStatus() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch("http://localhost:3000/welcome", { signal: ctrl.signal });
    clearTimeout(t);
    return `✅ responding (HTTP ${res.status}) — open http://localhost:3000`;
  } catch {
    return "⬜ not running — start with  npm run dev  (or  npm start  for the prod build)";
  }
}

async function main() {
  const withSeed = process.argv.includes("--seed");
  line("");
  line("  🚀  SMART SCHOOL ERP — RESUME SCREEN");
  hr();

  // 1) last saved state
  line("  📍 Last saved checkpoint:");
  try {
    const s = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    line(`     ${s.savedAt}  —  ${s.step}`);
    line(`     git HEAD: ${s.gitHead || "n/a"}   ·   log entries: ${s.logLines}`);
  } catch {
    line("     (no session-state.json yet — save once with  npm run save \"...\")");
  }

  // 2) recent checkpoints
  line("");
  line("  🧾 Recent checkpoints (tail of session-progress.log):");
  try {
    const all = readFileSync(LOG, "utf8").split("\n").filter(Boolean);
    for (const l of all.slice(-10)) line("     " + l);
  } catch {
    line("     (no checkpoint log yet)");
  }

  // 3) git state
  line("");
  line("  📦 Git:");
  try {
    const log = execFileSync("git", ["log", "--oneline", "-4"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    line("     " + (log || "(no commits)").replace(/\n/g, "\n     "));
    const dirty = execFileSync("git", ["status", "--porcelain"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    line(dirty ? `     ⚠️  ${dirty.split("\n").length} uncommitted file(s) — run  npm run save \"...\"` : "     ✅ working tree clean");
  } catch {
    line("     (not a git repo yet)");
  }

  // 4) server
  line("");
  line("  🌐 Local server (:3000):");
  line("     " + (await serverStatus()));

  // 5) .env sanity
  line("");
  line("  🔑 .env sanity:");
  const env = readEnv();
  if (!env) {
    line("     ❌ .env missing — copy .env.example and fill in Firebase credentials");
  } else {
    const pk = envValue(env, "FIREBASE_PRIVATE_KEY");
    const pid = envValue(env, "FIREBASE_PROJECT_ID");
    const jwt = envValue(env, "JWT_SECRET");
    line(`     FIREBASE_PROJECT_ID: ${pid ? "✅ " + pid : "❌ missing"}`);
    line(
      pk && pk.includes("BEGIN PRIVATE KEY")
        ? "     FIREBASE_PRIVATE_KEY: ✅ parses as a PEM key"
        : "     FIREBASE_PRIVATE_KEY: ❌ missing or corrupted (never re-run wire-env.mjs twice — re-download the service account)"
    );
    line(jwt && jwt !== "change-me-to-a-long-random-string" ? "     JWT_SECRET: ✅ set" : "     JWT_SECRET: ⚠️ default/empty — set a long random value");
  }

  // 6) next steps from PROGRESS.md
  line("");
  line("  🎯 Next steps (last 'Next steps' section in PROGRESS.md):");
  try {
    const p = readFileSync(path.join(ROOT, "PROGRESS.md"), "utf8");
    const sections = p.split(/\n## /);
    for (let i = sections.length - 1; i >= 0; i--) {
      const m = sections[i].match(/Next steps \(in order\):\n([\s\S]*?)(?=\n## |$)/);
      if (m) {
        for (const l of m[1].trim().split("\n").filter(Boolean)) line("     " + l.trim());
        break;
      }
    }
  } catch {}
  line("     Full context: open PROGRESS.md");

  if (withSeed) {
    line("");
    line("  🗃️  Seed state (--seed):");
    try {
      execFileSync("node", [path.join(ROOT, "scripts", "check-seed.mjs")], {
        cwd: ROOT,
        stdio: "inherit",
      });
    } catch {
      line("     (check-seed failed — is .env correct?)");
    }
  }

  hr();
  line("  Resume playbook:  1. npm run resume  2. PROGRESS.md  3. npm run dev");
  line("");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
