/**
 * Moment-to-moment checkpoint logger.
 * Appends a timestamped line to scripts/session-progress.log so that if a
 * session is interrupted (power cut, crash, whatever) the next session can
 * see exactly what finished and what did not.
 *
 * Usage:
 *   import { checkpoint } from "./progress.mjs";
 *   checkpoint("seed", "classes+sections done", "5 classes / 10 sections");
 */
import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LOG = path.join(ROOT, "scripts", "session-progress.log");

export function checkpoint(step, detail = "") {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] ${step}${detail ? " — " + detail : ""}\n`;
  try {
    appendFileSync(LOG, line);
    console.log(`  📝 ${ts} ${step}${detail ? " — " + detail : ""}`);
  } catch (e) {
    console.log(`  (checkpoint log unavailable: ${e.message})`);
  }
}

export function progressLogPath() {
  return LOG;
}
