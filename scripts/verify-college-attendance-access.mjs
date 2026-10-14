#!/usr/bin/env node
/**
 * Phase 8 ca-0 — the college ATTENDANCE allow-list, proved OFFLINE.
 *
 * `src/lib/college-attendance-access.ts` is the ONE place that decides who may
 * READ and who may MARK a college attendance session (docs/COLLEGE-DECISIONS.md
 * §24.8 D-CA-4, §25 D-8P-5; owner's answer Q8). It follows the results/fees
 * pattern: a strict allow-list, stated once, consumed by every caller — and it is
 * deliberately narrower than the school's `attendanceMarks` module, which would
 * admit a TEACHER (`entry`), a GUARDIAN (`view`) and a STUDENT (`viewOwn`).
 *
 * This verifier IMPORTS the module for real (`registerHooks`, the
 * `verify-college-gate.mjs` trick) and pins the tree around it:
 *
 *   1. PURITY — the module declares no import/require, so the ca-3 API handlers
 *      (server) and the ca-4 register screen (client) can share the same rule.
 *   2. THE ALLOW-LISTS — write = the three admin-level roles; read = the same
 *      plus a read-only REGISTRAR; no ACCOUNTANT (attendance is not money).
 *   3. THE TRUTH TABLE — every role × both directions, plus raw junk values.
 *   4. WHY IT EXISTS — the school's module WOULD admit TEACHER/GUARDIAN/STUDENT;
 *      this rule refuses all three (proved against `permissions.ts`).
 *   5. THE REFUSALS — the two sentences a caller renders.
 *   6. SCOPE — no consumer yet and no school path touched. ca-0 pinned that
 *      db.ts carried no `courseAttendance` collection; ca-2 (2026-10-14) added
 *      it, so that pin is REMOVED here with the change that owns it (§28), and
 *      what stays is the boundary that matters: this rule still has no consumer
 *      and the school's own attendance path still never reaches the college
 *      register (ca-3/ca-4 own the consumers).
 *
 *   node scripts/verify-college-attendance-access.mjs
 *
 * Needs no database, no server and no network, so it carries no `requireEmulator()`
 * guard and runs on plain `node`.
 */

import { registerHooks } from "node:module";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension,
 * so this local, synchronous hook retries a failed relative specifier with `.ts`
 * appended — the same approach as the sibling offline verifiers, scoped to this
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ACCESS_URL = new URL("../src/lib/college-attendance-access.ts", import.meta.url);
const accessSource = readFileSync(ACCESS_URL, "utf8");

const access = await import(ACCESS_URL.href);
const {
  canReadCollegeAttendance,
  canWriteCollegeAttendance,
  COLLEGE_ATTENDANCE_READ_ROLES,
  COLLEGE_ATTENDANCE_WRITE_ROLES,
  COLLEGE_ATTENDANCE_READ_REFUSAL,
  COLLEGE_ATTENDANCE_WRITE_REFUSAL,
} = access;

// The school's own matrix — imported so "why this module exists" is a MEASURED
// claim, not a comment.
const { can } = await import("../src/lib/permissions.ts");

/**
 * Blank out comments and string literals, PRESERVING LENGTH, so a token search
 * runs against code only — the module documents itself in prose and its header
 * names other files.
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

const accessCode = maskCommentsAndStrings(accessSource);

/** Every file under `src/` whose text names the module (excluding the module itself). */
function findConsumers() {
  const hits = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry.name) && !full.endsWith("college-attendance-access.ts")) {
        if (readFileSync(full, "utf8").includes("college-attendance-access")) {
          hits.push(full.slice(ROOT.length + 1).replace(/\\/g, "/"));
        }
      }
    }
  };
  walk(resolve(ROOT, "src"));
  return hits;
}

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};

console.log("=== Phase 8 ca-0 — college attendance access (offline) ===");

/* ------------------------------------------------------------------ 1. purity */

console.log("\n1. the module is pure, and it states its own rule");
{
  check(
    "college-attendance-access.ts declares no import/require",
    !/\bimport\b|\brequire\s*\(/.test(accessCode)
  );
  check(
    "no import at all — prisma/next/server cannot reach a client bundle through it",
    !/from\s+["']/.test(accessCode)
  );
  check(
    "both predicates are functions and both lists are read-only arrays",
    typeof canReadCollegeAttendance === "function" &&
      typeof canWriteCollegeAttendance === "function" &&
      Array.isArray(COLLEGE_ATTENDANCE_WRITE_ROLES) &&
      Array.isArray(COLLEGE_ATTENDANCE_READ_ROLES)
  );
  check(
    "the rule does not delegate to the school's attendanceMarks module",
    !/attendanceMarks/.test(accessCode)
  );
  check(
    "both refusals are non-empty, distinct sentences",
    typeof COLLEGE_ATTENDANCE_READ_REFUSAL === "string" &&
      COLLEGE_ATTENDANCE_READ_REFUSAL.length > 0 &&
      typeof COLLEGE_ATTENDANCE_WRITE_REFUSAL === "string" &&
      COLLEGE_ATTENDANCE_WRITE_REFUSAL.length > 0 &&
      COLLEGE_ATTENDANCE_READ_REFUSAL !== COLLEGE_ATTENDANCE_WRITE_REFUSAL
  );
}

/* -------------------------------------------------------------- 2. allow-lists */

console.log("\n2. the allow-lists — admin-level write, plus a read-only REGISTRAR");
{
  const wantWrite = ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN"];
  const wantRead = [...wantWrite, "REGISTRAR"];
  check(
    "WRITE is exactly the three admin-level roles, in order",
    JSON.stringify([...COLLEGE_ATTENDANCE_WRITE_ROLES]) === JSON.stringify(wantWrite),
    COLLEGE_ATTENDANCE_WRITE_ROLES.join(", ")
  );
  check(
    "READ is exactly the writers plus the REGISTRAR",
    JSON.stringify([...COLLEGE_ATTENDANCE_READ_ROLES]) === JSON.stringify(wantRead),
    COLLEGE_ATTENDANCE_READ_ROLES.join(", ")
  );
  check(
    "no ACCOUNTANT in either direction — attendance is not money, so the fee rule does not transfer",
    !COLLEGE_ATTENDANCE_WRITE_ROLES.includes("ACCOUNTANT") &&
      !COLLEGE_ATTENDANCE_READ_ROLES.includes("ACCOUNTANT")
  );
}

/* ------------------------------------------------------------- 3. truth table */

console.log("\n3. every role × both directions (and raw junk)");
{
  const ALLOWED_WRITE = ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN"];
  const ALLOWED_READ = [...ALLOWED_WRITE, "REGISTRAR"];
  const DENIED = ["TEACHER", "GUARDIAN", "STUDENT", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"];

  let writeLeak = null;
  for (const role of ALLOWED_WRITE) if (!canWriteCollegeAttendance(role)) writeLeak = `denied ${role}`;
  for (const role of [...DENIED, "REGISTRAR"]) {
    if (canWriteCollegeAttendance(role)) writeLeak = `allowed ${role}`;
  }
  for (const raw of [undefined, null, "", "  ", "NOT_A_ROLE", 0, {}, [], "school_admin", "Registrar"]) {
    if (canWriteCollegeAttendance(raw)) writeLeak = `allowed ${JSON.stringify(raw)}`;
  }
  check(
    `WRITE truth table holds (${ALLOWED_WRITE.length} allowed, ${DENIED.length + 1} roles + 10 raw values denied)`,
    writeLeak === null,
    writeLeak || ""
  );

  let readLeak = null;
  for (const role of ALLOWED_READ) if (!canReadCollegeAttendance(role)) readLeak = `denied ${role}`;
  for (const role of DENIED) if (canReadCollegeAttendance(role)) readLeak = `allowed ${role}`;
  for (const raw of [undefined, null, "", "  ", "NOT_A_ROLE", 0, {}, [], "school_admin", "registrar"]) {
    if (canReadCollegeAttendance(raw)) readLeak = `allowed ${JSON.stringify(raw)}`;
  }
  check(
    `READ truth table holds (${ALLOWED_READ.length} allowed, ${DENIED.length} roles + 10 raw values denied)`,
    readLeak === null,
    readLeak || ""
  );
}

/* ------------------------------------------------------- 4. the hole it closes */

console.log("\n4. why it exists — narrower than the school's attendanceMarks module");
{
  // Measured, not asserted: the module the college routes must NOT reuse admits
  // exactly the roles the ruling keeps out.
  check(
    "the school module would admit a TEACHER marker (entry), a GUARDIAN reader (view) and a STUDENT (viewOwn)",
    can("TEACHER", "attendanceMarks", "entry") === true &&
      can("GUARDIAN", "attendanceMarks", "view") === true &&
      can("STUDENT", "attendanceMarks", "viewOwn") === true
  );
  check(
    "this rule refuses all three, in both directions",
    !canWriteCollegeAttendance("TEACHER") &&
      !canReadCollegeAttendance("TEACHER") &&
      !canWriteCollegeAttendance("GUARDIAN") &&
      !canReadCollegeAttendance("GUARDIAN") &&
      !canWriteCollegeAttendance("STUDENT") &&
      !canReadCollegeAttendance("STUDENT")
  );
  // The registrar's v1 access is READ-only — the results/fees precedent.
  check(
    "the REGISTRAR reads but may not mark",
    canReadCollegeAttendance("REGISTRAR") && !canWriteCollegeAttendance("REGISTRAR")
  );
}

/* ------------------------------------------------------------- 5. the refusals */

console.log("\n5. the refusals name who may act");
{
  check(
    "the READ refusal names the administration and the registrar",
    /administration/.test(COLLEGE_ATTENDANCE_READ_REFUSAL) &&
      /registrar/i.test(COLLEGE_ATTENDANCE_READ_REFUSAL)
  );
  check(
    "the WRITE refusal names the administration and offers no other marker",
    /administration/.test(COLLEGE_ATTENDANCE_WRITE_REFUSAL) &&
      !/registrar/i.test(COLLEGE_ATTENDANCE_WRITE_REFUSAL)
  );
}

/* ---------------------------------------------------------------- 6. the scope */

console.log("\n6. scope — no consumer, and no school path touched (ca-2 removed ca-0's db pin)");
{
  const consumers = findConsumers();
  check(
    "no route, page or lib file consumes the rule yet (ca-3/ca-4 own the consumers; add them HERE deliberately)",
    consumers.length === 0,
    consumers.join(", ") || "the rule exists alone, exactly as ca-0 requires"
  );

  const schoolRoute = readFileSync(resolve(ROOT, "src/app/api/attendance/route.ts"), "utf8");
  check(
    "the school's own attendance route is untouched (no college model, no college rule)",
    !/college-attendance-access|courseAttendance/.test(schoolRoute)
  );

  // ca-0's "db.ts carries no courseAttendance" pin was ca-2's to remove, and
  // ca-2 removed it: db.ts now carries the model in COLS/RELS and through the
  // shim — see §28. The collection's own shape is proved by the data proofs
  // (verify-college-fees-data / verify-college-results-data, which drop it by
  // name) and by the route guard's COLLEGE_MODEL_RE, not asserted again here.
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ college attendance access (ca-0) verification FAILED — ${failures} of ${checks} check(s).`);
  process.exit(1);
}
console.log(`✅ college attendance access (ca-0) verification PASSED — ${checks} checks.`);
