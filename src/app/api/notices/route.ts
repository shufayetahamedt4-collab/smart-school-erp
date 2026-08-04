import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "GUARDIAN", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || undefined : session.schoolId!;
  if (!schoolId) return NextResponse.json({ data: [] });
  const limit = Number(req.nextUrl.searchParams.get("limit") || 100);

  const notices = await prisma.notice.findMany({
    where: { schoolId },
    include: { school: { select: { name: true } } },
    orderBy: { date: "desc" },
    take: limit,
  });
  return NextResponse.json({ data: notices });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const title = String(body?.title || "").trim();
  const bodyText = String(body?.body || "").trim();
  if (!title) return NextResponse.json({ error: "Title is required." }, { status: 400 });

  const notice = await prisma.notice.create({
    data: {
      schoolId,
      title,
      body: bodyText,
      category: body?.category || "GENERAL",
      date: body?.date ? new Date(body.date) : new Date(),
      createdById: session.id,
    },
  });
  await audit("NOTICE_CREATE", "notice", notice.id, { title });
  return NextResponse.json({ data: notice }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await prisma.notice.delete({ where: { id } });
  await audit("NOTICE_DELETE", "notice", id);
  return NextResponse.json({ data: { ok: true } });
}
