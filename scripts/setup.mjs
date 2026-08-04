/**
 * One-command project setup for the Firebase edition.
 * Verifies Firebase credentials are configured, then seeds demo data.
 * Run:  npm run setup
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

console.log("=== Smart School ERP — Firebase Setup ===");

// Load .env if present (node doesn't auto-load it for scripts).
// Handles single-line values and multi-line double-quoted values
// (e.g. a PEM key pasted raw across several lines).
const envPath = path.join(ROOT, ".env");
if (existsSync(envPath)) {
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

if (!process.env.FIREBASE_PROJECT_ID) {
  console.error(
    "\n❌ Firebase is not configured yet.\n" +
      "   1. Create a Firebase project (https://console.firebase.google.com)\n" +
      "   2. Enable Firestore + Authentication\n" +
      "   3. Generate a service account key (Project settings → Service accounts → Generate new private key)\n" +
      "   4. Add these to .env:\n" +
      "      FIREBASE_PROJECT_ID=your-project-id\n" +
      "      FIREBASE_CLIENT_EMAIL=firebase-adminsdk-xxxx@your-project.iam.gserviceaccount.com\n" +
      "      FIREBASE_PRIVATE_KEY=\"-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n\"\n" +
      "      JWT_SECRET=change-me\n" +
      "      APP_URL=http://localhost:3000\n"
  );
  process.exit(1);
}

try {
  execSync("node scripts/seed.mjs", { cwd: ROOT, stdio: "inherit", env: process.env });
} catch {
  console.error("\nSeeding failed. Check your Firebase credentials in .env");
  process.exit(1);
}

console.log("\n=== Setup complete! Run `npm run dev` and open http://localhost:3000 ===");
