import { NextResponse } from "next/server";
import { prisma } from "@/lib/db";

/** Public endpoint for the §4.1 enquiry form — active schools (names only). */
export async function GET() {
  const schools = await prisma.school.findMany({
    where: { status: { not: "SUSPENDED" } },
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });
  return NextResponse.json({ data: schools });
}
