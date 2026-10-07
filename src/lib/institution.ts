/**
 * Institution type — "one platform, three tenant shapes".
 *
 * A tenant runs a **school**, a **college**, or **both**. The choice is stored
 * on the tenant document as `schools.institutionType`. A document with no such
 * field is a SCHOOL: there is no backfill and no migration, so every tenant that
 * already exists — and every document written by another code path — reads as a
 * school and behaves exactly as before.
 *
 * **Mode** is the UI context *inside* a tenant. A BOTH tenant shows one half at
 * a time (a School | College switcher, later). Mode is deliberately **not**
 * authorization: `can()`, tenant isolation and the permission matrix remain the
 * only enforcement, and the server never treats a cookie or a `?mode=` value as
 * a grant. See docs/COLLEGE-DECISIONS.md.
 *
 * This module is intentionally dependency-free (no prisma, no node: imports) —
 * the same design as `sectors.ts` — so Edge middleware and client components can
 * import it later without pulling the database into their bundle.
 */

export const INSTITUTION_TYPES = ["SCHOOL", "COLLEGE", "BOTH"] as const;
export type InstitutionType = (typeof INSTITUTION_TYPES)[number];

/** A tenant with no `institutionType` is a school. */
export const DEFAULT_INSTITUTION_TYPE: InstitutionType = "SCHOOL";

export const MODES = ["SCHOOL", "COLLEGE"] as const;
export type Mode = (typeof MODES)[number];

const INSTITUTION_TYPE_SET: ReadonlySet<string> = new Set(INSTITUTION_TYPES);
const MODE_SET: ReadonlySet<string> = new Set(MODES);

/** Is this exactly one of the three storable values? */
export function isInstitutionType(value: unknown): value is InstitutionType {
  return typeof value === "string" && INSTITUTION_TYPE_SET.has(value);
}

/** Is this exactly one of the two UI modes? */
export function isMode(value: unknown): value is Mode {
  return typeof value === "string" && MODE_SET.has(value);
}

/**
 * The storable value, or the SCHOOL default. Never throws — an absent field, an
 * empty string and any unrecognised value all read as SCHOOL, so a raw tenant
 * document (old or partial) is always safe to pass in.
 */
export function normalizeInstitutionType(value: unknown): InstitutionType {
  return isInstitutionType(value) ? value : DEFAULT_INSTITUTION_TYPE;
}

/** Does this tenant run a school? True for SCHOOL and BOTH. */
export function hasSchool(type: InstitutionType): boolean {
  return type === "SCHOOL" || type === "BOTH";
}

/** Does this tenant run a college? True for COLLEGE and BOTH. */
export function hasCollege(type: InstitutionType): boolean {
  return type === "COLLEGE" || type === "BOTH";
}

/**
 * The modes this tenant is allowed to show:
 * SCHOOL → [SCHOOL], COLLEGE → [COLLEGE], BOTH → [SCHOOL, COLLEGE].
 */
export function allowedModes(type: InstitutionType): Mode[] {
  const modes: Mode[] = [];
  if (hasSchool(type)) modes.push("SCHOOL");
  if (hasCollege(type)) modes.push("COLLEGE");
  return modes;
}

/** A tenant or user with no usable mode preference shows SCHOOL. */
export const DEFAULT_MODE: Mode = "SCHOOL";

/**
 * The one cookie that carries the current UI mode. It is written by
 * `POST /api/mode` and by nothing else — never by a page, never by a GET.
 * It is UI context only: the server always re-validates it against the
 * tenant's `institutionType`, and it never grants access (docs/COLLEGE-DECISIONS.md §3).
 */
export const MODE_COOKIE = "ss_mode";

/** The storable mode, or the SCHOOL default. Never throws. */
export function normalizeMode(value: unknown): Mode {
  return isMode(value) ? value : DEFAULT_MODE;
}

/**
 * The suffix appended to a College-scoped settings key. Empty for SCHOOL, so a
 * school-mode key is byte-identical to the key it has always used.
 */
export const COLLEGE_KEY_SUFFIX = "__college";

/**
 * A mode-scoped settings key.
 *
 * This is the whole backward-compatibility guarantee for stored settings
 * (docs/COLLEGE-DECISIONS.md §4): the SCHOOL branch returns `base` untouched, so
 * an existing tenant's saved grading scheme, routine config and academic session
 * continue to live under exactly the key they were written with. Only COLLEGE
 * gets a distinct suffix — a tenant that never ran a college cannot be affected.
 */
export function modeScopedKey(base: string, mode: Mode | null | undefined): string {
  return mode === "COLLEGE" ? `${base}${COLLEGE_KEY_SUFFIX}` : base;
}

/* ------------------------------------------------------------ nav labels */

/**
 * Navigation label overrides, keyed `[institutionType][mode][href]`
 * (docs/COLLEGE-PLAN-DELTA.md §4).
 *
 * Phase 1 installs the **structure only**: the table is empty, so every lookup
 * falls through and `NAVS` stays the literal registry it has always been. Each
 * later phase adds its own entry in the same change that creates the route the
 * label belongs to (docs/COLLEGE-DECISIONS.md §8 — "Phase 1 decisions").
 *
 * Two properties worth knowing before adding to it:
 *  - the key is the **href**, so one entry applies to every role whose nav
 *    contains that href. A per-role wording (the registry already has
 *    "Branches" vs "My Branch") cannot be expressed here — if that is ever
 *    needed, this key shape has to change first.
 *  - an absent `institutionType` reads as SCHOOL, so a raw or partial tenant
 *    document and the Super Admin console keep behaving like a school tenant.
 */
export type NavLabelOverrides = Partial<
  Record<InstitutionType, Partial<Record<Mode, Readonly<Record<string, string>>>>>
>;

/** The overrides themselves — deliberately empty until a phase adds one. */
export const NAV_LABEL_OVERRIDES: NavLabelOverrides = {};

/**
 * The label override for one href, or `undefined` when none is configured.
 *
 * Safe for a raw tenant value, an absent institution type and an absent mode;
 * never throws. Callers treat `undefined` as "keep the item's own label", which
 * is what makes an empty table a true no-op.
 */
export function navLabelFor(
  href: string,
  institutionType: InstitutionType | null | undefined,
  mode: Mode | null | undefined
): string | undefined {
  const byType = NAV_LABEL_OVERRIDES[normalizeInstitutionType(institutionType)];
  if (!byType) return undefined;
  const byMode = byType[normalizeMode(mode)];
  if (!byMode) return undefined;
  return byMode[href];
}

/** Human labels for the platform console. Not wired into end-user screens yet. */
export const INSTITUTION_TYPE_LABELS: Record<InstitutionType, string> = {
  SCHOOL: "School",
  COLLEGE: "College",
  BOTH: "School & College",
};

/** Label for any stored/raw value (unknown values read as SCHOOL). */
export function institutionTypeLabel(value: unknown): string {
  return INSTITUTION_TYPE_LABELS[normalizeInstitutionType(value)];
}

/* ------------------------------------------------------------ change rule */

/**
 * Does this tenant currently hold any **college** data?
 *
 * Phase 0: the college collections do not exist yet, so the honest answer is
 * always "no college data" — there is nothing that a downgrade could strand.
 *
 * This is the single place later phases MUST extend: when the college's own
 * classes / programs / students (and anything else college-only) exist, replace
 * the body with a real existence check and return true the moment any such row
 * is present. Until then, `schoolHasCollegeData` is what makes the
 * COLLEGE/BOTH → SCHOOL downgrade safe.
 */
export async function schoolHasCollegeData(schoolId: string): Promise<boolean> {
  void schoolId; // no college collections exist yet (Phase 0)
  return false;
}

export interface InstitutionTypeChangeCheck {
  allowed: boolean;
  /** Present only when `allowed` is false; safe to show to the Super Admin. */
  reason?: string;
}

/**
 * The approved type-change rule (docs/COLLEGE-DECISIONS.md §6):
 *
 *  - `→ BOTH`   is **always allowed** — adding a half never destroys anything;
 *  - `→ SCHOOL` is allowed **only when the tenant has no college data**;
 *  - `→ COLLEGE` is **not defined yet** and is refused until a later phase
 *    decides how a school/BOTH tenant becomes college-only;
 *  - `→ same`   is a no-op and always allowed.
 *
 * `hasCollegeData` is passed in so the rule stays pure; the caller resolves it
 * with `schoolHasCollegeData`. The rule governs type *changes* only — a brand
 * new tenant may be created as any of the three values.
 */
export function canChangeInstitutionType(
  from: InstitutionType,
  to: InstitutionType,
  hasCollegeData: boolean
): InstitutionTypeChangeCheck {
  if (from === to) return { allowed: true };
  if (to === "BOTH") return { allowed: true };
  if (to === "SCHOOL") {
    return hasCollegeData
      ? {
          allowed: false,
          reason:
            "This tenant already has college data. Remove or archive it before switching it to a school-only tenant.",
        }
      : { allowed: true };
  }
  // to === "COLLEGE" — no rule yet.
  return {
    allowed: false,
    reason:
      "Switching a tenant to college-only is not supported yet. Set it to School & College to add a college, or create a new college tenant.",
  };
}
