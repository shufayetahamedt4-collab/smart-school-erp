import { prisma } from "@/lib/db";
import { modeScopedKey, type Mode } from "@/lib/institution";
import { resolveActiveMode } from "@/lib/auth";

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
export async function getCurrentSessionId(schoolId: string, mode?: Mode | null): Promise<string | null> {
  const m = mode === undefined ? await resolveActiveMode(schoolId) : mode;
  const row = await prisma.setting.findUnique({ where: { key: currentSessionKey(schoolId, m) } }).catch(() => null);
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
export async function resolveSessionId(schoolId: string, explicit?: string | null, mode?: Mode | null): Promise<string | null> {
  const wanted = explicit ? String(explicit) : null;
  if (wanted) {
    const session = await prisma.academicSession.findUnique({ where: { id: wanted } }).catch(() => null);
    if (session && session.schoolId === schoolId) return session.id;
  }
  const m = mode === undefined ? await resolveActiveMode(schoolId) : mode;
  return getCurrentSessionId(schoolId, m);
}

/**
 * The session pointer's key is mode-scoped (docs/COLLEGE-DECISIONS.md §2, §4).
 * With the mode omitted it is today's exact key
 * (`school.<schoolId>.current_session`): the SCHOOL branch of `modeScopedKey`
 * returns the base untouched, so an existing tenant's saved pointer is read and
 * written under exactly the key it has always had. Only college mode uses the
 * suffixed key.
 */
export function currentSessionKey(schoolId: string, mode?: Mode | null): string {
  return modeScopedKey(`school.${schoolId}.current_session`, mode);
}
