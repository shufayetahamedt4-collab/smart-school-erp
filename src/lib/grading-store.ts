import { prisma } from "./db";
import { coerceScheme, type GradingScheme } from "./grading";

/**
 * Persistence for a school's grading scheme.
 *
 * Kept out of `grading.ts` on purpose: that module is imported by the editor
 * (a client component) and so must stay free of prisma/node imports. This one
 * is server-only.
 *
 * The scheme lives in the `settings` collection under one deterministic key per
 * school (`set_grading_scheme_<schoolId>`), which means it is read as a single
 * document through the shared read cache and is never visible through the
 * generic /api/settings endpoint.
 */

export const schemeKey = (schoolId: string): string => `grading_scheme_${schoolId}`;

export async function loadScheme(schoolId: string | null | undefined): Promise<GradingScheme> {
  if (!schoolId) return coerceScheme(null);
  const row = await prisma.setting.findUnique({ where: { key: schemeKey(schoolId) } }).catch(() => null);
  return coerceScheme((row as any)?.value ?? null);
}

export async function saveScheme(schoolId: string, scheme: GradingScheme): Promise<void> {
  const key = schemeKey(schoolId);
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: scheme as any },
    update: { value: scheme as any },
  });
}
