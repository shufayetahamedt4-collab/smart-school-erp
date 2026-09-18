import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";

/** PRD §7.1 — Photo/Video Gallery (school events, class activities). */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const classId = req.nextUrl.searchParams.get("classId") || undefined;
  const items = await prisma.galleryItem.findMany({
    where: { schoolId: session.schoolId!, ...(classId ? { classId } : {}) },
    orderBy: { date: "desc" },
    take: 100,
    include: { classRoom: { select: { name: true } } },
  });
  return NextResponse.json({ data: items });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "communication", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const url = String(body?.url || "");
  const title = String(body?.title || "").trim();
  if (!url || !title) return NextResponse.json({ error: "Title and URL are required." }, { status: 400 });
  const item = await prisma.galleryItem.create({
    data: {
      schoolId: session.schoolId!,
      title,
      url,
      kind: body?.kind === "VIDEO" ? "VIDEO" : "PHOTO",
      classId: body?.classId || null,
      caption: body?.caption || null,
      date: body?.date ? new Date(body.date) : new Date(),
      uploadedById: session.id,
    },
  });
  await audit("GALLERY_UPLOAD", "galleryItem", item.id, { title });
  return NextResponse.json({ data: item }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "communication", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await prisma.galleryItem.deleteMany({ where: { id, schoolId: session.schoolId } });
  await audit("GALLERY_DELETE", "galleryItem", id);
  return NextResponse.json({ data: { ok: true } });
}
