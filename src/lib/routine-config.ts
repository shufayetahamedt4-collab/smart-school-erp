import { prisma } from "./db";

/**
 * A school's timetable shape — how many periods a day, when each one runs, and
 * which weekdays the school works.
 *
 * Kept out of the routine editor on purpose: the editor is a client component
 * and must stay free of prisma/node imports, so the types live here and the
 * page imports them by type only.
 *
 * This lives in the `settings` collection under one deterministic key per school
 * (`routine_config_<schoolId>`), exactly like the grading scheme: a single
 * document through the shared read cache, and never visible through the generic
 * /api/settings endpoint.
 */

export interface RoutinePeriod {
  /** 1-based, always contiguous when read back through coerceRoutineConfig. */
  period: number;
  start: string | null;
  end: string | null;
}

export interface RoutineConfig {
  /** Weekdays the school runs, 0 = Sunday … 6 = Saturday. */
  days: number[];
  periods: RoutinePeriod[];
}

export const routineConfigKey = (schoolId: string): string => `routine_config_${schoolId}`;

export const MIN_PERIODS = 1;
export const MAX_PERIODS = 12;

/**
 * What a school starts with: Sunday–Thursday, eight periods. The times are the
 * ones this project's demo timetable already uses, so adopting the setting does
 * not silently move anyone's bells.
 */
export const DEFAULT_ROUTINE_CONFIG: RoutineConfig = {
  days: [0, 1, 2, 3, 4],
  periods: [
    { period: 1, start: "08:30", end: "09:10" },
    { period: 2, start: "09:15", end: "09:55" },
    { period: 3, start: "10:15", end: "10:55" },
    { period: 4, start: "11:00", end: "11:40" },
    { period: 5, start: "11:45", end: "12:30" },
    { period: 6, start: "13:30", end: "14:10" },
    { period: 7, start: "14:15", end: "15:00" },
    { period: 8, start: "15:00", end: "15:40" },
  ],
};

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A clock time, or null. Accepts "" as "not set". */
export function normalizeTime(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return TIME_RE.test(text) ? text : null;
}

export function isTime(value: unknown): boolean {
  return value === null || value === undefined || value === "" || TIME_RE.test(String(value).trim());
}

/** Be forgiving on read: anything unusable falls back to the shipped default. */
export function coerceRoutineConfig(value: unknown): RoutineConfig {
  const raw: any = value;
  if (!raw || typeof raw !== "object") return DEFAULT_ROUTINE_CONFIG;

  const rawDays: number[] = Array.isArray(raw.days) ? raw.days.map((d: any) => Number(d)) : [];
  const days: number[] = [...new Set(rawDays.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort((a, b) => a - b);
  const periods = Array.isArray(raw.periods)
    ? raw.periods
        .filter((p: any) => p && Number.isFinite(Number(p.period)))
        .map((p: any) => ({ period: Number(p.period), start: normalizeTime(p.start), end: normalizeTime(p.end) }))
        .sort((a: any, b: any) => a.period - b.period)
        .slice(0, MAX_PERIODS)
        .map((p: any, i: number) => ({ ...p, period: i + 1 }))
    : [];

  if (!days.length || periods.length < MIN_PERIODS) return DEFAULT_ROUTINE_CONFIG;
  // Times are ordered if set; a period whose end is before its start is nonsense.
  const clean = periods.map((p: any) => (p.start && p.end && p.end < p.start ? { ...p, end: null } : p));
  return { days, periods: clean };
}

export type ConfigCheck = { ok: true; config: RoutineConfig } | { ok: false; error: string };

/** Strict validation for writes — refuse to store something we would not read back. */
export function validateRoutineConfig(value: unknown): ConfigCheck {
  const raw: any = value;
  if (!raw || typeof raw !== "object") return { ok: false, error: "A configuration object is required." };

  if (!Array.isArray(raw.days) || raw.days.length === 0) {
    return { ok: false, error: "Pick at least one working day." };
  }
  const days: number[] = [...new Set((raw.days as any[]).map((d: any) => Number(d)))];
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
    return { ok: false, error: "Working days must be Sunday…Saturday." };
  }

  if (!Array.isArray(raw.periods) || raw.periods.length < MIN_PERIODS || raw.periods.length > MAX_PERIODS) {
    return { ok: false, error: `A day must have between ${MIN_PERIODS} and ${MAX_PERIODS} periods.` };
  }
  const periods: RoutinePeriod[] = [];
  for (const [i, p] of raw.periods.entries()) {
    if (!p || typeof p !== "object") return { ok: false, error: `Period ${i + 1} is not a valid period.` };
    if (!isTime(p.start) || !isTime(p.end)) {
      return { ok: false, error: `Period ${i + 1} has an invalid time — use HH:MM.` };
    }
    const start = normalizeTime(p.start);
    const end = normalizeTime(p.end);
    if (start && end && end <= start) {
      return { ok: false, error: `Period ${i + 1}: the end time must be after the start time.` };
    }
    periods.push({ period: i + 1, start, end });
  }

  return { ok: true, config: { days: days.sort((a, b) => a - b), periods } };
}

export async function loadRoutineConfig(schoolId: string | null | undefined): Promise<RoutineConfig> {
  if (!schoolId) return DEFAULT_ROUTINE_CONFIG;
  const row = await prisma.setting.findUnique({ where: { key: routineConfigKey(schoolId) } }).catch(() => null);
  return coerceRoutineConfig((row as any)?.value ?? null);
}

export async function saveRoutineConfig(schoolId: string, config: RoutineConfig): Promise<void> {
  const key = routineConfigKey(schoolId);
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: config as any },
    update: { value: config as any },
  });
}
