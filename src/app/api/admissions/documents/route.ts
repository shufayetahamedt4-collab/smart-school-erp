import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";

/** PRD §4.1 step 2 — document collection (birth certificate, photo, TC, marksheets). */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "admission", "entry") && !can(session.role, "admission", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const body = await req.json().catch(() => null);
  const admissionId = String(body?.admissionId || "");
  const url = String(body?.url || "");
  const kind = String(body?.kind || "OTHER");
  if (!admissionId || !url) return NextResponse.json({ error: "admissionId and url are required." }, { status: 400 });

  const admission = await prisma.admission.findUnique({ where: { id: admissionId } });
  if (!admission || admission.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Admission not found" }, { status: 404 });
  }

  const doc = await prisma.admissionDocument.create({
    data: { admissionId, kind, url, uploadedById: session.id },
  });
  await audit("ADMISSION_DOC_UPLOAD", "admissionDocument", doc.id, { kind });
  return NextResponse.json({ data: doc }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const admissionId = req.nextUrl.searchParams.get("admissionId");
  if (!admissionId) return NextResponse.json({ error: "admissionId required" }, { status: 400 });
  const admission = await prisma.admission.findUnique({
    where: { id: admissionId },
    include: { documents: true },
  });
  if (!admission || admission.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Admission not found" }, { status: 404 });
  }
  return NextResponse.json({ data: admission.documents });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "admission", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const doc = await prisma.admissionDocument.findUnique({ where: { id } });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const admission = await prisma.admission.findUnique({ where: { id: doc.admissionId } });
  if (!admission || admission.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.admissionDocument.delete({ where: { id } });
  return NextResponse.json({ data: { ok: true } });
}
