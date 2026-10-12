#!/usr/bin/env node
/**
 * pilot-fix-1 — the pilot hardening guards, proved.
 *
 * Six fixes, each with an offline pin and, where the claim is about behaviour
 * rather than text, a live check:
 *
 *   1. JWT_SECRET fail-closed ........... a deployment with no JWT_SECRET must
 *      not sign or accept a session with the built-in development secret.
 *   2. Payment webhook / mock-complete .. fail closed on a deployment.
 *   3. Guardian/student self-pay ........ refused server-side; the Parents App is
 *      read-only, so no orphan PENDING intent is created.
 *   4. Demo accounts card ............... resolved on the server, empty on a
 *      deployment, still present in dev.
 *   5. Onboarding admin password ........ explicit and 8+ characters on a
 *      deployment; no built-in default.
 *   6. Bare-host roles ................. BRANCH_ADMIN and REGISTRAR reach
 *      /dashboard on the host production actually serves.
 *
 * The offline half imports the pure decision module directly (the same
 * `registerHooks` trick `verify-college-gate.mjs` uses) so the checks are against
 * real behaviour, not a regex that mirrors it. The remaining offline checks are
 * source pins: each names the exact line that must be true, and every one of them
 * has a documented mutation that makes it fail
 * (docs/PILOT-FIX-1.md, "Mutation proofs").
 *
 * Usage:
 *   SMOKE_PORT=3000 node scripts/verify-pilot-hardening.mjs
 *   node scripts/verify-pilot-hardening.mjs --offline          # skip the live half
 *   PILOT_PROD_URL=http://127.0.0.1:3101 node scripts/verify-pilot-hardening.mjs
 *     ... the production-mode probe (see the item-1 block): /api/health, a
 *     signed-with-the-dev-secret cookie, and the sign-in refusal. It needs a
 *     server started with NODE_ENV=production and NO JWT_SECRET; when it is not
 *     set the probe reports SKIP and the offline checks still run.
 *
 * The live half is guarded (`requireEmulator()`): it writes two throwaway users
 * into the demo school and deletes them again.
 */

import { registerHooks } from "node:module";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { createHmac } from "node:crypto";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/* ------------------------------------------------------------------ harness */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ARGS = process.argv.slice(2);
const OFFLINE_ONLY = ARGS.includes("--offline");

let checks = 0;
let failures = 0;
const ok = (msg) => {
  checks += 1;
  console.log(`  ✅ ${msg}`);
};
const bad = (scope, msg) => {
  checks += 1;
  failures += 1;
  console.log(`  ❌ [${scope}] ${msg}`);
};
const check = (scope, msg, condition, detail = "") =>
  condition ? ok(msg) : bad(scope, `${msg}${detail ? ` — ${detail}` : ""}`);

const read = (rel) => readFileSync(resolve(ROOT, rel), "utf8");

/** The line number of the first match, for a failure message that points at code. */
function lineOf(text, needle) {
  const idx = text.indexOf(needle);
  return idx === -1 ? -1 : text.slice(0, idx).split("\n").length;
}

/**
 * True only when BOTH anchors exist AND `a` comes first.
 *
 * Plain `lineOf(a) < lineOf(b)` silently PASSES when `a` is missing, because
 * `lineOf` answers -1 — which is precisely the shape the previous code had (no
 * limiter call at all). Every ordering check therefore goes through here: an
 * absent anchor is a failure, never a pass. The mutation battery for the p1b
 * checks found this: reverting `src/app/api/auth/login/route.ts` to HEAD left
 * "the login limit is read BEFORE any password work" passing vacuously.
 */
function before(text, a, b) {
  const ia = lineOf(text, a);
  const ib = lineOf(text, b);
  return ia !== -1 && ib !== -1 && ia < ib;
}

/*
 * The app compiles with bundler-style resolution; Node's ESM resolver wants the
 * extension. Retry a failed relative specifier with `.ts`, exactly as
 * verify-college-gate.mjs does.
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

const guards = await import("../src/lib/pilot-guards.ts");
const demo = await import("../src/lib/demo-accounts.ts");

const {
  isProductionEnv,
  sessionSecret,
  sessionSecretFatal,
  effectiveSessionSecret,
  DEV_SESSION_SECRET,
  MIN_ADMIN_PASSWORD,
  adminPasswordProblem,
  resolvedWizardAdminPassword,
  DEV_ONBOARDING_ADMIN_PASSWORD,
} = guards;

console.log("pilot-fix-1 hardening — offline decision table\n");

/* ------------------------------------------------------------------- item 1 */
console.log("1) JWT_SECRET fail-closed");

const PROD = { NODE_ENV: "production" };
const DEV = { NODE_ENV: "development" };
const EMU = { NODE_ENV: "production", FIRESTORE_EMULATOR_HOST: "127.0.0.1:8080" };

check("item1", "isProductionEnv: a production deployment is production", isProductionEnv(PROD) === true);
check("item1", "isProductionEnv: `next dev` is not production", isProductionEnv(DEV) === false);
check(
  "item1",
  "isProductionEnv: a production build against the local emulator is NOT production",
  isProductionEnv(EMU) === false
);
check("item1", "isProductionEnv: an undefined env is not production", isProductionEnv(undefined) === false);
check("item1", "isProductionEnv: NODE_ENV=test is not production", isProductionEnv({ NODE_ENV: "test" }) === false);

check(
  "item1",
  "sessionSecretFatal: production + no secret is fatal",
  sessionSecretFatal(PROD) === true
);
check("item1", "sessionSecretFatal: dev + no secret is NOT fatal", sessionSecretFatal(DEV) === false);
check(
  "item1",
  "sessionSecretFatal: emulator + no secret is NOT fatal",
  sessionSecretFatal(EMU) === false
);
check(
  "item1",
  "sessionSecretFatal: an explicit secret is never fatal",
  sessionSecretFatal({ NODE_ENV: "production", JWT_SECRET: "abc" }) === false
);
check(
  "item1",
  "sessionSecretFatal: a whitespace-only secret counts as NO secret",
  sessionSecretFatal({ NODE_ENV: "production", JWT_SECRET: "   " }) === true
);

check(
  "item1",
  "effectiveSessionSecret: production + no secret resolves to null (fail closed)",
  effectiveSessionSecret(PROD) === null
);
check(
  "item1",
  "effectiveSessionSecret: dev + no secret still resolves to the development secret",
  effectiveSessionSecret(DEV) === DEV_SESSION_SECRET
);
check(
  "item1",
  "effectiveSessionSecret: the emulator harness keeps working",
  effectiveSessionSecret(EMU) === DEV_SESSION_SECRET
);
check(
  "item1",
  "effectiveSessionSecret: an explicit secret wins",
  effectiveSessionSecret({ NODE_ENV: "production", JWT_SECRET: "s3cret" }) === "s3cret"
);
check(
  "item1",
  "a deployment NEVER resolves to the built-in development secret",
  effectiveSessionSecret(PROD) !== DEV_SESSION_SECRET && effectiveSessionSecret(PROD) === null
);

const authSrc = read("src/lib/auth.ts");
const mwSrc = read("src/middleware.ts");
const loginSrc = read("src/app/api/auth/login/route.ts");

check(
  "item1",
  "auth.ts resolves its signing key through effectiveSessionSecret",
  authSrc.includes("effectiveSessionSecret(process.env)")
);
check(
  "item1",
  "auth.ts refuses to SIGN without a key",
  /const key = secretKey\(\);\s*\n\s*\/\/[^\n]*\n\s*if \(!key\) throw new Error\(SESSION_SECRET_MISSING\)/.test(authSrc) ||
    /if \(!key\) throw new Error\(SESSION_SECRET_MISSING\)/.test(authSrc)
);
check(
  "item1",
  "auth.ts refuses to VERIFY without a key (returns null, never the dev secret)",
  /if \(!key\) return null;/.test(authSrc)
);
check(
  "item1",
  "the hard-coded fallback secret is gone from auth.ts",
  !authSrc.includes("smart-school-erp-secret-change-me-in-production")
);
check(
  "item1",
  "the hard-coded fallback secret is gone from middleware.ts",
  !mwSrc.includes("smart-school-erp-secret-change-me-in-production")
);
check(
  "item1",
  "middleware treats a cookie as anonymous when there is no key",
  /const key = secretKey\(\);\s*\n\s*if \(key\) \{/.test(mwSrc)
);
check(
  "item1",
  "the sign-in route refuses with a clear 503 when the secret is missing",
  loginSrc.includes("sessionSecretFatal(process.env)") && loginSrc.includes("status: 503")
);
check(
  "item1",
  "the refusal is checked BEFORE any password work",
  lineOf(loginSrc, "sessionSecretFatal(process.env)") < lineOf(loginSrc, "bcrypt.compareSync"),
  `secret at line ${lineOf(loginSrc, "sessionSecretFatal(process.env)")}, bcrypt at ${lineOf(loginSrc, "bcrypt.compareSync")}`
);
check(
  "item1",
  "the secret is read at CALL time, never at module scope (next build needs no secrets)",
  !/^const\s+\w+\s*=\s*effectiveSessionSecret\(/m.test(authSrc) && !/^const secret\s*=/m.test(mwSrc)
);

/* ------------------------------------------------------------------- item 2 */
console.log("\n2) Payment webhook and mock-complete fail closed in production");

const webhookSrc = read("src/app/api/payments/webhook/[provider]/route.ts");
const mockSrc = read("src/app/api/payments/mock-complete/route.ts");

check(
  "item2",
  "the webhook refuses when PAYMENT_WEBHOOK_SECRET is unset on a deployment",
  webhookSrc.includes("!secret && isProductionEnv(process.env)")
);
check(
  "item2",
  "the unsigned-acceptance branch is now unreachable in production",
  /if \(!secret\) return true; \/\/ mock\/sandbox mode — never reachable in production/.test(webhookSrc)
);
check(
  "item2",
  "the webhook refusal is a clean 503 with a reason",
  webhookSrc.includes("The payment webhook is not configured on this deployment.") && webhookSrc.includes("status: 503")
);
check(
  "item2",
  "mock-complete refuses on a deployment REGARDLESS of the secret",
  /if \(isProductionEnv\(process\.env\)\) \{\s*\n\s*return NextResponse\.json\(\{ error: "Disabled in production" \}, \{ status: 403 \}\);\s*\n\s*\}/.test(
    mockSrc
  )
);
check(
  "item2",
  "mock-complete keeps refusing while a webhook secret is set (dev)",
  mockSrc.includes("if (process.env.PAYMENT_WEBHOOK_SECRET) {")
);

/* ------------------------------------------------------------------- item 3 */
console.log("\n3) Guardian/student self-pay is refused server-side");

const paymentsLib = read("src/lib/payments.ts");
const paymentsRoute = read("src/app/api/payments/route.ts");
const parentFees = read("src/app/parent/fees/page.tsx");

check(
  "item3",
  "the refusal reads the live gateway list, not a hard-coded rule",
  paymentsLib.includes("export function liveGatewayMethods()")
);
check(
  "item3",
  "today no gateway is live, so the list is empty by construction",
  paymentsLib.includes("gatewayMethods().filter((method) => PROVIDERS[method].live)")
);
check("item3", "one shared message for the family", paymentsLib.includes("Online payment is not available."));
check(
  "item3",
  "POST /api/payments refuses a self-service role before writing an intent",
  /isSelfServiceRole\(session\.role\)/.test(paymentsRoute) &&
    paymentsRoute.includes("ONLINE_PAYMENT_UNAVAILABLE")
);
check(
  "item3",
  "the guardian refusal happens BEFORE createPaymentIntent",
  lineOf(paymentsRoute, "ONLINE_PAYMENT_UNAVAILABLE") < lineOf(paymentsRoute, "createPaymentIntent("),
  `refusal line ${lineOf(paymentsRoute, "ONLINE_PAYMENT_UNAVAILABLE")}, intent line ${lineOf(paymentsRoute, "createPaymentIntent(")}`
);
check(
  "item3",
  "mock-complete refuses a self-service role too",
  /isSelfServiceRole\(session\.role\) && liveGatewayMethods\(\)\.length === 0/.test(mockSrc)
);
check("item3", "the Parents App has no Pay button", !parentFees.includes("startPay"));
check(
  "item3",
  "the Parents App no longer CALLS /api/payments (only the comment names it)",
  !/api\(\s*["`]\/api\/payments/.test(parentFees),
  "found an api(\"/api/payments… call site"
);
check(
  "item3",
  "the Parents App no longer completes an intent for a family",
  !/api\(\s*["`]\/api\/payments\/mock-complete/.test(parentFees),
  "found an api(\"/api/payments/mock-complete… call site"
);
check(
  "item3",
  "the Parents App states the office-only policy",
  parentFees.includes("Online payment is not available")
);
check(
  "item3",
  "the staff reconcile path is untouched (PATCH still confirms a BANK entry)",
  paymentsRoute.includes("export async function PATCH") &&
    paymentsRoute.includes("const { confirmPayment } = await import(\"@/lib/ledger\")")
);

/* ------------------------------------------------------------------- item 4 */
console.log("\n4) The demo-account card is server-resolved and gone in production");

check(
  "item4",
  "demoAccountsFor: a deployment gets NO demo accounts",
  demo.demoAccountsFor(PROD).length === 0
);
check("item4", "demoAccountsFor: dev still gets the four seeded logins", demo.demoAccountsFor(DEV).length === 4);
check(
  "item4",
  "demoAccountsFor: the emulator harness still gets them",
  demo.demoAccountsFor(EMU).length === 4
);
check(
  "item4",
  "the seeded list is unchanged (the four demo identities)",
  demo.DEMO_ACCOUNTS.map((d) => d.id).join(",") ===
    "admin@smartschool.com,principal@sunrise.edu,teacher@sunrise.edu,guardian1@demo.com"
);
const loginFormSrc = read("src/components/LoginForm.tsx");
check(
  "item4",
  "the CLIENT sign-in component names no demo account",
  !loginFormSrc.includes("@smartschool.com") && !loginFormSrc.includes("guardian1@demo.com")
);
check(
  "item4",
  "the client component takes the list as a prop",
  /demoAccounts\?: DemoAccount\[\]/.test(loginFormSrc) && loginFormSrc.includes("const demos = demoAccounts.filter(")
);
const loginPageSrc = read("src/app/login/page.tsx");
check(
  "item4",
  "the sign-in PAGE resolves the list on the server",
  loginPageSrc.includes("demoAccountsFor(process.env)")
);
for (const [needle, label] of [
  ["<SignIn hub demoAccounts={demoAccounts} />", "the hub shape forwards the list"],
  ["<SignIn sector={sector.key} demoAccounts={demoAccounts} />", "the sector shape forwards the list"],
]) {
  check("item4", label, loginPageSrc.includes(needle));
}

/* ------------------------------------------------------------------- item 5 */
console.log("\n5) A new tenant's admin password is explicit and 8+ characters");

check("item5", "the minimum is 8 characters", MIN_ADMIN_PASSWORD === 8);
check(
  "item5",
  "production: an absent password is refused",
  adminPasswordProblem(PROD, "") !== null && adminPasswordProblem(PROD, undefined) !== null
);
check("item5", "production: 7 characters are refused", adminPasswordProblem(PROD, "1234567") !== null);
check("item5", "production: exactly 8 characters are accepted", adminPasswordProblem(PROD, "12345678") === null);
check("item5", "dev: a short password is still allowed (harness unchanged)", adminPasswordProblem(DEV, "x") === null);
check(
  "item5",
  "dev: an omitted password still resolves to the development default",
  resolvedWizardAdminPassword(DEV, undefined).password === DEV_ONBOARDING_ADMIN_PASSWORD
);
check(
  "item5",
  "production: an omitted password is NOT resolved to the development default",
  resolvedWizardAdminPassword(PROD, undefined).ok === false
);
check(
  "item5",
  "production: the resolved password is the one the operator typed",
  resolvedWizardAdminPassword(PROD, "PilotAdmin@2026").password === "PilotAdmin@2026"
);
const onboardingSrc = read("src/app/api/onboarding/route.ts");
check(
  "item5",
  "the onboarding route has no built-in default left",
  !onboardingSrc.includes('|| "School@123"') && onboardingSrc.includes("resolvedWizardAdminPassword(process.env")
);
check(
  "item5",
  "the wizard decides the password BEFORE the transaction",
  lineOf(onboardingSrc, "resolvedWizardAdminPassword(process.env") <
    lineOf(onboardingSrc, "const result = (await prisma.$transaction")
);
check(
  "item5",
  "the wizard hashes the resolved password",
  onboardingSrc.includes("bcrypt.hashSync(adminPassword.password, 10)")
);
const schoolsRouteSrc = read("src/app/api/schools/route.ts");
check(
  "item5",
  "create-school enforces the strength rule",
  schoolsRouteSrc.includes("adminPasswordProblem(process.env, password)")
);
const adminSchoolsSrc = read("src/app/admin/schools/page.tsx");
check(
  "item5",
  "the Super Admin console has no built-in default password",
  !adminSchoolsSrc.includes('"School@123"')
);
check(
  "item5",
  "the console requires 8+ characters before it will create a school",
  (adminSchoolsSrc.match(/adminPassword\.trim\(\)\.length < 8/g) || []).length >= 1 &&
    adminSchoolsSrc.includes("form.adminPassword.trim().length >= 8")
);

/* ------------------------------------------------------------------- item 6 */
console.log("\n6) BRANCH_ADMIN and REGISTRAR reach /dashboard on the bare host");

const guardsBlock = mwSrc.slice(mwSrc.indexOf("const HUB_GUARDS"), mwSrc.indexOf("const HUB_HOME"));
const homeBlock = mwSrc.slice(mwSrc.indexOf("const HUB_HOME"), mwSrc.indexOf("const GUARDIAN_ENTRY"));
check(
  "item6",
  "HUB_GUARDS lists BRANCH_ADMIN for /dashboard",
  /prefix: "\/dashboard",\s*\n\s*roles: \[[^\]]*"BRANCH_ADMIN"/.test(guardsBlock)
);
check("item6", "HUB_GUARDS lists REGISTRAR for /dashboard", /roles: \[[^\]]*"REGISTRAR"/.test(guardsBlock));
check("item6", "HUB_HOME maps BRANCH_ADMIN to /dashboard", /BRANCH_ADMIN: "\/dashboard"/.test(homeBlock));
check("item6", "HUB_HOME maps REGISTRAR to /dashboard", /REGISTRAR: "\/dashboard"/.test(homeBlock));
check(
  "item6",
  "the four roles that already worked are still there",
  ["SCHOOL_ADMIN", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"].every((r) => guardsBlock.includes(`"${r}"`))
);
check(
  "item6",
  "the hub guards still do NOT hand /dashboard to a teacher or a guardian",
  !/prefix: "\/dashboard",\s*\n\s*roles: \[[^\]]*"(TEACHER|GUARDIAN)"/.test(guardsBlock)
);
const sectorsSrc = read("src/lib/sectors.ts");
check(
  "item6",
  "the school sector already carries both roles (app-host routing unchanged)",
  /roles: \["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR",/.test(sectorsSrc)
);

/* ======================================================================= p1b =
 * The pilot P1b items: the sign-in attempt limiter (A), the honest
 * forgot-password surface (B), the first-owner bootstrap (C) and the last
 * default/shared passwords (D). Same shape as above: real module imports for
 * everything that is a decision, source pins for what is wiring.
 * ========================================================================= */

const attempts = await import("../src/lib/login-attempts.ts");
const {
  ATTEMPT_WINDOW_MS,
  IDENTIFIER_LIMIT,
  IP_LIMIT,
  LOCKOUT_MESSAGE,
  normalizeIdentifier,
  counterKey,
  clientIp,
  counterOf,
  lockoutState,
  afterFailure,
  retryAfterSeconds,
} = attempts;

const bootstrap = await import("./bootstrap-super-admin.mjs");
const { bootstrapProblems } = bootstrap;

const teachersSrc = read("src/app/api/teachers/route.ts");
const teachersPageSrc = read("src/app/dashboard/teachers/page.tsx");
const importTeachersSrc = read("src/app/api/import/teachers/route.ts");
const writeSrc = read("src/lib/import/write.ts");
/** Comments quote the literals this stage removed; judge the CODE, not the prose. */
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** A `Headers`-shaped reader over a literal map, lower-cased like the real one. */
const headerReader = (map) => ({ get: (name) => map[String(name).toLowerCase()] ?? null });
/** A fixed clock: the decision table must not depend on when it runs. */
const T0 = 1_700_000_000_000;

console.log("\nP1b-A) sign-in attempt limiting — the pure decision table");

check("p1b-a", "the identifier limit is 8 failures per 15 minutes", IDENTIFIER_LIMIT.max === 8 && IDENTIFIER_LIMIT.windowMs === 15 * 60 * 1000, `${IDENTIFIER_LIMIT.max}/${IDENTIFIER_LIMIT.windowMs}`);
check("p1b-a", "the address limit is 30 failures per 15 minutes", IP_LIMIT.max === 30 && IP_LIMIT.windowMs === 15 * 60 * 1000, `${IP_LIMIT.max}/${IP_LIMIT.windowMs}`);
check("p1b-a", "the identifier limit is the tighter one (it is the primary defence)", IDENTIFIER_LIMIT.max < IP_LIMIT.max);
check("p1b-a", "one window length is exported and shared", ATTEMPT_WINDOW_MS === IDENTIFIER_LIMIT.windowMs && ATTEMPT_WINDOW_MS === IP_LIMIT.windowMs);

check("p1b-a", "an email identifier is trimmed and lower-cased", normalizeIdentifier("  Principal@Sunrise.EDU ") === "principal@sunrise.edu");
check("p1b-a", "a typed phone number collapses to one form", normalizeIdentifier("+880 1712-345678") === "+8801712345678");
check("p1b-a", "two spellings of the same phone are the same counter", normalizeIdentifier("+880 (1712) 345678") === normalizeIdentifier("+8801712345678"));
check("p1b-a", "an empty identifier normalises to nothing (it is never counted)", normalizeIdentifier("   ") === "" && normalizeIdentifier(undefined) === "");

const keyA = counterKey("login", "identifier", "principal@sunrise.edu");
check("p1b-a", "a counter key is stable for the same scope/kind/value", keyA === counterKey("login", "identifier", "principal@sunrise.edu"));
check("p1b-a", "a different scope, kind or value is a different counter", new Set([keyA, counterKey("qr", "identifier", "principal@sunrise.edu"), counterKey("login", "ip", "principal@sunrise.edu"), counterKey("login", "identifier", "other@sunrise.edu")]).size === 4);
check("p1b-a", "the stored key is a hash, not the identifier", /^rl:login:identifier:[0-9a-f]{64}$/.test(keyA) && !keyA.includes("principal"));
check("p1b-a", "the key is namespaced by the entry point", counterKey("qr", "identifier", "tok").startsWith("rl:qr:") && counterKey("forgot", "ip", "1.2.3.4").startsWith("rl:forgot:"));

check("p1b-a", "a single client address is used as-is", clientIp(headerReader({ "x-forwarded-for": "203.0.113.9" })) === "203.0.113.9");
check("p1b-a", "the LAST forwarded entry wins — a client cannot name itself", clientIp(headerReader({ "x-forwarded-for": "1.2.3.4, 198.51.100.7" })) === "198.51.100.7");
check("p1b-a", "junk to the left of the trusted hop is skipped", clientIp(headerReader({ "x-forwarded-for": "attacker, 1.2.3.4, 198.51.100.7" })) === "198.51.100.7");
check("p1b-a", "a bracketed IPv6 address is unwrapped", clientIp(headerReader({ "x-forwarded-for": "[::1]" })) === "::1");
check("p1b-a", "no header at all is one shared \"unknown\" bucket, never an exemption", clientIp(headerReader({})) === "unknown" && clientIp(null) === "unknown");
check("p1b-a", "an unusable header falls back to the same bucket", clientIp(headerReader({ "x-forwarded-for": "not-an-ip" })) === "unknown");
check("p1b-a", "an out-of-range IPv4 is not accepted as an address", clientIp(headerReader({ "x-forwarded-for": "999.1.1.1" })) === "unknown");

check("p1b-a", "no row means no counter", counterOf(null) === null && counterOf({}) === null);
check("p1b-a", "a junk row is not read as a live counter", counterOf({ value: { count: 0, firstAtMs: T0 } }) === null && counterOf({ value: { count: "x", firstAtMs: T0 } }) === null && counterOf({ value: "8" }) === null);
check("p1b-a", "a stored counter is read back exactly", counterOf({ value: { count: 3, firstAtMs: T0 } })?.count === 3);

check("p1b-a", "7 failures do not lock an identifier", lockoutState({ value: { count: 7, firstAtMs: T0 } }, T0 + 1000, IDENTIFIER_LIMIT).locked === false);
const locked8 = lockoutState({ value: { count: 8, firstAtMs: T0 } }, T0 + 1000, IDENTIFIER_LIMIT);
check("p1b-a", "the 8th failure locks the identifier", locked8.locked === true);
check("p1b-a", "a lockout reports how long to wait (Retry-After)", locked8.retryAfterSec > 0 && locked8.retryAfterSec <= 900, String(locked8.retryAfterSec));
check("p1b-a", "a window that has run out is NOT a lockout", lockoutState({ value: { count: 8, firstAtMs: T0 } }, T0 + ATTEMPT_WINDOW_MS, IDENTIFIER_LIMIT).locked === false);
check("p1b-a", "ten attempts from one address are not a lockout (the limit is 30)", lockoutState({ value: { count: 10, firstAtMs: T0 } }, T0 + 1, IP_LIMIT).locked === false);
check("p1b-a", "30 attempts from one address lock that address", lockoutState({ value: { count: 30, firstAtMs: T0 } }, T0 + 1, IP_LIMIT).locked === true);
check("p1b-a", "Retry-After is never negative", retryAfterSeconds({ count: 8, firstAtMs: T0 }, T0 + ATTEMPT_WINDOW_MS * 2, IDENTIFIER_LIMIT) === 0);

const firstFailure = afterFailure(null, T0, IDENTIFIER_LIMIT);
check("p1b-a", "the first failure opens a window at now with count 1", firstFailure.value.count === 1 && firstFailure.value.firstAtMs === T0 && firstFailure.locked === false);
check("p1b-a", "a failure inside a live window increments it", afterFailure({ value: { count: 2, firstAtMs: T0 } }, T0 + 5000, IDENTIFIER_LIMIT).value.count === 3);
check("p1b-a", "the failure that reaches the limit is itself the lockout", afterFailure({ value: { count: 7, firstAtMs: T0 } }, T0 + 5000, IDENTIFIER_LIMIT).locked === true);
const reopened = afterFailure({ value: { count: 8, firstAtMs: T0 } }, T0 + ATTEMPT_WINDOW_MS, IDENTIFIER_LIMIT);
check("p1b-a", "after the window runs out the next failure starts a NEW one", reopened.value.count === 1 && reopened.value.firstAtMs === T0 + ATTEMPT_WINDOW_MS && reopened.locked === false);
check("p1b-a", "an increment never rewrites the window's start", afterFailure({ value: { count: 4, firstAtMs: T0 } }, T0 + 900_000 - 1, IDENTIFIER_LIMIT).value.firstAtMs === T0);

check("p1b-a", "the refusal is ONE generic sentence", typeof LOCKOUT_MESSAGE === "string" && LOCKOUT_MESSAGE.length > 20 && LOCKOUT_MESSAGE.trim() === LOCKOUT_MESSAGE);
check("p1b-a", "the refusal names no account, identifier or address", !/@|http|school|admin|email/i.test(LOCKOUT_MESSAGE), LOCKOUT_MESSAGE);

console.log("\nP1b-A) the three entry points, wired");

const attemptsStoreSrc = read("src/lib/login-attempts-store.ts");
check("p1b-a", "the login route checks the limit", loginSrc.includes('checkAttemptLimit("login"'));
check(
  "p1b-a",
  "the login limit is read BEFORE any password work",
  before(loginSrc, 'checkAttemptLimit("login"', "bcrypt.compareSync"),
  `limit at line ${lineOf(loginSrc, 'checkAttemptLimit("login"')}, bcrypt at ${lineOf(loginSrc, "bcrypt.compareSync")}`
);
check("p1b-a", "ONLY a failed credential counts against the login identifier", /if \(!user \|\| !bcrypt\.compareSync[\s\S]{0,400}noteFailedAttempt\("login"/.test(loginSrc));
check("p1b-a", "a correct password clears the identifier's counter", loginSrc.includes('clearAttempts("login"'));
check("p1b-a", "the reset is driven by the check, so a clean sign-in pays nothing", /gate\.tracked[\s\S]{0,80}clearAttempts\("login"/.test(loginSrc));
check("p1b-a", "the login refusal is a 429 with a Retry-After header", /status: 429, headers: \{ "Retry-After"/.test(loginSrc));
check(
  "p1b-a",
  "the refusal is one shared helper, not three messages",
  (loginSrc.match(/error: LOCKOUT_MESSAGE/g) || []).length === 1 && (loginSrc.match(/return lockedOut\(/g) || []).length >= 3,
  `message sites ${(loginSrc.match(/error: LOCKOUT_MESSAGE/g) || []).length}, call sites ${(loginSrc.match(/return lockedOut\(/g) || []).length}`
);

const qrSrc = read("src/app/api/qr/verify/route.ts");
check("p1b-a", "the QR entry point is limited too", qrSrc.includes('checkAttemptLimit("qr"'));
check("p1b-a", "the QR limit is read before the token is looked up", before(qrSrc, 'checkAttemptLimit("qr"', "prisma.student.findUnique"), "limit must precede the lookup, and both must exist");
check("p1b-a", "an unknown token counts as a failed guess", /!student \|\| !student\.school[\s\S]{0,300}noteFailedAttempt\("qr"/.test(qrSrc));
check("p1b-a", "a wrong PIN counts as a failed guess", /!pinOk && !phoneOk[\s\S]{0,300}noteFailedAttempt\("qr"/.test(qrSrc));
check("p1b-a", "a valid slip clears the token's counter", qrSrc.includes('clearAttempts("qr"'));
check("p1b-a", "the QR refusal is the same 429 shape", qrSrc.includes("LOCKOUT_MESSAGE") && /status: 429, headers: \{ "Retry-After"/.test(qrSrc));

check("p1b-a", "the store writes through $guardedUpdate (a real transaction)", attemptsStoreSrc.includes('prisma.$guardedUpdate("setting"'));
check("p1b-a", "the store never uses the sequential callback form of $transaction for a counter", !/\$transaction\(/.test(attemptsStoreSrc));
/**
 * The BODY of one function, not "the file contains this word somewhere".
 *
 * The first version of the two pins below searched the whole file within a
 * character window, and both were satisfied by the PROSE above the function
 * (the doc comment names `$guardedUpdate`, and `keysFor` also mentions the
 * identifier kind) — the mutation battery caught it: replacing readCounter's
 * body with the memoised `findUnique` still passed. A pin must look at the code
 * it claims to pin.
 */
const bodyOf = (src, header, size = 700) => {
  const at = src.indexOf(header);
  return at === -1 ? "" : src.slice(at, at + size);
};
const readCounterBody = bodyOf(attemptsStoreSrc, "async function readCounter");
const clearAttemptsBody = bodyOf(attemptsStoreSrc, "export async function clearAttempts", 1500);
check(
  "p1b-a",
  "the check reads a counter WITHOUT the read memo",
  /prisma\.\$guardedUpdate/.test(readCounterBody) && !/\.findUnique\(/.test(readCounterBody) && /memo/i.test(attemptsStoreSrc),
  "readCounter must go through $guardedUpdate itself, not the memoised findUnique path"
);
check("p1b-a", "a store failure fails OPEN and says so with an [auth] line", (attemptsStoreSrc.match(/\[auth\]/g) || []).length >= 2 && /console\.error\("\[auth\][\s\S]{0,80}allowing this attempt/.test(attemptsStoreSrc));
check("p1b-a", "a failed WRITE is never counted as a lockout", /could not be written[\s\S]{0,120}locked: false, retryAfterSec: 0/.test(attemptsStoreSrc));
check(
  "p1b-a",
  "only the identifier counter is ever cleared (never another account's address counter)",
  /counterKey\(scope, "identifier"/.test(clearAttemptsBody) && !/counterKey\(scope, "ip"/.test(clearAttemptsBody)
);
check(
  "p1b-a",
  "clearing a counter uses the shim's key-resolving delete",
  /clearAttempts[\s\S]{0,800}setting\.deleteMany\(\{ where: \{ key \} \}\)/.test(attemptsStoreSrc),
  "the shim's single-row delete only understands where.id, so it would silently miss the row"
);
const settingsSrc = read("src/app/api/settings/route.ts");
check("p1b-a", "the counter rows can never be read out of /api/settings", /SECRET_SETTING_PREFIXES = \[[^\]]*"rl_"/.test(settingsSrc));

console.log("\nP1b-B) the forgot-password dead end is now honest");

check("p1b-b", "the sign-in form no longer offers a Forgot-password action", !stripComments(loginFormSrc).includes("Forgot password?") && !/setMode\(\s*["']forgot/.test(stripComments(loginFormSrc)));
check("p1b-b", "the client no longer calls the OTP endpoint", !/purpose:\s*["']forgot["']/.test(stripComments(loginFormSrc)) && !stripComments(loginFormSrc).toLowerCase().includes("send reset code"));
check("p1b-b", "a staff/teacher app says the truth: a school administrator can reset it", loginFormSrc.includes("Ask your school administrator to reset it."));
check("p1b-b", "the Parents App points at the QR code instead of promising an admin reset", /sectorKey === "guardian"[\s\S]{0,300}QR code on your child's ID card/.test(loginFormSrc));
check("p1b-b", "the sentence is chosen per app, not shown everywhere", /sectorKey === "super"/.test(loginFormSrc));
check("p1b-b", "the API branch itself is kept (no reset flow was rebuilt)", loginSrc.includes('purpose === "forgot"') && loginSrc.includes("forgotPassword("));
check("p1b-b", "no reset record is written when no email provider can deliver", loginSrc.includes("getEmailProvider()") && /provider\.live[\s\S]{0,400}return NextResponse.json\(generic\)/.test(loginSrc));
check(
  "p1b-b",
  "the provider gate runs BEFORE the reset code is minted",
  before(loginSrc, "provider.live", "codeHash: hashResetCode"),
  `gate at line ${lineOf(loginSrc, "provider.live")}, mint at ${lineOf(loginSrc, "codeHash: hashResetCode")}`
);

console.log("\nP1b-C) the first-owner bootstrap refuses everything it should");

const GOOD = "StrongPass@1";
const base = { env: { ALLOW_LIVE_FIRESTORE: "1" }, argv: ["--email", "owner@school.com"], email: "owner@school.com", password: GOOD, passwordSource: "env", superAdminExists: false, liveTarget: false };
check("p1b-c", "the emulator path with a strong password is allowed", bootstrapProblems(base).length === 0, JSON.stringify(bootstrapProblems(base)));
check("p1b-c", "refuses without ALLOW_LIVE_FIRESTORE=1", bootstrapProblems({ ...base, env: {} }).some((p) => /ALLOW_LIVE_FIRESTORE/.test(p)));
check("p1b-c", "a whitespace/other flag value is not an acknowledgement", bootstrapProblems({ ...base, env: { ALLOW_LIVE_FIRESTORE: "true" } }).length > 0);
check("p1b-c", "refuses a password given on the command line", bootstrapProblems({ ...base, argv: ["--email", "owner@school.com", "--password", GOOD] }).some((p) => /command line/.test(p)));
check("p1b-c", "refuses --password=… too", bootstrapProblems({ ...base, argv: ["--email", "owner@school.com", `--password=${GOOD}`] }).some((p) => /command line/.test(p)));
check("p1b-c", "refuses without --email", bootstrapProblems({ ...base, email: "" }).some((p) => /--email/.test(p)));
check("p1b-c", "refuses a malformed --email", bootstrapProblems({ ...base, email: "not-an-email" }).some((p) => /not a valid email/.test(p)));
check("p1b-c", "refuses with no password at all", bootstrapProblems({ ...base, password: "", passwordSource: "none" }).some((p) => /No password was provided/.test(p)));
check("p1b-c", "refuses a 7-character password", bootstrapProblems({ ...base, password: "1234567" }).some((p) => /at least 8 characters/.test(p)));
check("p1b-c", "accepts exactly 8 characters", bootstrapProblems({ ...base, password: "12345678" }).length === 0);
check("p1b-c", "refuses when a SUPER_ADMIN already exists", bootstrapProblems({ ...base, superAdminExists: true }).some((p) => /SUPER_ADMIN already exists/.test(p)));
const liveUnconfirmed = bootstrapProblems({ ...base, liveTarget: true, projectId: "amar-e-school", liveConfirmation: "" });
check("p1b-c", "refuses a LIVE target that has not been confirmed", liveUnconfirmed.some((p) => /LIVE Firestore/.test(p)));
check("p1b-c", "accepts a LIVE target confirmed by naming the project", bootstrapProblems({ ...base, liveTarget: true, projectId: "amar-e-school", liveConfirmation: "amar-e-school" }).length === 0);
check("p1b-c", "the refusal list is exhaustive, not first-error-wins", bootstrapProblems({ env: {}, argv: [], email: "", password: "", passwordSource: "none", superAdminExists: true, liveTarget: true }).length >= 4);
const selfFailures = bootstrap.selfTest();
check("p1b-c", "the script's own offline self-test passes", selfFailures.length === 0, selfFailures.join("; "));
const bootSrc = read("scripts/bootstrap-super-admin.mjs");
check("p1b-c", "the script prints only the email and the id", bootSrc.includes("SUPER_ADMIN created.") && bootSrc.includes("email:") && bootSrc.includes("user id:"));
const bootSummary = bootSrc.slice(bootSrc.indexOf("SUPER_ADMIN created."), bootSrc.indexOf("Keep the password in the deployment"));
check(
  "p1b-c",
  "the summary prints the email and the id, and never the password",
  bootSummary.includes("${email}") && bootSummary.includes("${id}") && !bootSummary.includes("${password}") && bootSummary.length > 40,
  bootSummary.trim().split("\n").join(" | ")
);
check("p1b-c", "the script hashes with the app's own bcrypt cost", bootSrc.includes("bcrypt.hashSync(password, 10)"));
check("p1b-c", "the script reuses the app's user-id rule", bootSrc.includes("userIdForEmail") && bootSrc.includes("createHash(\"sha1\")"));
check("p1b-c", "the script refuses before it opens a connection", before(bootSrc, "if (early.length)", "initializeApp("));
check("p1b-c", "the created user is the app's own SUPER_ADMIN shape", bootstrap.superAdminDoc({ email: "a@b.c", name: "n", passwordHash: "h" }).role === "SUPER_ADMIN");

console.log("\nP1b-D) the last default/shared passwords are gone (guardians stay REPORT-ONLY)");

check("p1b-d", "creating a teacher no longer falls back to a shared literal", !stripComments(teachersSrc).includes('|| "Teacher@123"') && !/Teacher@123/.test(stripComments(teachersSrc)));
check("p1b-d", "creating a teacher REQUIRES a password", teachersSrc.includes("password.length < MIN_ADMIN_PASSWORD") && teachersSrc.includes("TEACHER_PASSWORD_RULE"));
check("p1b-d", "the rule is the app's own new-account rule", teachersSrc.includes('from "@/lib/pilot-guards"') && teachersSrc.includes("MIN_ADMIN_PASSWORD"));
check("p1b-d", "the password that is stored is the one supplied", teachersSrc.includes("bcrypt.hashSync(password, 10)"));
check("p1b-d", "the teacher form starts empty (no default in the page either)", !teachersPageSrc.includes('password: "Teacher@123"') && /password: ""/.test(teachersPageSrc));
check("p1b-d", "the teacher form requires 8+ characters before it will submit", /password\.length < 8/.test(teachersPageSrc));
check("p1b-d", "the teacher import hashes a per-account secret", importTeachersSrc.includes("unusableTeacherPassword()"));
check("p1b-d", "the teacher import returns NO password at all", !importTeachersSrc.includes("defaultPassword") && importTeachersSrc.includes("passwordNotice"));
check("p1b-d", "the import result tells the school what to do instead", importTeachersSrc.includes("TEACHER_PASSWORD_NOTICE"));
check("p1b-d", "a provisioned teacher password is random bytes, not a literal", /export function unusableTeacherPassword[\s\S]{0,200}randomBytes\(24\)/.test(writeSrc));
const importExportPageSrc = read("src/app/dashboard/import-export/page.tsx");
check(
  "p1b-d",
  "the import console no longer prints a teacher default password",
  importExportPageSrc.includes("passwordNotice") && !/commit\.defaultPassword/.test(stripComments(importExportPageSrc)),
  "the console still renders commit.defaultPassword"
);
check("p1b-d", "no quoted Teacher@123 literal survives in any of the four files", ![
  importTeachersSrc,
  teachersSrc,
  teachersPageSrc,
  importExportPageSrc,
].some((src) => /"Teacher@123"/.test(stripComments(src))), "a quoted Teacher@123 literal is still assigned somewhere");
check("p1b-d", "the old default survived in NONE of the teacher paths (the live proof is behaviour below)", !/Teacher@123/.test(stripComments(importTeachersSrc)) && !/Teacher@123/.test(stripComments(teachersSrc)));

/* pilot P1c — guardians never have a password. The QR slip (token + PIN) is the
 * guardian's credential; every creation path mints a random, unusable hash.
 * (These replace the P1b REPORT-ONLY pins, which deliberately left the guardian
 * default in place.) */
const guardiansSrc = read("src/app/api/guardians/route.ts");
const enrollSrc = read("src/lib/enroll.ts");
const importStudentsSrc = read("src/app/api/import/students/route.ts");
const intakeSrc = read("src/app/api/admissions/intake/route.ts");
const studentsSrc = read("src/app/api/students/route.ts");
const intakeFormSrc = read("src/components/AdmissionIntakeForm.tsx");
const guardiansPageSrc = read("src/app/dashboard/guardians/page.tsx");
check("p1c", "POST /api/guardians mints an unusable password, never a default", guardiansSrc.includes("unusableGuardianPassword()") && !/Guardian@123/.test(stripComments(guardiansSrc)));
check("p1c", "POST /api/guardians ignores any password the caller sends", !stripComments(guardiansSrc).includes("password ||") && !stripComments(guardiansSrc).includes("name, password,"));
check("p1c", "the enrollment kernel has no shared guardian default left", !/Guardian@123/.test(stripComments(enrollSrc)) && !stripComments(enrollSrc).includes("DEFAULT_GUARDIAN_PASSWORD ="));
check("p1c", "the enrollment kernel mints an unusable guardian password", enrollSrc.includes("unusableGuardianPassword()"));
check("p1c", "the legacy student import mints an unusable guardian password", importStudentsSrc.includes("unusableGuardianPassword()") && !/Guardian@123/.test(stripComments(importStudentsSrc)));
check("p1c", "the legacy import response carries NO guardian password", !importStudentsSrc.includes("defaultGuardianPassword"));
check("p1c", "the legacy import still reports how many guardian logins it created", importStudentsSrc.includes("guardianLoginsCreated"));
check("p1c", "the desk intake sends no guardian password to the kernel", !stripComments(intakeSrc).includes("guard.password"));
check("p1c", "POST /api/students sends no guardian password to the kernel", !stripComments(studentsSrc).includes("guardianPassword"));
check("p1c", "the admission form has no initial-password field left", !intakeFormSrc.includes("guardianPassword") && !/Guardian@123/.test(stripComments(intakeFormSrc)));
check("p1c", "the guardians console has no password default left", !/Guardian@123/.test(stripComments(guardiansPageSrc)) && !guardiansPageSrc.includes("form.password"));
check("p1c", "the import console prints no guardian default password", !/defaultGuardianPassword/.test(stripComments(importExportPageSrc)));
check("p1c", "the bulk-import guardian path still refuses a shared password", writeSrc.includes("unusableGuardianPassword"));
check("p1c", "no quoted Guardian@123 literal survives in any writer or form", ![
  guardiansSrc,
  enrollSrc,
  importStudentsSrc,
  intakeSrc,
  studentsSrc,
  intakeFormSrc,
  guardiansPageSrc,
  importExportPageSrc,
].some((src) => /"Guardian@123"/.test(stripComments(src))), "a quoted Guardian@123 literal is still assigned somewhere");

/* ------------------------------------------------------------------- live */
const BASE = process.env.PILOT_BASE || `http://127.0.0.1:${process.env.SMOKE_PORT || 3000}`;
const PROD_URL = process.env.PILOT_PROD_URL || "";

async function reachable(url) {
  try {
    const r = await fetch(`${url}/login`, { signal: AbortSignal.timeout(5000) });
    return r.status > 0;
  } catch {
    return false;
  }
}

const sign = (payload, secret) => {
  const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(createHmac("sha256", secret).update(`${head}.${body}`).digest());
  return `${head}.${body}.${sig}`;
};

if (PROD_URL) {
  console.log("\n1/2/3-live) production-mode probe against", PROD_URL);
  const probes = await (async () => {
    const health = await fetch(`${PROD_URL}/api/health`, { signal: AbortSignal.timeout(15000) });
    const healthBody = await health.json().catch(() => null);
    const problems = healthBody?.data?.problems || [];
    const forged = sign(
      { id: "u_probe", name: "probe", email: "probe@test.local", role: "SCHOOL_ADMIN", schoolId: "s_probe", scope: null, branchId: null, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 },
      DEV_SESSION_SECRET
    );
    const dash = await fetch(`${PROD_URL}/dashboard`, { redirect: "manual", headers: { cookie: `ss_token=${forged}` }, signal: AbortSignal.timeout(20000) });
    const login = await fetch(`${PROD_URL}/api/auth/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: "probe@test.local", password: "whatever" }),
      signal: AbortSignal.timeout(20000),
    });
    const loginBody = await login.json().catch(() => null);
    const wh = await fetch(`${PROD_URL}/api/payments/webhook/bkash`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intentId: "pi_probe", status: "SUCCESS" }),
      signal: AbortSignal.timeout(20000),
    });
    const mock = await fetch(`${PROD_URL}/api/payments/mock-complete`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ intentId: "pi_probe" }),
      signal: AbortSignal.timeout(20000),
    });
    return { health: health.status, problems, dash, login: login.status, loginBody, wh: wh.status, mock: mock.status };
  })().catch((e) => ({ error: String(e?.message || e) }));

  if (probes.error) {
    bad("live", `production probe failed: ${probes.error}`);
  } else {
    // The middleware preserves the destination (?next=/dashboard); the claim is
    // the bounce to the sign-in screen, not the exact query string.
    const dashLocation = probes.dash.headers.get("location") || "";
    check(
      "live",
      "the dev-secret cookie is NOT accepted on a deployment without JWT_SECRET",
      probes.dash.status === 307 && (dashLocation === "/login" || dashLocation.startsWith("/login?")) && !dashLocation.startsWith("/dashboard"),
      `got ${probes.dash.status} ${dashLocation}`
    );
    check(
      "live",
      "sign-in answers 503 with the actionable JWT_SECRET message",
      probes.login === 503 && /JWT_SECRET/.test(String(probes.loginBody?.error || "")),
      `got ${probes.login} ${JSON.stringify(probes.loginBody)}`
    );
    check(
      "live",
      "/api/health reports the missing JWT_SECRET on a deployment",
      probes.problems.some((p) => /JWT_SECRET/.test(p)),
      JSON.stringify(probes.problems)
    );
    check("live", "an unsigned gateway webhook is refused on a deployment", probes.wh === 503, `got ${probes.wh}`);
    check("live", "mock-complete is refused on a deployment", probes.mock === 403, `got ${probes.mock}`);
  }
} else {
  console.log("\n1/2-live) production-mode probe: SKIP (set PILOT_PROD_URL to a server started");
  console.log("          with NODE_ENV=production and no JWT_SECRET to run it)");
}

if (OFFLINE_ONLY) {
  console.log("\nlive half: SKIP (--offline)");
} else if (!(await reachable(BASE))) {
  bad("live", `no server answered on ${BASE} — start the app (SMOKE_PORT) and re-run, or pass --offline`);
} else {
  const q = ["FIRESTORE_EMULATOR_HOST", "FIREBASE_PROJECT_ID"];
  const emulatorReady = q.every((k) => process.env[k]);
  if (!emulatorReady) {
    bad("live", "the emulator env is not set, so the live fixture cannot be created (run with FIRESTORE_EMULATOR_HOST + FIREBASE_PROJECT_ID)");
  } else {
    const { initializeApp } = await import("firebase-admin/app");
    const { getFirestore } = await import("firebase-admin/firestore");
    const bcrypt = (await import("bcryptjs")).default;
    const { createHash, randomBytes } = await import("node:crypto");
    initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID });
    const db = getFirestore();
    const sha1 = (s) => createHash("sha1").update(String(s)).digest("hex");
    const userDoc = (email) => `u_${sha1(String(email).toLowerCase())}`;
    const pw = () => randomBytes(12).toString("base64url");

    const login = async (email, password) => {
      const r = await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: email, password }),
      });
      return { status: r.status, body: await r.json().catch(() => null), cookie: (r.headers.get("set-cookie") || "").split(";")[0] };
    };
    const get = async (path, cookie) => {
      const r = await fetch(`${BASE}${path}`, { redirect: "manual", headers: cookie ? { cookie } : {} });
      return { status: r.status, location: r.headers.get("location") };
    };
    const post = async (path, cookie, body) => {
      const r = await fetch(`${BASE}${path}`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json().catch(() => null) };
    };

    const school = ((await db.collection("schools").where("slug", "==", "sunrise").limit(1).get()).docs[0] ||
      (await db.collection("schools").limit(1).get()).docs[0]);
    if (!school) {
      bad("live", "no school in the emulator — run `npm run setup` first");
    } else {
      const schoolId = school.id;
      let branchId = "zzph-branch";
      const existing = (await db.collection("branches").where("schoolId", "==", schoolId).limit(1).get()).docs[0];
      if (existing) branchId = existing.id;
      else await db.collection("branches").doc(branchId).set({ schoolId, name: "ZZ PH Campus", enabled: true, createdAt: new Date().toISOString() });

      const ROLES = ["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "TEACHER", "GUARDIAN"];
      const creds = {};
      const written = [];
      for (const role of ROLES) {
        const email = `zzph-${role.toLowerCase()}@test.local`;
        const password = pw();
        const id = userDoc(email);
        const data = { email, name: `ZZ PH ${role}`, role, schoolId, active: true, passwordHash: bcrypt.hashSync(password, 10) };
        if (role === "BRANCH_ADMIN") {
          data.scope = "BRANCH";
          data.branchId = branchId;
        }
        await db.collection("users").doc(id).set(data, { merge: true });
        written.push(id);
        creds[role] = { email, password, id };
      }
      await db.collection("teachers").doc(`t_${creds.TEACHER.id}`).set(
        { schoolId, userId: creds.TEACHER.id, name: "ZZ PH TEACHER", designation: "Teacher", createdAt: new Date().toISOString() },
        { merge: true }
      );
      const feeId = "zzph-fee";
      const studentId = "zzph-student";
      await db.collection("students").doc(studentId).set(
        { schoolId, name: "ZZ PH Student", roll: 9100, admissionNo: "ZZ-PH-001", status: "ACTIVE", active: true, guardianUserId: creds.GUARDIAN.id, guardianName: "ZZ PH Guardian" },
        { merge: true }
      );
      await db.collection("fees").doc(feeId).set({
        schoolId, studentId, title: "ZZ PH Fee", amount: 1000, paidAmount: 0, status: "PENDING", feeType: "MONTHLY", createdAt: new Date().toISOString(),
      });

      // The limiter's counters are DISPOSABLE state, and the suite's protocol wipes
      // the emulator between verifiers. This reproduces exactly that for the
      // counters alone, BEFORE this run's first sign-in, so the checks below always
      // measure from zero and a second run in a row (without a wipe) cannot inherit
      // a spent 30-per-address budget that would fail THIS run's own logins.
      // Nothing else is touched — no fixture, no user, no fee.
      const carriedCounters = (await db.collection("settings").get()).docs.filter((d) =>
        /^rl:(login|qr|forgot):/.test(String(d.data()?.key || ""))
      );
      await Promise.all(carriedCounters.map((d) => d.ref.delete()));

      try {
        console.log("\n6-live) the role table on the bare host");
        const expected = {
          SCHOOL_ADMIN: "200",
          ACCOUNTANT: "200",
          TEACHER: "307 → /teacher",
          GUARDIAN: "307 → /parent",
          BRANCH_ADMIN: "200",
          REGISTRAR: "200",
        };
        for (const role of ROLES) {
          const session = await login(creds[role].email, creds[role].password);
          check("item6", `${role} signs in`, session.status === 200, `got ${session.status}`);
          const dash = await get("/dashboard", session.cookie);
          const observed = dash.location ? `307 → ${dash.location}` : String(dash.status);
          if (role === "TEACHER" || role === "GUARDIAN") {
            check("live", `${role} is sent to its own app from /dashboard`, observed === expected[role], `got ${observed}`);
          } else {
            check("live", `${role} reaches /dashboard on the bare host`, dash.status === 200, `got ${observed}`);
          }
        }
        const bh = await get("/dashboard", (await login(creds.BRANCH_ADMIN.email, creds.BRANCH_ADMIN.password)).cookie);
        check(
          "live",
          "BRANCH_ADMIN no longer bounces to /login (the pilot-fix-1 item 6 claim)",
          !(bh.status === 307 && bh.location === "/login"),
          `got ${bh.status} ${bh.location || ""}`
        );
        const rg = await get("/dashboard", (await login(creds.REGISTRAR.email, creds.REGISTRAR.password)).cookie);
        check(
          "live",
          "REGISTRAR no longer bounces to /login",
          !(rg.status === 307 && rg.location === "/login"),
          `got ${rg.status} ${rg.location || ""}`
        );

        console.log("\n3-live) a guardian cannot record a payment");
        const guardian = await login(creds.GUARDIAN.email, creds.GUARDIAN.password);
        const cash = await post("/api/payments", guardian.cookie, { feeId, method: "CASH", amount: 500 });
        check("item3", "guardian POST /api/payments {CASH} is refused", cash.status === 403, `got ${cash.status}`);
        check(
          "item3",
          "the refusal says to pay at the office",
          /Online payment is not available/.test(String(cash.body?.error || "")),
          JSON.stringify(cash.body)
        );
        const nonCash = await post("/api/payments", guardian.cookie, { feeId, method: "BKASH", amount: 500 });
        check("item3", "guardian POST /api/payments {BKASH} is refused", nonCash.status === 403, `got ${nonCash.status}`);
        const mockRes = await post("/api/payments/mock-complete", guardian.cookie, { intentId: "pi_does_not_exist" });
        check(
          "item3",
          "guardian POST /api/payments/mock-complete is refused before it can record money",
          mockRes.status === 403 && /Online payment is not available/.test(String(mockRes.body?.error || "")),
          `got ${mockRes.status} ${JSON.stringify(mockRes.body)}`
        );
        const feeRow = (await db.collection("fees").doc(feeId).get()).data();
        const payments = (await db.collection("payments").where("feeId", "==", feeId).get()).size;
        const ledger = (await db.collection("ledger").where("feeId", "==", feeId).get()).size;
        const intents = (await db.collection("paymentIntents").where("feeId", "==", feeId).get()).size;
        check("item3", "the fee is still unpaid", Number(feeRow?.paidAmount || 0) === 0 && feeRow?.status === "PENDING", JSON.stringify(feeRow));
        check("item3", "NO payment row was written", payments === 0, `rows=${payments}`);
        check("item3", "NO ledger entry was written", ledger === 0, `rows=${ledger}`);
        check("item3", "NO orphan PENDING intent was created", intents === 0, `rows=${intents}`);

        console.log("\n3-live) the staff path still works exactly as before");
        const accountant = await login(creds.ACCOUNTANT.email, creds.ACCOUNTANT.password);
        const staffPay = await post("/api/payments", accountant.cookie, { feeId, method: "BANK", amount: 500 });
        check("item3", "an ACCOUNTANT can still create an intent", staffPay.status === 201, `got ${staffPay.status}`);
        const intentId = staffPay.body?.data?.id;
        check("item3", "the intent is PENDING for a bank transfer", staffPay.body?.data?.status === "PENDING", JSON.stringify(staffPay.body?.data));
        if (intentId) {
          const confirmed = await fetch(`${BASE}/api/payments`, {
            method: "PATCH",
            redirect: "manual",
            headers: { "content-type": "application/json", cookie: accountant.cookie },
            body: JSON.stringify({ intentId, action: "confirm" }),
          });
          const confirmedBody = await confirmed.json().catch(() => null);
          check("item3", "the ACCOUNTANT can still confirm it", confirmed.status === 200, `got ${confirmed.status} ${JSON.stringify(confirmedBody)}`);
          const after = (await db.collection("fees").doc(feeId).get()).data();
          check("item3", "the staff-recorded payment DID reach the fee", Number(after?.paidAmount || 0) === 500, JSON.stringify(after));
          await db.collection("payments").where("feeId", "==", feeId).get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
          await db.collection("ledger").where("feeId", "==", feeId).get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
          await db.collection("paymentIntents").where("feeId", "==", feeId).get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete())));
        }

        console.log("\n4-live) the demo card renders in dev and not on a deployment");
        const html = await (await fetch(`${BASE}/login`)).text();
        check("item4", "dev renders the demo quick-fill card", html.includes("Demo account"), "the card is absent from /login");
        check(
          "item4",
          "dev seeds the four demo identities into the page",
          html.includes("principal@sunrise.edu") && html.includes("guardian1@demo.com")
        );

        /* ------------------------------------------------------- pilot P1b, live */
        const p1bTag = Math.random().toString(36).slice(2, 8);
        const p1bUsers = [];
        const p1bStudents = [];
        const p1bSettingKeys = [];
        const p1bTeacherEmails = [];
        try {
          console.log("\nP1b-A-live) the sign-in limiter, on the running app");
          const rawLogin = async (identifier, password) => {
            const r = await fetch(`${BASE}/api/auth/login`, {
              method: "POST",
              redirect: "manual",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ identifier, password }),
            });
            return {
              status: r.status,
              retryAfter: r.headers.get("retry-after"),
              cookie: (r.headers.get("set-cookie") || "").split(";")[0],
              body: await r.json().catch(() => null),
            };
          };

          // Three throwaway accounts, so no demo login can be locked by this run.
          const [lockedEmail, otherEmail, resetEmail] = ["a", "b", "c"].map((k) => `zzpb-rate-${k}-${p1bTag}@test.local`);
          const ratePasswords = {};
          for (const email of [lockedEmail, otherEmail, resetEmail]) {
            const password = `RateProbe!${p1bTag}${email.length % 10}`;
            const id = userDoc(email);
            await db.collection("users").doc(id).set(
              { email, name: `ZZ PB Rate ${email}`, role: "SCHOOL_ADMIN", schoolId, active: true, passwordHash: bcrypt.hashSync(password, 10) },
              { merge: true }
            );
            p1bUsers.push(id);
            ratePasswords[email] = password;
          }
          // A signed-in baseline: the limiter must not have broken a good sign-in.
          const baseline = await rawLogin(lockedEmail, ratePasswords[lockedEmail]);
          check("p1b-a-live", "a fresh account still signs in (the limiter is not a wall)", baseline.status === 200, `got ${baseline.status}`);

          // Start every probe from a clean counter, so a re-run of this verifier
          // (or a leftover from an aborted one) cannot move a count under it.
          /** The settings DOCUMENT id a counter for this login key lives at (`set_<key>`). */
          const p1bDocFor = (kind, value) => `set_${attempts.counterKey("login", kind, attempts.normalizeIdentifier(value))}`;
          const lockedDoc = p1bDocFor("identifier", lockedEmail);
          for (const email of [lockedEmail, otherEmail, resetEmail]) {
            for (const key of [p1bDocFor("identifier", email), p1bDocFor("ip", email)]) {
              await db.collection("settings").doc(key).delete();
              p1bSettingKeys.push(key);
            }
          }

          const wrong = [];
          for (let i = 0; i < 7; i += 1) wrong.push(await rawLogin(lockedEmail, "definitely-not-the-password"));
          check(
            "p1b-a-live",
            "the first 7 wrong passwords answer 401 Invalid credentials",
            wrong.every((r) => r.status === 401 && /Invalid credentials/.test(String(r.body?.error || ""))),
            wrong.map((r) => r.status).join(",")
          );
          const eighth = await rawLogin(lockedEmail, "definitely-not-the-password");
          check("p1b-a-live", "the 8th wrong password is refused with 429", eighth.status === 429, `got ${eighth.status}`);
          check("p1b-a-live", "the refusal carries a Retry-After header", Number(eighth.retryAfter) > 0, String(eighth.retryAfter));
          check("p1b-a-live", "the refusal is the one generic sentence", eighth.body?.error === attempts.LOCKOUT_MESSAGE, String(eighth.body?.error));
          const correctWhileLocked = await rawLogin(lockedEmail, ratePasswords[lockedEmail]);
          check(
            "p1b-a-live",
            "a CORRECT password is refused while the identifier is locked",
            correctWhileLocked.status === 429,
            `got ${correctWhileLocked.status} ${JSON.stringify(correctWhileLocked.body)}`
          );
          check(
            "p1b-a-live",
            "the locked account cannot escape by presenting the right password again",
            (await rawLogin(lockedEmail, ratePasswords[lockedEmail])).status === 429
          );

          const lockedRow = (await db.collection("settings").doc(lockedDoc).get()).data();
          check(
            "p1b-a-live",
            "the counter lives in Firestore (so all 10 instances share it)",
            Number(lockedRow?.value?.count) === 8,
            JSON.stringify(lockedRow?.value)
          );
          check(
            "p1b-a-live",
            "the stored counter names nothing — it is a hash",
            String(lockedRow?.key || "").startsWith("rl:login:identifier:") && !String(lockedRow?.key).includes(p1bTag),
            String(lockedRow?.key)
          );
          const allSettings = (await db.collection("settings").get()).docs.map((d) => d.data());
          const ipRows = allSettings.filter((s) => String(s.key || "").startsWith("rl:login:ip:"));
          check(
            "p1b-a-live",
            "the client address is counted as well (the secondary defence)",
            ipRows.length >= 1 && Number(ipRows[0].value?.count) >= 8,
            ipRows.map((r) => JSON.stringify(r.value)).join(" ")
          );

          const otherLogin = await rawLogin(otherEmail, ratePasswords[otherEmail]);
          check(
            "p1b-a-live",
            "another identifier is untouched while the first is locked",
            otherLogin.status === 200 && /ss_token=/.test(otherLogin.cookie),
            `got ${otherLogin.status}`
          );

          console.log("\nP1b-A-live) a success resets the identifier's counter");
          const resetKey = p1bDocFor("identifier", resetEmail);
          p1bSettingKeys.push(resetKey);
          for (let i = 0; i < 3; i += 1) await rawLogin(resetEmail, "definitely-not-the-password");
          const beforeReset = (await db.collection("settings").doc(resetKey).get()).data();
          const recovered = await rawLogin(resetEmail, ratePasswords[resetEmail]);
          const afterReset = await db.collection("settings").doc(resetKey).get();
          check("p1b-a-live", "3 failures leave a live counter row", Number(beforeReset?.value?.count) === 3, JSON.stringify(beforeReset?.value));
          check("p1b-a-live", "the account still signs in below the limit", recovered.status === 200, `got ${recovered.status}`);
          check("p1b-a-live", "a successful sign-in CLEARS that identifier's counter", afterReset.exists === false, afterReset.exists ? JSON.stringify(afterReset.data()) : "gone");
          await rawLogin(resetEmail, "definitely-not-the-password");
          const restarted = (await db.collection("settings").doc(resetKey).get()).data();
          check(
            "p1b-a-live",
            "the next failure starts a fresh window at 1 (not a continued 4)",
            Number(restarted?.value?.count) === 1,
            JSON.stringify(restarted?.value)
          );

          console.log("\nP1b-A-live) the QR/PIN entry point is limited the same way");
          const qrToken = `zzpb-qr-${p1bTag}`;
          const qrPin = "4821";
          // The app stores every student under its token's own id (`st_<token>`) and
          // resolves `findUnique({ where: { qrToken } })` straight to it, so the
          // fixture must live at that id or the route cannot find it.
          const qrStudentId = `st_${qrToken}`;
          await db
            .collection("students")
            .doc(qrStudentId)
            .set(
              { schoolId, name: "ZZ PB QR Student", admissionNo: `ZZ-PB-QR-${p1bTag}`, status: "ACTIVE", active: true, qrToken, qrPin, guardianName: "ZZ PB Guardian" },
              { merge: true }
            );
          p1bStudents.push(qrStudentId);
          const qrPost = async (body) => {
            const r = await fetch(`${BASE}/api/qr/verify`, {
              method: "POST",
              redirect: "manual",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            });
            return { status: r.status, retryAfter: r.headers.get("retry-after"), body: await r.json().catch(() => null) };
          };
          const badPins = [];
          for (let i = 0; i < 7; i += 1) badPins.push(await qrPost({ token: qrToken, pin: "0000" }));
          check("p1b-a-live", "7 wrong PINs are rejected with 401", badPins.every((r) => r.status === 401), badPins.map((r) => r.status).join(","));
          const eighthPin = await qrPost({ token: qrToken, pin: "0000" });
          check("p1b-a-live", "the 8th wrong PIN is refused with 429", eighthPin.status === 429, `got ${eighthPin.status}`);
          const rightPin = await qrPost({ token: qrToken, pin: qrPin });
          check("p1b-a-live", "the CORRECT PIN is refused while the token is locked", rightPin.status === 429, `got ${rightPin.status}`);
          const otherToken = await qrPost({ token: `zzpb-no-such-token-${p1bTag}`, pin: "0000" });
          check("p1b-a-live", "a different token is not caught by that lockout", otherToken.status === 404, `got ${otherToken.status}`);

          console.log("\nP1b-B-live) the forgot-password request is limited, and stores nothing for an unknown email");
          const forgotEmail = `zzpb-forgot-${p1bTag}@test.local`;
          const sends = [];
          for (let i = 0; i < 7; i += 1) sends.push(await post("/api/auth/login", null, { purpose: "forgot", identifier: forgotEmail }));
          check(
            "p1b-b-live",
            "the first 7 reset requests all answer the same generic message",
            sends.every((r) => r.status === 200 && r.body?.data?.ok === true),
            sends.map((r) => r.status).join(",")
          );
          const eighthSend = await post("/api/auth/login", null, { purpose: "forgot", identifier: forgotEmail });
          check("p1b-b-live", "the 8th reset request is refused with 429", eighthSend.status === 429, `got ${eighthSend.status}`);
          const unknownResetRow = (await db.collection("settings").doc(`set_pw_reset_${forgotEmail}`).get()).exists;
          check("p1b-b-live", "an unknown email stores no reset record at all", unknownResetRow === false);

          const knownEmail = "guardian1@demo.com";
          const knownSends = [];
          for (let i = 0; i < 3; i += 1) knownSends.push(await post("/api/auth/login", null, { purpose: "forgot", identifier: knownEmail }));
          check(
            "p1b-b-live",
            "a KNOWN email answers in exactly the same shape as an unknown one",
            knownSends.length === 3 && sends.length === 7 && knownSends.every((r) => r.status === 200 && JSON.stringify(r.body) === JSON.stringify(sends[0].body)),
            JSON.stringify(knownSends[0]?.body)
          );
          p1bSettingKeys.push(`set_pw_reset_${knownEmail}`);

          console.log("\nP1b-D-live) a bulk-imported teacher gets no shared password");
          const admin = await login(creds.SCHOOL_ADMIN.email, creds.SCHOOL_ADMIN.password);
          const importRows = ["a", "b"].map((k) => `zzpb-teacher-${k}-${p1bTag}@test.local`);
          importRows.forEach((e) => p1bTeacherEmails.push(e));
          const imported = await post("/api/import/teachers", admin.cookie, {
            dryRun: false,
            csv: ["Name,Email,Phone,Designation", ...importRows.map((e, i) => `ZZ PB Teacher ${i},${e},+88017000000${i},Teacher`)].join("\n"),
          });
          check(
            "p1b-d-live",
            "the teacher import still creates the accounts",
            imported.status === 200 && imported.body?.data?.created === 2,
            `admin login ${admin.status} → HTTP ${imported.status} created=${imported.body?.data?.created} ${JSON.stringify(imported.body?.error || "")}`
          );
          check("p1b-d-live", "the import response carries NO password of any kind", !("defaultPassword" in (imported.body?.data || {})));
          const importedUsers = (await db.collection("users").where("email", "in", importRows).get()).docs.map((d) => d.data());
          check("p1b-d-live", "both imported teacher accounts exist", importedUsers.length === 2, String(importedUsers.length));
          check(
            "p1b-d-live",
            "neither account can be entered with the old shared literal",
            importedUsers.length === 2 && importedUsers.every((u) => !bcrypt.compareSync("Teacher@123", String(u.passwordHash || ""))),
            "Teacher@123 opened an imported account"
          );
          check(
            "p1b-d-live",
            "the two accounts got different secrets (no shared literal by another name)",
            importedUsers.length === 2 && importedUsers[0].passwordHash !== importedUsers[1].passwordHash
          );
          const noPassword = await post("/api/teachers", admin.cookie, { name: `ZZ PB NoPw ${p1bTag}`, email: `zzpb-nopw-${p1bTag}@test.local` });
          check(
            "p1b-d-live",
            "creating a teacher without a password is refused, with the rule spelled out",
            noPassword.status === 400 && /at least 8 characters/.test(String(noPassword.body?.error || "")),
            `got ${noPassword.status} ${JSON.stringify(noPassword.body)}`
          );
          const withPassword = await post("/api/teachers", admin.cookie, { name: `ZZ PB Pw ${p1bTag}`, email: `zzpb-pw-${p1bTag}@test.local`, password: `TeacherProbe!${p1bTag}` });
          check("p1b-d-live", "creating a teacher WITH a password still works", withPassword.status === 201, `got ${withPassword.status} ${JSON.stringify(withPassword.body)}`);
          p1bTeacherEmails.push(`zzpb-nopw-${p1bTag}@test.local`, `zzpb-pw-${p1bTag}@test.local`);

          console.log("\nP1c-live) guardians have no password — the QR slip is the credential");
          const p1cUsers = [];
          const p1cStudents = [];
          const p1cAdmissions = [];
          const p1cFees = [];
          // A class for the creation paths (read straight from the emulator).
          const p1cClass = (await db.collection("classes").where("schoolId", "==", schoolId).limit(1).get()).docs[0];
          check("p1c-live", "there is a class to admit into", !!p1cClass, p1cClass?.id || "none");
          const p1cClassName = p1cClass?.data?.()?.name || "Class 1";
          const qrCheck = async (token, pin) => {
            const r = await fetch(`${BASE}/api/qr/verify`, {
              method: "POST",
              redirect: "manual",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ token, pin }),
            });
            return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], body: await r.json().catch(() => null) };
          };
          // Every refusal below is compared against an UNKNOWN identifier with
          // the same password: the shape must be identical (no account oracle).
          const unknownProbe = await rawLogin(`zzpb-unknown-${p1bTag}@test.local`, "Guardian@123");
          const sameShape = (r) => r.status === unknownProbe.status && String(r.body?.error || "") === String(unknownProbe.body?.error || "");
          if (p1cClass) {
            // Path 1: POST /api/students (no guardian) + POST /api/guardians.
            const s1 = await post("/api/students", admin.cookie, { name: `ZZ PC S1 ${p1bTag}`, classId: p1cClass.id, admissionNo: `ZZ-PC-S1-${p1bTag}` });
            check("p1c-live", "a student without a guardian is created", s1.status === 201 && !!s1.body?.data?.id, `got ${s1.status}`);
            const s1Id = s1.body?.data?.id;
            if (s1Id) p1cStudents.push(s1Id);
            const g1Email = `zzpc-g1-${p1bTag}@test.local`;
            const g1 = await post("/api/guardians", admin.cookie, { name: "ZZ PC G1", email: g1Email, studentId: s1Id });
            check("p1c-live", "POST /api/guardians links without any password", g1.status === 201, `got ${g1.status} ${JSON.stringify(g1.body)}`);
            if (g1.status === 201) p1cUsers.push(userDoc(g1Email));
            for (const [label, pw] of [["the old default", "Guardian@123"], ["a guess", "Sunrise123"], ["the phone number", "01700000001"]]) {
              const attempt = await rawLogin(g1Email, pw);
              check("p1c-live", `a guardian from POST /api/guardians cannot sign in with ${label}`, attempt.status === 401 && sameShape(attempt), `got ${attempt.status} ${JSON.stringify(attempt.body)}`);
            }
            const emptyAttempt = await rawLogin(g1Email, "");
            const emptyUnknown = await rawLogin(`zzpb-unknown2-${p1bTag}@test.local`, "");
            check("p1c-live", "an empty password is refused exactly like an unknown account", emptyAttempt.status === emptyUnknown.status && String(emptyAttempt.body?.error || "") === String(emptyUnknown.body?.error || ""), `got ${emptyAttempt.status} vs ${emptyUnknown.status}`);
            // The same guardian CAN sign in with the linked student's QR slip.
            const s1full = s1.body?.data || {};
            const g1qr = await qrCheck(s1full.qrToken, s1full.qrPin);
            check("p1c-live", "the same guardian signs in with the QR slip token+PIN", g1qr.status === 200 && /ss_token=/.test(g1qr.cookie), `got ${g1qr.status}`);
            // Slip re-issue (new PIN) from the student page still works.
            const reissue = await fetch(`${BASE}/api/students/${s1Id}`, {
              method: "PATCH",
              redirect: "manual",
              headers: { "content-type": "application/json", cookie: admin.cookie },
              body: JSON.stringify({ qrPin: "7701" }),
            });
            check("p1c-live", "an admin can re-issue the slip (new PIN)", reissue.status === 200, `got ${reissue.status}`);
            const stalePin = await qrCheck(s1full.qrToken, s1full.qrPin);
            check("p1c-live", "the OLD pin stops working after a re-issue", stalePin.status === 401, `got ${stalePin.status}`);
            const freshPin = await qrCheck(s1full.qrToken, "7701");
            check("p1c-live", "the NEW pin signs the guardian in", freshPin.status === 200 && /ss_token=/.test(freshPin.cookie), `got ${freshPin.status}`);

            // Path 2: the desk intake (no password field anywhere).
            const g2Email = `zzpc-g2-${p1bTag}@test.local`;
            const intake = await post("/api/admissions/intake", admin.cookie, {
              student: { name: `ZZ PC S2 ${p1bTag}`, classId: p1cClass.id },
              guardian: { name: "ZZ PC G2", phone: `0179${p1bTag.slice(-7)}`, email: g2Email, createLogin: true },
              fees: { admissionFee: 0, monthlyFee: 0, createMonthly: false },
              payment: { collect: false },
              kit: {},
            });
            check("p1c-live", "the desk intake admits without a guardian password", intake.status === 201 && !!intake.body?.data?.studentId, `got ${intake.status} ${JSON.stringify(intake.body?.error || "")}`);
            if (intake.body?.data?.studentId) p1cStudents.push(intake.body.data.studentId);
            if (intake.body?.data?.admissionId) p1cAdmissions.push(intake.body.data.admissionId);
            if (g2Email && intake.body?.data?.guardian?.linked) p1cUsers.push(userDoc(g2Email));
            const g2try = await rawLogin(g2Email, "Guardian@123");
            check("p1c-live", "an intake guardian cannot sign in with the old default", g2try.status === 401 && sameShape(g2try), `got ${g2try.status}`);
            const g2qr = await qrCheck(intake.body?.data?.qrToken, intake.body?.data?.qrPin);
            check("p1c-live", "an intake guardian signs in with the admission QR slip", g2qr.status === 200 && /ss_token=/.test(g2qr.cookie), `got ${g2qr.status}`);

            // Path 3: the legacy CSV import (keeps guardianLoginsCreated, drops the password).
            const legacy = await post("/api/import/students", admin.cookie, {
              dryRun: false,
              csv: [
                "Admission No,Name,Class,Roll,Guardian Name,Guardian Email,Guardian Phone,Guardian Relation,Create Guardian Login",
                `ZZ-PC-L1-${p1bTag},ZZ PC Legacy ${p1bTag},${p1cClassName},1,ZZ PC GL ${p1bTag},zzpc-gl-${p1bTag}@test.local,+880170000001,FATHER,yes`,
              ].join("\n"),
            });
            check("p1c-live", "the legacy import still creates the student + guardian login", legacy.status === 200 && legacy.body?.data?.created === 1 && legacy.body?.data?.guardianLoginsCreated === 1, `got ${legacy.status} ${JSON.stringify(legacy.body?.data)}`);
            check("p1c-live", "the legacy import response carries NO password", !("defaultGuardianPassword" in (legacy.body?.data || {})), JSON.stringify(Object.keys(legacy.body?.data || {})));
            const glEmail = `zzpc-gl-${p1bTag}@test.local`;
            p1cUsers.push(userDoc(glEmail));
            const glTry = await rawLogin(glEmail, "Guardian@123");
            check("p1c-live", "a legacy-import guardian cannot sign in with the old default", glTry.status === 401 && sameShape(glTry), `got ${glTry.status}`);
            const glStudent = ((await db.collection("students").where("schoolId", "==", schoolId).get()).docs.map((d) => ({ id: d.id, ...d.data() }))).find((s) => String(s.admissionNo || "") === `ZZ-PC-L1-${p1bTag}`);
            if (glStudent?.id) p1cStudents.push(glStudent.id);
            const glQr = glStudent ? await qrCheck(glStudent.qrToken, glStudent.qrPin) : { status: 0, cookie: "" };
            check("p1c-live", "a legacy-import guardian signs in with the QR slip", glQr.status === 200 && /ss_token=/.test(glQr.cookie || ""), `got ${glQr.status}`);
          }
          // Best-effort cleanup of everything path 1–3 created.
          await Promise.all(p1cFees.map((id) => db.collection("fees").doc(id).delete().catch(() => null)));
          for (const id of p1cStudents) {
            await db.collection("fees").where("studentId", "==", id).get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete()))).catch(() => null);
            await db.collection("payments").where("studentId", "==", id).get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete()))).catch(() => null);
            await db.collection("ledger").where("studentId", "==", id).get().then((s) => Promise.all(s.docs.map((d) => d.ref.delete()))).catch(() => null);
            await db.collection("students").doc(id).delete().catch(() => null);
          }
          await Promise.all(p1cAdmissions.map((id) => db.collection("admissions").doc(id).delete().catch(() => null)));
          await Promise.all(p1cUsers.map((id) => db.collection("users").doc(id).delete().catch(() => null)));
        } finally {
          const teacherUserIds = (await db.collection("users").where("email", "in", p1bTeacherEmails.length ? p1bTeacherEmails : ["zzpb-none@test.local"]).get()).docs.map((d) => d.id);
          for (const id of teacherUserIds) {
            await db.collection("users").doc(id).delete();
            await db.collection("teachers").doc(`t_${id}`).delete();
          }
          await Promise.all(p1bUsers.map((id) => db.collection("users").doc(id).delete()));
          await Promise.all(p1bStudents.map((id) => db.collection("students").doc(id).delete()));
          await Promise.all(p1bSettingKeys.map((k) => db.collection("settings").doc(k).delete()));
          const leftovers = (await db.collection("settings").get()).docs.filter((d) =>
            /^(rl:|pw_reset_zzpb-)/.test(String(d.data()?.key || "")) && String(d.data()?.key || "").includes(p1bTag)
          );
          await Promise.all(leftovers.map((d) => d.ref.delete()));
        }
      } finally {
        await Promise.all(written.map((id) => db.collection("users").doc(id).delete()));
        await db.collection("teachers").doc(`t_${creds.TEACHER.id}`).delete();
        await db.collection("students").doc(studentId).delete();
        await db.collection("fees").doc(feeId).delete();
        if (!existing) await db.collection("branches").doc(branchId).delete();
      }
    }
  }

  /* Item 4, the build half: the credentials must not be in a production bundle. */
  const staticDir = resolve(ROOT, ".next/static");
  if (existsSync(staticDir)) {
    const files = [];
    const walk = (dir) => {
      for (const name of readdirSync(dir)) {
        const p = resolve(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(js|mjs)$/.test(name)) files.push(p);
      }
    };
    walk(staticDir);
    const hits = files.filter((f) => /principal@sunrise\.edu|guardian1@demo\.com|smartschool\.com/.test(readFileSync(f, "utf8")));
    check(
      "item4",
      `no demo credential in the production client bundle (${files.length} chunks scanned)`,
      hits.length === 0,
      hits.map((h) => h.replace(ROOT, "")).join(", ")
    );
  } else {
    console.log("\n4-build) .next/static is absent — SKIP the bundle scan (run `next build` first)");
  }
}

console.log(`\n${failures === 0 ? "PASS" : "FAIL"}: ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
