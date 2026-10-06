import { prisma } from "@/lib/db";

/**
 * Family / sibling helpers, shared by the walk-in intake
 * (`/api/admissions/intake`), the enquiry pipeline's enrollment
 * (`lib/admission.ts`) and the shared enrollment kernel (`lib/enroll.ts`).
 *
 * These two functions were moved here verbatim from `lib/admission.ts` — same
 * bodies, same behaviour. They live in their own module so `lib/enroll.ts` can
 * use them without importing `lib/admission.ts` (which imports `lib/enroll.ts`),
 * which would be a circular import. `lib/admission.ts` re-exports both, so every
 * existing `import { … } from "@/lib/admission"` keeps working unchanged.
 */

/** The nearest already-enrolled child to link a new student to, or null. */
export async function findExistingSibling(
  schoolId: string,
  studentId: string,
  guardianUserId: string | null,
  guardianPhone?: string | null
) {
  // The guardian ACCOUNT is the strongest signal (a family that already signed
  // in shares it); the phone number is the fallback the enquiry form implies.
  const byUser = guardianUserId
    ? await prisma.student.findFirst({ where: { schoolId, id: { not: studentId }, guardianUserId } })
    : null;
  if (byUser) return byUser;
  if (!guardianPhone) return null;
  return prisma.student.findFirst({ where: { schoolId, id: { not: studentId }, guardianPhone } });
}

/**
 * Put a new student in the same family as a sibling (§5.4).
 *
 * The sibling's family id wins when it has one; otherwise a new one is minted and
 * stamped on BOTH children, which is what makes the guardian portal list them
 * together (see /api/parent/siblings). The family also shares one login: whichever
 * of the two already has a guardian account keeps it for both.
 */
export async function linkSiblingFamily(opts: {
  schoolId: string;
  studentId: string;
  siblingId: string;
  guardianUserId?: string | null;
}): Promise<{ familyId: string; siblingName: string; guardianUserId: string | null }> {
  const sibling = await prisma.student.findUnique({ where: { id: opts.siblingId } });
  if (!sibling || sibling.schoolId !== opts.schoolId) throw new Error("Sibling not found in this school.");
  if (sibling.id === opts.studentId) throw new Error("A student cannot be their own sibling.");

  const familyId = sibling.familyId || `fam_${opts.studentId.slice(0, 10)}`;
  if (!sibling.familyId) await prisma.student.update({ where: { id: sibling.id }, data: { familyId } });
  await prisma.student.update({ where: { id: opts.studentId }, data: { familyId } });

  const familyGuardian = sibling.guardianUserId || opts.guardianUserId || null;
  if (familyGuardian && !sibling.guardianUserId) {
    await prisma.student.update({ where: { id: sibling.id }, data: { guardianUserId: familyGuardian } });
  }
  if (familyGuardian && !opts.guardianUserId) {
    await prisma.student.update({ where: { id: opts.studentId }, data: { guardianUserId: familyGuardian } });
  }
  return { familyId, siblingName: sibling.name, guardianUserId: familyGuardian };
}
