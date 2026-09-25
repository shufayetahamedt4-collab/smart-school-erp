import type { SessionUser } from "./auth";
import type { Role } from "./db";

/**
 * PRD §2.1 — central permission matrix.
 *
 * Modules × roles → allowed actions. Single source of truth enforced by
 * requirePermission() / withRoute() on every API route (PRD §14.1:
 * "Role-based Access Control must be enforced on all API routes").
 * Roles 6–9 (ACCOUNTANT, LIBRARIAN, FRONT_DESK) are permission-controlled
 * sub-roles that surface inside the Admin panel UI — same matrix applies.
 */

export type ModuleKey =
  | "studentTeacherInfo"
  | "feePayment"
  | "attendanceMarks"
  | "teachingMaterial"
  | "systemSettings"
  | "admission"
  | "library"
  | "communication"
  | "platformBilling"
  | "branches"
  | "staff";

export type Action = "view" | "viewOwn" | "viewOwnChild" | "viewOwnClass" | "entry" | "full" | "pay" | "upload" | "billing";

type Actions = Action[];

const R = {
  full: "full" as Action,
  view: "view" as Action,
  viewOwn: "viewOwn" as Action,
  viewOwnChild: "viewOwnChild" as Action,
  viewOwnClass: "viewOwnClass" as Action,
  entry: "entry" as Action,
  pay: "pay" as Action,
  upload: "upload" as Action,
  billing: "billing" as Action,
};

/**
 * Permission matrix (PRD §2.1), extended with the modules the PRD introduces.
 * SUPER_ADMIN always has platform-level access via explicit entries here.
 */
export const MATRIX: Record<ModuleKey, Partial<Record<Role, Actions>>> = {
  studentTeacherInfo: {
    SCHOOL_ADMIN: [R.full],
    BRANCH_ADMIN: [R.full],
    ACCOUNTANT: [R.view],
    REGISTRAR: [R.view],
    TEACHER: [R.viewOwnClass],
    GUARDIAN: [R.viewOwnChild],
    STUDENT: [R.viewOwn],
  },
  feePayment: {
    SUPER_ADMIN: [R.billing],
    SCHOOL_ADMIN: [R.full],
    BRANCH_ADMIN: [R.full],
    ACCOUNTANT: [R.full],
    REGISTRAR: [R.view],
    GUARDIAN: [R.view, R.pay],
    STUDENT: [R.view],
  },
  attendanceMarks: {
    SCHOOL_ADMIN: [R.full],
    BRANCH_ADMIN: [R.full],
    REGISTRAR: [R.view],
    TEACHER: [R.entry],
    GUARDIAN: [R.view],
    STUDENT: [R.viewOwn],
  },
  teachingMaterial: {
    SCHOOL_ADMIN: [R.full],
    BRANCH_ADMIN: [R.full],
    TEACHER: [R.upload],
    GUARDIAN: [R.view],
    STUDENT: [R.view],
  },
  systemSettings: {
    SUPER_ADMIN: [R.full],
    SCHOOL_ADMIN: [R.full],
  },
  admission: {
    SCHOOL_ADMIN: [R.full],
    BRANCH_ADMIN: [R.full],
    ACCOUNTANT: [R.entry, R.view],
    REGISTRAR: [R.entry, R.view],
    FRONT_DESK: [R.entry, R.view],
  },
  library: {
    SCHOOL_ADMIN: [R.full],
    BRANCH_ADMIN: [R.full],
    LIBRARIAN: [R.full],
    TEACHER: [R.view],
    GUARDIAN: [R.view],
    STUDENT: [R.view],
  },
  communication: {
    SUPER_ADMIN: [R.view],
    SCHOOL_ADMIN: [R.full],
    BRANCH_ADMIN: [R.full],
    REGISTRAR: [R.view, R.entry],
    TEACHER: [R.full],
    GUARDIAN: [R.view, R.entry],
    STUDENT: [R.view, R.entry],
    FRONT_DESK: [R.view],
  },
  platformBilling: {
    SUPER_ADMIN: [R.full],
  },
  // Multi-branch PRD §12.3: main admin manages branch records & the ERP
  // permission; a BRANCH_ADMIN may only see the branch list.
  branches: {
    SUPER_ADMIN: [R.full],
    SCHOOL_ADMIN: [R.full],
    BRANCH_ADMIN: [R.view],
    REGISTRAR: [R.view],
  },
  // Staff & role assignment: main admin manages everyone; a BRANCH_ADMIN
  // manages staff of their own branch only (enforced via scopeWhere).
  staff: {
    SUPER_ADMIN: [R.full],
    SCHOOL_ADMIN: [R.full],
    BRANCH_ADMIN: [R.full],
  },
};

export class PermissionError extends Error {
  status = 403;
  constructor(message = "Forbidden") {
    super(message);
  }
}

/**
 * Actions imply weaker actions: `full` covers entry/pay/upload and every read;
 * `entry` covers uploads and reads; a plain `view` covers the narrower
 * viewOwn* scopes. Checking implication keeps the matrix declarative — roles
 * don't need to list `view` alongside `full` everywhere.
 */
const IMPLIED: Partial<Record<Action, Action[]>> = {
  full: ["entry", "pay", "upload", "billing", "view", "viewOwn", "viewOwnChild", "viewOwnClass"],
  entry: ["upload", "view", "viewOwn", "viewOwnChild", "viewOwnClass"],
  billing: ["view"],
  pay: ["view", "viewOwn", "viewOwnChild"],
  upload: ["view"],
  view: ["viewOwn", "viewOwnChild", "viewOwnClass"],
};

/** Does this role hold `action` (or an action implying it) on `module`? SUPER_ADMIN passes everything. */
export function can(role: Role | string | undefined | null, module: ModuleKey, action: Action): boolean {
  if (!role) return false;
  if (role === "SUPER_ADMIN") return true;
  const actions = MATRIX[module]?.[role as Role];
  if (!actions) return false;
  if (actions.includes(action)) return true;
  return actions.some((a) => IMPLIED[a]?.includes(action));
}

export function requirePermission(
  session: { role?: Role | string | null } | null | undefined,
  module: ModuleKey,
  action: Action
): void {
  if (!session) throw new PermissionError("Unauthorized");
  if (!can(session.role, module, action)) throw new PermissionError("Forbidden");
}

/** Home route per role (used by middleware/login/UI). */
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
    case "STUDENT":
      // There is no student app: students do not carry phones in class, so every
      // family-facing facility lives in the Parents App (guardian's device).
      // A STUDENT session is API-only — there is no page of its own to land on.
      return "/login";
    default:
      // Sub-roles (ACCOUNTANT, LIBRARIAN, FRONT_DESK, REGISTRAR, BRANCH_ADMIN)
      // live inside the Admin panel as permission-controlled views (PRD §2 note).
      return "/dashboard";
  }
}

// ---------------------------------------------------------------------------
// Branch scoping (PRD §12.3 multi-branch support)
// ---------------------------------------------------------------------------
//
// A school can have many branches. Every user record optionally carries:
//   scope    – "SCHOOL" (whole school: main admin & staff that work it all)
//              or "BRANCH" (a user that only manages their own branch)
//   branchId – the single branch a "BRANCH" user is confined to
//
// The main admin (scope SCHOOL) sees and manages every branch; a branch user
// sees and manages only their own branch's data. `scopeWhere` turns a session
// into the right Firestore where-clause prefix for that rule.

export type RoleScope = "SCHOOL" | "BRANCH";

/** Management/back-office roles that the Staff & Roles page manages (no teachers/guardians/students). */
export const MANAGEMENT_ROLES: Role[] = ["BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK"];

/** Roles that belong to the school dashboard and show up in the staff list. */
export const STAFF_ROLES: Role[] = ["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK", "TEACHER"];

/** True when a session is confined to a single branch. */
export function isBranchScoped(session: Pick<SessionUser, "role" | "scope" | "branchId"> | null | undefined): boolean {
  return (
    !!session &&
    session.role !== "SUPER_ADMIN" &&
    (session.scope === "BRANCH" || !!session.branchId)
  );
}

/** True when the session may touch the given branch (SUPER_ADMIN / SCHOOL scope always may). */
export function canAccessBranch(
  session: Pick<SessionUser, "role" | "scope" | "branchId" | "schoolId"> | null | undefined,
  branchId: string | null | undefined
): boolean {
  if (!session) return false;
  if (session.role === "SUPER_ADMIN") return true;
  if (!branchId) return !isBranchScoped(session);
  return !isBranchScoped(session) || session.branchId === branchId;
}

/** Throw a 403 when the session is not allowed to operate on the given branch. */
export function assertCanAccessBranch(
  session: Pick<SessionUser, "role" | "scope" | "branchId" | "schoolId"> | null | undefined,
  branchId: string | null | undefined
): void {
  if (!canAccessBranch(session, branchId)) throw new PermissionError("You do not have access to this branch.");
}

/**
 * Default where-clause for tenant-owned reads/writes so a branch user can only
 * ever see their own branch's rows while a school-scoped user sees all branches.
 *
 *   scopeWhere(session)                                   → { schoolId }
 *   scopeWhere(session, { branchId })                     → { schoolId, branchId }
 *   scopeWhere(session, { branchId }, { active: true })   → { schoolId, branchId, active: true }
 */
export function scopeWhere(
  session: Pick<SessionUser, "role" | "scope" | "branchId" | "schoolId"> | null | undefined,
  extra: Record<string, any> = {}
): Record<string, any> {
  const where: Record<string, any> = {};
  if (session?.schoolId) where.schoolId = session.schoolId;
  if (session && isBranchScoped(session)) where.branchId = session.branchId;
  return { ...where, ...extra };
}
