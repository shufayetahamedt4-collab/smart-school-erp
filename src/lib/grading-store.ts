import { prisma } from "./db";
import { coerceScheme, type GradingScheme } from "./grading";
import { modeScopedKey, type Mode } from "./institution";
import { resolveActiveMode } from "./auth";

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

/**
 * The scheme key is mode-scoped (docs/COLLEGE-DECISIONS.md §2, §4). With the
 * mode omitted it is today's exact key (`grading_scheme_<schoolId>`): the SCHOOL
 * branch of `modeScopedKey` returns the base untouched, so an existing tenant's
 * saved scheme is read and written under exactly the key it has always had.
 * Only a college-mode read/write uses the suffixed key.
 */
export const schemeKey = (schoolId: string, mode?: Mode | null): string =>
  modeScopedKey(`grading_scheme_${schoolId}`, mode);

export async function loadScheme(schoolId: string | null | undefined, mode?: Mode | null): Promise<GradingScheme> {
  if (!schoolId) return coerceScheme(null);
  const m = mode === undefined ? await resolveActiveMode(schoolId) : mode;
  const row = await prisma.setting.findUnique({ where: { key: schemeKey(schoolId, m) } }).catch(() => null);
  return coerceScheme((row as any)?.value ?? null);
}

export async function saveScheme(schoolId: string, scheme: GradingScheme, mode?: Mode | null): Promise<void> {
  const m = mode === undefined ? await resolveActiveMode(schoolId) : mode;
  const key = schemeKey(schoolId, m);
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: scheme as any },
    update: { value: scheme as any },
  });
}
