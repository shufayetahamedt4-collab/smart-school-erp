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
  | "platformBilling";

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
    ACCOUNTANT: [R.view],
    TEACHER: [R.viewOwnClass],
    GUARDIAN: [R.viewOwnChild],
    STUDENT: [R.viewOwn],
  },
  feePayment: {
    SUPER_ADMIN: [R.billing],
    SCHOOL_ADMIN: [R.full],
    ACCOUNTANT: [R.full],
    GUARDIAN: [R.view, R.pay],
    STUDENT: [R.view],
  },
  attendanceMarks: {
    SCHOOL_ADMIN: [R.full],
    TEACHER: [R.entry],
    GUARDIAN: [R.view],
    STUDENT: [R.viewOwn],
  },
  teachingMaterial: {
    SCHOOL_ADMIN: [R.full],
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
    ACCOUNTANT: [R.entry, R.view],
    FRONT_DESK: [R.entry, R.view],
  },
  library: {
    SCHOOL_ADMIN: [R.full],
    LIBRARIAN: [R.full],
    TEACHER: [R.view],
    GUARDIAN: [R.view],
    STUDENT: [R.view],
  },
  communication: {
    SUPER_ADMIN: [R.view],
    SCHOOL_ADMIN: [R.full],
    TEACHER: [R.full],
    GUARDIAN: [R.view, R.entry],
    STUDENT: [R.view, R.entry],
    FRONT_DESK: [R.view],
  },
  platformBilling: {
    SUPER_ADMIN: [R.full],
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
      return "/student";
    default:
      // Sub-roles (ACCOUNTANT, LIBRARIAN, FRONT_DESK) live inside the Admin
      // panel as permission-controlled views (PRD §2 note).
      return "/dashboard";
  }
}
