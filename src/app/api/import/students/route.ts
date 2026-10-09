import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma, invalidateReferenceCache } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard, planLimitGuard } from "@/lib/subscription";
import { parseCsv, rowsToRecords, toCsv } from "@/lib/csv";
import { qrToken, qrPin } from "@/lib/qr";
import { invalidateStats } from "@/lib/stats-cache";

/**
 * PRD §12.4 — Bulk CSV import for students.
 *
 *   GET                        → CSV template (headers + example row)
 *   POST { dryRun: true  }     → validate only, no writes (preview)
 *   POST { csv, dryRun:false } → import (transactional, duplicate-safe)
 *
 * Upcoming per-row fee rows (`feeTitle`,`feeAmount`,`feeType`,`feeDueDate`)
 * are collected and emitted in the preview so the school can pre-announce,
 * but the canonical per-student fee creation still runs through
 * POST /api/students / the admission flow afterwards.
 */

export async function GET() {
  const session = await getSession();
  if (!session || !can(session.role, "studentTeacherInfo", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const headers = TEMPLATE_HEADERS.map((h) => h.name);
  const csv = toCsv(headers, [EXAMPLE_ROW]);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="students-import-template.csv"',
    },
  });
}

const TEMPLATE_HEADERS = [
  { name: "admissionNo", required: true },
  { name: "name", required: true },
  { name: "class", required: false },
  { name: "section", required: false },
  { name: "roll", required: false },
  { name: "gender", required: false },
  { name: "dob", required: false },
  { name: "guardianName", required: false },
  { name: "guardianPhone", required: false },
  { name: "guardianEmail", required: false },
  { name: "guardianRelation", required: false },
  { name: "bloodGroup", required: false },
  { name: "address", required: false },
  { name: "createGuardianLogin", required: false },
];

const EXAMPLE_ROW: Record<string, string> = {
  admissionNo: "STU-1001",
  name: "Ayesha Rahman",
  class: "Class 1",
  section: "A",
  roll: "1",
  gender: "FEMALE",
  dob: "2015-03-14",
  guardianName: "Karim Rahman",
  guardianPhone: "+8801712345678",
  guardianEmail: "karim@example.com",
  guardianRelation: "FATHER",
  bloodGroup: "A_POS",
  address: "12/A Green Road, Dhaka",
  createGuardianLogin: "yes",
};

const ALIASES: Record<string, string> = {
  "admission no": "admissionNo", "admission number": "admissionNo", "admissionno": "admissionNo", "adm no": "admissionNo",
  name: "name", "student name": "name", "full name": "name",
  class: "class", "class name": "class",
  section: "section", "section name": "section",
  roll: "roll", "roll no": "roll", "roll number": "roll",
  gender: "gender", sex: "gender",
  dob: "dob", "date of birth": "dob", birthday: "dob",
  "guardian name": "guardianName", "father name": "guardianName", "mother name": "guardianName",
  "guardian phone": "guardianPhone", phone: "guardianPhone", mobile: "guardianPhone", contact: "guardianPhone",
  "guardian email": "guardianEmail", email: "guardianEmail",
  "guardian relation": "guardianRelation", relation: "guardianRelation",
  "blood group": "bloodGroup", blood: "bloodGroup",
  address: "address",
  "create guardian login": "createGuardianLogin", "guardian login": "createGuardianLogin",
};

function parseDateCell(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

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
  const dryRun = body?.dryRun !== false; // default: preview-only
  if (!csv.trim()) return NextResponse.json({ error: "CSV content is required." }, { status: 400 });

  const rows = parseCsv(csv);
  const { records } = rowsToRecords(rows, ALIASES);
  if (!records.length) return NextResponse.json({ error: "No data rows found in the CSV." }, { status: 400 });

  // ---- reference data (one pull per model) --------------------------------
  const [classes, sections, existingStudents, existingUsers] = await Promise.all([
    prisma.classRoom.findMany({ where: { schoolId }, select: { id: true, name: true, order: true } }),
    prisma.section.findMany({ where: { schoolId }, select: { id: true, classId: true, name: true } }),
    prisma.student.findMany({ where: { schoolId }, select: { admissionNo: true } }),
    prisma.user.findMany({ where: { schoolId, role: "GUARDIAN" }, select: { id: true, email: true } }),
  ]);
  const classByName = new Map(classes.map((c) => [String(c.name).toLowerCase(), c]));
  const sectionsByClass = new Map<string, Map<string, string>>();
  for (const s of sections) {
    const byName = sectionsByClass.get(s.classId) || new Map<string, string>();
    byName.set(String(s.name).toLowerCase(), s.id);
    sectionsByClass.set(s.classId, byName);
  }
  const takenAdmission = new Set(existingStudents.map((s) => s.admissionNo));
  const guardianByEmail = new Map(existingUsers.map((u) => [String(u.email).toLowerCase(), u.id]));

  // ---- plan limit ----------------------------------------------------------
  const validCount = records.filter((r) => r.name && r.admissionNo && !takenAdmission.has(r.admissionNo)).length;
  const limitGuard = await planLimitGuard(schoolId, validCount);
  if (limitGuard) return limitGuard;

  // ---- validate / resolve each row ----------------------------------------
  type RowResult = {
    row: number; admissionNo: string; name: string; className: string; sectionName: string;
    status: "OK" | "ERROR" | "SKIP"; error?: string;
  };
  const results: RowResult[] = [];
  const toCreate: any[] = [];
  const sessionGuardians: { email: string; name: string; phone: string }[] = [];

  records.forEach((rec, idx) => {
    const rowNo = idx + 2; // +header row, 1-indexed
    const admissionNo = rec.admissionNo || "";
    const name = rec.name || "";
    const base = { row: rowNo, admissionNo, name, className: rec.class || "", sectionName: rec.section || "" };

    if (!name) { results.push({ ...base, status: "ERROR", error: "Name is required." }); return; }
    if (!admissionNo) { results.push({ ...base, status: "ERROR", error: "Admission number is required." }); return; }
    if (takenAdmission.has(admissionNo)) { results.push({ ...base, status: "SKIP", error: "Duplicate admission number (already in school)." }); return; }

    let classId: string | null = null;
    if (rec.class) {
      const cls = classByName.get(rec.class.toLowerCase());
      if (!cls) { results.push({ ...base, status: "ERROR", error: `Class "${rec.class}" not found — create it first.` }); return; }
      classId = cls.id;
      if (rec.section) {
        const sec = sectionsByClass.get(cls.id)?.get(rec.section.toLowerCase());
        if (!sec) { results.push({ ...base, status: "ERROR", error: `Section "${rec.section}" not found in ${rec.class}.` }); return; }
        var sectionId: string | null = sec;
      } else {
        var sectionId: string | null = null;
      }
    } else {
      var sectionId: string | null = null;
    }

    const gender = ["MALE", "FEMALE", "OTHER"].includes(rec.gender?.toUpperCase()) ? rec.gender.toUpperCase() : "OTHER";
    const wantsLogin = /^(yes|true|1|y)$/i.test(rec.createGuardianLogin || "") && !!rec.guardianEmail;
    if (wantsLogin && !guardianByEmail.has(rec.guardianEmail.toLowerCase())) {
      sessionGuardians.push({ email: rec.guardianEmail.toLowerCase(), name: rec.guardianName || "Guardian", phone: rec.guardianPhone || "" });
    }

    toCreate.push({
      schoolId,
      admissionNo,
      name,
      dob: parseDateCell(rec.dob),
      gender,
      bloodGroup: rec.bloodGroup || null,
      roll: rec.roll ? Number(rec.roll) : null,
      classId,
      sectionId: sectionId ?? null,
      guardianName: rec.guardianName || null,
      guardianPhone: rec.guardianPhone || null,
      guardianEmail: rec.guardianEmail ? rec.guardianEmail.toLowerCase() : null,
      guardianRelation: rec.guardianRelation || null,
      address: rec.address || null,
      admissionDate: new Date(),
      qrToken: qrToken(),
      qrPin: qrPin(),
      _createGuardian: wantsLogin,
    });
    takenAdmission.add(admissionNo);
    results.push({ ...base, status: "OK" });
  });

  const okCount = toCreate.length;
  const errorCount = results.filter((r) => r.status === "ERROR").length;
  const skipCount = results.filter((r) => r.status === "SKIP").length;

  if (dryRun) {
    return NextResponse.json({
      data: {
        dryRun: true,
        total: records.length, ok: okCount, errors: errorCount, skipped: skipCount,
        guardianLoginsToCreate: sessionGuardians.length,
        results,
      },
    });
  }

  // ---- commit --------------------------------------------------------------
  let created = 0;
  const createdGuardians: string[] = [];
  try {
    await prisma.$transaction(async (tx) => {
      // Guardian accounts first (shared across rows by email)
      for (const g of sessionGuardians) {
        const user = await tx.user.create({
          data: {
            email: g.email,
            name: g.name,
            role: "GUARDIAN",
            schoolId,
            phone: g.phone || null,
            passwordHash: bcrypt.hashSync("Guardian@123", 10),
          },
        });
        guardianByEmail.set(g.email, user.id);
        createdGuardians.push(g.email);
      }

      for (const s of toCreate) {
        const { _createGuardian, ...data } = s;
        const student = await tx.student.create({ data });
        if (_createGuardian && s.guardianEmail) {
          const guardianId = guardianByEmail.get(s.guardianEmail);
          if (guardianId) {
            await tx.student.update({ where: { id: student.id }, data: { guardianUserId: guardianId } });
          }
        }
        created++;
      }
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || "Import failed — no changes were saved." }, { status: 500 });
  }

  await audit("STUDENT_IMPORT", "student", undefined, { created, errors: errorCount, skipped: skipCount });
  invalidateReferenceCache(schoolId);
  invalidateStats(schoolId, "students");

  return NextResponse.json({
    data: {
      dryRun: false,
      total: records.length, created, errors: errorCount, skipped: skipCount,
      guardianLoginsCreated: createdGuardians.length,
      defaultGuardianPassword: createdGuardians.length ? "Guardian@123" : undefined,
      results,
    },
  });
}
