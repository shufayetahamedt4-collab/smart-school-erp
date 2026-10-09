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
  ShieldCheck,
  Crown,
  Scale,
  CalendarX2,
  CalendarCheck,
  Radio,
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
  Briefcase,
  Bell,
  Upload,
  Network,
  Layers,
  TrendingUp,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import {
  hasCollege,
  navLabelFor,
  normalizeInstitutionType,
  normalizeMode,
  type InstitutionType,
  type Mode,
} from "../lib/institution";

/**
 * Navigation registry.
 *
 * The per-role link arrays here are the SAME objects the Shell always rendered —
 * this module only moves them out of Shell.tsx so the sidebar renderer and the
 * grouping config can be reasoned about (and diffed) on their own. The hrefs,
 * labels and icons are unchanged; nothing is added or dropped.
 *
 * `groupNavFor()` re-buckets a role's existing array into the module groups
 * below. It consumes the role's own items, so labels that differ per role
 * (e.g. "Branches" vs "My Branch") are preserved exactly, and any group a role
 * has no members for is dropped.
 */

export interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  /**
   * Optional visibility marker: shown only to a tenant that can run this mode at
   * all, and only while that mode is the active one. Phase 2e is the first phase
   * to use it — the college destinations (`/dashboard/departments`,
   * `/dashboard/programs`, `/dashboard/courses`, `/dashboard/registration`)
   * carry `COLLEGE` for the three
   * college-facing roles (SCHOOL_ADMIN, BRANCH_ADMIN, REGISTRAR). Nothing else
   * is marked, and an item without a marker is visible in every mode, so a
   * SCHOOL tenant's sidebar is still the registry's school items exactly.
   *
   * Mode is UI context and never authorization: this decides what a sidebar
   * lists, not what a user may reach (`can()` and the tenant gate in
   * `requireCollege()` remain the only enforcement). The tenant half of the
   * check is defence in depth: a SCHOOL tenant lists no college link even if a
   * stale `ss_mode` cookie ever asked for one.
   */
  requires?: Mode;
}

export interface NavGroup {
  key: string;
  label: string;
  icon: LucideIcon;
  /** Solid accent — used for the module's icon glyph and the active rail. */
  accent: string;
  /** Translucent accent — used for the module's icon container. */
  tint: string;
  items: NavItem[];
}

export const NAVS: Record<string, NavItem[]> = {
  SUPER_ADMIN: [
    { href: "/admin", label: "Dashboard", icon: LayoutDashboard },
    { href: "/admin/notifications", label: "Notifications", icon: Bell },
    { href: "/admin/schools", label: "Schools", icon: School },
    { href: "/admin/billing", label: "Billing & Plans", icon: CreditCard },
    { href: "/admin/settings", label: "Global Settings", icon: Settings },
  ],
  SCHOOL_ADMIN: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/dashboard/students", label: "Students", icon: GraduationCap },
    { href: "/dashboard/students/import", label: "Bulk Import", icon: Upload },
    { href: "/dashboard/onboarding", label: "Guardian Onboarding", icon: ShieldCheck },
    { href: "/dashboard/teachers", label: "Teachers", icon: Users },
    { href: "/dashboard/classes", label: "Classes & Sections", icon: BookOpen },
    { href: "/dashboard/academic-sessions", label: "Academic Sessions", icon: CalendarDays },
    { href: "/dashboard/subjects", label: "Subjects", icon: BookOpen },
    { href: "/dashboard/departments", label: "Departments", icon: Network, requires: "COLLEGE" },
    { href: "/dashboard/programs", label: "Programs", icon: Layers, requires: "COLLEGE" },
    { href: "/dashboard/courses", label: "Courses", icon: BookOpen, requires: "COLLEGE" },
    { href: "/dashboard/registration", label: "Registration", icon: ClipboardList, requires: "COLLEGE" },
    { href: "/dashboard/college-promotion", label: "College Promotion", icon: TrendingUp, requires: "COLLEGE" },
    { href: "/dashboard/routine", label: "Routine", icon: CalendarDays },
    { href: "/dashboard/live-classes", label: "Live Classes", icon: Radio },
    { href: "/dashboard/exams", label: "Exams & Results", icon: FileText },
    { href: "/dashboard/grades", label: "Grading & GPA", icon: Award },
    { href: "/dashboard/notices", label: "Notice Board", icon: Megaphone },
    { href: "/dashboard/fees", label: "Fees", icon: Wallet },
    { href: "/dashboard/fees/structure", label: "Fee structure", icon: Wallet },
    { href: "/dashboard/fees/payments", label: "Payment channels", icon: CreditCard },
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
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/dashboard/students", label: "Students", icon: GraduationCap },
    { href: "/dashboard/students/import", label: "Bulk Import", icon: Upload },
    { href: "/dashboard/onboarding", label: "Guardian Onboarding", icon: ShieldCheck },
    { href: "/dashboard/teachers", label: "Teachers", icon: Users },
    { href: "/dashboard/classes", label: "Classes & Sections", icon: BookOpen },
    { href: "/dashboard/academic-sessions", label: "Academic Sessions", icon: CalendarDays },
    { href: "/dashboard/subjects", label: "Subjects", icon: BookOpen },
    { href: "/dashboard/departments", label: "Departments", icon: Network, requires: "COLLEGE" },
    { href: "/dashboard/programs", label: "Programs", icon: Layers, requires: "COLLEGE" },
    { href: "/dashboard/courses", label: "Courses", icon: BookOpen, requires: "COLLEGE" },
    { href: "/dashboard/registration", label: "Registration", icon: ClipboardList, requires: "COLLEGE" },
    { href: "/dashboard/college-promotion", label: "College Promotion", icon: TrendingUp, requires: "COLLEGE" },
    { href: "/dashboard/routine", label: "Routine", icon: CalendarDays },
    { href: "/dashboard/live-classes", label: "Live Classes", icon: Radio },
    { href: "/dashboard/exams", label: "Exams & Results", icon: FileText },
    { href: "/dashboard/grades", label: "Grading & GPA", icon: Award },
    { href: "/dashboard/notices", label: "Notice Board", icon: Megaphone },
    { href: "/dashboard/fees", label: "Fees", icon: Wallet },
    { href: "/dashboard/fees/structure", label: "Fee structure", icon: Wallet },
    { href: "/dashboard/fees/payments", label: "Payment channels", icon: CreditCard },
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
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/dashboard/students", label: "Students", icon: GraduationCap },
    { href: "/dashboard/departments", label: "Departments", icon: Network, requires: "COLLEGE" },
    { href: "/dashboard/programs", label: "Programs", icon: Layers, requires: "COLLEGE" },
    { href: "/dashboard/courses", label: "Courses", icon: BookOpen, requires: "COLLEGE" },
    { href: "/dashboard/registration", label: "Registration", icon: ClipboardList, requires: "COLLEGE" },
    { href: "/dashboard/college-promotion", label: "College Promotion", icon: TrendingUp, requires: "COLLEGE" },
    { href: "/dashboard/fees", label: "Fees", icon: Wallet },
    { href: "/dashboard/notices", label: "Notice Board", icon: Megaphone },
    { href: "/dashboard/messages", label: "Messages", icon: MessageSquare },
  ],
  ACCOUNTANT: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/dashboard/students", label: "Students", icon: GraduationCap },
    { href: "/dashboard/fees", label: "Fees", icon: Wallet },
    { href: "/dashboard/fees/structure", label: "Fee structure", icon: Wallet },
    { href: "/dashboard/fees/payments", label: "Payment channels", icon: CreditCard },
    { href: "/dashboard/ledger", label: "Ledger", icon: Scale },
  ],
  LIBRARIAN: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/library", label: "Library & Books", icon: BookOpen },
  ],
  FRONT_DESK: [
    { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
    { href: "/dashboard/notifications", label: "Notifications", icon: Bell },
    { href: "/dashboard/admissions", label: "Admissions", icon: ClipboardList },
    { href: "/dashboard/notices", label: "Notice Board", icon: Megaphone },
  ],
  TEACHER: [
    { href: "/teacher", label: "Dashboard", icon: LayoutDashboard },
    { href: "/teacher/notifications", label: "Notifications", icon: Bell },
    { href: "/teacher/classes", label: "My Classes", icon: Radio },
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
    { href: "/parent/notifications", label: "Notifications", icon: Bell },
    { href: "/parent/live-classes", label: "Live Classes", icon: Radio },
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

/**
 * A role's navigation for one tenant shape and one active mode.
 *
 * Phase 1 (docs/COLLEGE-DECISIONS.md §8) installed the mechanism as a no-op;
 * Phase 2e is the phase that consumes it, marking the two college destinations
 * for the three college-facing roles. The result now depends on the data:
 *   - an item whose `requires` is not the active mode, or whose tenant cannot run
 *     that mode at all, is dropped;
 *   - an item with an override for this type/mode is returned under that label.
 * When neither changes anything the function still returns `NAVS[role]` **by
 * reference** — which is now true for the six roles with no college items, not
 * for the three that carry them (dropping a marked item necessarily returns a
 * copy, so a marked role's array is no longer the registry's own).
 * `scripts/verify-nav-scope.mjs` asserts exactly that split, and that a SCHOOL
 * tenant's list is still the frozen pre-Phase-1 registry.
 */
export function navForRole(
  role: string,
  institutionType?: InstitutionType | null,
  mode?: Mode | null
): NavItem[] {
  const items = NAVS[role];
  if (!items) return [];

  const active = normalizeMode(mode);
  // A marked item needs BOTH halves: the active mode must be the one it requires,
  // and the tenant must be able to run that mode (COLLEGE = the college-capable
  // types). Absent/unknown types normalize to SCHOOL, so they never qualify.
  const collegeCapable = hasCollege(normalizeInstitutionType(institutionType));
  let changed = false;
  const out: NavItem[] = [];

  for (const item of items) {
    const tenantSupports = item.requires !== "COLLEGE" || collegeCapable;
    if (item.requires && (item.requires !== active || !tenantSupports)) {
      changed = true;
      continue;
    }
    const label = navLabelFor(item.href, institutionType, mode);
    if (label !== undefined && label !== item.label) {
      changed = true;
      out.push({ ...item, label });
    } else {
      out.push(item);
    }
  }

  // Nothing was dropped and nothing was relabelled — hand back the registry's
  // own array so "unchanged" is an identity, not a deep-equality guess.
  return changed ? out : items;
}

/**
 * Module groups for the School Admin panel (SCHOOL_ADMIN, BRANCH_ADMIN and the
 * back-office sub-roles). These are section headers only — every member below
 * is an existing route, unchanged.
 *
 * `accent` / `tint` are presentation-only: a restrained per-module hue used for
 * the header icon, its container and the active rail. The chrome stays deep
 * navy — the accents are tints, never large fills. `overview` deliberately
 * carries the tenant's own brand color so the section that owns the dashboard
 * matches whatever theme the school configured.
 */
export const SCHOOL_GROUP_ORDER = ["overview", "academics", "people", "finance", "communication", "operations", "system"] as const;

export const SCHOOL_GROUP_META: Record<string, { label: string; icon: LucideIcon; accent: string; tint: string }> = {
  overview: { label: "Overview", icon: LayoutDashboard, accent: "rgb(var(--brand))", tint: "rgb(var(--brand) / 0.16)" },
  academics: { label: "Academics", icon: GraduationCap, accent: "#818cf8", tint: "#818cf829" },
  people: { label: "People", icon: Users, accent: "#2dd4bf", tint: "#2dd4bf29" },
  finance: { label: "Finance", icon: Wallet, accent: "#34d399", tint: "#34d39929" },
  communication: { label: "Communication", icon: MessageSquare, accent: "#a78bfa", tint: "#a78bfa29" },
  operations: { label: "Operations", icon: Briefcase, accent: "#fbbf24", tint: "#fbbf2429" },
  system: { label: "System", icon: Settings, accent: "#94a3b8", tint: "#94a3b829" },
};

/**
 * The roles that live inside the School Admin panel. ONLY these get the grouped
 * sidebar — Teacher, Guardian and the Platform Console keep the flat list they
 * have always had. Grouping is keyed off this list, never off "has a NAVS entry",
 * so a non-panel role can never accidentally inherit module headers.
 */
const SCHOOL_PANEL_ROLES = ["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"];

/** href → module key, for every School Admin panel route (all roles share hrefs). */
const SCHOOL_GROUP_OF: Record<string, string> = {
  "/dashboard": "overview",
  "/dashboard/classes": "academics",
  "/dashboard/academic-sessions": "academics",
  "/dashboard/subjects": "academics",
  "/dashboard/departments": "academics",
  "/dashboard/programs": "academics",
  "/dashboard/courses": "academics",
  "/dashboard/registration": "academics",
  "/dashboard/college-promotion": "academics",
  "/dashboard/routine": "academics",
  "/dashboard/live-classes": "academics",
  "/dashboard/exams": "academics",
  "/dashboard/grades": "academics",
  "/dashboard/library": "academics",
  "/dashboard/resources": "academics",
  "/dashboard/admissions": "people",
  "/dashboard/students": "people",
  "/dashboard/students/import": "people",
  "/dashboard/onboarding": "people",
  "/dashboard/teachers": "people",
  "/dashboard/guardians": "people",
  "/dashboard/staff": "people",
  "/dashboard/promotion": "people",
  "/dashboard/fees": "finance",
  "/dashboard/fees/structure": "finance",
  "/dashboard/fees/payments": "finance",
  "/dashboard/ledger": "finance",
  "/dashboard/notices": "communication",
  "/dashboard/messages": "communication",
  "/dashboard/notifications": "communication",
  "/dashboard/meetings": "communication",
  "/dashboard/guardian-app": "communication",
  "/dashboard/complaints": "communication",
  "/dashboard/leaves": "operations",
  "/dashboard/id-cards": "operations",
  "/dashboard/gallery": "operations",
  "/dashboard/reports": "operations",
  "/dashboard/branches": "operations",
  "/dashboard/settings": "system",
};

/**
 * Bucket a role's existing items into the module groups. Consumes the role's own
 * array (so per-role labels survive), preserves item order within a group and the
 * fixed group order, and drops any group the role has no members for. Items whose
 * href is not mapped (there should be none for school roles) fall back to the
 * last group so nothing can silently disappear.
 *
 * Pass an already-filtered array (`navForRole(...)`) as the second argument to
 * group a mode-aware list; called with the role alone it buckets the registry
 * entry itself, exactly as it always has.
 */
export function groupNavFor(role: string, items?: NavItem[]): NavGroup[] | null {
  if (!SCHOOL_PANEL_ROLES.includes(role)) return null;
  // The optional argument is the already-filtered array (`navForRole`); omitted,
  // this buckets the role's registry entry exactly as it always has.
  const list = items ?? NAVS[role];
  if (!list) return null;
  const buckets = new Map<string, NavItem[]>();
  for (const item of list) {
    const key = SCHOOL_GROUP_OF[item.href] || "operations";
    buckets.set(key, [...(buckets.get(key) || []), item]);
  }
  return SCHOOL_GROUP_ORDER.filter((key) => (buckets.get(key) || []).length > 0).map((key) => {
    const meta = SCHOOL_GROUP_META[key];
    return {
      key,
      label: meta.label,
      icon: meta.icon,
      accent: meta.accent,
      tint: meta.tint,
      items: buckets.get(key)!,
    };
  });
}

/** Where the bell's "View all" hands off, per role. */
export const NOTIFICATIONS_HREF: Record<string, string> = {
  SUPER_ADMIN: "/admin/notifications",
  SCHOOL_ADMIN: "/dashboard/notifications",
  BRANCH_ADMIN: "/dashboard/notifications",
  REGISTRAR: "/dashboard/notifications",
  ACCOUNTANT: "/dashboard/notifications",
  LIBRARIAN: "/dashboard/notifications",
  FRONT_DESK: "/dashboard/notifications",
  TEACHER: "/teacher/notifications",
  GUARDIAN: "/parent/notifications",
};

/** Where the account menu's "Profile" entry points, per role. */
export const PROFILE_HREF: Record<string, string> = {
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

/** Roles that get the grouped School Admin panel sidebar; everyone else stays flat. */
export function isSchoolPanelRole(role: string | null | undefined): boolean {
  return !!role && SCHOOL_PANEL_ROLES.includes(role);
}

/* ------------------------------------------------------------------ mobile */

/**
 * Mobile bottom-nav tabs, per role.
 *
 * Every href here ALREADY exists in `NAVS[role]` — this registry adds no route,
 * renames no route and removes no route. Only the tab's short label is new. The
 * icon is not repeated: it is read from the role's own nav item, so the bottom
 * bar and the sidebar can never disagree about what a destination looks like.
 */
export const MOBILE_TAB_HREFS: Record<string, { href: string; label: string }[]> = {
  TEACHER: [
    { href: "/teacher", label: "Home" },
    { href: "/teacher/classes", label: "Academics" },
    { href: "/teacher/homework", label: "Classwork" },
    { href: "/teacher/messages", label: "Messages" },
  ],
};

/**
 * The bottom bar's tabs, resolved against the role's own nav array: same href
 * object, same icon, only the label swapped for its short form. An href that is
 * NOT present in the role's nav is dropped rather than rendered, so the bar can
 * never surface a page the role is not allowed to reach.
 *
 * Returns an empty array for any role with no mobile tabs configured, which is
 * every role except TEACHER — so nothing else in the app is affected.
 */
export function mobileTabsFor(role: string): NavItem[] {
  const items = NAVS[role];
  const tabs = MOBILE_TAB_HREFS[role];
  if (!items || !tabs) return [];
  return tabs
    .map((tab) => {
      const item = items.find((n) => n.href === tab.href);
      return item ? { ...item, label: tab.label } : null;
    })
    .filter((x): x is NavItem => x !== null);
}

/**
 * Everything the role can reach that is NOT already a tab — the contents of the
 * "More" sheet. Derived from the same array, so a nav item added later shows up
 * in More with no second edit and can never be orphaned between the two.
 */
export function moreItemsFor(role: string): NavItem[] {
  const items = NAVS[role];
  if (!items) return [];
  const tabHrefs = new Set((MOBILE_TAB_HREFS[role] || []).map((t) => t.href));
  return items.filter((n) => !tabHrefs.has(n.href));
}
