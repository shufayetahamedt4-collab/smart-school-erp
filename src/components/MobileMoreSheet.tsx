"use client";

import { useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LogOut, X } from "lucide-react";
import { api } from "@/lib/client";
import { cn } from "@/lib/utils";
import { moreItemsFor } from "@/components/nav";

/**
 * The Teacher App's "More" sheet.
 *
 * Presentation-only: it renders destinations that ALREADY exist in the role's
 * own nav array (see `moreItemsFor`), so it can never surface a page the role
 * cannot reach. Nothing here fetches, validates or gated — every item is an
 * ordinary <Link> to a route the sidebar already links to.
 *
 * Rendered by MobileTabBar, which only mounts below 768px, so the sheet itself
 * needs no viewport guard: there is no way to open it on desktop.
 */
export function MobileMoreSheet({
  role,
  open,
  onClose,
  returnFocusRef,
}: {
  role: string;
  open: boolean;
  onClose: () => void;
  /** The More button — focus is handed back here when the sheet closes. */
  returnFocusRef?: { current: HTMLElement | null };
}) {
  const pathname = usePathname();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const wasOpen = useRef(false);
  const items = moreItemsFor(role);

  // Escape closes, whether or not focus is inside the sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Move focus into the sheet when it opens; hand it back to the More button
  // when it closes, so a keyboard user never loses their place.
  useEffect(() => {
    if (open) {
      wasOpen.current = true;
      sheetRef.current?.focus();
      return;
    }
    if (wasOpen.current) {
      wasOpen.current = false;
      returnFocusRef?.current?.focus();
    }
  }, [open, returnFocusRef]);

  // The page behind the sheet must not scroll while it is open.
  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  if (!open) return null;

  // Keep Tab inside the dialog while it is open.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Tab") return;
    const root = sheetRef.current;
    if (!root) return;
    const focusables = root.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
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

  // Same endpoint + same destination as the sidebar's own sign-out; the full
  // reload (rather than a client-side replace) is the sidebar's behaviour too.
  // Shell's `writeCachedMe` is module-private, so the session cache is cleared
  // by its storage key — the identical effect.
  const signOut = async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => null);
    try {
      sessionStorage.removeItem("ss_me_v1");
    } catch {
      /* private mode / quota — sign-out must still complete */
    }
    window.location.href = "/login";
  };

  const activeOf = (href: string) => pathname === href || pathname.startsWith(href + "/");

  return (
    <div className="no-print fixed inset-0 z-[70] md:hidden">
      {/* backdrop — clicking it closes, and it is inert to assistive tech */}
      <div className="absolute inset-0 bg-slate-900/45 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="More"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className="ss-sheet-in absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-3xl border-t border-[#E2E8F0] bg-[#F8FAFC] shadow-2xl outline-none"
        style={{ paddingBottom: "calc(env(safe-area-inset-bottom) + 12px)" }}
      >
        <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-slate-300" aria-hidden="true" />

        <div className="flex items-center justify-between px-4 pb-1 pt-3">
          <h2 className="text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">More</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-xl text-slate-400 transition hover:bg-slate-200/70"
          >
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-4 gap-2.5 px-4 pb-4 pt-2">
          {items.map((item) => {
            const isActive = activeOf(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={onClose}
                aria-current={isActive ? "page" : undefined}
                className={cn(
                  "flex min-h-[76px] flex-col items-center justify-center gap-1.5 rounded-2xl border px-1 py-2.5 text-center transition",
                  isActive ? "bg-white" : "border-[#E2E8F0] bg-white hover:border-slate-300"
                )}
                style={isActive ? { borderColor: "rgb(var(--brand, 79 70 229) / 0.45)" } : undefined}
              >
                <span
                  className="flex h-10 w-10 items-center justify-center rounded-xl"
                  style={
                    isActive
                      ? { background: "rgb(var(--brand, 79 70 229) / 0.12)", color: "rgb(var(--brand, 79 70 229))" }
                      : { background: "#F1F5F9", color: "#475569" }
                  }
                >
                  <item.icon size={19} />
                </span>
                <span
                  className="line-clamp-2 text-[10.5px] font-semibold leading-tight"
                  style={isActive ? { color: "rgb(var(--brand, 79 70 229))" } : undefined}
                >
                  {item.label}
                </span>
              </Link>
            );
          })}
        </div>

        <div className="px-4 pb-2">
          <button
            type="button"
            onClick={signOut}
            className="flex min-h-[48px] w-full items-center justify-center gap-2 rounded-2xl border border-[#E2E8F0] bg-white px-4 text-[14px] font-semibold text-rose-600 transition hover:bg-rose-50"
          >
            <LogOut size={16} /> Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
