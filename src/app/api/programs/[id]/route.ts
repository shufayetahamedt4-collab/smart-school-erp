import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache, ON_ROLL_STUDENT } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { TERM_SYSTEMS, isTermSystem, normalizeTermSystem, termCount, termLabel } from "@/lib/college-terms";
import { deleteProgrammeRunRow, reconcileProgrammeRunAfterShrink } from "@/lib/college-promotion-server";

/**
 * College support (Phase 2) — update/delete one program.
 *
 * Guard order in EVERY handler:
 *   1. session                 → 401
 *   2. target tenant schoolId  → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId) → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "programs", "full") → 403
 *   5. id present              → 400
 *   6. writeGuard(schoolId)     → 402
 *   7. load row by id AND require row.schoolId === schoolId → else 404
 *   8. canAccessBranch(row.branchId) → 403
 *   9. mapping-aware guards (Phase 3c): a `termSystem` change, or a
 *      `durationYears` decrease below the highest mapped term, answers 409
 *      while any `programCourse` row references this program; both are allowed
 *      once nothing is mapped.
 *  10. on-roll shrink guard (Phase 5b-3): a change that LOWERS the programme's
 *      derived term count answers 409 while any ON-ROLL student of the programme
 *      still sits beyond the new last term; ALUMNI and TRANSFERRED never block.
 *      It runs after the mapping guard and before the write.
 */

const DEGREE_LEVELS = ["HSC", "DEGREE_PASS", "HONOURS", "MASTERS", "DIPLOMA"] as const;

function targetSchoolId(
  session: { role: string; schoolId: string | null },
  req: NextRequest
): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

function readString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function parseDuration(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  if (!can(session.role, "programs", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  // Load by id, confined to the target tenant — a foreign id is NOT FOUND.
  const program = await prisma.program.findUnique({ where: { id } });
  if (!program || (program as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  if (!canAccessBranch(session, (program as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await req.json().catch(() => null);
  const data: Record<string, any> = {};

  if (body?.name !== undefined) {
    const name = readString(body.name);
    if (!name) return NextResponse.json({ error: "Program name cannot be empty." }, { status: 400 });
    data.name = name;
  }
  if (body?.code !== undefined) {
    const code = readString(body.code);
    if (!code) return NextResponse.json({ error: "Program code cannot be empty." }, { status: 400 });
    const clash = await prisma.program.findFirst({ where: { schoolId, code } });
    if (clash && clash.id !== id) {
      return NextResponse.json({ error: "A program with this code already exists." }, { status: 409 });
    }
    data.code = code;
  }
  if (body?.degreeLevel !== undefined) {
    const level = readString(body.degreeLevel);
    if (!DEGREE_LEVELS.includes(level as (typeof DEGREE_LEVELS)[number])) {
      return NextResponse.json(
        { error: `degreeLevel must be one of: ${DEGREE_LEVELS.join(", ")}.` },
        { status: 400 }
      );
    }
    data.degreeLevel = level;
  }
  if (body?.durationYears !== undefined) {
    const durationYears = parseDuration(body.durationYears);
    if (durationYears === null) {
      return NextResponse.json({ error: "durationYears must be a whole number from 1 to 6." }, { status: 400 });
    }
    data.durationYears = durationYears;
  }
  if (body?.termSystem !== undefined) {
    const termSystem = readString(body.termSystem);
    if (!isTermSystem(termSystem)) {
      return NextResponse.json(
        { error: `termSystem must be one of: ${TERM_SYSTEMS.join(", ")}.` },
        { status: 400 }
      );
    }
    data.termSystem = termSystem;
  }
  if (body?.status !== undefined) data.status = body.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";

  // Re-validate the department when it changes, and re-inherit its branch.
  if (body?.departmentId !== undefined) {
    const departmentId = readString(body.departmentId);
    if (!departmentId) {
      return NextResponse.json({ error: "A department is required." }, { status: 400 });
    }
    const department = await prisma.department.findUnique({ where: { id: departmentId } });
    if (!department || (department as any).schoolId !== schoolId) {
      return NextResponse.json({ error: "Department not found in this school." }, { status: 400 });
    }
    if ((department as any).status && (department as any).status !== "ACTIVE") {
      return NextResponse.json({ error: "The department is not active." }, { status: 400 });
    }
    if (!canAccessBranch(session, (department as any).branchId)) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    data.departmentId = departmentId;
    data.branchId = (department as any).branchId || null;
  }
  // An explicit branch override (validated) wins over the inherited branch.
  if (body?.branchId !== undefined) {
    const branchId = readString(body.branchId) || null;
    if (!canAccessBranch(session, branchId)) {
      return NextResponse.json({ error: "You do not have access to this branch." }, { status: 403 });
    }
    data.branchId = branchId;
  }

  // Mapping-aware guards (Phase 3c). The program's `programCourse` rows ARE its
  // terms, so a change that would invalidate them is refused while any exist:
  // switching YEARLY ⇄ SEMESTER renumbers every term, and shrinking
  // `durationYears` can land below a term that is already mapped. Both are
  // allowed once the program has no mappings. Guarded AFTER every field has been
  // validated, so a bad body is still a 400, never a 409.
  const currentSystem = normalizeTermSystem((program as any).termSystem);
  const storedDuration = Number((program as any).durationYears);
  const effectiveSystem = data.termSystem ?? currentSystem;
  const effectiveDuration =
    data.durationYears ?? (Number.isInteger(storedDuration) ? storedDuration : 0);
  const currentTermCount = termCount(storedDuration, currentSystem);
  const nextTermCount = termCount(effectiveDuration, effectiveSystem);
  const mappings = await prisma.programCourse.findMany({ where: { programId: id } });
  if (mappings.length) {
    if (data.termSystem !== undefined && data.termSystem !== currentSystem) {
      return NextResponse.json(
        { error: "Cannot change the term system while courses are mapped to this program." },
        { status: 409 }
      );
    }
    const highestMappedTerm = mappings.reduce(
      (max, row) => Math.max(max, Number((row as any).termNumber) || 0),
      0
    );
    if (highestMappedTerm > nextTermCount) {
      return NextResponse.json(
        {
          error:
            `This would leave ${nextTermCount} term(s), below the highest mapped term ` +
            `(${highestMappedTerm}). Remove the later mappings first.`,
        },
        { status: 409 }
      );
    }
  }

  // Phase 5b-3 — refuse a shrink that would strand on-roll students. Lowering the
  // derived term count (a `durationYears` decrease, or a SEMESTER → YEARLY switch)
  // leaves any student whose `termNumber` is past the new end holding a position
  // the programme no longer has. ON_ROLL_STUDENT is reused verbatim, so ALUMNI and
  // TRANSFERRED never block. Runs after the mapping guard (which owns the term
  // rows) and before the write, and only when the count actually falls.
  if (nextTermCount < currentTermCount) {
    const onRoll = await prisma.student.findMany({
      where: {
        schoolId: (program as any).schoolId,
        programId: id,
        ...ON_ROLL_STUDENT,
      },
      select: { id: true, termNumber: true },
    });
    const beyond = (onRoll as any[]).filter(
      (s) => typeof s.termNumber === "number" && s.termNumber > nextTermCount
    );
    if (beyond.length) {
      return NextResponse.json(
        {
          error:
            `This would end the programme at ${termLabel(nextTermCount, effectiveSystem)} ` +
            `(${nextTermCount} term(s)), but ${beyond.length} on-roll student(s) are already beyond it. ` +
            `Move them within the programme first.`,
        },
        { status: 409 }
      );
    }
  }

  const updated = await prisma.program.update({ where: { id }, data });
  await audit("PROGRAM_UPDATE", "program", id, { schoolId, data });
  invalidateReferenceCache(schoolId);
  // Phase 6-pre 5 — the ladder's run row must not outlive the ladder it described. If
  // this update LOWERED the derived term count, a work list naming a term the programme
  // no longer has could block the ladder for ever (the single-position route would
  // refuse that term). So the run row's `finishTerms` is filtered to the new end.
  // Best effort, AFTER the write and the audit: this route's response, status and audit
  // are unchanged whether or not the row could be reconciled.
  if (nextTermCount < currentTermCount) {
    await reconcileProgrammeRunAfterShrink({ schoolId, programId: id, termCount: nextTermCount });
  }
  return NextResponse.json({
    data: {
      ...updated,
      termSystem: normalizeTermSystem((updated as any).termSystem),
      termCount: termCount(Number((updated as any).durationYears), (updated as any).termSystem),
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  if (!can(session.role, "programs", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const program = await prisma.program.findUnique({ where: { id } });
  if (!program || (program as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Program not found" }, { status: 404 });
  }
  if (!canAccessBranch(session, (program as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Blocked while any course is mapped to this program (Phase 3c), the same way
  // a department is blocked while it still has programs. The mapping is the
  // program's term list, so deleting under it would orphan every term row.
  const mappingCount = await prisma.programCourse.count({ where: { programId: id } });
  if (mappingCount > 0) {
    return NextResponse.json(
      { error: "Cannot delete a program that still has courses mapped to it." },
      { status: 400 }
    );
  }

  // Hard delete. Phase 4a: block while any student is enrolled in this program,
  // the same shape as the mapping guard above — a program a student points at
  // must not vanish from under them.
  const enrolledCount = await prisma.student.count({ where: { programId: id } });
  if (enrolledCount > 0) {
    return NextResponse.json(
      { error: "Cannot delete a program that still has students enrolled in it." },
      { status: 400 }
    );
  }
  await prisma.program.delete({ where: { id } });
  await audit("PROGRAM_DELETE", "program", id, { schoolId });
  invalidateReferenceCache(schoolId);
  // Phase 6-pre 5 — the run row is addressed by a hash of (schoolId, programId), so no
  // prefix scan can find it: a deleted programme would leave an orphan nobody can reach.
  // Best effort, AFTER the delete has succeeded, and it never changes this response.
  await deleteProgrammeRunRow({ schoolId, programId: id });
  return NextResponse.json({ data: { ok: true } });
}
