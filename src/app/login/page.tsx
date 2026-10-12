import { Suspense } from "react";
import { headers } from "next/headers";
import { SECTOR_LIST, resolveSector, requestHost, sectorHostFor } from "@/lib/sectors";
import LoginForm from "@/components/LoginForm";
import PortalChooser from "@/components/PortalChooser";
import { demoAccountsFor } from "@/lib/demo-accounts";

/**
 * One route, one app per host.
 *
 *   parents.<domain>/login  → the Parents App sign-in screen
 *   teacher.<domain>/login  → the Teacher App sign-in screen
 *   <bare domain>/login     → the hub, in one of two shapes:
 *       · the four apps have their own addresses (APP_DOMAIN, or
 *         <label>.localhost in development) → a directory of them
 *       · they don't (a bare IP, a platform URL such as <site>.netlify.app)
 *         → the ONE sign-in page, because that host already serves every app
 *           and the account decides where the visitor lands. A directory of
 *           four unlinked cards there is a dead end: no way in at all.
 *
 * There is no longer a single sign-in page that offers every role on an app
 * host; that job belongs to the account, and only the hub needs it.
 */
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const h = await headers();
  const host = requestHost(h);
  const sector = resolveSector(host);
  // pilot-fix-1 item 4 — the demo quick-fill accounts are resolved HERE, on the
  // server, and are empty on a deployment. They are never a client constant, so a
  // production bundle carries neither the credentials nor the card.
  const demoAccounts = demoAccountsFor(process.env);
  // Scheme for the app links shown on the hub (behind a proxy in production).
  const protocol = (h.get("x-forwarded-proto") || (process.env.NODE_ENV === "production" ? "https" : "http"))
    .split(",")[0]
    .trim();

  if (!sector) {
    const routed = SECTOR_LIST.some((s) => sectorHostFor(host, s.key));
    return routed ? <PortalChooser host={host} protocol={protocol} /> : <SignIn hub demoAccounts={demoAccounts} />;
  }

  return <SignIn sector={sector.key} demoAccounts={demoAccounts} />;
}

function SignIn({
  sector,
  hub,
  demoAccounts,
}: {
  sector?: Parameters<typeof LoginForm>[0]["sector"];
  hub?: boolean;
  demoAccounts: ReturnType<typeof demoAccountsFor>;
}) {
  return (
    <Suspense fallback={<div className="flex min-h-screen items-center justify-center bg-white" />}>
      <LoginForm sector={sector} hub={hub} demoAccounts={demoAccounts} />
    </Suspense>
  );
}
