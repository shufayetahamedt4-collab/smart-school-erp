import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { queryId } from "@/lib/utils";
import {
  collegeTermCount,
  collegeTermMonths,
  structureTotal,
  termBillTotal,
  validateCollegeFeeStructure,
} from "@/lib/college-fees";
import {
  loadHeads,
  loadStructure,
  requireCollegeFeesRead,
  requireCollegeFeesWrite,
  serveHead,
  serveStructure,
  targetSchoolId,
} from "@/lib/college-fees-server";

/**
 * College support (Phase 7c) — the college FEE STRUCTURE
 * (collection `collegeFeeStructure`), route `/api/college-fees/structure`.
 *
 * One row per `(programId, termNumber, headId)` (D-7-6): the amount this
 * programme's term charges for that head, plus `required`, `unit`
 * (`STUDENT | COURSE`) and `basis` (`FLAT | PER_CREDIT`) and a note. The head's
 * own `frequency` decides how many times a term bills the row (D-7-7).
 *
 * Validation is 7a's, called here rather than restated — precisely so the rules
 * cannot exist twice. It refuses, by name: a missing programme or head, a
 * non-positive amount, a fractional or out-of-range term (checked against the
 * PROGRAMME's own `durationYears`/`termSystem`), a `PER_CREDIT` basis (D-7-8), an
 * UNKNOWN unit, and an UNKNOWN basis (a typo is never silently stored as the
 * default and then priced).
 *
 * The duplicate `(programId, termNumber, headId)` is a VISIBLE 409 — a refusal,
 * never a silent overwrite (there is deliberately no derived-id entry for this
 * model, 7b).
 *
 * Guard order: session → target tenant → `requireCollege` → the allow-list →
 * `writeGuard` (mutations) → 400 on a foreign programme/head → 404/403 on a
 * foreign row.
 */

/**
 * Is this structure row visible to the caller? A SCHOOL scope sees every row;
 * a BRANCH scope sees only rows of its own branch (a branch-less row is not
 * reachable from a branch scope — the college departments/programmes rule).
 */
function visibleTo(session: { role: string; scope?: string | null; branchId?: string | null }, row: any): boolean {
  return canAccessBranch(session as any, row?.branchId ?? null);
}

/** The programme this tenant owns, or a refusal to return. */
async function ownedProgramme(
  schoolId: string,
  session: { role: string; scope?: string | null; branchId?: string | null },
  programId: string
): Promise<{ ok: true; program: any } | { ok: false; status: number; error: string }> {
  const program: any = await prisma.program.findUnique({ where: { id: programId } });
  if (!program || program.schoolId !== schoolId) {
    return { ok: false, status: 400, error: "Programme not found in this school." };
  }
  if (!canAccessBranch(session as any, program.branchId)) {
    return { ok: false, status: 403, error: "Forbidden" };
  }
  return { ok: true, program };
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  const denied = requireCollegeFeesRead(session);
  if (denied) return denied;

  const programId = queryId(req.nextUrl.searchParams, "programId");
  // An ABSENT term is "no filter" (`queryId` answers `undefined` — `Number(undefined)`
  // would be NaN and refuse a valid read).
  const termRaw = queryId(req.nextUrl.searchParams, "termNumber");
  const termNumber = termRaw === undefined || termRaw === null ? null : Number(termRaw);
  if (termNumber !== null && (!Number.isInteger(termNumber) || termNumber < 1)) {
    return NextResponse.json({ error: "termNumber must be a whole number from 1." }, { status: 400 });
  }

  // A named programme must be one this tenant owns AND one the caller's branch can
  // touch: a foreign or wrong-branch programme is refused, exactly as the write
  // handlers refuse it (never silently answered with other rows).
  const programme = programId ? await ownedProgramme(schoolId, session, programId) : null;
  if (programme && !programme.ok) {
    return NextResponse.json({ error: programme.error }, { status: programme.status });
  }

  const heads = (await loadHeads(schoolId)).map(serveHead);
  const rows = (await loadStructure(schoolId, programId, termNumber))
    .filter((r) => visibleTo(session, r))
    .map(serveStructure)
    .sort(
      (a, b) =>
        String(a.programId).localeCompare(String(b.programId)) ||
        a.termNumber - b.termNumber ||
        String(a.headId).localeCompare(String(b.headId))
    );

  // The term total is stated BOTH ways so the screen can show what the rows add
  // (D-7-6) and what the term will actually bill once the head cadences apply
  // (D-7-7) — the two differ for a MONTHLY head on a six-month term.
  const termSystem = programme && programme.ok ? programme.program.termSystem : null;
  const months = collegeTermMonths(termSystem);

  // 7d (additive): the programme picker's own data. The college fee screens may
  // not use `/api/programs` — the ACCOUNTANT, a D-7-18 writer who owns the
  // college's money, holds no `programs` permission there — so the ONE college
  // read that owns the programme dimension serves the id, the name and the term
  // shape its screens pick from. Nothing else on this route changed, and a
  // caller's own branch scope still decides what it may see.
  const programmes = ((await prisma.program.findMany({ where: { schoolId } })) as any[])
    .filter((p) => canAccessBranch(session as any, p.branchId))
    .map((p) => ({
      id: String(p.id),
      name: String(p.name ?? ""),
      termSystem: p.termSystem ?? null,
      durationYears: Number.isFinite(Number(p.durationYears)) ? Number(p.durationYears) : null,
      termCount: collegeTermCount(Number(p.durationYears), p.termSystem),
    }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));

  const data = {
    rows,
    heads,
    programmes,
    termNumber,
    programId: programId || null,
    termSystem,
    termCount:
      programme && programme.ok
        ? collegeTermCount(Number(programme.program.durationYears), programme.program.termSystem)
        : null,
    rowsTotal: structureTotal(rows),
    billTotal: termBillTotal(rows, heads, months),
    rowCount: rows.length,
  };
  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
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
  const programId = typeof body?.programId === "string" ? body.programId.trim() : "";
  if (!programId) return NextResponse.json({ error: "A structure row needs a programme." }, { status: 400 });
  const program = await ownedProgramme(schoolId, session, programId);
  if (!program.ok) return NextResponse.json({ error: program.error }, { status: program.status });

  const headId = typeof body?.headId === "string" ? body.headId.trim() : "";
  const head: any = headId ? await prisma.collegeFeeHead.findUnique({ where: { id: headId } }) : null;
  if (!head || head.schoolId !== schoolId || !visibleTo(session, head)) {
    return NextResponse.json({ error: "Fee head not found in this school." }, { status: 400 });
  }

  // 7a's ONE validation: PER_CREDIT refused by name, an unknown unit or basis
  // refused, the term bounded by the programme's own terms.
  const checked = validateCollegeFeeStructure(
    { ...body, programId, headId },
    { durationYears: Number(program.program.durationYears), termSystem: program.program.termSystem }
  );
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  // The duplicate is a VISIBLE refusal, never a silent overwrite.
  const duplicates = (await loadStructure(schoolId, programId, checked.row.termNumber)).filter(
    (r) => r.headId === checked.row.headId
  );
  if (duplicates.length) {
    return NextResponse.json(
      { error: "This head is already priced for that programme and term — edit the existing row instead." },
      { status: 409 }
    );
  }

  const created = await prisma.collegeFeeStructure.create({
    data: {
      schoolId,
      branchId: program.program.branchId || null,
      programId,
      termNumber: checked.row.termNumber,
      headId: checked.row.headId,
      amount: checked.row.amount,
      required: checked.row.required,
      unit: checked.row.unit,
      basis: checked.row.basis,
      note: checked.row.note,
    },
  });
  await audit("COLLEGE_FEE_STRUCTURE_CREATE", "collegeFeeStructure", created.id, {
    programId,
    termNumber: checked.row.termNumber,
    headId: checked.row.headId,
    amount: checked.row.amount,
  });
  return NextResponse.json({ data: serveStructure(created) }, { status: 201 });
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
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const existing: any = await prisma.collegeFeeStructure.findUnique({ where: { id } });
  if (!existing || existing.schoolId !== schoolId) {
    return NextResponse.json({ error: "Structure row not found" }, { status: 404 });
  }
  if (!visibleTo(session, existing)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const programId = String(existing.programId ?? "");
  const program = await ownedProgramme(schoolId, session, programId);
  if (!program.ok) return NextResponse.json({ error: program.error }, { status: program.status });

  // Merged onto the stored row before validating, so a partial edit keeps the rest.
  const merged = { ...serveStructure(existing), ...body, programId, headId: existing.headId };
  const headId = String(merged.headId ?? "");
  const head: any = await prisma.collegeFeeHead.findUnique({ where: { id: headId } });
  if (!head || head.schoolId !== schoolId || !visibleTo(session, head)) {
    return NextResponse.json({ error: "Fee head not found in this school." }, { status: 400 });
  }

  const checked = validateCollegeFeeStructure(merged, {
    durationYears: Number(program.program.durationYears),
    termSystem: program.program.termSystem,
  });
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400 });

  // A change of term/head must not collide with another row of the same key.
  const clashing = (await loadStructure(schoolId, programId, checked.row.termNumber)).filter(
    (r) => r.headId === checked.row.headId && r.id !== id
  );
  if (clashing.length) {
    return NextResponse.json(
      { error: "This head is already priced for that programme and term — edit that row instead." },
      { status: 409 }
    );
  }

  await prisma.collegeFeeStructure.update({
    where: { id },
    data: {
      termNumber: checked.row.termNumber,
      amount: checked.row.amount,
      required: checked.row.required,
      unit: checked.row.unit,
      basis: checked.row.basis,
      note: checked.row.note,
    },
  });
  await audit("COLLEGE_FEE_STRUCTURE_UPDATE", "collegeFeeStructure", id, {
    programId,
    termNumber: checked.row.termNumber,
    headId: checked.row.headId,
    amount: checked.row.amount,
  });
  const updated: any = await prisma.collegeFeeStructure.findUnique({ where: { id } });
  return NextResponse.json({ data: serveStructure(updated || { ...merged, id }) });
}

export async function DELETE(req: NextRequest) {
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

  const id = req.nextUrl.searchParams.get("id") || "";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const row: any = await prisma.collegeFeeStructure.findUnique({ where: { id } });
  if (!row || row.schoolId !== schoolId) {
    return NextResponse.json({ error: "Structure row not found" }, { status: 404 });
  }
  if (!visibleTo(session, row)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  // Money already raised is never rewritten (D-7-9): a row whose term has been
  // billed stays, so nothing a family was charged can lose the price behind it.
  const billed = (
    await prisma.collegeFee.findMany({ where: { schoolId, programId: String(row.programId ?? ""), headId: String(row.headId ?? "") } })
  ).filter((c) => Number(c.termNumber) === Number(row.termNumber));
  if (billed.length) {
    return NextResponse.json(
      { error: "This row's term has been billed. Charges cannot be rewritten — edit the row for unbilled terms instead." },
      { status: 409 }
    );
  }

  await prisma.collegeFeeStructure.delete({ where: { id } });
  await audit("COLLEGE_FEE_STRUCTURE_DELETE", "collegeFeeStructure", id, {
    programId: row.programId ?? null,
    termNumber: row.termNumber ?? null,
    headId: row.headId ?? null,
  });
  return NextResponse.json({ data: { ok: true } });
}
