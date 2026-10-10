/**
 * Grading & GPA scheme — the school's own marking rules.
 *
 * Every grade a screen shows is derived from THIS module, so a school admin or
 * teacher can change its marking policy (bands, GPA points, pass mark, whether
 * a failure caps the GPA) without a code change, and every reader — marks
 * entry, the exam sheet, the report card — follows.
 *
 * Design notes:
 *  - A band's `gpa` is the grade point a subject earns; a report's GPA is the
 *    mean of those points (the plain average the app always used) unless
 *    `failCapsGpa` is on, in which case any failed subject zeroes it.
 *  - Bands are kept sorted by `minPercent` DESC, so "the first band whose
 *    minimum is ≤ this percentage" is the grade.
 *  - This file is deliberately dependency-free (no prisma, no node: imports)
 *    because the editor UI is a client component and imports it directly.
 */

export interface GradeBand {
  /** Shown on the report card and stored on each mark, e.g. "A+". */
  grade: string;
  /** Lowest percentage that earns this band (0–100). */
  minPercent: number;
  /**
   * Grade point a subject with this grade earns (0–gpaScale). **Optional** (a
   * Phase 6 addition): a scheme with `showGpa: false` prints letters and/or
   * percentages only, so its bands carry no point at all — the key is absent,
   * never a printed `0.00` (docs/COLLEGE-DECISIONS.md D-6-2, D-6-16). Every
   * existing scheme still sets it, so nothing changes for them.
   */
  gpa?: number;
  /** Optional note printed next to the band / used for teacher remarks. */
  remark?: string;
}

export interface GradingScheme {
  /** Human label for the policy, e.g. "Bangladesh National". */
  name: string;
  /** Highest possible GPA — 5.00 and 4.00 are the common scales. */
  gpaScale: number;
  /** Percentage a subject must reach to pass. */
  passPercent: number;
  /** When true, a single failed subject caps the overall GPA at 0. */
  failCapsGpa: boolean;
  /**
   * Whether a GPA/point is shown at all (D-6-2). **Absent means `true`** — that
   * absent-is-true rule is the whole backward-compatibility guarantee: every
   * stored scheme, every existing preset and every verified value keeps grading,
   * printing and validating exactly as before. Only an explicit `false` (letters
   * or percentages only) relaxes a band's `gpa` (D-6-5) and suppresses the GPA
   * columns (D-6-16).
   */
  showGpa?: boolean;
  /**
   * The tenant's retake rule, in the SAME document as the scheme (D-6-7).
   * Absent means today's behaviour: no retakes are recorded and there is nothing
   * to resolve. Phase 6 adds no second pass mark — a retake references the one
   * `passPercent` above (D-6-10).
   */
  retake?: RetakeConfig;
  bands: GradeBand[];
}

/** The scale the app shipped with (Bangladesh national, 5.00). */
export const DEFAULT_SCHEME: GradingScheme = {
  name: "Bangladesh National",
  gpaScale: 5,
  passPercent: 33,
  failCapsGpa: false,
  bands: [
    { grade: "A+", minPercent: 80, gpa: 5, remark: "Outstanding" },
    { grade: "A", minPercent: 70, gpa: 4, remark: "Excellent" },
    { grade: "A-", minPercent: 60, gpa: 3.5, remark: "Very good" },
    { grade: "B", minPercent: 50, gpa: 3, remark: "Good" },
    { grade: "C", minPercent: 40, gpa: 2, remark: "Satisfactory" },
    { grade: "D", minPercent: 33, gpa: 1, remark: "Needs improvement" },
    { grade: "F", minPercent: 0, gpa: 0, remark: "Failed" },
  ],
};

/** Ready-made policies a school can start from, then tweak. */
export const GRADING_PRESETS: { key: string; label: string; hint: string; scheme: GradingScheme }[] = [
  {
    key: "bd-5",
    label: "Bangladesh National (5.00)",
    hint: "A+ 80%, A 70%, A- 60%, B 50%, C 40%, D 33%, F below — pass at 33%.",
    scheme: DEFAULT_SCHEME,
  },
  {
    key: "gpa-4",
    label: "GPA 4.00 scale",
    hint: "A 90%, B 80%, C 70%, D 60%, F below — pass at 60%.",
    scheme: {
      name: "GPA 4.00",
      gpaScale: 4,
      passPercent: 60,
      failCapsGpa: false,
      bands: [
        { grade: "A", minPercent: 90, gpa: 4, remark: "Excellent" },
        { grade: "B", minPercent: 80, gpa: 3, remark: "Good" },
        { grade: "C", minPercent: 70, gpa: 2, remark: "Satisfactory" },
        { grade: "D", minPercent: 60, gpa: 1, remark: "Pass" },
        { grade: "F", minPercent: 0, gpa: 0, remark: "Failed" },
      ],
    },
  },
  {
    key: "letters-5",
    label: "Letters + 5.00 GPA (no minus)",
    hint: "A+ 80%, A 65%, B 50%, C 40%, D 33% — pass at 33%.",
    scheme: {
      name: "Letters only",
      gpaScale: 5,
      passPercent: 33,
      failCapsGpa: true,
      bands: [
        { grade: "A+", minPercent: 80, gpa: 5, remark: "Outstanding" },
        { grade: "A", minPercent: 65, gpa: 4, remark: "Excellent" },
        { grade: "B", minPercent: 50, gpa: 3, remark: "Good" },
        { grade: "C", minPercent: 40, gpa: 2, remark: "Satisfactory" },
        { grade: "D", minPercent: 33, gpa: 1, remark: "Pass" },
        { grade: "F", minPercent: 0, gpa: 0, remark: "Failed" },
      ],
    },
  },
  {
    key: "bd-university-4",
    label: "University CGPA (4.00)",
    hint: "A 80% → 4.00, B 65% → 3.25, C 50% → 2.00, D 40% → 1.00, F below — pass at 40%.",
    scheme: {
      name: "University 4.00",
      gpaScale: 4,
      passPercent: 40,
      failCapsGpa: false,
      bands: [
        { grade: "A+", minPercent: 80, gpa: 4, remark: "Outstanding" },
        { grade: "A", minPercent: 75, gpa: 3.75, remark: "Excellent" },
        { grade: "A-", minPercent: 70, gpa: 3.5, remark: "Very good" },
        { grade: "B+", minPercent: 65, gpa: 3.25, remark: "Good" },
        { grade: "B", minPercent: 60, gpa: 3, remark: "Good" },
        { grade: "B-", minPercent: 55, gpa: 2.75, remark: "Satisfactory" },
        { grade: "C", minPercent: 50, gpa: 2, remark: "Satisfactory" },
        { grade: "D", minPercent: 40, gpa: 1, remark: "Pass" },
        { grade: "F", minPercent: 0, gpa: 0, remark: "Failed" },
      ],
    },
  },
  {
    key: "eng-medium-letters",
    label: "English-medium letters (no GPA)",
    hint: "A* 90%, A 80%, B 70%, C 60%, D 50%, E 40% — pass at 40%. Letters only, no grade point.",
    scheme: {
      name: "Level letters",
      gpaScale: 5,
      passPercent: 40,
      failCapsGpa: false,
      showGpa: false,
      bands: [
        { grade: "A*", minPercent: 90, remark: "Top level" },
        { grade: "A", minPercent: 80, remark: "Excellent" },
        { grade: "B", minPercent: 70, remark: "Good" },
        { grade: "C", minPercent: 60, remark: "Satisfactory" },
        { grade: "D", minPercent: 50, remark: "Pass" },
        { grade: "E", minPercent: 40, remark: "Pass" },
        { grade: "F", minPercent: 0, remark: "Failed" },
      ],
    },
  },
  {
    key: "percent-only",
    label: "Percent only (no GPA, no letters)",
    hint: "Marks print as a percentage; pass at 40%. No grade points at all.",
    scheme: {
      name: "Percent only",
      gpaScale: 5,
      passPercent: 40,
      failCapsGpa: false,
      showGpa: false,
      bands: [
        { grade: "P", minPercent: 40, remark: "Pass" },
        { grade: "F", minPercent: 0, remark: "Failed" },
      ],
    },
  },
];

/* ------------------------------------------------ retake policy (D-6-7…D-6-10) */

/**
 * The four ways a tenant may treat a retaken course (D-6-8). The chosen policy
 * never changes the STORED attempts — it decides only which value grades the
 * course and what the transcript prints (a derived-on-read decision, D-6-12).
 *
 *   - `REPLACE` — the latest attempt is the course grade;
 *   - `BEST`    — the highest attempt is the course grade;
 *   - `BOTH`    — every attempt is reported, the LATEST is the effective one;
 *   - `AVERAGE` — the mean of the attempts is the course grade.
 */
export const RETAKE_POLICIES = ["REPLACE", "BEST", "BOTH", "AVERAGE"] as const;

export type RetakePolicy = (typeof RETAKE_POLICIES)[number];

/** A tenant's retake rule, stored beside the scheme (D-6-7). */
export interface RetakeConfig {
  policy: RetakePolicy;
  /** Attempts allowed BEYOND the first, or `null` for unlimited (D-6-9). */
  maxRetakes: number | null;
}

/**
 * What a scheme with no `retake` block means: today's behaviour — no retakes
 * recorded (`maxRetakes` 0), and a single attempt, so the policy value is moot.
 */
export const DEFAULT_RETAKE: RetakeConfig = { policy: "REPLACE", maxRetakes: 0 };

/** Is this exactly one of the four stored policies? */
export function isRetakePolicy(value: unknown): value is RetakePolicy {
  return typeof value === "string" && (RETAKE_POLICIES as readonly string[]).includes(value);
}

/**
 * Validate a `retake` block coming from the client or from storage. `maxRetakes`
 * is an integer in [0, 1000] or empty/null for unlimited (D-6-9); the limit is
 * enforced when a retake is RECORDED (the API), never by deleting an attempt.
 */
export function validateRetakeConfig(
  input: any
): { ok: true; config: RetakeConfig } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Retake policy must be an object." };
  const policy = input.policy;
  if (!isRetakePolicy(policy)) return { ok: false, error: `Retake policy must be one of ${RETAKE_POLICIES.join(", ")}.` };
  const raw = input.maxRetakes;
  if (raw === undefined || raw === null || raw === "") return { ok: true, config: { policy, maxRetakes: null } };
  const n = num(raw, 0, 1000);
  if (n === null || !Number.isInteger(n)) {
    return { ok: false, error: "Max retakes must be a whole number from 0 to 1000, or empty for unlimited." };
  }
  return { ok: true, config: { policy, maxRetakes: n } };
}

/**
 * Read a stored/optional `retake` block leniently: anything unusable falls back
 * to `DEFAULT_RETAKE` (no retakes), the same fail-safe convention `coerceScheme`
 * uses for a broken scheme. Never throws.
 */
export function normalizeRetakeConfig(value: unknown): RetakeConfig {
  const result = validateRetakeConfig(value);
  return result.ok ? result.config : DEFAULT_RETAKE;
}

/** Does this scheme show a GPA/point at all? Absent means yes (D-6-2). */
export function showsGpa(scheme: GradingScheme | null | undefined): boolean {
  return scheme?.showGpa !== false;
}

/** One column of an exam's marks sheet: a subject and what it is marked out of. */
export interface ExamColumn {
  subjectId: string;
  fullMarks: number;
}

const MIN_BANDS = 2;
const MAX_BANDS = 20;
const MAX_COLUMNS = 40;
const MAX_FULL_MARKS = 1000;

/** A finite number inside [min, max], or null when the input is unusable. */
function num(value: unknown, min: number, max: number): number | null {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  if (n < min || n > max) return null;
  return n;
}

/** Keep the top two decimals — the same rounding the report card prints. */
export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Validate + normalise a scheme coming from the client or from storage.
 * Rejects anything that would leave a percentage ungraded or a GPA above the
 * declared scale, because both would print nonsense on a report card.
 */
export function validateScheme(input: any): { ok: true; scheme: GradingScheme } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Grading scheme must be an object." };

  const gpaScale = num(input.gpaScale, 0.1, 10);
  if (gpaScale === null) return { ok: false, error: "GPA scale must be between 0.1 and 10 (e.g. 5 or 4)." };

  const passPercent = num(input.passPercent, 0, 100);
  if (passPercent === null) return { ok: false, error: "Pass mark must be a percentage between 0 and 100." };

  // Absent means shown (D-6-2) — only an explicit `false` relaxes a band's gpa.
  const showGpa = input.showGpa !== false;

  const rawBands = Array.isArray(input.bands) ? input.bands : [];
  if (rawBands.length < MIN_BANDS) return { ok: false, error: `Add at least ${MIN_BANDS} grade bands.` };
  if (rawBands.length > MAX_BANDS) return { ok: false, error: `At most ${MAX_BANDS} grade bands.` };

  const seen = new Set<number>();
  const bands: GradeBand[] = [];
  for (const raw of rawBands) {
    const grade = String(raw?.grade ?? "").trim();
    if (!grade) return { ok: false, error: "Every band needs a grade label (e.g. A+)." };
    if (grade.length > 6) return { ok: false, error: `Grade "${grade}" is too long — use at most 6 characters.` };

    const minPercent = num(raw?.minPercent, 0, 100);
    if (minPercent === null) return { ok: false, error: `Band "${grade}" needs a minimum percentage between 0 and 100.` };
    if (seen.has(minPercent)) return { ok: false, error: `Two bands start at ${minPercent}% — minimums must be unique.` };
    seen.add(minPercent);

    // With `showGpa: false` a band may omit its point (D-6-5). When the scheme
    // DOES show a GPA — or a no-GPA scheme still supplies a point — the value is
    // validated against the scale exactly as before, so a scheme can never carry
    // a point the printed transcript would show wrongly. No existing refusal is
    // removed or reworded; the no-GPA relaxation is additive only.
    const hasGpa = raw?.gpa !== undefined && raw?.gpa !== null && raw?.gpa !== "";
    const gpa = showGpa || hasGpa ? num(raw?.gpa, 0, gpaScale) : null;
    if (gpa === null && (showGpa || hasGpa)) {
      return { ok: false, error: `Band "${grade}" needs a GPA between 0 and ${gpaScale}.` };
    }

    const remark = String(raw?.remark ?? "").trim().slice(0, 120);
    // Only carry a key when it has a value — Firestore rejects `undefined`, and
    // an absent key already means "none" everywhere that reads it.
    const band: GradeBand = { grade, minPercent };
    if (gpa !== null) band.gpa = gpa;
    if (remark) band.remark = remark;
    bands.push(band);
  }

  if (!bands.some((b) => b.minPercent === 0)) {
    return { ok: false, error: "One band must start at 0% — otherwise the lowest marks would have no grade." };
  }

  bands.sort((a, b) => b.minPercent - a.minPercent);

  const name = String(input.name ?? "").trim().slice(0, 80) || DEFAULT_SCHEME.name;
  const scheme: GradingScheme = { name, gpaScale, passPercent, failCapsGpa: !!input.failCapsGpa, bands };
  // Absent means shown, so only an explicit `false` is ever stored (D-6-2).
  if (!showGpa) scheme.showGpa = false;
  // The retake block rides in the same document (D-6-7); an absent block means
  // "no retakes recorded", which is what every existing scheme already means.
  if (input.retake !== undefined && input.retake !== null) {
    const retake = validateRetakeConfig(input.retake);
    if (!retake.ok) return { ok: false, error: retake.error };
    scheme.retake = retake.config;
  }
  return { ok: true, scheme };
}

/**
 * Read a stored scheme leniently: anything unusable falls back to the shipped
 * default rather than printing a broken report card for the school.
 */
export function coerceScheme(stored: any): GradingScheme {
  const parsed = typeof stored === "string" ? safeParse(stored) : stored;
  const result = validateScheme(parsed);
  return result.ok ? result.scheme : DEFAULT_SCHEME;
}

function safeParse(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The band a percentage falls into (bands are sorted high → low). */
export function bandForPercent(scheme: GradingScheme, percent: number): GradeBand {
  return scheme.bands.find((b) => percent >= b.minPercent) || scheme.bands[scheme.bands.length - 1];
}

export interface SubjectResult {
  grade: string;
  gpa: number;
  remark: string;
  percent: number;
  pass: boolean;
}

/** Grade one subject's marks under the school's scheme. */
export function gradeForScheme(scheme: GradingScheme, obtained: number, full: number): SubjectResult {
  const percent = full > 0 ? (obtained / full) * 100 : 0;
  const band = bandForPercent(scheme, percent);
  return {
    grade: band.grade,
    // A no-GPA band omits its point; the school SubjectResult still carries a
    // number so every existing caller is unchanged (only a no-GPA scheme, which
    // is new, ever reaches the `?? 0`).
    gpa: band.gpa ?? 0,
    remark: band.remark || "",
    percent: Math.round(percent * 100) / 100,
    pass: percent >= scheme.passPercent,
  };
}

/**
 * Overall GPA from subject grade points — the plain mean, capped by the scale.
 * With `failCapsGpa` on, one failed subject zeroes it (the usual rule on
 * 5.00/4.00 national scales).
 */
export function gpaOfScheme(scheme: GradingScheme, points: number[]): number {
  if (!points.length) return 0;
  if (scheme.failCapsGpa && points.some((p) => Number(p) <= 0)) return 0;
  const mean = points.reduce((a, b) => a + Number(b), 0) / points.length;
  return Math.min(scheme.gpaScale, round2(mean));
}

/** The explicit columns an exam declares, or every subject at `fullMarks`. */
export function resolveExamColumns(
  examColumns: any,
  subjects: { id: string; name: string }[],
  defaultFullMarks = 100
): { id: string; name: string; fullMarks: number }[] {
  const declared = Array.isArray(examColumns) ? examColumns : [];
  if (!declared.length) return subjects.map((s) => ({ id: s.id, name: s.name, fullMarks: defaultFullMarks }));

  const byId = new Map(subjects.map((s) => [s.id, s]));
  const resolved = declared
    .map((c: any) => {
      const id = String(c?.subjectId ?? "");
      const subject = byId.get(id);
      if (!subject) return null;
      const fullMarks = num(c?.fullMarks, 0.5, MAX_FULL_MARKS) ?? defaultFullMarks;
      return { id, name: subject.name, fullMarks };
    })
    .filter(Boolean) as { id: string; name: string; fullMarks: number }[];

  // Every declared subject has since been deleted from the school's catalogue.
  // Falling back to the full list keeps the sheet usable (and re-savable) rather
  // than leaving the exam with no columns at all.
  return resolved.length ? resolved : subjects.map((s) => ({ id: s.id, name: s.name, fullMarks: defaultFullMarks }));
}

/**
 * Validate a marks-sheet column list. Returns the de-duplicated columns, or the
 * reason the sheet cannot be saved as asked.
 */
export function validateColumns(
  input: any,
  subjects: { id: string; name: string }[]
): { ok: true; columns: ExamColumn[] } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: "Columns must be a list." };
  if (!input.length) return { ok: false, error: "An exam needs at least one subject column." };
  if (input.length > MAX_COLUMNS) return { ok: false, error: `At most ${MAX_COLUMNS} subject columns.` };

  const known = new Set(subjects.map((s) => s.id));
  const seen = new Set<string>();
  const columns: ExamColumn[] = [];
  for (const raw of input) {
    const subjectId = String(raw?.subjectId ?? "");
    if (!known.has(subjectId)) return { ok: false, error: "One of the columns is not a subject of this school." };
    if (seen.has(subjectId)) return { ok: false, error: "The same subject is listed twice — remove the duplicate." };
    seen.add(subjectId);
    const fullMarks = num(raw?.fullMarks, 0.5, MAX_FULL_MARKS);
    if (fullMarks === null) return { ok: false, error: `Full marks must be between 0.5 and ${MAX_FULL_MARKS}.` };
    columns.push({ subjectId, fullMarks });
  }
  return { ok: true, columns };
}

/** "≥ 70%" — an honest label for a band whose upper edge is the next band. */
export function bandLabel(band: GradeBand): string {
  const trimmed = Number.isInteger(band.minPercent) ? band.minPercent : round2(band.minPercent);
  return `≥ ${trimmed}%`;
}
