/**
 * College fee logic — the pure half of Phase 7a (docs/COLLEGE-DECISIONS.md §24).
 *
 * This module decides, given the admin's own fee heads and structure rows and a
 * student's enrolment plus their APPROVED course registrations, WHAT a college
 * term charges: the charge set, its deterministic ids, the discount arithmetic,
 * the dues read and the payment rules. It writes nothing, reads nothing and
 * knows nothing about HTTP, prisma, sessions, React or Firestore — the same
 * design as `college-results.ts`, `college-promotion.ts`, `college-terms.ts`
 * and `college-routes.ts`, so the offline verifier
 * (`scripts/verify-college-fees-logic.mjs`), a client component and Edge code
 * can all import it. That verifier pins the property by failing if an `import`
 * appears in this file.
 *
 * Why it does NOT import `college-terms.ts`: the no-import property is what
 * makes the module trivially portable. The term arithmetic is therefore
 * **restated** here (`collegeTermCount`, `isValidCollegeTermNumber`,
 * `collegeTermLabel`, `collegeTermMonths`) and the offline verifier asserts the
 * restatement equals `college-terms.ts` on a wide probe table — pinned, not
 * assumed to agree (the same treatment `college-results.ts` gives the retake
 * list).
 *
 * The decided rules (docs/COLLEGE-DECISIONS.md §24.2–§24.4):
 *
 *   - **D-7-1/D-7-2** — a head is the school's own shape (`name`, `bucket`,
 *     `frequency`, `optional`, `active`, `dueDay`, `note`, `branchId`) **minus
 *     the pricing**: the amount lives in the structure, because the same head
 *     costs different money in different programmes and terms.
 *   - **D-7-5** — the school's validation, restated: a name is required and
 *     bounded, `bucket`/`frequency` fall back rather than throw, `dueDay` is
 *     clamped 1..28, `optional`/`active` are coerced exactly as the school's own
 *     route coerces them (`!!value`), and an inactive head is never billed.
 *   - **D-7-6** — the structure is ONE row per `(programId, termNumber, headId)`:
 *     an `amount`, a `required` flag and a `note`. The term number is bounded by
 *     the programme's own `durationYears`/`termSystem`.
 *   - **D-7-7** — one row = what one billing event charges; the head's
 *     `frequency` decides how MANY events a term produces (`MONTHLY` in a
 *     6-month term bills six times, `TERM` once, `YEARLY` once per year).
 *   - **D-7-8** — `basis: FLAT | PER_CREDIT` is present as the hook, and
 *     `PER_CREDIT` is **refused in v1**: a credit basis is impossible for an HSC
 *     college (its courses carry `creditHours: null`), so the module refuses it
 *     with a reason instead of ever minting a NaN.
 *   - **D-7-9/D-7-11** — the charge carries its own `title` and `amount`;
 *     changing a structure row never rewrites a charge already raised, and
 *     `paidAmount` is written explicitly as 0.
 *   - **D-7-10** — a charge is DERIVED from `(programId, termNumber)` plus the
 *     APPROVED registrations, never typed: the `(student, head, term, sequence)`
 *     id makes a re-run top up the students who arrived late instead of
 *     double-charging.
 *   - **D-7-13** — discounts are a percentage of a term's charges or a fixed
 *     amount per head, propose/approve, and only an APPROVED award applies.
 *   - **D-7-14** — dues are a first-class, FINITE read: `Σ(amount − paid)`, with
 *     UNPAID / PARTIAL / PAID derived from the two fields, never stored apart.
 *
 * **The rounding rule, written down (D-7-13's "no floating point drift").** All
 * arithmetic happens in integer **minor units** (paisa, 1/100 of a taka):
 * `toMinor` rounds the incoming money to the nearest paisa, every sum, product
 * and percentage is integer arithmetic, and `fromMinor` turns the result back
 * into money with at most two decimals. A percentage is computed per charge as
 * `round(amount_minor × percent / 100)` — half away from zero, the rounding
 * `Math.round` already uses for positive money. A discount can never take a
 * charge below zero: the waiver is clamped to what the charge still owes, and
 * the clamp is reported (`applied[].clamped`).
 *
 * The module's own settings entry point is `resolveCollegeFeeSettings` — the
 * one place the tenant's college fee config is resolved, so the later
 * per-programme or per-credit override lands here without touching a caller
 * (the `resolveSchemeFor` pattern, D-6-18).
 */

/* --------------------------------------------------------------------- money */

/** Minor units per money unit — money is handled in paisa, never in floats. */
export const MINOR_PER_UNIT = 100;

/** A finite number from anything money-shaped, or 0. Never NaN, never Infinity. */
export function safeMoney(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value === "string") {
    const n = Number(value.replace(/[\s,৳]/g, ""));
    return Number.isFinite(n) ? n : 0;
  }
  if (value === null || value === undefined) return 0;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** Money to integer minor units (paisa). Half away from zero. */
export function toMinor(value: unknown): number {
  return Math.round(safeMoney(value) * MINOR_PER_UNIT);
}

/** Integer minor units back to money, two decimals at most. */
export function fromMinor(minor: unknown): number {
  const n = Number.isFinite(Number(minor)) ? Math.round(Number(minor)) : 0;
  return n / MINOR_PER_UNIT;
}

/** Money rounded to two decimals — the value every charge row stores. */
export function roundMoney(value: unknown): number {
  return fromMinor(toMinor(value));
}

/* ---------------------------------------------------------------------- heads */

/** The eight accounting buckets the central ledger already understands. */
export const COLLEGE_FEE_BUCKETS = [
  "TUITION",
  "ADMISSION",
  "EXAM",
  "TRANSPORT",
  "HOSTEL",
  "LIBRARY_FINE",
  "LATE_FEE",
  "OTHER",
] as const;
export type CollegeFeeBucket = (typeof COLLEGE_FEE_BUCKETS)[number];

/** The five cadences the school's own fee heads use. */
export const COLLEGE_FEE_FREQUENCIES = ["WEEKLY", "MONTHLY", "TERM", "YEARLY", "ONE_TIME"] as const;
export type CollegeFeeFrequency = (typeof COLLEGE_FEE_FREQUENCIES)[number];

/**
 * The pricing hook (D-7-8). `PER_CREDIT` exists so the later per-credit basis is
 * an addition *inside* the one pricing function, and it is refused in v1.
 */
export const COLLEGE_FEE_BASES = ["FLAT", "PER_CREDIT"] as const;
export type CollegeFeeBasis = (typeof COLLEGE_FEE_BASES)[number];

/** What one charge of a structure row covers: the student, or one course. */
export const COLLEGE_FEE_UNITS = ["STUDENT", "COURSE"] as const;
export type CollegeFeeUnit = (typeof COLLEGE_FEE_UNITS)[number];

/** A head name is required and bounded, like every other named thing here. */
export const COLLEGE_FEE_NAME_MAX = 80;
/** A note is a short operator sentence, never a document. */
export const COLLEGE_FEE_NOTE_MAX = 120;

/** The refusal a `PER_CREDIT` row gets in v1 (D-7-8, owner's answer Q2). */
export const PER_CREDIT_NOT_IN_V1 =
  "Per-credit-hour pricing is not in v1 — price the term flat (basis FLAT).";

export function isCollegeFeeBucket(value: unknown): value is CollegeFeeBucket {
  return typeof value === "string" && (COLLEGE_FEE_BUCKETS as readonly string[]).includes(value);
}

/** `bucket` falls back to OTHER rather than throwing (D-7-5). */
export function normalizeCollegeFeeBucket(value: unknown): CollegeFeeBucket {
  return isCollegeFeeBucket(value) ? value : "OTHER";
}

export function isCollegeFeeFrequency(value: unknown): value is CollegeFeeFrequency {
  return typeof value === "string" && (COLLEGE_FEE_FREQUENCIES as readonly string[]).includes(value);
}

/** `frequency` falls back to MONTHLY, exactly as the school's route does. */
export function normalizeCollegeFeeFrequency(value: unknown): CollegeFeeFrequency {
  return isCollegeFeeFrequency(value) ? value : "MONTHLY";
}

export function isCollegeFeeBasis(value: unknown): value is CollegeFeeBasis {
  return typeof value === "string" && (COLLEGE_FEE_BASES as readonly string[]).includes(value);
}

export function isCollegeFeeUnit(value: unknown): value is CollegeFeeUnit {
  return typeof value === "string" && (COLLEGE_FEE_UNITS as readonly string[]).includes(value);
}

/** An unknown unit reads as STUDENT (charging once, not once per course). */
export function normalizeCollegeFeeUnit(value: unknown): CollegeFeeUnit {
  return isCollegeFeeUnit(value) ? value : "STUDENT";
}

/** A head as it is stored and read back (D-7-2). */
export interface CollegeFeeHead {
  name: string;
  bucket: CollegeFeeBucket;
  frequency: CollegeFeeFrequency;
  optional: boolean;
  active: boolean;
  dueDay: number | null;
  note: string | null;
  branchId: string | null;
}

export const DEFAULT_COLLEGE_FEE_HEAD: CollegeFeeHead = {
  name: "Fee",
  bucket: "OTHER",
  frequency: "MONTHLY",
  optional: false,
  active: true,
  dueDay: null,
  note: null,
  branchId: null,
};

/** Clamp a due day to 1..28 (`null` when absent or unusable). */
function dueDayOf(value: unknown): number | null {
  if (value === null || value === undefined || value === "" || value === false) return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(28, Math.max(1, Math.round(n)));
}

function noteOf(value: unknown, max: number): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function idOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s.slice(0, 120) : null;
}

/**
 * Validate a head for storage. A refusal always names what to fix; nothing here
 * throws, and the two enums fall back (D-7-5) — only the NAME is a hard rule.
 */
export function validateCollegeFeeHead(input: unknown): { ok: true; head: CollegeFeeHead } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "Give the fee head a name." };
  const raw = input as Record<string, unknown>;
  const name = String(raw.name ?? "").trim().slice(0, COLLEGE_FEE_NAME_MAX);
  if (!name) return { ok: false, error: "Give the fee head a name." };
  return {
    ok: true,
    head: {
      name,
      bucket: normalizeCollegeFeeBucket(raw.bucket),
      frequency: normalizeCollegeFeeFrequency(raw.frequency),
      // The school's own coercion (`!!value`, with the shipped default when the
      // key is absent) so a POST stores what the school's route would store.
      optional: raw.optional === undefined ? false : !!raw.optional,
      active: raw.active === undefined ? true : !!raw.active,
      dueDay: dueDayOf(raw.dueDay),
      note: noteOf(raw.note, COLLEGE_FEE_NOTE_MAX),
      branchId: idOf(raw.branchId),
    },
  };
}

/**
 * Read a stored (or hand-written, or legacy) head without ever throwing: a
 * missing name reads "Fee", a junk bucket OTHER, a junk frequency MONTHLY and a
 * junk due day `null`, so a page can render a row it cannot fully trust.
 */
export function normalizeCollegeFeeHead(value: unknown): CollegeFeeHead {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const name = String(raw.name ?? "").trim().slice(0, COLLEGE_FEE_NAME_MAX);
  return {
    name: name || DEFAULT_COLLEGE_FEE_HEAD.name,
    bucket: normalizeCollegeFeeBucket(raw.bucket),
    frequency: normalizeCollegeFeeFrequency(raw.frequency),
    optional: raw.optional === true,
    active: raw.active !== false,
    dueDay: dueDayOf(raw.dueDay),
    note: noteOf(raw.note, COLLEGE_FEE_NOTE_MAX),
    branchId: idOf(raw.branchId),
  };
}

/* ---------------------------------------------------------------------- terms */

/**
 * The term model, restated from `college-terms.ts` to keep this module
 * import-free (the offline verifier asserts the two agree).
 */
export const COLLEGE_TERM_SYSTEMS = ["YEARLY", "SEMESTER"] as const;
export type CollegeTermSystem = (typeof COLLEGE_TERM_SYSTEMS)[number];
export const DEFAULT_COLLEGE_TERM_SYSTEM: CollegeTermSystem = "YEARLY";

export function isCollegeTermSystem(value: unknown): value is CollegeTermSystem {
  return typeof value === "string" && (COLLEGE_TERM_SYSTEMS as readonly string[]).includes(value);
}

/** Absent or unrecognised reads as YEARLY — a missing field is the default. */
export function normalizeCollegeTermSystem(value: unknown): CollegeTermSystem {
  return isCollegeTermSystem(value) ? value : DEFAULT_COLLEGE_TERM_SYSTEM;
}

/** Terms per academic year: a YEARLY programme has one, a SEMESTER programme two. */
export function collegeTermsPerYear(system: unknown): number {
  return normalizeCollegeTermSystem(system) === "SEMESTER" ? 2 : 1;
}

/** How many terms the programme has: `durationYears × termsPerYear`. */
export function collegeTermCount(durationYears: number, system: unknown): number {
  const years = Number.isInteger(durationYears) && durationYears > 0 ? durationYears : 0;
  return years * collegeTermsPerYear(system);
}

/** How many months one term of this programme covers (12 or 6). */
export function collegeTermMonths(system: unknown): number {
  return 12 / collegeTermsPerYear(system);
}

/** Is this a term number the programme actually has? */
export function isValidCollegeTermNumber(termNumber: unknown, durationYears: number, system: unknown): boolean {
  if (!Number.isInteger(termNumber)) return false;
  const n = termNumber as number;
  return n >= 1 && n <= collegeTermCount(durationYears, system);
}

/** The human label of one term — "Year 3" or "Semester 5". */
export function collegeTermLabel(termNumber: number, system: unknown): string {
  const unit = normalizeCollegeTermSystem(system) === "SEMESTER" ? "Semester" : "Year";
  return `${unit} ${termNumber}`;
}

/* ------------------------------------------------------- cadence → events (D-7-7) */

/** The longest term the arithmetic accepts; anything wilder reads as a year. */
export const MAX_TERM_MONTHS = 60;
const DEFAULT_TERM_MONTHS = 12;

function termMonthsOf(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TERM_MONTHS;
  return Math.min(MAX_TERM_MONTHS, n);
}

/**
 * How many times ONE structure row bills inside ONE term (D-7-7).
 *
 *   - MONTHLY  → once per month of the term (6-month term → 6, a year → 12)
 *   - WEEKLY   → once per week of the term (a year → 52, a semester → 26)
 *   - TERM     → once
 *   - YEARLY   → once per year the term covers (a term is at most a year → 1)
 *   - ONE_TIME → once, and it is the admin's job to bill the one right term
 *
 * The count is always a whole number ≥ 1, so it can never multiply a charge by
 * a fraction or by zero.
 */
export function billingEventsFor(frequency: unknown, termMonths: unknown = DEFAULT_TERM_MONTHS): number {
  const months = termMonthsOf(termMonths);
  switch (normalizeCollegeFeeFrequency(frequency)) {
    case "WEEKLY":
      return Math.max(1, Math.round((months * 52) / 12));
    case "MONTHLY":
      return Math.max(1, Math.round(months));
    case "YEARLY":
      return Math.max(1, Math.ceil(months / 12));
    case "TERM":
    case "ONE_TIME":
      return 1;
    default:
      return Math.max(1, Math.round(months));
  }
}

/* ------------------------------------------------------------------ structure */

/** One priced (programme, term, head) row (D-7-6/D-7-7). */
export interface CollegeFeeStructureRow {
  programId: string;
  termNumber: number;
  headId: string;
  amount: number;
  required: boolean;
  basis: CollegeFeeBasis;
  unit: CollegeFeeUnit;
  note: string | null;
}

export interface CollegeProgrammeBounds {
  durationYears: number;
  termSystem?: unknown;
}

/**
 * Validate one structure row. `programme` is optional: when it is given the term
 * number is checked against the programme's own `durationYears`/`termSystem`
 * (D-7-6), so a structure can never price a term the programme does not have.
 */
export function validateCollegeFeeStructure(
  input: unknown,
  programme?: CollegeProgrammeBounds | null
): { ok: true; row: CollegeFeeStructureRow } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "A structure row needs a programme, a term and a head." };
  const raw = input as Record<string, unknown>;

  const programId = idOf(raw.programId);
  if (!programId) return { ok: false, error: "A structure row needs a programme." };
  const headId = idOf(raw.headId);
  if (!headId) return { ok: false, error: "A structure row needs a fee head." };

  const termNumber = Number(raw.termNumber);
  if (!Number.isInteger(termNumber) || termNumber < 1) {
    return { ok: false, error: "The term must be a whole number starting at 1." };
  }
  if (programme && !isValidCollegeTermNumber(termNumber, programme.durationYears, programme.termSystem)) {
    return {
      ok: false,
      error: `This programme has no term ${termNumber} — it has ${collegeTermCount(programme.durationYears, programme.termSystem)} term(s).`,
    };
  }

  // The pricing hook is present and deliberately refused in v1 (D-7-8).
  if (raw.basis === "PER_CREDIT") return { ok: false, error: PER_CREDIT_NOT_IN_V1 };

  const amount = Number(safeMoney(raw.amount));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "Set an amount greater than 0." };

  return {
    ok: true,
    row: {
      programId,
      termNumber,
      headId,
      amount: roundMoney(amount),
      required: raw.required !== false,
      basis: "FLAT",
      unit: normalizeCollegeFeeUnit(raw.unit),
      note: noteOf(raw.note, COLLEGE_FEE_NOTE_MAX),
    },
  };
}

/**
 * Read a stored structure row without throwing. An explicit `PER_CREDIT` basis
 * is preserved so the billing path can refuse it (rather than silently pricing
 * it as flat).
 */
export function normalizeCollegeFeeStructure(value: unknown): CollegeFeeStructureRow {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const termNumber = Number(raw.termNumber);
  return {
    programId: idOf(raw.programId) ?? "",
    termNumber: Number.isInteger(termNumber) && termNumber >= 1 ? termNumber : 1,
    headId: idOf(raw.headId) ?? "",
    amount: roundMoney(safeMoney(raw.amount)),
    required: raw.required !== false,
    basis: isCollegeFeeBasis(raw.basis) ? raw.basis : "FLAT",
    unit: normalizeCollegeFeeUnit(raw.unit),
    note: noteOf(raw.note, COLLEGE_FEE_NOTE_MAX),
  };
}

function headIndex(heads: unknown): Map<string, CollegeFeeHead> {
  const map = new Map<string, CollegeFeeHead>();
  if (!Array.isArray(heads)) return map;
  for (const entry of heads) {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const id = idOf(raw.id);
    if (!id) continue;
    map.set(id, normalizeCollegeFeeHead(raw));
  }
  return map;
}

/** A term's total for a programme: the sum of its rows, one event each (D-7-6). */
export function structureTotal(rows: unknown): number {
  if (!Array.isArray(rows)) return 0;
  let minor = 0;
  for (const row of rows) {
    const r = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
    minor += toMinor(r.amount);
  }
  return fromMinor(minor);
}

/** The rows an inactive head can no longer bill (D-7-5). */
export function billableStructureRows(rows: unknown, heads: unknown): CollegeFeeStructureRow[] {
  const index = headIndex(heads);
  if (!Array.isArray(rows)) return [];
  return rows
    .map(normalizeCollegeFeeStructure)
    .filter((row) => {
      const head = index.get(row.headId);
      return !head || head.active !== false;
    });
}

export interface CollegeBillingLine {
  headId: string;
  amount: number;
  events: number;
  total: number;
}

/** Per-row billing breakdown: `amount × events` for every billable row. */
export function billingBreakdown(rows: unknown, heads: unknown, termMonths: number): CollegeBillingLine[] {
  const index = headIndex(heads);
  return billableStructureRows(rows, heads).map((row) => {
    const head = index.get(row.headId);
    const events = billingEventsFor(head?.frequency, termMonths);
    return { headId: row.headId, amount: row.amount, events, total: fromMinor(toMinor(row.amount) * events) };
  });
}

/** What one TERM actually raises: `Σ amount × events`, inactive heads excluded. */
export function termBillTotal(rows: unknown, heads: unknown, termMonths: number): number {
  let minor = 0;
  for (const line of billingBreakdown(rows, heads, termMonths)) minor += toMinor(line.total);
  return fromMinor(minor);
}

/* -------------------------------------------------------------------- presets */

/** An editable starting point for the heads editor (D-7-4). */
export interface CollegeFeeHeadDraft {
  name: string;
  bucket: CollegeFeeBucket;
  frequency: CollegeFeeFrequency;
  optional: boolean;
}

export interface CollegeFeePreset {
  key: string;
  label: string;
  hint: string;
  heads: CollegeFeeHeadDraft[];
}

/**
 * Institution-neutral starting points (D-7-4). A preset drops an **editable
 * copy** into the editor; nothing is applied behind the admin's back and none is
 * privileged. There is deliberately no credit-based preset while `PER_CREDIT`
 * is refused in v1 (D-7-8) — a preset that could not validate has no place in
 * this table.
 */
export const COLLEGE_FEE_PRESETS: CollegeFeePreset[] = [
  {
    key: "college-hsc",
    label: "College — HSC / National",
    hint: "Monthly tuition, a per-term exam fee, and yearly session and library charges.",
    heads: [
      { name: "Tuition Fee", bucket: "TUITION", frequency: "MONTHLY", optional: false },
      { name: "Exam Fee", bucket: "EXAM", frequency: "TERM", optional: false },
      { name: "Session Charge", bucket: "OTHER", frequency: "YEARLY", optional: false },
      { name: "Library Fee", bucket: "OTHER", frequency: "YEARLY", optional: true },
    ],
  },
  {
    key: "college-university",
    label: "College — University (per term)",
    hint: "One tuition charge per term, with a per-course lab fee and an exam charge.",
    heads: [
      { name: "Tuition Fee", bucket: "TUITION", frequency: "TERM", optional: false },
      { name: "Exam Fee", bucket: "EXAM", frequency: "TERM", optional: false },
      { name: "Lab Fee", bucket: "OTHER", frequency: "TERM", optional: true },
      { name: "Development Fee", bucket: "OTHER", frequency: "YEARLY", optional: true },
    ],
  },
  {
    key: "custom",
    label: "Custom",
    hint: "Start from nothing and add exactly the heads this institution charges.",
    heads: [],
  },
];

/** The preset for a key, or `null` for junk. */
export function collegeFeePreset(key: unknown): CollegeFeePreset | null {
  if (typeof key !== "string") return null;
  return COLLEGE_FEE_PRESETS.find((p) => p.key === key) ?? null;
}

/**
 * Fresh, editable copies of a preset's heads — a new array of new objects every
 * call, so an edit in the editor can never rewrite the table itself.
 */
export function presetHeads(key: unknown): CollegeFeeHeadDraft[] {
  const preset = collegeFeePreset(key);
  if (!preset) return [];
  return preset.heads.map((h) => ({ ...h }));
}

/* ------------------------------------------------------------------- charges */

const REGISTRATION_APPROVED = "APPROVED";

/** The ONE status a registration must carry to bill anything (D-7-10). */
export function isApprovedRegistration(value: unknown): boolean {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return String(raw.status ?? "").trim().toUpperCase() === REGISTRATION_APPROVED;
}

/** A safe id token: deterministic, and never a path separator. */
function token(value: unknown): string {
  return String(value ?? "").replace(/[^A-Za-z0-9_-]/g, "_");
}

/**
 * The deterministic charge id (D-7-10): `(student, head, term, sequence)`.
 *
 * It is the whole idempotence story — a re-run, a concurrent submission or a
 * late registration all compute the same id for the same charge, so a college
 * generation can only ever create a row that is not there yet.
 */
export function collegeChargeId(studentId: unknown, headId: unknown, termNumber: unknown, sequence: unknown): string {
  const term = Number.isInteger(Number(termNumber)) ? Number(termNumber) : 0;
  const seq = Number.isInteger(Number(sequence)) && Number(sequence) > 0 ? Number(sequence) : 1;
  return `cf_${token(studentId)}_${token(headId)}_${term}_${seq}`;
}

/** The charge's own title — it carries the name and term it was raised with (D-7-9). */
export function chargeTitle(headName: unknown, termLabel: unknown, sequence = 1, events = 1, courseNumber = 0): string {
  const base = `${String(headName ?? "").trim() || "Fee"} — ${String(termLabel ?? "").trim() || "Term"}`;
  const byEvent = events > 1 ? ` (${sequence}/${events})` : "";
  const byCourse = courseNumber > 0 ? ` · Course ${courseNumber}` : "";
  return `${base}${byEvent}${byCourse}`;
}

/** A college charge row as it is written (D-7-11). */
export interface CollegeCharge {
  id: string;
  schoolId: string | null;
  branchId: string | null;
  studentId: string;
  programId: string;
  termNumber: number;
  headId: string;
  headName: string;
  bucket: CollegeFeeBucket;
  title: string;
  amount: number;
  paidAmount: number;
  status: "UNPAID" | "PARTIAL" | "PAID";
  sequence: number;
  unit: CollegeFeeUnit;
  dueDay: number | null;
  dueDate: string | null;
}

export interface CollegeChargeRequest {
  schoolId?: string | null;
  branchId?: string | null;
  studentId: unknown;
  programId: unknown;
  termNumber: unknown;
  /** The programme's own bounds; without them the term is only checked as ≥ 1. */
  programme?: CollegeProgrammeBounds | null;
  heads?: unknown;
  structure?: unknown;
  /** The student's registrations for this term — only APPROVED ones bill. */
  registrations?: unknown;
  /** Charges already raised for this student/term (any read shape with an `id`). */
  existing?: unknown;
  /** Bill optional heads too (the admin ticked them). */
  includeOptional?: boolean;
  /** The explicit heads to bill; a required row is billed even when it is absent. */
  headIds?: unknown;
  dueDate?: unknown;
}

export interface CollegeChargePlan {
  charges: CollegeCharge[];
  /** Charges already on the books — never rewritten, never duplicated. */
  existing: string[];
  /** Every charge this term needs, new and existing. */
  planned: number;
  /** The money the NEW rows add. */
  total: number;
  courseCount: number;
  /** Rows that cannot bill, each with the reason (inactive head, PER_CREDIT, …). */
  refused: { headId: string | null; reason: string }[];
  skippedOptional: number;
}

/**
 * Derive a student's charge set for one term (D-7-10).
 *
 * The inputs are the admin's own rows and the student's own enrolment: the
 * `(programId, termNumber)` identity, the APPROVED registrations for that term,
 * the structure rows priced for it and the heads they point at. Nothing is
 * typed by hand and nothing is invented:
 *
 *   - a head that is not active bills nothing (D-7-5);
 *   - an `optional` head (or a row with `required: false`) bills only when the
 *     caller asks for it by id;
 *   - a `COURSE`-unit row bills once per APPROVED registration, so a student
 *     with no approved registration bills nothing for a course-based head;
 *   - a `PER_CREDIT` row is refused with the recorded reason, never priced;
 *   - a charge already on the books is returned as `existing` and left alone.
 */
export function deriveCollegeCharges(request: CollegeChargeRequest): CollegeChargePlan {
  const plan: CollegeChargePlan = {
    charges: [],
    existing: [],
    planned: 0,
    total: 0,
    courseCount: 0,
    refused: [],
    skippedOptional: 0,
  };

  const studentId = idOf(request?.studentId);
  const programId = idOf(request?.programId);
  const termNumber = Number(request?.termNumber);
  if (!studentId || !programId || !Number.isInteger(termNumber) || termNumber < 1) return plan;

  const programme = request?.programme ?? null;
  if (programme && !isValidCollegeTermNumber(termNumber, programme.durationYears, programme.termSystem)) return plan;

  const termSystem = programme?.termSystem;
  const termLabel = collegeTermLabel(termNumber, termSystem);
  const termMonths = collegeTermMonths(termSystem);

  const courseCount = Array.isArray(request?.registrations)
    ? request.registrations.filter(isApprovedRegistration).length
    : 0;
  plan.courseCount = courseCount;

  const index = headIndex(request?.heads);
  const wanted = Array.isArray(request?.headIds) ? request.headIds.map((h) => String(h)) : [];
  const onlyWanted = wanted.length > 0;
  const existingIds = new Set<string>();
  if (Array.isArray(request?.existing)) {
    for (const row of request.existing) {
      const raw = (row && typeof row === "object" ? row : {}) as Record<string, unknown>;
      const id = idOf(raw.id);
      if (id) existingIds.add(id);
    }
  }

  const rows = (Array.isArray(request?.structure) ? request.structure : [])
    .map(normalizeCollegeFeeStructure)
    .filter((row) => row.programId === programId && row.termNumber === termNumber)
    .sort((a, b) => (a.headId < b.headId ? -1 : a.headId > b.headId ? 1 : 0));

  let totalMinor = 0;

  for (const row of rows) {
    const head = index.get(row.headId);
    if (!head) {
      plan.refused.push({ headId: row.headId, reason: "The fee head no longer exists." });
      continue;
    }
    if (head.active === false) {
      plan.refused.push({ headId: row.headId, reason: "The fee head is inactive — reactivate it to bill." });
      continue;
    }
    if (row.basis === "PER_CREDIT") {
      plan.refused.push({ headId: row.headId, reason: PER_CREDIT_NOT_IN_V1 });
      continue;
    }
    const optional = head.optional === true || row.required === false;
    if (optional && !(request?.includeOptional === true && wanted.includes(row.headId))) {
      plan.skippedOptional += 1;
      continue;
    }
    if (onlyWanted && !wanted.includes(row.headId) && !optional) {
      // An explicit pick narrows a required row too — that is what the admin asked for.
      continue;
    }

    const units = row.unit === "COURSE" ? courseCount : 1;
    if (units <= 0) {
      // A course-based head with no approved registration bills nothing at all.
      plan.refused.push({ headId: row.headId, reason: "No approved course registration — nothing to bill for this head." });
      continue;
    }

    const events = billingEventsFor(head.frequency, termMonths);
    const amountMinor = toMinor(row.amount);
    const amount = fromMinor(amountMinor);

    // COURSE-major sequence: a row's events are numbered course by course, so a
    // course's ids are the stable range 1..events, events+1..2*events, … and a
    // late registration APPENDS a course's charges instead of re-interpreting
    // the ids already on the books. An already-billed id therefore keeps meaning
    // the same event of the same course — the D-7-10 rule is "top up, never
    // rewrite", and this ordering is what makes that true of the labels too
    // (an event-major id would silently swap the course a stored row belongs to
    // as soon as the number of courses changed).
    for (let course = 1; course <= units; course++) {
      for (let event = 1; event <= events; event++) {
        const sequence = (course - 1) * events + event;
        const id = collegeChargeId(studentId, row.headId, termNumber, sequence);
        if (existingIds.has(id)) {
          plan.existing.push(id);
          continue;
        }
        plan.charges.push({
          id,
          schoolId: idOf(request?.schoolId),
          branchId: idOf(request?.branchId),
          studentId,
          programId,
          termNumber,
          headId: row.headId,
          headName: head.name,
          bucket: head.bucket,
          title: chargeTitle(head.name, termLabel, event, events, units > 1 ? course : 0),
          amount,
          paidAmount: 0,
          status: "UNPAID",
          sequence,
          unit: row.unit,
          dueDay: head.dueDay,
          dueDate: request?.dueDate ? String(request.dueDate).slice(0, 40) : null,
        });
        totalMinor += amountMinor;
      }
    }
  }

  plan.total = fromMinor(totalMinor);
  plan.planned = plan.charges.length + plan.existing.length;
  return plan;
}

/* ----------------------------------------------------------------- discounts */

/** The two discount shapes the owner ruled into v1 (D-7-13, Q5). */
export const COLLEGE_DISCOUNT_KINDS = ["PERCENT", "FIXED"] as const;
export type CollegeDiscountKind = (typeof COLLEGE_DISCOUNT_KINDS)[number];

/** Propose/approve, the school's own flow (D-7-13). */
export const COLLEGE_DISCOUNT_STATES = ["PROPOSED", "APPROVED", "REJECTED"] as const;
export type CollegeDiscountState = (typeof COLLEGE_DISCOUNT_STATES)[number];

export function isCollegeDiscountKind(value: unknown): value is CollegeDiscountKind {
  return typeof value === "string" && (COLLEGE_DISCOUNT_KINDS as readonly string[]).includes(value);
}

export function isCollegeDiscountState(value: unknown): value is CollegeDiscountState {
  return typeof value === "string" && (COLLEGE_DISCOUNT_STATES as readonly string[]).includes(value);
}

/** A discount award: a percentage of a term's charges, or a fixed amount per head. */
export interface CollegeDiscount {
  id: string;
  kind: CollegeDiscountKind;
  percent: number | null;
  amountPerHead: number | null;
  headIds: string[];
  programId: string | null;
  termNumber: number | null;
  status: CollegeDiscountState;
  proposedBy: string | null;
  approvedBy: string | null;
  note: string | null;
}

function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = value.map((v) => idOf(v)).filter((v): v is string => !!v);
  return [...new Set(out)].sort();
}

/**
 * Validate an award. A percentage must be 1..100, a fixed award a positive
 * amount and at least one head, and an APPROVED award must name who approved
 * it — a discount with no approver is a refusal, not a silent waiver.
 */
export function validateCollegeDiscount(input: unknown): { ok: true; award: CollegeDiscount } | { ok: false; error: string } {
  if (!input || typeof input !== "object") return { ok: false, error: "A discount needs a kind." };
  const raw = input as Record<string, unknown>;

  if (!isCollegeDiscountKind(raw.kind)) return { ok: false, error: "A discount is either PERCENT or FIXED." };
  const kind = raw.kind;

  let percent: number | null = null;
  if (kind === "PERCENT") {
    const p = Number(raw.percent);
    if (!Number.isFinite(p) || p <= 0 || p > 100) return { ok: false, error: "A percentage discount must be between 1 and 100." };
    percent = roundMoney(p);
  }

  let amountPerHead: number | null = null;
  const headIds = idList(raw.headIds);
  if (kind === "FIXED") {
    const amount = Number(safeMoney(raw.amountPerHead));
    if (!Number.isFinite(amount) || amount <= 0) return { ok: false, error: "A fixed discount must be greater than 0." };
    if (!headIds.length) return { ok: false, error: "A fixed discount names the head(s) it waives." };
    amountPerHead = roundMoney(amount);
  }

  const status = isCollegeDiscountState(raw.status) ? raw.status : "PROPOSED";
  const approvedBy = idOf(raw.approvedBy);
  if (status === "APPROVED" && !approvedBy) return { ok: false, error: "An approved discount must record who approved it." };

  return {
    ok: true,
    award: {
      id: idOf(raw.id) ?? "",
      kind,
      percent,
      amountPerHead,
      headIds,
      programId: idOf(raw.programId),
      termNumber: Number.isInteger(Number(raw.termNumber)) ? Number(raw.termNumber) : null,
      status,
      proposedBy: idOf(raw.proposedBy),
      approvedBy,
      note: noteOf(raw.note, COLLEGE_FEE_NOTE_MAX),
    },
  };
}

/**
 * Read a stored award leniently. A junk record keeps its id and status but
 * carries no arithmetic, so `applyCollegeDiscounts` can only skip it — never
 * discount something by accident.
 */
export function normalizeCollegeDiscount(value: unknown): CollegeDiscount {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const kind = isCollegeDiscountKind(raw.kind) ? raw.kind : null;
  const percentRaw = Number(raw.percent);
  const fixedRaw = Number(safeMoney(raw.amountPerHead));
  return {
    id: idOf(raw.id) ?? "",
    kind: (kind ?? "PERCENT") as CollegeDiscountKind,
    percent: kind === "PERCENT" && Number.isFinite(percentRaw) && percentRaw > 0 && percentRaw <= 100 ? roundMoney(percentRaw) : null,
    amountPerHead: kind === "FIXED" && Number.isFinite(fixedRaw) && fixedRaw > 0 ? roundMoney(fixedRaw) : null,
    headIds: idList(raw.headIds),
    programId: idOf(raw.programId),
    termNumber: Number.isInteger(Number(raw.termNumber)) ? Number(raw.termNumber) : null,
    status: isCollegeDiscountState(raw.status) ? raw.status : "PROPOSED",
    proposedBy: idOf(raw.proposedBy),
    approvedBy: idOf(raw.approvedBy),
    note: noteOf(raw.note, COLLEGE_FEE_NOTE_MAX),
  };
}

export interface DiscountedCharge {
  id: string;
  headId: string;
  programId: string | null;
  termNumber: number;
  /** What the structure billed, before any award. */
  grossAmount: number;
  /** The money the awards waived. */
  discount: number;
  /** What the family actually owes on this charge (the stored `amount`). */
  amount: number;
  paidAmount: number;
}

export interface CollegeDiscountResult {
  rows: DiscountedCharge[];
  applied: { awardId: string; amount: number; clamped: boolean }[];
  skippedAwards: { awardId: string; reason: string }[];
  grossTotal: number;
  totalDiscount: number;
  netTotal: number;
}

/** Does an award reach this charge's (programme, term, head)? */
function awardMatches(award: CollegeDiscount, charge: { programId?: string | null; termNumber: number; headId: string }): boolean {
  if (award.programId && charge.programId && award.programId !== charge.programId) return false;
  if (award.termNumber !== null && award.termNumber !== charge.termNumber) return false;
  if (award.kind === "FIXED") return award.headIds.includes(charge.headId);
  return award.headIds.length === 0 || award.headIds.includes(charge.headId);
}

/**
 * Apply the APPROVED awards to a charge set (D-7-13).
 *
 * Percentages run first, then fixed amounts, each in id order, so two awards can
 * never fight over an ordering the caller cannot see. A percentage is computed
 * per charge on that charge's own gross amount and clamped to what is left of
 * it (so an overlapping award can never discount it twice); a FIXED award waives
 * its amount **once per
 * head** across that head's charges (a lab-fee waiver waives the fee, not once
 * per month), walking them in sequence order. Every waiver is clamped to what
 * the charge still owes, and the clamp is reported.
 *
 * Only `APPROVED` awards apply: a PROPOSED or REJECTED award is inert, and an
 * unreadable one is skipped with a reason.
 */
export function applyCollegeDiscounts(
  charges: unknown,
  awards: unknown
): CollegeDiscountResult {
  const rows: DiscountedCharge[] = (Array.isArray(charges) ? charges : []).map((entry) => {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const amount = roundMoney(safeMoney(raw.amount));
    const termNumber = Number.isInteger(Number(raw.termNumber)) ? Number(raw.termNumber) : 0;
    return {
      id: idOf(raw.id) ?? "",
      headId: idOf(raw.headId) ?? "",
      termNumber,
      grossAmount: amount,
      discount: 0,
      amount,
      paidAmount: roundMoney(safeMoney(raw.paidAmount)),
      programId: idOf(raw.programId),
    };
  });

  const applied: CollegeDiscountResult["applied"] = [];
  const skippedAwards: CollegeDiscountResult["skippedAwards"] = [];

  const approved = (Array.isArray(awards) ? awards : [])
    .map(normalizeCollegeDiscount)
    .filter((award) => {
      if (award.status !== "APPROVED") return false;
      if (award.kind === "PERCENT" && award.percent === null) {
        skippedAwards.push({ awardId: award.id, reason: "The percentage is missing or out of range." });
        return false;
      }
      if (award.kind === "FIXED" && (award.amountPerHead === null || !award.headIds.length)) {
        skippedAwards.push({ awardId: award.id, reason: "The fixed amount or its head is missing." });
        return false;
      }
      if (!award.approvedBy) {
        skippedAwards.push({ awardId: award.id, reason: "An approved discount must record who approved it." });
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "PERCENT" ? -1 : 1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });

  const key = (row: DiscountedCharge) => `${row.programId ?? ""}|${row.termNumber}|${row.headId}`;
  const totalGrossMinor = rows.reduce((a, row) => a + toMinor(row.grossAmount), 0);

  for (const award of approved) {
    if (award.kind === "PERCENT") {
      const percent = award.percent as number;
      for (const row of rows) {
        if (!awardMatches(award, row)) continue;
        const remainingMinor = toMinor(row.grossAmount) - toMinor(row.discount);
        if (remainingMinor <= 0) continue;
        const waive = Math.min(remainingMinor, Math.round((toMinor(row.grossAmount) * percent) / 100));
        if (waive <= 0) continue;
        row.discount = fromMinor(toMinor(row.discount) + waive);
        applied.push({ awardId: award.id, amount: fromMinor(waive), clamped: waive < Math.round((toMinor(row.grossAmount) * percent) / 100) });
      }
      continue;
    }

    // FIXED — one waiver per (head, term), spread over that head's charges in order.
    const perHeadMinor = award.amountPerHead as number;
    const groups = new Map<string, DiscountedCharge[]>();
    for (const row of rows) {
      if (!awardMatches(award, row)) continue;
      const k = key(row);
      const list = groups.get(k) ?? [];
      list.push(row);
      groups.set(k, list);
    }
    for (const list of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v)) {
      let leftMinor = toMinor(perHeadMinor);
      let clamped = false;
      for (const row of list.sort((a, b) => a.id.localeCompare(b.id))) {
        if (leftMinor <= 0) break;
        const remainingMinor = toMinor(row.grossAmount) - toMinor(row.discount);
        if (remainingMinor <= 0) continue;
        const waive = Math.min(remainingMinor, leftMinor);
        row.discount = fromMinor(toMinor(row.discount) + waive);
        leftMinor -= waive;
        applied.push({ awardId: award.id, amount: fromMinor(waive), clamped: false });
      }
      if (leftMinor > 0) clamped = true;
      if (clamped) applied.push({ awardId: award.id, amount: 0, clamped: true });
    }
  }

  let discountMinor = 0;
  for (const row of rows) {
    row.grossAmount = fromMinor(toMinor(row.grossAmount));
    row.discount = fromMinor(Math.min(toMinor(row.discount), toMinor(row.grossAmount)));
    row.amount = fromMinor(toMinor(row.grossAmount) - toMinor(row.discount));
    discountMinor += toMinor(row.discount);
  }

  return {
    rows,
    applied,
    skippedAwards,
    grossTotal: fromMinor(totalGrossMinor),
    totalDiscount: fromMinor(discountMinor),
    netTotal: fromMinor(totalGrossMinor - discountMinor),
  };
}

/* --------------------------------------------------------------- dues + payments */

export type CollegeDueStatus = "UNPAID" | "PARTIAL" | "PAID";

/** UNPAID / PARTIAL / PAID, derived from the two money fields (D-7-14). */
export function duesStatus(amount: unknown, paid: unknown): CollegeDueStatus {
  const net = toMinor(amount);
  const settled = toMinor(paid);
  if (net <= 0 || settled <= 0) return net <= 0 ? "PAID" : "UNPAID";
  return settled >= net ? "PAID" : "PARTIAL";
}

/** What one charge still owes: `amount − paid`, never negative, always finite. */
export function chargeDue(charge: { amount?: unknown; paidAmount?: unknown } | null | undefined): number {
  const amountMinor = toMinor(charge?.amount);
  const paidMinor = toMinor(charge?.paidAmount);
  return fromMinor(Math.max(0, amountMinor - paidMinor));
}

export interface CollegeDuesSummary {
  rows: { id: string; amount: number; discount: number; paid: number; due: number; status: CollegeDueStatus }[];
  count: number;
  gross: number;
  billed: number;
  discount: number;
  paid: number;
  due: number;
  status: CollegeDueStatus;
}

/**
 * A student's college dues (D-7-14) — a finite read over the charge rows:
 * `Σ(amount − paid)`, with the status derived from the same two fields.
 */
export function collegeDues(charges: unknown): CollegeDuesSummary {
  const summary: CollegeDuesSummary = {
    rows: [],
    count: 0,
    gross: 0,
    billed: 0,
    discount: 0,
    paid: 0,
    due: 0,
    status: "UNPAID",
  };
  if (!Array.isArray(charges)) return summary;

  let grossMinor = 0;
  let discountMinor = 0;
  let billedMinor = 0;
  let paidMinor = 0;

  for (const entry of charges) {
    const raw = (entry && typeof entry === "object" ? entry : {}) as Record<string, unknown>;
    const amount = roundMoney(safeMoney(raw.amount));
    const discount = roundMoney(safeMoney(raw.discount));
    const paid = roundMoney(safeMoney(raw.paidAmount));
    const due = chargeDue({ amount, paidAmount: paid });
    summary.rows.push({
      id: idOf(raw.id) ?? "",
      amount,
      discount,
      paid,
      due,
      status: duesStatus(amount, paid),
    });
    grossMinor += toMinor(amount) + toMinor(discount);
    discountMinor += toMinor(discount);
    billedMinor += toMinor(amount);
    paidMinor += toMinor(paid);
  }

  summary.count = summary.rows.length;
  summary.gross = fromMinor(grossMinor);
  summary.discount = fromMinor(discountMinor);
  summary.billed = fromMinor(billedMinor);
  summary.paid = fromMinor(paidMinor);
  summary.due = fromMinor(Math.max(0, billedMinor - paidMinor));
  summary.status = summary.count === 0 ? "UNPAID" : summary.due <= 0 ? "PAID" : summary.paid > 0 ? "PARTIAL" : "UNPAID";
  return summary;
}

export type CollegePaymentResult =
  | { ok: true; applied: number; paidAmount: number; due: number; status: CollegeDueStatus }
  | { ok: false; error: string };

/**
 * Accept a payment against ONE charge (D-7-14).
 *
 * A payment must be a positive, finite amount and it may never exceed what the
 * charge still owes — an over-payment is refused by name, not silently clamped
 * into a credit. A partial payment leaves the charge PARTIAL.
 */
export function acceptCollegePayment(charge: { amount?: unknown; paidAmount?: unknown } | null | undefined, payment: unknown): CollegePaymentResult {
  const amountMinor = toMinor(charge?.amount);
  const paidMinor = toMinor(charge?.paidAmount);
  const dueMinor = Math.max(0, amountMinor - paidMinor);

  let payMinor: number;
  if (payment !== null && typeof payment === "object") {
    payMinor = toMinor((payment as Record<string, unknown>).amount);
  } else {
    payMinor = toMinor(payment);
  }

  if (!Number.isFinite(payMinor) || payMinor <= 0) return { ok: false, error: "Payment must be a positive amount." };
  if (payMinor > dueMinor) {
    return { ok: false, error: `Payment exceeds the outstanding amount (৳${fromMinor(dueMinor).toLocaleString("en-IN")}).` };
  }

  const paidTotal = paidMinor + payMinor;
  return {
    ok: true,
    applied: fromMinor(payMinor),
    paidAmount: fromMinor(paidTotal),
    due: fromMinor(amountMinor - paidTotal),
    status: duesStatus(fromMinor(amountMinor), fromMinor(paidTotal)),
  };
}

/* ------------------------------------------------------------ tenant settings */

export const COLLEGE_FEE_CURRENCY_DEFAULT = "BDT";

/** The college's own config (D-7-3): channels, a note, a currency label. */
export interface CollegeFeeConfig {
  channels: Record<string, unknown>[];
  paymentNote: string | null;
  currency: string;
}

export const COLLEGE_FEE_CONFIG_DEFAULTS: CollegeFeeConfig = {
  channels: [],
  paymentNote: null,
  currency: COLLEGE_FEE_CURRENCY_DEFAULT,
};

/**
 * Normalise the stored college config. The channel shape is the school's
 * `PaymentChannel` (D-7-3) and its editor-side normalisation belongs to
 * `fee-channels.ts` (7d); this keeps only what every reader can rely on — an
 * array of objects, a bounded note and a currency label that is never blank.
 */
export function normalizeCollegeFeeConfig(value: unknown): CollegeFeeConfig {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const channels = Array.isArray(raw.channels)
    ? raw.channels.filter((c): c is Record<string, unknown> => !!c && typeof c === "object" && !Array.isArray(c))
    : [];
  return {
    channels,
    paymentNote: noteOf(raw.paymentNote, 500),
    currency: String(raw.currency ?? "").trim().slice(0, 12) || COLLEGE_FEE_CURRENCY_DEFAULT,
  };
}

export interface CollegeFeeSettingsRequest {
  schoolId?: string | null;
  programId?: string | null;
  termNumber?: number | null;
  stored?: unknown;
}

/**
 * The ONE place the tenant's college fee settings are resolved (D-6-18 pattern).
 *
 * Every caller that needs the college fee config — the generation preview, the
 * dues read, the statement — goes through this function instead of reading the
 * stored row directly, so the later per-programme config or the per-credit basis
 * lands as a change *inside* it, with no caller, route or page contract touched.
 *
 * v1 is deliberately one config per tenant: the programme, the term and the
 * tenant id are ignored, and the answer is the stored row normalised (or the
 * shipped defaults when there is none).
 */
export function resolveCollegeFeeSettings({ stored }: CollegeFeeSettingsRequest = {}): CollegeFeeConfig {
  // v1: one config per tenant (D-7-8/D-7-3). The arguments are part of the fixed
  // contract so a per-programme override can be added here later.
  return normalizeCollegeFeeConfig(stored ?? COLLEGE_FEE_CONFIG_DEFAULTS);
}
