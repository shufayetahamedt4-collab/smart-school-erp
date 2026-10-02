"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LayoutGrid } from "lucide-react";
import { cn } from "@/lib/utils";
import { mobileTabsFor, moreItemsFor } from "@/components/nav";
import { MobileMoreSheet } from "@/components/MobileMoreSheet";

/** The same boundary the bar hides at — Tailwind's `md:` (768px). */
const DESKTOP_QUERY = "(min-width: 768px)";

/**
 * The Teacher App's bottom tab bar — phones only.
 *
 * Presentation-only: it links to destinations that already exist in the role's
 * own nav array, so it adds no route, changes no permission and touches no data
 * flow. The tabs (and the "More" sheet's contents) are derived from the SAME
 * array the sidebar renders, so the two can never disagree.
 *
 * Viewport guard: the bar mounts only below 768px. `md:hidden` alone would still
 * emit hidden DOM at desktop, which would change the element counts the T0
 * baseline pinned for ≥768px — so the media query is applied in JS as well, and
 * at ≥768px this component renders nothing at all.
 */
export function MobileTabBar({ role }: { role: string }) {
  const pathname = usePathname();
  const [mobile, setMobile] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const mq = window.matchMedia(DESKTOP_QUERY);
    const sync = () => setMobile(!mq.matches);
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  // Growing past the breakpoint must not leave the sheet stranded open.
  useEffect(() => {
    if (!mobile) setMoreOpen(false);
  }, [mobile]);

  const tabs = mobileTabsFor(role);
  const more = moreItemsFor(role);

  // Longest-prefix match, exactly as the sidebar resolves "you are here".
  const active = useMemo(() => {
    const all = [...tabs, ...more];
    const matches = all.filter((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
    return matches.sort((a, b) => b.href.length - a.href.length)[0]?.href || "";
  }, [pathname, tabs, more]);

  if (!mobile || tabs.length === 0) return null;

  const moreActive = more.some((n) => n.href === active);

  return (
    <>
      <nav
        aria-label="Teacher app"
        className="no-print ss-tabbar fixed inset-x-0 bottom-0 z-[55] rounded-t-2xl border-t border-[#E2E8F0] bg-white md:hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto flex h-16 max-w-lg items-stretch">
          {tabs.map((item) => {
            const isActive = active === item.href;
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive ? "page" : undefined}
                className="flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-0.5 py-1.5"
              >
                <span
                  className="flex h-7 w-14 items-center justify-center rounded-full transition-colors"
                  style={
                    isActive
                      ? { background: "rgb(var(--brand, 79 70 229) / 0.12)", color: "rgb(var(--brand, 79 70 229))" }
                      : { color: "#94A3B8" }
                  }
                >
                  <item.icon size={20} />
                </span>
                <span
                  className={cn("w-full truncate text-center text-[10px] font-semibold leading-none")}
                  style={isActive ? { color: "rgb(var(--brand, 79 70 229))" } : { color: "#64748B" }}
                >
                  {item.label}
                </span>
              </Link>
            );
          })}

          <button
            ref={moreButtonRef}
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

      <MobileMoreSheet
        role={role}
        open={moreOpen}
        onClose={() => setMoreOpen(false)}
        returnFocusRef={moreButtonRef}
      />
    </>
  );
}
