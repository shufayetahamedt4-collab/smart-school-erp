import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { signSession, SESSION_COOKIE } from "@/lib/auth";
import { sectorHostFor, stripPort, requestHost } from "@/lib/sectors";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const token = String(body?.token || "").trim();
  const pin = String(body?.pin || "").trim();
  const phone = String(body?.phone || "").trim();

  if (!token) return NextResponse.json({ error: "Missing QR token." }, { status: 400 });

  const student = await prisma.student.findUnique({
    where: { qrToken: token },
    include: { school: true },
  });

  if (!student || !student.school || student.school.status === "SUSPENDED") {
    return NextResponse.json({ error: "Invalid QR code or school suspended." }, { status: 404 });
  }

  const pinOk = pin.length > 0 && student.qrPin === pin;
  const phoneOk = phone.length > 0 && !!student.guardianPhone && student.guardianPhone.replace(/\s/g, "") === phone.replace(/\s/g, "");

  if (!pinOk && !phoneOk) {
    return NextResponse.json({ error: "Verification failed. Check the PIN or guardian phone number." }, { status: 401 });
  }

  const session = await signSession({
    id: `qr-${student.id}`,
    name: student.guardianName || student.name,
    email: student.guardianEmail,
    role: "GUARDIAN",
    schoolId: student.schoolId,
    studentId: student.id,
  });

  await prisma.auditLog.create({
    data: { action: "QR_LOGIN", schoolId: student.schoolId, entity: "student", entityId: student.id },
  });

  // Land in the Parents App. The cookie is host-only, so the QR entry point is
  // served on the guardian host (middleware redirects /qr there); if this
  // deployment has no guardian host configured we stay on the current one.
  const host = requestHost(req.headers);
  const target = sectorHostFor(host, "guardian");
  const redirect =
    target && target !== stripPort(host) ? `${new URL(req.url).protocol}//${target}/parent` : "/parent";

  const res = NextResponse.json({ data: { ok: true, redirect } });
  res.cookies.set(SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return res;
}
