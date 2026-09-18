"use client";

import { createContext, useContext, useEffect, useState } from "react";
import Link from "next/link";
import { Lock, Clock, ShieldAlert } from "lucide-react";

/**
 * PRD §12.1 — subscription state surfaced in the UI: banner when the period
 * is ending or the school is past-due; a read-only lock screen when locked.
 * Fetched once per layout from /api/subscription/state.
 */

interface SubState {
  status: "TRIAL" | "ACTIVE" | "PAST_DUE" | "LOCKED" | "CANCELLED" | "NONE";
  canWrite: boolean;
  planName: string | null;
  daysLeft: number | null;
}

const Ctx = createContext<SubState | null>(null);

export function useSubscription(): SubState | null {
  return useContext(Ctx);
}

/** Mount inside school-scoped layouts (dashboard/teacher/parent/student). */
export function SubscriptionProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<SubState | null>(null);

  useEffect(() => {
    fetch("/api/subscription/state")
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => setState(b?.data || null))
      .catch(() => null);
  }, []);

  return <Ctx.Provider value={state}>{children}</Ctx.Provider>;
}

/** Non-blocking banner — render at the top of a layout. */
export function SubscriptionBanner() {
  const state = useSubscription();
  if (!state || state.status === "NONE" || state.status === "ACTIVE") return null;
  if (state.status === "LOCKED") return null; // locked UI handled by <SubscriptionLock />

  const tone =
    state.status === "PAST_DUE"
      ? "border-rose-200 bg-rose-50 text-rose-700"
      : "border-amber-200 bg-amber-50 text-amber-700";

  const icon = state.status === "PAST_DUE" ? <ShieldAlert size={15} /> : <Clock size={15} />;
  const text =
    state.status === "PAST_DUE"
      ? "Subscription period ended — the school is in the grace period. Renew to continue making changes."
      : state.status === "TRIAL"
        ? `Trial (${state.planName || "Trial"} plan) — ${state.daysLeft ?? "?"} day(s) left.`
        : `Subscription period ends in ${state.daysLeft ?? "?"} day(s).`;

  return (
    <div className={`no-print flex items-center gap-2 rounded-xl border px-4 py-2.5 text-xs font-semibold ${tone}`}>
      {icon} {text}
    </div>
  );
}

/** Read-only lock screen for locked schools (data is never deleted). */
export function SubscriptionLock() {
  const state = useSubscription();
  if (!state || state.status !== "LOCKED") return null;
  return (
    <div className="no-print fixed inset-0 z-[100] flex items-center justify-center bg-slate-900/70 p-4 backdrop-blur-sm">
      <div className="max-w-md rounded-2xl bg-white p-8 text-center shadow-2xl">
        <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl bg-rose-100 text-rose-600">
          <Lock size={26} />
        </div>
        <h2 className="text-lg font-black text-slate-900">School account locked</h2>
        <p className="mt-2 text-sm text-slate-500">
          The subscription for <b>{state.planName || "this school"}</b> has expired and the grace period is over.
          Your data is safe — renew the subscription to restore access.
        </p>
        <p className="mt-3 rounded-xl bg-slate-50 px-4 py-2 text-xs text-slate-500">
          Contact the platform administrator to renew (PRD §12.1 — auto-lock after trial/grace; data is never deleted).
        </p>
      </div>
    </div>
  );
}
