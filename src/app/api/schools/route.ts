import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { slugify } from "@/lib/utils";
import { audit } from "@/lib/auth";

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
  const email = String(body?.adminEmail || "").trim().toLowerCase();
  const password = String(body?.adminPassword || "");
  if (!name || !email || !password) {
    return NextResponse.json({ error: "School name, admin email and password are required." }, { status: 400 });
  }

  let slug = slugify(name) || "school";
  let unique = slug;
  let n = 1;
  while (await prisma.school.findUnique({ where: { slug: unique } })) {
    unique = `${slug}-${n++}`;
  }
  slug = unique;

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) {
    return NextResponse.json({ error: "Admin email is already in use." }, { status: 400 });
  }

  const school = await prisma.$transaction(async (tx) => {
    const s = await tx.school.create({
      data: {
        name,
        slug,
        address: body?.address || null,
        phone: body?.phone || null,
        email: body?.schoolEmail || null,
        tagline: body?.tagline || null,
        status: body?.status || "ACTIVE",
        plan: body?.plan || "Pro",
        feeSetting: {
          create: { monthlyFee: Number(body?.monthlyFee || 1500), admissionFee: Number(body?.admissionFee || 5000) },
        },
      },
    });
    await tx.user.create({
      data: {
        email,
        name: body?.adminName || "School Administrator",
        role: "SCHOOL_ADMIN",
        schoolId: s.id,
        passwordHash: bcrypt.hashSync(password, 10),
      },
    });
    return s;
  });

  await audit("SCHOOL_CREATE", "school", school.id, { name });
  return NextResponse.json({ data: school }, { status: 201 });
}
