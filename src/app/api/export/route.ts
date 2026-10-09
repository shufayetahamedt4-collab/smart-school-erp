import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { toCsv } from "@/lib/csv";

/**
 * PRD §12.4 — CSV export endpoint.
 *   GET /api/export?type=students|teachers|fees|ledger|attendance
 *
 * Streams text/csv with a filename; all queries are school-scoped from the
 * session (never client-sent schoolId).
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const type = (req.nextUrl.searchParams.get("type") || "students").toLowerCase();
  const allowedTypes = ["students", "teachers", "fees", "ledger", "attendance"];
  if (!allowedTypes.includes(type)) {
    return NextResponse.json({ error: `Unknown export type "${type}".` }, { status: 400 });
  }

  const staffRead =
    can(session.role, "studentTeacherInfo", "view") ||
    can(session.role, "feePayment", "view") ||
    session.role === "SUPER_ADMIN";
  if (!staffRead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  let csv = "";
  let filename = `${type}.csv`;

  if (type === "students") {
    if (!can(session.role, "studentTeacherInfo", "view") && session.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const [students, classes, sections] = await Promise.all([
      prisma.student.findMany({ where: { schoolId } }),
      prisma.classRoom.findMany({ where: { schoolId }, select: { id: true, name: true } }),
      prisma.section.findMany({ where: { schoolId }, select: { id: true, name: true } }),
    ]);
    const classById = new Map(classes.map((c: any) => [c.id, c.name]));
    const sectionById = new Map(sections.map((s: any) => [s.id, s.name]));
    const headers = ["admissionNo", "name", "class", "section", "roll", "gender", "dob", "guardianName", "guardianPhone", "guardianEmail", "status"];
    const records = students.map((s: any) => ({
      admissionNo: s.admissionNo,
      name: s.name,
      class: s.classId ? classById.get(s.classId) || "" : "",
      section: s.sectionId ? sectionById.get(s.sectionId) || "" : "",
      roll: s.roll ?? "",
      gender: s.gender || "",
      dob: s.dob ? new Date(s.dob).toISOString().slice(0, 10) : "",
      guardianName: s.guardianName || "",
      guardianPhone: s.guardianPhone || "",
      guardianEmail: s.guardianEmail || "",
      status: s.status || "ACTIVE",
    }));
    csv = toCsv(headers, records);
    filename = "students.csv";
  } else if (type === "teachers") {
    if (!can(session.role, "studentTeacherInfo", "view") && session.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const [teachers, users] = await Promise.all([
      prisma.teacher.findMany({ where: { schoolId } }),
      prisma.user.findMany({ where: { schoolId }, select: { id: true, name: true, email: true, phone: true } }),
    ]);
    const userById = new Map(users.map((u: any) => [u.id, u]));
    const headers = ["name", "email", "phone", "designation", "qualification", "joinDate"];
    const records = teachers.map((t: any) => {
      const u = t.userId ? userById.get(t.userId) : null;
      return {
        name: u?.name || "",
        email: u?.email || "",
        phone: u?.phone || t.phone || "",
        designation: t.designation || "",
        qualification: t.qualification || "",
        joinDate: t.joinDate ? new Date(t.joinDate).toISOString().slice(0, 10) : "",
      };
    });
    csv = toCsv(headers, records);
    filename = "teachers.csv";
  } else if (type === "fees") {
    if (!can(session.role, "feePayment", "view") && session.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const [fees, students] = await Promise.all([
      prisma.fee.findMany({ where: { schoolId } }),
      prisma.student.findMany({ where: { schoolId }, select: { id: true, name: true, admissionNo: true } }),
    ]);
    const studentById = new Map(students.map((s: any) => [s.id, s]));
    const headers = ["invoice", "student", "admissionNo", "title", "type", "amount", "paidAmount", "status", "dueDate"];
    const records = fees.map((f: any) => ({
      invoice: f.id,
      student: f.studentId ? studentById.get(f.studentId)?.name || "" : "",
      admissionNo: f.studentId ? studentById.get(f.studentId)?.admissionNo || "" : "",
      title: f.title || "",
      type: f.feeType || "",
      amount: f.amount,
      paidAmount: f.paidAmount ?? 0,
      status: f.status || "",
      dueDate: f.dueDate ? new Date(f.dueDate).toISOString().slice(0, 10) : "",
    }));
    csv = toCsv(headers, records);
    filename = "fees.csv";
  } else if (type === "ledger") {
    if (!can(session.role, "feePayment", "view") && session.role !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const entries = await prisma.ledgerEntry.findMany({ where: { schoolId }, orderBy: { createdAt: "desc" }, take: 5000 });
    const headers = ["date", "kind", "description", "amount", "status", "studentId", "feeId"];
    const records = entries.map((e: any) => ({
      date: e.date ? new Date(e.date).toISOString() : e.createdAt ? new Date(e.createdAt).toISOString() : "",
      kind: e.kind || "",
      description: e.description || "",
      amount: e.amount,
      status: e.status || "",
      studentId: e.studentId || "",
      feeId: e.feeId || "",
    }));
    csv = toCsv(headers, records);
    filename = "ledger.csv";
  } else if (type === "attendance") {
    const sp = req.nextUrl.searchParams;
    const from = sp.get("from") ? new Date(String(sp.get("from"))) : null;
    const to = sp.get("to") ? new Date(String(sp.get("to"))) : null;
    const [attendance, students] = await Promise.all([
      prisma.attendance.findMany({ where: { schoolId } }),
      prisma.student.findMany({ where: { schoolId }, select: { id: true, name: true, admissionNo: true } }),
    ]);
    const studentById = new Map(students.map((s: any) => [s.id, s]));
    const headers = ["date", "admissionNo", "student", "status", "note"];
    const records = attendance
      .filter((a: any) => {
        const d = a.date ? new Date(a.date).getTime() : 0;
        if (from && d < from.getTime()) return false;
        if (to && d > to.getTime()) return false;
        return true;
      })
      .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime())
      .map((a: any) => ({
        date: a.date ? new Date(a.date).toISOString().slice(0, 10) : "",
        admissionNo: a.studentId ? studentById.get(a.studentId)?.admissionNo || "" : "",
        student: a.studentId ? studentById.get(a.studentId)?.name || "" : "",
        status: a.status || "",
        note: a.note || "",
      }));
    csv = toCsv(headers, records);
    filename = "attendance.csv";
  }

  await audit("DATA_EXPORT", "export", undefined, { type });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
