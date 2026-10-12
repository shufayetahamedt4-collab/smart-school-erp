import { NextRequest, NextResponse, after } from "next/server";
import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { signSession, SESSION_COOKIE } from "@/lib/auth";
import { homeForRole } from "@/lib/auth";
import { needsTwoFactor, verifyChallenge, twoFactorStatus } from "@/lib/twoFactor";
import { sendOtpEmail, getEmailProvider } from "@/lib/notify";
import { resolveSector, sectorForRole, requestHost } from "@/lib/sectors";
import { firebaseConfigProblem } from "@/lib/firebase";
import { SESSION_SECRET_MISSING, sessionSecretFatal } from "@/lib/pilot-guards";
import { LOCKOUT_MESSAGE, normalizeIdentifier } from "@/lib/login-attempts";
import { checkAttemptLimit, clearAttempts, noteFailedAttempt } from "@/lib/login-attempts-store";

/**
 * Each app only accepts the accounts that belong to it. The check is skipped on
 * host-agnostic hosts (bare domain, localhost, 127.0.0.1) so the platform URL
 * and the seeded harnesses keep working.
 */
function sectorMismatch(req: NextRequest, role: string): string | null {
  const sector = resolveSector(requestHost(req.headers));
  if (!sector || sector.roles.includes(role)) return null;
  // No student app exists: families use the Parents App on the guardian's
  // device, so a student account is never the way in.
  if (role === "STUDENT") {
    return "Student accounts don't sign in directly. Ask your guardian to open the Parents App.";
  }
  const owner = sectorForRole(role);
  return `This account signs in to the ${owner?.label || "another"} — please use that app.`;
}

/**
 * A serverless host with no environment is the single most common way this app
 * "does not work" after a deploy: every data route fails at the first Firestore
 * read with an empty 500, which the browser can only report as "Request
 * failed". Say what is actually wrong instead, and point at /api/health.
 */
export async function POST(req: NextRequest) {
  const configProblem = firebaseConfigProblem();
  if (configProblem) {
    console.error(`[auth] refusing to sign in: ${configProblem}`);
    return NextResponse.json({ error: configProblem }, { status: 503 });
  }
  // pilot-fix-1 item 1 — a deployment with no JWT_SECRET can neither sign nor
  // verify a session, so it must refuse the sign-in with a clear, actionable
  // answer instead of minting a cookie everyone could forge. Checked BEFORE the
  // password so no account is verified against a deployment that cannot hold a
  // session. `/api/health` reports the same problem.
  if (sessionSecretFatal(process.env)) {
    console.error(`[auth] refusing to sign in: ${SESSION_SECRET_MISSING}`);
    return NextResponse.json({ error: SESSION_SECRET_MISSING }, { status: 503 });
  }
  try {
    return await signIn(req);
  } catch (e: any) {
    const message = String(e?.message || e);
    console.error(`[auth] sign-in failed: ${message}`);
    return NextResponse.json(
      { error: `The server could not complete the sign-in: ${message}` },
      { status: 500 }
    );
  }
}

/**
 * The ONE refusal for a rate-limited request (pilot P1b item A).
 *
 * Identical for every caller — a known identifier, an unknown one, and every
 * address — because the message may not reveal whether an account exists, and a
 * different shape for a known account would turn the limiter into exactly the
 * enumeration oracle the sign-in route avoids elsewhere. `Retry-After` says how
 * long the caller must wait.
 */
function lockedOut(retryAfterSec: number): NextResponse {
  const wait = Math.max(1, Math.ceil(retryAfterSec || 0));
  return NextResponse.json({ error: LOCKOUT_MESSAGE }, { status: 429, headers: { "Retry-After": String(wait) } });
}

async function signIn(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const identifier = String(body?.identifier || "").trim();
  const password = String(body?.password || "");
  const totp = body?.totp ? String(body.totp) : undefined;
  const purpose = body?.purpose === "2fa" ? "2fa" : body?.purpose === "forgot" ? "forgot" : "login";

  // ---------------------------------------------------------------- forgot password (email OTP)
  if (purpose === "forgot") {
    return forgotPassword(String(body?.identifier || ""), req);
  }

  // ---------------------------------------------------------------- step 2: 2FA challenge
  if (purpose === "2fa") {
    const challengeId = String(body?.challengeId || "");
    if (!challengeId || !totp) {
      return NextResponse.json({ error: "Verification code is required." }, { status: 400 });
    }
    const pending = await prisma.setting.findUnique({ where: { key: `2fa_challenge_${challengeId}` } }).catch(() => null);
    if (!pending) {
      return NextResponse.json({ error: "Verification session expired. Please sign in again." }, { status: 401 });
    }
    const data = pending as any;
    if (Date.now() > Number(data.expiresAt || 0)) {
      await prisma.setting.deleteMany({ where: { key: `2fa_challenge_${challengeId}` } });
      return NextResponse.json({ error: "Verification session expired. Please sign in again." }, { status: 401 });
    }
    const userId = String(data.userId);
    const result = await verifyChallenge(userId, totp);
    if (result === "invalid") {
      return NextResponse.json({ error: "Invalid verification code." }, { status: 401 });
    }
    await prisma.setting.deleteMany({ where: { key: `2fa_challenge_${challengeId}` } });
    return issueSession(userId, req);
  }

  // ---------------------------------------------------------------- step 1: password
  if (!identifier || !password) {
    return NextResponse.json({ error: "Email/phone and password are required." }, { status: 400 });
  }

  // pilot P1b item A — the rate limit, checked BEFORE the account is looked up, so
  // a locked identifier costs one read, is refused even when the password is
  // right, and is refused in exactly the same way whether or not it exists.
  const attemptId = normalizeIdentifier(identifier);
  const gate = await checkAttemptLimit("login", attemptId, req.headers);
  if (gate.locked) return lockedOut(gate.retryAfterSec);

  // An email has a deterministic document id (`u_<sha1(email)>`), so an email
  // sign-in is ONE document read. The old `OR: [email, phone]` had no pushdown
  // and pulled the whole users collection — 0.5–4s cold on every single login.
  // Phones keep the scan; they have no deterministic id.
  const email = identifier.toLowerCase();
  const user =
    (identifier.includes("@")
      ? await prisma.user.findUnique({ where: { email }, include: { school: true } })
      : null) ??
    (await prisma.user.findFirst({
      where: { OR: [{ email }, { phone: identifier }] },
      include: { school: true },
    }));

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    // Only a FAILED attempt counts (an unknown identifier and a wrong password
    // are the same failure, and are counted identically). The attempt that brings
    // the count to the limit is already a refusal.
    const after = await noteFailedAttempt("login", attemptId, req.headers);
    if (after.locked) return lockedOut(after.retryAfterSec);
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  // The credentials were right: clear THIS identifier's failure count. The
  // address counter is deliberately left alone — one account signing in must not
  // wipe the evidence of a spray against other accounts from the same host.
  if (gate.tracked) await clearAttempts("login", attemptId);

  if (!user.active) {
    return NextResponse.json({ error: "This account has been deactivated." }, { status: 403 });
  }

  if (user.role !== "SUPER_ADMIN" && (!user.school || user.school.status === "SUSPENDED")) {
    return NextResponse.json({ error: "Your school is suspended. Contact the platform admin." }, { status: 403 });
  }

  // Wrong app for this account (e.g. a guardian signing in on the staff console).
  const mismatch = sectorMismatch(req, user.role);
  if (mismatch) return NextResponse.json({ error: mismatch }, { status: 403 });

  // ---------------------------------------------------------------- 2FA gate (PRD §14.1)
  // Gradual enrollment: only challenge when the user has actually enabled 2FA.
  // The status read is itself a round trip, so only the roles that can ever
  // enroll (SUPER_ADMIN / SCHOOL_ADMIN) pay for it — a teacher, guardian or
  // student sign-in no longer waits on it.
  if (needsTwoFactor(user.role)) {
    const tf = await twoFactorStatus(user.id).catch(() => ({ enrolled: false, enabled: false }));
    if (tf.enabled) {
      const challengeId = `c_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
      await prisma.setting.upsert({
        where: { key: `2fa_challenge_${challengeId}` },
        create: {
          key: `2fa_challenge_${challengeId}`,
          value: { userId: user.id, expiresAt: Date.now() + 5 * 60 * 1000 },
        },
        update: { value: { userId: user.id, expiresAt: Date.now() + 5 * 60 * 1000 } },
      });
      return NextResponse.json({
        data: { twoFactorRequired: true, challengeId, email: user.email },
      });
    }
  }

  return issueSession(user.id, req, user);
}

/**
 * Mint the session cookie + audit entry for a fully authenticated user.
 * `preloaded` is the account the caller just read, so an email sign-in does not
 * pay a second, identical document read just to mint the cookie.
 */
async function issueSession(userId: string, req: NextRequest, preloaded?: any) {
  const user =
    preloaded?.id === userId
      ? preloaded
      : await prisma.user.findUnique({ where: { id: userId }, include: { school: true } });
  if (!user || !user.active) {
    return NextResponse.json({ error: "Account not found or deactivated." }, { status: 401 });
  }

  const mismatch = sectorMismatch(req, user.role);
  if (mismatch) return NextResponse.json({ error: mismatch }, { status: 403 });

  // PRD §12.3 — a branch user (scope "BRANCH" or any branchId) only signs in
  // while the school has granted that branch access to the ERP.
  if (user.branchId) {
    const branch = await prisma.branch.findUnique({ where: { id: user.branchId } }).catch(() => null);
    if (!branch || branch.enabled === false) {
      return NextResponse.json({ error: "This branch's access to the ERP has been turned off. Contact the school admin." }, { status: 403 });
    }
  }

  // Sign the session now; record the login AFTER the response is sent.
  //
  // The audit write is a full Firestore round trip and the user does not wait on
  // it, so `after()` runs it once the response has gone out — still guaranteed
  // (the platform tracks it), but no longer on the sign-in critical path. A
  // failed audit write must never cost the user their login.
  const session = await signSession({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    schoolId: user.schoolId,
    scope: user.scope || null,
    branchId: user.branchId || null,
  });
  after(() => {
    void prisma.auditLog
      .create({
        data: { action: "LOGIN", userId: user.id, schoolId: user.schoolId, entity: "user", entityId: user.id },
      })
      .catch(() => null);
  });

  const res = NextResponse.json({
    data: {
      user: { id: user.id, name: user.name, role: user.role, schoolId: user.schoolId, scope: user.scope || null, branchId: user.branchId || null },
      redirect: homeForRole(user.role),
    },
  });
  res.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}

/** How long a password-reset code stays valid. */
const RESET_TTL_MINUTES = 10;

/**
 * Only a peppered hash is persisted, so a leaked settings row (or DB read)
 * cannot be turned back into a usable reset code.
 */
const hashResetCode = (email: string, code: string) =>
  createHash("sha256").update(`${email}|${code}|${process.env.JWT_SECRET || ""}`).digest("hex");

/**
 * PRD §3.2 — forgot password via email OTP.
 * Delivery goes through the transactional email provider in lib/notify
 * (HTTP provider when EMAIL_API_KEY is set, dev-console adapter otherwise).
 */
async function forgotPassword(identifier: string, req: NextRequest) {
  const email = identifier.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });

  // pilot P1b item A — this request is limited too, and it is counted as a REQUEST
  // rather than as a "failure", because there is no failure here: the resource
  // being protected is the mail send. Counting it for unknown identifiers as well
  // is what keeps the limit itself from revealing which emails exist.
  const attemptId = normalizeIdentifier(email);
  const gate = await checkAttemptLimit("forgot", attemptId, req.headers);
  if (gate.locked) return lockedOut(gate.retryAfterSec);
  const counted = await noteFailedAttempt("forgot", attemptId, req.headers);
  if (counted.locked) return lockedOut(counted.retryAfterSec);

  const user = await prisma.user.findUnique({ where: { email } });
  // Always answer the same way — do not leak which emails exist.
  const generic = { data: { ok: true, message: "If the email exists, a reset code has been sent." } };

  // pilot P1b item B — a deployment with no email provider can neither deliver a
  // code nor be trusted with one: the console adapter refuses to print codes in
  // production, so the old code wrote a `pw_reset_*` record and then threw the
  // code away. Nothing consumes that record today either way (there is no
  // reset-code verifier anywhere in this app), so with no live provider this now
  // sends nothing AND stores nothing, and still answers the generic message.
  const provider = getEmailProvider();
  if (!provider.live) {
    console.error(
      "[auth] no email provider is configured on this deployment — the password-reset request was not sent and no reset code was stored"
    );
    return NextResponse.json(generic);
  }

  if (!user) return NextResponse.json(generic);

  const code = String(100000 + Math.floor(Math.random() * 900000));
  const key = `pw_reset_${email}`;
  const value = {
    codeHash: hashResetCode(email, code),
    expiresAt: Date.now() + RESET_TTL_MINUTES * 60 * 1000,
  };
  await prisma.setting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });

  // Delivery failure must not change the response (enumeration safety), but it
  // must be visible to operators. sendOtpEmail never leaks the code in prod.
  await sendOtpEmail(email, code, RESET_TTL_MINUTES).catch((e) =>
    console.error(`[auth] password-reset email failed for ${email}: ${e?.message || e}`)
  );
  return NextResponse.json(generic);
}
