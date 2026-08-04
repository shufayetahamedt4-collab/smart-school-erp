import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { signSession, SESSION_COOKIE } from "@/lib/auth";
import { homeForRole } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const identifier = String(body?.identifier || "").trim();
  const password = String(body?.password || "");

  if (!identifier || !password) {
    return NextResponse.json({ error: "Email/phone and password are required." }, { status: 400 });
  }

  const user = await prisma.user.findFirst({
    where: {
      OR: [{ email: identifier.toLowerCase() }, { phone: identifier }],
    },
    include: { school: true },
  });

  if (!user || !bcrypt.compareSync(password, user.passwordHash)) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 401 });
  }

  if (!user.active) {
    return NextResponse.json({ error: "This account has been deactivated." }, { status: 403 });
  }

  if (user.role !== "SUPER_ADMIN" && (!user.school || user.school.status === "SUSPENDED")) {
    return NextResponse.json({ error: "Your school is suspended. Contact the platform admin." }, { status: 403 });
  }

  const session = await signSession({
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    schoolId: user.schoolId,
  });

  await prisma.auditLog.create({
    data: { action: "LOGIN", userId: user.id, schoolId: user.schoolId, entity: "user", entityId: user.id },
  });

  const res = NextResponse.json({
    data: { user: { id: user.id, name: user.name, role: user.role, schoolId: user.schoolId }, redirect: homeForRole(user.role) },
  });
  res.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
