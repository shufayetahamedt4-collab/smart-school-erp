import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { ChevronRight, RefreshCw, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The Teacher App's mobile UI kit.
 *
 * The app palette (brand violet, pastel tiles) is the same one the portal
 * already used — what changes here is the *shape* of the UI: inset list rows on
 * one white surface instead of a bordered card each, pastel stat tiles instead
 * of a scrolling stat row, segmented pills instead of a tab strip.
 *
 * Presentational only: nothing here fetches, navigates on its own, or holds
 * state beyond what the caller passes in. Callers keep their own data bindings.
 */

export type Tone = "indigo" | "violet" | "emerald" | "amber" | "sky" | "rose" | "slate";

/** Pastel chip behind an icon. */
const TILE: Record<Tone, string> = {
  indigo: "bg-indigo-50 text-indigo-600",
  violet: "bg-violet-50 text-violet-600",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  sky: "bg-sky-50 text-sky-600",
  rose: "bg-rose-50 text-rose-600",
  slate: "bg-slate-100 text-slate-600",
};

/** A whole pastel surface (stat tile, quick action). */
const SOFT: Record<Tone, string> = {
  indigo: "bg-indigo-50",
  violet: "bg-violet-50",
  emerald: "bg-emerald-50",
  amber: "bg-amber-50",
  sky: "bg-sky-50",
  rose: "bg-rose-50",
  slate: "bg-slate-50",
};

/** Ink that reads on the matching pastel surface. */
const INK: Record<Tone, string> = {
  indigo: "text-indigo-700",
  violet: "text-violet-700",
  emerald: "text-emerald-700",
  amber: "text-amber-700",
  sky: "text-sky-700",
  rose: "text-rose-700",
  slate: "text-slate-700",
};

export function IconTile({
  icon: Icon,
  tone = "indigo",
  className,
}: {
  icon: LucideIcon;
  tone?: Tone;
  className?: string;
}) {
  return (
    <span
      className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-xl", TILE[tone], className)}
      aria-hidden
    >
      <Icon size={18} />
    </span>
  );
}

/** One white surface holding hairline-separated rows. */
export function ListCard({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <ul className={cn("divide-y divide-slate-100 overflow-hidden rounded-2xl bg-white ring-1 ring-slate-900/5", className)}>
      {children}
    </ul>
  );
}

/**
 * A single row. Tapping anywhere in the row performs the action, which is the
 * native idiom — the row is the button, not a control inside it.
 *
 * Titles clamp to two lines rather than truncating: real names and titles are
 * longer than a mockup's, and hiding half of one is worse than wrapping it. The
 * `min-w-0` is what lets the text column shrink instead of forcing the row wide.
 */
export function ListRow({
  href,
  onClick,
  icon,
  tone = "indigo",
  title,
  subtitle,
  trailing,
  chevron = true,
}: {
  href?: string;
  onClick?: () => void;
  icon?: LucideIcon;
  tone?: Tone;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  chevron?: boolean;
}) {
  const inner = (
    <>
      {icon && <IconTile icon={icon} tone={tone} />}
      <span className="min-w-0 flex-1">
        <span className="block line-clamp-2 text-[14px] font-bold leading-snug text-slate-800">{title}</span>
        {subtitle ? <span className="mt-0.5 block line-clamp-2 text-[12px] leading-snug text-slate-400">{subtitle}</span> : null}
      </span>
      {trailing}
      {/* A chevron promises navigation, so a row that neither links nor acts must
          not carry one. */}
      {!trailing && chevron && (href || onClick) ? (
        <ChevronRight size={17} className="shrink-0 text-slate-300" aria-hidden />
      ) : null}
    </>
  );

  const cls = "flex w-full items-center gap-3 px-3.5 py-3 text-left transition";

  return (
    <li>
      {href ? (
        <Link href={href} className={cn(cls, "active:bg-slate-50")}>
          {inner}
        </Link>
      ) : onClick ? (
        <button type="button" onClick={onClick} className={cn(cls, "active:bg-slate-50")}>
          {inner}
        </button>
      ) : (
        // Neither a link nor an action: purely informational. Rendering a
        // <button> here would be a control that does nothing.
        <div className={cls}>{inner}</div>
      )}
    </li>
  );
}

/**
 * A white inset surface for content that is not a list — a form, a panel, a
 * summary block. `ListCard` is a `<ul>`, so anything that is not list content
 * needs its own surface to sit on the same visual plane.
 */
export function Surface({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("rounded-2xl bg-white p-4 ring-1 ring-slate-900/5", className)}>{children}</div>;
}

/** Solid brand pill on a light track — the mock's primary segment control. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  className,
  label,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (next: T) => void;
  className?: string;
  label?: string;
}) {
  return (
    <div role="tablist" aria-label={label} className={cn("flex gap-1 rounded-full bg-slate-100 p-1", className)}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={on}
            onClick={() => onChange(o.value)}
            className={cn(
              // min-h-11: a segment is a real touch target, not a 34px text chip.
              "flex min-h-11 flex-1 items-center justify-center rounded-full px-3 text-[13px] font-bold transition-colors",
              on ? "brand-bg text-white shadow-sm" : "text-slate-500 hover:text-slate-700",
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A 2×2 dashboard tile: pastel surface, icon chip, big number, label. */
export function OverviewTile({
  icon: Icon,
  tone,
  value,
  label,
  sub,
}: {
  icon: LucideIcon;
  tone: Tone;
  value: React.ReactNode;
  label: string;
  sub?: string;
}) {
  return (
    <div className={cn("rounded-2xl p-3.5", SOFT[tone])}>
      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-white/80">
        <Icon size={16} className={INK[tone]} aria-hidden />
      </span>
      <div className={cn("mt-2 text-[22px] font-extrabold leading-none", INK[tone])}>{value}</div>
      <div className="mt-1 text-[10.5px] font-bold uppercase tracking-[0.06em] text-slate-500">{label}</div>
      {sub ? <div className="mt-0.5 text-[11px] leading-snug text-slate-400">{sub}</div> : null}
    </div>
  );
}

/** A pastel icon action in the quick-actions grid. */
export function QuickAction({
  href,
  icon: Icon,
  tone,
  label,
}: {
  href: string;
  icon: LucideIcon;
  tone: Tone;
  label: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-2xl px-2 py-3.5 text-center transition active:scale-[0.98]",
        SOFT[tone],
      )}
    >
      <Icon size={20} className={INK[tone]} aria-hidden />
      <span className={cn("text-[11px] font-bold leading-tight", INK[tone])}>{label}</span>
    </Link>
  );
}

/**
 * Section title with an optional "View all" hand-off.
 *
 * `className` is an additive hook so a caller can neutralise the leading margin
 * when the header is the FIRST block on a page (the `mt-5` is meant for headers
 * BETWEEN blocks; as a first child its margin collapses out of the page root and
 * adds dead space above the screen). Nothing about the default rendering changes.
 */
export function SectionHeader({
  title,
  actionHref,
  actionLabel,
  className,
}: {
  title: string;
  actionHref?: string;
  actionLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn("mb-2 mt-5 flex items-end justify-between px-1", className)}>
      <h2 className="text-[13px] font-extrabold uppercase tracking-[0.05em] text-slate-500">{title}</h2>
      {actionHref && actionLabel ? (
        // min-h-11 gives the hand-off a real touch target; the matching negative
        // margin keeps the header's own line height exactly as it was.
        <Link
          href={actionHref}
          className="-my-3 flex min-h-11 items-center px-1 text-[12px] font-bold text-indigo-600"
        >
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  hint,
  actionHref,
  actionLabel,
}: {
  icon: LucideIcon;
  title: string;
  hint?: string;
  actionHref?: string;
  actionLabel?: string;
}) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl bg-white px-6 py-10 text-center ring-1 ring-slate-900/5">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-slate-100 text-slate-400" aria-hidden>
        <Icon size={20} />
      </span>
      <p className="text-[14px] font-bold text-slate-700">{title}</p>
      {hint ? <p className="max-w-[26ch] text-[12px] leading-snug text-slate-400">{hint}</p> : null}
      {actionHref && actionLabel ? (
        // min-h-11: `.btn-sm` is 33px, which is under the app's touch minimum.
        <Link href={actionHref} className="btn btn-primary btn-sm mt-1 min-h-11">
          {actionLabel}
        </Link>
      ) : null}
    </div>
  );
}

/** A read that failed — never leave the user on a spinner that never resolves. */
export function ErrorState({ message, onRetry }: { message?: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-2xl bg-white px-6 py-10 text-center ring-1 ring-slate-900/5">
      <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-rose-50 text-rose-500" aria-hidden>
        <TriangleAlert size={20} />
      </span>
      <p className="text-[14px] font-bold text-slate-700">Couldn&apos;t load this</p>
      <p className="max-w-[30ch] text-[12px] leading-snug text-slate-400">{message || "Something went wrong on the way to the server."}</p>
      {onRetry ? (
        // min-h-11: `.btn-sm` is 33px. A retry control the user has to hit after a
        // failure is exactly the wrong place to fall under the touch minimum.
        <button type="button" onClick={onRetry} className="btn btn-secondary btn-sm mt-1 min-h-11">
          <RefreshCw size={14} /> Try again
        </button>
      ) : null}
    </div>
  );
}
