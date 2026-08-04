import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { verifySession, homeForRole, SESSION_COOKIE } from "@/lib/auth";

/**
 * Root route:
 *  - logged in  → their role dashboard (/admin, /dashboard, /teacher, /parent)
 *  - anonymous  → the marketing landing page (/welcome), which is the entry
 *                 point for schools to install the app and sign in.
 */
export default async function Home() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token) {
    const session = await verifySession(token);
    if (session) redirect(homeForRole(session.role));
  }
  redirect("/welcome");
}
