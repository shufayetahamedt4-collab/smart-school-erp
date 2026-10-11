import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";
import { normalizeCollegeFeeConfig } from "@/lib/college-fees";
import {
  collegeFeeConfigId,
  loadCollegeFeeConfig,
  requireCollegeFeesRead,
  requireCollegeFeesWrite,
  serveConfig,
  targetSchoolId,
} from "@/lib/college-fees-server";

/**
 * College support (Phase 7c) — the college's OWN payment config
 * (collection `collegeFeeConfig`), route `/api/college-fees/config` (D-7-3).
 *
 * Where the money is sent: the same `PaymentChannel` shape the school uses
 * (`src/lib/fee-channels.ts`), plus a payment note and a currency label. It is a
 * college row and the school's `feeSetting` is neither read nor extended (D-7-3,
 * the delta's §2 ruling) — v1 keeps ONE config per tenant, written at a
 * deterministic id (`cfc_<schoolId>`) so a save can never create a second one.
 *
 * Guard order: session → target tenant → `requireCollege` → the allow-list →
 * `writeGuard` (the PATCH).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  const denied = requireCollegeFeesRead(session);
  if (denied) return denied;

  const config = await loadCollegeFeeConfig(schoolId);
  return NextResponse.json({ data: serveConfig(schoolId, config) });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  const denied = requireCollegeFeesWrite(session);
  if (denied) return denied;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const current = await loadCollegeFeeConfig(schoolId);
  const merged = {
    channels: body?.channels !== undefined ? body.channels : current.channels,
    paymentNote: body?.paymentNote !== undefined ? body.paymentNote : current.paymentNote,
    currency: body?.currency !== undefined ? body.currency : current.currency,
  };
  // 7a's ONE normalisation: an array of channel objects, a bounded note, and a
  // currency label that is never blank.
  const normalized = normalizeCollegeFeeConfig(merged);

  await prisma.collegeFeeConfig.create({
    data: { id: collegeFeeConfigId(schoolId), schoolId, ...normalized },
  });
  await audit("COLLEGE_FEE_CONFIG_UPDATE", "collegeFeeConfig", collegeFeeConfigId(schoolId), {
    channels: normalized.channels.length,
    currency: normalized.currency,
    note: normalized.paymentNote ? "set" : null,
  });
  return NextResponse.json({ data: serveConfig(schoolId, normalized) });
}
