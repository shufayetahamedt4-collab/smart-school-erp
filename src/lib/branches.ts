import { prisma } from "./db";
import type { SessionUser } from "./auth";
import { canAccessBranch } from "./permissions";

/**
 * PRD §12.3 — resolve the branch a new tenant record (student, class, teacher…)
 * belongs to.
 *
 *   BRANCH-scoped user  → their own branch, always (they can't pick another)
 *   SCHOOL-scoped user  → the explicit `branchId` from the form when given,
 *                         otherwise the school's first branch ("Main Campus")
 *   SUPER_ADMIN         → the explicit branch, or none
 */
export async function resolveBranchId(
  session: Pick<SessionUser, "role" | "scope" | "branchId" | "schoolId"> | null | undefined,
  explicit?: string | null
): Promise<string | null> {
  if (!session) return explicit || null;
  if (session.role === "SUPER_ADMIN") return explicit || null;
  if (session.scope === "BRANCH" && session.branchId) return session.branchId;
  if (explicit) {
    if (!canAccessBranch(session, explicit)) throw new Error("You do not have access to this branch.");
    return explicit;
  }
  const first = await prisma.branch.findFirst({
    where: { schoolId: session.schoolId ?? "" },
    orderBy: { createdAt: "asc" },
  });
  return first?.id || null;
}