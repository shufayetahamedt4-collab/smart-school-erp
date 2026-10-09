/**
 * College promotion page — the view layer's DECISIONS, pure (Phase 6-pre 1,
 * docs/COLLEGE-DECISIONS.md §21).
 *
 * `src/app/dashboard/college-promotion/page.tsx` is a client component. Most of it
 * is JSX, but a real and load-bearing part of it is *decisions*: which warnings are
 * shown, how the D6 pending figure is phrased, whether a button is disabled and
 * whether a handler may proceed, what the confirmation dialog promises, what the
 * server's report is turned into, and what the failure path re-fetches. Those are
 * exactly the parts a reviewer must not have to read 765 lines of JSX to check, and
 * they are the parts a future change is most likely to get subtly wrong (a
 * singular/plural slip, a guard that lets a second submit through, a failure path
 * that forgets to refresh).
 *
 * So they live here. This module is **dependency-free** in the same sense as
 * `college-promotion.ts`, `college-terms.ts`, `registration-status.ts` and
 * `institution.ts`: no `import`, no `require(`, no prisma, no `node:`, no React.
 * `scripts/verify-college-promotion-page.mjs` pins that property by failing if an
 * `import` appears here, and it also fails if `page.tsx` stops importing this
 * module or re-inlines a literal this module owns — so the extraction cannot
 * silently drift back into a duplicate.
 *
 * What this module deliberately does NOT do: it does not render, it does not fetch,
 * it holds no state, and it never touches the DOM. **Nothing here proves the page
 * RENDERS.** A real browser test (real login, real navigation, real API round trip)
 * is still NOT DONE — see §21. This module narrows what an untested UI can get wrong;
 * it does not replace that test.
 *
 * Wording is copied VERBATIM from the page and must stay byte-identical: the
 * singular/plural rule and the "pending course requests" label are decided product
 * text (D6), not formatting.
 */

/* ----------------------------------------------------------------------------
 * D6 — the pending figure is a count of REQUESTS, never of students.
 * -------------------------------------------------------------------------- */

/**
 * The exact tooltip D6 requires for the pending figure. It says "pending course
 * requests" and is explicit that this is not a student count and that it neither
 * blocks nor follows a promotion.
 */
export const PENDING_TOOLTIP =
  "Course-registration requests still PENDING at this term. One request = one course; one student may have several. This is not a student count, and it does not block or follow a promotion.";

/**
 * The pending figure with the right number: "1 pending course request" /
 * "N pending course requests". It counts REQUESTS, never students, so the label
 * must read correctly at 1 as well as at N. A non-number reads 0.
 */
export function pendingRequests(n: unknown): string {
  const count = typeof n === "number" && Number.isFinite(n) ? n : 0;
  return `${count} pending course ${count === 1 ? "request" : "requests"}`;
}

/* ----------------------------------------------------------------------------
 * The run-in-progress warning — the honest statement of the lease's limits.
 * -------------------------------------------------------------------------- */

/**
 * The ladder run modal's one-line warning.
 *
 * It must stay TRUTHFUL, and it changed in Phase 6-pre 2: until then there was no
 * run lock, so the line said so. Now the server refuses a second concurrent run of
 * the same programme (409), so the line states the guarantee instead of the hazard.
 * The verifier pins the current claim, so this string cannot drift back to a
 * statement the server no longer honours.
 */
export const LADDER_RUN_WARNING =
  "Run this one at a time: a second run of the same programme is refused while one is already in progress.";

/* ----------------------------------------------------------------------------
 * Failure phrasing — the human fallback for every load, in one place.
 * -------------------------------------------------------------------------- */

/** The fallback shown when a load fails without a usable server message. */
export const PAGE_ERRORS = {
  programs: "Could not load programmes",
  preview: "Could not load the preview",
  ladderPlan: "Could not build the ladder plan",
  apply: "The promotion could not be applied",
  ladderRun: "The ladder could not be run",
  // Phase 6-pre 5 — the two new failure phrasings (the empty-term strike-off and the
  // abandon hatch). Neither is a promotion, so neither may borrow the apply's wording.
  markFinished: "The term could not be marked finished",
  abandon: "The run could not be abandoned",
} as const;

/** The name a message falls back to when the programme row is not selected. */
export const UNNAMED_PROGRAM = "the programme";

/**
 * `error.message || fallback` — the page's own rule, kept identical: a falsy or
 * missing message reads as the fallback, anything else is used as it stands.
 */
export function messageOf(error: unknown, fallback: string): string {
  const message = (error as { message?: unknown } | null | undefined)?.message;
  return message ? String(message) : fallback;
}

/* ----------------------------------------------------------------------------
 * Disabled predicates and handler guards — one rule per button.
 * -------------------------------------------------------------------------- */

/**
 * The single-position apply button. A missing preview, an empty cohort, an
 * in-flight run and a loading preview all disable it — there is no state in which
 * it can be pressed against nothing.
 */
export function applyDisabled(input: {
  hasPreview: boolean;
  count: number;
  busy: boolean;
  previewLoading: boolean;
}): boolean {
  return !input.hasPreview || input.count === 0 || input.busy || input.previewLoading;
}

/**
 * The apply handler's early return: nothing to move, or a run already in flight.
 *
 * The handler checks `preview` for null ITSELF (a control-flow concern), so this
 * rule starts where the original did, after the null check: `busy || count === 0`.
 */
export function applyBlocked(input: { count: number; busy: boolean }): boolean {
  return input.busy || input.count === 0;
}

/**
 * The ladder run button AND its handler: disabled/refused while busy, when the plan
 * holds nobody, or when the server reports the programme BLOCKED (Phase 6-pre 3 —
 * the last run did not finish). The handler checks `ladderPlan` for null itself.
 *
 * Without `blocked` this is the same expression as `applyBlocked` by intent — both
 * mean "this run cannot go" — and the page verifier asserts the two agree so they
 * cannot drift. `blocked` is optional so that agreement stays checkable, and it is
 * only the ladder that can be blocked (the single-position route is the way OUT of a
 * blocked programme, so it is never locked by this).
 */
export function ladderRunDisabled(input: { count: number; busy: boolean; blocked?: boolean }): boolean {
  return input.busy || input.count === 0 || input.blocked === true;
}

/** "Preview full ladder" needs a programme and an idle page. */
export function previewLadderDisabled(input: { programId: string; busy: boolean }): boolean {
  return !input.programId || input.busy;
}

/** The run button's own label, so "Running…" can never disagree with `busy`. */
export function ladderRunButtonLabel(count: number, busy: boolean): string {
  return busy ? "Running…" : `Run the whole ladder (${count})`;
}

/** The apply button's label: graduating is its own verb, never a generic "apply". */
export function applyButtonLabel(graduating: boolean): string {
  return graduating ? "Graduate the cohort" : "Advance the cohort";
}

/* ----------------------------------------------------------------------------
 * The warnings a preview raises (D4/D5/D6).
 * -------------------------------------------------------------------------- */

/** D5 — the graduating banner appears exactly for a last-term (graduating) run. */
export function showGraduatingBanner(preview: { graduating?: unknown } | null | undefined): boolean {
  return !!preview && preview.graduating === true;
}

/** D4 — the classId banner appears when at least one cohort member also holds a classId. */
export function showClassIdBanner(
  preview: { counts?: { classIdWarnings?: unknown } } | null | undefined
): boolean {
  const warnings = preview?.counts?.classIdWarnings;
  return typeof warnings === "number" && warnings > 0;
}

/**
 * D5 — the "Destination: …" line is hidden on a graduating run, because a
 * graduating row has no destination term to name.
 */
export function showDestinationLine(preview: { graduating?: unknown } | null | undefined): boolean {
  return !!preview && preview.graduating !== true;
}

/** The D4 banner sentence, with the count the server reported. */
export function classIdBannerText(count: unknown): string {
  const n = typeof count === "number" && Number.isFinite(count) ? count : 0;
  return `${n} student(s) below are also enrolled in a school class — school promotion may advance this student too.`;
}

/** One cohort row's Notes cell: a D4 warning, the D6 request count, or a dash. */
export interface RowNote {
  /** D4 — this student also sits in a school class. */
  classIdWarning: boolean;
  /** D6 — "N pending course requests at this term", or null when there are none. */
  pendingText: string | null;
  /** The em dash, shown only when a row has neither a warning nor a request. */
  placeholder: boolean;
}

export function rowNote(row: {
  classIdWarning?: unknown;
  pendingRegistrationCount?: unknown;
}): RowNote {
  const classIdWarning = row.classIdWarning === true;
  const pending = row.pendingRegistrationCount;
  const hasPending = typeof pending === "number" && pending > 0;
  return {
    classIdWarning,
    pendingText: hasPending ? `${pendingRequests(pending)} at this term` : null,
    placeholder: !classIdWarning && pending === 0,
  };
}

/** One ladder step's footnote: the D4 warning (optional) and the D6 requests. */
export interface StepNote {
  /** `${n} also in a school class · `, or null when no row carries a classId. */
  classIdText: string | null;
  /** D6 — always present: the step's pending course requests. */
  pendingText: string;
}

export function stepNote(step: {
  counts?: { classIdWarnings?: unknown; pendingRegistrations?: unknown };
}): StepNote {
  const warnings = step?.counts?.classIdWarnings;
  const hasWarnings = typeof warnings === "number" && warnings > 0;
  return {
    classIdText: hasWarnings ? `${warnings} also in a school class · ` : null,
    pendingText: pendingRequests(step?.counts?.pendingRegistrations),
  };
}

/* ----------------------------------------------------------------------------
 * The confirmation summary — what the operator is told they are about to do.
 * -------------------------------------------------------------------------- */

/** The verb and destination the confirm dialog restates before the POST. */
export interface ConfirmSummary {
  verb: "graduate" | "advance";
  /** The destination term of an advance, or null when the run graduates. */
  toTermNumber: number | null;
  termCount: number;
  fromTermNumber: number;
}

export function confirmSummary(preview: {
  graduating?: unknown;
  fromTermNumber: number;
  termCount: number;
}): ConfirmSummary {
  const graduating = preview.graduating === true;
  return {
    verb: graduating ? "graduate" : "advance",
    toTermNumber: graduating ? null : preview.fromTermNumber + 1,
    termCount: preview.termCount,
    fromTermNumber: preview.fromTermNumber,
  };
}

/** The empty-cohort headline, which names the position the operator picked. */
export function emptyCohortTitle(preview: { fromTermNumber: number; termCount: number }): string {
  return `Nobody is at term ${preview.fromTermNumber} of ${preview.termCount}`;
}

/* ----------------------------------------------------------------------------
 * The server's own report, turned into the sentence the operator reads.
 * -------------------------------------------------------------------------- */

/**
 * The apply result. Graduating and advancing are different sentences with
 * different verbs and different counts (D5) — never one generic "done".
 *
 * "(s)" is deliberate and matches the shipped wording at every count.
 */
export function applyResultMessage(
  res: { graduating: boolean; graduated: number; promoted: number; toTermNumber: number | null },
  programName: string
): string {
  return res.graduating
    ? `Graduated ${res.graduated} student(s) as ALUMNI from ${programName}.`
    : `Promoted ${res.promoted} student(s) to Term ${res.toTermNumber} of ${programName}.`;
}

/** The whole-ladder success line. */
export function ladderRunMessage(
  res: { promoted: number; graduated: number },
  programName: string
): string {
  return `Ran the whole ladder for ${programName}: ${res.promoted} advanced, ${res.graduated} graduated.`;
}

/** The plan's own summary line: how many of the ladder's students graduate. */
export function ladderGraduateText(plan: { counts?: { graduate?: unknown } }): string {
  const n = typeof plan?.counts?.graduate === "number" ? plan.counts.graduate : 0;
  return `${n} will graduate`;
}

/* ----------------------------------------------------------------------------
 * The failure path — what is re-fetched, and how.
 * -------------------------------------------------------------------------- */

/**
 * After a PARTIAL/FAILED ladder run the screen must never keep showing pre-run
 * state, so BOTH the plan and the position preview are re-fetched. This is the
 * list, in the order the page issues them.
 */
export const LADDER_FAILURE_REFRESH = ["ladderPlan", "preview"] as const;

/**
 * The failure refresh is SILENT: it must not clear the error the run just set, or
 * the operator loses the server's structured report (D-5d2-5).
 */
export const LADDER_FAILURE_REFRESH_IS_SILENT = true;

/* ----------------------------------------------------------------------------
 * Phase 6-pre 3 — a ladder re-run the server REFUSES, and why.
 * -------------------------------------------------------------------------- */

/** The plan's run state, exactly as `GET /api/college-promotion/ladder` reports it
 *  (additive field, Phase 6-pre 3). Unknown-typed on purpose: the page must not
 *  crash on a response from a server that does not carry it yet. */
export interface PlanRunBlock {
  blocked?: unknown;
  status?: unknown;
  finishTerms?: unknown;
  remainingTerms?: unknown;
  stoppedAtTermNumber?: unknown;
  message?: unknown;
}

/**
 * Is the ladder refused because the LAST run for this programme did not finish?
 *
 * Strictly `=== true`: anything else (a missing field, a string, a stale server) is
 * "not blocked", so a plan without the field behaves exactly as before.
 */
export function ladderBlocked(plan: { runBlock?: PlanRunBlock } | null | undefined): boolean {
  return plan?.runBlock?.blocked === true;
}

/**
 * The terms the unfinished run still owes, DESCENDING (the failed term first) — the
 * order the single-position apply must finish them in. A missing or malformed list
 * reads as none, never as a guess.
 */
export function ladderBlockTerms(plan: { runBlock?: PlanRunBlock } | null | undefined): number[] {
  const terms = plan?.runBlock?.finishTerms;
  return Array.isArray(terms)
    ? terms.filter((t): t is number => typeof t === "number").sort((a, b) => b - a)
    : [];
}

/**
 * The note the run modal shows INSTEAD of letting the operator press Run and be
 * refused: why the ladder is blocked, and how to finish it.
 *
 * The SERVER's own sentence wins when it is present (it names the failed term and the
 * route that finishes it, so the screen and the refusal can never disagree), and the
 * fallback below — the module's wording, pinned by the verifier — makes an empty
 * explanation impossible. Returns null when nothing is blocked.
 */
export function ladderBlockNote(plan: { runBlock?: PlanRunBlock } | null | undefined): string | null {
  if (!ladderBlocked(plan)) return null;
  const message = plan?.runBlock?.message;
  if (typeof message === "string" && message) return message;
  const status = typeof plan?.runBlock?.status === "string" ? plan.runBlock.status : "PARTIAL";
  const terms = ladderBlockTerms(plan)
    .map((t) => `term ${t}`)
    .join(", then ");
  return `The last ladder run for this programme did not finish (${status}). Finish it with the single-position apply, descending: ${terms || "the remaining terms"}.`;
}

/* ----------------------------------------------------------------------------
 * Phase 6-pre 5 — an OUTSTANDING term with an EMPTY cohort, and the abandon hatch.
 * -------------------------------------------------------------------------- */

/**
 * May the operator mark the previewed term finished WITHOUT promoting anybody?
 *
 * Only when a work list still names this term (it is OUTSTANDING) and the cohort here
 * is EMPTY: there is nobody to move, so the only way the term can ever leave the list
 * is this explicit press. The single-position route does the actual strike-off — the
 * page sends the same position it would otherwise apply, so nothing new is invented on
 * the client and no student can be moved by a path the server does not already police.
 *
 * A term that is NOT outstanding keeps the ordinary rule: an empty cohort disables the
 * apply button and there is simply nothing to do (`applyDisabled` is NOT relaxed here —
 * this predicate gates a different button).
 */
export function markFinishedEligible(input: {
  hasPreview: boolean;
  count: number;
  busy: boolean;
  previewLoading: boolean;
  fromTermNumber: number;
  outstandingTerms: number[];
}): boolean {
  return (
    input.hasPreview &&
    input.count === 0 &&
    !input.busy &&
    !input.previewLoading &&
    input.outstandingTerms.includes(input.fromTermNumber)
  );
}

/** The button's label — the term is named, so it cannot be pressed by accident. */
export function markFinishedButtonLabel(term: number): string {
  return `Mark term ${term} finished`;
}

/**
 * What that button says it does. It must be plainly true: nobody is promoted, because
 * the term has no students, and the press only records that the term is DONE.
 */
export function markFinishedTitle(term: number, termCount: number): string {
  return `Nobody is at term ${term} of ${termCount}, so nobody is promoted`;
}

/** The explanation under that title, with the honest consequence. */
export function markFinishedNote(): string {
  return "This term is still outstanding on the ladder's work list, and there is nobody here to move. Marking it finished strikes it off that list and advances nobody.";
}

/** The confirmation line after the press, naming the programme and the term. */
export function markFinishedMessage(term: number, programName: string): string {
  return `Marked term ${term} finished for ${programName} — nobody was promoted, because that term has no students.`;
}

/**
 * The abandon confirmation. It is DELIBERATELY blunt, and every sentence is a fact of
 * the server's behaviour (§22): the hatch advances nobody, does not undo the terms that
 * already ran, and a later ladder run WILL advance those steps again — which is why
 * finishing the outstanding terms is named first as the better option.
 */
export const ABANDON_WARNING =
  "Abandoning this run advances nobody and does NOT undo the terms that already ran. A later ladder run will advance those steps again. Prefer finishing the outstanding terms.";

/** The reason length the SERVER enforces; the page only uses it to disable early. */
export const ABANDON_REASON_MIN = 10;

/**
 * Phase 6-pre 6 — WHO may abandon. The hatch is an ADMIN act: a REGISTRAR may run the
 * ladder, apply a position and mark an empty outstanding term finished, but giving up on
 * a run — which leaves work permanently undone — is restricted to the school's
 * administrators. `SUPER_ADMIN` is listed because `can()` grants it every module by its
 * own short-circuit, so the behaviour is unchanged for that role.
 *
 * This list is the ONE source of truth for BOTH surfaces: the ladder route imports
 * `canAbandon` and refuses with 403, and the page uses it to hide the control, so the
 * screen and the refusal cannot drift apart. `scripts/verify-college-promotion-page.mjs`
 * pins the predicate and that both the page AND the route use it.
 */
export const ABANDON_ROLES = ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN"] as const;

/**
 * May this role abandon a programme's unfinished run? Strictly a member of
 * `ABANDON_ROLES`: anything else — a REGISTRAR, an ACCOUNTANT, a TEACHER, a GUARDIAN, a
 * STUDENT, a missing/`null`/non-string role — may not.
 */
export function canAbandon(role: unknown): boolean {
  return typeof role === "string" && (ABANDON_ROLES as readonly string[]).includes(role);
}

/** The abandon button: only while a run is BLOCKED, and never while a request is out. */
export function abandonDisabled(input: {
  blocked: boolean;
  busy: boolean;
  reasonLength: number;
}): boolean {
  return !input.blocked || input.busy || input.reasonLength < ABANDON_REASON_MIN;
}

/** The abandon headline: what the operator is about to do, in one sentence. */
export function abandonSummary(programName: string, terms: number[]): string {
  const list = terms.length ? terms.map((t) => `term ${t}`).join(", then ") : "the remaining terms";
  return `Abandon this programme's unfinished run for ${programName}? It still owes ${list}.`;
}

/** The line shown after a successful abandon. */
export function abandonMessage(programName: string): string {
  return `Abandoned the unfinished run for ${programName}. Nobody was moved, and the ladder is usable again — a later run will advance the terms that never ran.`;
}
