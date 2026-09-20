import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { slugify } from "@/lib/utils";
import { can } from "@/lib/permissions";

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
    return NextResponse.json({ data: { onboarded: false, school: null } });
  }

  const school = await prisma.school.findUnique({ where: { id: schoolId } });
  if (!school) return NextResponse.json({ data: { onboarded: false, school: null } });

  const [classes, subjects, feeSetting, setup] = await Promise.all([
    prisma.classRoom.count({ where: { schoolId } }),
    prisma.subject.count({ where: { schoolId } }),
    prisma.feeSetting.findUnique({ where: { schoolId } }),
    prisma.setting.findUnique({ where: { key: `school.${schoolId}.onboarded` } }),
  ]);

  return NextResponse.json({
    data: {
      onboarded: !!setup,
      school: { id: school.id, name: school.name, slug: school.slug, status: school.status },
      progress: { classes, subjects, fees: !!feeSetting },
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

    const result = await applyWizardData(school.id, body, { createAdmin: false });
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

  const wizard = await applyWizardData(result.school.id, body, { createAdmin: false });

  await prisma.branch.create({ data: { schoolId: result.school.id, name: "Main Campus" } }).catch(() => undefined);
  await prisma.setting.upsert({
    where: { key: `school.${result.school.id}.onboarded` },
    update: { value: "1" },
    create: { key: `school.${result.school.id}.onboarded`, value: "1" },
  });
  await audit("SCHOOL_ONBOARDED", "school", result.school.id, { name, adminEmail });
  return NextResponse.json(
    { data: { schoolId: result.school.id, slug: result.school.slug, ...wizard } },
    { status: 201 }
  );
}

/**
 * Shared wizard-data writer for both create and extend flows.
 * Creates classes (+sections), subjects and fee settings.
 */
async function applyWizardData(
  schoolId: string,
  body: any,
  _opts: { createAdmin: boolean }
): Promise<{ classesCreated: number; sectionsCreated: number; subjectsCreated: number; fees: unknown }> {
  // ---- 3. Classes with sections ------------------------------------------
  const classDefs: { name: string; sections: string[] }[] = Array.isArray(body?.classes) ? body.classes : [];
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
  const subjectDefs: { name: string; code?: string }[] = Array.isArray(body?.subjects) ? body.subjects : [];
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
  let fees: unknown = null;
  const monthlyFee = Number(body?.fees?.monthlyFee);
  const admissionFee = Number(body?.fees?.admissionFee);
  if (monthlyFee > 0 || admissionFee > 0) {
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

  return { classesCreated, sectionsCreated, subjectsCreated, fees };
}
