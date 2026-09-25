import { NextResponse } from "next/server";
import { prisma, ON_ROLL_STUDENT } from "@/lib/db";
import { getSession, guardianChildIds } from "@/lib/auth";

/** PRD §5.4 — Sibling/Family Account Linking: all children of one guardian. */
export async function GET() {
  const session = await getSession();
  if (!session || session.role !== "GUARDIAN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // Children linked by guardianUserId and children who share the family id with
  // one of them — the one definition of "this family's children" (lib/auth), so
  // the portal cannot disagree with the pages that authorize a child.
  const ids = await guardianChildIds(session);
  const children = await prisma.student.findMany({
    where: {
      schoolId: session.schoolId!,
      ...ON_ROLL_STUDENT,
      id: { in: ids },
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
