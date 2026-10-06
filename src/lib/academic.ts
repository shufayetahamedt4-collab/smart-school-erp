import { prisma } from "@/lib/db";

/**
 * Academic session helpers (Phase 1 foundation).
 *
 * `academicSessions` and `student.sessionId` already existed in the schema but
 * were never used. These helpers activate them minimally:
 *
 *  - the school's current session is stored in the `settings` collection under
 *    `school.<schoolId>.current_session` (the same key convention as
 *    `school.<id>.branding`), and
 *  - `resolveSessionId()` turns an optional caller-supplied session into a valid
 *    one for the school — falling back to the current session, else null.
 *
 * Nothing here changes behaviour when no session exists: every creation path
 * gets `null`, exactly as before.
 */

/** The current session id for a school, or null. */
export async function getCurrentSessionId(schoolId: string): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key: currentSessionKey(schoolId) } }).catch(() => null);
  const stored = row?.value ? String(row.value) : null;
  if (stored) {
    const session = await prisma.academicSession.findUnique({ where: { id: stored } }).catch(() => null);
    if (session && session.schoolId === schoolId) return session.id;
  }
  // Fall back to whichever session is flagged current (covers a school that set
  // the flag before the pointer existed).
  const flagged = await prisma.academicSession.findFirst({ where: { schoolId, isCurrent: true } }).catch(() => null);
  return flagged?.id || null;
}

/**
 * Resolve the session a new/updated student should carry: the explicit id when it
 * is a real session of this school, otherwise the school's current session.
 */
export async function resolveSessionId(schoolId: string, explicit?: string | null): Promise<string | null> {
  const wanted = explicit ? String(explicit) : null;
  if (wanted) {
    const session = await prisma.academicSession.findUnique({ where: { id: wanted } }).catch(() => null);
    if (session && session.schoolId === schoolId) return session.id;
  }
  return getCurrentSessionId(schoolId);
}

export function currentSessionKey(schoolId: string): string {
  return `school.${schoolId}.current_session`;
}
