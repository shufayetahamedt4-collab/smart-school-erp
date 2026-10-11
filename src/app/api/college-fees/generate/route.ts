import { NextRequest, NextResponse } from "next/server";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";
import { postToLedger } from "@/lib/ledger";
import { buildGeneration, requireCollegeFeesWrite, targetSchoolId } from "@/lib/college-fees-server";

/**
 * College support (Phase 7c) — charge GENERATION, `POST /api/college-fees/generate`.
 *
 * This is the college counterpart of the school's `/api/fees/generate`, and it
 * keeps that route's two promises (D-7-10):
 *
 *   - **`dryRun` writes nothing** and returns the exact rows a commit would write;
 *   - **a re-run only tops up.** A charge is derived from the enrolment and the
 *     APPROVED registrations, and its id is deterministic — `cf_<student>_<head>_<term>_<sequence>`
 *     (7a) — so generation can only ever create a row that is not there yet. The
 *     write is a conditional CREATE inside a real Firestore transaction
 *     (`$guardedUpdate`), so two simultaneous generations cannot double-create a
 *     charge and neither can reset a row that already carries a payment.
 *
 * Nothing here accepts a charge amount: the client names a programme and a term,
 * and the money comes from the admin's own structure rows.
 *
 * Guard order: session → target tenant → `requireCollege` → the allow-list →
 * `writeGuard` (a COMMIT only — a dry run writes nothing, so it is not locked).
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  const denied = requireCollegeFeesWrite(session);
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const dryRun = body?.dryRun === true || body?.dryRun === "true";
  if (!dryRun) {
    const locked = await writeGuard(schoolId);
    if (locked) return locked;
  }

  const programId = typeof body?.programId === "string" ? body.programId.trim() : "";
  if (!programId) return NextResponse.json({ error: "A programme is required." }, { status: 400 });

  const outcome = await buildGeneration({
    session,
    schoolId,
    programId,
    termNumber: body?.termNumber,
    headIds: body?.headIds,
    includeOptional: body?.includeOptional === true || body?.includeOptional === "true",
    dueDate: body?.dueDate ? String(body.dueDate) : null,
    dryRun,
  });
  if (!outcome.ok) return NextResponse.json({ error: outcome.error }, { status: outcome.status });

  if (!dryRun) {
    await audit("COLLEGE_FEE_GENERATE", "collegeFee", undefined, {
      programId: outcome.programId,
      termNumber: outcome.termNumber,
      students: outcome.totals.students,
      newRows: outcome.totals.newRows,
      existingRows: outcome.totals.existingRows,
      amount: outcome.totals.amount,
      written: outcome.written,
      skippedExisting: outcome.skippedExisting,
    });

    // The award's money reaches the ledger HERE, with the charges it discounted
    // (D-7-13). A percentage has no amount until there is a charge to apply it to,
    // so posting at decision time would state a number nobody could stand behind;
    // this entry and the rows it discounted can never disagree. One entry per
    // award, and none at all when nothing was actually waived.
    for (const entry of outcome.discounts) {
      if (!entry.amount || entry.amount <= 0) continue;
      await postToLedger({
        schoolId,
        kind: "DISCOUNT",
        amount: entry.amount,
        status: "CONFIRMED",
        studentId: null,
        feeId: null,
        actorId: session.id,
        description: `College fee discount applied to ${outcome.programName} ${outcome.termLabel}`,
        meta: {
          collegeDiscountId: entry.awardId,
          programId: outcome.programId,
          termNumber: outcome.termNumber,
        },
      });
    }
  }
  return NextResponse.json({ data: outcome });
}
