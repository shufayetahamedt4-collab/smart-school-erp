import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, scopeWhere, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import {
  DEFAULT_TERM_SYSTEM,
  TERM_SYSTEMS,
  isTermSystem,
  normalizeTermSystem,
  termCount,
} from "@/lib/college-terms";

/**
 * College support (Phase 2) — programs (collection `programs`).
 *
 * A program belongs to a department (departmentId, required) of the SAME
 * tenant, and inherits that department's branchId by default. `(schoolId, code)`
 * is unique, enforced in-code with `findFirst`.
 *
 * Phase 3c adds `termSystem` (YEARLY | SEMESTER, default YEARLY, missing-safe on
 * read) and, with `durationYears`, the DERIVED term count
 * (`termCount = durationYears × termsPerYear`). Nothing else stores terms: a
 * `programCourse` row points at one of those terms by `termNumber`, so the count
 * must be computed the same way here, in `programs/[id]/courses` and in the page.
 *
 * Guard order in EVERY handler:
 *   1. session                 → 401
 *   2. target tenant schoolId  → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId) → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "programs", …) → 403
 *   5. writeGuard(schoolId)     → 402   (mutations only)
 */

/** The degree levels Phase 2 supports (Bangladesh college/university ladder). */
const DEGREE_LEVELS = ["HSC", "DEGREE_PASS", "HONOURS", "MASTERS", "DIPLOMA"] as const;

/** The tenant this request targets — the SUPER_ADMIN's `?schoolId=`, else the session's own. */
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

/** A valid duration is a whole number of years in [1, 6]. */
function parseDuration(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 && n <= 6 ? n : null;
}

export async function GET(req: NextRequest) {
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission
  if (!can(session.role, "programs", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Branch scoping: a branch admin sees only their own branch's rows.
  const scoped = session.role === "SUPER_ADMIN" ? { schoolId } : scopeWhere(session);
  const [programs, departments] = await Promise.all([
    prisma.program.findMany({ where: scoped }),
    prisma.department.findMany({ where: { schoolId }, select: { id: true, name: true } }),
  ]);

  // Optional ?departmentId= filter — applied in memory ON TOP of the tenant/branch
  // scope, so a foreign department id can only ever narrow the result to zero.
  const departmentIdFilter = req.nextUrl.searchParams.get("departmentId") || null;
  const deptName = new Map<string, string>((departments as any[]).map((d) => [d.id, d.name]));

  const data = (programs as any[])
    .filter((p) => !departmentIdFilter || p.departmentId === departmentIdFilter)
    .map((p) => ({
      ...p,
      // A row written before Phase 3c has no `termSystem`; read it as YEARLY so
      // an old program behaves exactly like a new YEARLY one (no migration).
      termSystem: normalizeTermSystem(p.termSystem),
      termCount: termCount(Number(p.durationYears), p.termSystem),
      departmentName: deptName.get(p.departmentId) || null,
    }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));

  return NextResponse.json({ data });
}

export async function POST(req: NextRequest) {
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission
  if (!can(session.role, "programs", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const name = readString(body?.name);
  const code = readString(body?.code);
  const departmentId = readString(body?.departmentId);
  if (!name) return NextResponse.json({ error: "Program name is required." }, { status: 400 });
  if (!code) return NextResponse.json({ error: "Program code is required." }, { status: 400 });
  if (!departmentId) {
    return NextResponse.json({ error: "A department is required." }, { status: 400 });
  }

  // The department must exist IN THIS SCHOOL and be ACTIVE. A missing or foreign
  // department id is the SAME 400 — never a 404 that would confirm another
  // tenant's department exists.
  const department = await prisma.department.findUnique({ where: { id: departmentId } });
  if (!department || (department as any).schoolId !== schoolId) {
    return NextResponse.json({ error: "Department not found in this school." }, { status: 400 });
  }
  if ((department as any).status && (department as any).status !== "ACTIVE") {
    return NextResponse.json({ error: "The department is not active." }, { status: 400 });
  }
  // A branch admin may only hang a program off a department in their own branch.
  if (!canAccessBranch(session, (department as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Validation of the program's own fields.
  const degreeLevel = readString(body?.degreeLevel);
  if (!DEGREE_LEVELS.includes(degreeLevel as (typeof DEGREE_LEVELS)[number])) {
    return NextResponse.json(
      { error: `degreeLevel must be one of: ${DEGREE_LEVELS.join(", ")}.` },
      { status: 400 }
    );
  }
  const durationYears = parseDuration(body?.durationYears);
  if (durationYears === null) {
    return NextResponse.json({ error: "durationYears must be a whole number from 1 to 6." }, { status: 400 });
  }

  // `termSystem` is optional and defaults to YEARLY; a value that is supplied but
  // not one of the two systems is a 400 (only a MISSING value falls back).
  const termSystem = body?.termSystem === undefined ? DEFAULT_TERM_SYSTEM : readString(body.termSystem);
  if (!isTermSystem(termSystem)) {
    return NextResponse.json(
      { error: `termSystem must be one of: ${TERM_SYSTEMS.join(", ")}.` },
      { status: 400 }
    );
  }

  // (schoolId, code) uniqueness — in-code, per tenant.
  const exists = await prisma.program.findFirst({ where: { schoolId, code } });
  if (exists) {
    return NextResponse.json({ error: "A program with this code already exists." }, { status: 409 });
  }

  // Branch inherits the department's by default; an explicit override is honoured
  // only when the caller may touch that branch.
  let branchId = (department as any).branchId || null;
  if (body?.branchId !== undefined) {
    const override = readString(body.branchId) || null;
    if (!canAccessBranch(session, override)) {
      return NextResponse.json({ error: "You do not have access to this branch." }, { status: 403 });
    }
    branchId = override;
  }
  const status = body?.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";

  const program = await prisma.program.create({
    data: { schoolId, departmentId, name, code, degreeLevel, durationYears, branchId, status, termSystem },
  });
  await audit("PROGRAM_CREATE", "program", program.id, { schoolId, departmentId, name, code, branchId, termSystem });
  invalidateReferenceCache(schoolId);
  return NextResponse.json(
    { data: { ...program, termSystem: normalizeTermSystem((program as any).termSystem), termCount: termCount(durationYears, termSystem) } },
    { status: 201 }
  );
}
