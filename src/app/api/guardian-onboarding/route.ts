import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { can, isBranchScoped, scopeWhere } from "@/lib/permissions";

/**
 * GET /api/guardian-onboarding — Guardian Onboarding Monitor (Phase 5).
 *
 * PATH NOTE (integration 1): this route used to live at `/api/onboarding` on
 * college-support. origin/main added a different feature at that path — the
 * tenant onboarding WIZARD (`GET/POST /api/onboarding`) — so the monitor moved
 * here to keep BOTH features alive (docs/INTEGRATION-LOG.md). Only the PATH
 * changed; every query parameter, response shape and authorization rule is
 * identical to before.
 *
 * A READ-ONLY operations view over the guardian-onboarding state the import
 * pipeline already writes. It derives a status per student, aggregates a
 * summary, lists provisioned accounts left without a child (import undo), and
 * returns the filter options. It never writes anything: no guardian creation,
 * no credential generation, no invitation, no auth change.
 *
 * Status derivation (exact):
 *   guardianOnboarding === "LINKED"             → linked
 *   guardianOnboarding === "CREDENTIALS_READY"  → credentialsReady
 *   guardianOnboarding === "INCOMPLETE"         → incomplete
 *   missing / null / anything else              → legacy
 *
 * A missing marker is NEVER treated as INCOMPLETE — students created outside the
 * bulk-import flow (New Admission / manual) simply have no marker and are
 * unknown, so they are counted as `legacy`.
 *
 * `schoolId` always comes from the session; a branch admin is confined to its
 * own branch via `isBranchScoped`/`scopeWhere`.
 */

type Status = "credentialsReady" | "linked" | "incomplete" | "legacy";

function statusOf(student: any): Status {
  const v = student?.guardianOnboarding;
  if (v === "CREDENTIALS_READY") return "credentialsReady";
  if (v === "LINKED") return "linked";
  if (v === "INCOMPLETE") return "incomplete";
  return "legacy";
}

const STATUS_FILTERS: Record<string, Status> = {
  CREDENTIALS_READY: "credentialsReady",
  LINKED: "linked",
  INCOMPLETE: "incomplete",
  LEGACY: "legacy",
};

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role) || !can(session.role, "studentTeacherInfo", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const sp = req.nextUrl.searchParams;
  const statusParam = (sp.get("status") || "").toUpperCase();
  const classId = sp.get("classId") || "";
  const sectionId = sp.get("sectionId") || "";
  const sessionId = sp.get("sessionId") || "";
  const batchId = sp.get("batchId") || "";
  const q = (sp.get("q") || "").trim().toLowerCase();
  const offset = Math.max(0, Number(sp.get("offset")) || 0);
  const limit = Math.min(500, Math.max(1, Number(sp.get("limit")) || 200));

  // Branch scoping: a branch admin only ever sees its own branch.
  const scoped = isBranchScoped(session);
  // The main admin may drill into a branch with ?branchId= (like the Students page).
  const requestedBranch = sp.get("branchId") || "";
  const branchId = scoped ? session.branchId : requestedBranch || undefined;
  const base = scopeWhere(session, branchId ? { branchId } : {});

  // ---- batch filter: resolve the batch first, and refuse a foreign one (404) ----
  let batchStudentIds: Set<string> | null = null;
  if (batchId) {
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId } }).catch(() => null);
    if (!batch || batch.schoolId !== schoolId) {
      return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
    }
    if (scoped && batch.branchId !== session.branchId) {
      return NextResponse.json({ error: "Import batch not found" }, { status: 404 });
    }
    const rows = (await prisma.importBatchRow.findMany({ where: { batchId } })).filter((r: any) => r.schoolId === schoolId);
    batchStudentIds = new Set(rows.filter((r: any) => r.studentId).map((r: any) => String(r.studentId)));
  }

  const [students, users, classes, sections, sessions, branches, batches] = await Promise.all([
    prisma.student.findMany({ where: base }),
    prisma.user.findMany({ where: base, select: { id: true, name: true, email: true, phone: true, role: true, passwordStatus: true } }),
    prisma.classRoom.findMany({ where: { schoolId }, select: { id: true, name: true, order: true } }),
    prisma.section.findMany({ where: { schoolId }, select: { id: true, name: true, classId: true } }),
    prisma.academicSession.findMany({ where: { schoolId }, select: { id: true, name: true, isCurrent: true } }),
    prisma.branch.findMany({ where: { schoolId }, select: { id: true, name: true } }),
    prisma.importBatch.findMany({ where: { schoolId }, select: { id: true, fileName: true, branchId: true, createdAt: true } }),
  ]);

  // ---- resolve a student's import batch (from its row records), read-only ----
  const batchRows = (await prisma.importBatchRow.findMany({ where: { schoolId } })).filter((r: any) => r.schoolId === schoolId);
  const studentBatch = new Map<string, string>();
  for (const row of batchRows as any[]) {
    if (!row.studentId) continue;
    const sid = String(row.studentId);
    // A student should belong to one batch; first row wins deterministically by batch.
    if (!studentBatch.has(sid)) studentBatch.set(sid, String(row.batchId));
  }

  const classById = new Map((classes as any[]).map((c) => [String(c.id), c]));
  const sectionById = new Map((sections as any[]).map((s) => [String(s.id), s]));

  // ---- full (unpaginated) view for accurate summary + filters ----
  const allStudents = (students as any[]).filter((s) => {
    if (classId && String(s.classId) !== classId) return false;
    if (sectionId && String(s.sectionId) !== sectionId) return false;
    if (sessionId && String(s.sessionId) !== sessionId) return false;
    if (batchStudentIds && !batchStudentIds.has(String(s.id))) return false;
    if (q) {
      const hay = [s.name, s.admissionNo, s.guardianName, s.guardianEmail, s.guardianPhone]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });

  const summary = {
    total: allStudents.length,
    credentialsReady: 0,
    linked: 0,
    incomplete: 0,
    legacy: 0,
    orphanedAccounts: 0,
  };
  for (const s of allStudents) summary[statusOf(s)]++;

  // ---- orphaned provisioned accounts: QR_CREDENTIALS with no student in scope ----
  const referencedGuardians = new Set(
    (students as any[]).filter((s) => s.guardianUserId).map((s) => String(s.guardianUserId))
  );
  const orphanedAccounts = (users as any[])
    .filter((u) => u.role === "GUARDIAN" && u.passwordStatus === "QR_CREDENTIALS" && !referencedGuardians.has(String(u.id)))
    .map((u) => ({ id: String(u.id), name: u.name || null, email: u.email || null, phone: u.phone || null }));
  summary.orphanedAccounts = orphanedAccounts.length;

  // ---- status filter + pagination (applied after the summary) ----
  const wantedStatus = STATUS_FILTERS[statusParam] || null;
  const filtered = wantedStatus ? allStudents.filter((s) => statusOf(s) === wantedStatus) : allStudents;

  const rows = filtered
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")))
    .slice(offset, offset + limit)
    .map((s) => {
      const status = statusOf(s);
      const sid = String(s.id);
      const batch = studentBatch.get(sid) || null;
      return {
        id: sid,
        name: s.name || null,
        admissionNo: s.admissionNo || null,
        classId: s.classId || null,
        className: s.classId ? classById.get(String(s.classId))?.name || null : null,
        sectionId: s.sectionId || null,
        sectionName: s.sectionId ? sectionById.get(String(s.sectionId))?.name || null : null,
        sessionId: s.sessionId || null,
        branchId: s.branchId || null,
        guardianName: s.guardianName || null,
        guardianEmail: s.guardianEmail || null,
        guardianPhone: s.guardianPhone || null,
        guardianUserId: s.guardianUserId || null,
        status,
        batchId: batch,
        canPrintSlip: status === "credentialsReady" && !!batch && !!s.qrToken && !!s.qrPin,
      };
    });

  return NextResponse.json({
    data: {
      summary,
      students: rows,
      total: filtered.length,
      offset,
      limit,
      orphanedAccounts,
      options: {
        classes: (classes as any[]).map((c) => ({ id: c.id, name: c.name, order: c.order })).sort((a, b) => Number(a.order || 0) - Number(b.order || 0)),
        sections: (sections as any[]).map((s) => ({ id: s.id, name: s.name, classId: s.classId })),
        sessions: (sessions as any[]).map((s) => ({ id: s.id, name: s.name, isCurrent: !!s.isCurrent })),
        branches: (branches as any[]).map((b) => ({ id: b.id, name: b.name })),
        batches: (batches as any[])
          .filter((b) => !scoped || b.branchId === session.branchId)
          .map((b) => ({ id: b.id, fileName: b.fileName || null, branchId: b.branchId || null, createdAt: b.createdAt || null }))
          .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || ""))),
      },
    },
  });
}
