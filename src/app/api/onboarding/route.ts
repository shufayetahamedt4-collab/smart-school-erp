import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { slugify } from "@/lib/utils";
import { can } from "@/lib/permissions";
import {
  type InstitutionType,
  allowedModes,
  hasSchool,
  isInstitutionType,
  normalizeInstitutionType,
} from "@/lib/institution";
import { type SeedCollege, defaultSeedFor, resolveCollegeSeed } from "@/lib/onboarding-seed";
import { collegeProgressCounts, seedCollegeSkeleton } from "@/lib/college-skeleton";

/**
 * PRD §3.3 — Self-serve onboarding wizard.
 *
 * A new school admin completes a guided 5-step setup after signing up:
 *   1. School profile   → name, address, phone, email
 *   2. Admin account    → name, email, password (optional when already logged in)
 *   3. Classes          → e.g. Play, Nursery, Class 1… with sections (A/B)
 *   4. Subjects         → per-class or global defaults
 *   5. Fees             → monthly & admission amounts
 *
 * GET  → onboarding status for the session (or ?schoolId= for SUPER_ADMIN)
 * POST → create the school and everything above in one transaction
 */

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  let schoolId = session.schoolId;
  if (session.role === "SUPER_ADMIN") schoolId = req.nextUrl.searchParams.get("schoolId") ?? null;

  if (!schoolId) {
    // No school yet — wizard should start from scratch.
    // Nothing is stored yet, so there is no tenant shape to read: the wizard
    // starts on SCHOOL and the Super Admin may pick another shape on step 1.
    return NextResponse.json({
      data: {
        onboarded: false,
        school: null,
        institutionType: null,
        defaults: defaultSeedFor("SCHOOL"),
      },
    });
  }

  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  if (!school)
    return NextResponse.json({
      data: {
        onboarded: false,
        school: null,
        institutionType: null,
        defaults: defaultSeedFor("SCHOOL"),
      },
    });

  // The tenant's own shape decides what the wizard offers and seeds. An absent
  // value reads as SCHOOL, so every pre-existing tenant is unaffected.
  const institutionType: InstitutionType = normalizeInstitutionType((school as any).institutionType);

  const [classes, subjects, feeSetting, setup, college] = await Promise.all([
    prisma.classRoom.count({ where: { schoolId } }),
    prisma.subject.count({ where: { schoolId } }),
    prisma.feeSetting.findUnique({ where: { schoolId } }),
    prisma.setting.findUnique({ where: { key: `school.${schoolId}.onboarded` } }),
    // The college half's counts live behind the college-side helper, so this
    // platform route names no college model and `scripts/verify-college-routes.mjs`
    // check 3 stays strict and unexempted (docs/COLLEGE-DECISIONS.md D-4a-2,
    // D-4b-11). A SCHOOL tenant still gets zeros and reads no college collection.
    collegeProgressCounts(schoolId, institutionType),
  ]);

  return NextResponse.json({
    data: {
      onboarded: !!setup,
      school: {
        id: school.id,
        name: school.name,
        slug: school.slug,
        status: school.status,
        institutionType,
      },
      institutionType,
      allowedModes: allowedModes(institutionType),
      // What a tenant of THIS shape starts with: the wizard prefills from this, so
      // a college is offered a college skeleton instead of a school class ladder.
      defaults: defaultSeedFor(institutionType),
      progress: {
        classes,
        subjects,
        fees: !!feeSetting,
        departments: college.departments,
        programs: college.programs,
        courses: college.courses,
      },
    },
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  // A logged-in admin of an existing school can re-run/extend the wizard;
  // SUPER_ADMIN may create schools for others; anonymous signup is not
  // allowed (PRD: onboarding starts from an authenticated admin).
  const isSuper = !!session && session.role === "SUPER_ADMIN";
  if (!session) {
    return NextResponse.json(
      { error: "Sign in with your admin account first, then run the setup wizard." },
      { status: 401 }
    );
  }

  if (!isSuper && !can(session.role, "systemSettings", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // ---- 1. School profile -------------------------------------------------
  const name = String(body?.school?.name || "").trim();
  if (!name) return NextResponse.json({ error: "School name is required." }, { status: 400 });

  const adminName = String(body?.admin?.name || session.name || "").trim();
  const adminEmail = String(body?.admin?.email || session.email || "").trim().toLowerCase();

  const existingSchoolId =
    typeof body?.school?.id === "string" && body.school.id
      ? body.school.id
      : session.schoolId || undefined;

  if (existingSchoolId) {
    // Extend an existing school's setup (add classes/subjects/fees) —
    // school identity fields can be refreshed too.
    const school = await prisma.school.findUnique({ where: { id: String(existingSchoolId) } });
    if (!school) return NextResponse.json({ error: "School not found" }, { status: 404 });
    if (!isSuper && school.id !== session.schoolId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    if (isSuper && !existingSchoolId) {
      return NextResponse.json({ error: "School id is required." }, { status: 400 });
    }

    // The tenant's STORED type is authoritative in extend mode: a type posted to
    // the wizard is ignored on purpose, because changing a tenant's shape is
    // `PATCH /api/schools/[id]`, which owns the approved change rule
    // (`canChangeInstitutionType`).
    const extendType: InstitutionType = normalizeInstitutionType((school as any).institutionType);
    const extendSeed = resolveCollegeSeed(body?.college, extendType, false);
    if (!extendSeed.ok) return NextResponse.json({ error: extendSeed.error }, { status: 400 });
    const result = await applyWizardData(school.id, body, {
      institutionType: extendType,
      isNew: false,
      college: extendSeed.spec,
    });
    await prisma.setting.upsert({
      where: { key: `school.${school.id}.onboarded` },
      update: { value: "1" },
      create: { key: `school.${school.id}.onboarded`, value: "1" },
    });
    await audit("SCHOOL_ONBOARDED", "school", school.id, { mode: "extend" });
    return NextResponse.json({ data: { schoolId: school.id, ...result, extended: true } }, { status: 200 });
  }

  if (!adminEmail) {
    return NextResponse.json({ error: "Admin email is required." }, { status: 400 });
  }

  // ---- unique slug --------------------------------------------------------
  let slug = slugify(name) || "school";
  let unique = slug;
  let n = 1;
  while (await prisma.school.findUnique({ where: { slug: unique } })) {
    unique = `${slug}-${n++}`;
  }
  slug = unique;

  const existingUser = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existingUser) {
    return NextResponse.json(
      { error: "Admin email is already in use. Sign in instead and extend your school setup." },
      { status: 400 }
    );
  }

  // Tenant shape — absent ⇒ SCHOOL; an explicit value must be one of the three,
  // exactly like `POST /api/schools`. This is the wizard half of the fix: a
  // caller can now actually create a COLLEGE tenant through the wizard instead
  // of having the value silently ignored.
  if (body?.school?.institutionType !== undefined && !isInstitutionType(body.school.institutionType)) {
    return NextResponse.json({ error: "institutionType must be SCHOOL, COLLEGE or BOTH." }, { status: 400 });
  }
  const institutionType: InstitutionType = normalizeInstitutionType(body?.school?.institutionType);

  // Validate the college half BEFORE anything is written, so a bad value is a
  // clean 400 rather than a half-created tenant.
  const collegeSeed = resolveCollegeSeed(body?.college, institutionType, true);
  if (!collegeSeed.ok) return NextResponse.json({ error: collegeSeed.error }, { status: 400 });

  const result = (await prisma.$transaction(async (tx) => {
    const school = await tx.school.create({
      data: {
        name,
        slug,
        address: body?.school?.address || null,
        phone: body?.school?.phone || null,
        email: body?.school?.email || null,
        tagline: body?.school?.tagline || null,
        status: "ACTIVE",
        plan: "Pro",
        institutionType,
        themeColor: body?.school?.themeColor || "#4f46e5",
      },
    });

    await tx.setting.upsert({
      where: { key: `school.${school.id}.branding` },
      update: {
        value: JSON.stringify({
          themeColor: body?.school?.themeColor || "#4f46e5",
          logoUrl: body?.school?.logoUrl || "",
          displayName: name,
          tagline: body?.school?.tagline || "",
        }),
      },
      create: {
        key: `school.${school.id}.branding`,
        value: JSON.stringify({
          themeColor: body?.school?.themeColor || "#4f46e5",
          logoUrl: body?.school?.logoUrl || "",
          displayName: name,
          tagline: body?.school?.tagline || "",
        }),
      },
    });

    const adminUser = await tx.user.create({
      data: {
        email: adminEmail,
        name: adminName || "School Administrator",
        role: "SCHOOL_ADMIN",
        schoolId: school.id,
        passwordHash: bcrypt.hashSync(String(body?.admin?.password || "School@123"), 10),
      },
    });

    return { school, adminUser };
  }))!;

  const wizard = await applyWizardData(result.school.id, body, {
    institutionType,
    isNew: true,
    college: collegeSeed.spec,
  });

  await prisma.branch.create({ data: { schoolId: result.school.id, name: "Main Campus" } }).catch(() => undefined);
  await prisma.setting.upsert({
    where: { key: `school.${result.school.id}.onboarded` },
    update: { value: "1" },
    create: { key: `school.${result.school.id}.onboarded`, value: "1" },
  });
  await audit("SCHOOL_ONBOARDED", "school", result.school.id, { name, adminEmail, institutionType });
  return NextResponse.json(
    { data: { schoolId: result.school.id, slug: result.school.slug, ...wizard } },
    { status: 201 }
  );
}

/**
 * Shared wizard-data writer for both create and extend flows.
 * Creates classes (+sections), subjects and fee settings for the school half of
 * the tenant, and the department → programme → course catalogue for the college
 * half. Which halves exist is decided by the tenant's own `institutionType`.
 */
async function applyWizardData(
  schoolId: string,
  body: any,
  opts: { institutionType: InstitutionType; isNew: boolean; college: SeedCollege | null }
): Promise<{
  classesCreated: number;
  sectionsCreated: number;
  subjectsCreated: number;
  departmentsCreated: number;
  programsCreated: number;
  coursesCreated: number;
  mappingsCreated: number;
  fees: unknown;
}> {
  // ---- 3. Classes with sections ------------------------------------------
  // The type-appropriate default seed, in one place: school classes + subjects,
  // college department + programme + courses.
  const seed = defaultSeedFor(opts.institutionType);
  // An OMITTED list on a brand-new tenant means "give me the default seed"; a
  // list that is present — even an empty one — is taken literally. A tenant with
  // no school half never receives school rows, however the caller asks.
  const classDefs: { name: string; sections: string[] }[] = !hasSchool(opts.institutionType)
    ? []
    : Array.isArray(body?.classes)
      ? body.classes
      : body?.classes === undefined && opts.isNew
        ? seed.classes
        : [];
  let classesCreated = 0;
  let sectionsCreated = 0;
  for (const def of classDefs) {
    const className = String(def?.name || "").trim();
    if (!className) continue;
    const exists = await prisma.classRoom.findFirst({ where: { schoolId, name: className } });
    if (exists) continue;
    const cls = await prisma.classRoom.create({
      data: { schoolId, name: className, order: classesCreated },
    });
    classesCreated++;
    const sections = (Array.isArray(def.sections) ? def.sections : []).map((s: any) => String(s).trim()).filter(Boolean);
    if (sections.length) {
      await prisma.section.createMany({
        data: sections.map((s: string) => ({ schoolId, classId: cls.id, name: s })),
      });
      sectionsCreated += sections.length;
    }
  }

  // ---- 4. Subjects ---------------------------------------------------------
  const subjectDefs: { name: string; code?: string }[] = !hasSchool(opts.institutionType)
    ? []
    : Array.isArray(body?.subjects)
      ? body.subjects
      : body?.subjects === undefined && opts.isNew
        ? seed.subjects.map((name) => ({ name }))
        : [];
  let subjectsCreated = 0;
  for (const def of subjectDefs) {
    const subjectName = String(def?.name || "").trim();
    if (!subjectName) continue;
    const exists = await prisma.subject.findFirst({ where: { schoolId, name: subjectName } });
    if (exists) continue;
    await prisma.subject.create({ data: { schoolId, name: subjectName, code: def?.code || null } });
    subjectsCreated++;
  }

  // ---- 5. Fees -------------------------------------------------------------
  // The fee defaults are school-shaped (one monthly + one admission figure), so
  // they belong to the school half of a tenant only — `feeSetting` stays
  // school-only by design (docs/COLLEGE-PLAN-DELTA.md §2). A college-only tenant
  // neither shows a fee step nor receives the rows, however the caller asks: the
  // wizard stopped sending them, and this gate is what makes the rule true for
  // every other caller too. Nothing breaks without the row — `GET
  // /api/fees/settings` falls back to the app defaults and `enrollStudent`
  // creates it on demand.
  let fees: unknown = null;
  const monthlyFee = Number(body?.fees?.monthlyFee);
  const admissionFee = Number(body?.fees?.admissionFee);
  if (hasSchool(opts.institutionType) && (monthlyFee > 0 || admissionFee > 0)) {
    fees = await prisma.feeSetting.upsert({
      where: { schoolId },
      update: {
        ...(monthlyFee > 0 ? { monthlyFee } : {}),
        ...(admissionFee > 0 ? { admissionFee } : {}),
      },
      create: {
        schoolId,
        monthlyFee: monthlyFee > 0 ? monthlyFee : 1500,
        admissionFee: admissionFee > 0 ? admissionFee : 5000,
      },
    });
  }

  // ---- 4b. College half: department → programme → course catalogue ---------
  // Only a tenant whose own `institutionType` runs a college gets these rows; the
  // helper creates the same default seed the wizard offers, so a tenant created
  // here matches one created by hand in the college pages (`branchId` null until
  // the wizard's "Main Campus" branch is created after this call).
  // The writes themselves live in the college-side helper, so this platform route
  // names no college model and `scripts/verify-college-routes.mjs` check 3 stays
  // strict and unexempted (D-4a-2, D-4b-11). The helper re-checks the tenant's
  // `institutionType`, so a school tenant can never receive college rows. The
  // audit row stays here, where the route already records it, unchanged.
  const { departmentsCreated, programsCreated, coursesCreated, mappingsCreated } = await seedCollegeSkeleton(
    schoolId,
    opts.institutionType,
    opts.college
  );
  if (opts.college) {
    await audit("COLLEGE_SKELETON_SEEDED", "school", schoolId, {
      department: opts.college.department.code,
      program: opts.college.program.code,
      courses: coursesCreated,
      mappings: mappingsCreated,
    });
  }

  return {
    classesCreated,
    sectionsCreated,
    subjectsCreated,
    departmentsCreated,
    programsCreated,
    coursesCreated,
    mappingsCreated,
    fees,
  };
}
