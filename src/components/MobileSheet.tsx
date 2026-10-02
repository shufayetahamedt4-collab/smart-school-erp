"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The Teacher App's new-item sheet — ONE dialog with two shapes.
 *
 * Below 768px it is a bottom sheet: anchored to the bottom edge, full width,
 * flush over the tab bar, and dismissible with a thumb. At 768px and above it is
 * the centred card the app has always used — `p-4`, `max-w-lg` (or `max-w-3xl`
 * when `wide`), `rounded-2xl`, `max-h-[90vh]`. Only the box model changes; the
 * title, the body and the children are the same DOM at every width, so there is
 * no second card list to keep in sync.
 *
 * It replaces `Modal` for the two teacher authoring forms (homework and quizzes).
 * `Modal` is centre-anchored at every width and has no Escape handler; this adds
 * the phone-native shape plus Escape, a Tab trap and a scroll lock, and it
 * touches no request, no validation and no route — presentation only.
 */
export function MobileSheet({
  open,
  onClose,
  title,
  wide,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: React.ReactNode;
  wide?: boolean;
  children: React.ReactNode;
}) {
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Escape closes, whether or not focus is inside the sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Move focus into the sheet when it opens; hand it back to whatever opened it
  // when it closes, so a keyboard user never loses their place.
  useEffect(() => {
    if (open) {
      returnFocusRef.current = (document.activeElement as HTMLElement) || null;
      sheetRef.current?.focus();
      return;
    }
    returnFocusRef.current?.focus?.();
  }, [open]);

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
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
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

  return (
    <div className="no-print fixed inset-0 z-50 flex items-end justify-center md:items-center md:p-4">
      <div className="absolute inset-0 bg-slate-900/50 backdrop-blur-sm" onClick={onClose} aria-hidden="true" />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
        tabIndex={-1}
        onKeyDown={onKeyDown}
        className={cn(
          "ss-sheet-in relative flex max-h-[88vh] w-full flex-col rounded-t-3xl bg-white shadow-2xl outline-none",
          "md:max-h-[90vh] md:rounded-2xl",
          wide ? "md:max-w-3xl" : "md:max-w-lg"
        )}
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-slate-300 md:hidden" aria-hidden="true" />

        <div className="flex shrink-0 items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-base font-bold text-slate-800">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-11 w-11 items-center justify-center rounded-lg text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
          >
            <X size={18} />
          </button>
        </div>

        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
