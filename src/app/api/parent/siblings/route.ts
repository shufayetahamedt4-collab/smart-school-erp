import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";

/** PRD §5.4 — Sibling/Family Account Linking: all children of one guardian. */
export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "GUARDIAN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // All children linked by guardianUserId or familyId.
  const own = await prisma.student.findFirst({ where: { guardianUserId: session.id } });
  const familyId = own?.familyId;
  const children = await prisma.student.findMany({
    where: {
      schoolId: session.schoolId!,
      status: "ACTIVE",
      OR: [
        { guardianUserId: session.id },
        ...(familyId ? [{ familyId }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      admissionNo: true,
      photoUrl: true,
      classRoom: { select: { name: true } },
      section: { select: { name: true } },
      familyId: true,
    },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ data: children });
}
