#!/usr/bin/env node
/**
 * Onboarding — the tenant seed and its institution-type decision table, proved
 * OFFLINE.
 *
 * `src/lib/onboarding-seed.ts` is the one place that says what a brand-new tenant
 * starts with: classes + subjects for the school half, and a department →
 * programme → course catalogue for the college half. The wizard offers those
 * defaults and the route applies them, so a mistake here is a mistake in both.
 *
 * Everything below is checkable with no database, no server and no network (so
 * this script carries no `requireEmulator()` guard):
 *
 *   1. NO DRIFT. The module restates the three tenant shapes locally, because a
 *      runtime import would stop Node from loading it at all (type stripping
 *      resolves specifiers literally). That copy is only safe if it is PROVEN
 *      equal to `src/lib/institution.ts` — which is what section 1 does, over a
 *      probing set that includes `constructor`, `__proto__`, `toString`, numbers,
 *      booleans, arrays and objects.
 *   2. THE SHAPE TABLE. SCHOOL ⇒ school half only; COLLEGE ⇒ college half only;
 *      BOTH ⇒ both; every absent/unknown/junk value ⇒ SCHOOL (so an old tenant is
 *      a school, exactly as before).
 *   3. THE SCHOOL HALF. Non-empty, unique class names, non-empty section lists,
 *      unique subjects.
 *   4. THE COLLEGE SKELETON. Well-formed AND within every bound the college APIs
 *      enforce — the degree levels, course types, credit ceiling and term systems
 *      are cross-checked against the route sources that validate them, so a seed
 *      can never create a row those routes would reject.
 *   5. `normalizeCollegeSeed`. A partial edit keeps the rest of the defaults, a
 *      missing code is derived from the name, duplicate codes collapse, and every
 *      explicitly invalid value is REFUSED rather than silently dropped.
 *   6. `resolveCollegeSeed`. The per-shape rule: a school-only tenant never gets
 *      college rows however the request is shaped; a new tenant that omits the
 *      block gets the default skeleton; an existing tenant that omits it adds
 *      nothing.
 *   7. WIRING + RUNTIME-DEPENDENCY-FREE. The route and the wizard page actually
 *      use this module and carry the tenant shape, and the module has no runtime
 *      import at all.
 *
 *   node scripts/verify-onboarding-seed.mjs
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const MODULE_PATH = resolve(ROOT, "src/lib/onboarding-seed.ts");
const ROUTE_PATH = resolve(ROOT, "src/app/api/onboarding/route.ts");
const PAGE_PATH = resolve(ROOT, "src/app/onboarding/page.tsx");
const PROGRAMS_API_PATH = resolve(ROOT, "src/app/api/programs/route.ts");
const COURSES_API_PATH = resolve(ROOT, "src/app/api/courses/route.ts");

let passes = 0;
const failures = [];
const ok = (name) => {
  passes++;
  console.log(`  [PASS] ${name}`);
};
const bad = (name, detail) => {
  failures.push(name);
  console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
};
const check = (name, cond, detail = "") => (cond ? ok(name) : bad(name, detail));

const {
  COLLEGE_DEFAULT_SKELETON,
  COURSE_TYPES,
  DEGREE_LEVELS,
  MAX_CREDIT_HOURS,
  SCHOOL_DEFAULT_CLASSES,
  SCHOOL_DEFAULT_SUBJECTS,
  TERM_SYSTEMS,
  cloneCollege,
  defaultSeedFor,
  normalizeCollegeSeed,
  normalizeTenantType,
  resolveCollegeSeed,
  seedCodeFor,
  seedTermCount,
  tenantHasCollege,
  tenantHasSchool,
// Relative specifiers, not the absolute paths above: the default ESM loader only
// accepts file:// URLs on Windows, and the other offline verifiers import the
// libs the same way.
} = await import("../src/lib/onboarding-seed.ts");

const {
  hasCollege,
  hasSchool,
  normalizeInstitutionType,
} = await import("../src/lib/institution.ts");

const read = (p) => readFileSync(p, "utf8");
const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

/* ------------------------------------------------- 1. no drift with institution */

console.log("\n1. the restated shape table agrees with src/lib/institution.ts");
{
  const PROBES = [
    undefined,
    null,
    "",
    " ",
    "SCHOOL",
    "school",
    "COLLEGE",
    "college",
    "BOTH",
    "both",
    " SCHOOL ",
    "COLLEGES",
    "0",
    0,
    1,
    true,
    false,
    {},
    [],
    ["COLLEGE"],
    "constructor",
    "__proto__",
    "toString",
    "hasOwnProperty",
    "valueOf",
  ];
  const shapeMismatch = PROBES.filter((v) => normalizeTenantType(v) !== normalizeInstitutionType(v));
  check(
    "normalizeTenantType === normalizeInstitutionType for every probe",
    shapeMismatch.length === 0,
    `mismatched on: ${shapeMismatch.map((v) => JSON.stringify(v ?? `${v}`)).join(", ")}`
  );
  const schoolMismatch = PROBES.filter((v) => tenantHasSchool(v) !== hasSchool(normalizeInstitutionType(v)));
  check(
    "tenantHasSchool === hasSchool(normalize…) for every probe",
    schoolMismatch.length === 0,
    `mismatched on: ${schoolMismatch.map((v) => JSON.stringify(v ?? `${v}`)).join(", ")}`
  );
  const collegeMismatch = PROBES.filter((v) => tenantHasCollege(v) !== hasCollege(normalizeInstitutionType(v)));
  check(
    "tenantHasCollege === hasCollege(normalize…) for every probe",
    collegeMismatch.length === 0,
    `mismatched on: ${collegeMismatch.map((v) => JSON.stringify(v ?? `${v}`)).join(", ")}`
  );
  const halvesMismatch = PROBES.filter((v) => {
    const seed = defaultSeedFor(v);
    return (
      (seed.classes.length > 0) !== hasSchool(normalizeInstitutionType(v)) ||
      (seed.college !== null) !== hasCollege(normalizeInstitutionType(v))
    );
  });
  check(
    "defaultSeedFor gives a half exactly when the tenant has that half",
    halvesMismatch.length === 0,
    `mismatched on: ${halvesMismatch.map((v) => JSON.stringify(v ?? `${v}`)).join(", ")}`
  );
}

/* ------------------------------------------------------------- 2. shape table */

console.log("\n2. the default seed for each tenant shape");
{
  const school = defaultSeedFor("SCHOOL");
  check("SCHOOL: classes seeded", school.classes.length > 0, JSON.stringify(school.classes.length));
  check("SCHOOL: subjects seeded", school.subjects.length > 0);
  check("SCHOOL: no college half", school.college === null);

  const college = defaultSeedFor("COLLEGE");
  check("COLLEGE: no school rows at all", college.classes.length === 0 && college.subjects.length === 0);
  check("COLLEGE: college skeleton present", !!college.college);

  const both = defaultSeedFor("BOTH");
  check(
    "BOTH: both halves",
    both.classes.length > 0 && both.subjects.length > 0 && !!both.college
  );

  for (const junk of [undefined, null, "", "college", "COLLEGE ", 7, {}, "constructor"]) {
    const seed = defaultSeedFor(junk);
    const isSchool = seed.classes.length > 0 && seed.college === null;
    if (!isSchool) bad(`absent/unknown value ${JSON.stringify(junk ?? `${junk}`)} reads as SCHOOL`, JSON.stringify({ classes: seed.classes.length, college: !!seed.college }));
  }
  ok("every absent/unknown value reads as SCHOOL");

  // A caller may edit the returned seed (the wizard does) without touching the
  // module constants.
  const mutable = defaultSeedFor("SCHOOL");
  mutable.classes.push({ name: "ZZZ", sections: ["A"] });
  mutable.subjects.push("ZZZ");
  check(
    "the returned seed is a fresh copy (module constants untouched)",
    SCHOOL_DEFAULT_CLASSES.length !== mutable.classes.length &&
      !SCHOOL_DEFAULT_SUBJECTS.includes("ZZZ") &&
      defaultSeedFor("SCHOOL").classes.length === SCHOOL_DEFAULT_CLASSES.length
  );
}

/* ------------------------------------------------------------- 3. school half */

console.log("\n3. the school half is well-formed");
{
  const names = SCHOOL_DEFAULT_CLASSES.map((c) => c.name);
  check("class names are unique", new Set(names).size === names.length);
  check("every class carries at least one section", SCHOOL_DEFAULT_CLASSES.every((c) => c.sections.length > 0));
  check("no empty class or section name", SCHOOL_DEFAULT_CLASSES.every((c) => c.name.trim() && c.sections.every((s) => s.trim())));
  check("subjects are unique and non-empty", new Set(SCHOOL_DEFAULT_SUBJECTS).size === SCHOOL_DEFAULT_SUBJECTS.length && SCHOOL_DEFAULT_SUBJECTS.every((s) => s.trim()));
}

/* ------------------------------------------------------------ 4. college half */

console.log("\n4. the college skeleton is well-formed and within the college APIs' bounds");
{
  const skel = COLLEGE_DEFAULT_SKELETON;
  check("department has a name and a code", !!skel.department.name.trim() && !!skel.department.code.trim());
  check("programme has a name and a code", !!skel.program.name.trim() && !!skel.program.code.trim());
  check(
    "degree level is one of DEGREE_LEVELS",
    DEGREE_LEVELS.includes(skel.program.degreeLevel),
    skel.program.degreeLevel
  );
  check(
    "durationYears is a whole number in 1..6",
    Number.isInteger(skel.program.durationYears) && skel.program.durationYears >= 1 && skel.program.durationYears <= 6,
    String(skel.program.durationYears)
  );
  check("term system is one of TERM_SYSTEMS", TERM_SYSTEMS.includes(skel.program.termSystem), skel.program.termSystem);

  const codes = skel.courses.map((c) => c.code);
  check("course codes are unique and non-empty", new Set(codes).size === codes.length && codes.every((c) => c.trim()));
  check("every course has a title", skel.courses.every((c) => c.title.trim()));
  check(
    "every creditHours is positive and at most the ceiling",
    skel.courses.every((c) => c.creditHours === null || (c.creditHours > 0 && c.creditHours <= MAX_CREDIT_HOURS)),
    JSON.stringify(skel.courses.map((c) => c.creditHours))
  );
  check(
    "every course type is one of COURSE_TYPES",
    skel.courses.every((c) => COURSE_TYPES.includes(c.type)),
    JSON.stringify(skel.courses.map((c) => c.type))
  );
  const termCeiling = seedTermCount(skel.program.durationYears, skel.program.termSystem);
  check(
    "the mapped term exists for this programme",
    Number.isInteger(skel.mapCoursesToTerm) && skel.mapCoursesToTerm >= 1 && skel.mapCoursesToTerm <= termCeiling,
    `term ${skel.mapCoursesToTerm} of ${termCeiling}`
  );
  check(
    "term count = years × terms per year",
    seedTermCount(2, "YEARLY") === 2 && seedTermCount(2, "SEMESTER") === 4 && seedTermCount(3, "YEARLY") === 3
  );

  // The enum lists are mirrored from the routes that validate them; if either
  // side moves, this fails rather than letting the seed write an invalid row.
  const programsApi = read(PROGRAMS_API_PATH);
  const coursesApi = read(COURSES_API_PATH);
  const missing = DEGREE_LEVELS.filter((d) => !programsApi.includes(`"${d}"`));
  check("every degree level exists in the programs route", missing.length === 0, missing.join(", "));
  const missingTypes = COURSE_TYPES.filter((t) => !coursesApi.includes(`"${t}"`));
  check("every course type exists in the courses route", missingTypes.length === 0, missingTypes.join(", "));
  const ceilingMatch = /MAX_CREDIT_HOURS\s*=\s*(\d+)/.exec(coursesApi);
  check(
    "the credit ceiling matches the courses route",
    !!ceilingMatch && Number(ceilingMatch[1]) === MAX_CREDIT_HOURS,
    `route says ${ceilingMatch ? ceilingMatch[1] : "?"}, module says ${MAX_CREDIT_HOURS}`
  );
  const termSystemsApi = ["YEARLY", "SEMESTER"].every((t) => read(resolve(ROOT, "src/lib/college-terms.ts")).includes(`"${t}"`));
  check("both term systems exist in college-terms.ts", termSystemsApi);
}

/* ------------------------------------------------------ 5. normalizeCollegeSeed */

console.log("\n5. normalizeCollegeSeed — defaults, partial edits and refusals");
{
  const asDefault = normalizeCollegeSeed(undefined);
  check("undefined → the default skeleton", asDefault.ok && asDefault.spec.program.code === COLLEGE_DEFAULT_SKELETON.program.code && asDefault.spec.courses.length === COLLEGE_DEFAULT_SKELETON.courses.length);

  // A request that changes nothing must reproduce the skeleton EXACTLY, codes
  // included — deriving a code from the default name would silently rename the
  // starter department ('Science' → 'SCIENCE' instead of 'SCI').
  const emptyBlock = normalizeCollegeSeed({});
  check(
    "an empty block yields the skeleton's own names and codes exactly",
    emptyBlock.ok &&
      emptyBlock.spec.department.name === COLLEGE_DEFAULT_SKELETON.department.name &&
      emptyBlock.spec.department.code === COLLEGE_DEFAULT_SKELETON.department.code &&
      emptyBlock.spec.program.name === COLLEGE_DEFAULT_SKELETON.program.name &&
      emptyBlock.spec.program.code === COLLEGE_DEFAULT_SKELETON.program.code &&
      emptyBlock.spec.courses.length === COLLEGE_DEFAULT_SKELETON.courses.length,
    emptyBlock.ok
      ? JSON.stringify({ department: emptyBlock.spec.department, program: emptyBlock.spec.program.code })
      : emptyBlock.error
  );

  const partial = normalizeCollegeSeed({ department: { name: "Arts" } });
  check(
    "a partial edit keeps the rest of the defaults and derives the code",
    partial.ok && partial.spec.department.name === "Arts" && partial.spec.department.code === seedCodeFor("Arts") &&
      partial.spec.program.code === COLLEGE_DEFAULT_SKELETON.program.code && partial.spec.courses.length === COLLEGE_DEFAULT_SKELETON.courses.length,
    partial.ok ? JSON.stringify(partial.spec.department) : partial.error
  );

  const renamed = normalizeCollegeSeed({ program: { name: "Honours Physics", code: "HON-PHY", degreeLevel: "HONOURS", durationYears: 4, termSystem: "SEMESTER" } });
  check(
    "an edited programme is taken as given (4 SEMESTER ⇒ term ceiling 8)",
    renamed.ok && renamed.spec.program.degreeLevel === "HONOURS" && seedTermCount(4, "SEMESTER") === 8 &&
      renamed.spec.mapCoursesToTerm <= 8
  );

  const collapsed = normalizeCollegeSeed({
    courses: [
      { code: "X-1", title: "One" },
      { code: "X-1", title: "Duplicate code" },
      { code: "X-2", title: "Two" },
      { title: "No code at all" },
    ],
  });
  check(
    "duplicate codes collapse and a code is derived when missing",
    collapsed.ok && collapsed.spec.courses.length === 3 && collapsed.spec.courses.filter((c) => c.code === "X-1").length === 1,
    collapsed.ok ? JSON.stringify(collapsed.spec.courses.map((c) => c.code)) : collapsed.error
  );

  const noCourses = normalizeCollegeSeed({ courses: [] });
  check("an empty course list is honoured (department + programme still seeded)", noCourses.ok && noCourses.spec.courses.length === 0);

  const refusals = [
    ["degreeLevel", { program: { degreeLevel: "PHD" } }],
    ["durationYears", { program: { durationYears: 0 } }],
    ["durationYears (fraction)", { program: { durationYears: 2.5 } }],
    ["durationYears (too long)", { program: { durationYears: 7 } }],
    ["termSystem", { program: { termSystem: "TRIMESTER" } }],
    ["creditHours", { courses: [{ code: "C-1", title: "Too many", creditHours: MAX_CREDIT_HOURS + 1 }] }],
    ["creditHours (negative)", { courses: [{ code: "C-2", title: "Negative", creditHours: -1 }] }],
    ["type", { courses: [{ code: "C-3", title: "Odd type", type: "LAB" }] }],
    ["mapCoursesToTerm", { program: { durationYears: 1, termSystem: "YEARLY" }, courses: [{ code: "C-4", title: "T" }], mapCoursesToTerm: 2 }],
    ["non-object body", "COLLEGE"],
    ["array body", []],
    ["courses not an array", { courses: "Bangla,English" }],
  ];
  const notRefused = refusals.filter(([, input]) => normalizeCollegeSeed(input).ok);
  check(
    "every explicitly invalid value is refused, not silently dropped",
    notRefused.length === 0,
    notRefused.map(([name]) => name).join(", ")
  );
  const wrongMessage = refusals
    .map(([name, input]) => [name, normalizeCollegeSeed(input)])
    .filter(([, r]) => r.ok === false && !/must be/.test(r.error));
  check("every refusal explains the field", wrongMessage.length === 0, wrongMessage.map(([n]) => n).join(", "));
}

/* ------------------------------------------------------- 6. resolveCollegeSeed */

console.log("\n6. resolveCollegeSeed — the per-shape, per-tenant rule");
{
  const schoolNew = resolveCollegeSeed({ department: { name: "Science" } }, "SCHOOL", true);
  check("a SCHOOL tenant gets no college rows, however the request is shaped", schoolNew.ok && schoolNew.spec === null);

  const collegeNew = resolveCollegeSeed(undefined, "COLLEGE", true);
  check("a NEW college tenant that omits the block gets the default skeleton", collegeNew.ok && !!collegeNew.spec && collegeNew.spec.courses.length > 0);

  const collegeExisting = resolveCollegeSeed(undefined, "COLLEGE", false);
  check("an existing tenant that omits the block adds nothing", collegeExisting.ok && collegeExisting.spec === null);

  const collegeExplicit = resolveCollegeSeed({ courses: [] }, "COLLEGE", false);
  check("an existing tenant that sends the block gets exactly that", collegeExplicit.ok && !!collegeExplicit.spec && collegeExplicit.spec.courses.length === 0);

  const bothNew = resolveCollegeSeed(undefined, "BOTH", true);
  check("a NEW BOTH tenant gets the college skeleton too", bothNew.ok && !!bothNew.spec);

  const absentType = resolveCollegeSeed(undefined, undefined, true);
  check("an absent tenant shape reads as SCHOOL (no college rows)", absentType.ok && absentType.spec === null);

  const bad = resolveCollegeSeed({ program: { degreeLevel: "PHD" } }, "COLLEGE", true);
  check("an invalid block is refused for a college tenant", bad.ok === false && /degreeLevel/.test(bad.error));
}

/* ------------------------------------------------------------- 7. wiring + deps */

console.log("\n7. wiring and runtime-dependency-free");
{
  const module = stripComments(read(MODULE_PATH));
  const nonTypeImport = /^\s*import\s+(?!type\b)[^\n]*\bfrom\s+["']/m.test(module);
  const requireCall = /\brequire\s*\(/.test(module);
  check(
    "onboarding-seed.ts has no runtime import/require (loadable by node, the wizard page and the route)",
    !nonTypeImport && !requireCall
  );

  const route = stripComments(read(ROUTE_PATH));
  const page = stripComments(read(PAGE_PATH));
  check("the route imports the seed module", /from\s+["']@\/lib\/onboarding-seed["']/.test(route));
  check("the route reads the tenant's institutionType", /institutionType/.test(route) && /defaultSeedFor\(institutionType\)/.test(route));
  check("the route validates a posted institutionType", /isInstitutionType\(body\.school\.institutionType\)/.test(route));
  check("the route returns the type-aware defaults in its status payload", /defaults:\s*defaultSeedFor\(/.test(route));
  check("the route resolves the college half per tenant shape", /resolveCollegeSeed\(/.test(route));
  check("the route seeds the college skeleton", /COLLEGE_SKELETON_SEEDED/.test(route));
  check("the wizard page imports the seed module", /from\s+["']@\/lib\/onboarding-seed["']/.test(page));
  check("the wizard page offers the institution types", /INSTITUTION_TYPES/.test(page) && /INSTITUTION_TYPE_LABELS/.test(page));
  check("the wizard page has a college step", /stepKey === "college"/.test(page));
  check("the wizard page sends the college half", /collegeHalf && college \? \{ college \}/.test(page));
}

const total = passes + failures.length;
console.log(
  failures.length === 0
    ? `\n✅ ONBOARDING SEED OK — ${passes}/${total} checks — shape table == institution, school + college defaults well-formed, refusals explicit, wizard + route wired`
    : `\n❌ ${failures.length} of ${total} onboarding-seed failure(s): ${failures.join(", ")}`
);
process.exit(failures.length === 0 ? 0 : 1);
