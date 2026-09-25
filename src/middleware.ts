import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";
import { SECTOR_LIST, resolveSector, sectorForRole, sectorHostFor, stripPort, isSharedPath, requestHost, type Sector } from "@/lib/sectors";

const SESSION_COOKIE = "ss_token";

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET || "smart-school-erp-secret-change-me-in-production");

/**
 * Legacy (hub) role guards. These apply on the bare/unknown host, which stays
 * host-agnostic so local development, the verification harnesses and the
 * default App Hosting URL behave exactly as before. Every app host is strictly
 * scoped by `sectorRouting()` instead.
 */
const HUB_GUARDS: { prefix: string; roles: string[] }[] = [
  { prefix: "/admin", roles: ["SUPER_ADMIN"] },
  { prefix: "/dashboard", roles: ["SCHOOL_ADMIN", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"] },
  { prefix: "/teacher", roles: ["TEACHER"] },
  { prefix: "/parent", roles: ["GUARDIAN"] },
  { prefix: "/print", roles: ["SUPER_ADMIN", "SCHOOL_ADMIN", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK", "TEACHER", "GUARDIAN", "STUDENT"] },
];

const HUB_HOME: Record<string, string> = {
  SUPER_ADMIN: "/admin",
  SCHOOL_ADMIN: "/dashboard",
  ACCOUNTANT: "/dashboard/fees",
  LIBRARIAN: "/dashboard/library",
  FRONT_DESK: "/dashboard/admissions",
  TEACHER: "/teacher",
  GUARDIAN: "/parent",
};

/**
 * Credential-free entries into the Parents App:
 *   /qr           — the QR code printed on a child's ID card
 *   /s/<slug>     — the invite link a school prints for its guardians
 * Neither grants a session: both only open the app for the right school.
 */
const GUARDIAN_ENTRY = ["/qr", "/s"];

function isGuardianEntry(pathname: string): boolean {
  return GUARDIAN_ENTRY.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** Build a URL for the same path on another host of this deployment. */
function urlOn(req: NextRequest, host: string, pathname: string, search = "") {
  const u = new URL(req.url);
  u.host = host;
  u.pathname = pathname;
  u.search = search;
  return u;
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const host = requestHost(req.headers);

  // The API is the shared backend behind every app — never host-routed.
  if (pathname.startsWith("/api")) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  let role: string | null = null;
  if (token) {
    try {
      role = ((await jwtVerify(token, secret())).payload.role as string) || null;
    } catch {
      // invalid/expired token → treated as anonymous
    }
  }

  const sector = resolveSector(host);
  return sector ? sectorRouting(req, pathname, search, role, sector, host) : hubRouting(req, pathname, search, role, host);
}

/**
 * Hub host (bare domain / unknown): unchanged role gating, plus the QR entry
 * point is handed to the guardian app when a guardian host is configured.
 */
function hubRouting(req: NextRequest, pathname: string, search: string, role: string | null, host: string) {
  if (isGuardianEntry(pathname)) {
    const target = sectorHostFor(host, "guardian");
    if (target && target !== stripPort(host)) return NextResponse.redirect(urlOn(req, target, pathname, search));
  }

  const guard = HUB_GUARDS.find((g) => pathname.startsWith(g.prefix));
  if (!guard) return NextResponse.next();

  if (!role) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }
  if (!guard.roles.includes(role)) {
    return NextResponse.redirect(new URL(HUB_HOME[role] || "/login", req.url));
  }
  return NextResponse.next();
}

/**
 * App host: this host answers for exactly one sector.
 *  - its own area         → role-gated to that sector's roles
 *  - another app's area   → bounced to that app's host (or to the user's own)
 *  - shared paths         → allowed (sign-in, marketing, QR, printing, apply)
 *  - anything else        → the app's front door
 */
function sectorRouting(req: NextRequest, pathname: string, search: string, role: string | null, sector: Sector, host: string) {
  // The app's front door.
  if (pathname === "/") {
    return NextResponse.redirect(new URL(role && sector.roles.includes(role) ? sector.home : "/login", req.url));
  }

  // The guardian entry points belong to the Parents App — always run them there.
  if (isGuardianEntry(pathname) && sector.key !== "guardian") {
    const target = sectorHostFor(host, "guardian");
    if (target && target !== stripPort(host)) return NextResponse.redirect(urlOn(req, target, pathname, search));
  }

  if (isSharedPath(pathname)) {
    // Already signed in to this app? /login goes to the app home.
    if (pathname === "/login" && role && sector.roles.includes(role)) {
      return NextResponse.redirect(new URL(sector.home, req.url));
    }
    return NextResponse.next();
  }

  // Another app's area reached on this host.
  const other = SECTOR_LIST.find(
    (s) => s.key !== sector.key && (pathname === s.prefix || pathname.startsWith(s.prefix + "/"))
  );
  if (other) {
    const target = sectorHostFor(host, other.key);
    if (target && target !== stripPort(host)) return NextResponse.redirect(urlOn(req, target, pathname, search));
    // No routable sibling host: send them to the app they actually belong to.
    const mine = sectorForRole(role);
    return NextResponse.redirect(new URL(mine ? mine.home : "/login", req.url));
  }

  // This app's own area.
  if (pathname === sector.prefix || pathname.startsWith(sector.prefix + "/")) {
    if (!role) {
      const loginUrl = new URL("/login", req.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
    if (sector.roles.includes(role)) return NextResponse.next();

    // Signed in, but with an account that belongs to a different app.
    const mine = sectorForRole(role);
    if (mine && mine.key === sector.key) return NextResponse.next();
    const target = mine ? sectorHostFor(host, mine.key) : null;
    if (mine && target && target !== stripPort(host)) return NextResponse.redirect(urlOn(req, target, mine.home));
    return NextResponse.redirect(new URL("/login", req.url));
  }

  // Unknown path on an app host.
  return NextResponse.redirect(new URL(sector.home, req.url));
}

export const config = {
  /* Every app area, plus the paths that must resolve per host. Static assets
     are never matched. (Note the old matcher included a /student area: there is
     no student app any more — see src/lib/sectors.ts.) */
  matcher: [
    "/",
    "/login",
    "/welcome",
    "/apply/:path*",
    "/qr/:path*",
    "/s/:path*",
    "/admin/:path*",
    "/dashboard/:path*",
    "/teacher/:path*",
    "/parent/:path*",
    "/print/:path*",
  ],
};
