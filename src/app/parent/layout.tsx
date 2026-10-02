import { AppShell } from "@/components/AppShell";

/**
 * The Parents App shell.
 *
 * `AppShell` is the app chrome — a left icon rail on desktop and a bottom tab
 * bar on phones (Home · Attendance · AI · Messages · More). It renders in place
 * of the shared `Shell`, so the parent sector has no sidebar at any width.
 *
 * Only the wrapper changed: the same `children` render inside, and the shared
 * `Shell` is untouched, so the admin and super-admin sectors are unaffected.
 */
export default function ParentLayout({ children }: { children: React.ReactNode }) {
  return <AppShell role="GUARDIAN">{children}</AppShell>;
}
