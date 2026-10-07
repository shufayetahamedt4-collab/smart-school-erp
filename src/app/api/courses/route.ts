import { NextRequest, NextResponse } from "next/server";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, requireCollege, audit } from "@/lib/auth";
import { can, scopeWhere, canAccessBranch } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { queryId } from "@/lib/utils";

/**
 * College support (Phase 3b) — the course catalogue (collection `courses`).
 *
 * A course belongs to a DEPARTMENT of the SAME tenant (`departmentId` required),
 * and inherits that department's branch. Marks, attendance and programme
 * registration do NOT link to a course yet — that is the open decision recorded
 * in docs/COLLEGE-DECISIONS.md §10 (D-3-6); the programme→course mapping arrives
 * in 3c as its own collection (`programCourses`).
 *
 * `(schoolId, code)` is unique, enforced in-code with `findFirst` (the store has
 * no DB unique index) — the same rule as a department or a program.
 *
 * Guard order in EVERY handler:
 *   1. session                 → 401
 *   2. target tenant schoolId  → 400   (SUPER_ADMIN: resolved ?schoolId=; else session.schoolId)
 *   3. requireCollege(schoolId) → 403   FIRST authorization check, on the TARGET tenant
 *   4. can(role, "courses", …) → 403
 *   5. writeGuard(schoolId)     → 402   (mutations only)
 */

/** The kinds of course the catalogue supports. */
const COURSE_TYPES = ["THEORY", "PRACTICAL"] as const;

/** A course cannot carry more credits than a full degree year — an absurd value is a typo. */
const MAX_CREDIT_HOURS = 30;

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

/**
 * Optional credit hours. An absent/empty/null value means "this course carries
 * no credits" (HSC, most school-style subjects) and stores `null`. When present
 * it must be a POSITIVE number (so 0 and negatives are refused) with at most two
 * decimals, at most `MAX_CREDIT_HOURS`.
 *
 * Returns `undefined` for "not provided", `null` for "explicitly no credits",
 * or a number. Throws nothing — the caller distinguishes the three cases by the
 * sentinel below.
 */
const CREDIT_INVALID = Symbol("invalid-credits");
function parseCreditHours(v: unknown): number | null | undefined | typeof CREDIT_INVALID {
  if (v === undefined) return undefined; // field not mentioned → leave unchanged
  if (v === null || v === "") return null; // explicitly no credits
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) return CREDIT_INVALID;
  if (n <= 0) return CREDIT_INVALID; // 0 and negatives are not positive credits
  if (n > MAX_CREDIT_HOURS) return CREDIT_INVALID;
  // Two decimals is the most any transcript prints; more is a typo, not data.
  if (Math.round(n * 100) / 100 !== n) return CREDIT_INVALID;
  return n;
}

export async function GET(req: NextRequest) {
  // 1. session
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  // 2. target tenant
  const schoolId = targetSchoolId(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  // 3. COLLEGE gate FIRST — the target tenant, before can() and every read.
  const gate = await requireCollege({ schoolId });
  if (gate) return gate;
  // 4. permission
  if (!can(session.role, "courses", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Branch scoping (PRD §12.3): a branch admin sees only their own branch's rows.
  // A course stores the branch it inherited from its department, so this is a
  // direct filter — no join.
  const scoped = session.role === "SUPER_ADMIN" ? { schoolId } : scopeWhere(session);
  const [courses, departments] = await Promise.all([
    prisma.course.findMany({ where: scoped }),
    prisma.department.findMany({ where: { schoolId }, select: { id: true, name: true } }),
  ]);

  // Optional ?departmentId= filter — applied in memory ON TOP of the tenant/branch
  // scope, so a foreign department id can only ever narrow the result to zero.
  const departmentIdFilter = queryId(req.nextUrl.searchParams, "departmentId");
  const deptName = new Map<string, string>((departments as any[]).map((d) => [d.id, d.name]));

  const data = (courses as any[])
    .filter((c) => !departmentIdFilter || c.departmentId === departmentIdFilter)
    .map((c) => ({ ...c, departmentName: deptName.get(c.departmentId) || null }))
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));

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
  if (!can(session.role, "courses", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  // 5. subscription write guard
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const code = readString(body?.code);
  const title = readString(body?.title);
  const departmentId = readString(body?.departmentId);
  if (!code) return NextResponse.json({ error: "Course code is required." }, { status: 400 });
  if (!title) return NextResponse.json({ error: "Course title is required." }, { status: 400 });
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
  // A branch admin may only hang a course off a department in their own branch.
  if (!canAccessBranch(session, (department as any).branchId)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  // Validation of the course's own fields.
  const type = readString(body?.type) || "THEORY";
  if (!COURSE_TYPES.includes(type as (typeof COURSE_TYPES)[number])) {
    return NextResponse.json(
      { error: `type must be one of: ${COURSE_TYPES.join(", ")}.` },
      { status: 400 }
    );
  }
  const creditHours = parseCreditHours(body?.creditHours);
  if (creditHours === CREDIT_INVALID) {
    return NextResponse.json(
      { error: `creditHours must be a positive number of at most ${MAX_CREDIT_HOURS} (or omitted).` },
      { status: 400 }
    );
  }

  // (schoolId, code) uniqueness — in-code, per tenant.
  const exists = await prisma.course.findFirst({ where: { schoolId, code } });
  if (exists) {
    return NextResponse.json({ error: "A course with this code already exists." }, { status: 409 });
  }

  // The branch is inherited from the department; a course is never branch-less
  // when its department has a branch.
  const branchId = (department as any).branchId || null;
  const status = body?.status === "INACTIVE" ? "INACTIVE" : "ACTIVE";

  const course = await prisma.course.create({
    data: {
      schoolId,
      departmentId,
      branchId,
      code,
      title,
      // `undefined` (field not sent) and `null` (explicitly no credits) both store null;
      // the invalid sentinel already returned above, so only a number reaches here.
      creditHours: creditHours ?? null,
      type,
      status,
    },
  });
  await audit("COURSE_CREATE", "course", course.id, { schoolId, departmentId, code });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({ data: course }, { status: 201 });
}
