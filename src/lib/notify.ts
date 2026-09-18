import { prisma } from "./db";

/**
 * Notification & messaging service (PRD §13, §10.4).
 * - In-app notifications for every role (notification center).
 * - Email (dev mode logs; production SMTP can be plugged in).
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

export async function sendOtpEmail(to: string, code: string): Promise<void> {
  // Production: plug SMTP / transactional email here.
  // Dev/mock: log to server console (visible in `npm run dev` output).
  console.info(`[notify] OTP email → ${to}: ${code}`);
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
