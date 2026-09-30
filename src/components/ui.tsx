"use client";

import Link from "next/link";
import { X, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { PageSkeleton } from "@/components/PageSkeleton";
import type { LucideIcon } from "lucide-react";

/* ------------------------------------------------------------------ Card */

export function Card({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn("card", className)}>{children}</div>;
}

export function CardHeader({
  title,
  subtitle,
  action,
}: {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
      <div>
        {/* The ss-* classes are school-scoped refinements (see globals.css); the
            Tailwind classes are the original rendering every other sector keeps. */}
        <h3 className="ss-card-title text-sm font-bold text-slate-800">{title}</h3>
        {subtitle && <p className="ss-card-sub mt-0.5 text-xs text-slate-500">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

/* ----------------------------------------------------------------- Badge */

const badgeTones: Record<string, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  red: "bg-rose-50 text-rose-700 ring-rose-600/20",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20",
  blue: "bg-sky-50 text-sky-700 ring-sky-600/20",
  indigo: "bg-indigo-50 text-indigo-700 ring-indigo-600/20",
  slate: "bg-slate-100 text-slate-600 ring-slate-500/20",
  violet: "bg-violet-50 text-violet-700 ring-violet-600/20",
};

export function Badge({
  tone = "slate",
  className,
  children,
}: {
  tone?: keyof typeof badgeTones;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span className={cn("badge ring-1 ring-inset", badgeTones[tone], className)}>{children}</span>
  );
}

export function statusTone(status: string): keyof typeof badgeTones {
  switch (status) {
    case "PAID":
    case "PRESENT":
    case "ACTIVE":
    case "EXCELLENT":
    case "SUBMITTED":
    case "COMPLETED":
      return "green";
    case "ABSENT":
    case "UNPAID":
    case "SUSPENDED":
    case "LOCKED":
    case "EXPIRED":
    case "NEEDS_IMPROVEMENT":
    case "OVERDUE":
      return "red";
    case "LATE":
    case "PARTIAL":
    case "TRIAL":
    case "GRACE":
    case "PAST_DUE":
    case "AVERAGE":
    case "PENDING":
      return "amber";
    case "LEAVE":
    case "GOOD":
      return "blue";
    default:
      return "slate";
  }
}

export function prettyStatus(s: string): string {
  return s.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

/* ----------------------------------------------------------------- Forms */

export function Field({
  label,
  children,
  hint,
  className,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label">{label}</label>
      {children}
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn("input", props.className)} />;
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} className={cn("input", props.className)} />;
}

export function Textarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn("input min-h-24 resize-y", props.className)} />;
}

/* ------------------------------------------------------------------ Modal */

export function Modal({
  open,
  onClose,
  title,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  children: React.ReactNode;
  wide?: boolean;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} />
      <div
        className={cn(
          "relative w-full fade-up rounded-2xl bg-white shadow-2xl max-h-[90vh] flex flex-col",
          wide ? "max-w-3xl" : "max-w-lg"
        )}
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-base font-bold text-slate-800">{title}</h3>
          <button onClick={onClose} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition">
            <X size={18} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ Misc */

export function Spinner({ className }: { className?: string }) {
  return (
    <div
      className={cn(
        "h-6 w-6 animate-spin rounded-full border-2 border-slate-300 border-t-indigo-600",
        className
      )}
    />
  );
}

/**
 * The per-page loading state (used by 59 pages).
 *
 * It used to be a centred spinner on an empty page, which made every fetch
 * look like a stalled page. It now lays out the page's shape instead, so the
 * frame is stable and the numbers settle into place — the difference between
 * "waiting" and "loading".
 */
export function LoadingScreen({ label = "Loading…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite">
      <PageSkeleton />
      <span className="sr-only">{label}</span>
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-slate-100 text-slate-400">
        <Icon size={22} />
      </div>
      <h4 className="text-sm font-bold text-slate-700">{title}</h4>
      {description && <p className="max-w-sm text-xs text-slate-500">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function StatCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = "indigo",
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: "indigo" | "emerald" | "amber" | "rose" | "sky" | "violet";
}) {
  const tones: Record<string, string> = {
    indigo: "bg-indigo-50 text-indigo-600",
    emerald: "bg-emerald-50 text-emerald-600",
    amber: "bg-amber-50 text-amber-600",
    rose: "bg-rose-50 text-rose-600",
    sky: "bg-sky-50 text-sky-600",
    violet: "bg-violet-50 text-violet-600",
  };
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-extrabold text-slate-900">{value}</p>
          {sub && <p className="mt-1 text-xs text-slate-500">{sub}</p>}
        </div>
        <div className={cn("flex h-11 w-11 shrink-0 items-center justify-center rounded-xl", tones[tone])}>
          <Icon size={20} />
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------- School Admin command center */

/**
 * The KPI/status/attention primitives below are ADDITIVE — they are new exports
 * used only by the School Admin dashboard, so every other screen (and every
 * other sector) is unaffected. They carry no logic: each one only lays out the
 * values it is handed.
 */
const kpiTones: Record<string, { tile: string; dot: string; glyph: string }> = {
  slate: { tile: "bg-slate-100 text-slate-600", dot: "bg-slate-400", glyph: "text-slate-400" },
  indigo: { tile: "bg-indigo-50 text-indigo-600", dot: "bg-indigo-500", glyph: "text-indigo-500" },
  emerald: { tile: "bg-emerald-50 text-emerald-600", dot: "bg-emerald-500", glyph: "text-emerald-500" },
  amber: { tile: "bg-amber-50 text-amber-600", dot: "bg-amber-500", glyph: "text-amber-500" },
  rose: { tile: "bg-rose-50 text-rose-600", dot: "bg-rose-500", glyph: "text-rose-500" },
  sky: { tile: "bg-sky-50 text-sky-600", dot: "bg-sky-500", glyph: "text-sky-500" },
  violet: { tile: "bg-violet-50 text-violet-600", dot: "bg-violet-500", glyph: "text-violet-500" },
};

export type KpiTone = keyof typeof kpiTones;

/**
 * A compact key figure: label, value, optional supporting line and a quiet icon.
 *
 * `bare` drops the card chrome so a row of KPIs can live inside ONE divided
 * surface (the dashboard's KPI strip) instead of five floating cards — the
 * "not everything is a card" rule.
 */
export function KpiCard({
  icon: Icon,
  label,
  value,
  sub,
  tone = "indigo",
  bare = false,
}: {
  icon: LucideIcon;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  tone?: KpiTone;
  bare?: boolean;
}) {
  // Numbers first: the figure is the largest thing in the cell, the label is a
  // quiet eyebrow, and the icon is a thin monochrome glyph — NOT a filled
  // pastel tile, so five KPIs never shout over the values they describe.
  const inner = (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="truncate text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-400">{label}</p>
        <p className="ss-metric mt-2">{value}</p>
        {sub && <p className="mt-1 truncate text-[11px] leading-tight text-slate-500">{sub}</p>}
      </div>
      <Icon size={15} strokeWidth={1.75} className={cn("mt-0.5 shrink-0", kpiTones[tone].glyph)} />
    </div>
  );
  if (bare) return <div className="px-4 py-3.5">{inner}</div>;
  return <Card className="p-5">{inner}</Card>;
}

/**
 * One inline fact in the "today at a glance" pulse strip.
 *
 * Deliberately smaller and quieter than a KPI: the strip is context about right
 * now, the KPI row beneath it is the school's standing data. A single tone dot
 * is the only color it carries.
 */
export function PulseFact({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: React.ReactNode;
  tone?: KpiTone;
}) {
  return (
    <div className="ss-fact">
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", kpiTones[tone].dot)} />
      <span className="ss-fact-label">{label}</span>
      <span className="ss-fact-value">{value}</span>
    </div>
  );
}

/**
 * A "needs your attention" row: links to the module that resolves it.
 * Borderless by design — rows sit inside one divided panel (see the dashboard),
 * so a list of six does not read as six cards.
 */
export function AttentionRow({
  icon: Icon,
  label,
  count,
  href,
  tone = "amber",
}: {
  icon: LucideIcon;
  label: string;
  count: number;
  href: string;
  tone?: KpiTone;
}) {
  // An operational queue row: neutral glyph, one soft tinted count chip, one
  // arrow. The warning colors are restrained on purpose — a queue of four
  // items should read as "to do", not as four alarms.
  return (
    <Link href={href} className="group ss-row ss-row-hover">
      <Icon size={15} strokeWidth={1.75} className="shrink-0 text-slate-400 transition-colors group-hover:text-slate-600" />
      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-slate-700">{label}</span>
      <span className={cn("shrink-0 rounded-md px-1.5 py-px text-[11px] font-semibold tabular-nums", kpiTones[tone].tile)}>
        {count}
      </span>
      <ChevronRight size={15} className="shrink-0 text-slate-300 transition-all group-hover:translate-x-0.5 group-hover:text-slate-500" />
    </Link>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
      <div>
        <h1 className="ss-page-title text-xl font-extrabold tracking-tight text-slate-900">{title}</h1>
        {subtitle && <p className="ss-page-sub mt-1 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
      {message}
    </div>
  );
}
