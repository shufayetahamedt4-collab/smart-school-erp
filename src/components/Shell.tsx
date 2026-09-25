"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Users,
  GraduationCap,
  BookOpen,
  CalendarDays,
  ClipboardList,
  Megaphone,
  Wallet,
  IdCard,
  FileText,
  MessageSquare,
  Settings,
  School,
  BarChart3,
  LogOut,
  Menu,
  X,

  ShieldCheck,
  Crown,
  Scale,
  CalendarX2,
  CalendarCheck,
  Images,
  Inbox,
  ArrowUpRight,
  Award,
  FolderOpen,
  CreditCard,
  BookUp,
  UserRound,
  UserCog,
  Building2,
  QrCode,
  ChevronDown,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, prefetch } from "@/lib/client";
import { cn, initials, classOf } from "@/lib/utils";
import { sectorForRole } from "@/lib/sectors";
import { dataForRoute, warmListForSector } from "@/lib/route-data";
import { PageSkeleton } from "./PageSkeleton";
import { NotificationBell } from "./NotificationBell";
import { ThemeToggle } from "./ThemeToggle";

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

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAVS: Record<string, NavItem[]> = {
  SUPER_ADMIN: [
    { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
    { href: "/admin/schools", label: "Schools", icon: School },
    { href: "/admin/billing", label: "Billing & Plans", icon: CreditCard },
    { href: "/admin/settings", label: "Global Settings", icon: Settings },
  ],
  SCHOOL_ADMIN: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/dashboard/students", label: "Students", icon: GraduationCap },
    { href: "/dashboard/teachers", label: "Teachers", icon: Users },
    { href: "/dashboard/classes", label: "Classes & Sections", icon: BookOpen },
    { href: "/dashboard/subjects", label: "Subjects", icon: BookOpen },
    { href: "/dashboard/routine", label: "Routine", icon: CalendarDays },
    { href: "/dashboard/exams", label: "Exams & Results", icon: FileText },
    { href: "/dashboard/grades", label: "Grading & GPA", icon: Award },
    { href: "/dashboard/notices", label: "Notice Board", icon: Megaphone },
    { href: "/dashboard/fees", label: "Fees", icon: Wallet },
    { href: "/dashboard/ledger", label: "Ledger", icon: Scale },
    { href: "/dashboard/leaves", label: "Leave Requests", icon: CalendarX2 },
    { href: "/dashboard/meetings", label: "PTM Slots", icon: CalendarCheck },
    { href: "/dashboard/gallery", label: "Gallery", icon: Images },
    { href: "/dashboard/complaints", label: "Feedback Box", icon: Inbox },
    { href: "/dashboard/promotion", label: "Promotion & Alumni", icon: ArrowUpRight },
    { href: "/dashboard/library", label: "Library & Books", icon: BookOpen },
    { href: "/dashboard/resources", label: "Materials", icon: FolderOpen },
    { href: "/dashboard/guardians", label: "Guardians", icon: ShieldCheck },
    { href: "/dashboard/guardian-app", label: "Parents App", icon: QrCode },
    { href: "/dashboard/id-cards", label: "ID Cards", icon: IdCard },
    { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
    { href: "/dashboard/messages", label: "Messages", icon: MessageSquare },
    { href: "/dashboard/branches", label: "Branches", icon: Building2 },
    { href: "/dashboard/staff", label: "Staff & Roles", icon: UserCog },
    { href: "/dashboard/settings", label: "Settings", icon: Settings },
  ],
  BRANCH_ADMIN: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/dashboard/students", label: "Students", icon: GraduationCap },
    { href: "/dashboard/teachers", label: "Teachers", icon: Users },
    { href: "/dashboard/classes", label: "Classes & Sections", icon: BookOpen },
    { href: "/dashboard/subjects", label: "Subjects", icon: BookOpen },
    { href: "/dashboard/routine", label: "Routine", icon: CalendarDays },
    { href: "/dashboard/exams", label: "Exams & Results", icon: FileText },
    { href: "/dashboard/grades", label: "Grading & GPA", icon: Award },
    { href: "/dashboard/notices", label: "Notice Board", icon: Megaphone },
    { href: "/dashboard/fees", label: "Fees", icon: Wallet },
    { href: "/dashboard/ledger", label: "Ledger", icon: Scale },
    { href: "/dashboard/leaves", label: "Leave Requests", icon: CalendarX2 },
    { href: "/dashboard/meetings", label: "PTM Slots", icon: CalendarCheck },
    { href: "/dashboard/gallery", label: "Gallery", icon: Images },
    { href: "/dashboard/complaints", label: "Feedback Box", icon: Inbox },
    { href: "/dashboard/library", label: "Library & Books", icon: BookOpen },
    { href: "/dashboard/resources", label: "Materials", icon: FolderOpen },
    { href: "/dashboard/guardians", label: "Guardians", icon: ShieldCheck },
    { href: "/dashboard/guardian-app", label: "Parents App", icon: QrCode },
    { href: "/dashboard/id-cards", label: "ID Cards", icon: IdCard },
    { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
    { href: "/dashboard/messages", label: "Messages", icon: MessageSquare },
    { href: "/dashboard/branches", label: "My Branch", icon: Building2 },
    { href: "/dashboard/staff", label: "Branch Staff", icon: UserCog },
    { href: "/dashboard/settings", label: "Settings", icon: Settings },
  ],
  REGISTRAR: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/dashboard/students", label: "Students", icon: GraduationCap },
    { href: "/dashboard/fees", label: "Fees", icon: Wallet },
    { href: "/dashboard/notices", label: "Notice Board", icon: Megaphone },
    { href: "/dashboard/messages", label: "Messages", icon: MessageSquare },
  ],
  ACCOUNTANT: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/dashboard/students", label: "Students", icon: GraduationCap },
    { href: "/dashboard/fees", label: "Fees", icon: Wallet },
    { href: "/dashboard/ledger", label: "Ledger", icon: Scale },
  ],
  LIBRARIAN: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/library", label: "Library & Books", icon: BookOpen },
  ],
  FRONT_DESK: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/dashboard/notices", label: "Notice Board", icon: Megaphone },
  ],
  TEACHER: [
    { href: "/teacher", label: "Dashboard", icon: LayoutDashboard },
    { href: "/teacher/attendance", label: "Attendance", icon: ClipboardList },
    { href: "/teacher/remarks", label: "Daily Remarks", icon: MessageSquare },
    { href: "/teacher/homework", label: "Homework", icon: BookOpen },
    { href: "/teacher/marks", label: "Marks Entry", icon: FileText },
    { href: "/teacher/results", label: "Results", icon: BarChart3 },
    { href: "/teacher/grades", label: "Grading & GPA", icon: Award },
    { href: "/teacher/resources", label: "My Materials", icon: FolderOpen },
    { href: "/teacher/quizzes", label: "Quizzes", icon: ClipboardList },
    { href: "/teacher/leaves", label: "My Leaves", icon: CalendarX2 },
    { href: "/teacher/meetings", label: "PTM Slots", icon: CalendarCheck },
    { href: "/teacher/messages", label: "Messages", icon: MessageSquare },
  ],
  GUARDIAN: [
    { href: "/parent", label: "Dashboard", icon: LayoutDashboard },
    { href: "/parent/attendance", label: "Attendance", icon: ClipboardList },
    { href: "/parent/homework", label: "Homework", icon: BookOpen },
    { href: "/parent/quizzes", label: "Quizzes", icon: ClipboardList },
    { href: "/parent/remarks", label: "Teacher Remarks", icon: MessageSquare },
    { href: "/parent/results", label: "Exam Results", icon: FileText },
    { href: "/parent/fees", label: "Fees & Payments", icon: Wallet },
    { href: "/parent/books", label: "My Books", icon: BookUp },
    { href: "/parent/resources", label: "Class Materials", icon: FolderOpen },
    { href: "/parent/gallery", label: "Gallery", icon: Images },
    { href: "/parent/meetings", label: "Book PTM", icon: CalendarCheck },
    { href: "/parent/leave", label: "Apply Leave", icon: CalendarX2 },
    { href: "/parent/feedback", label: "Complaints", icon: Inbox },
    { href: "/parent/notices", label: "Notices", icon: Megaphone },
    { href: "/parent/messages", label: "Messages", icon: MessageSquare },
    { href: "/parent/profile", label: "My Profile", icon: UserRound },
  ],
};

/** Where the account menu's "Profile" entry points, per role. */
const PROFILE_HREF: Record<string, string> = {
  SUPER_ADMIN: "/admin/settings",
  SCHOOL_ADMIN: "/dashboard/settings",
  BRANCH_ADMIN: "/dashboard/settings",
  REGISTRAR: "/dashboard/settings",
  ACCOUNTANT: "/dashboard/settings",
  LIBRARIAN: "/dashboard/settings",
  FRONT_DESK: "/dashboard/settings",
  GUARDIAN: "/parent/profile",
  TEACHER: "/teacher",
};

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

  // Once the shell knows who is signed in, warm the rest of this app's reads in
  // the background — pre-paying them is what makes the *first* click on any
  // sidebar entry instant when a Firestore read costs 0.5–1.2s cold. The
  // stagger keeps the warm from competing with the page being looked at.
  //
  // Returning to the tab is the other moment the cache has gone stale, so
  // re-warm then too (rate-limited, visible tabs only) — that is what makes the
  // first click after a long pause as fast as the first click after sign-in.
  useEffect(() => {
    if (!me) return;
    const sector = sectorForRole(me.user.role);
    if (!sector) return;
    const list = warmListForSector(sector.key);

    if (!warmed.current) {
      warmed.current = true;
      prefetch(list, 150);
    }

    let lastWarm = Date.now();
    const rearm = () => {
      if (document.visibilityState !== "visible") return;
      if (Date.now() - lastWarm < 30_000) return;
      lastWarm = Date.now();
      prefetch(list, 150);
    };
    window.addEventListener("focus", rearm);
    document.addEventListener("visibilitychange", rearm);
    return () => {
      window.removeEventListener("focus", rearm);
      document.removeEventListener("visibilitychange", rearm);
    };
  }, [me]);

  // The dashboard hosts several roles (SCHOOL_ADMIN, BRANCH_ADMIN, REGISTRAR,
  // ACCOUNTANT, LIBRARIAN, FRONT_DESK) — the sidebar always follows the
  // session's real role, not the layout's placeholder prop.
  const effRole = me?.user?.role || role;
  const nav = NAVS[effRole] || [];
  const user = me?.user;
  /** Which app is this shell? (each sector has its own name and nav) */
  const app = sectorForRole(effRole);

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
      <div className="min-h-screen bg-white">
        <aside className="fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-slate-900 lg:flex">
          <div className="flex items-center gap-3 px-5 py-5">
            <div className="h-10 w-10 rounded-xl bg-slate-800" />
            <div className="space-y-2">
              <div className="h-3 w-28 rounded bg-slate-800" />
              <div className="h-2 w-20 rounded bg-slate-800/70" />
            </div>
          </div>
          <div className="flex-1 space-y-2 px-3">
            {Array.from({ length: 9 }).map((_, i) => (
              <div key={i} className="h-9 rounded-xl bg-slate-800/60" />
            ))}
          </div>
        </aside>
        <div className="flex min-h-screen flex-col lg:pl-64">
          <header className="sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur md:px-6">
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
    <div className="min-h-screen bg-white">
      {/* desktop sidebar */}
      <aside className="no-print fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-slate-900 lg:flex">
        <SidebarContent
          role={effRole}
          nav={nav}
          active={active}
          schoolName={me?.school?.name}
          appLabel={app?.label}
          onClose={() => setDrawer(false)}
        />
      </aside>

      {/* mobile drawer */}
      {drawer && (
        <div className="no-print fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-slate-900 shadow-2xl">
            <SidebarContent
              role={effRole}
              nav={nav}
              active={active}
              schoolName={me?.school?.name}
              appLabel={app?.label}
              onClose={() => setDrawer(false)}
            />
          </aside>
        </div>
      )}

      {/* main */}
      <div className="flex min-h-screen flex-col lg:pl-64">
        <header className="no-print sticky top-0 z-30 flex h-16 items-center gap-3 border-b border-slate-200 bg-white/85 px-4 backdrop-blur md:px-6">
          <button className="rounded-lg p-2 text-slate-500 hover:bg-slate-100 lg:hidden" onClick={() => setDrawer(true)}>
            <Menu size={20} />
          </button>
          <div className="min-w-0 flex-1">
            {me?.school ? (
              <div className="truncate text-sm font-bold text-slate-800">{me.school.name}</div>
            ) : (
              <div className="text-sm font-bold text-slate-800">Amar E School</div>
            )}
            <div className="hidden text-[11px] uppercase tracking-widest text-slate-400 sm:block">
              {app ? app.app : effRole.replace("_", " ")}
              {user?.scope === "BRANCH" && user?.branch && <span className="ml-1">· {user.branch.name}</span>}
              {me?.school?.plan && <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-600">{me.school.plan} plan</span>}
            </div>
          </div>

          {user && (
            <div className="flex items-center gap-2">
              <ThemeToggle />
              <NotificationBell />
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

function SidebarContent({
  role,
  nav,
  active,
  schoolName,
  appLabel,
  onClose,
}: {
  role: string;
  nav: NavItem[];
  active: string;
  schoolName?: string;
  appLabel?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
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
        <button className="ml-auto rounded-lg p-1.5 text-slate-400 hover:bg-slate-800 lg:hidden" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 pb-4">
        {nav.map((item) => {
          const isActive = active === item.href;
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onClose}
              // Warm this page's reads the moment the pointer lands on it, so
              // the click renders from cache instead of showing its loader.
              onMouseEnter={() => prefetch(dataForRoute(item.href))}
              onFocus={() => prefetch(dataForRoute(item.href))}
              onTouchStart={() => prefetch(dataForRoute(item.href))}
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-all",
                isActive ? "brand-bg text-white shadow-md" : "text-slate-300 hover:bg-slate-800 hover:text-white"
              )}
            >
              <item.icon size={17} className={isActive ? "" : "text-slate-400"} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-slate-800 p-4">
        <button
          onClick={async () => {
            await api("/api/auth/logout", { method: "POST" }).catch(() => null);
            writeCachedMe(null);
            window.location.href = "/login";
          }}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-slate-800 px-3 py-2.5 text-[13px] font-semibold text-slate-300 transition hover:bg-slate-700 hover:text-white"
        >
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </div>
  );
}
