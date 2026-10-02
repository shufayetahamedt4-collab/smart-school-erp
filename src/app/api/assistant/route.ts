import { NextRequest, NextResponse } from "next/server";
import { getSession, audit } from "@/lib/auth";
import { respond } from "@/lib/assistant/respond";

/**
 * The grounded assistant endpoint.
 *
 * NEW route (nothing existing is modified). It answers ONLY from the signed-in
 * user's own school/records, through the same scoping the portal's routes use,
 * and carries no external model, key or network call.
 *
 * It never writes. A write intent comes back as an `action` descriptor which the
 * client may confirm; confirming calls the EXISTING endpoint, so all validation,
 * permissions and audit already apply.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !["TEACHER", "GUARDIAN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const message = String(body?.message || "").trim();
  if (!message) return NextResponse.json({ error: "message is required." }, { status: 400 });

  const reply = await respond(session, message);
  await audit("ASSISTANT_QUERY", "assistant", undefined, { role: session.role });

  return NextResponse.json({ data: reply });
}
