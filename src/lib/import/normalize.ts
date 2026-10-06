/**
 * Bulk student import — pure value normalizers.
 *
 * Everything here is deterministic and dependency-free so the same rules apply
 * wherever a value is read: the preview, the commit chunk, and any future
 * caller. Each normalizer returns either a normal value or a diagnostic string
 * describing why the cell is unusable, never throws.
 */

export type NormalizeResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** Trim a cell and treat whitespace-only / placeholder tokens as empty. */
export function cleanCell(value: unknown): string {
  const text = String(value ?? "").trim();
  if (!text || text === "-" || text.toUpperCase() === "N/A" || text.toUpperCase() === "NULL") return "";
  return text;
}

/** Identifier cells are compared case-insensitively and without inner padding. */
export function normalizeIdentifier(value: unknown): string {
  return cleanCell(value).replace(/\s+/g, " ");
}

/** Comparison key for identifiers (\u2192 lowercase, no spaces). */
export function identifierKey(value: unknown): string {
  return normalizeIdentifier(value).toLowerCase().replace(/\s+/g, "");
}

const GENDER_MAP: Record<string, "MALE" | "FEMALE" | "OTHER"> = {
  m: "MALE", male: "MALE", boy: "MALE", b: "MALE", "male ": "MALE",
  f: "FEMALE", female: "FEMALE", girl: "FEMALE", g: "FEMALE",
  o: "OTHER", other: "OTHER", others: "OTHER", unknown: "OTHER",
};

export function normalizeGender(value: unknown): NormalizeResult<"MALE" | "FEMALE" | "OTHER"> {
  const raw = cleanCell(value);
  if (!raw) return { ok: false, error: "" }; // empty = no value, caller decides
  const mapped = GENDER_MAP[raw.toLowerCase()];
  if (!mapped) return { ok: false, error: `Unrecognised gender "${raw}" (use Male, Female or Other).` };
  return { ok: true, value: mapped };
}

const BLOOD_MAP: Record<string, string> = {
  "a+": "A_POS", "a-": "A_NEG", "b+": "B_POS", "b-": "B_NEG",
  "ab+": "AB_POS", "ab-": "AB_NEG", "o+": "O_POS", "o-": "O_NEG",
  apos: "A_POS", aneg: "A_NEG", bpos: "B_POS", bneg: "B_NEG",
  abpos: "AB_POS", abneg: "AB_NEG", opos: "O_POS", oneg: "O_NEG",
  "a+ve": "A_POS", "a-ve": "A_NEG", "b+ve": "B_POS", "b-ve": "B_NEG",
  "ab+ve": "AB_POS", "ab-ve": "AB_NEG", "o+ve": "O_POS", "o-ve": "O_NEG",
};

export function normalizeBloodGroup(value: unknown): NormalizeResult<string> {
  const raw = cleanCell(value);
  if (!raw) return { ok: false, error: "" };
  const key = raw.toLowerCase().replace(/\s+/g, "");
  const mapped = BLOOD_MAP[key] || BLOOD_MAP[raw.toLowerCase()];
  if (!mapped) return { ok: false, error: `Unrecognised blood group "${raw}".` };
  return { ok: true, value: mapped };
}

/**
 * Parse a date of birth from the shapes spreadsheets actually contain:
 * ISO (YYYY-MM-DD), day/month-first (DD/MM/YYYY, DD-MM-YYYY) and anything
 * `Date.parse` understands. Ambiguous slash dates are read day-first, which is
 * the local convention.
 */
export function normalizeDob(value: unknown): NormalizeResult<Date> {
  const raw = cleanCell(value);
  if (!raw) return { ok: false, error: "" };

  let iso = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (iso) return buildDate(Number(iso[1]), Number(iso[2]), Number(iso[3]), raw);

  const dmy = raw.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) return buildDate(Number(dmy[3]), Number(dmy[2]), Number(dmy[1]), raw);

  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime()) && parsed.getFullYear() > 1900 && parsed.getFullYear() < 2100) {
    return { ok: true, value: parsed };
  }
  return { ok: false, error: `Unrecognised date of birth "${raw}" (use YYYY-MM-DD).` };
}

function buildDate(year: number, month: number, day: number, raw: string): NormalizeResult<Date> {
  const date = new Date(Date.UTC(year, month - 1, day));
  const valid = date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
  if (!valid) return { ok: false, error: `Invalid date of birth "${raw}".` };
  return { ok: true, value: date };
}

/** A roll number is stored numerically; blanks and non-numeric values are rejected. */
export function normalizeRoll(value: unknown): NormalizeResult<number> {
  const raw = cleanCell(value);
  if (!raw) return { ok: false, error: "" };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: `Roll "${raw}" must be a number.` };
  return { ok: true, value: n };
}

/** Loose email check — enough to reject a phone number typed into the email column. */
export function normalizeEmail(value: unknown): NormalizeResult<string> {
  const raw = cleanCell(value);
  if (!raw) return { ok: false, error: "" };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { ok: false, error: `Unrecognised email "${raw}".` };
  return { ok: true, value: raw.toLowerCase() };
}

export function normalizePhone(value: unknown): string {
  return cleanCell(value).replace(/[^\d+]/g, "");
}
