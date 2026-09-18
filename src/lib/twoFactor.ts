import { createHmac, randomBytes, createHash } from "node:crypto";
import { prisma } from "./db";

/**
 * PRD §14.1 — 2FA (TOTP, RFC 6238) for SUPER_ADMIN / SCHOOL_ADMIN.
 * Implemented with zero new dependencies (HMAC-SHA1 per RFC 4226/6238).
 *
 * Enrollment is gradual: admins can log in without 2FA until they enroll;
 * once enrolled, every login requires a valid code. Backup codes are
 * single-use hashes for recovery.
 */

interface TwoFactorRecord {
  id: string;
  userId: string;
  secret: string;
  enabled: boolean;
  backupHashes: string[];
}

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.replace(/=+$/, "").toUpperCase().replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** RFC 4226 HMAC-based one-time password. */
function hotp(secretBuf: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 0x100000000), 0);
  buf.writeUInt32BE(counter % 0x100000000, 4);
  const hmac = createHmac("sha1", secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    (hmac[offset + 1] << 16) |
    (hmac[offset + 2] << 8) |
    hmac[offset + 3];
  return String(bin % 1_000_000).padStart(6, "0");
}

/** RFC 6238 TOTP for the current time window (30s), ±1 window tolerance. */
export function verifyTotp(secretBase32: string, code: string, window = 1): boolean {
  const secretBuf = base32Decode(secretBase32);
  const now = Math.floor(Date.now() / 1000 / 30);
  const parsed = String(code).replace(/\D/g, "");
  if (parsed.length !== 6) return false;
  for (let i = -window; i <= window; i++) {
    if (hotp(secretBuf, now + i) === parsed) return true;
  }
  return false;
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** otpauth:// URI for authenticator apps (Google Authenticator, Authy…). */
export function otpauthUri(secret: string, email: string, issuer = "Amar E School"): string {
  const label = encodeURIComponent(`${issuer}:${email}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: "SHA1", digits: "6", period: "30" });
  return `otpauth://totp/${label}?${params.toString()}`;
}

async function getRecord(userId: string): Promise<TwoFactorRecord | null> {
  return prisma.twoFactor.findUnique({ where: { userId } }) as unknown as TwoFactorRecord | null;
}

export async function twoFactorStatus(userId: string): Promise<{ enrolled: boolean; enabled: boolean }> {
  const rec = await getRecord(userId);
  return { enrolled: !!rec, enabled: !!rec?.enabled };
}

/** Begin enrollment: generates (or regenerates) a pending secret + backup codes. */
export async function startEnrollment(userId: string, email: string) {
  const secret = generateTotpSecret();
  const backupCodes = Array.from({ length: 8 }, () => randomBytes(4).toString("hex"));
  const backupHashes = backupCodes.map((c) => sha256(c));
  await prisma.twoFactor.upsert({
    where: { userId },
    create: { userId, secret, enabled: false, backupHashes },
    update: { secret, enabled: false, backupHashes },
  });
  return { secret, otpauth: otpauthUri(secret, email), backupCodes };
}

/** Confirm enrollment by verifying a live code; activates 2FA. */
export async function confirmEnrollment(userId: string, code: string): Promise<boolean> {
  const rec = await getRecord(userId);
  if (!rec) return false;
  if (!verifyTotp(rec.secret, code)) return false;
  await prisma.twoFactor.update({ where: { userId }, data: { enabled: true } });
  return true;
}

export async function disableTwoFactor(userId: string) {
  await prisma.twoFactor.deleteMany({ where: { userId } });
}

/**
 * Verify a 2FA challenge: TOTP code or a backup code (single use).
 * Returns "ok" | "invalid" | "backup-used".
 */
export async function verifyChallenge(
  userId: string,
  code: string
): Promise<"ok" | "invalid" | "backup-used"> {
  const rec = await getRecord(userId);
  if (!rec || !rec.enabled) return "invalid";
  if (verifyTotp(rec.secret, code)) return "ok";

  const hash = sha256(String(code).trim());
  if (rec.backupHashes?.includes(hash)) {
    const remaining = rec.backupHashes.filter((h) => h !== hash);
    await prisma.twoFactor.update({ where: { userId }, data: { backupHashes: remaining } });
    return "backup-used";
  }
  return "invalid";
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Roles that must present a 2FA challenge after password verification. */
export function needsTwoFactor(role: string): boolean {
  return role === "SUPER_ADMIN" || role === "SCHOOL_ADMIN";
}
