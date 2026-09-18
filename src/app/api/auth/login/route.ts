import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { signSession, SESSION_COOKIE } from "@/lib/auth";
import { homeForRole } from "@/lib/auth";
import { needsTwoFactor, verifyChallenge } from "@/lib/twoFactor";
import { sendOtpEmail } from "@/lib/notify";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const identifier = String(body?.identifier || "").trim();
  const password = String(body?.password || "");
  const totp = body?.totp ? String(body.totp) : undefined;
  const purpose = body?.purpose === "2fa" ? "2fa" : body?.purpose === "forgot" ? "forgot" : "login";

  // ---------------------------------------------------------------- forgot password (email OTP)
  if (purpose === "forgot") {
    return forgotPassword(String(body?.identifier || ""));
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
    return issueSession(userId);
  }

  // ---------------------------------------------------------------- step 1: password
  if (!identifier || !password) {
    return NextResponse.json({ error: "Email/phone and password are required." }, { status: 400 });
  }

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: identifier.toLowerCase() }, { phone: identifier }],
    },
    include: { school: true },
  });

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  if (!user.active) {
    return NextResponse.json({ error: "This account has been deactivated." }, { status: 403 });
  }

  if (user.role !== "SUPER_ADMIN" && (!user.school || user.school.status === "SUSPENDED")) {
    return NextResponse.json({ error: "Your school is suspended. Contact the platform admin." }, { status: 403 });
  }

  // ---------------------------------------------------------------- 2FA gate (PRD §14.1)
  if (needsTwoFactor(user.role)) {
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

  return issueSession(user.id);
}

/** Mint the session cookie + audit entry for a fully authenticated user. */
async function issueSession(userId: string) {
  const user = await prisma.user.findUnique({ where: { id: userId }, include: { school: true } });
  if (!user || !user.active) {
    return NextResponse.json({ error: "Account not found or deactivated." }, { status: 401 });
  }

  const session = await signSession({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    schoolId: user.schoolId,
  });

  await prisma.auditLog.create({
    data: { action: "LOGIN", userId: user.id, schoolId: user.schoolId, entity: "user", entityId: user.id },
  });

  const res = NextResponse.json({
    data: { user: { id: user.id, name: user.name, role: user.role, schoolId: user.schoolId }, redirect: homeForRole(user.role) },
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

/** PRD §3.2 — forgot password via email OTP (SMS adapter can be plugged in later). */
async function forgotPassword(identifier: string) {
  const email = identifier.trim().toLowerCase();
  if (!email) return NextResponse.json({ error: "Email is required." }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email } });
  // Always answer the same way — do not leak which emails exist.
  const generic = { data: { ok: true, message: "If the email exists, a reset code has been sent." } };

  if (!user) return NextResponse.json(generic);

  const code = String(100000 + Math.floor(Math.random() * 900000));
  const key = `pw_reset_${email}`;
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: { code, expiresAt: Date.now() + 10 * 60 * 1000 } },
    update: { value: { code, expiresAt: Date.now() + 10 * 60 * 1000 } },
  });
  await sendOtpEmail(email, code).catch(() => null);
  return NextResponse.json(generic);
}
