"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Building2, ChevronDown, ChevronLeft, LayoutGrid, LogOut, UserRound, X } from "lucide-react";
import { api } from "@/lib/client";
import { cn, initials } from "@/lib/utils";
import { sectorForRole } from "@/lib/sectors";
import { NAVS, NOTIFICATIONS_HREF, PROFILE_HREF, type NavItem } from "@/components/nav";
import { appMoreItemsFor, appTabsFor } from "@/components/app-nav";
import { useMe, type Me } from "@/components/Shell";
import { NotificationBell } from "@/components/NotificationBell";
import styles from "./AppShell.module.css";

/**
 * The app shell for the Teacher App and the Parents App.
 *
 * A modern, app-shaped chrome instead of a desktop sidebar:
 *   • ≥1024px — a slim left ICON RAIL (72px) that widens to labels on hover or
 *     focus, an "All destinations" panel for anything not on the rail, and a
 *     slim top bar for the bell and the account menu.
 *   • <1024px — a BOTTOM TAB BAR (the primary destinations + More) and the same
 *     top bar, with the device's safe-area insets respected.
 *
 * Additive by construction: it imports `useMe`/`Me` from the existing `Shell`
 * and reuses `NotificationBell` and the shared registry in `nav.ts` — none of
 * which is modified. The admin/super sectors keep rendering `Shell` untouched.
 */
export function AppShell({ role, children }: { role: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const { me, loading } = useMe();
  const [moreOpen, setMoreOpen] = useState(false);
  const [allOpen, setAllOpen] = useState(false);
  // The phone bar is gated in JS as well as CSS, so at desktop widths it is not
  // in the DOM at all (only the rail is). "Unknown" until measured, so the
  // server render — and the first client frame — carry neither.
  const [phone, setPhone] = useState<"unknown" | "yes" | "no">("unknown");

  useEffect(() => {
    const mq = window.matchMedia("(min-width: 1024px)");
    const sync = () => setPhone(mq.matches ? "no" : "yes");
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  const effRole = me?.user?.role || role;
  const app = sectorForRole(effRole);
  const sectorKey = app?.key;
  // Both phone-first apps (Teacher App, Parents App) share the one native-app
  // chrome: dark bar, back affordance below the root, no marketing footer, and
  // the inset content background. The admin/super sectors never render this
  // shell — they keep the shared `Shell` untouched.
  const isApp = effRole === "TEACHER" || effRole === "GUARDIAN";

  const tabs = useMemo(() => appTabsFor(effRole), [effRole]);
  const more = useMemo(() => appMoreItemsFor(effRole), [effRole]);
  const all = useMemo(() => NAVS[effRole] || [], [effRole]);

  // "You are here" — longest-prefix match across every destination, exactly as
  // the old sidebar resolved it (so "/teacher" never swallows "/teacher/ai").
  const active = useMemo(() => {
    const every = [...tabs, ...more];
    const matches = every.filter((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
    return matches.sort((a, b) => b.href.length - a.href.length)[0]?.href || "";
  }, [pathname, tabs, more]);

  const moreActive = more.some((n) => n.href === active);
  const activeLabel = [...tabs, ...more].find((n) => n.href === active)?.label;

  // The app bar: the school as the title on the root screen, and the screen's
  // own name with the school beneath it once you are below the root.
  const rootHref = app?.home || "/";
  const atRoot = pathname === rootHref;
  const barTitle = isApp
    ? atRoot
      ? me?.school?.name || app?.app || "Amar E School"
      : activeLabel || app?.app || "Teacher App"
    : activeLabel || me?.school?.name || app?.app || "Amar E School";
  const barSub = isApp
    ? atRoot
      ? app?.app || "Teacher App"
      : me?.school?.name || ""
    : me?.school?.name || app?.app || effRole.replace("_", " ");

  if (loading) {
    return <ShellSkeleton sectorKey={sectorKey} dark={isApp} />;
  }

  return (
    <div className={cn("min-h-screen", isApp ? "bg-[#F6F7FB]" : "bg-white")} data-sector={sectorKey}>
      {/* ------------------------------ desktop icon rail ------------------------------ */}
      <aside
        className={cn(
          styles.rail,
          "ss-app-rail no-print fixed inset-y-0 left-0 z-40 hidden w-[72px] flex-col overflow-hidden bg-slate-900 transition-[width] duration-200 hover:w-60 focus-within:w-60 lg:flex"
        )}
        aria-label={app ? `${app.app} navigation` : "Navigation"}
      >
        <Link href={app?.home || "/"} className="flex items-center gap-3 px-4 py-4">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-white/95 ring-1 ring-white/10">
            {me?.school?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={me.school.logoUrl} alt="" className="max-h-full max-w-full object-contain p-0.5" />
            ) : (
              <span className="flex h-full w-full items-center justify-center brand-bg text-white">
                <Building2 size={18} />
              </span>
            )}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-[13px] font-semibold text-white">
              {me?.school?.name || app?.app || "Amar E School"}
            </span>
            <span className={cn(styles.railLabel, "block text-[10px] font-medium uppercase tracking-[0.09em] text-slate-400")}>
              {app?.app || effRole.replace("_", " ")}
            </span>
          </span>
        </Link>

        <nav className="flex-1 space-y-1 px-2 py-2">
          {tabs.map((item) => (
            <RailLink key={item.href} item={item} active={active === item.href} />
          ))}
        </nav>

        <div className="border-t border-white/10 p-2">
          <button
            type="button"
            onClick={() => setAllOpen(true)}
            className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold text-slate-300 transition hover:bg-white/10 hover:text-white"
          >
            <LayoutGrid size={18} className="shrink-0" />
            <span className={styles.railLabel}>All destinations</span>
          </button>
        </div>
      </aside>

      {/* ------------------------------ content column ------------------------------ */}
      <div
        className={cn(
          "ss-app-content flex min-h-screen flex-col",
          styles.content,
          isApp && styles.contentApp,
        )}
      >
        <header
          className={cn(
            "no-print sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-3 backdrop-blur md:px-5",
            // The app bar is the reference mockup's dark navy chrome; the
            // admin/super sectors keep the original light bar untouched.
            isApp ? "border-white/10 bg-[#0F172A]" : "border-slate-200 bg-white/85",
          )}
        >
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            {isApp && !atRoot ? (
              // A native bar carries a back affordance on every screen below the
              // root. The rail (desktop) and the tab bar (phone) already own
              // primary navigation, so this only walks back to the app root.
              <Link
                href={rootHref}
                aria-label="Back"
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-200 transition active:bg-white/10"
              >
                <ChevronLeft size={20} />
              </Link>
            ) : me?.school?.logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={me.school.logoUrl} alt="" className="h-8 w-8 rounded-lg object-contain lg:hidden" />
            ) : (
              <span className="flex h-8 w-8 items-center justify-center rounded-lg brand-bg text-xs font-bold text-white lg:hidden">
                {me?.school ? initials(me.school.name) : <Building2 size={15} />}
              </span>
            )}
            <div className="min-w-0">
              <div className={cn("truncate text-sm font-bold", isApp ? "text-white" : "text-slate-800")}>
                {barTitle}
              </div>
              <div className="hidden truncate text-[11px] uppercase tracking-widest text-slate-400 sm:block">{barSub}</div>
            </div>
          </div>

          {me?.user && (
            <div className="flex items-center gap-2">
              <NotificationBell
                viewAllHref={NOTIFICATIONS_HREF[effRole] || "/teacher/notifications"}
                appearance={isApp ? "dark" : "light"}
              />
              <AccountMenu me={me} role={effRole} appearance={isApp ? "dark" : "light"} />
            </div>
          )}
        </header>

        <main className={cn("flex-1", isApp ? "px-4 py-4 md:px-8 md:py-6" : "px-4 py-6 md:px-8")}>
          {children}
        </main>

        {/* The apps have no footer: a marketing strip inside an app is a
            website tell, and the phone tab bar already reserves the space. */}
        {!isApp && (
          <footer className="no-print border-t border-slate-200 px-6 py-4 text-center text-xs text-slate-400">
            {app ? `${app.app} · ` : ""}Amar E School · Multi-Tenant SaaS
          </footer>
        )}
      </div>

      {/* ------------------------------ phone bottom tab bar ------------------------------ */}
      {phone === "yes" && !allOpen && (
        <nav
          aria-label={app ? `${app.app} tabs` : "Primary"}
          className={cn(
            styles.tabbar,
            "ss-app-tabbar no-print fixed inset-x-0 bottom-0 z-[55] rounded-t-2xl border-t border-[#E2E8F0] bg-white"
          )}
        >
          <div className="mx-auto flex h-16 max-w-lg items-stretch">
            {tabs.map((item) => (
              <TabBarLink key={item.href} item={item} active={active === item.href} />
            ))}
            <button
              type="button"
              onClick={() => setMoreOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={moreOpen}
              className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 py-1.5"
            >
              <span
                className="flex h-7 w-14 items-center justify-center rounded-full transition-colors"
                style={
                  moreActive || moreOpen
                    ? { background: "rgb(var(--brand, 79 70 229) / 0.12)", color: "rgb(var(--brand, 79 70 229))" }
                    : { color: "#94A3B8" }
                }
              >
                <LayoutGrid size={20} />
              </span>
              <span
                className="w-full truncate text-center text-[10px] font-semibold leading-none"
                style={moreActive || moreOpen ? { color: "rgb(var(--brand, 79 70 229))" } : { color: "#64748B" }}
              >
                More
              </span>
            </button>
          </div>
        </nav>
      )}

      {moreOpen && (
        <BottomSheet title="More" onClose={() => setMoreOpen(false)} panelClass="max-h-[85vh]">
          <div className="grid grid-cols-4 gap-2.5 px-4 pb-3 pt-1">
            {more.map((item) => (
              <SheetTile key={item.href} item={item} active={active === item.href} onClick={() => setMoreOpen(false)} />
            ))}
          </div>
          <div className="px-4 pb-3">
            <SheetSignOut />
          </div>
        </BottomSheet>
      )}

      {allOpen && (
        <BottomSheet title="All destinations" onClose={() => setAllOpen(false)} panelClass="max-h-[88vh]">
          <div className="grid grid-cols-2 gap-2.5 px-4 pb-3 pt-1 sm:grid-cols-3">
            {all.map((item) => (
              <SheetTile key={item.href} item={item} active={active === item.href} onClick={() => setAllOpen(false)} />
            ))}
          </div>
          <div className="px-4 pb-3">
            <SheetSignOut />
          </div>
        </BottomSheet>
      )}
    </div>
  );
}

/** A single rail row: the icon stays put, the label fades in as the rail widens. */
function RailLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-colors",
        active ? "brand-bg text-white shadow-md" : "text-slate-300 hover:bg-white/10 hover:text-white"
      )}
    >
      <item.icon size={18} className={cn("shrink-0", !active && "text-slate-400")} />
      <span className={styles.railLabel}>{item.label}</span>
    </Link>
  );
}

/** A bottom-tab item: the icon sits in a pill that fills with the brand tint. */
function TabBarLink({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? "page" : undefined}
      className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 py-1.5"
    >
      <span
        className="flex h-7 w-14 items-center justify-center rounded-full transition-colors"
        style={
          active
            ? { background: "rgb(var(--brand, 79 70 229) / 0.12)", color: "rgb(var(--brand, 79 70 229))" }
            : { color: "#94A3B8" }
        }
      >
        <item.icon size={20} />
      </span>
      <span
        className="w-full truncate text-center text-[10px] font-semibold leading-none"
        style={active ? { color: "rgb(var(--brand, 79 70 229))" } : { color: "#64748B" }}
      >
        {item.label}
      </span>
    </Link>
  );
}

/** One destination tile inside a sheet. */
function SheetTile({ item, active, onClick }: { item: NavItem; active: boolean; onClick: () => void }) {
  return (
    <Link
      href={item.href}
      onClick={onClick}
      aria-current={active ? "page" : undefined}
      className={cn(
        "flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-2xl border bg-white px-1 py-2.5 text-center transition",
        active ? "border-transparent" : "border-[#E2E8F0] hover:border-slate-300"
      )}
      style={active ? { borderColor: "rgb(var(--brand, 79 70 229) / 0.45)" } : undefined}
    >
      <span
        className="flex h-10 w-10 items-center justify-center rounded-xl"
        style={
          active
            ? { background: "rgb(var(--brand, 79 70 229) / 0.12)", color: "rgb(var(--brand, 79 70 229))" }
            : { background: "#F1F5F9", color: "#475569" }
        }
      >
        <item.icon size={19} />
      </span>
      <span
        className="line-clamp-2 text-[10.5px] font-semibold leading-tight"
        style={active ? { color: "rgb(var(--brand, 79 70 229))" } : undefined}
      >
        {item.label}
      </span>
    </Link>
  );
}

/**
 * A bottom sheet used for both the phone "More" and the desktop "All
 * destinations" panel. Escape closes; the page behind cannot scroll; focus is
 * trapped while open and returned to the trigger on close.
 */
function BottomSheet({
  title,
  onClose,
  children,
  panelClass,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  panelClass?: string;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    sheetRef.current?.focus();
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = sheetRef.current;
    if (!root) return;
    const focusables = root.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const current = document.activeElement;
    if (e.shiftKey && (current === first || current === root)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && current === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="no-print fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />
      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          styles.sheetIn,
          "absolute inset-x-0 bottom-0 mx-auto w-full overflow-y-auto rounded-t-3xl border-t border-[#E2E8F0] bg-[#F8FAFC] shadow-2xl outline-none sm:max-w-xl",
          panelClass
        )}
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300" aria-hidden="true" />
        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-200/70"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Sign out — same endpoint and destination as every other sign-out in the app. */
function SheetSignOut() {
  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    try {
      sessionStorage.removeItem("ss_me_v1");
    } catch {
      /* private mode / quota — sign-out must still complete */
    }
    window.location.href = "/login";
  };
  return (
    <button
      type="button"
      onClick={signOut}
      className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl border border-[#E2E8F0] bg-white px-4 text-[14px] font-semibold text-rose-600 transition hover:bg-rose-50"
    >
      <LogOut size={16} /> Sign out
    </button>
  );
}

/**
 * The header account menu: account details, the guardian's linked child, a
 * profile shortcut and sign-out — the same information the old header menu
 * showed, presented for the app bar.
 */
function AccountMenu({
  me,
  role,
  appearance = "light",
}: {
  me: Me;
  role: string;
  /** Trigger-only variant, for the Teacher App's dark bar. Panel stays light. */
  appearance?: "light" | "dark";
}) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const user = me.user;
  const student = me.student;
  const dark = appearance === "dark";

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const profileHref = PROFILE_HREF[role] || "/";
  const signOut = async () => {
    setOpen(false);
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    try {
      sessionStorage.removeItem("ss_me_v1");
    } catch {
      /* ignore */
    }
    window.location.href = "/login";
  };

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        className={cn(
          "flex items-center gap-2 rounded-xl p-1 pr-2 transition",
          dark ? cn("hover:bg-white/10", open && "bg-white/10") : cn("hover:bg-slate-100", open && "bg-slate-100"),
        )}
      >
        <span
          className={cn(
            "flex h-9 w-9 items-center justify-center rounded-full brand-bg text-xs font-bold text-white",
            dark && "ring-2 ring-white/20",
          )}
        >
          {initials(user.name)}
        </span>
        <ChevronDown
          size={15}
          className={cn("transition", dark ? "text-slate-300" : "text-slate-400", open && "rotate-180")}
        />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-12 z-50 w-72 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl fade-up">
          <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full brand-bg text-sm font-bold text-white">
              {initials(user.name)}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-slate-800">{user.name}</div>
              <div className="truncate text-[11px] text-slate-400">{user.email || user.phone || role.replace("_", " ")}</div>
            </div>
          </div>

          {me.school && (
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-2.5 text-xs">
              <span className="text-slate-400">School</span>
              <span className="truncate font-semibold text-slate-700">{me.school.name}</span>
            </div>
          )}

          {student && (
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Linked child</div>
              <div className="mt-2 flex items-center gap-3">
                {student.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={student.photoUrl} alt="" className="h-9 w-9 rounded-lg object-cover" />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-[10px] font-bold text-indigo-600">
                    {initials(student.name)}
                  </div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-xs font-bold text-slate-800">{student.name}</div>
                  <div className="truncate text-[11px] text-slate-400">
                    {[student.classRoom?.name, student.section?.name].filter(Boolean).join(" / ") || student.admissionNo}
                  </div>
                </div>
              </div>
            </div>
          )}

          <div className="p-1.5">
            <Link
              href={profileHref}
              onClick={() => setOpen(false)}
              className="flex items-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-semibold text-slate-600 transition hover:bg-slate-100"
            >
              <UserRound size={16} className="text-slate-400" /> {role === "GUARDIAN" ? "My profile" : "Profile & settings"}
            </Link>
            <button
              onClick={signOut}
              className="flex w-full items-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-semibold text-rose-600 transition hover:bg-rose-50"
            >
              <LogOut size={16} /> Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** First-paint shape: the chrome is on screen before the session resolves. */
function ShellSkeleton({ sectorKey, dark = false }: { sectorKey?: string; dark?: boolean }) {
  return (
    <div className={cn("min-h-screen", dark ? "bg-[#F6F7FB]" : "bg-white")} data-sector={sectorKey}>
      <div className={cn("mx-auto flex min-h-screen max-w-3xl flex-col", styles.content)}>
        <header
          className={cn(
            "sticky top-0 z-30 flex h-14 items-center gap-3 border-b px-4 backdrop-blur",
            dark ? "border-white/10 bg-[#0F172A]" : "border-slate-200 bg-white/85",
          )}
        >
          <div className={cn("h-8 w-8 rounded-lg", dark ? "bg-white/10" : "bg-slate-100")} />
          <div className={cn("h-3 w-28 rounded", dark ? "bg-white/15" : "bg-slate-200")} />
          <div className={cn("ml-auto h-8 w-8 rounded-full", dark ? "bg-white/10" : "bg-slate-100")} />
        </header>
        <main className="flex-1 px-4 py-6">
          <div className="space-y-3">
            <div className="h-6 w-40 rounded bg-slate-200" />
            <div className="h-24 rounded-2xl bg-slate-100" />
            <div className="h-24 rounded-2xl bg-slate-100" />
          </div>
        </main>
      </div>
    </div>
  );
}
