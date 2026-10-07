import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit, resolveActiveMode } from "@/lib/auth";
import { MODE_COOKIE, allowedModes, isMode, normalizeInstitutionType } from "@/lib/institution";

/**
 * POST /api/mode — switch the caller's School | College UI mode.
 *
 * This is the ONLY writer of the `ss_mode` cookie (docs/COLLEGE-DECISIONS.md §3,
 * §7). Mode is UI context, never authorization: the request is authenticated and
 * the tenant is resolved server-side, and the requested mode is validated
 * against the tenant's `institutionType` — a value the client cannot influence.
 *
 * Deliberately NOT guarded by `writeGuard`: switching a context is not a
 * tenant-data write, so a school in the subscription grace/locked window must
 * still be able to change what its own admin is looking at. Every other
 * boundary the platform enforces (authentication, tenant resolution,
 * institutionType validation) is applied here exactly as anywhere else.
 *
 * Body: `{ mode: "SCHOOL" | "COLLEGE" }`. A missing, unknown or disallowed mode
 * is a 400 — an explicitly invalid request is never silently downgraded to the
 * default. On success: the cookie is set, `users.lastMode` is persisted, a real
 * switch is audited (`MODE_SWITCH`), and the resolved mode is returned.
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const body = await req.json().catch(() => null);
  const requested = (body as { mode?: unknown } | null)?.mode;
  // Never fall back on an explicitly invalid request.
  if (!isMode(requested)) {
    return NextResponse.json({ error: "Choose a valid mode." }, { status: 400 });
  }

  // The tenant's shape is read here, never taken from the request.
  const school = await prisma.school
    .findUnique({ where: { id: schoolId }, select: { institutionType: true } })
    .catch(() => null);
  const allowed = allowedModes(normalizeInstitutionType((school as any)?.institutionType));
  if (!allowed.includes(requested)) {
    return NextResponse.json(
      { error: "That mode is not available for this institution." },
      { status: 400 }
    );
  }

  const from = await resolveActiveMode(schoolId);
  const to = requested;

  // Persist the preference on the account. Synthetic QR guardian sessions have
  // no user document, so writing one would create a junk account — they keep the
  // session-scoped cookie only.
  if (!String(session.id).startsWith("qr-")) {
    await prisma.user.update({ where: { id: session.id }, data: { lastMode: to } }).catch(() => null);
  }

  // Only a real switch is audited; a same-mode request is a successful no-op and
  // a rejected request returns above, so neither adds audit noise.
  if (from !== to) {
    await audit("MODE_SWITCH", "user", session.id, { from, to });
  }

  const res = NextResponse.json({ data: { mode: to } });
  res.cookies.set(MODE_COOKIE, to, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
  });
  return res;
}
