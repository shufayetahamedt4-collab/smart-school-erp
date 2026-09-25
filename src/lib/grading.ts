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
  /** Grade point a subject with this grade earns (0–gpaScale). */
  gpa: number;
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
];

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

    const gpa = num(raw?.gpa, 0, gpaScale);
    if (gpa === null) return { ok: false, error: `Band "${grade}" needs a GPA between 0 and ${gpaScale}.` };

    const remark = String(raw?.remark ?? "").trim().slice(0, 120);
    // Only carry the key when it has a value — Firestore rejects `undefined`,
    // and an absent remark already means "no remark" everywhere that reads it.
    const band: GradeBand = { grade, minPercent, gpa };
    if (remark) band.remark = remark;
    bands.push(band);
  }

  if (!bands.some((b) => b.minPercent === 0)) {
    return { ok: false, error: "One band must start at 0% — otherwise the lowest marks would have no grade." };
  }

  bands.sort((a, b) => b.minPercent - a.minPercent);

  const name = String(input.name ?? "").trim().slice(0, 80) || DEFAULT_SCHEME.name;
  return { ok: true, scheme: { name, gpaScale, passPercent, failCapsGpa: !!input.failCapsGpa, bands } };
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
    gpa: band.gpa,
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
