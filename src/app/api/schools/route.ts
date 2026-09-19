import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { slugify } from "@/lib/utils";
import { audit } from "@/lib/auth";

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schools = await prisma.school.findMany({
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { students: true, teachers: true, users: true } },
      feeSetting: true,
    },
  });
  return NextResponse.json({ data: schools });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  const adminEmail = String(body?.admin?.email || body?.adminEmail || "").trim().toLowerCase();
  const password = String(body?.admin?.password || body?.adminPassword || "");

  if (!name || !adminEmail || !password) {
    return NextResponse.json({ error: "School name, admin email and password are required." }, { status: 400 });
  }

  const planId = String(body?.planId || body?.plan || "").trim();
  const cycle = body?.cycle === "YEARLY" ? "YEARLY" : "MONTHLY";

  let slug = slugify(name) || "school";
  let unique = slug;
  let n = 1;
  while (await prisma.school.findUnique({ where: { slug: unique } })) {
    unique = `${slug}-${n++}`;
  }
  slug = unique;

  const existing = await prisma.user.findUnique({ where: { email: adminEmail } });
  if (existing) {
    return NextResponse.json({ error: "Admin email is already in use." }, { status: 400 });
  }

  let currentPlan = null;
  if (planId) {
    currentPlan = await prisma.plan.findUnique({ where: { id: planId } });
  }

  if (!currentPlan) {
    const fallbackPlan = await prisma.plan.findFirst({
      where: { name: "Basic" },
      orderBy: { createdAt: "asc" },
    });
    currentPlan = fallbackPlan ?? null;
  }

  const result = await prisma.$transaction(async (tx) => {
    const school = await tx.school.create({
      data: {
        name,
        slug,
        address: body?.address || null,
        phone: body?.phone || null,
        email: body?.schoolEmail || body?.email || null,
        tagline: body?.tagline || null,
        status: body?.status || "ACTIVE",
        plan: currentPlan?.name || body?.plan || "Pro",
        themeColor: body?.themeColor || "#4f46e5",
        logoUrl: body?.logoUrl || null,
        feeSetting: {
          create: {
            monthlyFee: Number(body?.monthlyFee || 1500),
            admissionFee: Number(body?.admissionFee || 5000),
          },
        },
      },
    });

    await tx.setting.upsert({
      where: { key: `school.${school.id}.branding` },
      update: {
        value: JSON.stringify({
          themeColor: body?.themeColor || "#4f46e5",
          logoUrl: body?.logoUrl || "",
          displayName: name,
          tagline: body?.tagline || "",
        }),
      },
      create: {
        key: `school.${school.id}.branding`,
        value: JSON.stringify({
          themeColor: body?.themeColor || "#4f46e5",
          logoUrl: body?.logoUrl || "",
          displayName: name,
          tagline: body?.tagline || "",
        }),
      },
    });

    const adminName = String(body?.admin?.name || body?.adminName || "School Administrator");
    const adminUser = await tx.user.create({
      data: {
        email: adminEmail,
        name: adminName,
        role: "SCHOOL_ADMIN",
        schoolId: school.id,
        passwordHash: bcrypt.hashSync(password, 10),
      },
    });

    let subscription = null;
    let invoice = null;

    if (currentPlan) {
      const startedAt = new Date();
      const currentPeriodEnd = addDays(startedAt, 30);
      const trialEndsAt = addDays(startedAt, currentPlan.trialDays || 14);
      const graceEndsAt = addDays(trialEndsAt, 7);

      subscription = await tx.subscription.create({
        data: {
          schoolId: school.id,
          planId: currentPlan.id,
          cycle,
          status: currentPlan.trialDays ? "TRIAL" : "ACTIVE",
          startedAt,
          currentPeriodStart: startedAt,
          currentPeriodEnd,
          trialEndsAt,
          graceEndsAt,
        },
      });

      invoice = await tx.invoice.create({
        data: {
          schoolId: school.id,
          planId: currentPlan.id,
          invoiceNo: `INV-${Date.now()}`,
          amount: Number(currentPlan.price || 0),
          status: "PENDING",
          issueDate: startedAt,
          dueDate: addDays(startedAt, 7),
        },
      });
    }

    await tx.branch.create({
      data: {
        schoolId: school.id,
        name: body?.branchName || "Main Campus",
      },
    }).catch(() => undefined);

    return { school, adminUser, subscription, invoice };
  });

  const schoolId = result?.school?.id ?? null;

  await audit("SCHOOL_CREATE", "school", schoolId ?? undefined, {
    name,
    adminEmail,
    planId: result?.subscription?.planId || currentPlan?.id || null,
  });

  return NextResponse.json({ data: result ?? null }, { status: 201 });
}
