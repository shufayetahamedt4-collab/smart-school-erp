import { Sparkles, type LucideIcon } from "lucide-react";
import { NAVS, type NavItem } from "./nav";

/**
 * App-shell navigation for the two phone-first apps (Teacher, Parents).
 *
 * This is DELIBERATELY a separate module from `nav.ts`: `nav.ts` is the shared
 * registry the School Admin sidebar also reads, so it is left completely
 * untouched. Nothing here mutates it — the items are resolved AGAINST the
 * role's existing `NAVS[role]` array, so an href that already exists keeps its
 * own icon and can never drift from the registry.
 *
 * Only two hrefs are new to the system: `/teacher/ai` and `/parent/ai`. They are
 * not in `NAVS` (adding them would change the shared registry), so they carry
 * their own icon here and are marked as app tabs. Every other tab is an existing
 * destination.
 */

export interface AppTabDef {
  href: string;
  /** Optional short label that overrides the registry's (e.g. "Academics"). */
  label?: string;
  /** Only needed for a tab that is not in `NAVS` (the AI tabs). */
  icon?: LucideIcon;
}

/**
 * The five primary destinations, per role. The last slot of the rendered bar is
 * always "More", so four tabs is the correct shape here.
 */
const TAB_DEFS: Record<string, AppTabDef[]> = {
  TEACHER: [
    { href: "/teacher" },
    { href: "/teacher/classes", label: "Academics" },
    { href: "/teacher/ai", label: "AI", icon: Sparkles },
    { href: "/teacher/homework", label: "Classwork" },
  ],
  GUARDIAN: [
    { href: "/parent" },
    { href: "/parent/attendance", label: "Attendance" },
    { href: "/parent/ai", label: "AI", icon: Sparkles },
    { href: "/parent/messages", label: "Messages" },
  ],
};

/** Roles that use the app shell. Everything else keeps the shared `Shell`. */
export function isAppRole(role: string | null | undefined): boolean {
  return !!role && !!TAB_DEFS[role];
}

/**
 * Resolve a role's primary tabs against its own registry array. A tab whose href
 * exists in `NAVS` keeps the registry's icon (and any short label we set); a tab
 * not in the registry (the AI tabs) falls back to its own icon.
 */
export function appTabsFor(role: string): NavItem[] {
  const items = NAVS[role] || [];
  const defs = TAB_DEFS[role] || [];
  const out: NavItem[] = [];
  for (const def of defs) {
    const found = items.find((n) => n.href === def.href);
    if (found) {
      out.push(def.label ? { ...found, label: def.label } : found);
    } else if (def.icon) {
      out.push({ href: def.href, label: def.label || def.href, icon: def.icon });
    }
    // A tab with neither a registry entry nor its own icon is dropped rather
    // than rendered as a dead link.
  }
  return out;
}

/**
 * Every destination that is NOT one of the primary tabs — the contents of the
 * "More" sheet and the desktop rail's "All destinations" panel. Derived from the
 * role's own array, so nothing can be orphaned between the tabs and the sheet.
 */
export function appMoreItemsFor(role: string): NavItem[] {
  const items = NAVS[role] || [];
  const tabHrefs = new Set((TAB_DEFS[role] || []).map((d) => d.href));
  return items.filter((n) => !tabHrefs.has(n.href));
}
