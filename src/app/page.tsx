import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { verifySession, homeForRole, SESSION_COOKIE } from "@/lib/auth";

/**
 * Root route:
 *  - logged in  → their role dashboard (/admin, /dashboard, /teacher, /parent)
 *  - anonymous  → go straight to the login screen; /welcome remains available
 *                 as an explicit marketing/landing route if needed.
 */
export default async function Home() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const session = await verifySession(token);
    if (session) redirect(homeForRole(session.role));
  }
  redirect("/login");
}
