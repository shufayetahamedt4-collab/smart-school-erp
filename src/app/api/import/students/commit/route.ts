import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { resolveBranchId } from "@/lib/branches";
import { getCurrentSessionId } from "@/lib/academic";
import { enrollStudent } from "@/lib/enroll";
import { qrPin } from "@/lib/qr";
import { invalidateStats } from "@/lib/stats-cache";
import { detectMapping, sanitizeMapping } from "@/lib/import/fields";
import { identifierKey } from "@/lib/import/normalize";
import { readHeaders, readStrictRows, MAX_IMPORT_ROWS } from "@/lib/import/request";
import { loadImportContext, validateRows, rowDocId, studentDataFor, type PlanRow } from "@/lib/import/plan";
import {
  ensureFeeSetting,
  fastGuardianUserId,
  fastRowWrites,
  rowHasSibling,
  unusableGuardianPassword,
  GUARDIAN_PROVISION_STATUS,
  type ImporterState,
} from "@/lib/import/write";

/**
 * POST /api/import/students/commit
 *
 * The ONLY endpoint that writes imported data. The client calls it once per
 * chunk (never one giant request), re-sending the same raw cells the preview
 * saw; the server re-validates every chunk before writing, so a client can
 * neither skip validation nor forge resolved ids.
 *
 * Idempotency / safe re-run:
 *   • a row's student id is derived from its identifier (`st_<stable token>`),
 *     so re-sending a chunk (retry) or re-running the whole file re-uses the
 *     SAME document instead of creating a second student — an existing student
 *     is skipped, never duplicated;
 *   • in-file duplicates collapse onto the same id, so the second occurrence is
 *     skipped no matter which chunk it arrives in;
 *   • batch rows have deterministic ids (`ibr_<batch>_<row>`), so progress is
 *     safe to overwrite.
 *
 * `schoolId` always comes from the session. A batch belongs to a school and is
 * refused (404) to any other.
 */

interface RowOutcome {
  status: "OK" | "SKIPPED" | "ERROR";
  studentId?: string | null;
  guardianUserId?: string | null;
  note?: string | null;
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role) || !can(session.role, "admission", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  // Resolve an existing batch FIRST, before anything else about the chunk, so a
  // batch that belongs to another school is refused (404) regardless of the row
  // payload attached to it — school isolation.
  let batch: any = null;
  if (body.batchId) {
    batch = await prisma.importBatch.findUnique({ where: { id: String(body.batchId) } }).catch(() => null);
    if (!batch || batch.schoolId !== schoolId) return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
    if (batch.status === "UNDONE") return NextResponse.json({ error: "This import was undone." }, { status: 409 });
  }

  const headers = readHeaders(body.headers);
  const parsed = readStrictRows(body.rows);
  if (parsed.error || !parsed.rows) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const rawRows = parsed.rows;
  if (rawRows.length > MAX_IMPORT_ROWS) {
    return NextResponse.json({ error: `Too many rows in one chunk (${rawRows.length}).` }, { status: 400 });
  }

  const detected = detectMapping(headers);
  const mapping = { ...detected, ...sanitizeMapping(body.mapping, Math.max(headers.length, 1)) };

  const branchId = await resolveBranchId(session, body.branchId || null);
  const sessionId = await getCurrentSessionId(schoolId);
  const ctx = await loadImportContext(schoolId, branchId, sessionId);

  const { rows: planned, summary } = validateRows(ctx, rawRows, mapping);

  const warnings = planned.filter((r) => r.level === "WARNING").length;
  if (warnings > 0 && body.allowWarnings !== true) {
    return NextResponse.json(
      { error: `${warnings} row(s) need review before import. Confirm that warnings were reviewed to continue.` },
      { status: 409 }
    );
  }

  // ---- create the batch on the first accepted chunk ----
  if (!batch) {
    batch = await prisma.importBatch.create({
      data: {
        schoolId,
        branchId,
        module: "students",
        status: "COMMITTING",
        fileName: String(body.fileName || ""),
        mapping,
        totalRows: Math.max(0, Number(body.totalRows) || rawRows.length),
        createFees: body.createFees === true,
        createdById: session.id,
        created: 0,
        skipped: 0,
        errors: 0,
        warnings: 0,
        guardianReused: 0,
        families: 0,
        processed: 0,
      },
    });
  }

  const createFees = body.createFees === true;
  const importerState: ImporterState = {
    createdGuardianIds: new Set<string>(),
    feeSetting: createFees ? await ensureFeeSetting(schoolId) : null,
  };
  // Existence is decided in memory (seeded from the chunk snapshot, grown as rows
  // are written), so a decision never costs a read.
  const existingStudentIds = new Set(ctx.existingStudentIds);
  // Independent writes queue here and commit as one Firestore write-batch. 400 is
  // the codebase's batch chunk (a Firestore batch caps at 500 ops).
  const pending: any[] = [];
  const flushPending = async () => {
    while (pending.length) {
      const slice = pending.splice(0, 400);
      await prisma.$transaction(slice);
    }
  };

  let created = 0;
  let skipped = 0;
  let rowErrors = 0;
  let rowWarnings = 0;
  let guardianReused = 0;
  let families = 0;
  const rowDocs: Record<string, any>[] = [];

  for (const plan of planned) {
    if (plan.level === "WARNING") rowWarnings++;

    if (!plan.importable) {
      if (plan.action === "SKIP_EXISTING") {
        // This exact row was already imported (re-run / duplicate of an earlier
        // chunk) — a skip, never an error.
        skipped++;
        rowDocs.push(rowDoc(batch.id, schoolId, plan, { status: "SKIPPED", note: "Already imported." }));
      } else {
        rowErrors++;
        rowDocs.push(rowDoc(batch.id, schoolId, plan, { status: "ERROR", note: "Row has validation errors." }));
      }
      continue;
    }

    const studentId = `st_${plan.qrToken}`;
    const admitKey = plan.values.admissionNo ? identifierKey(plan.values.admissionNo) : null;

    // Already on file from a previous chunk/run (or an in-file duplicate already
    // written) → skip. In memory, so no per-row read. This is the guard that
    // makes re-runs safe.
    if (existingStudentIds.has(studentId)) {
      skipped++;
      rowDocs.push(rowDoc(batch.id, schoolId, plan, { status: "SKIPPED", studentId, note: "Already imported." }));
      continue;
    }
    if (admitKey && ctx.studentsByAdmission.get(admitKey)) {
      const clash = ctx.studentsByAdmission.get(admitKey);
      skipped++;
      rowDocs.push(rowDoc(batch.id, schoolId, plan, { status: "SKIPPED", studentId: clash.id, note: "Admission number already on file." }));
      continue;
    }

    const guardianUserId = fastGuardianUserId(plan);
    // A row with an email that matched no account has one provisioned
    // (invite-pending) — the sibling path creates it through `enrollStudent`.
    const guardianProvisioned = !plan.guardianUserId && !!plan.values.guardianEmail;

    try {
      let linkedGuardianId: string | null = null;

      if (rowHasSibling(ctx, plan, guardianUserId)) {
        // Family linking reads a sibling document and writes to it: flush the
        // queued writes so that sibling is visible, then run the kernel, which
        // performs the read-then-write in the correct order. The student is
        // created already carrying its guardian id (matched or provisioned), so
        // the family link resolves the right sibling without a follow-up fix-up.
        await flushPending();
        const enrolled = await enrollStudent({
          schoolId,
          branchId,
          student: studentDataFor(ctx, plan, {
            qrPin: qrPin(),
            guardianUserId: guardianUserId ?? undefined,
            guardianProvisioned,
          }),
          guardian: guardianOptions(plan),
          family: { findExisting: true, guardianPhone: plan.values.guardianPhone },
          fees: createFees ? { ensureDefaults: true, createDefaults: true, includeBranch: true, branchId } : null,
        });
        linkedGuardianId = enrolled.guardianUserId || null;
        // Reuse-by-phone: the matched account is linked explicitly (the kernel only
        // matches by email when creating).
        if (plan.guardianUserId && linkedGuardianId !== plan.guardianUserId) {
          await prisma.student.update({ where: { id: enrolled.student.id }, data: { guardianUserId: plan.guardianUserId } });
          linkedGuardianId = plan.guardianUserId;
        }
        if (enrolled.family) families++;
      } else {
        // No sibling: every write the row needs is an independent create on a
        // known id, so it is grouped into the write-batch instead of paid for
        // one round trip at a time.
        const fast = fastRowWrites(ctx, plan, importerState, { branchId, createFees });
        pending.push(...fast.ops);
        linkedGuardianId = fast.guardianUserId;
        if (pending.length >= 400) {
          const slice = pending.splice(0, 400);
          await prisma.$transaction(slice);
        }
      }

      created++;
      if (plan.action === "REUSE_GUARDIAN") guardianReused++;

      // Teach the in-request maps about the row we just wrote.
      existingStudentIds.add(studentId);
      if (admitKey) ctx.studentsByAdmission.set(admitKey, { id: studentId, name: plan.values.name, classId: plan.values.classId });
      if (guardianUserId) ctx.studentsByGuardianUser.add(guardianUserId);
      if (plan.values.guardianPhone) ctx.studentsByGuardianPhone.add(plan.values.guardianPhone);

      const note =
        plan.action === "REUSE_GUARDIAN"
          ? "Linked to an existing guardian account."
          : guardianProvisioned
            ? "New guardian account provisioned — QR/PIN access slip ready."
            : plan.values.guardianPhone && !plan.values.guardianEmail
              ? "No guardian email — onboarding incomplete (email is the account key)."
              : null;
      rowDocs.push(
        rowDoc(batch.id, schoolId, plan, {
          status: "OK",
          studentId,
          guardianUserId: linkedGuardianId,
          note,
        })
      );
    } catch (e: any) {
      // A single bad row must not abort the chunk: record it and move on so the
      // rest of the file imports and can be retried.
      rowErrors++;
      rowDocs.push(rowDoc(batch.id, schoolId, plan, { status: "ERROR", note: e?.message || "Failed to create student." }));
    }
  }

  // Commit whatever is still queued before the row records are written.
  await flushPending();

  // Persist row records in write-batches (400 at a time, matching the codebase's
  // existing batch limit) so a 200-row chunk is a handful of round trips.
  for (let i = 0; i < rowDocs.length; i += 400) {
    const slice = rowDocs.slice(i, i + 400);
    await prisma.$transaction(slice.map((d) => prisma.importBatchRow.create({ data: d })));
  }

  const cumulative = {
    created: Number(batch.created || 0) + created,
    skipped: Number(batch.skipped || 0) + skipped,
    errors: Number(batch.errors || 0) + rowErrors,
    warnings: Number(batch.warnings || 0) + rowWarnings,
    guardianReused: Number(batch.guardianReused || 0) + guardianReused,
    families: Number(batch.families || 0) + families,
    processed: Number(batch.processed || 0) + planned.length,
  };
  const finalStatus = body.final === true ? (cumulative.errors > 0 ? "PARTIAL" : "DONE") : "COMMITTING";

  const updated = await prisma.importBatch.update({
    where: { id: batch.id },
    data: { ...cumulative, status: finalStatus, updatedAt: new Date(), finishedAt: body.final === true ? new Date() : null },
  });

  invalidateReferenceCache(schoolId);
  invalidateStats(schoolId, "students");

  if (body.final === true) {
    await audit("STUDENT_IMPORT", "importBatch", batch.id, {
      created: cumulative.created,
      skipped: cumulative.skipped,
      errors: cumulative.errors,
      warnings: cumulative.warnings,
      guardianReused: cumulative.guardianReused,
      families: cumulative.families,
    });
  }

  return NextResponse.json({
    data: {
      batchId: batch.id,
      status: finalStatus,
      chunk: { processed: planned.length, created, skipped, errors: rowErrors, warnings: rowWarnings, guardianReused, families },
      totals: {
        processed: cumulative.processed,
        totalRows: Number(updated.totalRows || 0),
        created: cumulative.created,
        skipped: cumulative.skipped,
        errors: cumulative.errors,
        warnings: cumulative.warnings,
        guardianReused: cumulative.guardianReused,
        families: cumulative.families,
      },
      summary,
    },
  });
}

/**
 * Guardian options for the kernel: reuse an existing account, else provision one
 * by email. A provisioned account gets a random, unusable password and the
 * invite-pending marker instead of the shared default password, so bulk import
 * never depends on a platform-wide secret.
 */
function guardianOptions(plan: PlanRow) {
  if (plan.guardianUserId) return { create: false };
  if (plan.values.guardianEmail) {
    return {
      create: true,
      email: plan.values.guardianEmail,
      name: plan.values.guardianName,
      phone: plan.values.guardianPhone,
      password: unusableGuardianPassword(),
      passwordStatus: GUARDIAN_PROVISION_STATUS,
    };
  }
  return { create: false };
}

function rowDoc(batchId: string, schoolId: string, plan: PlanRow, outcome: RowOutcome): Record<string, any> {
  return {
    id: rowDocId(batchId, plan.rowNumber, plan.key),
    batchId,
    schoolId,
    rowNumber: plan.rowNumber,
    name: plan.values.name || null,
    admissionNo: plan.values.admissionNo || null,
    className: plan.values.className || null,
    level: plan.level,
    action: plan.action,
    status: outcome.status,
    messages: plan.messages,
    qrToken: plan.qrToken,
    studentId: outcome.studentId ?? null,
    guardianUserId: outcome.guardianUserId ?? null,
    note: outcome.note ?? null,
  };
}
