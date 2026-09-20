import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { parseCsv, rowsToRecords, toCsv } from "@/lib/csv";

/**
 * PRD §12.4 — Bulk CSV import for teachers.
 *
 *   GET                        → CSV template (headers + example row)
 *   POST { dryRun: true  }     → validate only, no writes (preview)
 *   POST { csv, dryRun:false } → import (transactional, duplicate-safe)
 */

export async function GET() {
  const session = await getSession();
  if (!session || !can(session.role, "studentTeacherInfo", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const csv = toCsv(TEMPLATE_HEADERS, [EXAMPLE_ROW]);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="teachers-import-template.csv"',
    },
  });
}

const TEMPLATE_HEADERS = ["name", "email", "phone", "designation", "qualification", "address", "joinDate"];
const EXAMPLE_ROW: Record<string, string> = {
  name: "Sabrina Haque",
  email: "sabrina@sunrise.edu",
  phone: "+8801898765432",
  designation: "Senior Teacher",
  qualification: "B.Sc, B.Ed",
  address: "7/C Lake View, Dhaka",
  joinDate: "2026-01-05",
};

const ALIASES: Record<string, string> = {
  name: "name", "teacher name": "name", "full name": "name",
  email: "email", "email address": "email", mail: "email",
  phone: "phone", mobile: "phone", contact: "phone",
  designation: "designation", post: "designation", role: "designation",
  qualification: "qualification", degree: "qualification",
  address: "address",
  "join date": "joinDate", joiningdate: "joinDate", "joining date": "joinDate", joindate: "joinDate",
};

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "studentTeacherInfo", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const csv = String(body?.csv || "");
  const dryRun = body?.dryRun !== false;
  if (!csv.trim()) return NextResponse.json({ error: "CSV content is required." }, { status: 400 });

  const rows = parseCsv(csv);
  const { records } = rowsToRecords(rows, ALIASES);
  if (!records.length) return NextResponse.json({ error: "No data rows found in the CSV." }, { status: 400 });

  const [users, teachers] = await Promise.all([
    prisma.user.findMany({ select: { id: true, email: true } }),
    prisma.teacher.findMany({ where: { schoolId }, select: { userId: true } }),
  ]);
  const userByEmail = new Map(users.map((u) => [String(u.email).toLowerCase(), u.id]));
  const teacherUserIds = new Set(teachers.map((t) => t.userId));

  type RowResult = { row: number; name: string; email: string; status: "OK" | "ERROR" | "SKIP"; error?: string };
  const results: RowResult[] = [];
  const toCreate: any[] = [];

  records.forEach((rec, idx) => {
    const rowNo = idx + 2;
    const name = rec.name || "";
    const email = (rec.email || "").toLowerCase();
    const base = { row: rowNo, name, email };

    if (!name) { results.push({ ...base, status: "ERROR", error: "Name is required." }); return; }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { results.push({ ...base, status: "ERROR", error: "Valid email is required." }); return; }

    const existingUserId = userByEmail.get(email);
    if (existingUserId && teacherUserIds.has(existingUserId)) {
      results.push({ ...base, status: "SKIP", error: "Already a teacher in this school." });
      return;
    }

    const joinDate = rec.joinDate ? new Date(rec.joinDate) : new Date();
    toCreate.push({
      email,
      name,
      userData: {
        email,
        name,
        role: "TEACHER",
        schoolId,
        phone: rec.phone || null,
        passwordHash: bcrypt.hashSync("Teacher@123", 10),
      },
      teacherData: {
        userId: existingUserId || "", // resolved at commit for existing users
        schoolId,
        designation: rec.designation || null,
        qualification: rec.qualification || null,
        phone: rec.phone || null,
        address: rec.address || null,
        joinDate: Number.isNaN(joinDate.getTime()) ? new Date() : joinDate,
      },
    });
    results.push({ ...base, status: "OK" });
  });

  if (dryRun) {
    return NextResponse.json({
      data: {
        dryRun: true,
        total: records.length,
        ok: toCreate.length,
        errors: results.filter((r) => r.status === "ERROR").length,
        skipped: results.filter((r) => r.status === "SKIP").length,
        results,
      },
    });
  }

  let created = 0;
  try {
    await prisma.$transaction(async (tx) => {
      for (const t of toCreate) {
        let userId = userByEmail.get(t.email) || "";
        if (!userId) {
          const user = await tx.user.create({ data: t.userData });
          userId = user.id;
          userByEmail.set(t.email, userId);
        }
        await tx.teacher.create({ data: { ...t.teacherData, userId } });
        created++;
      }
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Import failed — no changes were saved." }, { status: 500 });
  }

  await audit("TEACHER_IMPORT", "teacher", undefined, { created });
  invalidateReferenceCache(schoolId);
  return NextResponse.json({
    data: {
      dryRun: false,
      total: records.length, created,
      errors: results.filter((r) => r.status === "ERROR").length,
      skipped: results.filter((r) => r.status === "SKIP").length,
      defaultPassword: "Teacher@123",
      results,
    },
  });
}
