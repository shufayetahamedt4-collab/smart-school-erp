/**
 * College fees — the 7d PAGE layer's decisions, pure
 * (docs/COLLEGE-DECISIONS.md §24, D-7-1…D-7-19).
 *
 * `src/app/dashboard/college-fees/page.tsx` (a client component) and the shared
 * ledger page are mostly JSX. What is NOT JSX — and what a reviewer must not
 * have to read hundreds of lines of markup to check — is a small set of
 * load-bearing rules:
 *
 *   - **ONE money helper, integer minor units end to end.** `formatMinor` is the
 *     only function in the app that turns stored money into text for the college
 *     screens, and every amount is carried as whole paisa (`toMinor`) until then.
 *     No page may divide by 100, round, or format money itself; the offline
 *     verifier (`scripts/verify-college-fees-page.mjs`) fails if one tries.
 *   - **The v1 access rule decides the controls, not the page** (D-7-18):
 *     `writeControlsFor(role)` is the ONE place that says which write controls
 *     exist for a role, so a REGISTRAR can never be shown a button the API would
 *     403 — and the page asks for it instead of re-testing the role list.
 *   - **A refusal is shown VERBATIM** (`apiRefusal`): the server's 400/409 text
 *     (over-payment, duplicate structure row, already-decided award) reaches the
 *     screen unchanged, and a failed request is never silently retried.
 *   - **The shared ledger's college tag** is one rule seen from the ledger's
 *     side: `feeId: null` + `meta.collegeFeeId` / `meta.collegeDiscountId` is a
 *     COLLEGE entry, and `ledgerTotals` keeps the two halves' money in SEPARATE
 *     totals so no page adds school and college money together (D-7-12, Q3).
 *
 * This module is **dependency-free** in the same sense as `college-fees.ts`,
 * `college-results-view.ts` and `college-promotion-view.ts`: its only import is
 * the pure `./college-fees` money module, so a plain-`node` offline verifier can
 * import it directly (no prisma, no `node:`, no React). That verifier fails if
 * any other import appears here, and it fails if a page re-inlines a literal this
 * module owns.
 *
 * **Nothing here proves a page RENDERS.** There is no DOM, no React, no browser
 * and no server in this file: a real browser pass is a separate step.
 */

import {
  COLLEGE_FEE_BASES,
  COLLEGE_FEE_BUCKETS,
  COLLEGE_FEE_FREQUENCIES,
  COLLEGE_FEE_UNITS,
  MINOR_PER_UNIT,
  fromMinor,
  roundMoney,
} from "./college-fees";
import { canDecideCollegeFeeAward, canReadCollegeFees, canWriteCollegeFees } from "./college-fees-access";
import { hasCollege, normalizeInstitutionType } from "./institution";

/* --------------------------------------------------------------- money (ONE) */

/** The glyph a currency label prints with. Unknown labels fall back to the code. */
export const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  BDT: "৳",
  USD: "$",
  EUR: "€",
  GBP: "£",
  INR: "₹",
};

/** What a missing or unusable money value prints as — never a fake ৳0.00. */
export const MONEY_UNKNOWN = "—";

/**
 * A money-shaped value as whole minor units (paisa), or `null` when there is
 * nothing to print. Accepts the API's numbers and the padded strings real data
 * arrives in ("1,200.50", " ৳1200 "). Never returns NaN or Infinity.
 */
export function minorUnits(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  let n: number;
  if (typeof value === "number") n = value;
  else if (typeof value === "string") {
    const cleaned = value.trim().replace(/[,\s৳$€£₹]/g, "");
    if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    n = Number(cleaned);
  } else return null;
  if (!Number.isFinite(n)) return null;
  const minor = Math.round(n * MINOR_PER_UNIT);
  return Number.isFinite(minor) ? minor : null;
}

/**
 * THE money formatter of the college screens (7d): integer minor units in, text
 * out, grouped for reading and always showing the paisa.
 *
 * Integer arithmetic only — the whole part is `Math.floor(abs / 100)` and the
 * paisa part is `abs % 100`, so no float can drift and no `toFixed`/`toLocaleString`
 * rounding rule is left to chance. `null`/junk prints the em-dash, never ৳0.00.
 */
export function formatMinor(minor: unknown, currency: unknown = "BDT"): string {
  const value = minorValue(minor);
  if (value === null) return MONEY_UNKNOWN;
  const code = String(currency ?? "").trim().toUpperCase();
  const symbol = CURRENCY_SYMBOLS[code] ?? (code ? `${code} ` : CURRENCY_SYMBOLS.BDT);
  const negative = value < 0;
  const abs = Math.abs(value);
  const whole = Math.floor(abs / MINOR_PER_UNIT);
  const paisa = abs % MINOR_PER_UNIT;
  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${symbol}${grouped}.${paisa < 10 ? `0${paisa}` : String(paisa)}`;
}

/**
 * An amount as the 7c API serves it (a finite number of MAJOR units) printed by
 * the one formatter. Delegates — there is no second formatting rule.
 */
export function formatMoney(major: unknown, currency: unknown = "BDT"): string {
  const minor = minorUnits(major);
  return minor === null ? MONEY_UNKNOWN : formatMinor(minor, currency);
}

/**
 * An ALREADY-MINOR value (a whole number of paisa), checked — the counterpart of
 * `minorUnits`, which converts the API's major units at the boundary. Keeping the
 * two apart is what stops a formatter from converting twice: `formatMinor` takes
 * paisa, `formatMoney` takes the number the API served.
 */
export function minorValue(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? Math.round(value) : null;
  if (typeof value === "string") {
    const cleaned = value.trim().replace(/[,\s৳$€£₹]/g, "");
    if (!cleaned || !/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
    const n = Number(cleaned);
    return Number.isFinite(n) ? Math.round(n) : null;
  }
  return null;
}

/** The integer sum of already-MINOR values; unusable entries contribute 0. */
export function sumMinor(values: readonly unknown[]): number {
  return (Array.isArray(values) ? values : []).reduce<number>((total, value) => total + (minorValue(value) ?? 0), 0);
}

/** A typed amount (what an admin types, e.g. "1,500.50") as whole minor units. */
export function typedMinor(text: unknown): number | null {
  const raw = String(text ?? "").trim();
  if (!raw) return null;
  const cleaned = raw.replace(/[,\s৳$€£₹]/g, "");
  if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const minor = minorUnits(cleaned.endsWith(".") ? cleaned.slice(0, -1) : cleaned);
  return minor === null ? null : minor;
}

/** Did the admin type more than the two decimals money has? (its own message) */
export function typedTooPrecise(text: unknown): boolean {
  const raw = String(text ?? "").trim().replace(/[,\s৳$€£₹]/g, "");
  return /^\d+\.\d{3,}$/.test(raw);
}

/**
 * The result of reading one typed money field — the form's ONE validator, so the
 * button rule and the handler rule cannot drift apart.
 */
export type TypedMoney = { ok: true; minor: number } | { ok: false; error: string };

export function readMoneyField(text: unknown, label = "amount"): TypedMoney {
  const raw = String(text ?? "").trim();
  if (!raw) return { ok: false, error: `Enter ${label === "amount" ? "an amount" : `the ${label}`}.` };
  if (typedTooPrecise(raw)) return { ok: false, error: "Use at most two decimals — money has 100 paisa." };
  const minor = typedMinor(raw);
  if (minor === null) return { ok: false, error: "Enter a plain number, e.g. 1500.50" };
  if (minor <= 0) return { ok: false, error: "The amount must be more than zero." };
  return { ok: true, minor };
}

/* ------------------------------------------------------------ copy & refusals */

/** The human fallback for every load on the college fee screens, in one place. */
export const PAGE_ERRORS = {
  heads: "Could not load the fee heads",
  structure: "Could not load the fee structure",
  charges: "Could not load the charges",
  dues: "Could not load the dues",
  discounts: "Could not load the discounts and waivers",
  config: "Could not load the payment config",
  programmes: "Could not load the programmes",
  save: "Could not save",
  pay: "Could not record the payment",
  generate: "Could not run the charge generation",
  decide: "Could not decide the award",
} as const;

/**
 * The server's own refusal text, VERBATIM, or `null` when the failure did not
 * come from the API (a dropped connection carries no message worth printing).
 *
 * The client's `ApiError` carries a numeric status; a network failure does not.
 * That is the whole discriminator — so a 400/409 refusal (over-payment, duplicate
 * structure row, already-decided award) is shown exactly as the server wrote it
 * and never replaced by a friendly paraphrase.
 */
export function apiRefusal(e: unknown): string | null {
  const err = e as { status?: unknown; message?: unknown } | null | undefined;
  if (!err || typeof err !== "object") return null;
  if (typeof err.status !== "number") return null;
  const message = typeof err.message === "string" ? err.message.trim() : "";
  return message || null;
}

/** What the screen shows for a failed call: the server's words, else the fallback. */
export function refusalText(e: unknown, fallback: string): string {
  return apiRefusal(e) ?? fallback;
}

/** The registrar's (and any read-only reader's) own note — never a write control. */
export function readOnlyNote(): string {
  return "You have read-only access. Fee heads, prices, charges and waivers are set by the administration and the accounts office.";
}

/* ------------------------------------------------------------------ the tabs */

export const COLLEGE_FEE_TABS = [
  { key: "heads", label: "Fee heads" },
  { key: "structure", label: "Fee structure" },
  { key: "dues", label: "Dues & generation" },
  { key: "config", label: "Payment config" },
] as const;

export type CollegeFeeTab = (typeof COLLEGE_FEE_TABS)[number]["key"];

/** The tab a `?tab=` value names, or the first tab (never an empty screen). */
export function tabFor(value: unknown): CollegeFeeTab {
  const raw = String(value ?? "").trim();
  const hit = COLLEGE_FEE_TABS.find((t) => t.key === raw);
  return hit ? hit.key : "heads";
}

/* ------------------------------------------------------- gating (D-7-18, Q4) */

export type CollegeFeesPageState = "loading" | "error" | "no-college" | "refused" | "ready";

export interface CollegeFeesPageInput {
  meLoading?: unknown;
  meError?: unknown;
  resolved?: unknown;
  institutionType?: unknown;
  role?: unknown;
}

/**
 * What the page shows BEFORE it reads anything.
 *
 * The tenant shape comes from the same source the Shell uses
 * (`me.school.institutionType ?? me.institutionType`), so a SCHOOL tenant that
 * types the URL gets a refusal and issues NO request — the API remains the real
 * gate (`requireCollege()` + the D-7-18 allow-list in every handler).
 */
export function collegeFeesPageState(input: CollegeFeesPageInput): CollegeFeesPageState {
  if (input?.meLoading) return "loading";
  if (!input?.resolved) return input?.meError ? "error" : "loading";
  if (!hasCollege(normalizeInstitutionType(input?.institutionType))) return "no-college";
  if (!canReadCollegeFees(input?.role)) return "refused";
  return "ready";
}

/** May this role write college fees? (the API's own rule, not a copy of it) */
export function pageCanWrite(role: unknown): boolean {
  return canWriteCollegeFees(role);
}

/** May this role read college fees? (REGISTRAR is the read-only reader.) */
export function pageCanRead(role: unknown): boolean {
  return canReadCollegeFees(role);
}

/**
 * Which WRITE controls exist for a role — the ONE answer the page renders from.
 *
 * Any control that is false here must not be rendered at all: hiding a button is
 * convenience, and the API is still the guard (a REGISTRAR is 403 on every write
 * route, `verify-college-fees-api.mjs`), but a screen must never offer an action
 * it knows will be refused.
 */
export interface CollegeFeeWriteControls {
  heads: boolean;
  structure: boolean;
  generate: boolean;
  pay: boolean;
  awardPropose: boolean;
  awardDecide: boolean;
  config: boolean;
}

export function writeControlsFor(role: unknown): CollegeFeeWriteControls {
  const write = canWriteCollegeFees(role);
  return {
    heads: write,
    structure: write,
    generate: write,
    pay: write,
    awardPropose: write,
    // Approving is a second, narrower rule: admin-level only (never the ACCOUNTANT).
    awardDecide: canDecideCollegeFeeAward(role),
    config: write,
  };
}

/* -------------------------------------------------------------- form gating */

export interface BusyForm {
  busy?: unknown;
}

/** The head form: a name is the only hard field (D-7-5 restates the school's rule). */
export function headBlocked(form: { name?: unknown } & BusyForm): boolean {
  return !!form?.busy || !String(form?.name ?? "").trim();
}

/** The structure form: a programme, a head and a positive amount. */
export function structureBlocked(
  form: { programId?: unknown; headId?: unknown; amount?: unknown; termNumber?: unknown } & BusyForm
): boolean {
  if (form?.busy) return true;
  if (!form?.programId || !form?.headId) return true;
  const term = Number(form?.termNumber);
  if (!Number.isInteger(term) || term < 1) return true;
  return !readMoneyField(form?.amount).ok;
}

export function saveButtonLabel(busy: unknown, idle = "Save"): string {
  return busy ? "Saving…" : idle;
}

/**
 * The payment form (D-7-12/D-7-14). The button is disabled while a request is in
 * flight — that is what makes a double-click unable to duplicate a payment — and
 * ONLY for that plus a missing/unreadable field. An amount larger than the due is
 * deliberately allowed to reach the server so the refusal is the server's own 409
 * ("Payment exceeds the outstanding amount") rather than a client-side guess.
 */
export function payDisabled(
  form: { chargeId?: unknown; amount?: unknown; method?: unknown } & BusyForm
): boolean {
  if (form?.busy) return true;
  if (!form?.chargeId || !form?.method) return true;
  return !readMoneyField(form?.amount).ok;
}

/** The same rule for the handler, so the form cannot be bypassed into a refusal. */
export function payBlocked(
  form: { chargeId?: unknown; amount?: unknown; method?: unknown } & BusyForm
): boolean {
  return payDisabled(form);
}

export function payButtonLabel(busy: unknown): string {
  return busy ? "Recording…" : "Record payment";
}

/**
 * 7e-pre — a fresh key for ONE payment attempt.
 *
 * The key belongs to the ATTEMPT, not to a request: the form generates it when a
 * submit first needs it, keeps it across a retry or a dropped response, and throws
 * it away only after a success or when the charge, the amount or the method
 * changes. The server then answers every repeat of that attempt from the payment
 * the first request wrote, so a double submit, a second tab and a retry can only
 * ever produce one payment.
 */
export function newPaymentKey(): string {
  const c: any = typeof crypto !== "undefined" ? crypto : null;
  if (c && typeof c.randomUUID === "function") return String(c.randomUUID());
  // A browser without randomUUID (or a test harness) still gets a usable key.
  return `pk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
}

/** What the screen says after a payment is accepted (receipt + what is left). */
export function paymentDoneText(
  result: { receiptNo?: unknown; applied?: unknown; due?: unknown; status?: unknown } | null | undefined,
  currency: unknown = "BDT"
): string {
  const receipt = String(result?.receiptNo ?? "").trim() || "receipt";
  return `Recorded ${formatMoney(result?.applied, currency)} — ${receipt}. Still due: ${formatMoney(
    result?.due,
    currency
  )} (${dueStatusText(result?.status)}).`;
}

export function dueStatusText(status: unknown): string {
  switch (status) {
    case "PAID":
      return "paid";
    case "PARTIAL":
      return "partly paid";
    case "UNPAID":
      return "unpaid";
    default:
      return "unknown";
  }
}

/* ------------------------------------------------------------- charge totals */

export interface ChargeLike {
  amount?: unknown;
  paidAmount?: unknown;
  discount?: unknown;
  due?: unknown;
  status?: unknown;
}

/** One charge's outstanding paisa, from the two fields the API serves. */
export function dueMinorOf(charge: ChargeLike | null | undefined): number {
  const billed = minorUnits(charge?.amount) ?? 0;
  const paid = minorUnits(charge?.paidAmount) ?? 0;
  return Math.max(0, billed - paid);
}

export interface ChargeTotals {
  count: number;
  billedMinor: number;
  discountMinor: number;
  paidMinor: number;
  dueMinor: number;
}

/**
 * The totals a college screen may print — integer arithmetic over the colleges'
 * OWN rows only. Nothing here can see a school fee row: the reads come from
 * `/api/college-fees`, which never serves one.
 */
export function chargeTotals(rows: readonly ChargeLike[] | null | undefined): ChargeTotals {
  const list = Array.isArray(rows) ? rows : [];
  let billedMinor = 0;
  let discountMinor = 0;
  let paidMinor = 0;
  let dueMinor = 0;
  for (const row of list) {
    billedMinor += minorUnits(row?.amount) ?? 0;
    discountMinor += minorUnits(row?.discount) ?? 0;
    paidMinor += minorUnits(row?.paidAmount) ?? 0;
    dueMinor += dueMinorOf(row);
  }
  return { count: list.length, billedMinor, discountMinor, paidMinor, dueMinor };
}

/** What is still owed on a term's rows, as text (the live term total, D-7-6). */
export function termTotalText(rows: readonly ChargeLike[] | null | undefined, currency: unknown = "BDT"): string {
  const totals = chargeTotals(rows);
  return `${formatMinor(totals.billedMinor, currency)} billed · ${formatMinor(totals.paidMinor, currency)} paid · ${formatMinor(
    totals.dueMinor,
    currency
  )} due`;
}

/* ------------------------------------------------------- dues scope summary */

/**
 * One row of the Dues tab's per-student SUMMARY table — the shape
 * `GET /api/college-fees/dues` serves in `students`. Note the money fields:
 * `billed`, `discount`, `paid`, `due` (MAJOR units) beside `count` — NOT a
 * charge's `amount`/`paidAmount`.
 */
export interface DuesStudentRowLike {
  count?: unknown;
  billed?: unknown;
  discount?: unknown;
  paid?: unknown;
  due?: unknown;
}

/** The Dues header's six figures, all in integer minor units but for the counts. */
export interface DuesScopeTotals {
  students: number;
  charges: number;
  billedMinor: number;
  waivedMinor: number;
  paidMinor: number;
  dueMinor: number;
}

/**
 * The Dues header totals: the SUM of the per-student SUMMARY rows the table
 * beneath renders.
 *
 * A summary row carries `count`/`billed`/`discount`/`paid`/`due` in MAJOR units —
 * it is NOT a charge, so it has no `amount`/`paidAmount`. Running a CHARGE-shaped
 * helper (`chargeTotals`) over these rows is exactly the 7d defect the header
 * shipped with: the helper read charge-shaped keys off rows that never had them,
 * so every money figure collapsed to ৳0.00 and `count` counted STUDENTS, printing
 * `2 students · 2 charges · ৳0.00 billed · ৳0.00 paid · ৳0.00 due` beside a table
 * of real money.
 *
 * The API's own `totals` object is built by `collegeDues()` over the same charge
 * rows these summaries come from, so this sum and the served totals agree — the
 * offline verifier holds this helper to the API's REAL payload (not a fixture)
 * and to the rows the table prints.
 */
export function duesScopeTotals(students: readonly DuesStudentRowLike[] | null | undefined): DuesScopeTotals {
  const list = Array.isArray(students) ? students : [];
  let charges = 0;
  let billedMinor = 0;
  let waivedMinor = 0;
  let paidMinor = 0;
  let dueMinor = 0;
  for (const s of list) {
    const count = Number(s?.count);
    if (Number.isFinite(count)) charges += count;
    billedMinor += minorUnits(s?.billed) ?? 0;
    waivedMinor += minorUnits(s?.discount) ?? 0;
    paidMinor += minorUnits(s?.paid) ?? 0;
    dueMinor += minorUnits(s?.due) ?? 0;
  }
  return { students: list.length, charges, billedMinor, waivedMinor, paidMinor, dueMinor };
}

/**
 * The Dues header line: `N students · M charges · X billed · Y waived · Z paid ·
 * W due` — the six figures the table below and the API's `totals` agree on.
 */
export function duesScopeText(students: readonly DuesStudentRowLike[] | null | undefined, currency: unknown = "BDT"): string {
  const t = duesScopeTotals(students);
  return `${countText(t.students, "student")} · ${countText(t.charges, "charge")} · ${formatMinor(
    t.billedMinor,
    currency
  )} billed · ${formatMinor(t.waivedMinor, currency)} waived · ${formatMinor(t.paidMinor, currency)} paid · ${formatMinor(
    t.dueMinor,
    currency
  )} due`;
}

/* ------------------------------------------------------------ structure rows */

export interface StructureRowLike {
  id?: unknown;
  programId?: unknown;
  termNumber?: unknown;
  headId?: unknown;
  amount?: unknown;
  unit?: unknown;
  basis?: unknown;
  required?: unknown;
  note?: unknown;
}

/**
 * The rows of ONE programme term, keeping the caller's own row type (the page
 * filters the served payload through this rather than testing the term itself).
 */
export function rowsForTerm<T extends StructureRowLike>(rows: readonly T[] | null | undefined, termNumber: unknown): T[] {
  const term = Number(termNumber);
  return (Array.isArray(rows) ? rows : []).filter((r) => Number(r?.termNumber) === term);
}

/** One structure row's amount in minor units. */
export function rowAmountMinor(row: StructureRowLike | null | undefined): number {
  return minorUnits(row?.amount) ?? 0;
}

/**
 * The term's live total (D-7-6): the integer sum of the rows' amounts, plus the
 * number of billing events the cadences add (D-7-7) — `billTotal` is the number
 * a commit would actually raise, `rowsTotal` what the admin typed.
 */
export function structureTotalsText(
  rows: readonly StructureRowLike[] | null | undefined,
  billTotalMajor: unknown,
  currency: unknown = "BDT"
): string {
  const rowsMinor = sumMinor((Array.isArray(rows) ? rows : []).map((r) => rowAmountMinor(r)));
  return `${formatMinor(rowsMinor, currency)} in rows · ${formatMoney(billTotalMajor, currency)} once cadences bill`;
}

/**
 * The Term pricing TABLE's own total: what its PRICED rows add up to.
 *
 * A structure row is a price, not a charge: it has an `amount` and no
 * `paidAmount`, so a charge-shaped total (`termTotalText`) printed
 * `৳X billed · ৳0.00 paid · ৳X due` under a pure pricing table — "due" money that
 * nobody owes. The pricing table shows a pricing figure.
 */
export function structureRowsText(rows: readonly StructureRowLike[] | null | undefined, currency: unknown = "BDT"): string {
  const rowsMinor = sumMinor((Array.isArray(rows) ? rows : []).map((r) => rowAmountMinor(r)));
  return `${formatMinor(rowsMinor, currency)} in rows`;
}

/** A structure row's shape in words, e.g. `per student · flat`. */
export function pricingText(unit: unknown, basis: unknown): string {
  return `${unitLabel(unit)} · ${basisLabel(basis)}`;
}

export function unitLabel(unit: unknown): string {
  return unit === "COURSE" ? "per approved course" : "per student";
}

export function basisLabel(basis: unknown): string {
  return basis === "PER_CREDIT" ? "per credit hour" : "flat";
}

export function bucketLabel(bucket: unknown): string {
  const value = String(bucket ?? "").toUpperCase();
  if (!(COLLEGE_FEE_BUCKETS as readonly string[]).includes(value)) return "Other";
  return value
    .split("_")
    .map((word) => word[0] + word.slice(1).toLowerCase())
    .join(" ");
}

export function frequencyLabel(frequency: unknown): string {
  const value = String(frequency ?? "").toUpperCase();
  if (!(COLLEGE_FEE_FREQUENCIES as readonly string[]).includes(value)) return "Monthly";
  if (value === "ONE_TIME") return "One time";
  return value[0] + value.slice(1).toLowerCase();
}

export function headStateText(active: unknown, optional: unknown): string {
  if (active === false) return "Inactive — never billed";
  return optional ? "Active · optional" : "Active · required";
}

/** The head-form option lists, from 7a's own value sets (never re-typed). */
export const HEAD_BUCKET_OPTIONS = COLLEGE_FEE_BUCKETS;
export const HEAD_FREQUENCY_OPTIONS = COLLEGE_FEE_FREQUENCIES;
export const STRUCTURE_BASIS_OPTIONS = COLLEGE_FEE_BASES;
export const STRUCTURE_UNIT_OPTIONS = COLLEGE_FEE_UNITS;

/* ------------------------------------------------------------- generation UI */

export interface GenerationOutcomeLike {
  dryRun?: unknown;
  programName?: unknown;
  termLabel?: unknown;
  currency?: unknown;
  written?: unknown;
  skippedExisting?: unknown;
  totals?: { students?: unknown; newRows?: unknown; existingRows?: unknown; amount?: unknown; refused?: unknown };
  students?: { newCharges?: readonly unknown[]; refused?: readonly unknown[] }[];
  discounts?: { awardId?: unknown; amount?: unknown }[];
  skippedAwards?: { awardId?: unknown; reason?: unknown }[];
}

export function generateBlocked(form: { programId?: unknown; termNumber?: unknown } & BusyForm): boolean {
  if (form?.busy) return true;
  if (!form?.programId) return true;
  const term = Number(form?.termNumber);
  return !Number.isInteger(term) || term < 1;
}

export function previewButtonLabel(busy: unknown): string {
  return busy ? "Building the preview…" : "Run preview (writes nothing)";
}

export function commitButtonLabel(busy: unknown): string {
  return busy ? "Writing the charges…" : "Commit these charges";
}

/** The dry-run/commit headline: what was (or would be) written, in minor units. */
export function generationSummaryText(outcome: GenerationOutcomeLike | null | undefined): string {
  if (!outcome) return "";
  const currency = outcome.currency;
  const totals = outcome.totals ?? {};
  const students = Number(totals.students ?? 0);
  const written = Number(outcome.written ?? 0);
  const skipped = Number(outcome.skippedExisting ?? 0);
  const parts = [
    `${students} student${students === 1 ? "" : "s"}`,
    `${formatMoney(totals.amount, currency)} to raise`,
  ];
  if (outcome.dryRun) parts.push(`${Number(totals.newRows ?? 0)} new charge row(s) would be written`);
  else parts.push(`${written} row(s) written`, `${skipped} already on the books (kept as they are)`);
  return parts.join(" · ");
}

/** The per-student line in a generation preview: `Name — 3 course(s) — ৳4,500.00`. */
export function generationStudentText(
  student: { name?: unknown; courseCount?: unknown; total?: unknown },
  currency: unknown
): string {
  return `${String(student?.name ?? "Student")} — ${Number(student?.courseCount ?? 0)} approved course(s) — ${formatMoney(
    student?.total,
    currency
  )}`;
}

/** A waiver the generation actually applied, or a note that none applied. */
export function appliedAwardsText(outcome: GenerationOutcomeLike | null | undefined): string {
  const applied = Array.isArray(outcome?.discounts) ? outcome!.discounts! : [];
  if (!applied.length) return "";
  return `Waivers applied: ${applied.map((a) => formatMoney(a?.amount, outcome?.currency)).join(", ")}`;
}

/* -------------------------------------------------------------- awards (D-7-13) */

export interface AwardLike {
  id?: unknown;
  kind?: unknown;
  percent?: unknown;
  amountPerHead?: unknown;
  headIds?: unknown;
  programId?: unknown;
  termNumber?: unknown;
  status?: unknown;
  proposedBy?: unknown;
  approvedBy?: unknown;
  note?: unknown;
}

export function awardKindText(award: AwardLike | null | undefined): string {
  if (award?.kind === "FIXED") return `${formatMoney(award?.amountPerHead)} per head`;
  return `${Number(award?.percent ?? 0)}% of the term's charges`;
}

export function awardScopeText(award: AwardLike | null | undefined, programmeName?: (id: unknown) => string): string {
  const heads = Array.isArray(award?.headIds) ? (award!.headIds as unknown[]).length : 0;
  const parts: string[] = [];
  const programId = String(award?.programId ?? "");
  parts.push(programId ? `Programme: ${programmeName ? programmeName(programId) : programId}` : "Whole college");
  const term = Number(award?.termNumber);
  if (Number.isInteger(term) && term > 0) parts.push(`Term ${term}`);
  if (heads) parts.push(`${heads} head(s)`);
  return parts.join(" · ");
}

export function awardStateText(status: unknown): string {
  switch (status) {
    case "APPROVED":
      return "Approved — applies to charges raised from now on";
    case "REJECTED":
      return "Rejected";
    case "PROPOSED":
      return "Proposed — waiting for an administrator";
    default:
      return String(status ?? "Proposed");
  }
}

export function awardTone(status: unknown): "green" | "red" | "amber" {
  if (status === "APPROVED") return "green";
  if (status === "REJECTED") return "red";
  return "amber";
}

/**
 * May this viewer decide ONE award? The API's rule, applied per row (D-7-13):
 * admin-level only, and never the person who proposed it — so the two buttons
 * are absent for the proposer and for the accounts office.
 */
export function awardDecidable(
  award: AwardLike | null | undefined,
  role: unknown,
  actorId: unknown
): boolean {
  if (award?.status !== "PROPOSED") return false;
  if (!canDecideCollegeFeeAward(role)) return false;
  const proposer = String(award?.proposedBy ?? "");
  return !(proposer && proposer === String(actorId ?? ""));
}

/** The propose form: a PERCENT in 1..100, or a FIXED amount over named heads. */
export function awardProposeBlocked(
  form: { kind?: unknown; percent?: unknown; amountPerHead?: unknown; headIds?: unknown } & BusyForm
): boolean {
  if (form?.busy) return true;
  if (form?.kind === "FIXED") {
    if (!Array.isArray(form?.headIds) || !(form!.headIds as unknown[]).length) return true;
    return !readMoneyField(form?.amountPerHead, "amount per head").ok;
  }
  const percent = Number(form?.percent);
  return !Number.isFinite(percent) || percent <= 0 || percent > 100;
}

export function awardButtonLabel(busy: unknown): string {
  return busy ? "Sending…" : "Propose award";
}

export function decideButtonLabel(busy: unknown, state: "APPROVED" | "REJECTED"): string {
  if (busy) return state === "APPROVED" ? "Approving…" : "Rejecting…";
  return state === "APPROVED" ? "Approve" : "Reject";
}

/* ------------------------------------------------------------------- config */

export const CHANNEL_KIND_OPTIONS = ["MOBILE", "BANK", "CASH"] as const;

export function channelKindLabel(kind: unknown): string {
  if (kind === "BANK") return "Bank";
  if (kind === "CASH") return "Office / cash";
  return "Mobile wallet";
}

/** One channel in a line: `bKash — Mobile wallet · 017… · BKASH, NAGAD`. */
export function channelLine(channel: {
  label?: unknown;
  kind?: unknown;
  number?: unknown;
  methods?: unknown;
  enabled?: unknown;
}): string {
  const methods = Array.isArray(channel?.methods) ? (channel!.methods as unknown[]).map(String) : [];
  const parts = [
    String(channel?.label ?? "").trim() || "Unnamed channel",
    channelKindLabel(channel?.kind),
  ];
  const number = String(channel?.number ?? "").trim();
  if (number) parts.push(number);
  if (methods.length) parts.push(methods.join(", "));
  if (channel?.enabled === false) parts.push("disabled");
  return parts.join(" · ");
}

export function configBlocked(form: BusyForm): boolean {
  return !!form?.busy;
}

export function configButtonLabel(busy: unknown): string {
  return busy ? "Saving…" : "Save payment config";
}

/** The channels a screen may show: the stored ones, or none at all. */
export function channelsOf(config: { channels?: unknown } | null | undefined): Record<string, unknown>[] {
  return Array.isArray(config?.channels) ? (config!.channels as Record<string, unknown>[]) : [];
}

/* --------------------------------------------------- the shared central ledger */

/** The two modes' money, as the shared ledger holds it (D-7-12, Q3). */
export const LEDGER_MODE_OPTIONS = [
  { value: "", label: "All money" },
  { value: "SCHOOL", label: "School money" },
  { value: "COLLEGE", label: "College money" },
] as const;

export type LedgerModeFilter = "" | "SCHOOL" | "COLLEGE";

/**
 * Is this ledger entry COLLEGE money?
 *
 * THE tag, and the only one (7c's audit, D-7-12): the college path writes
 * `feeId: null` plus `meta.collegeFeeId` (a payment) or `meta.collegeDiscountId`
 * (an approved waiver). A school entry always carries its own `feeId`, so the tag
 * is unambiguous in both directions — and a tagged entry must keep showing with
 * its badge, never be hidden.
 */
export function isCollegeLedgerEntry(entry: {
  feeId?: unknown;
  meta?: unknown;
} | null | undefined): boolean {
  if (!entry || typeof entry !== "object") return false;
  if (entry.feeId) return false;
  const meta = (entry.meta && typeof entry.meta === "object" ? entry.meta : {}) as Record<string, unknown>;
  return !!meta.collegeFeeId || !!meta.collegeDiscountId;
}

export function ledgerEntryMode(entry: { feeId?: unknown; meta?: unknown } | null | undefined): "COLLEGE" | "SCHOOL" {
  return isCollegeLedgerEntry(entry) ? "COLLEGE" : "SCHOOL";
}

/** The badge text for a college entry — the same word in the filter and the row. */
export const COLLEGE_LEDGER_BADGE = "College";

/**
 * A ledger row's amount, or `null` when the row is the school's own.
 *
 * The shared ledger page keeps the school's own money formatter and text
 * untouched (its figures and markup must not change for a school tenant), so it
 * asks this module ONLY for college money — which is printed from integer minor
 * units, paisa included.
 */
export function collegeLedgerAmountText(entry: { feeId?: unknown; meta?: unknown; amount?: unknown } | null | undefined): string | null {
  return isCollegeLedgerEntry(entry) ? formatMinor(minorUnits(entry?.amount)) : null;
}

/** The rows a mode filter shows; an empty filter shows everything, tagged. */
export function filterLedgerEntries<T extends { feeId?: unknown; meta?: unknown }>(
  entries: readonly T[] | null | undefined,
  filter: unknown
): T[] {
  const list = Array.isArray(entries) ? entries : [];
  const mode = String(filter ?? "");
  if (mode !== "SCHOOL" && mode !== "COLLEGE") return [...list];
  return list.filter((e) => ledgerEntryMode(e) === mode);
}

export interface LedgerHalfTotals {
  collectedMinor: number;
  discountsMinor: number;
  lateFeesMinor: number;
  byMethodMinor: Record<string, number>;
  entries: number;
}

export interface LedgerTotalsSplit {
  school: LedgerHalfTotals;
  college: LedgerHalfTotals;
}

function emptyHalf(): LedgerHalfTotals {
  return { collectedMinor: 0, discountsMinor: 0, lateFeesMinor: 0, byMethodMinor: {}, entries: 0 };
}

/**
 * The ledger's totals, split by half — the rule that makes Q3's binding condition
 * true on screen: **no total adds school and college money together.** A caller
 * prints `school.*` and `college.*` as two separate figures; there is deliberately
 * no combined number to print.
 */
export function ledgerTotals(entries: readonly { kind?: unknown; status?: unknown; method?: unknown; amount?: unknown; feeId?: unknown; meta?: unknown }[] | null | undefined): LedgerTotalsSplit {
  const split: LedgerTotalsSplit = { school: emptyHalf(), college: emptyHalf() };
  for (const entry of Array.isArray(entries) ? entries : []) {
    const half = isCollegeLedgerEntry(entry) ? split.college : split.school;
    half.entries += 1;
    if (entry?.status !== "CONFIRMED") continue;
    const amount = minorUnits(entry?.amount) ?? 0;
    if (entry?.kind === "PAYMENT") {
      half.collectedMinor += amount;
      const method = String(entry?.method ?? "") || "OTHER";
      half.byMethodMinor[method] = (half.byMethodMinor[method] ?? 0) + amount;
    } else if (entry?.kind === "DISCOUNT") {
      half.discountsMinor += amount;
    } else if (entry?.kind === "LATE_FEE") {
      half.lateFeesMinor += amount;
    }
  }
  return split;
}

/** Is there any college money on this ledger? (the badge/filter only then matter) */
export function hasCollegeMoney(entries: readonly { feeId?: unknown; meta?: unknown }[] | null | undefined): boolean {
  return (Array.isArray(entries) ? entries : []).some((e) => isCollegeLedgerEntry(e));
}

/** A BOTH/COLLEGE tenant's own ledger note, so a reader knows what the badge means. */
export function collegeLedgerNote(): string {
  // The line sits DIRECTLY after the `College` badge on the ledger page, so it
  // must not open with the same word again: "College" + "College fee payments…"
  // reads as "College College fee payments…" (the 7d-screens observation, 7d-fix).
  return "Fee payments and waivers post to this same ledger. They carry a College badge, their totals are kept apart from the school's, and no figure on this page adds the two together.";
}

/* --------------------------------------------------------------- misc helpers */

/** The route the one college fee nav entry points at (slug and query are one place). */
export const COLLEGE_FEES_HREF = "/dashboard/college-fees";

/** The tab URL — every screen of 7d lives behind this one route and nav entry. */
export function collegeFeesHref(tab: CollegeFeeTab): string {
  return tab === "heads" ? COLLEGE_FEES_HREF : `${COLLEGE_FEES_HREF}?tab=${tab}`;
}

/** A count in words: `1 student` / `3 students`. */
export function countText(n: unknown, singular: string, plural = `${singular}s`): string {
  const count = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `${count} ${count === 1 ? singular : plural}`;
}

/** A headless programme list keyed for a select, tolerant of a partial payload. */
export function programmeOptions(programs: readonly { id?: unknown; name?: unknown }[] | null | undefined): {
  id: string;
  name: string;
}[] {
  return (Array.isArray(programs) ? programs : [])
    .map((p) => ({ id: String(p?.id ?? ""), name: String(p?.name ?? "Programme") }))
    .filter((p) => p.id);
}

/** From a served config row or its defaults, the currency label to print with. */
export function currencyOf(config: { currency?: unknown } | null | undefined): string {
  const code = String(config?.currency ?? "").trim().toUpperCase();
  return code || "BDT";
}

/** The rounded money value the API's structure form expects, from typed text. */
export function majorFromTyped(text: unknown): number | null {
  const read = readMoneyField(text);
  return read.ok ? roundMoney(fromMinor(read.minor)) : null;
}

/* -------------------------------------------- the print pages (D-7-17, 7d) */

/**
 * The two print routes of D-7-17, in the ONE place their hrefs are built.
 *
 * Both are built here rather than in the page that links them (the
 * `COLLEGE_FEES_HREF` convention of this module): a URL that appears in a link on
 * the college fees screen and in the page's own header cannot drift.
 */
export const COLLEGE_FEE_STATEMENT_HREF = "/print/college-fee-statement";
export const COLLEGE_FEE_RECEIPT_HREF = "/print/college-fee-receipt";

/** One student's fee statement, optionally narrowed to one term. Empty id ⇒ "". */
export function collegeFeeStatementHref(studentId: unknown, termNumber?: unknown): string {
  const id = String(studentId ?? "").trim();
  if (!id) return "";
  const term = statementTermValue(termNumber);
  return `${COLLEGE_FEE_STATEMENT_HREF}/${encodeURIComponent(id)}${term ? `?term=${term}` : ""}`;
}

/**
 * The receipt for ONE confirmed payment on one charge.
 *
 * `receiptNo` selects which payment when a charge has been paid more than once
 * (a family paying in instalments holds several receipts for one charge); without
 * it the page prints the charge's newest confirmed payment.
 */
export function collegeFeeReceiptHref(chargeId: unknown, receiptNo?: unknown): string {
  const id = String(chargeId ?? "").trim();
  if (!id) return "";
  const receipt = String(receiptNo ?? "").trim();
  return `${COLLEGE_FEE_RECEIPT_HREF}/${encodeURIComponent(id)}${receipt ? `?receipt=${encodeURIComponent(receipt)}` : ""}`;
}

/**
 * The statement's `?term=` value: a whole number from 1, or `null` for the whole
 * programme. Junk (`""`, `"abc"`, `"0"`, `"1.5"`, `"-2"`) is the SAME as absent —
 * a printed statement is never an error page because of a hand-typed query.
 */
export function statementTermValue(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : null;
}

export interface StatementTermGroup<T> {
  termNumber: number;
  rows: T[];
  totals: ChargeTotals;
}

/**
 * A statement's charge rows, grouped by term in term order (1, 2, 3…) with each
 * term's own totals — the shape the statement page prints.
 *
 * A row whose term cannot be read as a whole number is grouped under term 1, the
 * same default the store itself uses (`serveCharge`), so a statement can never
 * lose a charge to a junk term number.
 */
export function statementTerms<T extends ChargeLike & { termNumber?: unknown }>(
  rows: readonly T[] | null | undefined
): StatementTermGroup<T>[] {
  const byTerm = new Map<number, T[]>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const n = Number(row?.termNumber);
    const term = Number.isInteger(n) && n >= 1 ? n : 1;
    const list = byTerm.get(term);
    if (list) list.push(row);
    else byTerm.set(term, [row]);
  }
  return [...byTerm.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([termNumber, list]) => ({ termNumber, rows: list, totals: chargeTotals(list) }));
}

/**
 * A statement's scope line: `Term 1 — 3 charges`, or the whole programme with its
 * term count. Always says which rows the paper below is about.
 */
export function statementScopeText(
  groups: readonly StatementTermGroup<ChargeLike>[] | null | undefined,
  termNumber: number | null,
  currency: unknown = "BDT"
): string {
  const list = Array.isArray(groups) ? groups : [];
  const charges = list.reduce((n, g) => n + g.rows.length, 0);
  const money = list.reduce(
    (acc, g) => ({
      billedMinor: acc.billedMinor + g.totals.billedMinor,
      paidMinor: acc.paidMinor + g.totals.paidMinor,
      dueMinor: acc.dueMinor + g.totals.dueMinor,
    }),
    { billedMinor: 0, paidMinor: 0, dueMinor: 0 }
  );
  const scope = termNumber ? `Term ${termNumber}` : `Whole programme · ${countText(list.length, "term")}`;
  return `${scope} · ${countText(charges, "charge")} · ${formatMinor(money.billedMinor, currency)} billed · ${formatMinor(
    money.paidMinor,
    currency
  )} paid · ${formatMinor(money.dueMinor, currency)} due`;
}

/** Is this ledger entry the COLLEGE payment recorded against THIS charge? */
export function isCollegePaymentEntryFor(
  entry: { kind?: unknown; feeId?: unknown; meta?: unknown } | null | undefined,
  chargeId: unknown
): boolean {
  if (!isCollegeLedgerEntry(entry)) return false;
  if (entry?.kind !== "PAYMENT") return false;
  const id = String(chargeId ?? "").trim();
  if (!id) return false;
  const meta = (entry?.meta && typeof entry.meta === "object" ? entry.meta : {}) as Record<string, unknown>;
  return String(meta.collegeFeeId ?? "") === id;
}

/** A college payment's receipt number, as the ledger entry carries it. */
export function paymentReceiptNo(entry: { meta?: unknown } | null | undefined): string {
  const meta = (entry?.meta && typeof entry.meta === "object" ? entry.meta : {}) as Record<string, unknown>;
  return String(meta.receiptNo ?? "").trim();
}

/**
 * The ONE entry a receipt page prints.
 *
 * With a receipt number, that entry — and `matched` says whether it was really
 * found, so a page can refuse to print a DIFFERENT payment under the number a
 * family is holding. Without one, the newest confirmed payment on the charge.
 * `createdAt` is compared as a string (ISO), which is what both the API and the
 * store serve; an unreadable date sorts last rather than throwing.
 */
export function pickReceiptEntry<T extends { meta?: unknown; createdAt?: unknown; id?: unknown }>(
  entries: readonly T[] | null | undefined,
  receiptNo?: unknown
): { entry: T; matched: boolean } | null {
  const list = (Array.isArray(entries) ? entries : []).filter((e) => e && typeof e === "object");
  if (!list.length) return null;
  const wanted = String(receiptNo ?? "").trim();
  if (wanted) {
    const hit = list.find((e) => paymentReceiptNo(e) === wanted);
    return hit ? { entry: hit, matched: true } : null;
  }
  const newest = [...list].sort((a, b) => {
    const byDate = String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? ""));
    return byDate !== 0 ? byDate : String(b?.id ?? "").localeCompare(String(a?.id ?? ""));
  })[0];
  return newest ? { entry: newest, matched: false } : null;
}

/**
 * Which structure priced this charge, as the rate line both print pages carry.
 *
 * D-7-17 requires a reprint to be honest about WHAT billed it, so the paper names
 * the row's own pricing (`৳1,500.00 per student · flat`) instead of implying a
 * figure nobody can check. The module stays date-format-free: the page prints the
 * effective date itself through the app's own `fmtDate`.
 */
export function structureRateText(row: StructureRowLike | null | undefined, currency: unknown = "BDT"): string {
  if (!row) return "";
  return `${formatMoney(row.amount, currency)} ${pricingText(row.unit, row.basis)}`;
}

/** The instant a structure row took effect, as stored (a string key, or null). */
export function structureEffectiveAt(row: StructureRowLike | null | undefined): string | null {
  const raw = (row as any)?.updatedAt || (row as any)?.createdAt || null;
  const text = String(raw ?? "").trim();
  return text || null;
}

/**
 * What a charge's own row says about its settlement — printed beside the receipt
 * so one payment is never mistaken for the whole charge.
 */
export function chargeSettlementText(charge: ChargeLike | null | undefined, currency: unknown = "BDT"): string {
  const due = dueMinorOf(charge);
  if (!charge) return "";
  if (due === 0 && (minorUnits(charge.amount) ?? 0) > 0) return "Paid in full";
  if (due === 0) return "Nothing billed";
  return `${formatMinor(due, currency)} still due`;
}
