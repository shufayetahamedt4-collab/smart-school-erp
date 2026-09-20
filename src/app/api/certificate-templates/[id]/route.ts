import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import {
  validateCertBody,
  validateCertDesign,
  type CertDesign,
  type CertTemplateDoc,
} from "@/lib/certificate";

/**
 * Update / delete a single certificate template. The [id] lookup is always
 * narrowed to the session's school — cross-school access is impossible even
 * with a guessed id (defense in depth on top of the school-scoped reads).
 */
async function loadOwned(id: string, schoolId: string | null): Promise<CertTemplateDoc | null> {
  const tpl = (await prisma.certificateTemplate.findUnique({ where: { id } })) as CertTemplateDoc | null;
  if (!tpl) return null;
  if (schoolId && tpl.schoolId !== schoolId) return null;
  return tpl;
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const schoolId = session.role === "SUPER_ADMIN" ? null : session.schoolId!;
  const tpl = await loadOwned(id, schoolId);
  if (!tpl) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });

  const data: Record<string, unknown> = {};
  if (body.name !== undefined) {
    const name = String(body.name).trim();
    if (!name) return NextResponse.json({ error: "name: template name is required." }, { status: 400 });
    data.name = name.slice(0, 80);
  }
  if (body.bodyEn !== undefined) {
    const errs = validateCertBody(body.bodyEn ?? null, "bodyEn");
    if (errs.length) return NextResponse.json({ error: errs.join(" "), errors: errs }, { status: 400 });
    data.bodyEn = body.bodyEn ? String(body.bodyEn) : null;
  }
  if (body.bodyBn !== undefined) {
    const errs = validateCertBody(body.bodyBn ?? null, "bodyBn");
    if (errs.length) return NextResponse.json({ error: errs.join(" "), errors: errs }, { status: 400 });
    data.bodyBn = body.bodyBn ? String(body.bodyBn) : null;
  }
  if (body.design !== undefined) {
    const errs = validateCertDesign(body.design ?? null, tpl.schoolId);
    if (errs.length) return NextResponse.json({ error: errs.join(" "), errors: errs }, { status: 400 });
    data.design = (body.design as CertDesign) || null;
  }

  if (body.isDefault !== undefined) {
    const isDefault = !!body.isDefault;
    data.isDefault = isDefault;
    if (isDefault) {
      // Clear other defaults for the same (school, type) pair.
      const others = (await prisma.certificateTemplate.findMany({
        where: { schoolId: tpl.schoolId, type: tpl.type, isDefault: true },
      })) as CertTemplateDoc[];
      await Promise.all(
        others.filter((t) => t.id !== tpl.id).map((t) => prisma.certificateTemplate.update({ where: { id: t.id }, data: { isDefault: false } }))
      );
    }
  }

  if (!Object.keys(data).length) {
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  }
  data.updatedAt = new Date();
  const updated = await prisma.certificateTemplate.update({ where: { id: tpl.id }, data });
  await audit("CERT_TEMPLATE_UPDATE", "certificateTemplate", tpl.id, { fields: Object.keys(data) });
  return NextResponse.json({ data: { ...updated, isDefault: !!updated.isDefault } });
}

export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "SUPER_ADMIN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const schoolId = session.role === "SUPER_ADMIN" ? null : session.schoolId!;
  const tpl = await loadOwned(id, schoolId);
  if (!tpl) return NextResponse.json({ error: "Template not found" }, { status: 404 });

  await prisma.certificateTemplate.delete({ where: { id: tpl.id } });
  await audit("CERT_TEMPLATE_DELETE", "certificateTemplate", tpl.id, { name: tpl.name });
  return NextResponse.json({ data: { ok: true } });
}
