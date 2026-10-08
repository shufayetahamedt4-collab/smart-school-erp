import { SignJWT, jwtVerify } from "jose";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import type { Role } from "@/lib/db";
import { MODE_COOKIE, allowedModes, collegeGateDecision, isMode, normalizeInstitutionType, type Mode } from "./institution";

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

/**
 * The active UI mode for a tenant — the ONE server-side mode resolver.
 *
 * Mode is UI context, never authorization (docs/COLLEGE-DECISIONS.md §3). The
 * resolution is deliberately tenant-first and never trusts the client:
 *
 *   - SCHOOL tenant  → SCHOOL, always (an `ss_mode` cookie is ignored);
 *   - COLLEGE tenant → COLLEGE, always;
 *   - BOTH tenant    → the `ss_mode` cookie the switcher wrote, else the user's
 *                      own `lastMode`, else SCHOOL.
 *
 * Any value that is not a mode, or that the tenant does not allow, is ignored
 * rather than honoured — an old cookie can never make a SCHOOL tenant render as
 * a college. Every mode-scoped cache key and settings key is built from this
 * one answer, so a request cannot mix modes.
 */
export async function resolveActiveMode(schoolId: string | null | undefined): Promise<Mode> {
  if (!schoolId) return "SCHOOL";
  const { prisma } = await import("./db");
  const school = await prisma.school
    .findUnique({ where: { id: schoolId }, select: { institutionType: true } })
    .catch(() => null);
  const allowed = allowedModes(normalizeInstitutionType((school as any)?.institutionType));
  // A single-mode tenant has exactly one valid answer; the cookie cannot change it.
  if (allowed.length <= 1) return allowed[0] ?? "SCHOOL";
  const store = await cookies();
  const fromCookie = store.get(MODE_COOKIE)?.value;
  if (isMode(fromCookie) && allowed.includes(fromCookie)) return fromCookie;
  const session = await getSession();
  if (session?.schoolId && session.schoolId === schoolId) {
    const user = await prisma.user
      .findUnique({ where: { id: session.id }, select: { lastMode: true } })
      .catch(() => null);
    const last = (user as any)?.lastMode;
    if (isMode(last) && allowed.includes(last)) return last;
  }
  return "SCHOOL";
}

/**
 * The COLLEGE-tenant gate — the one check every college surface calls first.
 *
 * College features (departments, programs, and everything later phases add)
 * exist only for a tenant whose `institutionType` is COLLEGE or BOTH. The Edge
 * middleware gates by host and role only (`src/middleware.ts`), and it cannot
 * see `institutionType`, so this in-route check is the sole enforcement: a route
 * that forgets it would let a SCHOOL tenant reach college data by URL.
 *
 * Resolves the tenant's real type server-side (never from the request) and
 * returns a **403** response for a school-only tenant — or **null** when the
 * caller may proceed, the same return shape as `writeGuard()`
 * (`src/lib/subscription.ts`), so a handler reads:
 *
 *   const gate = await requireCollege(session);
 *   if (gate) return gate;
 *
 * `session` only needs `schoolId`; a route that resolves a different tenant
 * (the Super Admin's `?schoolId=`) passes that id explicitly. A caller with no
 * tenant context is a 400, not an allow.
 */
export async function requireCollege(
  session: { schoolId?: string | null } | null | undefined
): Promise<NextResponse | null> {
  const schoolId = session?.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const { prisma } = await import("./db");
  const school = await prisma.school
    .findUnique({ where: { id: schoolId }, select: { institutionType: true } })
    .catch(() => null);
  if (collegeGateDecision((school as any)?.institutionType) === "ALLOW") return null;
  return NextResponse.json(
    { error: "This feature is available to college tenants only." },
    { status: 403 }
  );
}

/**
 * Does this tenant currently hold any **college** data?
 *
 * The DB half of the institution-type change rule (`canChangeInstitutionType`),
 * which stays pure in `./institution`. Phase 2g: the college collections now
 * exist, so this counts **this tenant's own** `departments` and `programs` —
 * always with a `schoolId`-scoped query, never unscoped, so another tenant's
 * rows can never make this tenant look like it holds college data.
 *
 * Phase 5-pre: a `courseRegistrations` count joins them, so a tenant that holds
 * no department and no program but does hold a registration still counts as
 * holding college data — the default named by docs/COLLEGE-PLAN-DELTA.md §8 Q7.
 *
 * **Fails SAFE.** If the store cannot be read, this reports `true` ("has college
 * data"), which makes a COLLEGE/BOTH → SCHOOL downgrade *refused* rather than
 * allowed. A false refusal is recoverable; a wrong downgrade would strand the
 * tenant's college rows behind a school-only shape. It lives here, beside
 * `requireCollege`, because this is the module allowed to import the store.
 */
export async function schoolHasCollegeData(schoolId: string): Promise<boolean> {
  // No tenant to scope to is treated as "holds data": never downgrade blind.
  if (!schoolId) return true;
  try {
    const { prisma } = await import("./db");
    const [departments, programs, registrations] = await Promise.all([
      prisma.department.count({ where: { schoolId } }),
      prisma.program.count({ where: { schoolId } }),
      prisma.courseRegistration.count({ where: { schoolId } }),
    ]);
    return departments > 0 || programs > 0 || registrations > 0;
  } catch {
    return true;
  }
}

export { homeForRole } from "./permissions";

export function guardRole(session: SessionUser | null, ...roles: Role[]): session is SessionUser {
  return !!session && roles.includes(session.role);
}

/** Account fields that must never leave the API in a response body. */
const USER_SECRET_FIELDS = ["passwordHash", "twoFactorSecret", "totpSecret", "backupCodes", "backupHashes"];

/**
 * What may leave the API about a user account — the one definition.
 *
 * The Firestore shim returns whole documents (it ignores `select`), so any route
 * that puts a user document straight into a response ships that account's bcrypt
 * hash to the browser, and the demo shares one password, so a leaked hash is a
 * leaked account. Routes that return a user must send it through here rather
 * than spreading the field off by hand at each call site.
 *
 * Only /api/settings is exempt in spirit: it stores a platform-wide
 * `default_guardian_password` setting, which is configuration, not an account
 * field, and is readable by the super admin alone.
 */
export function publicUser<T extends Record<string, any>>(user: T): T {
  const safe: Record<string, any> = { ...(user as any) };
  for (const field of USER_SECRET_FIELDS) delete safe[field];
  return safe as T;
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
  // Target the guardian's OWN rows instead of scanning the school.
  //
  // `where: { schoolId, guardianUserId }` is NOT a targeted query in this data
  // layer: it pushes only the `schoolId` equality down to Firestore (a single
  // equality filter is all the pull can push), then filters `guardianUserId` in
  // memory — so every guardian read pulled the whole school's students (610 rows
  // in the demo, ~4.9s cold on /api/auth/me) just to keep two. Asking for
  // `guardianUserId` alone pushes THAT equality down (a single-field equality
  // query — no composite index), so only the guardian's own rows cross the wire;
  // the school boundary is enforced here, on the returned rows, which is exactly
  // the filter the old query applied. Same rows, same order (the sort below),
  // same isolation — just not the whole school.
  const linked: any[] = (
    await prisma.student.findMany({ where: { guardianUserId: session.id }, select })
  ).filter((c) => c.schoolId === schoolId);
  const familyIds = [...new Set(linked.map((c) => c.familyId).filter((f): f is string => !!f))];
  // Same reasoning for the sibling expansion: a `familyId: { in: [...] }` clause
  // is an object condition, so it pushed no filter and re-scanned the school
  // under the cached `schoolId` key. One single-field equality pull per family id
  // is targeted and index-free; the school check keeps it to this school.
  const siblingLists = await Promise.all(
    familyIds.map((familyId) => prisma.student.findMany({ where: { familyId }, select }))
  );
  const siblings: any[] = siblingLists.flat().filter((c) => c.schoolId === schoolId);
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
