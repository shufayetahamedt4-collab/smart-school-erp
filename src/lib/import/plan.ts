import { createHash } from "node:crypto";
import { prisma } from "@/lib/db";
import { type ImportFieldKey } from "@/lib/import/fields";
import {
  cleanCell,
  identifierKey,
  normalizeBloodGroup,
  normalizeDob,
  normalizeEmail,
  normalizeGender,
  normalizeIdentifier,
  normalizePhone,
  normalizeRoll,
} from "@/lib/import/normalize";

/**
 * Bulk student import — server-side planning.
 *
 * One function turns raw spreadsheet cells into a row-by-row plan that says, for
 * every row, whether it can be imported, what it resolved to, and why it was
 * flagged. The preview endpoint runs it once over the whole file (so in-file
 * duplicates are caught) and does ZERO writes; the chunked commit endpoint runs
 * the SAME validator over each chunk, so nothing the client sends is trusted.
 *
 * Duplicate policy (mirrors the Phase 2 spec):
 *   definite duplicate (admission/registration already on file, or a second row
 *     in the same file)  → ERROR   (row is not imported)
 *   possible duplicate (same name+class, or same roll+class) → WARNING (review,
 *     still importable)
 *   existing guardian account matched by email or phone → REUSE (never a second
 *     guardian account)
 *   no guardian information at all → WARNING, student still importable
 */

export type PlanLevel = "ERROR" | "WARNING" | "INFO" | "OK";
/**
 * create a student · reuse the matched guardian · skip (row is an error) ·
 * skip because this exact row was already imported (safe re-run).
 */
export type PlanAction = "CREATE" | "REUSE_GUARDIAN" | "SKIP" | "SKIP_EXISTING";

export interface PlanMessage {
  field: string | null;
  level: Exclude<PlanLevel, "OK">;
  code: string;
  message: string;
}

export interface PlanValues {
  name: string;
  nameBn: string | null;
  admissionNo: string | null;
  roll: number | null;
  registrationNo: string | null;
  classId: string | null;
  className: string | null;
  sectionId: string | null;
  sectionName: string | null;
  dob: string | null;
  gender: string | null;
  bloodGroup: string | null;
  birthCertificateNo: string | null;
  address: string | null;
  previousSchoolName: string | null;
  previousSchoolClass: string | null;
  guardianName: string | null;
  guardianPhone: string | null;
  guardianEmail: string | null;
  guardianRelation: string | null;
  photoUrl: string | null;
}

export interface PlanRow {
  rowNumber: number;
  /** Highest severity seen for the row (OK when only info). */
  level: PlanLevel;
  /** What commit will do with the row. */
  action: PlanAction;
  /** False when the row is an ERROR and must not be imported. */
  importable: boolean;
  messages: PlanMessage[];
  values: PlanValues;
  /** Deterministic stable key + qr token (identical across re-runs). */
  key: string;
  qrToken: string;
  /** The matched existing guardian account, when one was found. */
  guardianUserId: string | null;
  /** The matched existing student, when a possible/definite duplicate was found. */
  existingStudentId: string | null;
}

export interface PlanSummary {
  total: number;
  importable: number;
  errors: number;
  warnings: number;
  duplicates: number;
  inFileDuplicates: number;
  reuseGuardian: number;
  missingGuardian: number;
  alreadyImported: number;
}

export interface ImportContext {
  schoolId: string;
  branchId: string | null;
  sessionId: string | null;
  classes: any[];
  sections: any[];
  studentsByAdmission: Map<string, any>;
  studentsByRegistration: Map<string, any>;
  studentsByNameClass: Map<string, any[]>;
  studentsByRollClass: Map<string, any[]>;
  guardiansByEmail: Map<string, any>;
  guardiansByPhone: Map<string, any>;
  /**
   * In-memory indexes so the commit path never has to read a document it is
   * about to decide on:
   *   - every existing student id in the school (a student id IS `st_<qrToken>`),
   *     which replaces the per-row `findUnique(id)` existence probe;
   *   - which guardian accounts / phones already have a child, which is exactly
   *     what `findExistingSibling()` would query to decide "is there a sibling?"
   */
  existingStudentIds: Set<string>;
  studentsByGuardianUser: Set<string>;
  studentsByGuardianPhone: Set<string>;
}

export interface RawImportRow {
  rowNumber: number;
  cells: string[];
}

/** Load exactly the reference data validation needs, in one parallel wave. */
export async function loadImportContext(
  schoolId: string,
  branchId: string | null,
  sessionId: string | null
): Promise<ImportContext> {
  const [classes, sections, students, users] = await Promise.all([
    prisma.classRoom.findMany({ where: { schoolId }, select: { id: true, name: true, order: true } }),
    prisma.section.findMany({ where: { schoolId }, select: { id: true, name: true, classId: true } }),
    prisma.student.findMany({
      where: { schoolId },
      select: {
        id: true,
        name: true,
        admissionNo: true,
        registrationNo: true,
        roll: true,
        classId: true,
        sectionId: true,
        guardianPhone: true,
        guardianUserId: true,
        familyId: true,
      },
    }),
    prisma.user.findMany({ where: { schoolId }, select: { id: true, email: true, name: true, phone: true, role: true } }),
  ]);

  const studentsByAdmission = new Map<string, any>();
  const studentsByRegistration = new Map<string, any>();
  const studentsByNameClass = new Map<string, any[]>();
  const studentsByRollClass = new Map<string, any[]>();
  const existingStudentIds = new Set<string>();
  const studentsByGuardianUser = new Set<string>();
  const studentsByGuardianPhone = new Set<string>();
  for (const s of students as any[]) {
    if (s.admissionNo) studentsByAdmission.set(identifierKey(s.admissionNo), s);
    if (s.registrationNo) studentsByRegistration.set(identifierKey(s.registrationNo), s);
    if (s.name && s.classId) push(studentsByNameClass, `${nameKey(s.name)}|${s.classId}`, s);
    if (s.roll !== null && s.roll !== undefined && s.classId) push(studentsByRollClass, `${s.classId}|${Number(s.roll)}`, s);
    existingStudentIds.add(s.id);
    if (s.guardianUserId) studentsByGuardianUser.add(String(s.guardianUserId));
    const phone = normalizePhone(s.guardianPhone);
    if (phone) studentsByGuardianPhone.add(phone);
  }

  // Guardian matching is SCHOOL-SCOPED (the users read above is filtered by
  // schoolId), so a guardian account belonging to another school is never
  // matched during a preview/commit for this school.
  const guardiansByEmail = new Map<string, any>();
  const guardiansByPhone = new Map<string, any>();
  // A phone number shared by more than one guardian account is AMBIGUOUS: two
  // families (or a family and a third party) put the same number on file, so
  // reusing "by phone" would guess whose account this student belongs to. Such
  // a phone is deliberately left out of the map — never auto-linked.
  const phoneGuardianCount = new Map<string, number>();
  for (const u of users as any[]) {
    if (u.role !== "GUARDIAN") continue;
    const phone = normalizePhone(u.phone);
    if (phone) phoneGuardianCount.set(phone, (phoneGuardianCount.get(phone) || 0) + 1);
  }
  for (const u of users as any[]) {
    if (u.role !== "GUARDIAN") continue;
    if (u.email) guardiansByEmail.set(String(u.email).toLowerCase(), u);
    const phone = normalizePhone(u.phone);
    if (phone && (phoneGuardianCount.get(phone) || 0) === 1) guardiansByPhone.set(phone, u);
  }

  return {
    schoolId,
    branchId,
    sessionId,
    classes: classes as any[],
    sections: sections as any[],
    studentsByAdmission,
    studentsByRegistration,
    studentsByNameClass,
    studentsByRollClass,
    guardiansByEmail,
    guardiansByPhone,
    existingStudentIds,
    studentsByGuardianUser,
    studentsByGuardianPhone,
  };
}

function push(map: Map<string, any[]>, key: string, value: any) {
  const list = map.get(key) || [];
  list.push(value);
  map.set(key, list);
}

function nameKey(name: unknown): string {
  return String(name ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** A stable qr token for an imported row — same row, same token, every run. */
export function importQrToken(schoolId: string, rowKey: string): string {
  return "imp" + createHash("sha1").update(`${schoolId}|${rowKey}`).digest("hex").slice(0, 29);
}

/**
 * Deterministic document id for a batch row.
 *
 * Keyed by (batch, absolute row number, row identity hash): a retried chunk
 * overwrites the same document, while two different rows can never collapse
 * onto one even if a client mistakenly repeats a row number across chunks.
 */
export function rowDocId(batchId: string, rowNumber: number, rowKey: string): string {
  const fingerprint = createHash("sha1").update(rowKey || "").digest("hex").slice(0, 8);
  return `ibr_${batchId}_${rowNumber}_${fingerprint}`;
}

function readCell(row: RawImportRow, mapping: Record<string, number>, key: ImportFieldKey): string {
  const index = mapping[key];
  if (index === undefined || index === null) return "";
  return cleanCell(row.cells[index]);
}

function resolveClass(classes: any[], raw: string): any | null {
  if (!raw) return null;
  const norm = nameKey(raw);
  const exact = classes.find((c) => nameKey(c.name) === norm);
  if (exact) return exact;
  const stripped = classes.find((c) => nameKey(String(c.name).replace(/class/i, "")) === norm);
  if (stripped) return stripped;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    const byOrder = classes.find((c) => Number(c.order) === n);
    if (byOrder) return byOrder;
    return classes.find((c) => nameKey(c.name).replace(/^class/, "") === String(n)) || null;
  }
  return null;
}

function resolveSection(sections: any[], classId: string, raw: string): { sectionId: string | null; sectionName: string | null; error?: string } {
  const pool = sections.filter((s) => s.classId === classId);
  if (!raw) return { sectionId: null, sectionName: null };
  if (!pool.length) return { sectionId: null, sectionName: null }; // class has no sections — ignore
  const match = pool.find((s) => nameKey(s.name) === nameKey(raw));
  if (!match) return { sectionId: null, sectionName: null, error: `No section "${raw}" in this class.` };
  return { sectionId: match.id, sectionName: match.name };
}

/**
 * Validate one file's rows. `seen` carries in-file identifier keys across rows;
 * it is created internally, so a single call over the whole file detects
 * duplicates within it.
 */
export function validateRows(
  ctx: ImportContext,
  rows: RawImportRow[],
  mapping: Record<string, number>
): { rows: PlanRow[]; summary: PlanSummary } {
  const seen = new Map<string, number>();
  const planned: PlanRow[] = [];
  const summary: PlanSummary = {
    total: rows.length,
    importable: 0,
    errors: 0,
    warnings: 0,
    duplicates: 0,
    inFileDuplicates: 0,
    reuseGuardian: 0,
    missingGuardian: 0,
    alreadyImported: 0,
  };

  for (const row of rows) {
    const plan = validateRow(ctx, row, mapping, seen);
    planned.push(plan);
    if (plan.level === "ERROR") summary.errors++;
    if (plan.importable) summary.importable++;
    if (plan.level === "WARNING") summary.warnings++;
    if (plan.messages.some((m) => m.code === "DUPLICATE_IN_FILE")) summary.inFileDuplicates++;
    if (plan.messages.some((m) => m.code === "DUPLICATE_ADMISSION_NO" || m.code === "DUPLICATE_REGISTRATION_NO")) summary.duplicates++;
    if (plan.action === "REUSE_GUARDIAN") summary.reuseGuardian++;
    if (plan.action === "SKIP_EXISTING") summary.alreadyImported++;
    if (plan.messages.some((m) => m.code === "MISSING_GUARDIAN_INFO")) summary.missingGuardian++;
  }

  return { rows: planned, summary };
}

function validateRow(
  ctx: ImportContext,
  row: RawImportRow,
  mapping: Record<string, number>,
  seen: Map<string, number>
): PlanRow {
  const messages: PlanMessage[] = [];
  const error = (field: ImportFieldKey | null, code: string, message: string) =>
    messages.push({ field, level: "ERROR", code, message });
  const warn = (field: ImportFieldKey | null, code: string, message: string) =>
    messages.push({ field, level: "WARNING", code, message });
  const info = (field: ImportFieldKey | null, code: string, message: string) =>
    messages.push({ field, level: "INFO", code, message });

  // ---- required: name ----
  const name = readCell(row, mapping, "name");
  if (!name) error("name", "MISSING_NAME", "Name is required.");

  // ---- required: class ----
  const classRaw = readCell(row, mapping, "class");
  let classId: string | null = null;
  let className: string | null = null;
  if (!classRaw) {
    error("class", "MISSING_CLASS", "Class is required.");
  } else {
    const klass = resolveClass(ctx.classes, classRaw);
    if (!klass) error("class", "UNKNOWN_CLASS", `No class named "${classRaw}" in this school.`);
    else {
      classId = klass.id;
      className = klass.name;
    }
  }

  // ---- identifier: at least one ----
  const admissionNoRaw = normalizeIdentifier(readCell(row, mapping, "admissionNo"));
  const registrationNoRaw = normalizeIdentifier(readCell(row, mapping, "registrationNo"));
  const rollRaw = readCell(row, mapping, "roll");
  let roll: number | null = null;
  if (rollRaw) {
    const r = normalizeRoll(rollRaw);
    if (r.ok) roll = r.value;
    else if (r.error) error("roll", "INVALID_ROLL", r.error);
  }
  if (!admissionNoRaw && !registrationNoRaw && roll === null) {
    error(null, "MISSING_IDENTIFIER", "A row needs an admission number, a roll number or a registration number.");
  }

  // ---- optional scalar fields ----
  let gender: string | null = null;
  const genderRaw = readCell(row, mapping, "gender");
  if (genderRaw) {
    const g = normalizeGender(genderRaw);
    if (g.ok) gender = g.value;
    else if (g.error) error("gender", "INVALID_GENDER", g.error);
  }

  let dob: Date | null = null;
  const dobRaw = readCell(row, mapping, "dob");
  if (dobRaw) {
    const d = normalizeDob(dobRaw);
    if (d.ok) dob = d.value;
    else if (d.error) error("dob", "INVALID_DOB", d.error);
  }

  let bloodGroup: string | null = null;
  const bloodRaw = readCell(row, mapping, "bloodGroup");
  if (bloodRaw) {
    const b = normalizeBloodGroup(bloodRaw);
    if (b.ok) bloodGroup = b.value;
    else if (b.error) error("bloodGroup", "INVALID_BLOOD_GROUP", b.error);
  }

  const sectionRaw = readCell(row, mapping, "section");
  let sectionId: string | null = null;
  let sectionName: string | null = null;
  if (classId && sectionRaw) {
    const sec = resolveSection(ctx.sections, classId, sectionRaw);
    if (sec.error) error("section", "UNKNOWN_SECTION", sec.error);
    else {
      sectionId = sec.sectionId;
      sectionName = sec.sectionName;
    }
  }

  const nameBn = readCell(row, mapping, "nameBn") || null;
  const birthCertificateNo = readCell(row, mapping, "birthCertificateNo") || null;
  const address = readCell(row, mapping, "address") || null;
  const previousSchoolName = readCell(row, mapping, "previousSchoolName") || null;
  const previousSchoolClass = readCell(row, mapping, "previousSchoolClass") || null;
  const photoUrl = readCell(row, mapping, "photoUrl") || null;

  // ---- guardian ----
  const guardianName = readCell(row, mapping, "guardianName") || null;
  const guardianRelation = readCell(row, mapping, "guardianRelation") || null;
  let guardianEmail: string | null = null;
  const guardianEmailRaw = readCell(row, mapping, "guardianEmail");
  if (guardianEmailRaw) {
    const e = normalizeEmail(guardianEmailRaw);
    if (e.ok) guardianEmail = e.value;
    else if (e.error) error("guardianEmail", "INVALID_GUARDIAN_EMAIL", e.error);
  }
  const guardianPhone = normalizePhone(readCell(row, mapping, "guardianPhone")) || null;

  let guardianUserId: string | null = null;
  let action: PlanAction = "CREATE";

  const matchedByEmail = guardianEmail ? ctx.guardiansByEmail.get(guardianEmail) || null : null;
  const matchedByPhone = !matchedByEmail && guardianPhone ? ctx.guardiansByPhone.get(guardianPhone) || null : null;
  const matchedGuardian = matchedByEmail || matchedByPhone;

  if (matchedGuardian) {
    guardianUserId = matchedGuardian.id;
    action = "REUSE_GUARDIAN";
    info("guardianEmail", "REUSE_GUARDIAN", `An existing guardian account (${matchedGuardian.name || matchedGuardian.email || "guardian"}) will be linked — no new login.`);
  } else if (!guardianName && !guardianPhone && !guardianEmail) {
    warn("guardianName", "MISSING_GUARDIAN_INFO", "No guardian information — the student will have no guardian account.");
  } else if (guardianEmail) {
    info("guardianEmail", "CREATE_GUARDIAN", `A new guardian account will be created for ${guardianEmail}.`);
  } else {
    warn(
      "guardianEmail",
      "GUARDIAN_EMAIL_REQUIRED",
      "A guardian phone is present but no email — no guardian portal account will be created (email is the account key)."
    );
  }

  // ---- duplicate detection ----
  const identifier =
    admissionNoRaw ? `a:${identifierKey(admissionNoRaw)}`
    : registrationNoRaw ? `r:${identifierKey(registrationNoRaw)}`
    : roll !== null && classId ? `l:${classId}:${roll}`
    : "";
  // The deterministic id this row WOULD create — used to tell a genuine clash
  // (a different student) apart from this very row already imported earlier.
  const key = identifier || `n:${nameKey(name)}|${classId || "?"}`;
  const qrToken = importQrToken(ctx.schoolId, key);
  const expectedStudentId = `st_${qrToken}`;

  let existingStudentId: string | null = null;
  let alreadyImported = false;

  if (admissionNoRaw) {
    const clash = ctx.studentsByAdmission.get(identifierKey(admissionNoRaw));
    if (clash && clash.id === expectedStudentId) {
      alreadyImported = true;
      info(null, "ALREADY_IMPORTED", "Already imported by this roster — will be skipped, not duplicated.");
    } else if (clash) {
      existingStudentId = clash.id;
      error("admissionNo", "DUPLICATE_ADMISSION_NO", `Admission number ${admissionNoRaw} already belongs to ${clash.name || "another student"}.`);
    }
  }
  if (registrationNoRaw && !existingStudentId && !alreadyImported) {
    const clash = ctx.studentsByRegistration.get(identifierKey(registrationNoRaw));
    if (clash && clash.id === expectedStudentId) {
      alreadyImported = true;
      info(null, "ALREADY_IMPORTED", "Already imported by this roster — will be skipped, not duplicated.");
    } else if (clash) {
      existingStudentId = clash.id;
      error("registrationNo", "DUPLICATE_REGISTRATION_NO", `Registration number ${registrationNoRaw} already belongs to ${clash.name || "another student"}.`);
    }
  }

  if (identifier && !alreadyImported) {
    const first = seen.get(identifier);
    if (first !== undefined) {
      error(null, "DUPLICATE_IN_FILE", `Duplicate of row ${first} in this file.`);
    } else {
      seen.set(identifier, row.rowNumber);
    }
  }

  // possible duplicates (warnings) — only worth checking when the row is not already a definite duplicate
  if (name && classId && !existingStudentId && !alreadyImported) {
    const byName = ctx.studentsByNameClass.get(`${nameKey(name)}|${classId}`) || [];
    if (byName.length) {
      existingStudentId = existingStudentId || byName[0].id;
      warn(null, "POSSIBLE_DUPLICATE", `A student named "${name}" already exists in ${className}${admissionNoRaw ? "" : " (no admission number to confirm)"}. Review before importing.`);
    } else if (roll !== null) {
      const byRoll = ctx.studentsByRollClass.get(`${classId}|${roll}`) || [];
      if (byRoll.length) {
        existingStudentId = existingStudentId || byRoll[0].id;
        warn(null, "POSSIBLE_DUPLICATE", `Roll ${roll} in ${className} is already taken by ${byRoll[0].name || "another student"}. Review before importing.`);
      }
    }
  }

  const hasError = messages.some((m) => m.level === "ERROR");
  const hasWarning = messages.some((m) => m.level === "WARNING");
  const level: PlanLevel = hasError ? "ERROR" : hasWarning ? "WARNING" : "OK";

  const values: PlanValues = {
    name,
    nameBn,
    admissionNo: admissionNoRaw || null,
    roll,
    registrationNo: registrationNoRaw || null,
    classId,
    className,
    sectionId,
    sectionName,
    dob: dob ? dob.toISOString().slice(0, 10) : null,
    gender,
    bloodGroup,
    birthCertificateNo,
    address,
    previousSchoolName,
    previousSchoolClass,
    guardianName,
    guardianPhone,
    guardianEmail,
    guardianRelation,
    photoUrl,
  };

  return {
    rowNumber: row.rowNumber,
    level,
    action: hasError ? "SKIP" : alreadyImported ? "SKIP_EXISTING" : action,
    importable: !hasError && !alreadyImported,
    messages,
    values,
    key,
    qrToken,
    guardianUserId,
    existingStudentId,
  };
}

/**
 * Build the student field object for one planned row.
 *
 * The field set mirrors POST /api/students (so imported students are shaped
 * exactly like admitted ones) plus the extra optional columns the template
 * offers. `id` is carried explicitly so the same row re-imported lands on the
 * same document instead of creating a second student.
 */
export function studentDataFor(
  ctx: ImportContext,
  plan: PlanRow,
  opts: { qrPin: string; admissionDate?: Date; guardianUserId?: string | null; guardianProvisioned?: boolean }
): Record<string, any> {
  const v = plan.values;
  // Guardian onboarding state:
  //   LINKED             – this row reuses an existing, working guardian account
  //   CREDENTIALS_READY  – a guardian account was provisioned by the import and
  //                        its QR/PIN access slip is available to hand over
  //   INCOMPLETE         – no guardian account exists (no usable contact supplied)
  // The student always imports; this only records what the school still has to
  // collect. No contact information is ever invented.
  const guardianOnboarding = opts.guardianUserId
    ? opts.guardianProvisioned
      ? "CREDENTIALS_READY"
      : "LINKED"
    : "INCOMPLETE";
  return {
    id: `st_${plan.qrToken}`,
    schoolId: ctx.schoolId,
    branchId: ctx.branchId,
    guardianOnboarding,
    // Only included when known, so a guardian-less student's document is shaped
    // exactly as before (the key is absent, not null).
    ...(opts.guardianUserId ? { guardianUserId: opts.guardianUserId } : {}),
    admissionNo: v.admissionNo || `IMP-${plan.qrToken.slice(3, 11).toUpperCase()}`,
    name: v.name,
    nameBn: v.nameBn,
    dob: v.dob ? new Date(v.dob) : null,
    gender: v.gender || "OTHER",
    bloodGroup: v.bloodGroup,
    registrationNo: v.registrationNo,
    roll: v.roll,
    classId: v.classId,
    sectionId: v.sectionId,
    guardianName: v.guardianName,
    guardianPhone: v.guardianPhone,
    guardianEmail: v.guardianEmail,
    guardianRelation: v.guardianRelation,
    address: v.address,
    birthCertificateNo: v.birthCertificateNo,
    previousSchoolName: v.previousSchoolName,
    previousSchoolClass: v.previousSchoolClass,
    photoUrl: v.photoUrl,
    admissionDate: opts.admissionDate || new Date(),
    qrToken: plan.qrToken,
    qrPin: opts.qrPin,
    sessionId: ctx.sessionId,
  };
}
