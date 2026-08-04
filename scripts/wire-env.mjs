/**
 * Populates FIREBASE_* values in .env from service-account.json.
 * Keeps every other line intact (e.g. JWT_SECRET, APP_URL).
 * Run:  npm run env:wire   (or: node scripts/wire-env.mjs)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const saPath = path.join(ROOT, "service-account.json");
const envPath = path.join(ROOT, ".env");

if (!existsSync(saPath)) {
  console.error("❌ service-account.json not found in project root.");
  process.exit(1);
}
if (!existsSync(envPath)) {
  console.error("❌ .env not found in project root.");
  process.exit(1);
}

const sa = JSON.parse(readFileSync(saPath, "utf8"));
if (!sa.project_id || !sa.client_email || !sa.private_key) {
  console.error("❌ service-account.json is missing project_id / client_email / private_key.");
  process.exit(1);
}

/** Escape a value for a single-line double-quoted .env entry. */
const esc = (s) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

let env = readFileSync(envPath, "utf8");

// Drop any multi-line FIREBASE_PRIVATE_KEY placeholder (line + its continuation lines).
const lines = env.split(/\r?\n/);
const kept = [];
let inKey = false;
for (const line of lines) {
  if (/^FIREBASE_PRIVATE_KEY=/.test(line)) {
    inKey = true;
    continue;
  }
  if (inKey) {
    if (line.trim().endsWith('"') && line.trim().startsWith('"')) {
      inKey = false;
    } else if (line.trim() === '"' || line.trim().endsWith('"')) {
      inKey = false;
    } else if (!line.includes('"')) {
      continue; // continuation line of the multi-line placeholder
    } else {
      inKey = false;
      kept.push(line);
    }
    continue;
  }
  kept.push(line);
}
env = kept.join("\n");

const set = (key, value) => {
  const re = new RegExp(`^${key}=.*$`, "m");
  const line = `${key}="${esc(value)}"`;
  env = re.test(env) ? env.replace(re, line) : env + (env.endsWith("\n") ? "" : "\n") + line;
};

set("FIREBASE_PROJECT_ID", sa.project_id);
set("FIREBASE_CLIENT_EMAIL", sa.client_email);
set("FIREBASE_PRIVATE_KEY", sa.private_key);
if (!/^FIREBASE_STORAGE_BUCKET=/m.test(env)) {
  set("FIREBASE_STORAGE_BUCKET", `${sa.project_id}.firebasestorage.app`);
}

writeFileSync(envPath, env, "utf8");
console.log(`✅ .env updated with credentials for project "${sa.project_id}"`);
console.log(`   FIREBASE_CLIENT_EMAIL=${sa.client_email}`);
