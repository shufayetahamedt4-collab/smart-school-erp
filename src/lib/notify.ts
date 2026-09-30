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
  | "COMPLAINT_UPDATE"
  | "LEAVE_DECISION"
  | "CLASS_STARTED"
  | "EXAM_PUBLISHED"
  | "RESULT_PUBLISHED"
  | "RESOURCE_ADDED"
  | "PLATFORM_EVENT"
  | "SYSTEM";

export interface NotifyInput {
  schoolId: string;
  userIds: string[];
  event: NotifyEvent | (string & {});
  title: string;
  body?: string;
  link?: string;
  studentId?: string;
  push?: boolean;
  /** The person who caused the event (the signed-in user) is never notified. */
  excludeUserId?: string;
}

/**
 * Cap on one fan-out. A whole-school notice can legitimately reach every parent
 * plus every teacher, but a mistyped caller must not be able to write tens of
 * thousands of rows in a single request.
 */
const MAX_RECIPIENTS = 2000;

/**
 * Create in-app notifications (one per user) and optionally fan out push/SMS.
 *
 * `createdAt` is stamped here and only here. The datastore shim never adds
 * timestamps of its own, so a row written without one rendered a blank "—" in
 * the bell and sorted to the bottom forever — which is exactly why the old
 * notification list looked like fabricated demo data. Every writer goes through
 * this function, so every notification now carries a real time.
 *
 * Returns the number of rows written.
 */
export async function notifyUsers(input: NotifyInput): Promise<number> {
  const { schoolId, event, title, body, link, studentId, excludeUserId } = input;
  const unique = [...new Set((input.userIds || []).filter(Boolean))]
    .filter((id) => id !== excludeUserId)
    .slice(0, MAX_RECIPIENTS);
  if (!unique.length) return 0;

  const now = new Date();
  await prisma.notification.createMany({
    data: unique.map((userId) => ({
      schoolId,
      userId,
      event,
      title: String(title).slice(0, 160),
      body: body ? String(body).slice(0, 600) : null,
      link: link || null,
      studentId: studentId || null,
      readAt: null,
      createdAt: now,
    })),
  });

  if (input.push) {
    await pushToUsers(unique, { title, body: body || "", link }).catch(() => null);
  }
  return unique.length;
}

/* ------------------------------------------------------------ Targeting helpers */
//
// A notification is only useful if it reaches the right people. These resolve a
// *set of users* for a role, a class or a child, so a route can say what
// happened instead of hand-listing ids. They all funnel into notifyUsers, so
// timestamps, dedupe and the fan-out cap are applied in one place.

/** The inverse of NotifyInput: everything except who to notify. */
export type NotifyTarget = Omit<NotifyInput, "userIds" | "schoolId">;

/** User ids of every account in a school holding one of `roles`. */
async function userIdsForRoles(schoolId: string, roles: string[], branchId?: string | null): Promise<string[]> {
  const users = await prisma.user.findMany({ where: { schoolId, role: { in: roles } } });
  return (users as any[])
    // A branch-scoped event reaches school-wide staff plus that one branch's staff.
    .filter((u) => !branchId || !u.branchId || u.branchId === branchId)
    .map((u) => u.id);
}

/** Notify every account in a school that holds one of `roles` — the standard
 *  "tell the office" fan-out (admins, front desk, librarians, teachers…). */
export async function notifyRoles(
  schoolId: string,
  roles: string[],
  input: NotifyTarget,
  branchId?: string | null
): Promise<number> {
  const userIds = await userIdsForRoles(schoolId, roles, branchId);
  return notifyUsers({ ...input, schoolId, userIds });
}

/** Guardian account ids for the students matching `where` (deduped, capped). */
async function guardianIdsFor(schoolId: string, where: Record<string, any>): Promise<string[]> {
  const students = await prisma.student.findMany({ where: { schoolId, ...where } });
  const ids = new Set<string>();
  for (const s of students as any[]) {
    if (s.active === false) continue; // a child who left gets no new mail
    if (s.guardianUserId) ids.add(s.guardianUserId);
    if (ids.size >= MAX_RECIPIENTS) break;
  }
  return [...ids];
}

/** Every guardian with a child in this class (optionally narrowed to a section). */
export async function notifyGuardiansOfClass(
  schoolId: string,
  scope: { classId: string; sectionId?: string | null },
  input: NotifyTarget
): Promise<number> {
  const userIds = await guardianIdsFor(schoolId, {
    classId: scope.classId,
    ...(scope.sectionId ? { sectionId: scope.sectionId } : {}),
  });
  return notifyUsers({ ...input, schoolId, userIds });
}

/** Every guardian in a school — a school-wide notice or an urgent alert. */
export async function notifyGuardiansOfSchool(schoolId: string, input: NotifyTarget): Promise<number> {
  const userIds = await guardianIdsFor(schoolId, {});
  return notifyUsers({ ...input, schoolId, userIds });
}

/** The guardian of one child — attendance, results and other per-student events. */
export async function notifyGuardianOfStudent(
  schoolId: string,
  studentId: string,
  input: NotifyTarget
): Promise<number> {
  const student: any = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student || student.schoolId !== schoolId || !student.guardianUserId) return 0;
  return notifyUsers({ ...input, schoolId, userIds: [student.guardianUserId], studentId });
}

/**
 * Platform-console events (a new school, a plan change). Super Admins sit above
 * any one school, and the notification list is read by `userId` alone, so a
 * platform notice is written against the school it concerns and still lands in
 * the Super Admin's own bell.
 */
export async function notifySuperAdmins(input: Omit<NotifyInput, "userIds">): Promise<number> {
  const users = await prisma.user.findMany({ where: { role: "SUPER_ADMIN" } });
  return notifyUsers({ ...input, userIds: (users as any[]).map((u) => u.id) });
}

/* ----------------------------------------------------------------- Read / delete */

/**
 * Mark all of a user's notifications read, or just one. Returns rows changed.
 *
 * The single-id path resolves the document by id and then checks ownership in
 * code, rather than trusting `findFirst({ where: { id, userId } })`: the
 * datastore shim's doc-id lookup ignores every other key in `where`, so an
 * unguarded `findFirst` would let one user read or delete another user's rows.
 */
export async function markRead(userId: string, notificationId?: string): Promise<number> {
  if (notificationId) {
    const row: any = await prisma.notification.findFirst({ where: { id: notificationId } });
    if (!row || row.userId !== userId) return 0;
    await prisma.notification.update({ where: { id: row.id }, data: { readAt: new Date() } });
    return 1;
  }
  const rows: any[] = await prisma.notification.findMany({ where: { userId, readAt: null } });
  const ids = rows.map((n) => n.id);
  if (!ids.length) return 0;
  await prisma.notification.updateMany({ where: { id: { in: ids } }, data: { readAt: new Date() } });
  return ids.length;
}

/** Put a read notification back in the unread badge. */
export async function markUnread(userId: string, notificationId: string): Promise<number> {
  const row: any = await prisma.notification.findFirst({ where: { id: notificationId } });
  if (!row || row.userId !== userId) return 0;
  await prisma.notification.update({ where: { id: row.id }, data: { readAt: null } });
  return 1;
}

/**
 * Delete one notification, or every read one, for this user. Returns the count.
 *
 * Ownership is load-bearing: the id comes from the caller, so an unguarded
 * lookup would let any signed-in user delete any notification by guessing ids.
 */
export async function deleteNotifications(
  userId: string,
  opts: { id?: string; readOnly?: boolean } = {}
): Promise<number> {
  // Single-id path resolves the doc then checks ownership in code, for the same
  // reason markRead does — the doc-id lookup ignores any other `where` key.
  if (opts.id) {
    const row: any = await prisma.notification.findFirst({ where: { id: opts.id } });
    if (!row || row.userId !== userId) return 0;
    await prisma.notification.delete({ where: { id: row.id } });
    return 1;
  }
  const rows: any[] = await prisma.notification.findMany({ where: { userId } });
  const ids = rows.filter((n) => (opts.readOnly ? !!n.readAt : true)).map((n) => n.id);
  if (!ids.length) return 0;
  await prisma.notification.deleteMany({ where: { id: { in: ids } } });
  return ids.length;
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
