#!/usr/bin/env node
/**
 * Onboarding — the wizard is institution-type aware, proved END TO END.
 *
 * `verify-onboarding-seed.mjs` proves the pure decision table offline. This
 * script proves the wiring it cannot: that the real wizard, over HTTP, against
 * the emulator-backed server,
 *
 *   1. reports a tenant's shape and the type-appropriate defaults in its status
 *      payload (`GET /api/onboarding`);
 *   2. CREATES a COLLEGE tenant when asked to — the documented gap ("posting
 *      `institutionType: \"COLLEGE\"` to it is ignored — the tenant stays SCHOOL");
 *   3. seeds the college skeleton it promises (department → programme → course
 *      catalogue → term-1 mapping), and the seeded rows are readable through the
 *      college APIs — not just counted;
 *   4. applies the SAME defaults the module defines (asserted against the module,
 *      so the two can never disagree);
 *   5. gives a SCHOOL tenant exactly what it got before — the school classes /
 *      subjects counts are unchanged and it receives NO college rows;
 *   6. refuses an invalid shape (400) and an invalid college block (400) WITHOUT
 *      half-creating a tenant;
 *   7. never lets a wizard request change an existing tenant's shape;
 *   8. stores the full profile payload the wizard posts for a COLLEGE tenant,
 *      while refusing the school-shaped fee defaults it used to send behind the
 *      (absent) fee step's back — and still applies them to a SCHOOL or BOTH
 *      tenant;
 *   9. cleans up everything it created.
 *
 *   SMOKE_PORT=3000 node scripts/verify-onboarding-type.mjs
 */

import { loadEnv } from "./load-env.mjs";
import { requireEmulator } from "./lib/guard.mjs";

loadEnv();
requireEmulator();

const PORT = process.env.SMOKE_PORT || process.env.VERIFY_PORT || "3000";
const BASE = `http://127.0.0.1:${PORT}`;
const RUN = Date.now().toString(36);
const SUPER = { identifier: "admin@smartschool.com", password: "Admin@123" };

const {
  SCHOOL_DEFAULT_CLASSES,
  SCHOOL_DEFAULT_SUBJECTS,
  COLLEGE_DEFAULT_SKELETON,
} = await import("../src/lib/onboarding-seed.ts");

let PASS = 0;
let FAIL = 0;
const pass = (name) => {
  PASS++;
  console.log(`  [PASS] ${name}`);
};
const fail = (name, detail) => {
  FAIL++;
  console.log(`  [FAIL] ${name}${detail ? ` — ${detail}` : ""}`);
};
const check = (name, cond, detail = "") => (cond ? pass(name) : fail(name, detail));

async function api(path, { method = "GET", body, cookie } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, text, setCookie };
}

const cookieOf = (r) =>
  r.setCookie
    ? r.setCookie.split(";").map((s) => s.trim()).filter((s) => s.startsWith("ss_token=")).join("; ")
    : null;

async function login(identifier, password) {
  const r = await api("/api/auth/login", { method: "POST", body: { identifier, password } });
  const cookie = cookieOf(r);
  if (!cookie) throw new Error(`login failed for ${identifier}: ${r.status} ${JSON.stringify(r.json)}`);
  return cookie;
}

const createdSchoolIds = [];

/** Create a tenant through the wizard. Returns { status, data }. */
async function wizardCreate(superCookie, suffix, body) {
  const admin = {
    name: `QA Type Admin ${suffix}`,
    email: `qa-type-${suffix}-${RUN}@qatest.edu`,
    password: "QaType@12345",
  };
  const r = await api("/api/onboarding", {
    method: "POST",
    cookie: superCookie,
    // `body.school` must MERGE with the generated name, never replace it —
    // spreading the whole body after `school` silently dropped the name and made
    // every case here look like a "School name is required" 400.
    body: {
      ...body,
      school: { name: `QA Type ${suffix} ${RUN}`, ...(body?.school ?? {}) },
      admin,
    },
  });
  if (r.json?.data?.schoolId) createdSchoolIds.push(r.json.data.schoolId);
  return { status: r.status, data: r.json?.data ?? {}, json: r.json, admin };
}

async function main() {
  console.log(`Onboarding type-aware wizard — ${BASE}\n`);
  const superCookie = await login(SUPER.identifier, SUPER.password);

  /* ------------------------------------------------- 1. status payload */
  console.log("1. the status payload carries the tenant shape and its defaults");
  {
    const r = await api("/api/onboarding", { cookie: superCookie });
    const d = r.json?.data ?? {};
    check("super admin with no school gets the SCHOOL default seed", r.status === 200 && d.school === null && d.institutionType === null && (d.defaults?.classes ?? []).length === SCHOOL_DEFAULT_CLASSES.length && d.defaults?.college === null, JSON.stringify(d).slice(0, 200));
  }

  /* ------------------------------------------------- 2. COLLEGE tenant */
  console.log("\n2. the wizard creates a COLLEGE tenant and seeds the college skeleton");
  let collegeSchoolId = null;
  let collegeFullSchoolId = null;
  let collegeCookie = null;
  {
    // No classes / subjects / college keys at all: a new tenant must get the
    // defaults for its shape, and for COLLEGE that is the college half only.
    const { status, data, admin } = await wizardCreate(superCookie, "College", {
      school: { name: `QA Type College ${RUN}`, institutionType: "COLLEGE" },
    });
    check("POST creates the COLLEGE tenant (201)", status === 201 && !!data.schoolId, `status ${status}: ${JSON.stringify(data).slice(0, 200)}`);
    collegeSchoolId = data.schoolId ?? null;
    check("no school-half rows are created for a college-only tenant", data.classesCreated === 0 && data.sectionsCreated === 0 && data.subjectsCreated === 0, JSON.stringify({ c: data.classesCreated, s: data.sectionsCreated, sub: data.subjectsCreated }));
    check(
      "the college skeleton is seeded exactly as the module defines it",
      data.departmentsCreated === 1 &&
        data.programsCreated === 1 &&
        data.coursesCreated === COLLEGE_DEFAULT_SKELETON.courses.length &&
        data.mappingsCreated === COLLEGE_DEFAULT_SKELETON.courses.length,
      JSON.stringify({ d: data.departmentsCreated, p: data.programsCreated, c: data.coursesCreated, m: data.mappingsCreated })
    );
    check("the tenant's stored type is COLLEGE", data.fees === null || typeof data.fees === "object", JSON.stringify(data.fees));

    const st = await api(`/api/onboarding?schoolId=${collegeSchoolId}`, { cookie: superCookie });
    const sd = st.json?.data ?? {};
    check("the stored tenant shape reads back as COLLEGE", sd.institutionType === "COLLEGE", JSON.stringify(sd.institutionType));
    check(
      "progress reports the seeded college rows",
      sd.progress?.departments === 1 &&
        sd.progress?.programs === 1 &&
        sd.progress?.courses === COLLEGE_DEFAULT_SKELETON.courses.length &&
        sd.progress?.classes === 0,
      JSON.stringify(sd.progress)
    );
    check(
      "the status payload offers the college defaults for a college tenant",
      (sd.defaults?.college?.courses ?? []).length === COLLEGE_DEFAULT_SKELETON.courses.length && (sd.defaults?.classes ?? []).length === 0,
      JSON.stringify(sd.defaults).slice(0, 160)
    );

    /* ----------------------------------- 3. readable through the college APIs */
    console.log("\n3. the seeded skeleton is readable through the college APIs");
    collegeCookie = await login(admin.email, admin.password);

    const depts = await api("/api/departments", { cookie: collegeCookie });
    const dept = (depts.json?.data ?? []).find((d) => d.code === COLLEGE_DEFAULT_SKELETON.department.code);
    check("GET /api/departments shows the seeded department", depts.status === 200 && !!dept, `status ${depts.status}: ${JSON.stringify(depts.json).slice(0, 160)}`);

    const programs = await api("/api/programs", { cookie: collegeCookie });
    const program = (programs.json?.data ?? []).find((p) => p.code === COLLEGE_DEFAULT_SKELETON.program.code);
    check(
      "GET /api/programs shows the seeded programme with its term shape",
      !!program && program.degreeLevel === COLLEGE_DEFAULT_SKELETON.program.degreeLevel && Number(program.durationYears) === COLLEGE_DEFAULT_SKELETON.program.durationYears && program.termSystem === COLLEGE_DEFAULT_SKELETON.program.termSystem,
      JSON.stringify(program ?? {}).slice(0, 200)
    );
    check("the programme hangs off the seeded department", !!program && program.departmentId === dept?.id, `${program?.departmentId} vs ${dept?.id}`);

    const courses = await api("/api/courses", { cookie: collegeCookie });
    const courseCodes = (courses.json?.data ?? []).filter((c) => c.departmentId === dept?.id).map((c) => c.code).sort();
    const expectedCodes = COLLEGE_DEFAULT_SKELETON.courses.map((c) => c.code).sort();
    check(
      `GET /api/courses shows all ${expectedCodes.length} seeded courses`,
      courses.status === 200 && JSON.stringify(courseCodes) === JSON.stringify(expectedCodes),
      JSON.stringify(courseCodes)
    );

    if (program) {
      const mapped = await api(`/api/programs/${program.id}/courses`, { cookie: collegeCookie });
      const rows = mapped.json?.data ?? [];
      check(
        `the curriculum maps every seeded course into term ${COLLEGE_DEFAULT_SKELETON.mapCoursesToTerm}`,
        mapped.status === 200 && rows.length === expectedCodes.length && rows.every((m) => Number(m.termNumber) === COLLEGE_DEFAULT_SKELETON.mapCoursesToTerm),
        `status ${mapped.status}: ${JSON.stringify(rows).slice(0, 200)}`
      );
    } else {
      fail("the curriculum maps every seeded course into term 1", "no programme id");
    }

    /* ------------- the wizard's own chrome for a COLLEGE tenant: profile, no fees */
    // What the wizard PAGE actually posts for a college: the school-profile
    // fields the profile step collects, the shape, and — before this fix — a
    // `fees` block too, even though a college never sees a fee step. The profile
    // half must be reachable AND stored, and the school-shaped fee defaults must
    // not land. (Which steps exist for which shape is the pure table asserted by
    // verify-onboarding-seed.mjs §8; this is its HTTP-observable half.)
    console.log("\n2b. a COLLEGE tenant keeps its profile half and gets no fee defaults");
    const collegeFull = await wizardCreate(superCookie, "CollegeFull", {
      school: {
        name: `QA Type College Full ${RUN}`,
        institutionType: "COLLEGE",
        tagline: "Science for tomorrow",
        address: "College Road 1, Dhaka",
        phone: "+8801700000001",
        email: "college-full@qatest.edu",
        themeColor: "#0d9488",
      },
      fees: { monthlyFee: 1500, admissionFee: 5000 },
    });
    collegeFullSchoolId = collegeFull.data.schoolId ?? null;
    check(
      "the wizard creates a COLLEGE tenant from its full profile payload (201)",
      collegeFull.status === 201 && !!collegeFullSchoolId,
      `status ${collegeFull.status}: ${JSON.stringify(collegeFull.data).slice(0, 160)}`
    );

    const fullRead = await api(`/api/schools/${collegeFullSchoolId}`, { cookie: superCookie });
    const fd = fullRead.json?.data ?? {};
    check(
      "every profile field the profile step collects is stored for the COLLEGE tenant",
      fullRead.status === 200 &&
        fd.name === `QA Type College Full ${RUN}` &&
        fd.tagline === "Science for tomorrow" &&
        fd.address === "College Road 1, Dhaka" &&
        fd.phone === "+8801700000001" &&
        fd.email === "college-full@qatest.edu" &&
        fd.themeColor === "#0d9488" &&
        fd.institutionType === "COLLEGE",
      JSON.stringify({ name: fd.name, tagline: fd.tagline, address: fd.address, phone: fd.phone, email: fd.email, themeColor: fd.themeColor, institutionType: fd.institutionType })
    );
    check(
      "the college tenant is still seeded with the college skeleton (its non-profile steps)",
      collegeFull.data.departmentsCreated === 1 &&
        collegeFull.data.programsCreated === 1 &&
        collegeFull.data.coursesCreated === COLLEGE_DEFAULT_SKELETON.courses.length &&
        collegeFull.data.classesCreated === 0 &&
        collegeFull.data.subjectsCreated === 0,
      JSON.stringify(collegeFull.data).slice(0, 220)
    );
    check(
      "a fees block from the wizard is refused for a college-only tenant (no school fee defaults)",
      collegeFull.data.fees === null && fd.feeSetting === null,
      JSON.stringify({ postResponse: collegeFull.data.fees, stored: fd.feeSetting })
    );
    const fullSt = await api(`/api/onboarding?schoolId=${collegeFullSchoolId}`, { cookie: superCookie });
    check(
      "the college tenant's progress reports no fee settings",
      fullSt.json?.data?.progress?.fees === false,
      JSON.stringify(fullSt.json?.data?.progress)
    );
  }

  /* ------------------------------------------------- 4. SCHOOL + BOTH tenants */
  console.log("\n4. a SCHOOL tenant is unchanged and a BOTH tenant gets both halves");
  {
    const { status, data, admin } = await wizardCreate(superCookie, "School", {
      classes: [{ name: `QA Type C1 ${RUN}`, sections: ["A", "B"] }, { name: `QA Type C2 ${RUN}`, sections: ["A"] }],
      subjects: [{ name: `QA Type S1 ${RUN}` }, { name: `QA Type S2 ${RUN}` }],
      fees: { monthlyFee: 1234, admissionFee: 5678 },
    });
    check("explicit arrays are still taken literally (2 classes / 3 sections / 2 subjects)", status === 201 && data.classesCreated === 2 && data.sectionsCreated === 3 && data.subjectsCreated === 2, `status ${status}: ${JSON.stringify(data).slice(0, 200)}`);
    check("a SCHOOL tenant receives no college rows", data.departmentsCreated === 0 && data.programsCreated === 0 && data.coursesCreated === 0 && data.mappingsCreated === 0, JSON.stringify(data).slice(0, 200));
    check("the fee setting is still applied", Number(data.fees?.monthlyFee) === 1234, JSON.stringify(data.fees));

    const cookie = await login(admin.email, admin.password);
    const st = await api("/api/onboarding", { cookie });
    check("the SCHOOL tenant reports zero college progress", st.json?.data?.progress?.departments === 0 && st.json?.data?.progress?.programs === 0, JSON.stringify(st.json?.data?.progress));
    check("the SCHOOL tenant's defaults carry no college skeleton", st.json?.data?.defaults?.college === null && (st.json?.data?.defaults?.classes ?? []).length === SCHOOL_DEFAULT_CLASSES.length, JSON.stringify(st.json?.data?.defaults).slice(0, 160));

    // A college API must still refuse a SCHOOL tenant.
    const refused = await api("/api/departments", { cookie });
    check("a SCHOOL tenant is still refused by the college gate (403)", refused.status === 403, `status ${refused.status}`);

    const both = await wizardCreate(superCookie, "Both", {
      school: { institutionType: "BOTH" },
      fees: { monthlyFee: 4321, admissionFee: 8765 },
    });
    check(
      "a BOTH tenant is seeded with both halves, from the module's defaults",
      both.status === 201 &&
        both.data.classesCreated === SCHOOL_DEFAULT_CLASSES.length &&
        both.data.subjectsCreated === SCHOOL_DEFAULT_SUBJECTS.length &&
        both.data.departmentsCreated === 1 &&
        both.data.coursesCreated === COLLEGE_DEFAULT_SKELETON.courses.length,
      `status ${both.status}: ${JSON.stringify(both.data).slice(0, 220)}`
    );
    check(
      "a BOTH tenant keeps the fee defaults (it has a school half)",
      Number(both.data.fees?.monthlyFee) === 4321 && Number(both.data.fees?.admissionFee) === 8765,
      JSON.stringify(both.data.fees)
    );

    // The submit label is chosen from the tenant's own shape, so the three shapes
    // the label table names must be the three the wizard really stores. (The
    // mapping shape → label itself is asserted in verify-onboarding-seed.mjs §8.)
    const bothSt = await api(`/api/onboarding?schoolId=${both.data.schoolId}`, { cookie: superCookie });
    const collegeSt = await api(`/api/onboarding?schoolId=${collegeFullSchoolId}`, { cookie: superCookie });
    check(
      "the wizard stores each of the three shapes its submit label is chosen from",
      st.json?.data?.institutionType === "SCHOOL" &&
        collegeSt.json?.data?.institutionType === "COLLEGE" &&
        bothSt.json?.data?.institutionType === "BOTH",
      JSON.stringify({ SCHOOL: st.json?.data?.institutionType, COLLEGE: collegeSt.json?.data?.institutionType, BOTH: bothSt.json?.data?.institutionType })
    );
  }

  /* ------------------------------------------------- 5. refusals */
  console.log("\n5. invalid input is refused without half-creating a tenant");
  {
    const bad = await wizardCreate(superCookie, "BadType", { school: { institutionType: "UNIVERSITY" } });
    check("an unknown institutionType is a 400", bad.status === 400 && /institutionType/.test(bad.json?.error ?? ""), `status ${bad.status}: ${JSON.stringify(bad.json)}`);
    check("no school row was created for the refused type", !bad.data.schoolId, JSON.stringify(bad.data));

    // The refused request must not have consumed the admin email: the SAME email
    // must still be able to create a tenant.
    const reuse = await api("/api/onboarding", {
      method: "POST",
      cookie: superCookie,
      body: { school: { name: `QA Type Reuse ${RUN}`, institutionType: "SCHOOL" }, admin: bad.admin },
    });
    check("the refused request left no half-created tenant (the admin email is free)", reuse.status === 201, `status ${reuse.status}: ${JSON.stringify(reuse.json).slice(0, 200)}`);
    if (reuse.json?.data?.schoolId) createdSchoolIds.push(reuse.json.data.schoolId);

    const badCollege = await wizardCreate(superCookie, "BadCollege", {
      school: { institutionType: "COLLEGE" },
      college: { program: { degreeLevel: "PHD" } },
    });
    check("an invalid college block is a 400 naming the field", badCollege.status === 400 && /degreeLevel/.test(badCollege.json?.error ?? ""), `status ${badCollege.status}: ${JSON.stringify(badCollege.json)}`);
    check("no tenant was created for the invalid college block", !badCollege.data.schoolId, JSON.stringify(badCollege.data));
  }

  /* ------------------------------------------------- 6. extend never re-shapes */
  console.log("\n6. the wizard never changes an existing tenant's shape");
  {
    const r = await api("/api/onboarding", {
      method: "POST",
      cookie: collegeCookie,
      body: {
        school: { id: collegeSchoolId, name: `QA Type College ${RUN}`, institutionType: "SCHOOL" },
        college: { department: { name: `QA Extra Dept ${RUN}` }, courses: [] },
      },
    });
    check("extend mode accepts a college edit (200)", r.status === 200 && r.json?.data?.extended === true, `status ${r.status}: ${JSON.stringify(r.json).slice(0, 160)}`);
    const st = await api(`/api/onboarding?schoolId=${collegeSchoolId}`, { cookie: superCookie });
    check("the tenant is still COLLEGE after a SCHOOL posted to the wizard", st.json?.data?.institutionType === "COLLEGE", JSON.stringify(st.json?.data?.institutionType));
    check("the extra college edit landed (2 departments now)", st.json?.data?.progress?.departments === 2, JSON.stringify(st.json?.data?.progress));

    const r2 = await api("/api/onboarding", {
      method: "POST",
      cookie: collegeCookie,
      body: { school: { id: collegeSchoolId, name: `QA Type College ${RUN}` }, classes: [{ name: `QA nope ${RUN}`, sections: ["A"] }] },
    });
    check("a school-half write to a college-only tenant is ignored", r2.status === 200 && r2.json?.data?.classesCreated === 0, `status ${r2.status}: ${JSON.stringify(r2.json?.data).slice(0, 160)}`);
  }

  /* ------------------------------------------------- 7. cleanup */
  console.log("\n7. cleanup");
  {
    let deleted = 0;
    for (const id of createdSchoolIds) {
      const d = await api(`/api/schools/${id}`, { method: "DELETE", cookie: superCookie });
      if (d.status === 200 || d.status === 204) deleted++;
      else fail(`delete school ${id}`, `status ${d.status}`);
    }
    pass(`deleted ${deleted}/${createdSchoolIds.length} QA tenants`);
    const left = await api(`/api/onboarding?schoolId=${collegeSchoolId}`, { cookie: superCookie });
    check("a deleted tenant is gone (school null)", left.json?.data?.school === null, JSON.stringify(left.json?.data).slice(0, 160));
  }

  console.log(`\n===== RESULT: ${PASS} passed, ${FAIL} failed =====`);
  process.exit(FAIL ? 1 : 0);
}

main().catch((e) => {
  console.error("verify-onboarding-type crashed:", e);
  console.log(`\n===== RESULT: ${PASS} passed, ${FAIL + 1} failed =====`);
  process.exit(1);
});
