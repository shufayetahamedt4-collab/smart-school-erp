import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import type { FeeLineType } from "@/lib/db";

const LINE_TYPES: FeeLineType[] = ["TUITION", "ADMISSION", "EXAM", "TRANSPORT", "HOSTEL", "LIBRARY_FINE", "LATE_FEE", "OTHER"];

/** PRD §10.3 — per-class fee templates with line items. */
export async function GET() {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const templates = await prisma.feeTemplate.findMany({
    where: { schoolId: session.schoolId! },
    include: { items: { orderBy: { createdAt: "asc" } }, classRoom: { select: { id: true, name: true } } },
    orderBy: { createdAt: "desc" },
  });
  return NextResponse.json({ data: templates });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  if (!name) return NextResponse.json({ error: "Template name is required." }, { status: 400 });

  const items: { title: string; type: string; amount: number }[] = Array.isArray(body?.items) ? body.items : [];
  const template = await prisma.feeTemplate.create({
    data: {
      schoolId,
      name,
      classId: body?.classId || null,
      items: {
        create: items
          .filter((i) => i.title && Number(i.amount) > 0)
          .map((i) => ({
            title: String(i.title),
            type: LINE_TYPES.includes(i.type as FeeLineType) ? i.type : "OTHER",
            amount: Number(i.amount),
          })),
      },
    },
    include: { items: true },
  });
  await audit("FEE_TEMPLATE_CREATE", "feeTemplate", template.id, { name });
  return NextResponse.json({ data: template }, { status: 201 });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "feePayment", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const template = await prisma.feeTemplate.findUnique({ where: { id } });
  if (!template || template.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  await prisma.feeTemplateItem.deleteMany({ where: { templateId: id } });
  await prisma.feeTemplate.delete({ where: { id } });
  await audit("FEE_TEMPLATE_DELETE", "feeTemplate", id);
  return NextResponse.json({ data: { ok: true } });
}
