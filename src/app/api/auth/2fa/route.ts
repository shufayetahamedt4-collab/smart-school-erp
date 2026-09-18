import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import {
  twoFactorStatus,
  startEnrollment,
  confirmEnrollment,
  disableTwoFactor,
} from "@/lib/twoFactor";

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  return NextResponse.json({ data: await twoFactorStatus(session.id) });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => null);
  const action = String(body?.action || "");

  switch (action) {
    case "start": {
      const { secret, otpauth, backupCodes } = await startEnrollment(session.id, session.email || session.id);
      return NextResponse.json({ data: { secret, otpauth, backupCodes } });
    }
    case "confirm": {
      const ok = await confirmEnrollment(session.id, String(body?.code || ""));
      if (!ok) return NextResponse.json({ error: "Invalid code — check your authenticator app." }, { status: 400 });
      return NextResponse.json({ data: { ok: true } });
    }
    case "disable": {
      const { can } = await import("@/lib/permissions");
      if (!can(session.role, "systemSettings", "full")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      await disableTwoFactor(session.id);
      return NextResponse.json({ data: { ok: true } });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
