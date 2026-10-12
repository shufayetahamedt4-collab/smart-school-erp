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
