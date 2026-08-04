"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
  QrCode,
  ShieldCheck,
  Crown,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api } from "@/lib/client";
import { cn, initials, classOf } from "@/lib/utils";
import { Spinner } from "./ui";

export interface Me {
  user: {
    id: string;
    name: string;
    email: string | null;
    role: string;
    schoolId: string | null;
    studentId?: string;
  };
  school: {
    id: string;
    name: string;
    slug: string;
    logoUrl: string | null;
    plan: string;
    status: string;
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

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAVS: Record<string, NavItem[]> = {
  SUPER_ADMIN: [
    { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
    { href: "/admin/schools", label: "Schools", icon: School },
    { href: "/admin/settings", label: "Global Settings", icon: Settings },
  ],
  SCHOOL_ADMIN: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/students", label: "Students", icon: GraduationCap },
    { href: "/dashboard/teachers", label: "Teachers", icon: Users },
    { href: "/dashboard/classes", label: "Classes & Sections", icon: BookOpen },
    { href: "/dashboard/subjects", label: "Subjects", icon: BookOpen },
    { href: "/dashboard/routine", label: "Routine", icon: CalendarDays },
    { href: "/dashboard/exams", label: "Exams & Results", icon: FileText },
    { href: "/dashboard/notices", label: "Notice Board", icon: Megaphone },
    { href: "/dashboard/fees", label: "Fees", icon: Wallet },
    { href: "/dashboard/guardians", label: "Guardians", icon: ShieldCheck },
    { href: "/dashboard/id-cards", label: "ID Cards", icon: IdCard },
    { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
    { href: "/dashboard/messages", label: "Messages", icon: MessageSquare },
    { href: "/dashboard/settings", label: "Settings", icon: Settings },
  ],
  TEACHER: [
    { href: "/teacher", label: "Dashboard", icon: LayoutDashboard },
    { href: "/teacher/attendance", label: "Attendance", icon: ClipboardList },
    { href: "/teacher/remarks", label: "Daily Remarks", icon: MessageSquare },
    { href: "/teacher/homework", label: "Homework", icon: BookOpen },
    { href: "/teacher/marks", label: "Marks Entry", icon: FileText },
    { href: "/teacher/results", label: "Results", icon: BarChart3 },
    { href: "/teacher/messages", label: "Messages", icon: MessageSquare },
  ],
  GUARDIAN: [
    { href: "/parent", label: "Dashboard", icon: LayoutDashboard },
    { href: "/parent/attendance", label: "Attendance", icon: ClipboardList },
    { href: "/parent/homework", label: "Homework", icon: BookOpen },
    { href: "/parent/remarks", label: "Teacher Remarks", icon: MessageSquare },
    { href: "/parent/results", label: "Exam Results", icon: FileText },
    { href: "/parent/fees", label: "Fees", icon: Wallet },
    { href: "/parent/notices", label: "Notices", icon: Megaphone },
    { href: "/parent/messages", label: "Messages", icon: MessageSquare },
  ],
};

export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const refresh = useCallback(async () => {
    try {
      const data = await api<Me>("/api/auth/me");
      setMe(data);
      setError(null);
    } catch (e: any) {
      if (e?.status === 401) {
        router.replace("/login");
        return;
      }
      setError(e?.message || "Failed to load session");
    } finally {
      setLoading(false);
    }
  }, [router]);

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

  const nav = NAVS[role] || [];
  const user = me?.user;

  const logout = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    router.replace("/login");
  };

  const active = useMemo(() => {
    const item = nav.find((n) => n.href !== "/" && pathname.startsWith(n.href));
    return item?.href || "/";
  }, [pathname, nav]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* desktop sidebar */}
      <aside className="no-print fixed inset-y-0 left-0 z-40 hidden w-64 flex-col bg-slate-900 lg:flex">
        <SidebarContent role={role} nav={nav} active={active} schoolName={me?.school?.name} onClose={() => setDrawer(false)} />
      </aside>

      {/* mobile drawer */}
      {drawer && (
        <div className="no-print fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={() => setDrawer(false)} />
          <aside className="absolute inset-y-0 left-0 w-72 bg-slate-900 shadow-2xl">
            <SidebarContent role={role} nav={nav} active={active} schoolName={me?.school?.name} onClose={() => setDrawer(false)} />
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
              <div className="text-sm font-bold text-slate-800">Smart School ERP</div>
            )}
            <div className="hidden text-[11px] uppercase tracking-widest text-slate-400 sm:block">
              {role.replace("_", " ")}
              {me?.school?.plan && <span className="ml-2 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-bold text-indigo-600">{me.school.plan} plan</span>}
            </div>
          </div>

          {user && (
            <div className="flex items-center gap-2">
              <Link href="/qr" className="hidden items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold text-slate-500 hover:bg-slate-100 sm:flex">
                <QrCode size={15} /> QR Login
              </Link>
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 text-xs font-bold text-white">
                {initials(user.name)}
              </div>
              <div className="hidden md:block">
                <div className="text-xs font-bold text-slate-800">{user.name}</div>
                <div className="text-[11px] text-slate-400">{user.email || ""}</div>
              </div>
              <button onClick={logout} title="Logout" className="ml-1 rounded-lg p-2 text-slate-400 transition hover:bg-rose-50 hover:text-rose-600">
                <LogOut size={18} />
              </button>
            </div>
          )}
        </header>

        <main className="flex-1 px-4 py-6 md:px-8">{children}</main>

        <footer className="no-print border-t border-slate-200 px-6 py-4 text-center text-xs text-slate-400">
          Smart School ERP &amp; Parent Communication System · Multi-Tenant SaaS
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
  onClose,
}: {
  role: string;
  nav: NavItem[];
  active: string;
  schoolName?: string;
  onClose: () => void;
}) {
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 px-5 py-5">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600 text-lg font-black text-white shadow-lg shadow-indigo-900/40">
          {role === "SUPER_ADMIN" ? <Crown size={20} /> : <GraduationCap size={20} />}
        </div>
        <div className="min-w-0">
          <div className="truncate text-sm font-extrabold text-white">{role === "SUPER_ADMIN" ? "Platform Admin" : schoolName || "Smart School"}</div>
          <div className="text-[10px] uppercase tracking-widest text-slate-400">ERP Console</div>
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
              className={cn(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-[13px] font-semibold transition-all",
                isActive ? "bg-indigo-600 text-white shadow-md shadow-indigo-900/40" : "text-slate-300 hover:bg-slate-800 hover:text-white"
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
