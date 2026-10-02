import { AppShell } from "@/components/AppShell";

/**
 * The Teacher App shell.
 *
 * `AppShell` is the app chrome — a left icon rail on desktop and a bottom tab
 * bar on phones (Home · Academics · AI · Classwork · More). It renders in place
 * of the shared `Shell`, so the teacher sector has no sidebar at any width.
 *
 * Only the wrapper changed: the same `children` render inside, and the shared
 * `Shell` is untouched, so the admin and super-admin sectors are unaffected.
 */
export default function TeacherLayout({ children }: { children: React.ReactNode }) {
  return <AppShell role="TEACHER">{children}</AppShell>;
}
