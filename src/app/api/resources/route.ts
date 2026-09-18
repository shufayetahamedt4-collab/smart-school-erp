import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";

/**
 * PRD §6.2 — Digital Teaching Material Library.
 * Mandatory Class→Subject→Section→Semester tagging at upload; content is
 * auto-filtered to that class's students/guardians. View/download analytics
 * per teacher. Versioning: supersede keeps the old version linked.
 */

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;

  const where: any = { schoolId, supersededById: null };
  if (sp.get("classId")) where.classId = sp.get("classId");
  if (sp.get("subjectId")) where.subjectId = sp.get("subjectId");
  if (sp.get("sectionId")) where.sectionId = sp.get("sectionId");
  if (sp.get("semester")) where.semester = sp.get("semester");

  // §6.2 auto-filter: guardians/students only see their own class's materials.
  if (session.role === "GUARDIAN") {
    const student = await prisma.student.findFirst({
      where: { id: session.studentId || undefined, guardianUserId: session.id },
    }) || await prisma.student.findFirst({ where: { guardianUserId: session.id } });
    if (student) {
      where.classId = student.classId;
      if (student.sectionId) where.sectionId = student.sectionId;
    } else {
      return NextResponse.json({ data: [] });
    }
  } else if (session.role === "STUDENT") {
    const student = await prisma.student.findFirst({ where: { userId: session.id } });
    if (student) {
      where.classId = student.classId;
      if (student.sectionId) where.sectionId = student.sectionId;
    } else {
      return NextResponse.json({ data: [] });
    }
  } else if (session.role === "TEACHER") {
    where.teacherId = (await prisma.teacher.findUnique({ where: { userId: session.id } }))?.id;
  } else if (!can(session.role, "teachingMaterial", "full") && session.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const items = await prisma.resource.findMany({
    where,
    include: {
      classRoom: { select: { name: true } },
      subject: { select: { name: true } },
      section: { select: { name: true } },
      teacher: { select: { name: true } },
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });
  return NextResponse.json({ data: items });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "teachingMaterial", "upload") && !can(session.role, "teachingMaterial", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const title = String(body?.title || "").trim();
  // Mandatory tagging (§6.2)
  if (!title || !body?.classId || !body?.subjectId) {
    return NextResponse.json({ error: "Title, class and subject tagging are mandatory." }, { status: 400 });
  }
  const url = String(body?.url || "");
  const linkUrl = String(body?.linkUrl || "");
  if (!url && !linkUrl) return NextResponse.json({ error: "A file upload or video link is required." }, { status: 400 });

  const teacher = await prisma.teacher.findUnique({ where: { userId: session.id }, select: { id: true } });
  const resource = await prisma.resource.create({
    data: {
      schoolId: session.schoolId!,
      title,
      description: body?.description || null,
      kind: body?.kind || "PDF",
      url: url || null,
      linkUrl: linkUrl || null,
      classId: String(body.classId),
      subjectId: String(body.subjectId),
      sectionId: body?.sectionId ? String(body.sectionId) : null,
      semester: body?.semester ? String(body.semester) : null,
      teacherId: teacher?.id || null,
      version: 1,
    },
  });
  await audit("RESOURCE_UPLOAD", "resource", resource.id, { title });
  return NextResponse.json({ data: resource }, { status: 201 });
}

/** Track a view/download (analytics for "most viewed/downloaded" §6.2). */
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");
  const kind = body?.action === "download" ? "downloads" : "views";
  const resource = await prisma.resource.findUnique({ where: { id } });
  if (!resource || resource.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const updated = await prisma.resource.update({
    where: { id },
    data: kind === "views" ? { views: { increment: 1 } } : { downloads: { increment: 1 } },
  });
  return NextResponse.json({ data: { views: updated.views, downloads: updated.downloads } });
}

/** Versioning (§6.2): uploading a new version supersedes the old one. */
export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "teachingMaterial", "upload") && !can(session.role, "teachingMaterial", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const oldId = String(body?.supersedeId || "");
  const old = await prisma.resource.findUnique({ where: { id: oldId } });
  if (!old || old.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Original resource not found" }, { status: 404 });
  }
  const resource = await prisma.resource.create({
    data: {
      schoolId: old.schoolId,
      title: body?.title || old.title,
      description: body?.description || old.description,
      kind: body?.kind || old.kind,
      url: body?.url || old.url,
      linkUrl: body?.linkUrl || old.linkUrl,
      classId: old.classId,
      subjectId: old.subjectId,
      sectionId: old.sectionId,
      semester: old.semester,
      teacherId: old.teacherId,
      version: old.version + 1,
      supersedesId: oldId,
    },
  });
  await prisma.resource.update({ where: { id: oldId }, data: { supersededById: resource.id } });
  await audit("RESOURCE_VERSION", "resource", resource.id, { version: resource.version });
  return NextResponse.json({ data: resource }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "teachingMaterial", "upload") && !can(session.role, "teachingMaterial", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const resource = await prisma.resource.findUnique({ where: { id } });
  if (!resource || resource.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  // Teachers may only delete their own uploads.
  if (session.role === "TEACHER") {
    const teacher = await prisma.teacher.findUnique({ where: { userId: session.id }, select: { id: true } });
    if (resource.teacherId !== teacher?.id) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  await prisma.resource.delete({ where: { id } });
  await audit("RESOURCE_DELETE", "resource", id);
  return NextResponse.json({ data: { ok: true } });
}
