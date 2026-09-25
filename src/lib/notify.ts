import { prisma } from "./db";

/**
 * Notification & messaging service (PRD §13, §10.4).
 * - In-app notifications for every role (notification center).
 * - Email via a transactional HTTP provider (dev console fallback).
 * - SMS fallback via a provider interface (BD bulk-SMS adapter stub).
 */

export type NotifyEvent =
  | "FEE_CONFIRMED"
  | "FEE_DUE_REMINDER"
  | "NOTICE_PUBLISHED"
  | "HOMEWORK_POSTED"
  | "ATTENDANCE_PUBLISHED"
  | "MESSAGE_RECEIVED"
  | "ADMISSION_STATUS"
  | "DISCOUNT_DECISION"
  | "PTM_BOOKED"
  | "COMPLAINT_UPDATE";

export interface NotifyInput {
  schoolId: string;
  userIds: string[];
  event: NotifyEvent;
  title: string;
  body?: string;
  link?: string;
  studentId?: string;
  push?: boolean;
}

/** Create in-app notifications (one per user) and optionally fan out push/SMS. */
export async function notifyUsers(input: NotifyInput): Promise<void> {
  const { schoolId, userIds, event, title, body, link, studentId } = input;
  const unique = [...new Set(userIds.filter(Boolean))];
  if (!unique.length) return;

  await prisma.notification.createMany({
    data: unique.map((userId) => ({
      schoolId,
      userId,
      event,
      title,
      body: body || null,
      link: link || null,
      studentId: studentId || null,
      readAt: null,
    })),
  });

  if (input.push) {
    await pushToUsers(unique, { title, body: body || "" }).catch(() => null);
  }
}

/** Mark a user's notifications read (optionally one specific notification). */
export async function markRead(userId: string, notificationId?: string) {
  const ids = notificationId ? [notificationId] : undefined;
  const where = ids
    ? { id: { in: ids }, userId }
    : { userId, readAt: null } as any;
  const list = await prisma.notification.findMany({ where });
  for (const n of list) {
    if (!n.readAt) {
      await prisma.notification.update({ where: { id: n.id }, data: { readAt: new Date() } });
    }
  }
}

/* ------------------------------------------------------------------ Push (FCM) */

/**
 * FCM web push via firebase-admin messaging. Sends to every registered
 * device token of the given users. Gracefully no-ops when FCM env config
 * is absent (mock mode until credentials arrive — per plan).
 */
export async function pushToUsers(userIds: string[], payload: { title: string; body: string; link?: string }) {
  try {
    const devices = await prisma.device.findMany({
      where: { userId: { in: userIds }, active: true },
      select: { token: true },
    });
    if (!devices.length) return;

    const admin = await import("firebase-admin/messaging");
    const messaging = admin.getMessaging();
    const messages = devices.map((d) => ({
      token: d.token,
      notification: { title: payload.title, body: payload.body },
      webpush: { fcmOptions: { link: payload.link || process.env.APP_URL || "/" } },
    }));
    await messaging.sendEach(messages as any);
  } catch {
    // Mock mode — FCM credentials not configured yet.
  }
}

/* ------------------------------------------------------------------ Email */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailProvider {
  /** Human label (used in diagnostics). */
  label: string;
  /** True when the adapter can actually deliver (credentials present). */
  live: boolean;
  send(msg: EmailMessage): Promise<{ ok: boolean; ref?: string; error?: string }>;
}

/**
 * Dependency-free HTTP transactional-email adapter (Resend-compatible REST
 * shape; point EMAIL_API_URL at SendGrid/Mailgun/Postmark gateways instead).
 * Mirrors the SmsProvider / ProviderAdapter convention used in this codebase.
 *
 * Env: EMAIL_API_KEY (or RESEND_API_KEY), EMAIL_FROM,
 *      EMAIL_API_URL (default https://api.resend.com/emails),
 *      EMAIL_PROVIDER=resend|http|console (default: auto by key presence).
 */
class HttpEmailProvider implements EmailProvider {
  label = "http";
  live = true;
  constructor(private apiKey: string, private endpoint: string, private from: string) {}

  async send(msg: EmailMessage) {
    try {
      const res = await fetch(this.endpoint, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: this.from,
          to: [msg.to],
          subject: msg.subject,
          text: msg.text,
          ...(msg.html ? { html: msg.html } : {}),
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        console.error(`[notify] email rejected for ${msg.to}: HTTP ${res.status} ${detail}`);
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const body: any = await res.json().catch(() => null);
      return { ok: true, ref: body?.id };
    } catch (e: any) {
      console.error(`[notify] email failed for ${msg.to}: ${e?.message || e}`);
      return { ok: false, error: e?.message || "send failed" };
    }
  }
}

/**
 * Fallback adapter. Outside production it logs the message (including OTPs) to
 * the dev console; in production it refuses to print codes and raises the
 * misconfiguration instead, so OTPs never land in production logs.
 */
class ConsoleEmailProvider implements EmailProvider {
  label = "console";
  live = process.env.NODE_ENV !== "production";

  async send(msg: EmailMessage) {
    if (process.env.NODE_ENV === "production") {
      console.error(`[notify] no email provider configured (set EMAIL_API_KEY) — dropped "${msg.subject}" to ${msg.to}`);
      return { ok: false, error: "email provider not configured" };
    }
    console.info(`[notify:dev-email] → ${msg.to} | ${msg.subject}\n${msg.text}`);
    return { ok: true, ref: `dev_${Date.now()}` };
  }
}

/** Pick a provider from env (no provider configured → dev console adapter). */
function resolveEmailProvider(): EmailProvider {
  const explicit = (process.env.EMAIL_PROVIDER || "").trim().toLowerCase();
  const apiKey = process.env.EMAIL_API_KEY || process.env.RESEND_API_KEY || "";
  const from = process.env.EMAIL_FROM || "Amar E School <no-reply@amare.school>";
  const endpoint = process.env.EMAIL_API_URL || "https://api.resend.com/emails";

  if (explicit === "console") return new ConsoleEmailProvider();
  if (explicit && !apiKey) {
    console.warn(`[notify] EMAIL_PROVIDER=${explicit} but no EMAIL_API_KEY — falling back to the dev console adapter.`);
    return new ConsoleEmailProvider();
  }
  if (explicit === "resend" || explicit === "http" || (!explicit && apiKey)) {
    return new HttpEmailProvider(apiKey, endpoint, from);
  }
  return new ConsoleEmailProvider();
}

let emailProvider: EmailProvider | null = null;
export function getEmailProvider(): EmailProvider {
  if (!emailProvider) emailProvider = resolveEmailProvider();
  return emailProvider;
}
/** Test / DI hook — mirrors setSmsProvider. */
export function setEmailProvider(p: EmailProvider | null) {
  emailProvider = p;
}

/** Send one transactional email. Never throws; returns the delivery result. */
export async function sendEmail(msg: EmailMessage) {
  return getEmailProvider().send(msg);
}

/** PRD §3.2 — password-reset OTP. Real provider when configured, dev console otherwise. */
export async function sendOtpEmail(to: string, code: string, ttlMinutes = 10): Promise<void> {
  const result = await sendEmail({
    to,
    subject: "Your Amar E School password reset code",
    text:
      `Your password reset code is ${code}.\n\n` +
      `It expires in ${ttlMinutes} minutes. If you did not request a reset, ignore this email — your password is unchanged.`,
    html:
      `<p>Your Amar E School password reset code is:</p>` +
      `<p style="font-size:22px;font-weight:700;letter-spacing:4px">${code}</p>` +
      `<p>It expires in ${ttlMinutes} minutes. If you did not request a reset, ignore this email — your password is unchanged.</p>`,
  });
  if (!result.ok) throw new Error(result.error || "email delivery failed");
}

/* ------------------------------------------------------------------ SMS (§13) */

export interface SmsProvider {
  send(to: string, text: string): Promise<{ ok: boolean; ref?: string }>;
}

/** Stub adapter for a BD bulk-SMS provider — mock mode until env credentials. */
class MockSmsProvider implements SmsProvider {
  async send(to: string, text: string) {
    console.info(`[sms:mock] → ${to}: ${text.slice(0, 120)}`);
    return { ok: true, ref: `mock_${Date.now()}` };
  }
}

let smsProvider: SmsProvider | null = null;
export function getSmsProvider(): SmsProvider {
  if (!smsProvider) smsProvider = new MockSmsProvider();
  return smsProvider;
}
export function setSmsProvider(p: SmsProvider) {
  smsProvider = p;
}

/** Send an SMS and log it to `smsLogs` for audit (PRD §13 SMS fallback). */
export async function sendSms(schoolId: string, to: string, text: string, studentId?: string) {
  const provider = getSmsProvider();
  const result = await provider.send(to, text).catch(() => ({ ok: false as const, ref: undefined as string | undefined }));
  await prisma.smsLog
    .create({
      data: { schoolId, to, text: text.slice(0, 480), studentId: studentId || null, ok: result.ok, ref: result.ref || null },
    })
    .catch(() => null);
  return result;
}
