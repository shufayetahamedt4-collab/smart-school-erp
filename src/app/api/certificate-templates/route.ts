import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import {
  CERT_PLACEHOLDERS,
  validateCertBody,
  validateCertDesign,
  type CertDesign,
  type CertTemplateDoc,
} from "@/lib/certificate";

/**
 * PRD §9.2 extension — custom certificate templates (per-school).
 *
 * • Only SCHOOL_ADMIN / SUPER_ADMIN can read or write (systemSettings:full).
 * • Every write validates body syntax (plain text + safe placeholders only)
 *   and design (image URLs must live under certificates/{schoolId}/).
 * • isDefault is per (school, type): setting one clears the other defaults.
 */

function requireAdmin(sessionRole: string | undefined): boolean {
  return sessionRole === "SCHOOL_ADMIN" || sessionRole === "SUPER_ADMIN";
}

/** Validate an incoming template payload; returns field errors. */
function validatePayload(body: any, schoolId: string): string[] {
  const errors: string[] = [];
  const name = String(body?.name || "").trim();
  if (!name) errors.push("name: template name is required.");
  if (name.length > 80) errors.push("name: max 80 characters.");
  if (!["TC", "CHARACTER"].includes(body?.type)) {
    errors.push("type: must be TC or CHARACTER.");
  }
  errors.push(...validateCertBody(body?.bodyEn ?? null, "bodyEn"));
  errors.push(...validateCertBody(body?.bodyBn ?? null, "bodyBn"));
  errors.push(...validateCertDesign(body?.design ?? null, schoolId));
  return errors;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!requireAdmin(session?.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  // SUPER_ADMIN may inspect a specific school's templates via ?schoolId=.
  const schoolId =
    session!.role === "SUPER_ADMIN" ? req.nextUrl.searchParams.get("schoolId") || session!.schoolId : session!.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const templates = await prisma.certificateTemplate.findMany({
    where: { schoolId },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json({
    data: {
      placeholders: CERT_PLACEHOLDERS,
      templates: templates.map((t: CertTemplateDoc) => ({
        ...t,
        isDefault: !!t.isDefault,
        design: t.design || null,
      })),
    },
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!requireAdmin(session?.role)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const schoolId = session!.schoolId!;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const errors = validatePayload(body, schoolId);
  if (errors.length) return NextResponse.json({ error: errors.join(" "), errors }, { status: 400 });

  const isDefault = !!body.isDefault;
  const created = await prisma.certificateTemplate.create({
    data: {
      schoolId,
      type: body.type,
      name: String(body.name).trim(),
      isDefault,
      bodyEn: body.bodyEn ? String(body.bodyEn) : null,
      bodyBn: body.bodyBn ? String(body.bodyBn) : null,
      design: (body.design as CertDesign) || null,
    },
  });

  // Default is unique per (school, type).
  if (isDefault) {
    const others = (await prisma.certificateTemplate.findMany({
      where: { schoolId, type: body.type, isDefault: true },
    })) as CertTemplateDoc[];
    await Promise.all(
      others.filter((t) => t.id !== created.id).map((t) => prisma.certificateTemplate.update({ where: { id: t.id }, data: { isDefault: false } }))
    );
  }

  await audit("CERT_TEMPLATE_CREATE", "certificateTemplate", created.id, { name: created.name, type: created.type });
  return NextResponse.json({ data: { ...created, isDefault: !!created.isDefault } }, { status: 201 });
}
