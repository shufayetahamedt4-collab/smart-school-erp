// @ts-nocheck — runs under `bun test`; the project's tsc has no bun-types installed.
/**
 * Regression guard for the pre-warm lists in src/lib/route-data.ts.
 *
 * Every endpoint named in ROUTE_DATA or SECTOR_WARM is fetched by a
 * fire-and-forget `prefetch(...)` with NO query string — on hover, and for the
 * whole sector right after sign-in. So a warmed endpoint whose GET handler
 * *requires* a query parameter can only ever answer 400: the prefetch spends a
 * round trip to produce a red console error and warms nothing.
 *
 * That is exactly the bug `/api/attendance` and `/api/remarks` used to have
 * (`classId and date are required.`). This test makes the invariant explicit:
 *
 *   no warmed endpoint's GET handler may reject a parameter-free request.
 *
 * It is intentionally a static review of the GET handler source (no server, no
 * DB, no session): it looks for the "missing required query param -> 400" idiom.
 * A live behavioural test would need a valid session to reach the param check,
 * which the auth gate hides behind 401/403 — so the source shape is the honest
 * thing to assert on. The same detector is run against the two known-bad
 * endpoints at the bottom, proving it has teeth rather than passing vacuously.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const PROJECT_ROOT = path.resolve(import.meta.dir, "../../..");
const ROUTE_DATA_SRC = path.join(PROJECT_ROOT, "src/lib/route-data.ts");

/** Every `/api/...` literal in route-data.ts, with comments stripped first. */
function warmedEndpoints(): string[] {
  const src = fs.readFileSync(ROUTE_DATA_SRC, "utf8");
  const noComments = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => {
      const idx = line.indexOf("//");
      return idx === -1 ? line : line.slice(0, idx);
    })
    .join("\n");

  const paths = new Set<string>();
  for (const m of noComments.matchAll(/["'`](\/api\/[^"'`]+)["'`]/g)) {
    paths.add(m[1].split("?")[0]);
  }
  return [...paths].sort();
}

/** The source of the module's exported GET handler (top-level function). */
function getHandlerBody(file: string): string | null {
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  const start = lines.findIndex((l) => /^export async function GET\b/.test(l));
  if (start === -1) return null;
  let end = lines.findIndex((l, i) => i > start && /^\}/.test(l));
  if (end === -1) end = lines.length;
  return lines.slice(start, end + 1).join("\n");
}

/** The parenthesised condition of an `if (` starting at `from`. */
function conditionOf(line: string, from: number): string {
  let depth = 0;
  let out = "";
  for (let i = from + 3; i < line.length; i++) {
    const c = line[i];
    if (c === "(") depth++;
    else if (c === ")") {
      if (depth === 0) break;
      depth--;
    }
    out += c;
  }
  return out;
}

/**
 * True when the GET body rejects a request because a query parameter is absent.
 * Only *unconditional* param reads count: a `cond ? searchParams.get(...) : …`
 * belongs to a role branch (e.g. SUPER_ADMIN supplying ?schoolId=) that never
 * warms the endpoint, so keying on it would be a false positive.
 */
function requiresQueryParam(getBody: string): boolean {
  const lines = getBody.split("\n");

  const paramVars = new Set<string>();
  for (const line of lines) {
    const m = line.match(/(?:const|let)\s+(\w+)\s*=\s*(.+)/);
    if (!m) continue;
    const rhs = m[2];
    if (rhs.includes("?")) continue; // ternary → role-conditional, not required
    if (/\.get\(\s*["'`]/.test(rhs) || /\bqueryId\s*\(/.test(rhs)) paramVars.add(m[1]);
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ifIdx = line.indexOf("if (");
    if (ifIdx === -1) continue;

    const window = lines.slice(i, i + 3).join("\n");
    if (!/status:\s*400/.test(window)) continue;

    const cond = conditionOf(line, ifIdx);
    let negatesParam = [...paramVars].some((v) => new RegExp(`!\\s*${v}\\b`).test(cond));
    if (!negatesParam) negatesParam = /!\s*[^;()]*\.get\(/.test(cond);
    if (negatesParam) return true;
  }
  return false;
}

const endpoints = warmedEndpoints();

describe("route-data.ts warm lists", () => {
  test("every warmed endpoint has a GET handler that tolerates no query string", () => {
    expect(endpoints.length).toBeGreaterThan(0);
    const offenders: string[] = [];

    for (const apiPath of endpoints) {
      const file = path.join(PROJECT_ROOT, "src/app/api", apiPath.slice("/api/".length), "route.ts");
      if (!fs.existsSync(file)) {
        offenders.push(`${apiPath}: no route file at ${path.relative(PROJECT_ROOT, file)}`);
        continue;
      }
      const body = getHandlerBody(file);
      if (body === null) {
        offenders.push(`${apiPath}: no exported GET handler`);
        continue;
      }
      if (requiresQueryParam(body)) {
        offenders.push(`${apiPath}: GET rejects a parameter-free request (400)`);
      }
    }

    expect(offenders).toEqual([]);
  });

  test("the detector flags the known param-required endpoints (not vacuous)", () => {
    for (const apiPath of ["/api/attendance", "/api/remarks"]) {
      const file = path.join(PROJECT_ROOT, "src/app/api", apiPath.slice("/api/".length), "route.ts");
      const body = getHandlerBody(file)!;
      expect(requiresQueryParam(body)).toBe(true);
    }
  });
});
