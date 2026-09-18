import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { subscriptionStateForSession } from "@/lib/subscription";

/**
 * Subscription state for the current session's school (PRD §12.1).
 * Consumed by the SubscriptionProvider for banners/lock screens.
 * Returns a benign NONE state for platform admins / no school context.
 */
export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Super Admin manages billing, not bound by a school subscription.
  const state = session.role === "SUPER_ADMIN" ? null : await subscriptionStateForSession(session.schoolId);
  return NextResponse.json({
    data:
      state || {
        status: "NONE",
        canWrite: true,
        planName: null,
        maxStudents: null,
        currentPeriodEnd: null,
        daysLeft: null,
        trial: false,
      },
  });
}
