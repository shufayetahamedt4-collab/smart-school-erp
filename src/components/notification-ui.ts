import {
  Award,
  BadgeCheck,
  BarChart3,
  Bell,
  BookOpen,
  CalendarCheck,
  CalendarX2,
  ClipboardList,
  Crown,
  FileText,
  FolderOpen,
  Inbox,
  Megaphone,
  MessageSquare,
  Radio,
  Wallet,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * Presentation shared by the bell and the notification centre, so one event
 * looks the same wherever it appears. Icons and tones are full class strings on
 * purpose — Tailwind only keeps classes it can see literally.
 *
 * `where` names the page an event belongs to, which is the line under the time
 * ("Fee receipt", "Monthly fee"): it tells the reader *why* they got this.
 */
export interface NotificationMeta {
  icon: LucideIcon;
  tone: string;
  label: string;
}

const META: Record<string, NotificationMeta> = {
  NOTICE_PUBLISHED: { icon: Megaphone, tone: "bg-indigo-50 text-indigo-600", label: "Notice" },
  FEE_CONFIRMED: { icon: BadgeCheck, tone: "bg-emerald-50 text-emerald-600", label: "Payment" },
  FEE_DUE_REMINDER: { icon: Wallet, tone: "bg-amber-50 text-amber-600", label: "Fee due" },
  HOMEWORK_POSTED: { icon: BookOpen, tone: "bg-sky-50 text-sky-600", label: "Homework" },
  ATTENDANCE_PUBLISHED: { icon: ClipboardList, tone: "bg-rose-50 text-rose-600", label: "Attendance" },
  MESSAGE_RECEIVED: { icon: MessageSquare, tone: "bg-sky-50 text-sky-600", label: "Message" },
  ADMISSION_STATUS: { icon: ClipboardList, tone: "bg-violet-50 text-violet-600", label: "Admissions" },
  DISCOUNT_DECISION: { icon: Award, tone: "bg-emerald-50 text-emerald-600", label: "Discount" },
  PTM_BOOKED: { icon: CalendarCheck, tone: "bg-indigo-50 text-indigo-600", label: "PTM" },
  COMPLAINT_UPDATE: { icon: Inbox, tone: "bg-amber-50 text-amber-600", label: "Feedback" },
  LEAVE_DECISION: { icon: CalendarX2, tone: "bg-sky-50 text-sky-600", label: "Leave" },
  CLASS_STARTED: { icon: Radio, tone: "bg-rose-50 text-rose-600", label: "Live class" },
  EXAM_PUBLISHED: { icon: FileText, tone: "bg-violet-50 text-violet-600", label: "Exam" },
  RESULT_PUBLISHED: { icon: BarChart3, tone: "bg-violet-50 text-violet-600", label: "Results" },
  RESOURCE_ADDED: { icon: FolderOpen, tone: "bg-slate-100 text-slate-600", label: "Materials" },
  PLATFORM_EVENT: { icon: Crown, tone: "bg-violet-50 text-violet-600", label: "Platform" },
  SYSTEM: { icon: Bell, tone: "bg-slate-100 text-slate-600", label: "System" },
};

export function notificationMeta(event: string | null | undefined): NotificationMeta {
  return META[event || ""] || { icon: Bell, tone: "bg-slate-100 text-slate-600", label: "Notification" };
}

/**
 * The notice category palette, shared by the Notice Board screens and the
 * dashboard's notice badges, so one category keeps one colour everywhere.
 *
 * Typed against the real Badge tone keys on purpose — the shade is `green`,
 * not the `emerald` shade name, which the Badge primitive has no class for
 * (passing it would silently render an untinted badge).
 */
export type NoticeTone = "slate" | "red" | "amber" | "blue" | "green" | "violet";

const NOTICE_TONES: Record<string, NoticeTone> = {
  GENERAL: "slate",
  HOLIDAY: "red",
  EXAM: "violet",
  MEETING: "blue",
  EVENT: "green",
  PICNIC: "amber",
};

export function noticeCategoryTone(category: string | null | undefined): NoticeTone {
  return NOTICE_TONES[category || ""] || "slate";
}

/** "just now", "12m ago", "3h ago", "Yesterday", then a short date. */
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "—";
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 45) return "just now";
  if (secs < 3600) return `${Math.max(1, Math.round(secs / 60))}m ago`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h ago`;
  const days = Math.floor(secs / 86400);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}
