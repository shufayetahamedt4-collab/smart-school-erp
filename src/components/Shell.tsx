"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Crown, GraduationCap, LogOut, Menu, X, UserRound, ChevronDown, ChevronRight } from "lucide-react";
import { api, prefetch } from "@/lib/client";
import { cn, initials } from "@/lib/utils";
import { sectorForRole } from "@/lib/sectors";
import type { InstitutionType } from "@/lib/institution";
import { dataForRoute, warmListForSector } from "@/lib/route-data";
import { NAVS, NOTIFICATIONS_HREF, PROFILE_HREF, groupNavFor, type NavGroup, type NavItem } from "./nav";
import { PageSkeleton } from "./PageSkeleton";
import { NotificationBell } from "./NotificationBell";

export interface Me {
  user: {
    id: string;
    name: string;
    email: string | null;
    phone?: string | null;
    photoUrl?: string | null;
    role: string;
    schoolId: string | null;
    studentId?: string;
    /** multi-branch (PRD §12.3) */
    scope?: "SCHOOL" | "BRANCH" | null;
    branchId?: string | null;
    branch?: { id: string; name: string; code?: string | null; enabled?: boolean } | null;
  };
  school: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    plan: string;
    status: string;
    themeColor?: string | null;
    /** Tenant shape (docs/COLLEGE-DECISIONS.md). Absent = SCHOOL. */
    institutionType?: InstitutionType | null;
  } | null;
  student?: {
    id: string;
    name: string;
    admissionNo: string;
    photoUrl: string | null;
    classRoom?: { name: string } | null;
    section?: { name: string } | null;
  } | null;
}

/** PRD §12.2 white-label: paint the UI with the school's brand color. */
export function applyBrandColor(themeColor?: string | null) {
  if (typeof document === "undefined" || !themeColor) return;
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(themeColor).trim());
  if (!m) return;
  const n = parseInt(m[1], 16);
  document.documentElement.style.setProperty("--brand", `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`);
}

/** Persisted open/closed state of the grouped sidebar sections. */
const NAV_GROUPS_KEY = "ss_nav_groups_v1";

/**
 * Header account menu (replaces the old decorative avatar): account details,
 * the guardian's linked child, a profile shortcut and sign-out.
 */
function AccountMenu({ me, role, onSignOut }: { me: Me | null; role: string; onSignOut: () => void }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const user = me?.user;
  const student = me?.student;

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

  if (!user) return null;
  const qrSession = user.id.startsWith("qr-");
  const profileHref = PROFILE_HREF[role] || "/";

  return (
    <div className="relative" ref={boxRef}>
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        title="Account menu"
        className={cn("flex items-center gap-2 rounded-xl p-1 pr-2 transition hover:bg-slate-100", open && "bg-slate-100")}
      >
        <div className="flex h-9 w-9 items-center justify-center rounded-full brand-bg text-xs font-bold text-white">{initials(user.name)}</div>
        <div className="hidden text-left md:block">
          <div className="text-xs font-bold text-slate-800">{user.name}</div>
          <div className="text-[11px] text-slate-400">{user.email || user.phone || role.replace("_", " ")}</div>
        </div>
        <ChevronDown size={15} className={cn("hidden text-slate-400 transition md:block", open && "rotate-180")} />
      </button>

      {open && (
        <div role="menu" className="absolute right-0 top-12 z-50 w-72 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-xl fade-up">
          <div className="flex items-center gap-3 border-b border-slate-100 px-4 py-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-full brand-bg text-sm font-bold text-white">{initials(user.name)}</div>
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-slate-800">{user.name}</div>
              <div className="truncate text-[11px] text-slate-400">{user.email || "No email on file"}</div>
            </div>
          </div>

          <div className="space-y-2 border-b border-slate-100 px-4 py-3 text-xs">
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-400">Role</span>
              <span className="font-semibold text-slate-700">{role.replace("_", " ")}</span>
            </div>
            {user.phone && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">Phone</span>
                <span className="font-semibold text-slate-700">{user.phone}</span>
              </div>
            )}
            {me?.school && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">School</span>
                <span className="truncate font-semibold text-slate-700">{me.school.name}</span>
              </div>
            )}
            {user.scope === "BRANCH" && user.branch && (
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">Branch</span>
                <span className="truncate font-semibold text-slate-700">{user.branch.name}</span>
              </div>
            )}
            <div className="flex items-center justify-between gap-3">
              <span className="text-slate-400">Sign-in</span>
              <span className="font-semibold text-slate-700">{qrSession ? "QR code" : "Email & password"}</span>
            </div>
          </div>

          {student && (
            <div className="border-b border-slate-100 px-4 py-3">
              <div className="text-[10px] font-bold uppercase tracking-widest text-slate-400">Linked child</div>
              <div className="mt-2 flex items-center gap-3">
                {student.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={student.photoUrl} alt="" className="h-9 w-9 rounded-lg object-cover" />
                ) : (
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-[10px] font-bold text-indigo-600">{initials(student.name)}</div>
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
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
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

/**
 * The session payload, kept for the tab. Without it a reload replaces the whole
 * screen with the chrome skeleton while `/api/auth/me` resolves; with it the
 * sidebar and header are already on screen and the read only refreshes them.
 * Cleared on sign-out and on a 401 so a previous account's chrome can never
 * outlive its session.
 */
const ME_CACHE_KEY = "ss_me_v1";

function readCachedMe(): Me | null {
  try {
    const raw = sessionStorage.getItem(ME_CACHE_KEY);
    return raw ? (JSON.parse(raw) as Me) : null;
  } catch {
    return null;
  }
}

function writeCachedMe(me: Me | null): void {
  try {
    if (me) sessionStorage.setItem(ME_CACHE_KEY, JSON.stringify(me));
    else sessionStorage.removeItem(ME_CACHE_KEY);
  } catch {
    /* private mode / quota — the cache is an optimisation, never a dependency */
  }
}

export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const data = await api<Me>("/api/auth/me");
      setMe(data);
      writeCachedMe(data);
      applyBrandColor(data?.school?.themeColor);
      setError(null);
    } catch (e: any) {
      if (e?.status === 401) {
        writeCachedMe(null);
        setMe(null);
        router.replace("/login");
        return;
      }
      setError(e?.message || "Failed to load session");
    } finally {
      setLoading(false);
    }
  }, [router]);

  // Paint the cached chrome on the first frame after hydration (never during
  // SSR, so the server HTML and the first client render still agree), then let
  // the network read below correct it.
  useEffect(() => {
    const cached = readCachedMe();
    if (!cached) return;
    setMe(cached);
    applyBrandColor(cached.school?.themeColor);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { me, loading, error, refresh };
}

export function Shell({ role, children }: { role: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const { me, loading } = useMe();
  const [drawer, setDrawer] = useState(false);
  const warmed = useRef(false);

  // The dashboard hosts several roles (SCHOOL_ADMIN, BRANCH_ADMIN, REGISTRAR,
  // ACCOUNTANT, LIBRARIAN, FRONT_DESK) — the sidebar always follows the
  // session's real role, not the layout's placeholder prop.
  const effRole = me?.user?.role || role;
  const nav = NAVS[effRole] || [];
  const user = me?.user;
  /** Which app is this shell? (each sector has its own name and nav) */
  const app = sectorForRole(effRole);
  const sectorKey = app?.key;

  // School Admin panel roles get the grouped sidebar; every other sector keeps
  // the original flat list, untouched.
  const groups = useMemo(() => groupNavFor(effRole), [effRole]);

  // Once the shell knows who is signed in, warm the rest of this app's reads in
  // the background — pre-paying them is what makes the *first* click on any
  // sidebar entry instant when a Firestore read costs 0.5–1.2s cold.
  //
  // This runs exactly ONCE per sign-in, is deferred until the browser is idle,
  // and drips one request at a time (see `prefetch`), so it never competes with
  // the page the user is looking at. It deliberately does NOT re-run on window
  // focus / tab re-show: that fired the whole batch again on every return to the
  // tab and collided with the page's own reads.
  // The session read gates this shell: the page below only mounts once `me`
  // resolves, so its own reads used to start a full round trip late. Start the
  // current screen's reads NOW — in the same wave as the session read — so the
  // page finds them already in flight or answered. Same machinery as the hover
  // warm, and it only issues reads the screen was about to issue anyway.
  useEffect(() => {
    prefetch(dataForRoute(pathname));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!me) return;
    const sector = sectorForRole(me.user.role);
    if (!sector) return;
    if (warmed.current) return;
    warmed.current = true;
    prefetch(warmListForSector(sector.key), 150);
  }, [me]);

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    writeCachedMe(null);
    router.replace("/login");
  };

  const active = useMemo(() => {
    // Segment-aware longest match — "/parent" must not swallow "/parent/profile".
    const matches = nav.filter((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
    return matches.sort((a, b) => b.href.length - a.href.length)[0]?.href || "/";
  }, [pathname, nav]);

  // First paint of a sector: draw the app chrome and the page's shape rather
  // than a lone centred spinner, so the frame is on screen the instant the
  // route loads and only the data fills in.
  if (loading) {
    return (
      <div className="min-h-screen bg-white" data-sector={sectorKey}>
        <aside className="ss-chrome fixed inset-y-0 left-0 z-40 hidden w-64 flex-col lg:flex">
          <div className="flex items-center gap-3 px-4 py-4">
            <div className="h-10 w-10 rounded-lg bg-white/10" />
            <div className="space-y-2">
              <div className="h-3 w-28 rounded bg-white/10" />
              <div className="h-2 w-20 rounded bg-white/[0.07]" />
            </div>
          </div>
          <div className="flex-1 space-y-2 px-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="h-9 rounded-lg bg-white/[0.06]" />
            ))}
          </div>
        </aside>
        <div className="flex min-h-screen flex-col lg:pl-64">
          <header className="ss-appbar sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur md:px-6">
            <div className="h-4 w-40 rounded bg-slate-200" />
            <div className="ml-auto flex items-center gap-2">
              <div className="h-8 w-8 rounded-full bg-slate-100" />
              <div className="h-9 w-9 rounded-full bg-slate-200" />
            </div>
          </header>
          <main className="flex-1 px-4 py-6 md:px-8">
            <PageSkeleton />
          </main>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-white" data-sector={sectorKey}>
      {/* desktop sidebar */}
      <aside className="ss-chrome no-print fixed inset-y-0 left-0 z-40 hidden w-64 flex-col lg:flex">
        <SidebarContent
          role={effRole}
          nav={nav}
          groups={groups}
          active={active}
          schoolName={me?.school?.name}
          schoolLogo={me?.school?.logoUrl}
          plan={me?.school?.plan}
          appLabel={app?.label}
          appShort={app?.app}
          onClose={() => setDrawer(false)}
        />
      </aside>

      {/* mobile drawer */}
      {drawer && (
        <div className="no-print fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside className="ss-chrome absolute inset-y-0 left-0 w-72 shadow-2xl">
            <SidebarContent
              role={effRole}
              nav={nav}
              groups={groups}
              active={active}
              schoolName={me?.school?.name}
              schoolLogo={me?.school?.logoUrl}
              plan={me?.school?.plan}
              appLabel={app?.label}
              appShort={app?.app}
              onClose={() => setDrawer(false)}
            />
          </aside>
        </div>
      )}

      {/* main */}
      <div className="flex min-h-screen flex-col lg:pl-64">
        <header className="ss-appbar no-print sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur md:px-6">
          <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={() => setDrawer(true)} aria-label="Open navigation">
            <Menu size={20} />
          </button>
          {/* Chrome, not content: the school's identity stays here, quietly, while
              the page header below carries the page's own context. */}
          <div className="min-w-0 flex-1">
            {me?.school ? (
              <div className="ss-appbar-name truncate text-sm font-bold text-slate-800">{me.school.name}</div>
            ) : (
              <div className="ss-appbar-name text-sm font-bold text-slate-800">Amar E School</div>
            )}
            <div className="ss-appbar-role hidden text-[11px] uppercase tracking-widest text-slate-400 sm:block">
              {app ? app.app : effRole.replace("_", " ")}
              {user?.scope === "BRANCH" && user?.branch && <span className="ml-1">· {user.branch.name}</span>}
              {/* The school panel surfaces the plan in its sidebar branding block,
                  so the header chip is only for the other sectors — same badge,
                  never shown twice. */}
              {!groups && me?.school?.plan && <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-600">{me.school.plan} plan</span>}
            </div>
          </div>

          {user && (
            <div className="flex items-center gap-2">
              <NotificationBell viewAllHref={NOTIFICATIONS_HREF[effRole] || "/dashboard/notifications"} />
              <AccountMenu me={me} role={effRole} onSignOut={logout} />
            </div>
          )}
        </header>

        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>

        <footer className="no-print border-t border-slate-200 px-6 py-4 text-center text-xs text-slate-400">
          {app ? `${app.app} · ` : ""}Amar E School · Multi-Tenant SaaS
        </footer>
      </div>
    </div>
  );
}

/**
 * The top branding block.
 *
 * `premium` is the School Admin panel variant: the school's own logo in a
 * protected, contrast-safe container (so wide, tall or tiny logos all stay
 * balanced and undistorted), a truncating school name, and the school's live
 * subscription plan. The plan chip renders ONLY when the school actually has a
 * plan — there is no placeholder and no fallback label.
 *
 * Every other sector passes `premium={false}` and gets the original block.
 */
function BrandingBlock({
  premium,
  role,
  schoolName,
  schoolLogo,
  plan,
  appLabel,
  appShort,
  onClose,
}: {
  premium: boolean;
  role: string;
  schoolName?: string;
  schoolLogo?: string | null;
  plan?: string | null;
  appLabel?: string;
  /** Short product name ("School Admin") for the compact premium rail. */
  appShort?: string;
  onClose: () => void;
}) {
  if (!premium) {
    return (
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl brand-bg text-lg font-black text-white shadow-lg">
          {role === "SUPER_ADMIN" ? <Crown size={20} /> : <GraduationCap size={20} />}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-extrabold text-white">
            {role === "SUPER_ADMIN" ? "Platform Console" : schoolName || appLabel || "Amar E School"}
          </div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400">{appLabel || "ERP Console"}</div>
        </div>
        <button className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 lg:hidden" onClick={onClose} aria-label="Close navigation">
          <X size={18} />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 px-4 pb-3 pt-4">
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white/95 ring-1 ring-white/10">
        {schoolLogo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={schoolLogo} alt="" className="max-h-full max-w-full object-contain p-0.5" />
        ) : (
          <span className="flex h-full w-full items-center justify-center brand-bg text-white">
            <GraduationCap size={18} />
          </span>
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[13px] font-semibold leading-tight text-white">{schoolName || appLabel || "Amar E School"}</div>
        <div className="mt-1 flex items-center gap-1.5">
          <span className="truncate text-[10px] font-medium uppercase tracking-[0.09em]" style={{ color: "var(--chrome-muted)" }}>
            {appShort || appLabel || "School Admin"}
          </span>
          {plan ? (
            <span
              className="shrink-0 rounded px-1.5 py-px text-[9px] font-bold uppercase tracking-[0.08em]"
              style={{ background: "rgb(var(--gold) / 0.16)", color: "#d9bd7c" }}
            >
              {plan}
            </span>
          ) : null}
        </div>
      </div>
      <button className="rounded-lg p-1.5 text-slate-400 hover:bg-white/10 lg:hidden" onClick={onClose} aria-label="Close navigation">
        <X size={18} />
      </button>
    </div>
  );
}

/** One sidebar link. `premium` renders the School Admin treatment; otherwise the original. */
function NavLink({ item, active, onClose, premium }: { item: NavItem; active: boolean; onClose: () => void; premium: boolean }) {
  const warm = () => prefetch(dataForRoute(item.href));

  if (premium) {
    return (
      <Link
        href={item.href}
        onClick={onClose}
        onMouseEnter={warm}
        onFocus={warm}
        onTouchStart={warm}
        aria-current={active ? "page" : undefined}
        className={cn(
          "ss-navlink relative flex items-center gap-2.5 rounded-lg py-1.5 pl-3 pr-2 text-[13px] transition-colors",
          active && "ss-navlink-active"
        )}
      >
        <item.icon size={15} className="shrink-0" />
        <span className="truncate">{item.label}</span>
        {/* Decorative only: the active pill reads as "you are here", so it carries
            the same right-hand affordance the reference uses. aria-hidden, no
            handler, no link — nothing about navigation changes. */}
        {active && <ChevronRight aria-hidden size={14} className="ml-auto shrink-0 opacity-80" />}
      </Link>
    );
  }

  return (
    <Link
      href={item.href}
      onClick={onClose}
      // Warm this page's reads the moment the pointer lands on it, so the click
      // renders from cache instead of showing its loader.
      onMouseEnter={warm}
      onFocus={warm}
      onTouchStart={warm}
      className={cn(
        "ss-navlink flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-all",
        active ? "brand-bg text-white shadow-md" : "text-slate-300 hover:bg-slate-800 hover:text-white"
      )}
    >
      <item.icon size={17} className={active ? "" : "text-slate-400"} />
      {item.label}
    </Link>
  );
}

/**
 * The sidebar body. School Admin panel roles pass `groups` and get collapsible
 * module sections; every other sector passes `nav` and keeps the flat list.
 */
function SidebarContent({
  role,
  nav,
  groups,
  active,
  schoolName,
  schoolLogo,
  plan,
  appLabel,
  appShort,
  onClose,
}: {
  role: string;
  nav: NavItem[];
  groups: NavGroup[] | null;
  active: string;
  schoolName?: string;
  schoolLogo?: string | null;
  plan?: string | null;
  appLabel?: string;
  appShort?: string;
  onClose: () => void;
}) {
  const premium = !!groups;
  const activeGroup = useMemo(
    () => (groups ? groups.find((g) => g.items.some((i) => i.href === active))?.key : undefined),
    [groups, active]
  );
  const [openKeys, setOpenKeys] = useState<string[]>(() => (activeGroup ? [activeGroup] : []));
  const [hydrated, setHydrated] = useState(false);

  // Restore the user's sections after mount (never during SSR, so the server and
  // first client render agree).
  useEffect(() => {
    let stored: string[] = [];
    try {
      const raw = window.localStorage.getItem(NAV_GROUPS_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) stored = parsed.filter((k) => typeof k === "string");
    } catch {
      /* ignore malformed storage */
    }
    setHydrated(true);
    setOpenKeys((prev) => Array.from(new Set([...stored, ...prev])));
  }, []);

  // The section a page belongs to is always open, however the user left it.
  useEffect(() => {
    if (!activeGroup) return;
    setOpenKeys((prev) => (prev.includes(activeGroup) ? prev : [...prev, activeGroup]));
  }, [activeGroup]);

  useEffect(() => {
    if (!hydrated) return;
    try {
      window.localStorage.setItem(NAV_GROUPS_KEY, JSON.stringify(openKeys));
    } catch {
      /* storage unavailable — the accordion still works for this session */
    }
  }, [openKeys, hydrated]);

  const toggle = (key: string) =>
    setOpenKeys((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  return (
    <div className="flex h-full flex-col">
      <BrandingBlock
        premium={premium}
        role={role}
        schoolName={schoolName}
        schoolLogo={schoolLogo}
        plan={plan}
        appLabel={appLabel}
        appShort={appShort}
        onClose={onClose}
      />

      <nav className="flex-1 overflow-y-auto px-3 pb-4">
        {groups ? (
          <div className="space-y-4 pt-1">
            {groups.map((group) => {
              const multi = group.items.length > 1;
              const isOpen = !multi || openKeys.includes(group.key);
              const hasActive = group.items.some((i) => i.href === active);
              const header = (
                <>
                  <span
                    aria-hidden
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md"
                    style={{ background: group.tint, color: group.accent }}
                  >
                    <group.icon size={13} />
                  </span>
                  <span
                    className="flex-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.09em]"
                    style={{ color: hasActive ? "#e6ecf5" : "var(--chrome-muted)" }}
                  >
                    {group.label}
                  </span>
                </>
              );
              return (
                <div key={group.key}>
                  {multi ? (
                    <button
                      type="button"
                      onClick={() => toggle(group.key)}
                      aria-expanded={isOpen}
                      className="ss-groupheader flex w-full items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-2 text-left"
                    >
                      {header}
                      <ChevronDown
                        size={13}
                        className={cn("shrink-0 transition-transform", isOpen && "rotate-180")}
                        style={{ color: "var(--chrome-muted)" }}
                      />
                    </button>
                  ) : (
                    <div className="flex w-full items-center gap-2 rounded-lg py-1.5 pl-1.5 pr-2">{header}</div>
                  )}
                  {isOpen && (
                    <div
                      className={cn(
                        "ml-[11px] mt-1 space-y-0.5 pl-2.5",
                        multi && "ss-childrail border-l"
                      )}
                    >
                      {group.items.map((item) => (
                        <NavLink key={item.href} item={item} active={active === item.href} onClose={onClose} premium />
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="space-y-1">
            {nav.map((item) => (
              <NavLink key={item.href} item={item} active={active === item.href} onClose={onClose} premium={false} />
            ))}
          </div>
        )}
      </nav>

      <div className="border-t border-white/10 p-4">
        <button
          onClick={async () => {
            await api("/api/auth/logout", { method: "POST" }).catch(() => null);
            writeCachedMe(null);
            window.location.href = "/login";
          }}
          className={cn(
            "flex w-full items-center justify-center gap-2 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition",
            premium
              ? "bg-white/[0.06] text-slate-300 hover:bg-white/[0.1] hover:text-white"
              : "bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white"
          )}
        >
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </div>
  );
}
