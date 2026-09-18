import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { findSiblingCandidates } from "@/lib/admission";

/** PRD §4.2/§5.4 — sibling auto-suggest during admission. */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const sp = req.nextUrl.searchParams;
  const candidates = await findSiblingCandidates(
    session.schoolId!,
    sp.get("phone"),
    sp.get("email")
  );
  return NextResponse.json({ data: candidates });
}
