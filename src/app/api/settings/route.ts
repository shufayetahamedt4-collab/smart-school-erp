import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

/**
 * Keys that are safe to expose without a session (public branding copy only).
 * Every other persisted setting — including `default_guardian_password` and
 * `support_email`-adjacent config — requires SUPER_ADMIN.
 */
const PUBLIC_SETTING_KEYS = new Set(["site_name", "support_email"]);

/**
 * Transient machine state that must never leave the server, whoever asks.
 * The `settings` collection doubles as short-lived state storage for the
 * password-reset OTP and the 2FA challenge; GET used to return all of it
 * (including reset codes) to any unauthenticated caller.
 */
const SECRET_SETTING_PREFIXES = ["pw_reset_", "2fa_challenge_", "otp_", "grading_scheme_"];
const isSecretKey = (key: string) => SECRET_SETTING_PREFIXES.some((p) => key.startsWith(p));

export async function GET() {
  const session = await getSession();
  const isSuperAdmin = session?.role === "SUPER_ADMIN";

  const settings = await prisma.setting.findMany();
  const map: Record<string, string> = {};
  for (const s of settings) {
    if (isSecretKey(s.key)) continue;
    if (!isSuperAdmin && !PUBLIC_SETTING_KEYS.has(s.key)) continue;
    map[s.key] = s.value;
  }
  return NextResponse.json({ data: map });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SUPER_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const body = await req.json().catch(() => null);
  if (!body || typeof body !== "object") return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  // Config only — refuse to let the settings API overwrite transient state
  // (e.g. forging or clobbering a pending password-reset code).
  const entries = Object.entries(body).filter(([key]) => !isSecretKey(key));
  if (entries.length === 0) return NextResponse.json({ data: { ok: true } });

  await prisma.$transaction(
    entries.map(([key, value]) =>
      prisma.setting.upsert({ where: { key }, update: { value: String(value) }, create: { key, value: String(value) } })
    )
  );
  await audit("SETTINGS_UPDATE", "settings");
  return NextResponse.json({ data: { ok: true } });
}
