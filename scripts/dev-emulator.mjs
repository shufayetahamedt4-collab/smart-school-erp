#!/usr/bin/env node
/**
 * dev-emulator.mjs — start `next dev` wired to the LOCAL Firestore emulator.
 *
 * Cross-platform and dependency-free: it configures process.env and spawns the
 * child, instead of relying on shell `set`/`export` quoting.
 *
 * Why these are ASSIGNED (empty string) rather than deleted: Next.js loads
 * `.env` into the child but will NOT overwrite a variable it already inherits,
 * while it WILL fill in one that is absent. Deleting FIREBASE_CLIENT_EMAIL would
 * therefore let `.env` reinstate the live key; an empty string blocks that and is
 * falsy to the app.
 */
import { spawn } from "node:child_process";

process.env.FIRESTORE_EMULATOR_HOST = "127.0.0.1:8080";
process.env.FIREBASE_PROJECT_ID = "demo-ss-test";
process.env.FIREBASE_CLIENT_EMAIL = "";
process.env.FIREBASE_PRIVATE_KEY = "";
delete process.env.FIRESTORE_DATABASE_ID; // emulator uses the default database

const port = process.env.DEV_EMULATOR_PORT || "3000";
const extra = process.argv.slice(2);
const child = spawn("npx", ["next", "dev", "-p", port, ...extra], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
