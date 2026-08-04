import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import type { Role } from "@/lib/db";

export const SESSION_COOKIE = "ss_token";

export interface SessionUser {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  schoolId: string | null;
  /** set when a guardian session is created via QR code (no account) */
  studentId?: string;
}

const secret = () => new TextEncoder().encode(process.env.JWT_SECRET || "smart-school-erp-secret-change-me-in-production");

export async function signSession(user: SessionUser, days = 7): Promise<string> {
  return new SignJWT({ ...user })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${days}d`)
    .sign(secret());
}

export async function verifySession(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, secret());
    return payload as unknown as SessionUser;
  } catch {
    return null;
  }
}

export async function getSession(): Promise<SessionUser | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySession(token);
}

export async function getSessionOrThrow(): Promise<SessionUser> {
  const session = await getSession();
  if (!session) throw new Error("Unauthorized");
  return session;
}

export function homeForRole(role: Role | string): string {
  switch (role) {
    case "SUPER_ADMIN":
      return "/admin";
    case "SCHOOL_ADMIN":
      return "/dashboard";
    case "TEACHER":
      return "/teacher";
    case "GUARDIAN":
      return "/parent";
    default:
      return "/login";
  }
}

export function guardRole(session: SessionUser | null, ...roles: Role[]): session is SessionUser {
  return !!session && roles.includes(session.role);
}

export async function audit(action: string, entity?: string, entityId?: string, details?: unknown) {
  const session = await getSession().catch(() => null);
  const { prisma } = await import("./db");
  return prisma.auditLog.create({
    data: {
      action,
      entity,
      entityId,
      details: details ? JSON.parse(JSON.stringify(details)) : undefined,
      userId: session?.id,
      schoolId: session?.schoolId ?? undefined,
    },
  }).catch(() => null);
}
