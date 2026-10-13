#!/usr/bin/env node
/**
 * verify-college-fees-page.mjs — Phase 7d: the college fee SCREENS, the shared
 * ledger's college tag and the college success screen, proved OFFLINE
 * (docs/COLLEGE-DECISIONS.md §24, D-7-12/D-7-16/D-7-18, Q3 + the owner's answers
 * of 2026-10-11).
 *
 * `src/lib/college-fees-view.ts` holds every NON-JSX decision the 7d pages make:
 * the ONE money formatter over integer minor units, the typed-money reader, the
 * D-7-18 write-control map, the page-state gate, the shared ledger's college tag
 * and its split totals, and the wizard success screen's per-half lines. This
 * script pins that module — and the fact that all three pages USE it instead of
 * re-inlining a rule — with no database, no server and no network, so it carries
 * **no `requireEmulator()` guard** and runs on plain `node`, the same design as
 * `verify-college-results-page.mjs` and `verify-college-promotion-page.mjs`.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT — read this before trusting it:
 *
 *   ✅ PROVES: the money helper's exact output for zero, one paisa, odd amounts,
 *      a huge amount and junk (never a fake ৳0.00); that every amount the pages
 *      carry is read into whole paisa before any arithmetic; the double-submit
 *      rule (a busy form is disabled) and that the over-payment case is left to
 *      the SERVER's own refusal; the role truth table (admin + ACCOUNTANT write,
 *      REGISTRAR read-only, TEACHER/GUARDIAN/STUDENT refused) and that the page
 *      renders each write control only through that one map; the ledger tag and
 *      the rule that no total adds school and college money together; the college
 *      nav entry and its group; the success screen's per-half lines; and —
 *      statically — that the pages call only `/api/college-fees/*` routes that
 *      already exist.
 *
 *   ❌ DOES NOT PROVE THAT A PAGE RENDERS. There is no DOM here, no React, no
 *      browser and no server: nothing mounts a page, clicks a button, signs in or
 *      performs an API round trip. A REAL BROWSER PASS is a separate, recorded
 *      step (the screenshots in `proof/7d/`). Treat a green run here as "the
 *      pages' non-visual logic is right", never as "the pages work".
 *
 *   node scripts/verify-college-fees-page.mjs
 */

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

/*
 * The app is compiled with bundler-style resolution, so its modules import each
 * other without file extensions. Node's own ESM resolver requires the extension,
 * so this local, synchronous hook retries a failed relative specifier with `.ts`
 * appended — the same approach as the sibling offline verifiers, scoped to this
 * process. Nothing is installed and no loader flag is needed.
 */
registerHooks({
  resolve(specifier, context, nextResolve) {
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      if (error?.code === "ERR_MODULE_NOT_FOUND" && relative) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const VIEW_URL = new URL("../src/lib/college-fees-view.ts", import.meta.url);
const PAGE_URL = new URL("../src/app/dashboard/college-fees/page.tsx", import.meta.url);
const LEDGER_URL = new URL("../src/app/dashboard/ledger/page.tsx", import.meta.url);
const ONBOARDING_URL = new URL("../src/app/onboarding/page.tsx", import.meta.url);
const NAV_URL = new URL("../src/components/nav.ts", import.meta.url);
const STRUCTURE_ROUTE_URL = new URL("../src/app/api/college-fees/structure/route.ts", import.meta.url);
const PAYMENTS_ROUTE_URL = new URL("../src/app/api/college-fees/payments/route.ts", import.meta.url);
const GENERATE_ROUTE_URL = new URL("../src/app/api/college-fees/generate/route.ts", import.meta.url);
const ACCESS_URL = new URL("../src/lib/college-fees-access.ts", import.meta.url);
const FEES_LIB_URL = new URL("../src/lib/college-fees.ts", import.meta.url);
const STATEMENT_PAGE_URL = new URL("../src/app/print/college-fee-statement/[studentId]/page.tsx", import.meta.url);
const RECEIPT_PAGE_URL = new URL("../src/app/print/college-fee-receipt/[chargeId]/page.tsx", import.meta.url);

const viewSource = readFileSync(VIEW_URL, "utf8");
const pageSource = readFileSync(PAGE_URL, "utf8");
const ledgerSource = readFileSync(LEDGER_URL, "utf8");
const onboardingSource = readFileSync(ONBOARDING_URL, "utf8");
const navSource = readFileSync(NAV_URL, "utf8");
const structureRouteSource = readFileSync(STRUCTURE_ROUTE_URL, "utf8");
const paymentsRouteSource = readFileSync(PAYMENTS_ROUTE_URL, "utf8");
const generateRouteSource = readFileSync(GENERATE_ROUTE_URL, "utf8");
const accessSource = readFileSync(ACCESS_URL, "utf8");
const feesLibSource = readFileSync(FEES_LIB_URL, "utf8");
// The two D-7-17 print pages. Guarded by existsSync where they are asserted, so a
// missing route reports as a failed CHECK rather than crashing this verifier.
const statementSource = existsSync(STATEMENT_PAGE_URL) ? readFileSync(STATEMENT_PAGE_URL, "utf8") : "";
const receiptSource = existsSync(RECEIPT_PAGE_URL) ? readFileSync(RECEIPT_PAGE_URL, "utf8") : "";

const view = await import(VIEW_URL.href);
const access = await import(ACCESS_URL.href);
const seed = await import(new URL("../src/lib/onboarding-seed.ts", import.meta.url).href);
const nav = await import(NAV_URL.href);
// The API's OWN dues arithmetic (`collegeDues`), so the 7d-fix checks feed the
// page helper the payload the SERVER really serves — never a hand-made fixture.
const feesLib = await import(FEES_LIB_URL.href);
const {
  CURRENCY_SYMBOLS,
  COLLEGE_FEE_TABS,
  COLLEGE_FEES_HREF,
  COLLEGE_LEDGER_BADGE,
  LEDGER_MODE_OPTIONS,
  MONEY_UNKNOWN,
  PAGE_ERRORS,
  apiRefusal,
  awardButtonLabel,
  awardDecidable,
  awardProposeBlocked,
  basisLabel,
  bucketLabel,
  channelKindLabel,
  channelLine,
  collegeFeeReceiptHref,
  collegeFeeStatementHref,
  collegeFeesPageState,
  collegeLedgerAmountText,
  collegeLedgerNote,
  chargeSettlementText,
  isCollegePaymentEntryFor,
  paymentReceiptNo,
  pickReceiptEntry,
  statementScopeText,
  statementTermValue,
  statementTerms,
  structureEffectiveAt,
  structureRateText,
  configBlocked,
  countText,
  currencyOf,
  decideButtonLabel,
  duesScopeText,
  duesScopeTotals,
  dueMinorOf,
  dueStatusText,
  filterLedgerEntries,
  formatMinor,
  formatMoney,
  frequencyLabel,
  generateBlocked,
  generationSummaryText,
  hasCollegeMoney,
  headBlocked,
  headStateText,
  isCollegeLedgerEntry,
  ledgerEntryMode,
  ledgerTotals,
  majorFromTyped,
  minorUnits,
  payBlocked,
  payButtonLabel,
  payDisabled,
  paymentDoneText,
  programmeOptions,
  readMoneyField,
  readOnlyNote,
  refusalText,
  rowsForTerm,
  saveButtonLabel,
  structureBlocked,
  structureRowsText,
  structureTotalsText,
  sumMinor,
  tabFor,
  termTotalText,
  unitLabel,
  writeControlsFor,
} = view;

/**
 * Blank out comments and string literals, PRESERVING LENGTH, so a token search
 * runs against code only — every file here documents itself in prose, and the
 * words "import", "/api/college-fees" and "class(es)" all appear in comments.
 */
function maskCommentsAndStrings(text) {
  const out = text.split("");
  const blank = (i) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") blank(i++);
      continue;
    }
    if (ch === "/" && next === "*") {
      blank(i++);
      blank(i++);
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      blank(i++);
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") blank(i++);
        blank(i++);
      }
      blank(i++);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

/**
 * Blank out COMMENTS only (string literals kept), PRESERVING LENGTH — for the
 * "must not hard-code this literal" checks, where a real hard-coded value lives
 * in a string literal and the file's prose must not trip the search.
 */
function stripComments(text) {
  const out = text.split("");
  const blank = (i) => {
    if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = null;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") blank(i++);
      continue;
    }
    if (ch === "/" && next === "*") {
      blank(i++);
      blank(i++);
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) blank(i++);
      blank(i++);
      blank(i++);
      continue;
    }
    i += 1;
  }
  return out.join("");
}

// The view module and the two ROUTES are plain TS (no JSX), so masking comments
// AND string literals is safe there. The PAGE files are JSX and carry apostrophes
// in normal text ("A row's term…"), which a quote-blind masking pass would treat
// as an unterminated string and swallow the rest of the file — so the pages are
// masked for COMMENTS only, and their negative checks name tokens that appear in
// no string literal.
const viewCode = maskCommentsAndStrings(viewSource);
const pageCode = stripComments(pageSource);
const ledgerCode = stripComments(ledgerSource);
const pageNoComments = stripComments(pageSource);
const onboardingNoComments = stripComments(onboardingSource);
// The print pages are JSX too, so they get the same COMMENTS-only mask (their
// prose contains apostrophes; only tokens that appear in no string literal are
// asserted negatively).
const statementCode = stripComments(statementSource);
const receiptCode = stripComments(receiptSource);

let failures = 0;
let checks = 0;
const check = (label, ok, detail = "") => {
  checks += 1;
  console.log(`${ok ? "  PASS" : " FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures += 1;
};
const eq = (label, got, want) => check(label, got === want, `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

/** The source text of a call's argument list, brace-balanced. */
function callArgs(text, callOpen) {
  let depth = 0;
  for (let i = callOpen; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return text.slice(callOpen + 1, i);
    }
  }
  return "";
}

console.log("=== college fees page layer (offline) ===");

/* ------------------------------------------------------------------ 1. purity */

console.log("\n1. the view module is import-clean, and all three pages use it");
{
  // The specifiers are STRING literals, so this reads the raw source (the masked
  // code has them blanked by design).
  const imports = [...viewSource.matchAll(/\bimport\s+[^;]*?from\s+("[^"]*"|'[^']*')/g)].map((m) => m[1].replace(/["']/g, ""));
  check(
    "college-fees-view.ts imports only the three pure modules",
    JSON.stringify([...imports].sort()) === JSON.stringify(["./college-fees", "./college-fees-access", "./institution"]),
    imports.join(", ")
  );
  check("it declares no require()", !/\brequire\s*\(/.test(viewCode));
  check("it pulls in no prisma / node: / next/server / react", !/prisma|node:|next\/server|react/.test(viewCode));
  // The import specifier and the "must not contain" literals live in STRING
  // literals, which maskCommentsAndStrings blanks — so these read RAW source.
  check("the college fee page imports the view module", /@\/lib\/college-fees-view/.test(pageSource));
  check("the shared ledger page imports the view module", /@\/lib\/college-fees-view/.test(ledgerSource));
  check("the view module consumes the ONE access rule", /from "\.\/college-fees-access"/.test(viewSource));
  check("the access module itself stays import-free", !/\bimport\b|\brequire\s*\(/.test(maskCommentsAndStrings(accessSource)));
  check("the view module builds on 7a's money module", /from "\.\/college-fees"/.test(viewSource));
  check("no page talks to Firestore or fetch() directly", !/firebase|getFirestore|\bfetch\s*\(/.test(pageCode + ledgerCode));
}

/* ------------------------------------------------------- 2. the money helper */

console.log("\n2. ONE money helper: integer minor units in, grouped money out");
{
  eq("zero", formatMinor(0), "৳0.00");
  eq("one paisa", formatMinor(1), "৳0.01");
  eq("ten paisa", formatMinor(10), "৳0.10");
  eq("99 paisa", formatMinor(99), "৳0.99");
  eq("one taka", formatMinor(100), "৳1.00");
  eq("odd amount 1,234.56", formatMinor(123456), "৳1,234.56");
  eq("grouping at 10 lakh", formatMinor(100000000), "৳1,000,000.00");
  eq("huge amount", formatMinor(123456789012345), "৳1,234,567,890,123.45");
  eq("the largest safe integer still prints", formatMinor(Number.MAX_SAFE_INTEGER), "৳90,071,992,547,409.91");
  eq("negative money keeps its sign", formatMinor(-1), "-৳0.01");
  eq("null is not a zero", formatMinor(null), MONEY_UNKNOWN);
  eq("undefined is not a zero", formatMinor(undefined), MONEY_UNKNOWN);
  eq("a non-numeric string is not a zero", formatMinor("abc"), MONEY_UNKNOWN);
  eq("NaN is not a zero", formatMinor(Number.NaN), MONEY_UNKNOWN);
  eq("Infinity is not a zero", formatMinor(Number.POSITIVE_INFINITY), MONEY_UNKNOWN);
  eq("an object is not a zero", formatMinor({ n: 1 }), MONEY_UNKNOWN);
  eq("the unknown marker is a dash", MONEY_UNKNOWN, "—");
  // formatMoney is the same rule over the API's MAJOR-unit numbers.
  eq("1,500 major units", formatMoney(1500), "৳1,500.00");
  eq("a padded string", formatMoney("1,200.5"), "৳1,200.50");
  eq("junk stays unknown", formatMoney("n/a"), MONEY_UNKNOWN);
  eq("a non-BDT label uses its own glyph", formatMinor(123456, "USD"), "$1,234.56");
  eq("an unknown currency falls back to the code", formatMinor(123456, "SEK"), "SEK 1,234.56");
  check("BDT is the taka glyph", CURRENCY_SYMBOLS.BDT === "৳");
  // The formatter is the only place money becomes text: no float formatting call.
  check("the module uses no toFixed/toLocaleString", !/toFixed|toLocaleString/.test(viewCode));
  check("minorUnits refuses junk rather than zeroing it", minorUnits("x") === null && minorUnits(null) === null);
}

/* --------------------------------------------- 3. money arithmetic (integer) */

console.log("\n3. every amount is carried as whole paisa before any arithmetic");
{
  eq("sumMinor over junk (already-minor inputs)", sumMinor([123456, 1000, null, "x", undefined]), 124456);
  eq("minorValue reads a padded minor string", view.minorValue("1,000"), 1000);
  eq("minorValue refuses junk", view.minorValue("x"), null);
  eq("an absent amount contributes nothing", minorUnits(undefined), null);
  const rows = [
    { amount: 1000.5, paidAmount: 0.5, discount: 0.25 },
    { amount: 500, paidAmount: 200 },
    { amount: null, paidAmount: "x" },
  ];
  const totals = view.chargeTotals(rows);
  eq("billed total", totals.billedMinor, 150050);
  eq("paid total", totals.paidMinor, 20050);
  eq("discount total", totals.discountMinor, 25);
  eq("due total (amount − paid, per row, never negative)", totals.dueMinor, 130000);
  eq("row count", totals.count, 3);
  eq("dueMinorOf clamps an over-paid row", dueMinorOf({ amount: 10, paidAmount: 25 }), 0);
  eq("an empty charge set is zero, not NaN", view.chargeTotals([]).dueMinor, 0);
  check("the term total prints all three figures", /billed/.test(termTotalText(rows)) && /paid/.test(termTotalText(rows)) && /due/.test(termTotalText(rows)));
  eq("a typed amount becomes paisa", readMoneyField("1500.50").minor, 150050);
  eq("the formatter never converts twice", formatMoney(1500), formatMinor(150000));
  eq("a grouped amount is accepted", readMoneyField("1,500").minor, 150000);
  eq("a trailing dot is accepted", readMoneyField("1500.").minor, 150000);
  eq("three decimals are refused", readMoneyField("1500.505").ok, false);
  eq("an empty field is refused", readMoneyField("").ok, false);
  eq("zero is refused", readMoneyField("0").ok, false);
  eq("a negative amount is refused", readMoneyField("-5").ok, false);
  eq("letters are refused", readMoneyField("1o0").ok, false);
  eq("majorFromTyped round-trips through paisa", majorFromTyped("4500.75"), 4500.75);
  eq("majorFromTyped refuses junk", majorFromTyped("x"), null);
  check("the refusal for too many decimals says so", /two decimals/.test(readMoneyField("1.234").error || ""));
}

/* --------------------------------------------------- 4. forms and double-submit */

console.log("\n4. money forms: disabled while in flight, refusals left to the server");
{
  const ready = { chargeId: "cf_1", amount: "1500", method: "CASH" };
  eq("a complete form is enabled", payDisabled(ready), false);
  eq("a busy form is disabled", payDisabled({ ...ready, busy: true }), true);
  eq("a form with no charge is disabled", payDisabled({ ...ready, chargeId: "" }), true);
  eq("a form with no method is disabled", payDisabled({ ...ready, method: "" }), true);
  eq("a form with an unreadable amount is disabled", payDisabled({ ...ready, amount: "abc" }), true);
  // An over-payment must NOT be blocked here: the SERVER's 409 is the answer, shown verbatim.
  eq("an amount above the due is still submittable", payDisabled({ ...ready, amount: "999999" }), false);
  eq("the handler shares the button's rule", payBlocked({ ...ready, busy: true }), payDisabled({ ...ready, busy: true }));
  eq("the busy label differs from the idle one", payButtonLabel(true) !== payButtonLabel(false), true);
  eq("payment refused: structure form", structureBlocked({ programId: "p", headId: "h", amount: "100", termNumber: "1" }), false);
  eq("structure form needs a programme", structureBlocked({ programId: "", headId: "h", amount: "100", termNumber: "1" }), true);
  eq("structure form needs a head", structureBlocked({ programId: "p", headId: "", amount: "100", termNumber: "1" }), true);
  eq("structure form needs a whole term", structureBlocked({ programId: "p", headId: "h", amount: "100", termNumber: "0" }), true);
  eq("structure form needs a positive amount", structureBlocked({ programId: "p", headId: "h", amount: "0", termNumber: "1" }), true);
  eq("generation needs a programme", generateBlocked({ programId: "", termNumber: "1" }), true);
  eq("generation is disabled while busy", generateBlocked({ programId: "p", termNumber: "1", busy: true }), true);
  eq("a head needs a name", headBlocked({ name: "  " }), true);
  eq("a head form is enabled with a name", headBlocked({ name: "Tuition" }), false);
  eq("the config form is disabled only while busy", configBlocked({ busy: true }) === true && configBlocked({}) === false, true);
  eq("a PERCENT award in range is submittable", awardProposeBlocked({ kind: "PERCENT", percent: "50" }), false);
  eq("a PERCENT award over 100 is refused", awardProposeBlocked({ kind: "PERCENT", percent: "101" }), true);
  eq("a FIXED award needs at least one head", awardProposeBlocked({ kind: "FIXED", amountPerHead: "500", headIds: [] }), true);
  eq("a FIXED award with a head and an amount is submittable", awardProposeBlocked({ kind: "FIXED", amountPerHead: "500", headIds: ["h1"] }), false);
  eq("labels read as busy", saveButtonLabel(true) !== saveButtonLabel(false) && awardButtonLabel(true) !== awardButtonLabel(false), true);
  eq("decide labels differ by state and busy", decideButtonLabel(false, "APPROVED") !== decideButtonLabel(true, "APPROVED"), true);
  const receipt = paymentDoneText({ receiptNo: "CRCP-1", applied: 1500.5, due: 50.25, status: "PARTIAL" });
  check(
    "a payment receipt line prints the receipt, what was applied and what is left",
    /CRCP-1/.test(receipt) && /৳1,500.50/.test(receipt) && /৳50.25/.test(receipt) && /partly paid/.test(receipt),
    receipt
  );
}

/* ----------------------------------------------------- 5. the role truth table */

console.log("\n5. D-7-18 at the page layer: who may write, who may only read, who is refused");
{
  const WRITE = ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN", "ACCOUNTANT"];
  const READ_ONLY = ["REGISTRAR"];
  const DENIED = ["TEACHER", "GUARDIAN", "STUDENT", "LIBRARIAN", "FRONT_DESK"];
  const ids = ["heads", "structure", "generate", "pay", "awardPropose", "awardDecide", "config"];

  let problem = null;
  for (const role of WRITE) {
    const controls = writeControlsFor(role);
    for (const id of ids) {
      // The ACCOUNTANT may propose but never approve (admin-level decides, D-7-13).
      const want = id === "awardDecide" ? role !== "ACCOUNTANT" : true;
      if (controls[id] !== want) problem = `${role}.${id}=${controls[id]}, want ${want}`;
    }
  }
  for (const role of [...READ_ONLY, ...DENIED]) {
    const controls = writeControlsFor(role);
    for (const id of ids) if (controls[id] !== false) problem = `${role}.${id} must be false`;
  }
  for (const raw of [undefined, null, "", "REGISTRAR ", "accountant", 0, {}, []]) {
    const controls = writeControlsFor(raw);
    for (const id of ids) if (controls[id] === true) problem = `${JSON.stringify(raw)}.${id} allowed`;
  }
  check(`the write-control map: ${WRITE.length} writers (ACCOUNTANT never decides), ${READ_ONLY.length} read-only, ${DENIED.length + 8} refused`, problem === null, problem || "exact");

  eq("SUPER_ADMIN holding every write control", Object.values(writeControlsFor("SUPER_ADMIN")).every(Boolean), true);
  eq("the ACCOUNTANT may propose", writeControlsFor("ACCOUNTANT").awardPropose, true);
  eq("the ACCOUNTANT may not decide", writeControlsFor("ACCOUNTANT").awardDecide, false);
  eq("the REGISTRAR sees no write control at all", Object.values(writeControlsFor("REGISTRAR")).every((v) => v === false), true);
  eq("a TEACHER sees no write control at all", Object.values(writeControlsFor("TEACHER")).every((v) => v === false), true);

  // The page-state gate: a school tenant and a refused role both stop BEFORE a read.
  eq("no session yet → loading", collegeFeesPageState({}), "loading");
  eq("a session that failed with nothing cached → error", collegeFeesPageState({ resolved: false, meError: "x" }), "error");
  eq("a failed refresh of a LIVE session still renders", collegeFeesPageState({ resolved: true, meError: "x", institutionType: "COLLEGE", role: "SCHOOL_ADMIN" }), "ready");
  eq("a college tenant + a writer → ready", collegeFeesPageState({ resolved: true, institutionType: "COLLEGE", role: "SCHOOL_ADMIN" }), "ready");
  eq("a BOTH tenant + the registrar → ready", collegeFeesPageState({ resolved: true, institutionType: "BOTH", role: "REGISTRAR" }), "ready");
  eq("a SCHOOL tenant → no-college", collegeFeesPageState({ resolved: true, institutionType: "SCHOOL", role: "SCHOOL_ADMIN" }), "no-college");
  eq("an absent shape → no-college", collegeFeesPageState({ resolved: true, institutionType: null, role: "SCHOOL_ADMIN" }), "no-college");
  eq("an unknown shape → no-college", collegeFeesPageState({ resolved: true, institutionType: "PRIMARY", role: "SCHOOL_ADMIN" }), "no-college");
  eq("a TEACHER on a college tenant → refused", collegeFeesPageState({ resolved: true, institutionType: "COLLEGE", role: "TEACHER" }), "refused");
  eq("a GUARDIAN on a BOTH tenant → refused", collegeFeesPageState({ resolved: true, institutionType: "BOTH", role: "GUARDIAN" }), "refused");
  eq("a STUDENT on a college tenant → refused", collegeFeesPageState({ resolved: true, institutionType: "COLLEGE", role: "STUDENT" }), "refused");
  eq("loading wins over a missing shape", collegeFeesPageState({ meLoading: true }), "loading");
  eq("the page's read gate is the access rule", view.pageCanRead("REGISTRAR") === access.canReadCollegeFees("REGISTRAR"), true);
  eq("the page's write gate is the access rule", view.pageCanWrite("ACCOUNTANT") === access.canWriteCollegeFees("ACCOUNTANT"), true);
  // The award decider is per ROW: admin-level, never the proposer.
  const proposed = { status: "PROPOSED", proposedBy: "u1" };
  eq("the proposer cannot decide their own award", awardDecidable(proposed, "SCHOOL_ADMIN", "u1"), false);
  eq("another admin can decide it", awardDecidable(proposed, "SCHOOL_ADMIN", "u2"), true);
  eq("a decided award cannot be re-decided", awardDecidable({ status: "APPROVED", proposedBy: "u1" }, "SCHOOL_ADMIN", "u2"), false);
  eq("the ACCOUNTANT cannot decide any award", awardDecidable(proposed, "ACCOUNTANT", "u2"), false);
}

/* ------------------------------------- 6. the page renders from those decisions */

console.log("\n6. the page asks the module, and never hard-codes a control or a format");
{
  check("the page uses the page-state gate", /collegeFeesPageState\(/.test(pageCode));
  check("the page uses the write-control map", /writeControlsFor\(/.test(pageCode));
  check("the page gates the pay form on busy", /payDisabled\(\{/.test(pageCode));
  const controlIds = ["heads", "structure", "generate", "pay", "awardPropose", "awardDecide", "config"];
  const unguarded = controlIds.filter((id) => !new RegExp(`controls\\.${id}\\s*(&&|\\?)`).test(pageCode));
  check(`${controlIds.length} write controls are each guarded by a controls.<id> decision`, unguarded.length === 0, unguarded.join(", ") || "all guarded");
  const payCall = pageCode.indexOf("payDisabled({");
  check("the pay button's disabled expression passes `busy`", payCall > 0 && /\bbusy\b/.test(callArgs(pageCode, pageCode.indexOf("(", payCall))));
  const payBody = callArgs(pageCode, pageCode.indexOf("payBlocked({") + "payBlocked".length);
  check("the handler re-checks the same rule", /\bbusy\b/.test(payBody));
  check("the page does not use the school money formatter", !/fmtMoney\s*\(/.test(pageCode));
  check("the page does not format money by hand", !/toFixed|toLocaleString|\/\s*100\b|\*\s*100\b/.test(pageCode));
  check("money is printed by the one helper", /formatMoney\(/.test(pageCode) && /formatMinor\(/.test(pageCode));
  check("the payment carries integer minor units", /amountMinor/.test(pageCode) && !/body:\s*JSON\.stringify\(\{\s*chargeId,[^}]*\bamount:/.test(pageCode));
  // The generate POST names a programme, a term and a due date — never an amount:
  // the money comes from the admin's own structure rows (D-7-10).
  const genIdx = pageCode.indexOf("/api/college-fees/generate");
  const genCall = genIdx > 0 ? pageCode.slice(Math.max(0, genIdx - 400), genIdx) : "";
  check("no charge amount is ever typed for generation", genIdx > 0 && !/\bamount\b\s*:/.test(genCall), genCall.match(/amount\s*:/) ? "an amount key was found" : "none");
  check("the page re-states no role list", !/"REGISTRAR"|'REGISTRAR'/.test(pageNoComments.replace(/readOnlyNote|College Fees/g, "")));
  check("the page reads only the 7c fee API", [...pageNoComments.matchAll(/["'`](\/api\/[a-z0-9\-/]*)/g)].every((m) => m[1].startsWith("/api/college-fees/")));
  const segments = [...new Set([...pageNoComments.matchAll(/["'`]\/api\/college-fees\/([a-z\-]+)/g)].map((m) => m[1]))];
  const onDisk = readdirSync(fileURLToPath(new URL("../src/app/api/college-fees/", import.meta.url)))
    .filter((name) => existsSync(new URL(`../src/app/api/college-fees/${name}/route.ts`, import.meta.url)));
  const missing = segments.filter((s) => !onDisk.includes(s));
  check(`${segments.length} fee segments used, every one an existing route`, missing.length === 0, missing.join(", ") || segments.join(", "));
  check("the tabs are the four screens of D-7-16", COLLEGE_FEE_TABS.length === 4, COLLEGE_FEE_TABS.map((t) => t.key).join(", "));
  eq("an unknown tab falls back to the first", tabFor("nope"), "heads");
  eq("a known tab is honoured", tabFor("dues"), "dues");
  eq("the nav href is the one route", COLLEGE_FEES_HREF, "/dashboard/college-fees");
}

/* --------------------------------------------- 7. the shared ledger's college tag */

console.log("\n7. the shared ledger: college money is TAGGED, and the two halves' totals never mix");
{
  const schoolPayment = { kind: "PAYMENT", status: "CONFIRMED", method: "CASH", amount: 1234.56, feeId: "f1" };
  const collegePayment = { kind: "PAYMENT", status: "CONFIRMED", method: "BKASH", amount: 500.25, feeId: null, meta: { collegeFeeId: "cf1", programId: "p" } };
  const schoolDiscount = { kind: "DISCOUNT", status: "CONFIRMED", amount: 100, feeId: "f2" };
  const collegeWaiver = { kind: "DISCOUNT", status: "CONFIRMED", amount: 25.5, feeId: null, meta: { collegeDiscountId: "cd1" } };
  const schoolLateFee = { kind: "LATE_FEE", status: "CONFIRMED", amount: 50, feeId: "f3" };
  const pending = { kind: "PAYMENT", status: "PENDING", amount: 999, feeId: "f4" };

  eq("a college payment is tagged", isCollegeLedgerEntry(collegePayment), true);
  eq("a college waiver is tagged", isCollegeLedgerEntry(collegeWaiver), true);
  eq("a school payment is not", isCollegeLedgerEntry(schoolPayment), false);
  eq("an untagged null feeId is not college money", isCollegeLedgerEntry({ feeId: null, amount: 1 }), false);
  eq("junk is not college money", isCollegeLedgerEntry(null) === false && isCollegeLedgerEntry("x") === false, true);
  eq("the mode of a college row", ledgerEntryMode(collegePayment), "COLLEGE");
  eq("the mode of a school row", ledgerEntryMode(schoolPayment), "SCHOOL");
  eq("the badge word", COLLEGE_LEDGER_BADGE, "College");

  const entries = [schoolPayment, collegePayment, schoolDiscount, collegeWaiver, schoolLateFee, pending];
  eq("no filter keeps every row", filterLedgerEntries(entries, "").length, 6);
  eq("the college filter isolates the tagged rows", filterLedgerEntries(entries, "COLLEGE").length, 2);
  eq("the school filter keeps the rest", filterLedgerEntries(entries, "SCHOOL").length, 4);
  eq("an unknown filter is no filter", filterLedgerEntries(entries, "MIXED").length, 6);
  eq("college money is detected", hasCollegeMoney(entries), true);
  eq("a purely school ledger has none", hasCollegeMoney([schoolPayment]), false);

  const split = ledgerTotals(entries);
  eq("school collected excludes college money", split.school.collectedMinor, 123456);
  eq("school discounts", split.school.discountsMinor, 10000);
  eq("school late fees", split.school.lateFeesMinor, 5000);
  eq("school rows counted (including the pending one)", split.school.entries, 4);
  eq("school by-method", split.school.byMethodMinor.CASH, 123456);
  eq("college collected", split.college.collectedMinor, 50025);
  eq("college waivers", split.college.discountsMinor, 2550);
  eq("college rows counted", split.college.entries, 2);
  eq("college by-method", split.college.byMethodMinor.BKASH, 50025);
  eq("a pending row is not collected", split.school.collectedMinor + split.college.collectedMinor, 173481);
  check(
    "there is no combined total to print",
    JSON.stringify(Object.keys(split)) === JSON.stringify(["school", "college"]) &&
      !("total" in split) &&
      !("total" in split.school) &&
      !("total" in split.college)
  );
  eq("a college row prints with paisa", collegeLedgerAmountText(collegePayment), "৳500.25");
  eq("a school row is left to the school formatter", collegeLedgerAmountText(schoolPayment), null);
  check("the note explains the badge", /College badge/.test(collegeLedgerNote()));
  // 7d-fix: the note is printed right after the `College` badge, so it must not
  // start with that same word — the DOM read "College College fee payments…".
  check("the note does not repeat the badge word it follows", !/^\s*College\b/.test(collegeLedgerNote()), collegeLedgerNote());
  // 7d-fix (confirmed in the DOM): with a college half present, the school card's
  // bare "No payments yet" appeared beside the college's own payment rows. It now
  // names its half; a school-only ledger keeps the old text.
  check(
    "the school by-method empty text names its half only when a college half exists",
    /collegeMoney\s*\?\s*"No school payments yet"\s*:\s*"No payments yet"/.test(ledgerCode),
    "name the half conditionally"
  );
  check("the filter offers both halves", LEDGER_MODE_OPTIONS.length === 3 && LEDGER_MODE_OPTIONS[2].value === "COLLEGE");

  // …and the ledger PAGE must use exactly these decisions.
  check("the ledger page uses the tag", /isCollegeLedgerEntry\(/.test(ledgerCode));
  check("the ledger page splits its totals", /ledgerTotals\(/.test(ledgerCode));
  check("the ledger page offers the mode filter", /LEDGER_MODE_OPTIONS/.test(ledgerCode) && /filterLedgerEntries\(/.test(ledgerCode));
  check("the ledger page renders the badge", /COLLEGE_LEDGER_BADGE/.test(ledgerCode));
  check("the ledger page keeps the school's own money text", /fmtMoney\(/.test(ledgerCode));
  check("the ledger page excludes college rows from the school cards", /!isCollegeLedgerEntry\(/.test(ledgerCode));
  check("the ledger page does no float formatting of college money", /collegeLedgerAmountText\(/.test(ledgerCode));
}

/* ------------------------------------------------------------------- 8. the nav */

console.log("\n8. ONE college fee nav entry behind requires:COLLEGE, grouped in finance");
{
  const lines = navSource.split("\n").filter((l) => l.includes('href: "/dashboard/college-fees"'));
  check("one registry line per carrying role", lines.length === 4, `${lines.length} entries`);
  check("every one is a COLLEGE item", lines.every((l) => l.includes('requires: "COLLEGE"')));
  check("every one carries the one label", lines.every((l) => l.includes('label: "College Fees"')));
  check("the item is grouped in `finance`", /"\/dashboard\/college-fees": "finance"/.test(navSource));

  const carriers = [];
  for (const role of ["SUPER_ADMIN", "SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT", "LIBRARIAN", "FRONT_DESK", "TEACHER", "GUARDIAN"]) {
    const navList = nav.navForRole(role, "COLLEGE", "COLLEGE");
    if (navList.some((i) => i.href === "/dashboard/college-fees")) carriers.push(role);
  }
  check(
    "the fee entry is carried by exactly the v1 read roles with a dashboard",
    JSON.stringify(carriers) === JSON.stringify(["SCHOOL_ADMIN", "BRANCH_ADMIN", "REGISTRAR", "ACCOUNTANT"]),
    carriers.join(", ")
  );
  const collegeList = nav.navForRole("SCHOOL_ADMIN", "COLLEGE", "COLLEGE");
  check("a COLLEGE tenant's sidebar is the college list only", collegeList.every((i) => i.requires === "COLLEGE"), collegeList.map((i) => i.href).join(", "));
  check("…and it still lists the fee screen", collegeList.some((i) => i.href === "/dashboard/college-fees"));
  const schoolList = nav.navForRole("SCHOOL_ADMIN", "SCHOOL", "SCHOOL");
  check("a SCHOOL tenant's sidebar is untouched by 7d", !schoolList.some((i) => i.requires), `${schoolList.length} items`);
}

/* ------------------------------------------------- 9. the wizard success screen */

console.log("\n9. the success screen names the tenant it created (7d closes the open item)");
{
  const counts = { classesCreated: 3, sectionsCreated: 6, subjectsCreated: 9, departmentsCreated: 0, programsCreated: 0, coursesCreated: 0 };
  const collegeLines = seed.wizardSuccessLines("COLLEGE", counts);
  eq("a COLLEGE tenant is told nothing about classes", collegeLines.some((l) => /class\(es\)/.test(l)), false);
  eq("…and prints no line at all when it has no college rows", collegeLines.length, 0);
  const collegeWithRows = seed.wizardSuccessLines("COLLEGE", { ...counts, departmentsCreated: 2, programsCreated: 3, coursesCreated: 12 });
  eq("a COLLEGE tenant's own counts are printed", collegeWithRows.length === 1 && /2 department/.test(collegeWithRows[0]), true);
  const schoolLines = seed.wizardSuccessLines("SCHOOL", counts);
  eq("a SCHOOL tenant reads the school line", schoolLines.length === 1 && /3 class\(es\)/.test(schoolLines[0]), true);
  const bothLines = seed.wizardSuccessLines("BOTH", { ...counts, departmentsCreated: 1, programsCreated: 1, coursesCreated: 4 });
  eq("a BOTH tenant reads BOTH of its halves", bothLines.length, 2);
  eq("an absent shape reads as SCHOOL", seed.wizardSuccessLines(undefined, counts).length, 1);
  eq("an unknown shape reads as SCHOOL", seed.wizardSuccessLines("PRIMARY", counts).length, 1);

  eq("no settings button for a COLLEGE tenant", seed.wizardSettingsLink("COLLEGE"), null);
  eq("a SCHOOL tenant keeps its settings button", seed.wizardSettingsLink("SCHOOL").href, "/dashboard/settings");
  eq("…with the label it has always had", seed.wizardSettingsLink("SCHOOL").label, "School settings");
  eq("a BOTH tenant keeps it too", seed.wizardSettingsLink("BOTH").label, "School settings");
  eq("an absent shape keeps it", seed.wizardSettingsLink(undefined).href, "/dashboard/settings");

  check("the wizard page uses the per-half lines", /wizardSuccessLines\(/.test(onboardingNoComments));
  check("the wizard page uses the settings-link rule", /wizardSettingsLink\(/.test(onboardingNoComments));
  check("the wizard page no longer hard-codes the school counts", !/class\(es\),/.test(onboardingNoComments));
  check("the wizard page no longer hard-codes the settings button", !/School settings/.test(onboardingNoComments) && !/\/dashboard\/settings/.test(onboardingNoComments));
}

/* -------------------------------------- 10. the API contract the pages rely on */

console.log("\n10. the pages' own contract with the 7c API");
{
  // The payload key itself, not just the local name: 7d's picker reads
  // `data.programmes`, so the route's response object must carry it.
  const structureCode = maskCommentsAndStrings(structureRouteSource);
  const dataBlock = structureCode.slice(structureCode.indexOf("const data = {"), structureCode.indexOf("const data = {") + 600);
  check(
    "the structure read serves the programme picker",
    /programmes,/.test(dataBlock) && /collegeTermCount\(/.test(structureCode),
    dataBlock ? (dataBlock.match(/programmes,/) ? "payload key present" : "payload key missing") : "no data block"
  );
  check("the page reads the programmes from that read", /payload\?\.programmes|data\?\.programmes/.test(pageCode));
  check("the payments route takes integer minor units", /amountMinor/.test(maskCommentsAndStrings(paymentsRouteSource)));
  check("the generate route takes no charge amount", !/body\?\.amount\b/.test(maskCommentsAndStrings(generateRouteSource)));
  check("the page's programme select is built from the served list", /programmeOptions\(/.test(pageCode));
  // The helper's own truth table, so the picker cannot invent a programme.
  eq("a served programme list is keyed by id", programmeOptions([{ id: "p1", name: "HSC" }])[0].id, "p1");
  eq("a partial payload yields no bogus option", programmeOptions([{ name: "no id" }]).length, 0);
  eq("junk yields an empty list", programmeOptions(null).length, 0);
  // The label helpers are sanity, not decoration.
  eq("bucket labels read as words", bucketLabel("LIBRARY_FINE"), "Library Fine");
  eq("an unknown bucket falls back", bucketLabel("NOPE"), "Other");
  eq("cadence labels read as words", frequencyLabel("ONE_TIME"), "One time");
  eq("unit labels say what a row covers", unitLabel("COURSE"), "per approved course");
  eq("basis labels name the v1 basis", basisLabel("FLAT"), "flat");
  eq("head state names inactivity", headStateText(false, false), "Inactive — never billed");
  eq("due status reads as words", dueStatusText("PARTIAL"), "partly paid");
  eq("a channel line names its kind", /Mobile wallet/.test(channelLine({ label: "bKash", kind: "MOBILE", methods: ["BKASH"] })), true);
  eq("a channel kind label", channelKindLabel("BANK"), "Bank");
  eq("a count reads as words", countText(1, "charge"), "1 charge");
  eq("the currency label falls back to BDT", currencyOf(null), "BDT");
  eq("a stored currency label wins", currencyOf({ currency: "usd" }), "USD");
  eq("rows are filtered to their own term", rowsForTerm([{ termNumber: 1, amount: 1 }, { termNumber: 2, amount: 2 }], "2").length, 1);
  check("the structure totals line names both figures", /in rows/.test(structureTotalsText([{ amount: 100 }], 1000)) && /once cadences bill/.test(structureTotalsText([{ amount: 100 }], 1000)));
  check("the generation summary names the money", /to raise/.test(generationSummaryText({ dryRun: true, currency: "BDT", totals: { students: 2, amount: 1000, newRows: 4 } })));
  check("a refusal is shown verbatim", refusalText({ status: 409, message: "Payment exceeds the outstanding amount (৳10.00)." }, "fallback") === "Payment exceeds the outstanding amount (৳10.00).");
  check("a network failure falls back", refusalText(new Error("Failed to fetch"), "fallback") === "fallback");
  check("an API error exposes its message", apiRefusal({ status: 400, message: " nope " }) === "nope");
  check("the error copy is per screen", Object.keys(PAGE_ERRORS).length >= 10);
  check("the read-only note explains the role", /read-only/.test(readOnlyNote()));
  eq("the section label for an undefined amount", formatMoney(undefined), MONEY_UNKNOWN);
}

/* ----------------------- 11. the Dues header's totals (the 7d-fix, D-7-16) */

console.log("\n11. the Dues header's figures = the rows beneath them = the API's own totals");
{
  // The REAL payload, built the way the route builds it: `collegeDues()` — the
  // API's own function — over the very charge rows it serves, once per student
  // and once for the whole scope. Nothing here is a hand-made fixture.
  const chargeRows = [
    // Student A — a tuition row discounted 10% (net amount kept, discount beside
    // it) and part-paid, plus an unpaid lab row.
    { id: "cf_a1", studentId: "s1", amount: 21600, discount: 2400, paidAmount: 10800 },
    { id: "cf_a2", studentId: "s1", amount: 3500, discount: 0, paidAmount: 0 },
    // Student B — fully paid.
    { id: "cf_b1", studentId: "s2", amount: 10000, discount: 0, paidAmount: 10000 },
  ];
  const studentIds = [...new Set(chargeRows.map((r) => r.studentId))];
  const servedStudents = studentIds.map((sid) => {
    const own = feesLib.collegeDues(chargeRows.filter((r) => r.studentId === sid));
    return { studentId: sid, count: own.count, billed: own.billed, discount: own.discount, paid: own.paid, due: own.due, status: own.status };
  });
  const servedTotals = { ...feesLib.collegeDues(chargeRows), students: servedStudents.length };

  const header = duesScopeTotals(servedStudents);
  const apiBilled = minorUnits(servedTotals.billed);
  const apiWaived = minorUnits(servedTotals.discount);
  const apiPaid = minorUnits(servedTotals.paid);
  const apiDue = minorUnits(servedTotals.due);

  eq("the header counts the students", header.students, servedStudents.length);
  eq("the header counts the CHARGE ROWS, not the students", header.charges, chargeRows.length);
  eq("billed = the API's billed", header.billedMinor, apiBilled);
  eq("waived = the API's waivers", header.waivedMinor, apiWaived);
  eq("paid = the API's paid", header.paidMinor, apiPaid);
  eq("due = the API's due", header.dueMinor, apiDue);
  eq("and billed really is the sum of the rows beneath", header.billedMinor, chargeRows.reduce((a, r) => a + minorUnits(r.amount), 0));
  eq("…as is due", header.dueMinor, chargeRows.reduce((a, r) => a + Math.max(0, minorUnits(r.amount) - minorUnits(r.paidAmount)), 0));

  // The previous bug in one line: a CHARGE-shaped helper reads `amount`/
  // `paidAmount` off a SUMMARY row (which has `billed`/`paid`), so it printed
  // ৳0.00 for every figure and counted students as charges.
  const wrong = view.chargeTotals(servedStudents);
  eq("the charge-shaped helper DOES collapse on summary rows (the 7d defect)", wrong.billedMinor, 0);
  eq("…and would have counted students as charges", wrong.count, servedStudents.length);
  eq("the fixed helper does not", header.billedMinor !== wrong.billedMinor, true);

  const text = duesScopeText(servedStudents);
  check(
    "the header line names all six figures",
    /student/.test(text) && /charge/.test(text) && /billed/.test(text) && /waived/.test(text) && /paid/.test(text) && /due/.test(text),
    text
  );
  check("the header line prints the API's own money", new RegExp(formatMinor(apiBilled)).test(text) && new RegExp(formatMinor(apiDue)).test(text), text);
  check("the header line is NOT the old zero row", !/0 student/.test(text) && !/৳0\.00 billed/.test(text), text);

  // Edge: no students at all — zeros, never NaN, and still six figures.
  const zero = duesScopeTotals([]);
  eq("zero students: all six figures are zero", JSON.stringify(zero), JSON.stringify({ students: 0, charges: 0, billedMinor: 0, waivedMinor: 0, paidMinor: 0, dueMinor: 0 }));
  eq("zero students: junk in is zero out, never NaN", JSON.stringify(duesScopeTotals(null)), JSON.stringify(duesScopeTotals(undefined)));
  check("zero students still reads as a sentence", /0 students · 0 charges · ৳0\.00 billed/.test(duesScopeText([])), duesScopeText([]));

  // Edge: a fully paid set — due is zero and no figure is dropped.
  const paidRows = [{ amount: 5000, discount: 0, paidAmount: 5000 }];
  const paidSummary = feesLib.collegeDues(paidRows);
  const paidHeader = duesScopeTotals([{ count: paidSummary.count, billed: paidSummary.billed, discount: paidSummary.discount, paid: paidSummary.paid, due: paidSummary.due }]);
  eq("a fully paid set owes nothing", paidHeader.dueMinor, 0);
  eq("…and still shows what was billed", paidHeader.billedMinor, 500000);
  eq("…and what was paid", paidHeader.paidMinor, 500000);
  check("a fully paid header still prints a due figure", /৳0\.00 due/.test(duesScopeText([{ billed: paidSummary.billed, discount: 0, paid: paidSummary.paid, due: paidSummary.due }])));

  // The page must USE the helper — and must not feed per-student rows to a
  // charge-shaped total ever again.
  check("the page prints the header through the one helper", /duesScopeText\(\s*scope\?\.students/.test(pageCode));
  check("the page no longer runs a charge total over the per-student summaries", !/chargeTotals\(\s*scope\?\.students/.test(pageCode));
}

/* ---------------- 12. the Term pricing table shows PRICING money, not dues */

console.log("\n12. the Fee structure tab prints a pricing total, never billed/paid/due");
{
  const priceRows = [{ amount: 24000, termNumber: 1 }, { amount: 3500, termNumber: 1 }];
  const apiRowsTotal = priceRows.reduce((a, r) => a + minorUnits(r.amount), 0);
  eq("the pricing total is the sum of the priced rows", structureRowsText(priceRows), `${formatMinor(apiRowsTotal)} in rows`);
  check("it never claims a charge was billed, paid or due", !/billed|paid|due/.test(structureRowsText(priceRows)), structureRowsText(priceRows));
  eq("an empty pricing table reads as zero, not NaN", structureRowsText([]), `${formatMinor(0)} in rows`);
  eq("junk rows contribute nothing", structureRowsText([{ amount: null }, { amount: "x" }]), `${formatMinor(0)} in rows`);
  // A structure row has an amount and no paidAmount: the charge-shaped total is
  // exactly what printed a phantom "due" on a pure pricing table.
  // Exactly the string the tab used to print under the pricing table: the full
  // price shown as money "due" that nobody owes.
  eq("the charge-shaped total is the phantom the tab used to print", termTotalText(priceRows), "৳27,500.00 billed · ৳0.00 paid · ৳27,500.00 due");
  check("the page's Term pricing header uses the pricing helper", /structureRowsText\(\s*rows/.test(pageCode));
  check("the page's Term pricing header no longer uses the dues helper", !/termTotalText\(\s*rows/.test(pageCode));
}

/* ------------------- 13. the wizard must not prefill the SUPER_ADMIN (7d-fix) */

console.log("\n13. the Admin step does not prefill the platform SUPER_ADMIN's own identity");
{
  eq("a SUPER_ADMIN creating a tenant gets NO prefill", seed.wizardPrefillsAdmin("SUPER_ADMIN", false), false);
  eq("a SCHOOL_ADMIN creating their own school keeps its prefill", seed.wizardPrefillsAdmin("SCHOOL_ADMIN", false), true);
  eq("the check is case-proof", seed.wizardPrefillsAdmin("super_admin", false), false);
  eq("extend mode is unchanged for a SUPER_ADMIN", seed.wizardPrefillsAdmin("SUPER_ADMIN", true), true);
  eq("extend mode is unchanged for anyone", seed.wizardPrefillsAdmin("ACCOUNTANT", true), true);
  eq("a missing role is not the platform operator", seed.wizardPrefillsAdmin(null, false), true);
  check("the wizard page asks the rule", /wizardPrefillsAdmin\(me\.user\.role, false\)/.test(onboardingNoComments));
  check("the wizard page no longer prefills the admin unconditionally", !/\} else if \(me\?\.user\) \{\s*setAdmin\(/.test(onboardingNoComments));
  check("the rule lives with the wizard's other decisions", /export function wizardPrefillsAdmin\(/.test(readFileSync(new URL("../src/lib/onboarding-seed.ts", import.meta.url), "utf8")));
}

/* ------------------- 14. the two print pages, D-7-17 (phase 7d remainder) */

console.log("\n14. the college fee STATEMENT and RECEIPT print pages (D-7-17)");
{
  // The routes D-7-17 names, at the paths it names.
  check("the statement print route exists", existsSync(STATEMENT_PAGE_URL));
  check("the receipt print route exists", existsSync(RECEIPT_PAGE_URL));

  // ---- the guard chain, the same order the 7c API applies ----
  for (const [name, src, ownTenant, branchOf] of [
    ["statement", statementCode, "student.schoolId !== session.schoolId", "student.branchId"],
    ["receipt", receiptCode, "charge.schoolId !== session.schoolId", "charge.branchId"],
  ]) {
    check(`${name}: requires a session`, /await getSession\(\)/.test(src));
    check(`${name}: a foreign tenant is NOT FOUND, never a 403 oracle`, src.includes(ownTenant));
    check(`${name}: the college gate is the pure decision (a page cannot use requireCollege)`, /collegeGateDecision\(/.test(src));
    check(`${name}: applies the v1 READ allow-list, the SAME rule as the API`, /canReadCollegeFees\(session\.role\)/.test(src));
    // The call must be the one that RETURNS the refusal — a bare mention proves
    // nothing (removing the `if` is exactly the mutation this catches).
    check(
      `${name}: confines the read to the caller's branch`,
      new RegExp(`if \\(!canAccessBranch\\(session, ${branchOf.replace(".", "\\.")}\\)\\) return NOT_FOUND;`).test(src)
    );
    check(`${name}: never imports the NextResponse-shaped gate`, !/requireCollege\b/.test(src));
    check(`${name}: writes nothing (no write gate, no guarded write, no create)`, !/requireCollegeFeesWrite|\$guardedUpdate|prisma\.[A-Za-z]+\.create\(/.test(src));
    check(`${name}: never reaches a school fee surface`, !/feeCategory|feeSetting|\/api\/fees/.test(src));
    check(`${name}: prints the tenant's own name`, /school\?\.name/.test(src));
    check(`${name}: reads through the 7c loaders, not a new query`, /loadCollegeFeeConfig\(/.test(src));
  }

  // ---- the hrefs: ONE definition, both call sites, no re-inlining ----
  eq("the statement href", collegeFeeStatementHref("st_1"), "/print/college-fee-statement/st_1");
  eq("…narrowed to one term", collegeFeeStatementHref("st_1", 2), "/print/college-fee-statement/st_1?term=2");
  eq("…and junk in the term means the whole programme", collegeFeeStatementHref("st_1", "abc"), "/print/college-fee-statement/st_1");
  eq("no student ⇒ no href (never a broken link)", collegeFeeStatementHref(""), "");
  eq("a weird id is encoded", collegeFeeStatementHref("a/b c"), "/print/college-fee-statement/a%2Fb%20c");
  eq("the receipt href", collegeFeeReceiptHref("cf_1"), "/print/college-fee-receipt/cf_1");
  eq("…selecting ONE payment", collegeFeeReceiptHref("cf_1", "CRCP-1"), "/print/college-fee-receipt/cf_1?receipt=CRCP-1");
  eq("…and a blank receipt number selects none", collegeFeeReceiptHref("cf_1", "  "), "/print/college-fee-receipt/cf_1");
  eq("no charge ⇒ no href", collegeFeeReceiptHref(null), "");
  // The paths themselves ARE string literals in the view module, so this reads the
  // raw source: `viewCode` masks string literals away by design.
  check(
    "both print paths are defined once, in the view module",
    /export const COLLEGE_FEE_STATEMENT_HREF = "\/print\/college-fee-statement"/.test(viewSource) &&
      /export const COLLEGE_FEE_RECEIPT_HREF = "\/print\/college-fee-receipt"/.test(viewSource)
  );
  check("the Dues tab links the statement through the helper", /collegeFeeStatementHref\(/.test(pageCode));
  check("the Dues tab links the receipt through the helper", /collegeFeeReceiptHref\(/.test(pageCode));
  check("the receipt link appears only for a real receipt number", /receipt\?\.receiptNo &&/.test(pageCode));
  check("the receipt state is cleared when another student is picked", /setReceipt\(null\)/.test(pageCode));
  check("neither print page re-inlines its own path", !/\/print\/college-fee-/.test(statementCode) && !/\/print\/college-fee-/.test(receiptCode));

  // ---- the ?term= reader: junk is the whole programme, never an error page ----
  eq("no term ⇒ the whole programme", statementTermValue(undefined), null);
  eq("an empty term ⇒ the whole programme", statementTermValue(""), null);
  eq("an unreadable term ⇒ the whole programme", statementTermValue("abc"), null);
  eq("term 0 is refused", statementTermValue("0"), null);
  eq("a fractional term is refused", statementTermValue("1.5"), null);
  eq("a negative term is refused", statementTermValue("-2"), null);
  eq("a real term is read", statementTermValue("2"), 2);
  eq("…from a number too", statementTermValue(3), 3);

  // ---- grouping: term order, per-term totals, and no row lost to a junk term ----
  const rows = [
    { id: "c2", termNumber: 2, amount: 100, paidAmount: 0, discount: 0 },
    { id: "c1", termNumber: 1, amount: 200, paidAmount: 50, discount: 25 },
  ];
  const groups = statementTerms(rows);
  eq("the statement groups by term, in term order", groups.map((g) => g.termNumber).join(","), "1,2");
  eq("a term keeps its own rows", groups[0].rows.map((r) => r.id).join(","), "c1");
  eq("…and its own billed total", groups[0].totals.billedMinor, 20000);
  eq("…its own due total", groups[0].totals.dueMinor, 15000);
  eq("…and its own waiver total", groups[0].totals.discountMinor, 2500);
  eq("the second term totals independently", groups[1].totals.dueMinor, 10000);
  const junkTerm = statementTerms([{ id: "a", amount: 10 }, { id: "b", termNumber: "x", amount: 20 }]);
  eq("an unreadable term is term 1, so no charge is ever lost", junkTerm.length, 1);
  eq("…and both rows are on it", junkTerm[0].rows.length, 2);
  eq("an empty statement has no groups", statementTerms([]).length, 0);
  eq("junk input has no groups", statementTerms(null).length, 0);

  // ---- the scope line ----
  // A single-term statement is what the PAGE passes when it is narrowed to a term
  // (`?term=`), so that is the case asserted here: the term's own rows only.
  const termGroups = groups.filter((g) => g.termNumber === 1);
  const termScope = statementScopeText(termGroups, 1);
  check("the scope line names the term", /^Term 1/.test(termScope), termScope);
  check("…the charge count", /1 charge\b/.test(termScope), termScope);
  check("…and all three money figures", /billed/.test(termScope) && /paid/.test(termScope) && /due/.test(termScope), termScope);
  check("…printing the rows' own money", termScope.includes(formatMinor(20000)) && termScope.includes(formatMinor(15000)), termScope);
  check("…and NOT the other term's", !termScope.includes(formatMinor(10000)), termScope);
  const wholeScope = statementScopeText(groups, null);
  check("the whole-programme scope says so, with its term count", /^Whole programme · 2 terms/.test(wholeScope), wholeScope);
  check("…and adds both terms' money", wholeScope.includes(formatMinor(25000)), wholeScope);
  check("an empty statement reads as zeros, never NaN", /0 charges · ৳0\.00 billed/.test(statementScopeText(statementTerms([]), null)), statementScopeText(statementTerms([]), null));

  // ---- the pages print WHICH rate billed them (D-7-17) ----
  check("the statement names its rates", /structureRateText\(/.test(statementCode));
  // …and the instant is both READ and PRINTED — a read whose value is dropped is
  // exactly the mutation this catches.
  check(
    "…and the instant each took effect, read AND printed",
    /const when = structureEffectiveAt\(/.test(statementCode) && /fmtDate\(when\)/.test(statementCode)
  );
  check("the receipt names its rate too", /structureRateText\(/.test(receiptCode));
  check("both read the structure through the 7c loader", /loadStructure\(/.test(statementCode) && /loadStructure\(/.test(receiptCode));
  check("the statement totals come from the one charge helper", /chargeTotals\(/.test(statementCode));
}

/* ------------- 15. the receipt is ONE payment, and never a different one */

console.log("\n15. the receipt prints one payment — and refuses to print another under its number");
{
  // ---- the COLLEGE tag, per charge ----
  const tagged = { id: "l1", kind: "PAYMENT", feeId: null, meta: { collegeFeeId: "cf_1", receiptNo: "CRCP-1" } };
  check("a tagged payment for THIS charge matches", isCollegePaymentEntryFor(tagged, "cf_1"));
  check("a payment on ANOTHER charge does not", !isCollegePaymentEntryFor(tagged, "cf_2"));
  check("a school payment does not (it has its own feeId)", !isCollegePaymentEntryFor({ kind: "PAYMENT", feeId: "fee_1", meta: {} }, "cf_1"));
  check("a college WAIVER is not a payment", !isCollegePaymentEntryFor({ kind: "DISCOUNT", feeId: null, meta: { collegeDiscountId: "d1" } }, "cf_1"));
  check("a school FEE creation does not", !isCollegePaymentEntryFor({ kind: "FEE", feeId: "fee_1", meta: null }, "cf_1"));
  check("an untagged entry never matches", !isCollegePaymentEntryFor({ kind: "PAYMENT", feeId: null, meta: null }, "cf_1"));
  check("an empty charge id matches nothing", !isCollegePaymentEntryFor(tagged, ""));
  eq("its receipt number is read from the tag", paymentReceiptNo(tagged), "CRCP-1");
  eq("a missing tag has no receipt number", paymentReceiptNo({ meta: null }), "");

  // ---- pickReceiptEntry: the ASKED-FOR payment, or the newest ----
  const entries = [
    { id: "l1", createdAt: "2026-10-01T00:00:00.000Z", meta: { receiptNo: "CRCP-1" } },
    { id: "l2", createdAt: "2026-10-03T00:00:00.000Z", meta: { receiptNo: "CRCP-2" } },
    { id: "l3", createdAt: "2026-10-02T00:00:00.000Z", meta: { receiptNo: "CRCP-3" } },
  ];
  eq("asking for a receipt returns THAT payment", pickReceiptEntry(entries, "CRCP-1")?.entry.id, "l1");
  eq("…and says it was matched", pickReceiptEntry(entries, "CRCP-1")?.matched, true);
  eq("asking for a receipt this charge does not hold returns NOTHING", pickReceiptEntry(entries, "CRCP-9"), null);
  eq("without a number it prints the newest payment", pickReceiptEntry(entries)?.entry.id, "l2");
  eq("…and flags it as unmatched (the default selection)", pickReceiptEntry(entries)?.matched, false);
  eq("a charge with no payments has no receipt", pickReceiptEntry([], "CRCP-1"), null);
  eq("junk input has no receipt", pickReceiptEntry(null), null);
  eq("free-text junk never matches", pickReceiptEntry(entries, "whatever"), null);
  const tied = [
    { id: "la", createdAt: "2026-10-01T00:00:00.000Z", meta: { receiptNo: "A" } },
    { id: "lb", createdAt: "2026-10-01T00:00:00.000Z", meta: { receiptNo: "B" } },
  ];
  eq("an equal timestamp breaks the tie deterministically", pickReceiptEntry(tied)?.entry.id, "lb");
  check(
    "the receipt page uses the one picker, ON the number it was asked for",
    /pickReceiptEntry\(\s*payments,\s*receiptParam\s*\)/.test(receiptCode)
  );
  check("…and prints nothing when it finds none", /if \(!picked\)/.test(receiptCode) && /No confirmed college payment/.test(receiptCode));
  check("…saying WHICH number it could not find", /carries the receipt number/.test(receiptCode));
  check("…and reads the student's payments through the per-charge tag", /isCollegePaymentEntryFor\(/.test(receiptCode));

  // ---- one payment is not a settled charge ----
  eq("a settled charge reads as paid in full", chargeSettlementText({ amount: 100, paidAmount: 100 }), "Paid in full");
  eq("a part-paid charge states the remainder", chargeSettlementText({ amount: 100, paidAmount: 40 }), `${formatMinor(6000)} still due`);
  eq("an unpaid charge states the whole amount", chargeSettlementText({ amount: 100, paidAmount: 0 }), `${formatMinor(10000)} still due`);
  eq("nothing billed says so", chargeSettlementText({}), "Nothing billed");
  eq("no charge says nothing", chargeSettlementText(null), "");
  check("the receipt prints what the charge still owes", /chargeSettlementText\(/.test(receiptCode));
  check("…beside what THIS receipt collected", /collegeLedgerAmountText\(/.test(receiptCode));
  check("…and names the payment as one instalment", /ONE confirmed college payment/.test(receiptCode));

  // ---- the rate line and its effective instant ----
  eq("the rate line carries the amount and the shape", structureRateText({ amount: 1500, unit: "STUDENT", basis: "FLAT" }), `${formatMoney(1500)} per student · flat`);
  eq("a course-priced row says so", structureRateText({ amount: 1500, unit: "COURSE", basis: "FLAT" }), `${formatMoney(1500)} per approved course · flat`);
  eq("no structure row ⇒ no line", structureRateText(null), "");
  eq("the effective instant prefers the last edit", structureEffectiveAt({ updatedAt: "2026-02-01T00:00:00.000Z", createdAt: "2026-01-01T00:00:00.000Z" }), "2026-02-01T00:00:00.000Z");
  eq("…falling back to its creation", structureEffectiveAt({ createdAt: "2026-01-01T00:00:00.000Z" }), "2026-01-01T00:00:00.000Z");
  eq("an undated row has no instant", structureEffectiveAt({}), null);
  eq("no row has no instant", structureEffectiveAt(null), null);
}

/* ------- 16. the 7d copy fixes, pinned as text (a client render cannot be read) ------- */

console.log("\n16. the 7d copy fixes are complete sentences, and the preview names itself");
{
  // The college fee page is a CLIENT component: its server HTML is a loading shell, so
  // the sentences a human reads cannot be fetched over HTTP (a browser pass is a
  // separate step). These pins are the substitute this repo already uses for exactly
  // that situation — section 12 pins the phantom total the same way. `pageCode` drops
  // comments but KEEPS string literals, so a re-truncated sentence or a moved label
  // fails here. Item 3's defect was clipped text, so the old fragment must be gone
  // too: asserting only the new string would let both live on the page at once.
  const STRUCTURE_INTRO =
    "One row per programme, per term and per head. The programme's own term shape bounds the term number.";
  const BASIS_HINT = "Per-credit pricing is not in v1 — it is refused by name.";
  const PREVIEW_LABEL = "Preview (nothing written)";

  check("the Fee-structure intro is the complete sentence (7d item 3 — it read as clipped)", pageCode.includes(STRUCTURE_INTRO), STRUCTURE_INTRO);
  check("…and the OLD, clipped phrasing is gone", !/is one row per programme/.test(pageCode));
  check("the Basis help line is the complete sentence", pageCode.includes(BASIS_HINT), BASIS_HINT);
  check("…and the OLD mid-sentence version is gone", !/not in v1 and is refused/.test(pageCode));
  check("the preview panel names itself (7d item 4 — zeros beside committed money read as a wrong total)", pageCode.includes(PREVIEW_LABEL), PREVIEW_LABEL);
  // …and it is BOUND to the dry-run flag: the committed branch still says "Committed",
  // so the label cannot be shown for a real write, nor dropped from a preview.
  check(
    "…and only the dry-run branch says it",
    /preview\.dryRun \? "Preview \(nothing written\)" : "Committed"/.test(pageCode)
  );
}

/* ---------------------------------------------------------------------- end */

console.log("");
if (failures) {
  console.log(`❌ college fees page verification FAILED — ${failures} of ${checks} check(s).`);
  process.exit(1);
}
console.log(`✅ college fees page verification PASSED — ${checks} checks.`);
