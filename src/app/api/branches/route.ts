import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can, canAccessBranch, STAFF_ROLES } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";

/**
 * PRD §12.3 — Multi-branch support.
 *
 * A school (e.g. "Sunrise School") can have many branches/campuses. The main
 * School Admin creates branches and grants (or revokes) each branch's
 * permission to use the ERP via `enabled`. SUPER_ADMIN may also flip it from
 * the platform console. Branch-scoped staff only ever see their own branch.
 */

function schoolIdOf(session: { role: string; schoolId: string | null }, req: NextRequest): string | null {
  if (session.role === "SUPER_ADMIN") return req.nextUrl.searchParams.get("schoolId") || null;
  return session.schoolId;
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (session.role !== "SUPER_ADMIN" && !can(session.role, "branches", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = schoolIdOf(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const [branches, students, staff] = await Promise.all([
    prisma.branch.findMany({ where: { schoolId }, orderBy: { name: "asc" } }),
    prisma.student.findMany({ where: { schoolId }, select: { id: true, branchId: true } }),
    prisma.user.findMany({ where: { schoolId, role: { in: STAFF_ROLES } }, select: { id: true, branchId: true } }),
  ]);

  const countBy = (rows: { branchId?: string | null }[]) => {
    const map = new Map<string, number>();
    for (const r of rows) {
      if (!r.branchId) continue;
      map.set(r.branchId, (map.get(r.branchId) || 0) + 1);
    }
    return map;
  };
  const studentsByBranch = countBy(students);
  const staffByBranch = countBy(staff);

  // ---------------------------------------------------------------- monitoring (PRD §12.3)
  // The main admin can see every branch's details: per-branch students,
  // teachers, classes, admission pipeline and fee health. All derived from
  // four parallel school-wide pulls + in-memory grouping (cheap on the
  // Firestore adapter — no per-branch round-trips).
  const canMonitor = session.role === "SCHOOL_ADMIN" || session.role === "SUPER_ADMIN";
  let monitoring: Record<string, any> | null = null;
  if (canMonitor) {
    const [classRows, teacherRows, admissionRows, feeRows] = await Promise.all([
      prisma.classRoom.findMany({ where: { schoolId }, select: { id: true, branchId: true } }),
      prisma.teacher.findMany({ where: { schoolId }, select: { id: true, branchId: true } }),
      prisma.admission.findMany({ where: { schoolId }, select: { id: true, branchId: true, status: true } }),
      prisma.fee.findMany({ where: { schoolId }, select: { id: true, studentId: true, branchId: true, amount: true, paidAmount: true, status: true } }),
    ]);
    const studentBranch = new Map(students.map((s) => [s.id, s.branchId || null]));
    const branchOfFee = (f: { branchId?: string | null; studentId: string }) => f.branchId || studentBranch.get(f.studentId) || null;

    const classesByBranch = countBy(classRows);
    const teachersByBranch = countBy(teacherRows);
    const pipelineByBranch = new Map<string, Record<string, number>>();
    for (const a of admissionRows) {
      if (!a.branchId) continue;
      const m = pipelineByBranch.get(a.branchId) || {};
      m[a.status] = (m[a.status] || 0) + 1;
      pipelineByBranch.set(a.branchId, m);
    }
    const feesByBranch = new Map<string, { total: number; paid: number; due: number; unpaid: number }>();
    for (const f of feeRows) {
      const bid = branchOfFee(f);
      if (!bid) continue;
      const m = feesByBranch.get(bid) || { total: 0, paid: 0, due: 0, unpaid: 0 };
      m.total += Number(f.amount);
      m.paid += Number(f.paidAmount);
      if (f.status !== "PAID") m.due += Number(f.amount) - Number(f.paidAmount);
      if (f.status === "UNPAID") m.unpaid += 1;
      feesByBranch.set(bid, m);
    }

    monitoring = {};
    for (const b of branches) {
      const fees = feesByBranch.get(b.id) || { total: 0, paid: 0, due: 0, unpaid: 0 };
      monitoring[b.id] = {
        students: studentsByBranch.get(b.id) || 0,
        staff: staffByBranch.get(b.id) || 0,
        classes: classesByBranch.get(b.id) || 0,
        teachers: teachersByBranch.get(b.id) || 0,
        pipeline: pipelineByBranch.get(b.id) || {},
        fees,
      };
    }
  }

  const data = branches.map((b: any) => ({
    ...b,
    _count: { students: studentsByBranch.get(b.id) || 0, staff: staffByBranch.get(b.id) || 0 },
    ...(monitoring ? { monitoring: monitoring[b.id] } : {}),
  }));

  return NextResponse.json({ data });
}
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "branches", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = schoolIdOf(session, req);
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const name = String(body?.name || "").trim();
  if (!name) return NextResponse.json({ error: "Branch name is required." }, { status: 400 });

  const branch = await prisma.branch.create({
    data: {
      schoolId,
      name,
      code: body?.code ? String(body.code).trim() : null,
      address: body?.address ? String(body.address).trim() : null,
      phone: body?.phone ? String(body.phone).trim() : null,
      enabled: body?.enabled === false ? false : true, // ERP access granted by default; revoke later
      createdAt: new Date(),
    },
  });
  await audit("BRANCH_CREATE", "branch", branch.id, { name, schoolId });
  return NextResponse.json({ data: branch }, { status: 201 });
}

export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "branches", "full") && !can(session.role, "branches", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const branch = await prisma.branch.findUnique({ where: { id } });
  if (!branch) return NextResponse.json({ error: "Branch not found" }, { status: 404 });
  if (branch.schoolId !== session.schoolId && session.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (!canAccessBranch(session, id)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  if (session.role !== "SUPER_ADMIN") {
    const locked = await writeGuard(branch.schoolId);
    if (locked) return locked;
  }

  const body = await req.json().catch(() => null);
  const data: Record<string, any> = {};
  if (body?.name !== undefined) data.name = String(body.name).trim() || branch.name;
  if (body?.code !== undefined) data.code = String(body.code).trim() || null;
  if (body?.address !== undefined) data.address = String(body.address).trim() || null;
  if (body?.phone !== undefined) data.phone = String(body.phone).trim() || null;

  // ERP access grant/revoke — main admin and super admin only (a BRANCH_ADMIN
  // must never be able to switch on its own branch).
  if (body?.enabled !== undefined && (session.role === "SUPER_ADMIN" || session.role === "SCHOOL_ADMIN")) {
    data.enabled = body.enabled === true;
  }

  const updated = await prisma.branch.update({ where: { id }, data });
  await audit("BRANCH_UPDATE", "branch", id, { schoolId: branch.schoolId, data });
  return NextResponse.json({ data: updated });
}
export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "branches", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const branch = await prisma.branch.findUnique({ where: { id } });
  if (!branch) return NextResponse.json({ error: "Branch not found" }, { status: 404 });
  if (branch.schoolId !== session.schoolId && session.role !== "SUPER_ADMIN") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const locked = await writeGuard(branch.schoolId);
  if (locked) return locked;

  const [students, staff] = await Promise.all([
    prisma.student.count({ where: { branchId: id } }),
    prisma.user.count({ where: { branchId: id } }),
  ]);
  if (students > 0 || staff > 0) {
    return NextResponse.json(
      { error: "Cannot delete a branch that has students or staff. Revoke its ERP access instead." },
      { status: 400 }
    );
  }

  await prisma.branch.delete({ where: { id } });
  await audit("BRANCH_DELETE", "branch", id, { schoolId: branch.schoolId });
  return NextResponse.json({ data: { ok: true } });
}