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
  /** multi-branch (PRD §12.3): "SCHOOL" = whole school, "BRANCH" = one branch */
  scope?: "SCHOOL" | "BRANCH" | null;
  /** the branch a scope="BRANCH" user is confined to */
  branchId?: string | null;
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

export { homeForRole } from "./permissions";

export function guardRole(session: SessionUser | null, ...roles: Role[]): session is SessionUser {
  return !!session && roles.includes(session.role);
}

/** Fields every self-service route needs about the child it is scoped to. */
export interface ActingStudent {
  id: string;
  name: string;
  schoolId: string;
  classId: string | null;
}

/** A guardian's child with the extra fields the self-service routes scope by. */
export interface GuardianChild extends ActingStudent {
  sectionId: string | null;
  admissionNo: string | null;
}

/**
 * Stable sort key for "which child does the portal mean?": earliest admitted
 * first, falling back to when the record was written, then the id — never the
 * order the store handed documents back in, which is arbitrary.
 */
function childOrderKey(s: { id: string; admissionDate?: unknown; createdAt?: unknown }): [number, string] {
  const t = [s.admissionDate, s.createdAt]
    .map((v) => (v ? new Date(v as string).getTime() : NaN))
    .find((v) => Number.isFinite(v));
  return [t ?? Number.MAX_SAFE_INTEGER, String(s.id)];
}

/**
 * Every child a guardian session speaks for (§5.4 sibling/family linking), in a
 * stable order.
 *
 * Three links all mean "own child":
 *   • `student.guardianUserId` — the account itself;
 *   • `student.familyId` — a sibling the family link put in the same household,
 *     so one login covers every child (see /api/parent/siblings);
 *   • `session.studentId` — the narrow QR session, which speaks for one child.
 *
 * Sorted, so `children[0]` is the same child on every request: a bare
 * `findFirst({ guardianUserId })` silently changes which child it answers with the
 * moment a second child joins the account, and then one screen shows child A
 * while the next shows child B.
 */
export async function guardianChildren(session: SessionUser): Promise<GuardianChild[]> {
  if (session.role !== "GUARDIAN" || !session.schoolId) return [];
  const { prisma } = await import("./db");
  const schoolId = session.schoolId;
  const select = {
    id: true,
    name: true,
    schoolId: true,
    classId: true,
    sectionId: true,
    admissionNo: true,
    admissionDate: true,
    createdAt: true,
    familyId: true,
  } as const;
  const linked: any[] = await prisma.student.findMany({
    where: { schoolId, guardianUserId: session.id },
    select,
  });
  const familyIds = [...new Set(linked.map((c) => c.familyId).filter((f): f is string => !!f))];
  const siblings: any[] = familyIds.length
    ? await prisma.student.findMany({ where: { schoolId, familyId: { in: familyIds } }, select })
    : [];
  const byId = new Map<string, any>();
  for (const c of [...linked, ...siblings]) byId.set(c.id, c);
  if (session.studentId && !byId.has(session.studentId)) {
    const qr: any = await prisma.student.findUnique({ where: { id: session.studentId }, select });
    if (qr && qr.schoolId === schoolId) byId.set(qr.id, qr);
  }
  return [...byId.values()].sort((a, b) => {
    const [at, aid] = childOrderKey(a);
    const [bt, bid] = childOrderKey(b);
    return at - bt || (aid < bid ? -1 : aid > bid ? 1 : 0);
  });
}

/** Every child id a guardian session speaks for — the same list, same order. */
export async function guardianChildIds(session: SessionUser): Promise<string[]> {
  return (await guardianChildren(session)).map((c) => c.id);
}

/**
 * The one child a guardian session is acting on.
 *
 * `requestedId` is the child the caller asked for (a `studentId` in the query or
 * the body). It is honoured only when it really is this guardian's child —
 * otherwise there is no child, so a route can never answer with (or write to)
 * another family's student. With no request it is the first of
 * `guardianChildren`, which is stable, so every screen shows the same child.
 */
export async function guardianChildId(session: SessionUser, requestedId?: string | null): Promise<string | null> {
  const children = await guardianChildren(session);
  if (requestedId) return children.find((c) => c.id === requestedId)?.id ?? null;
  return children[0]?.id ?? null;
}

/**
 * Resolve the student a session is acting on behalf of.
 *
 *   STUDENT  → their own record (linked by `student.userId`)
 *   GUARDIAN → their linked child: the requested child when the caller names one
 *              and it belongs to this account, `session.studentId` for QR
 *              sessions, otherwise the stable default child
 *
 * Returns null for any other role and when nothing is linked, so a caller can
 * never be scoped to another family's child.
 */
export async function resolveActingStudent(
  session: SessionUser,
  requestedId?: string | null
): Promise<ActingStudent | null> {
  if (session.role !== "STUDENT" && session.role !== "GUARDIAN") return null;
  const { prisma } = await import("./db");
  const select = { id: true, name: true, schoolId: true, classId: true } as const;

  if (session.role === "STUDENT") {
    return prisma.student.findFirst({ where: { userId: session.id }, select });
  }
  const children = await guardianChildren(session);
  const pick = requestedId ? children.find((c) => c.id === requestedId) : children[0];
  return pick ? { id: pick.id, name: pick.name, schoolId: pick.schoolId, classId: pick.classId } : null;
}

/**
 * True when `student` is this guardian session's own child — or a sibling the
 * family link put in the same household, which is the same thing to a parent.
 *
 * The cheap checks come first (the account link, the QR session); the family
 * expansion is only paid for when the student actually carries a family id.
 */
export async function guardianOwnsStudent(
  session: SessionUser,
  student: { id: string; guardianUserId?: string | null; familyId?: string | null }
): Promise<boolean> {
  if (session.role !== "GUARDIAN") return false;
  if (session.studentId && session.studentId === student.id) return true;
  if (student.guardianUserId && student.guardianUserId === session.id) return true;
  if (!student.familyId) return false;
  return (await guardianChildIds(session)).includes(student.id);
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
