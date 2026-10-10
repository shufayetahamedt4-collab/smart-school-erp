/**
 * The default seed for a new tenant — one definition per tenant shape.
 *
 * A tenant runs a **school**, a **college**, or **both** (`institutionType`; see
 * `./institution`). Until now the onboarding wizard seeded one shape only: the
 * school one. This module is the single place that says what a brand-new tenant
 * of each shape starts with, so the wizard can offer and apply the right
 * defaults for a college instead of silently treating every tenant as a school
 * (docs/INTEGRATION-LOG.md — "Is the wizard institution-type aware today? No").
 *
 * Two halves, selected by the tenant's own type:
 *   - **school half** (`SCHOOL`, `BOTH`) — classes with sections, and the starter
 *     subject list. Identical to what the wizard has always offered.
 *   - **college half** (`COLLEGE`, `BOTH`) — one starter department, one starter
 *     programme (degree level, duration, term system) and its course catalogue,
 *     mapped to the programme's first term.
 *
 * It is intentionally **dependency-free at runtime** (no value imports at all —
 * no prisma, no `node:`, and the `./institution` import is type-only and erased),
 * the same design as `./institution` and `./sectors`, so
 *   - the wizard page (a client component) can import it,
 *   - the API route can import it, and
 *   - `scripts/verify-onboarding-seed.mjs` can prove the whole decision table
 *     offline, with no database and no server.
 *
 * The enum-valued fields mirror the college APIs on purpose. They are asserted
 * against `src/app/api/programs/route.ts` and `src/app/api/courses/route.ts` by
 * that verifier, so a seed can never create a row the college APIs would reject.
 *
 * Phase 7 (college fee basis) is **not** started, so this module deliberately
 * says nothing about college fees: `feeSetting` stays the school-shaped default
 * it has always been (docs/COLLEGE-PLAN-DELTA.md §2 — "feeSetting … Do not
 * extend it at all").
 */

import type { InstitutionType } from "./institution";

/**
 * The three tenant shapes and which halves each one has — the same table as
 * `./institution`'s `hasSchool`/`hasCollege`, restated here so this module has
 * **no runtime import at all** (the import above is type-only and is erased).
 *
 * That is not a stylistic choice: Node's type stripping resolves import
 * specifiers literally, so a module that imports `./institution` cannot be loaded
 * by `scripts/verify-onboarding-seed.mjs` at all. A proven-equivalent local table
 * keeps the offline verifier possible, and that verifier asserts these answers
 * against the real `./institution` functions for every value in a probing set
 * (including `constructor`, `__proto__`, `toString`, numbers, null and objects),
 * so the two cannot drift apart silently.
 */
const TENANT_SHAPES: Readonly<Record<InstitutionType, { school: boolean; college: boolean }>> = {
  SCHOOL: { school: true, college: false },
  COLLEGE: { school: false, college: true },
  BOTH: { school: true, college: true },
};

const TENANT_SHAPE_KEYS: ReadonlySet<string> = new Set(Object.keys(TENANT_SHAPES));

/** The storable tenant shape, or SCHOOL — never throws, never returns junk. */
export function normalizeTenantType(value: unknown): InstitutionType {
  return typeof value === "string" && TENANT_SHAPE_KEYS.has(value)
    ? (value as InstitutionType)
    : "SCHOOL";
}

/** Does this tenant run a school? (Equivalent to `hasSchool(normalize…)`.) */
export function tenantHasSchool(value: unknown): boolean {
  return TENANT_SHAPES[normalizeTenantType(value)].school;
}

/** Does this tenant run a college? (Equivalent to `hasCollege(normalize…)`.) */
export function tenantHasCollege(value: unknown): boolean {
  return TENANT_SHAPES[normalizeTenantType(value)].college;
}

/* ------------------------------------------------------------------ school */

export interface SeedClass {
  name: string;
  sections: string[];
}

/** The class ladder the wizard has always offered as quick-adds. */
export const SCHOOL_DEFAULT_CLASSES: readonly SeedClass[] = [
  { name: "Play", sections: ["A", "B"] },
  { name: "Nursery", sections: ["A", "B"] },
  { name: "KG", sections: ["A", "B"] },
  { name: "Class 1", sections: ["A", "B"] },
  { name: "Class 2", sections: ["A", "B"] },
  { name: "Class 3", sections: ["A", "B"] },
  { name: "Class 4", sections: ["A", "B"] },
  { name: "Class 5", sections: ["A", "B"] },
  { name: "Class 6", sections: ["A", "B"] },
  { name: "Class 7", sections: ["A", "B"] },
  { name: "Class 8", sections: ["A", "B"] },
  { name: "Class 9", sections: ["A", "B"] },
  { name: "Class 10", sections: ["A", "B"] },
];

/** The starter subjects the wizard has always offered. */
export const SCHOOL_DEFAULT_SUBJECTS: readonly string[] = [
  "Bangla",
  "English",
  "Mathematics",
  "Science",
  "Social Science",
  "Religion",
  "ICT",
  "Arts",
  "Physical Education",
];

/* ----------------------------------------------------------------- college */

/** Degree levels — mirrors `DEGREE_LEVELS` in `src/app/api/programs/route.ts`. */
export const DEGREE_LEVELS = ["HSC", "DEGREE_PASS", "HONOURS", "MASTERS", "DIPLOMA"] as const;
export type DegreeLevel = (typeof DEGREE_LEVELS)[number];

/** Course types — mirrors `COURSE_TYPES` in `src/app/api/courses/route.ts`. */
export const COURSE_TYPES = ["THEORY", "PRACTICAL"] as const;
export type CourseType = (typeof COURSE_TYPES)[number];

/** Credit-hour ceiling — mirrors `MAX_CREDIT_HOURS` in the courses route. */
export const MAX_CREDIT_HOURS = 30;

/** Term systems — mirrors `TERM_SYSTEMS` in `src/lib/college-terms.ts`. */
export const TERM_SYSTEMS = ["YEARLY", "SEMESTER"] as const;
export type SeedTermSystem = (typeof TERM_SYSTEMS)[number];

/** The term system a new programme starts on (mirrors `DEFAULT_TERM_SYSTEM`). */
export const DEFAULT_TERM_SYSTEM: SeedTermSystem = "YEARLY";

export interface SeedCourse {
  code: string;
  title: string;
  /** `null` means "no credits recorded" — the same meaning as the API's null. */
  creditHours: number | null;
  type: CourseType;
}

export interface SeedCollege {
  department: { name: string; code: string };
  program: {
    name: string;
    code: string;
    degreeLevel: DegreeLevel;
    durationYears: number;
    termSystem: SeedTermSystem;
  };
  courses: SeedCourse[];
  /** The programme term the seeded courses are mapped into (1-based). */
  mapCoursesToTerm: number;
}

/**
 * The starter college: one department, one HSC programme (2 years, yearly terms,
 * so `termCount` is 2) and a seven-course catalogue mapped into term 1.
 */
export const COLLEGE_DEFAULT_SKELETON: Readonly<SeedCollege> = {
  department: { name: "Science", code: "SCI" },
  program: {
    name: "HSC Science",
    code: "HSC-SCI",
    degreeLevel: "HSC",
    durationYears: 2,
    termSystem: DEFAULT_TERM_SYSTEM,
  },
  courses: [
    { code: "BAN-101", title: "Bangla", creditHours: 3, type: "THEORY" },
    { code: "ENG-101", title: "English", creditHours: 3, type: "THEORY" },
    { code: "PHY-101", title: "Physics", creditHours: 3, type: "THEORY" },
    { code: "CHE-101", title: "Chemistry", creditHours: 3, type: "THEORY" },
    { code: "BIO-101", title: "Biology", creditHours: 3, type: "THEORY" },
    { code: "MAT-101", title: "Mathematics", creditHours: 3, type: "THEORY" },
    { code: "ICT-101", title: "ICT", creditHours: 2, type: "PRACTICAL" },
  ],
  mapCoursesToTerm: 1,
};

/* -------------------------------------------------------------- the seed */ 

export interface TenantSeed {
  /** Empty for a college-only tenant. */
  classes: SeedClass[];
  subjects: string[];
  /** `null` for a school-only tenant. */
  college: SeedCollege | null;
}

/** Terms per year for a term system (YEARLY → 1, SEMESTER → 2). */
export function termsPerYear(system: unknown): number {
  return system === "SEMESTER" ? 2 : 1;
}

/** How many terms a programme of this length has; never below 1. */
export function seedTermCount(durationYears: number, system: unknown): number {
  const years = Number.isInteger(durationYears) && durationYears >= 1 ? durationYears : 1;
  return Math.max(1, years * termsPerYear(system));
}

/**
 * The defaults a tenant of this shape starts with.
 *
 * An absent, empty or unrecognised value reads as SCHOOL (there is no backfill
 * and no migration — `./institution`), so this never throws and a raw tenant
 * document behaves exactly as before. Every returned array/object is a fresh
 * copy, so a caller can edit the seed (the wizard does) without touching the
 * module constants.
 */
export function defaultSeedFor(value: unknown): TenantSeed {
  const type: InstitutionType = normalizeTenantType(value);
  return {
    classes: TENANT_SHAPES[type].school
      ? SCHOOL_DEFAULT_CLASSES.map((c) => ({ name: c.name, sections: [...c.sections] }))
      : [],
    subjects: TENANT_SHAPES[type].school ? [...SCHOOL_DEFAULT_SUBJECTS] : [],
    college: TENANT_SHAPES[type].college ? cloneCollege(COLLEGE_DEFAULT_SKELETON) : null,
  };
}

/**
 * Resolve the college half of a wizard payload, for the caller's tenant shape.
 *
 * This is the whole rule in one place:
 *   - a tenant that does not run a college keeps **no** college rows, however the
 *     request is shaped (`spec: null`);
 *   - a **new** tenant that omits the block entirely gets the default skeleton —
 *     the constants themselves, codes included ("the default seed for new
 *     tenants");
 *   - a request that sends the block gets the fields it NAMES, defaulted for the
 *     rest (a rename also derives a missing code from the new name);
 *   - an **existing** tenant that omits the block adds no college rows.
 *
 * Kept pure so the route can validate BEFORE it writes anything, and so the
 * whole decision table is provable offline by `scripts/verify-onboarding-seed.mjs`.
 */
export type ResolvedCollegeSeed =
  | { ok: true; spec: SeedCollege | null }
  | { ok: false; error: string };

export function resolveCollegeSeed(
  input: unknown,
  institutionType: unknown,
  isNew: boolean
): ResolvedCollegeSeed {
  if (!tenantHasCollege(institutionType)) return { ok: true, spec: null };
  if (input === undefined && !isNew) return { ok: true, spec: null };
  return normalizeCollegeSeed(input);
}

/** A deep copy of a college skeleton. */
export function cloneCollege(spec: Readonly<SeedCollege>): SeedCollege {
  return {
    department: { ...spec.department },
    program: { ...spec.program },
    courses: spec.courses.map((c) => ({ ...c })),
    mapCoursesToTerm: spec.mapCoursesToTerm,
  };
}

/* --------------------------------------------------------- college input */

export interface CollegeSeedInput {
  department?: { name?: unknown; code?: unknown };
  program?: {
    name?: unknown;
    code?: unknown;
    degreeLevel?: unknown;
    durationYears?: unknown;
    termSystem?: unknown;
  };
  courses?: { code?: unknown; title?: unknown; creditHours?: unknown; type?: unknown }[];
  mapCoursesToTerm?: unknown;
}

export type CollegeSeedResult = { ok: true; spec: SeedCollege } | { ok: false; error: string };

/**
 * A short, stable code derived from a name — the fallback when a caller supplies
 * a name but no code. `HSC Science` → `HSC-SCIENCE` truncated to the first
 * alphanumeric run, so it is always non-empty for a non-empty name.
 */
export function seedCodeFor(name: string, max = 12): string {
  const cleaned = String(name || "")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned.slice(0, max);
}

function readText(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function readCreditHours(v: unknown): number | null | "INVALID" {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > MAX_CREDIT_HOURS) return "INVALID";
  return n;
}

/**
 * Turn a caller-supplied college seed into a validated spec, starting from the
 * default skeleton. Explicitly invalid enum/number values are an error rather
 * than silently dropped, so the wizard can surface them; a missing value falls
 * back to the default.
 *
 * The returned spec can therefore always be written by the college APIs without
 * a second validation pass: degrees/duration/term system are in range, every
 * course code is unique and within the credit bound, and the mapped term exists.
 */
export function normalizeCollegeSeed(input: unknown): CollegeSeedResult {
  if (input === undefined || input === null) {
    return { ok: true, spec: cloneCollege(COLLEGE_DEFAULT_SKELETON) };
  }
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "college must be an object." };
  }
  const raw = input as CollegeSeedInput;
  const base = COLLEGE_DEFAULT_SKELETON;

  // ---- department ---------------------------------------------------------
  // A code is derived from the name ONLY when the caller renamed the entity: a
  // request that changes nothing must produce the skeleton's own codes exactly.
  const departmentNameInput = readText(raw.department?.name);
  const departmentName = departmentNameInput || base.department.name;
  const departmentCode =
    readText(raw.department?.code) ||
    (departmentNameInput ? seedCodeFor(departmentNameInput) : "") ||
    base.department.code;

  // ---- programme ----------------------------------------------------------
  const degreeLevel = readText(raw.program?.degreeLevel) || base.program.degreeLevel;
  if (!DEGREE_LEVELS.includes(degreeLevel as DegreeLevel)) {
    return { ok: false, error: `degreeLevel must be one of: ${DEGREE_LEVELS.join(", ")}.` };
  }
  const termSystem = readText(raw.program?.termSystem) || base.program.termSystem;
  if (!TERM_SYSTEMS.includes(termSystem as SeedTermSystem)) {
    return { ok: false, error: `termSystem must be one of: ${TERM_SYSTEMS.join(", ")}.` };
  }
  const durationRaw = raw.program?.durationYears;
  const durationYears =
    durationRaw === undefined || durationRaw === null || durationRaw === ""
      ? base.program.durationYears
      : Number(durationRaw);
  if (!Number.isInteger(durationYears) || durationYears < 1 || durationYears > 6) {
    return { ok: false, error: "durationYears must be a whole number from 1 to 6." };
  }
  const programNameInput = readText(raw.program?.name);
  const programName = programNameInput || base.program.name;
  const programCode =
    readText(raw.program?.code) ||
    (programNameInput ? seedCodeFor(programNameInput) : "") ||
    base.program.code;

  // ---- courses ------------------------------------------------------------
  const courseList: SeedCourse[] = [];
  const seen = new Set<string>();
  const source = raw.courses === undefined ? base.courses : raw.courses;
  if (!Array.isArray(source)) return { ok: false, error: "college.courses must be an array." };
  for (const entry of source) {
    if (!entry || typeof entry !== "object") continue;
    const title = readText((entry as any).title);
    if (!title) continue;
    const code = readText((entry as any).code) || seedCodeFor(title);
    if (!code || seen.has(code)) continue; // duplicate or unusable code → skipped
    const creditHours = readCreditHours((entry as any).creditHours);
    if (creditHours === "INVALID") {
      return {
        ok: false,
        error: `creditHours must be a positive number of at most ${MAX_CREDIT_HOURS} (or omitted).`,
      };
    }
    const type = readText((entry as any).type) || "THEORY";
    if (!COURSE_TYPES.includes(type as CourseType)) {
      return { ok: false, error: `type must be one of: ${COURSE_TYPES.join(", ")}.` };
    }
    seen.add(code);
    courseList.push({ code, title, creditHours, type: type as CourseType });
  }

  // ---- the term the seeded courses land in --------------------------------
  const termRaw = raw.mapCoursesToTerm;
  const mapCoursesToTerm = termRaw === undefined || termRaw === null || termRaw === "" ? 1 : Number(termRaw);
  if (!Number.isInteger(mapCoursesToTerm) || mapCoursesToTerm < 1) {
    return { ok: false, error: "mapCoursesToTerm must be a whole number of at least 1." };
  }
  const termCeiling = seedTermCount(durationYears, termSystem);
  if (courseList.length && mapCoursesToTerm > termCeiling) {
    return {
      ok: false,
      error: `mapCoursesToTerm must be a whole number from 1 to ${termCeiling} for this programme.`,
    };
  }

  return {
    ok: true,
    spec: {
      department: { name: departmentName, code: departmentCode },
      program: {
        name: programName,
        code: programCode,
        degreeLevel: degreeLevel as DegreeLevel,
        durationYears,
        termSystem: termSystem as SeedTermSystem,
      },
      courses: courseList,
      mapCoursesToTerm,
    },
  };
}
