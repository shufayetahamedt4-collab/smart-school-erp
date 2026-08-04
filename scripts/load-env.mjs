/**
 * Shared .env loader for scripts.
 * Reads `<project-root>/.env` into process.env (does not overwrite existing env).
 * Handles single-line values and multi-line double-quoted values
 * (e.g. a PEM private key pasted raw across several lines).
 *
 * Usage:
 *   import { loadEnv } from "./load-env.mjs";
 *   loadEnv();
 */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv() {
  const envPath = path.join(ROOT, ".env");
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m || process.env[m[1]] !== undefined) continue;
    let value = m[2];
    if (value.startsWith('"')) {
      const parts = [value.slice(1)];
      if (!parts[0].includes('"')) {
        // multi-line value: keep reading until the closing quote
        while (++i < lines.length && !lines[i].includes('"')) parts.push(lines[i]);
        if (i < lines.length) parts.push(lines[i].split('"')[0]);
      } else {
        parts[0] = parts[0].slice(0, parts[0].lastIndexOf('"'));
      }
      value = parts.join("\n");
    }
    process.env[m[1]] = value;
  }
}
