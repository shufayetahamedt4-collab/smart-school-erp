import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { jwtVerify } from "jose";

const SESSION_COOKIE = "ss_token";

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET || "smart-school-erp-secret-change-me-in-production");

const GUARDS: { prefix: string; roles: string[] }[] = [
  { prefix: "/admin", roles: ["SUPER_ADMIN"] },
  { prefix: "/dashboard", roles: ["SCHOOL_ADMIN", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"] },
  { prefix: "/teacher", roles: ["TEACHER"] },
  { prefix: "/parent", roles: ["GUARDIAN"] },
  { prefix: "/student", roles: ["STUDENT"] },
  { prefix: "/print", roles: ["SUPER_ADMIN", "SCHOOL_ADMIN", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK", "TEACHER", "GUARDIAN", "STUDENT"] },
];

const HOME: Record<string, string> = {
  SUPER_ADMIN: "/admin",
  SCHOOL_ADMIN: "/dashboard",
  ACCOUNTANT: "/dashboard/fees",
  LIBRARIAN: "/dashboard/library",
  FRONT_DESK: "/dashboard/admissions",
  TEACHER: "/teacher",
  GUARDIAN: "/parent",
  STUDENT: "/student",
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const guard = GUARDS.find((g) => pathname.startsWith(g.prefix));
  if (!guard) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  let payload: any = null;
  if (token) {
    try {
      const { payload: p } = await jwtVerify(token, secret());
      payload = p;
    } catch {
      // invalid token
    }
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);

  if (!payload?.role) {
    return NextResponse.redirect(loginUrl);
  }
  if (!guard.roles.includes(payload.role)) {
    return NextResponse.redirect(new URL(HOME[payload.role] || "/login", req.url));
  }
  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*", "/dashboard/:path*", "/teacher/:path*", "/parent/:path*", "/print/:path*"],
};
