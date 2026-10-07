#!/usr/bin/env node
/**
 * Phase 3-pre — the COLLEGE ROUTE GUARD, proved OFFLINE.
 *
 * Purpose. `src/middleware.ts` returns `NextResponse.next()` for every `/api`
 * path (it gates by host and role only), so it physically cannot see a tenant's
 * `institutionType`. The ONLY thing that keeps a SCHOOL tenant out of college
 * data is the in-route call to `requireCollege()` (`src/lib/auth.ts`), which
 * resolves the tenant server-side and answers 403. A college route that forgets
 * that call does not crash — it silently serves another tenant shape's rows.
 * This script makes that failure loud, at verification time, before it can ship.
 *
 * What it proves (all STATIC — text analysis of the source tree):
 *
 *   1. CLASSIFICATION. Every top-level directory under `src/app/api` is either a
 *      listed college segment (`src/lib/college-routes.ts`, the single source of
 *      truth) or one of the frozen non-college directories below. A NEW,
 *      unclassified directory fails — so an author must decide, on purpose,
 *      whether the new surface is college-gated or not. A listed segment with no
 *      directory (a stale list) also fails.
 *
 *   2. THE GATE, per handler. For every `export async function GET|POST|PATCH|
 *      DELETE` in every route file under a college segment, in order:
 *        session first     (`getSession()` before the gate),
 *        the gate next     (`const gate = await requireCollege({ schoolId })` —
 *                           the TARGET tenant, never a raw cookie/body value),
 *        the gate is obeyed (`if (gate) return gate;`),
 *        and nothing that authorizes or touches data — `can()`, `writeGuard()`,
 *        `prisma.*`, `scopeWhere()`, `canAccessBranch()`, `resolveBranchId()`,
 *        `assertCanAccessBranch()` — appears BEFORE the gate.
 *
 *   3. NO MISPLACED COLLEGE ROUTE. A file under a NON-college directory may not
 *      call `requireCollege` or touch a college model (`prisma.department`,
 *      `.program`, `.programCourse`, `.course`). College access belongs in a
 *      listed segment, where check 2 guarantees the gate order.
 *
 * Checks 2 and 3 read COMMENT- AND STRING-MASKED source, never the raw text. A
 * comment is not code, and the college routes document their own guard order in
 * prose ("… before `can()` and every read") — scanning raw text would match the
 * documentation instead of the call and report a false failure.
 *
 *   node scripts/verify-college-routes.mjs
 *
 * What it CANNOT prove. This is a static check, not a runtime test. It reads the
 * source text, so it cannot tell you that `requireCollege()` actually answers 403
 * for a SCHOOL tenant — that is `scripts/verify-college-gate.mjs` (decision
 * table) plus the isolation harnesses (over HTTP, with a database). It also
 * cannot see a gate reached through a helper function, or an authorization call
 * spelled in a way not listed above; it is a guard against the *known* shapes of
 * the mistake, deliberately strict about those and honest about its limit. It
 * needs no database, no server and no network, so it carries no
 * `requireEmulator()` guard and runs on plain `node`.
 *
 * The frozen non-college inventory and this script's own token lists are the
 * verification side of the same convention as `scripts/nav-scope-snapshot.json`:
 * a list that must be updated deliberately when the tree changes, never silently.
 */

import { registerHooks } from "node:module";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension,
 * so this local, synchronous hook retries a failed relative specifier with `.ts`
 * appended — the same approach as `verify-college-gate.mjs`, scoped to this
 * process.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (error?.code === "ERR_MODULE_NOT_FOUND" && relative) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const { COLLEGE_API_SEGMENTS } = await import("../src/lib/college-routes.ts");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const API_DIR = join(ROOT, "src", "app", "api");

/**
 * Every NON-college top-level directory under `src/app/api`, frozen. A directory
 * that is neither listed here nor in `COLLEGE_API_SEGMENTS` is unclassified and
 * fails check 1 — which is the point: adding an API surface is a decision.
 */
const FROZEN_NON_COLLEGE_API_DIRS = [
  "academic-sessions", "admissions", "assignments", "assistant", "attendance",
  "auth", "books", "branches", "certificates", "chat", "class-sessions",
  "classes", "complaints", "exams", "fee-categories", "fee-templates", "fees",
  "gallery", "grading-scheme", "guardians", "health", "homework", "import",
  "leave-requests", "ledger", "marks", "meetings", "messages", "mode", "notices",
  "notifications", "onboarding", "parent", "payments", "plans", "public", "qr",
  "quizzes", "remarks", "resources", "routine-config", "routines", "schools",
  "sections", "settings", "staff", "stats", "student", "students", "subjects",
  "subscription", "subscriptions", "teachers", "timetable-slots", "uploads",
];

/** The HTTP handlers every route file may export, and must gate. */
const HANDLER_METHODS = ["GET", "POST", "PATCH", "DELETE", "PUT"];

/** The session read that must precede the gate. */
const SESSION_TOKEN = "getSession(";

/**
 * Calls that either decide authorization or touch data. None of them may appear
 * before `requireCollege()` in a college handler — earlier means the gate is not
 * first, which is exactly the bug this script exists to catch.
 */
const AFTER_GATE_TOKENS = [
  "can(",
  "writeGuard(",
  "prisma.",
  "scopeWhere(",
  "canAccessBranch(",
  "assertCanAccessBranch(",
  "resolveBranchId(",
];

/** A college model access — forbidden outside a listed college segment. */
const COLLEGE_MODEL_RE = /\bprisma\.(department|program|programCourse|course)\b/;

let failures = 0;
const ok = (msg) => console.log(`  ✅ ${msg}`);
const bad = (scope, msg) => {
  failures += 1;
  console.log(`  ❌ [${scope}] ${msg}`);
};

/* ------------------------------------------------------------------ helpers */

/** Is this path a directory? */
function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every `route.ts` under `dir`, recursively, as paths relative to the repo root. */
function routeFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...routeFilesUnder(full));
    else if (entry.isFile() && entry.name === "route.ts") out.push(full);
  }
  return out;
}

/** Every `.ts` file under `dir`, recursively. */
function tsFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...tsFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** 1-based line number of a character offset. */
const lineOf = (text, index) => text.slice(0, index).split("\n").length;

/**
 * Blank out comments and string literals, PRESERVING LENGTH (and newlines), so a
 * token search runs against code only while every index still maps onto the
 * original file for line reporting. Both `//` and `/* *\/` comments, and single,
 * double and template string literals, are masked.
 */
function maskCommentsAndStrings(text) {
  const out = text.split("");
  const blank = (i) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];

    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") blank(i++);
      continue;
    }
    if (ch === "/" && next === "*") {
      blank(i++);
      blank(i++);
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      blank(i++);
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") blank(i++);
        blank(i++);
      }
      blank(i++);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * The index of the `{` that closes the parenthesis group opening at `openIndex`
 * (which must be a `(`). Used to step over a handler's parameter list, whose type
 * annotations contain braces (`Promise<{ id: string }>`).
 */
function parenMatch(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The index of the `}` matching the `{` at `openIndex`, or -1. */
function braceMatch(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    const ch = text[i];
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Parse the exported HTTP handlers of a route file into `{ method, name, body,
 * bodyStart }`. The body runs from the `{` after the parameter list to its
 * matching `}`.
 */
function handlersOf(text) {
  const re = new RegExp(`export\\s+async\\s+function\\s+(${HANDLER_METHODS.join("|")})\\s*\\(`, "g");
  const found = [];
  let match;
  while ((match = re.exec(text))) {
    const parenOpen = match.index + match[0].length - 1;
    const parenClose = parenMatch(text, parenOpen);
    if (parenClose < 0) continue; // malformed; the file-level shape check will notice
    const braceOpen = text.indexOf("{", parenClose);
    if (braceOpen < 0) continue;
    const braceClose = braceMatch(text, braceOpen);
    const body = braceClose < 0 ? text.slice(braceOpen) : text.slice(braceOpen, braceClose + 1);
    found.push({ method: match[1], name: match[1], body, bodyStart: braceOpen });
  }
  return found;
}

const rel = (full) => full.slice(ROOT.length + 1).split("\\").join("/");

/* ------------------------------------------------------------------- check 1 */

console.log("=== Phase 3 college route guard (offline) ===");
console.log("\n1. classification — every src/app/api directory is classified");

const collegeSet = new Set(COLLEGE_API_SEGMENTS);
const frozenSet = new Set(FROZEN_NON_COLLEGE_API_DIRS);
{
  const topLevel = readdirSync(API_DIR).filter((name) => isDir(join(API_DIR, name)));
  const unclassified = topLevel.filter((name) => !collegeSet.has(name) && !frozenSet.has(name));
  const staleSegments = COLLEGE_API_SEGMENTS.filter((seg) => !topLevel.includes(seg));
  // A name listed both as college and as non-college is a contradiction in the lists.
  const contradictory = COLLEGE_API_SEGMENTS.filter((seg) => frozenSet.has(seg));

  if (unclassified.length) {
    bad(
      "classification",
      `unclassified src/app/api director${unclassified.length === 1 ? "y" : "ies"}: ${unclassified.join(", ")} — ` +
        `add it to COLLEGE_API_SEGMENTS (src/lib/college-routes.ts) if it is college-only, or to the frozen ` +
        `non-college list in this script if it is not`
    );
  }
  if (staleSegments.length) {
    bad("classification", `COLLEGE_API_SEGMENTS lists ${staleSegments.join(", ")} but there is no such directory under src/app/api`);
  }
  if (contradictory.length) {
    bad("classification", `${contradictory.join(", ")} is listed as BOTH a college segment and a frozen non-college directory`);
  }
  if (!unclassified.length && !staleSegments.length && !contradictory.length) {
    ok(
      `${topLevel.length} director${topLevel.length === 1 ? "y" : "ies"} classified: ` +
        `${COLLEGE_API_SEGMENTS.length} college (${COLLEGE_API_SEGMENTS.join(", ")}) + ` +
        `${FROZEN_NON_COLLEGE_API_DIRS.length} frozen non-college; no unclassified directory`
    );
  }
}

/* ------------------------------------------------------------------- check 2 */

console.log("\n2. the gate — requireCollege() after getSession() and before every authorization/data access");

const collegeRouteFiles = [];
for (const segment of COLLEGE_API_SEGMENTS) {
  const dir = join(API_DIR, segment);
  if (!isDir(dir)) continue;
  const files = routeFilesUnder(dir);
  if (!files.length) {
    bad("gate", `college segment "${segment}" has no route.ts — nothing to gate (a listed segment must have routes)`);
    continue;
  }
  collegeRouteFiles.push(...files);
}

let handlersChecked = 0;
{
  // Ordered: file, then handler, so the first failure names the exact site.
  search: for (const file of collegeRouteFiles.sort()) {
    const text = readFileSync(file, "utf8");
    const handlers = handlersOf(text);
    if (!handlers.length) {
      bad("gate", `${rel(file)} exports no GET/POST/PATCH/DELETE handler`);
      continue;
    }
    for (const handler of handlers) {
      handlersChecked += 1;
      const where = `${rel(file)} ${handler.name}`;
      // Code only: a comment mentioning `can()` is not a call to it.
      const body = maskCommentsAndStrings(handler.body);

      const gateCall = /const\s+(\w+)\s*=\s*await\s+requireCollege\s*\(([^)]*)\)/.exec(body);
      if (!gateCall) {
        bad("gate", `${where}: no \`const gate = await requireCollege(...)\` call — the gate is mandatory and may not be skipped`);
        break search;
      }
      const [, gateVar, gateArgs] = gateCall;
      const gateIndex = gateCall.index;

      // The gate must act on the TARGET tenant, not on a cookie or request body.
      if (!/\bschoolId\b/.test(gateArgs)) {
        bad("gate", `${where}: requireCollege(${gateArgs.trim()}) does not pass the target \`schoolId\` — the gate must resolve the TARGET tenant`);
        break search;
      }

      // The gate's return value must actually stop the handler.
      const obeyed = new RegExp(`if\\s*\\(\\s*${gateVar}\\s*\\)\\s*return\\s+${gateVar}\\s*;`).test(body);
      if (!obeyed) {
        bad("gate", `${where}: requireCollege() is assigned to \`${gateVar}\` but never obeyed (expected \`if (${gateVar}) return ${gateVar};\`)`);
        break search;
      }

      // Session must be read BEFORE the gate, so the gate can act on it.
      const sessionIndex = body.indexOf(SESSION_TOKEN);
      if (sessionIndex < 0) {
        bad("gate", `${where}: no \`getSession()\` call — a college handler must read the session before gating`);
        break search;
      }
      if (sessionIndex > gateIndex) {
        bad("gate", `${where}: requireCollege() is called BEFORE getSession() (line ${lineOf(text, handler.bodyStart + gateIndex)} vs ${lineOf(text, handler.bodyStart + sessionIndex)})`);
        break search;
      }

      // Nothing that authorizes or touches data may precede the gate.
      for (const token of AFTER_GATE_TOKENS) {
        const at = body.indexOf(token);
        if (at >= 0 && at < gateIndex) {
          bad(
            "gate",
            `${where}: \`${token}\` appears BEFORE requireCollege() (line ${lineOf(text, handler.bodyStart + at)} vs ` +
              `gate at line ${lineOf(text, handler.bodyStart + gateIndex)}) — the gate must be the FIRST authorization step`
          );
          break search;
        }
      }
    }
  }

  if (failures === 0) {
    ok(
      `${handlersChecked} handler(s) across ${collegeRouteFiles.length} route file(s): every one reads the session, then ` +
        `calls requireCollege({ schoolId }) and obeys it, before any can()/writeGuard()/prisma access`
    );
  }
}

/* ------------------------------------------------------------------- check 3 */

console.log("\n3. no misplaced college access — a non-college directory may not gate or touch a college model");

{
  const offenders = [];
  const topLevel = readdirSync(API_DIR).filter((name) => isDir(join(API_DIR, name)));
  for (const name of topLevel) {
    if (collegeSet.has(name)) continue;
    for (const file of tsFilesUnder(join(API_DIR, name))) {
      const text = readFileSync(file, "utf8");
      const code = maskCommentsAndStrings(text);
      const gateAt = code.indexOf("requireCollege(");
      const model = COLLEGE_MODEL_RE.exec(code);
      if (gateAt >= 0) offenders.push(`${rel(file)}:${lineOf(text, gateAt)} calls requireCollege()`);
      if (model) offenders.push(`${rel(file)}:${lineOf(text, model.index)} touches ${model[0]}`);
    }
  }
  if (offenders.length) {
    for (const o of offenders) bad("misplaced", o);
  } else {
    const scanned = topLevel.filter((n) => !collegeSet.has(n)).reduce((n, d) => n + tsFilesUnder(join(API_DIR, d)).length, 0);
    ok(`${scanned} file(s) under ${topLevel.length - collegeSet.size} non-college director(ies): none calls requireCollege() or touches a college model`);
  }
}

console.log(
  failures === 0
    ? `\n✅ COLLEGE ROUTE GUARD OK — ${collegeRouteFiles.length} college route file(s), ${handlersChecked} gated handler(s), no unclassified API directory`
    : `\n❌ ${failures} college-route failure(s)`
);
process.exit(failures === 0 ? 0 : 1);
