"use client";

import { useEffect } from "react";

/**
 * PRD §14 — client diagnostics helper.
 *
 * Next's dev overlay shows `Unhandled Runtime Error: [object Event]` when a
 * promise rejects with a raw browser Event (e.g. a script/style resource that
 * failed to load), because `String(event)` is "[object Event]" — no message,
 * no stack. This listener unpacks the Event (ErrorEvent.message, resource
 * target URL, …) and logs a readable description plus the original object,
 * so the console always shows the real cause instead of "[object Event]".
 *
 * The listeners are passive observers — they never swallow or preventDefault
 * anything, so Next's own overlay and error handling behave exactly as before;
 * they only add a readable console line describing the real cause.
 */
export function ErrorDiagnostics() {
  useEffect(() => {
    const describeEvent = (e: Event): string => {
      if ("message" in e && typeof (e as ErrorEvent).message === "string") {
        const ee = e as ErrorEvent;
        const at = ee.filename ? ` (${ee.filename}:${ee.lineno}:${ee.colno})` : "";
        return `ErrorEvent: ${ee.message || "(empty message)"}${at}`;
      }
      const target = (e as Event & { target?: EventTarget | null }).target as
        | (HTMLScriptElement | HTMLLinkElement | HTMLImageElement | null);
      if (target && target !== e.currentTarget) {
        const url =
          ("src" in target && target.src) ||
          ("href" in target && target.href) ||
          "(unknown url)";
        return `Resource failed to load: ${url}`;
      }
      return `${e.constructor?.name || "Event"} of type "${e.type}"`;
    };

    const onRejection = (ev: PromiseRejectionEvent) => {
      const reason: unknown = ev.reason;
      if (reason instanceof Event) {
        console.error(`[diagnostics] Unhandled rejection with a raw Event — ${describeEvent(reason)}`, reason);
        return; // keep visible to Next's overlay, but with a readable log line
      }
      if (reason instanceof Error && reason.stack) {
        console.error(`[diagnostics] Unhandled rejection: ${reason.message}`, reason);
      }
    };

    const onError = (ev: ErrorEvent) => {
      console.error(`[diagnostics] Uncaught error: ${ev.message || "(empty)"} at ${ev.filename}:${ev.lineno}:${ev.colno}`);
    };

    window.addEventListener("unhandledrejection", onRejection);
    window.addEventListener("error", onError);
    return () => {
      window.removeEventListener("unhandledrejection", onRejection);
      window.removeEventListener("error", onError);
    };
  }, []);

  return null;
}
