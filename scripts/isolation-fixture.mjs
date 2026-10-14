/**
 * isolation-fixture.mjs — create / clean a THROWAWAY second school for the
 * cross-school isolation test (pre-push check), plus a STUDENT-role user in
 * the demo school for the parity harness. Never touches demo-school data
 * beyond the fixture student user it creates and deletes itself.
 *
 *   node scripts/isolation-fixture.mjs create   → prints fixture JSON
 *   node scripts/isolation-fixture.mjs clean    → deletes everything created
 *
 * Isolation principle: every fixture id starts with `zziso-` and the create
 * pass records everything it wrote in scripts/.qa-fixtures.json; clean reads
 * that file and deletes exactly those docs (plus sweeps any leftover
 * zziso-prefixed docs in the collections it owns).
 */
import { initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { readFileSync, writeFileSync, existsSync, unlinkSync } from "node:fs";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";

import { requireEmulator } from "./lib/guard.mjs";

requireEmulator();

// Emulator-only, credential-free init with the SAME project id as seed.mjs and
// the verifier, so the fixture lands in the namespace the emulator seed uses.
// No service-account.json, no cert(), no applicationDefault().
//
// INTEGRATION 1: origin/main's side of this conflict read service-account.json /
// applicationDefault() and selected `process.env.FIRESTORE_DB_ID`. Both are
// deliberately NOT used here — this script is emulator-only by design, and
// `requireEmulator()` (plus the FIRESTORE_DB_ID rule added to guard.mjs) fails
// closed if a named Cloud database is ever named. See docs/INTEGRATION-LOG.md.
initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || undefined });
const db = getFirestore();

const TRACK = new URL(".qa-fixtures.json", import.meta.url);
const P = "zziso-"; // fixture id prefix
const now = new Date().toISOString();

async function loadTrack() {
  if (!existsSync(TRACK)) return { created: [] };
  return JSON.parse(readFileSync(TRACK, "utf8"));
}
async function saveTrack(t) {
  writeFileSync(TRACK, JSON.stringify(t, null, 2));
}

const hash = (pw) => bcrypt.hashSync(pw, 10);

/** Random per-run password so NO fixture credential is ever committed. */
const newPw = () => randomBytes(12).toString("base64url");

async function create() {
  // Safe to run twice: remove any previous fixture (which also restores the demo
  // student link) before recreating, so a second `create` never mistakes the
  // first run's fixture user for the demo student's original link.
  if (existsSync(TRACK)) await clean();

  const track = { created: [], creds: { admin: newPw(), teacher: newPw(), student: newPw(), demoStudent: newPw() } };
  const mark = (col, id) => track.created.push({ col, id });

  // ---- Throwaway school #2 --------------------------------------------
  const schoolId = `${P}school`;
  const schoolRef = db.collection("schools").doc(schoolId);
  await schoolRef.set({
    id: schoolId,
    name: "ZZ Isolation Test School",
    status: "ACTIVE",
    plan: "PRO",
    createdAt: now,
  });
  mark("schools", schoolId);

  // Staff: one SCHOOL_ADMIN
  const adminUserId = `${P}user-admin`;
  await db.collection("users").doc(adminUserId).set({
    email: "zz-iso-admin@test.local",
    name: "ZZ Iso Admin",
    role: "SCHOOL_ADMIN",
    schoolId,
    active: true,
    passwordHash: hash(track.creds.admin),
  });
  mark("users", adminUserId);

  // Teacher + teacher profile
  const teacherUserId = `${P}user-teacher`;
  await db.collection("users").doc(teacherUserId).set({
    email: "zz-iso-teacher@test.local",
    name: "ZZ Iso Teacher",
    role: "TEACHER",
    schoolId,
    active: true,
    passwordHash: hash(track.creds.teacher),
  });
  mark("users", teacherUserId);
  // db-layer convention: teacher doc id is `t_<userId>` (findUnique by userId)
  const teacherId = `t_${teacherUserId}`;
  await db.collection("teachers").doc(teacherId).set({
    schoolId,
    userId: teacherUserId,
    name: "ZZ Iso Teacher",
    designation: "Teacher",
  });
  mark("teachers", teacherId);

  // Class + section + subject
  const classId = `${P}class`;
  await db.collection("classes").doc(classId).set({ schoolId, name: "ZZ Iso Class", order: 1 });
  mark("classes", classId);
  const sectionId = `${P}section`;
  await db.collection("sections").doc(sectionId).set({ schoolId, classId, name: "ZZ Iso A" });
  mark("sections", sectionId);
  const subjectId = `${P}subject`;
  await db.collection("subjects").doc(subjectId).set({ schoolId, name: "ZZ Iso Subject", code: "ZZ-ISO" });
  mark("subjects", subjectId);

  // Student + a STUDENT-role user in the FIXTURE school (also used to prove
  // student sessions can never see demo-school data).
  const stUserId = `${P}user-student`;
  await db.collection("users").doc(stUserId).set({
    email: "zz-iso-student@test.local",
    name: "ZZ Iso Student",
    role: "STUDENT",
    schoolId,
    active: true,
    passwordHash: hash(track.creds.student),
  });
  mark("users", stUserId);
  const studentId = `${P}student`;
  await db.collection("students").doc(studentId).set({
    schoolId,
    userId: stUserId,
    name: "ZZ Iso Student",
    classId,
    sectionId,
    roll: 1,
    admissionNo: "ZZ-ISO-001",
    status: "ACTIVE",
    active: true,
  });
  mark("students", studentId);

  // Attendance rows for the fixture student (date as a real Timestamp —
  // the app writes Dates and queries them with range operators)
  for (let d = 1; d <= 3; d++) {
    const attId = `${P}att-${d}`;
    await db.collection("attendance").doc(attId).set({
      schoolId,
      studentId,
      classId,
      date: new Date(`2026-09-1${d}T00:00:00`),
      status: "PRESENT",
    });
    mark("attendance", attId);
  }

  // Homework + fee + exam + routine + meeting slot (one each)
  const hwId = `${P}homework`;
  await db.collection("homeworks").doc(hwId).set({
    schoolId, classId, sectionId, subjectId, teacherId,
    title: "ZZ Iso Homework", description: "", dueDate: "2026-09-30", createdAt: now,
  });
  mark("homeworks", hwId);
  const feeId = `${P}fee`;
  await db.collection("fees").doc(feeId).set({
    schoolId, studentId, classId, title: "ZZ Iso Fee", amount: 500, paidAmount: 0, status: "PENDING", createdAt: now,
  });
  mark("fees", feeId);
  const examId = `${P}exam`;
  await db.collection("exams").doc(examId).set({
    schoolId, classId, name: "ZZ Iso Exam", year: 2026, published: false, createdAt: now,
  });
  mark("exams", examId);
  const routineId = `${P}routine`;
  await db.collection("routines").doc(routineId).set({
    schoolId, classId, sectionId, subjectId, teacherId, day: "SUN", period: 1,
  });
  mark("routines", routineId);
  const slotId = `${P}slot`;
  await db.collection("meetingSlots").doc(slotId).set({
    schoolId, teacherId, date: "2026-09-30", start: "10:00", end: "10:15", capacity: 1,
  });
  mark("meetingSlots", slotId);

  // Chat conversation owned by the fixture school (teacher<->guardian shape)
  const convId = `${P}conv`;
  await db.collection("conversations").doc(convId).set({
    schoolId,
    partyKey: `${P}party`,
    teacherUserId,
    guardianUserId: stUserId,
    studentId,
    lastMessageAt: now,
  });
  mark("conversations", convId);

  // ---- College fixture: a COLLEGE tenant with two branches, three departments
  //      (two branch-bound, one branch-less) and two programs, plus a SCHOOL_ADMIN
  //      and a BRANCH-scoped admin. This is the tenant the college route sweep
  //      (verify-tenant-isolation.mjs) and the branch-admin college assertions
  //      (verify-branch-isolation.mjs) run as. Folded in from the temporary
  //      _tmp-college-fixture.mjs.
  const collegeSchoolId = `${P}college`;
  await db.collection("schools").doc(collegeSchoolId).set({
    id: collegeSchoolId, name: "ZZ Iso College", status: "ACTIVE", plan: "PRO",
    institutionType: "COLLEGE", createdAt: now,
  });
  mark("schools", collegeSchoolId);

  const colBranchA = `${P}col-br-a`;
  const colBranchB = `${P}col-br-b`;
  await db.collection("branches").doc(colBranchA).set({
    id: colBranchA, schoolId: collegeSchoolId, name: "ZZ Iso College Branch A", enabled: true, createdAt: now,
  });
  mark("branches", colBranchA);
  await db.collection("branches").doc(colBranchB).set({
    id: colBranchB, schoolId: collegeSchoolId, name: "ZZ Iso College Branch B", enabled: true, createdAt: now,
  });
  mark("branches", colBranchB);

  track.creds.collegeAdmin = newPw();
  track.creds.collegeBranchAdmin = newPw();
  const colAdminUserId = `${P}user-col-admin`;
  await db.collection("users").doc(colAdminUserId).set({
    email: "zz-iso-college-admin@test.local", name: "ZZ Iso College Admin",
    role: "SCHOOL_ADMIN", schoolId: collegeSchoolId, active: true,
    passwordHash: hash(track.creds.collegeAdmin),
  });
  mark("users", colAdminUserId);
  const colBranchAdminUserId = `${P}user-col-bradmin`;
  await db.collection("users").doc(colBranchAdminUserId).set({
    email: "zz-iso-college-br-admin@test.local", name: "ZZ Iso College Branch Admin",
    role: "BRANCH_ADMIN", schoolId: collegeSchoolId, scope: "BRANCH", branchId: colBranchA,
    active: true, passwordHash: hash(track.creds.collegeBranchAdmin),
  });
  mark("users", colBranchAdminUserId);

  // A permanent REGISTRAR (Phase 4d) — the third role that carries the
  // `registration` permission as `full`, so the fixture no longer needs a
  // throwaway browser harness to prove a registrar reaches the page/API.
  track.creds.collegeRegistrar = newPw();
  const colRegistrarUserId = `${P}user-col-registrar`;
  await db.collection("users").doc(colRegistrarUserId).set({
    email: "zz-iso-college-registrar@test.local", name: "ZZ Iso College Registrar",
    role: "REGISTRAR", schoolId: collegeSchoolId, scope: null, branchId: null,
    active: true, passwordHash: hash(track.creds.collegeRegistrar),
  });
  mark("users", colRegistrarUserId);

  // A permanent ACCOUNTANT (Phase 7c) — the ONE staff role the college fee
  // allow-list (D-7-18) admits as a WRITER alongside the admin-level roles, and
  // the role that may PROPOSE an award but may never approve one (D-7-13/§24.1).
  // Without it the college fee role probe could only show admin vs refused.
  track.creds.collegeAccountant = newPw();
  const colAccountantUserId = `${P}user-col-accountant`;
  await db.collection("users").doc(colAccountantUserId).set({
    email: "zz-iso-college-accountant@test.local", name: "ZZ Iso College Accountant",
    role: "ACCOUNTANT", schoolId: collegeSchoolId, scope: null, branchId: null,
    active: true, passwordHash: hash(track.creds.collegeAccountant),
  });
  mark("users", colAccountantUserId);

  const colDeptA = `${P}col-dept-a`;
  const colDeptB = `${P}col-dept-b`;
  const colDeptNone = `${P}col-dept-none`;
  await db.collection("departments").doc(colDeptA).set({
    id: colDeptA, schoolId: collegeSchoolId, name: "ZZ Iso College Dept A", code: "ZZCA",
    branchId: colBranchA, headStaffId: null, description: null, status: "ACTIVE", createdAt: now,
  });
  mark("departments", colDeptA);
  await db.collection("departments").doc(colDeptB).set({
    id: colDeptB, schoolId: collegeSchoolId, name: "ZZ Iso College Dept B", code: "ZZCB",
    branchId: colBranchB, headStaffId: null, description: null, status: "ACTIVE", createdAt: now,
  });
  mark("departments", colDeptB);
  // The branch-less department: no branchId, so only a SCHOOL-scoped session may touch it.
  await db.collection("departments").doc(colDeptNone).set({
    id: colDeptNone, schoolId: collegeSchoolId, name: "ZZ Iso College Dept None", code: "ZZCN",
    branchId: null, headStaffId: null, description: null, status: "ACTIVE", createdAt: now,
  });
  mark("departments", colDeptNone);

  const colProgA = `${P}col-prog-a`;
  const colProgB = `${P}col-prog-b`;
  await db.collection("programs").doc(colProgA).set({
    id: colProgA, schoolId: collegeSchoolId, departmentId: colDeptA, name: "ZZ Iso College Program A",
    code: "ZZPA", degreeLevel: "HSC", durationYears: 2, branchId: colBranchA, status: "ACTIVE", createdAt: now,
  });
  mark("programs", colProgA);
  await db.collection("programs").doc(colProgB).set({
    id: colProgB, schoolId: collegeSchoolId, departmentId: colDeptB, name: "ZZ Iso College Program B",
    code: "ZZPB", degreeLevel: "DEGREE_PASS", durationYears: 3, branchId: colBranchB, status: "ACTIVE", createdAt: now,
  });
  mark("programs", colProgB);

  // ---- College courses (Phase 3e) -------------------------------------------
  //      Three courses in the COLLEGE tenant: one under each branch-bound
  //      department (A and B) and one under the BRANCH-LESS department, so a
  //      BRANCH-scoped session must not reach the third. A fourth course is added
  //      to the BOTH tenant below to serve as a genuine FOREIGN course id — a row
  //      that exists, in another tenant, and must behave as NOT FOUND (never as a
  //      403 that would confirm it).
  const colCourseA = `${P}col-course-a`;
  await db.collection("courses").doc(colCourseA).set({
    id: colCourseA, schoolId: collegeSchoolId, departmentId: colDeptA, branchId: colBranchA,
    code: "ZZCA-101", title: "ZZ Iso College Course A", creditHours: 3, type: "THEORY",
    status: "ACTIVE", createdAt: now,
  });
  mark("courses", colCourseA);
  const colCourseB = `${P}col-course-b`;
  await db.collection("courses").doc(colCourseB).set({
    id: colCourseB, schoolId: collegeSchoolId, departmentId: colDeptB, branchId: colBranchB,
    code: "ZZCB-101", title: "ZZ Iso College Course B", creditHours: 4, type: "THEORY",
    status: "ACTIVE", createdAt: now,
  });
  mark("courses", colCourseB);
  // The branch-less course (the deptNone analogue): no branchId, so only a
  // SCHOOL-scoped session may reach it.
  const colCourseNone = `${P}col-course-none`;
  await db.collection("courses").doc(colCourseNone).set({
    id: colCourseNone, schoolId: collegeSchoolId, departmentId: colDeptNone, branchId: null,
    code: "ZZCN-101", title: "ZZ Iso College Course None", creditHours: null, type: "THEORY",
    status: "ACTIVE", createdAt: now,
  });
  mark("courses", colCourseNone);

  // ---- Program→course mappings (Phase 3e): one per branch — on program A and on
  //      program B — so a branch admin can be proven confined to its own.
  const colMapA = `${P}col-map-a`;
  await db.collection("programCourses").doc(colMapA).set({
    id: colMapA, schoolId: collegeSchoolId, programId: colProgA, courseId: colCourseA,
    termNumber: 1, requirement: "REQUIRED", createdAt: now,
  });
  mark("programCourses", colMapA);
  const colMapB = `${P}col-map-b`;
  await db.collection("programCourses").doc(colMapB).set({
    id: colMapB, schoolId: collegeSchoolId, programId: colProgB, courseId: colCourseB,
    termNumber: 1, requirement: "REQUIRED", createdAt: now,
  });
  mark("programCourses", colMapB);

  // ---- College students + course registrations (Phase 4d) --------------------
  //      Two students, one per branch-bound programme, so each has a registration
  //      in the branch its programme belongs to. Written RAW (the fixture never
  //      calls the app), carrying the same schoolId/branchId/programId/termNumber
  //      shape the students and course-registration routes write, so the branch
  //      and tenant probes exercise the real confinement.
  const colStuA = `${P}col-stu-a`;
  await db.collection("students").doc(colStuA).set({
    id: colStuA, schoolId: collegeSchoolId, branchId: colBranchA, name: "ZZ Iso College Student A",
    admissionNo: "ZZ4D-COL-A", programId: colProgA, termNumber: 1, active: true, createdAt: now,
  });
  mark("students", colStuA);
  const colStuB = `${P}col-stu-b`;
  await db.collection("students").doc(colStuB).set({
    id: colStuB, schoolId: collegeSchoolId, branchId: colBranchB, name: "ZZ Iso College Student B",
    admissionNo: "ZZ4D-COL-B", programId: colProgB, termNumber: 1, active: true, createdAt: now,
  });
  mark("students", colStuB);

  // One PENDING registration per branch — the state a PATCH/DELETE probe may act on.
  const colRegA = `${P}col-reg-a`;
  await db.collection("courseRegistrations").doc(colRegA).set({
    id: colRegA, schoolId: collegeSchoolId, branchId: colBranchA, studentId: colStuA,
    courseId: colCourseA, programId: colProgA, termNumber: 1, status: "PENDING",
    requestedById: `${P}user-col-admin`, decidedById: null, decidedAt: null, createdAt: now,
  });
  mark("courseRegistrations", colRegA);
  const colRegB = `${P}col-reg-b`;
  await db.collection("courseRegistrations").doc(colRegB).set({
    id: colRegB, schoolId: collegeSchoolId, branchId: colBranchB, studentId: colStuB,
    courseId: colCourseB, programId: colProgB, termNumber: 1, status: "PENDING",
    requestedById: `${P}user-col-admin`, decidedById: null, decidedAt: null, createdAt: now,
  });
  mark("courseRegistrations", colRegB);

  // ---- College results (Phase 6c) -------------------------------------------
  //      One `courseResults` row per branch-bound programme, so a BRANCH-scoped
  //      session has a genuine other-branch row to be refused, and a SCHOOL-scoped
  //      one has both. Written RAW, carrying the same
  //      schoolId/branchId/studentId/courseId/programId/termNumber/attempt shape
  //      the results route writes, so the tenant and branch probes exercise the
  //      real confinement. The marks are ordinary (70/100 and 80/100): the
  //      LETTER/point/CGPA are derived at read time from the tenant's ACTIVE
  //      scheme (D-6-12), so the fixture deliberately stores no grade at all.
  const colResA = `${P}col-res-a`;
  await db.collection("courseResults").doc(colResA).set({
    id: colResA, schoolId: collegeSchoolId, branchId: colBranchA, studentId: colStuA,
    courseId: colCourseA, programId: colProgA, termNumber: 1, attempt: 1,
    obtained: 70, fullMarks: 100, recordedById: null, createdAt: now,
  });
  mark("courseResults", colResA);
  const colResB = `${P}col-res-b`;
  await db.collection("courseResults").doc(colResB).set({
    id: colResB, schoolId: collegeSchoolId, branchId: colBranchB, studentId: colStuB,
    courseId: colCourseB, programId: colProgB, termNumber: 1, attempt: 1,
    obtained: 80, fullMarks: 100, recordedById: null, createdAt: now,
  });
  mark("courseResults", colResB);

  // ---- BOTH tenant WITH college data (one department) + a SCHOOL_ADMIN -------
  const bothSchoolId = `${P}both`;
  await db.collection("schools").doc(bothSchoolId).set({
    id: bothSchoolId, name: "ZZ Iso Both", status: "ACTIVE", plan: "PRO",
    institutionType: "BOTH", createdAt: now,
  });
  mark("schools", bothSchoolId);
  const bothDeptId = `${P}both-dept`;
  await db.collection("departments").doc(bothDeptId).set({
    id: bothDeptId, schoolId: bothSchoolId, name: "ZZ Iso Both Dept", code: "ZZBD",
    branchId: null, headStaffId: null, description: null, status: "ACTIVE", createdAt: now,
  });
  mark("departments", bothDeptId);
  // A course in the BOTH tenant — the FOREIGN course id the 3e probes use.
  const bothCourse = `${P}both-course`;
  await db.collection("courses").doc(bothCourse).set({
    id: bothCourse, schoolId: bothSchoolId, departmentId: bothDeptId, branchId: null,
    code: "ZZBD-101", title: "ZZ Iso Both Course", creditHours: 3, type: "THEORY",
    status: "ACTIVE", createdAt: now,
  });
  mark("courses", bothCourse);
  // A program + mapping in the BOTH tenant too, so the 3e probes have a genuine
  // FOREIGN mapping id (another tenant's row) to prove is NOT FOUND.
  const bothProg = `${P}both-prog`;
  await db.collection("programs").doc(bothProg).set({
    id: bothProg, schoolId: bothSchoolId, departmentId: bothDeptId, name: "ZZ Iso Both Program",
    code: "ZZBP", degreeLevel: "HSC", durationYears: 2, termSystem: "YEARLY",
    branchId: null, status: "ACTIVE", createdAt: now,
  });
  mark("programs", bothProg);
  const bothMap = `${P}both-map`;
  await db.collection("programCourses").doc(bothMap).set({
    id: bothMap, schoolId: bothSchoolId, programId: bothProg, courseId: bothCourse,
    termNumber: 1, requirement: "REQUIRED", createdAt: now,
  });
  mark("programCourses", bothMap);
  // A BOTH-tenant student + registration (Phase 4d): the second college-capable
  // tenant's OWN row, so its list shows exactly this and never the COLLEGE
  // tenant's. Written raw, same shape as the routes.
  const bothStu = `${P}both-stu`;
  await db.collection("students").doc(bothStu).set({
    id: bothStu, schoolId: bothSchoolId, branchId: null, name: "ZZ Iso Both Student",
    admissionNo: "ZZ4D-BOTH-1", programId: bothProg, termNumber: 1, active: true, createdAt: now,
  });
  mark("students", bothStu);
  const bothReg = `${P}both-reg`;
  await db.collection("courseRegistrations").doc(bothReg).set({
    id: bothReg, schoolId: bothSchoolId, branchId: null, studentId: bothStu,
    courseId: bothCourse, programId: bothProg, termNumber: 1, status: "PENDING",
    requestedById: `${P}user-both-admin`, decidedById: null, decidedAt: null, createdAt: now,
  });
  mark("courseRegistrations", bothReg);
  // The BOTH tenant's OWN result row: the second college-capable tenant's row, so
  // its list shows exactly this and never the COLLEGE tenant's.
  const bothRes = `${P}both-res`;
  await db.collection("courseResults").doc(bothRes).set({
    id: bothRes, schoolId: bothSchoolId, branchId: null, studentId: bothStu,
    courseId: bothCourse, programId: bothProg, termNumber: 1, attempt: 1,
    obtained: 60, fullMarks: 100, recordedById: null, createdAt: now,
  });
  mark("courseResults", bothRes);
  track.creds.bothAdmin = newPw();
  const bothAdminUserId = `${P}user-both-admin`;
  await db.collection("users").doc(bothAdminUserId).set({
    email: "zz-iso-both-admin@test.local", name: "ZZ Iso Both Admin",
    role: "SCHOOL_ADMIN", schoolId: bothSchoolId, active: true,
    passwordHash: hash(track.creds.bothAdmin),
  });
  mark("users", bothAdminUserId);

  // ---- Phase 7e: the BOTH tenant's OWN money, in BOTH of its halves --------
  // Q3/D-7-12 states ONE binding condition — on a BOTH tenant the two modes'
  // money must never mix in a read — and it cannot be tested on a tenant whose
  // school half is EMPTY: an empty list is "unaffected by college money" for the
  // wrong reason. So the BOTH tenant that already exists for the 4d/7c probes
  // gets a deterministic spine in BOTH halves, and the amounts are chosen to be
  // unmistakable and non-overlapping — the school's own 12,000/5,000 against the
  // college's 45,000 — so a verifier can assert WHICH half's money came back,
  // not merely that some finite number did.
  //
  // Written RAW, like every other row in this fixture: it never calls the app's
  // audit()/notifyUsers(), so creating it leaves no audit or notification rows.
  const bothFeeSetting = bothSchoolId; // a `feeSetting` is keyed by its tenant
  await db.collection("feeSettings").doc(bothFeeSetting).set({
    id: bothFeeSetting, schoolId: bothSchoolId, monthlyFee: 1500, admissionFee: 5000,
    lateFee: 0, currency: "BDT", updatedAt: now,
  });
  mark("feeSettings", bothFeeSetting);
  const bothFeeA = `${P}both-fee-a`;
  await db.collection("fees").doc(bothFeeA).set({
    id: bothFeeA, schoolId: bothSchoolId, branchId: null, studentId: bothStu,
    title: "ZZ Iso Both School Tuition", amount: 12000, paidAmount: 3000, status: "PARTIAL",
    feeType: "MONTHLY", dueDate: now, note: null, createdAt: now,
  });
  mark("fees", bothFeeA);
  const bothFeeB = `${P}both-fee-b`;
  await db.collection("fees").doc(bothFeeB).set({
    id: bothFeeB, schoolId: bothSchoolId, branchId: null, studentId: bothStu,
    title: "ZZ Iso Both School Admission", amount: 5000, paidAmount: 5000, status: "PAID",
    feeType: "ADMISSION", dueDate: now, note: null, createdAt: now,
  });
  mark("fees", bothFeeB);
  const bothPayment = `${P}both-payment-1`;
  await db.collection("payments").doc(bothPayment).set({
    id: bothPayment, schoolId: bothSchoolId, studentId: bothStu, feeId: bothFeeA,
    amount: 3000, method: "CASH", refNo: "ZZRCP-900001", receiptNo: "ZZRCP-900001",
    date: now, createdAt: now,
  });
  mark("payments", bothPayment);
  const bothLedgerSchool = `${P}both-ledger-school`;
  await db.collection("ledger").doc(bothLedgerSchool).set({
    id: bothLedgerSchool, schoolId: bothSchoolId, kind: "PAYMENT", amount: 3000, method: "CASH",
    refNo: "ZZRCP-900001", status: "CONFIRMED", studentId: bothStu, feeId: bothFeeA,
    actorId: null, description: "Payment for ZZ Iso Both School Tuition",
    meta: { receiptNo: "ZZRCP-900001" }, createdAt: now,
  });
  mark("ledger", bothLedgerSchool);

  const bothHead = `${P}both-head-tuition`;
  await db.collection("collegeFeeHeads").doc(bothHead).set({
    id: bothHead, schoolId: bothSchoolId, branchId: null, name: "ZZ Iso Both College Tuition",
    bucket: "TUITION", frequency: "TERM", optional: false, active: true, dueDay: null,
    note: null, createdAt: now,
  });
  mark("collegeFeeHeads", bothHead);
  const bothStructure = `${P}both-str-1`;
  await db.collection("collegeFeeStructures").doc(bothStructure).set({
    id: bothStructure, schoolId: bothSchoolId, branchId: null, programId: bothProg,
    termNumber: 1, headId: bothHead, amount: 45000, required: true, unit: "STUDENT",
    basis: "FLAT", note: null, createdAt: now,
  });
  mark("collegeFeeStructures", bothStructure);
  const bothConfig = `cfc_${bothSchoolId}`;
  await db.collection("collegeFeeConfigs").doc(bothConfig).set({
    id: bothConfig, schoolId: bothSchoolId, currency: "BDT", channels: [], paymentNote: null,
    updatedAt: now,
  });
  mark("collegeFeeConfigs", bothConfig);
  const bothCharge = `${P}both-charge-1`;
  await db.collection("collegeFees").doc(bothCharge).set({
    id: bothCharge, schoolId: bothSchoolId, branchId: null, studentId: bothStu,
    programId: bothProg, termNumber: 1, headId: bothHead, headName: "ZZ Iso Both College Tuition",
    bucket: "TUITION", title: "ZZ Iso Both College Tuition — Term 1", amount: 45000,
    grossAmount: 45000, discount: 0, paidAmount: 15000, status: "PARTIAL", sequence: 1,
    unit: "STUDENT", dueDay: null, dueDate: now, billedAt: now, actorId: null, createdAt: now,
  });
  mark("collegeFees", bothCharge);
  const bothLedgerCollege = `${P}both-ledger-college`;
  await db.collection("ledger").doc(bothLedgerCollege).set({
    id: bothLedgerCollege, schoolId: bothSchoolId, kind: "PAYMENT", amount: 15000, method: "CASH",
    refNo: "CRCP-900001", status: "CONFIRMED", studentId: bothStu, feeId: null, actorId: null,
    description: "College payment — ZZ Iso Both College Tuition",
    meta: { receiptNo: "CRCP-900001", collegeFeeId: bothCharge, programId: bothProg, termNumber: 1 },
    createdAt: now,
  });
  mark("ledger", bothLedgerCollege);

  // The three roles D-7-18 REFUSES, inside a college-capable tenant — so a probe
  // can show the refusal is the ROLE rule and not the tenant gate. A SCHOOL
  // tenant answers NO_COLLEGE first, which would mask whichever rule is broken.
  for (const [role, emailCred, name] of [
    ["TEACHER", "bothTeacher", "ZZ Iso Both Teacher"],
    ["GUARDIAN", "bothGuardian", "ZZ Iso Both Guardian"],
    ["STUDENT", "bothStudent", "ZZ Iso Both Student User"],
  ]) {
    track.creds[emailCred] = newPw();
    const uid = `${P}user-both-${role.toLowerCase()}`;
    await db.collection("users").doc(uid).set({
      email: `zz-iso-both-${role.toLowerCase()}@test.local`, name,
      role, schoolId: bothSchoolId, active: true,
      passwordHash: hash(track.creds[emailCred]),
    });
    mark("users", uid);
  }

  // ---- BOTH tenant with NO college data (its downgrade must be ALLOWED) -----
  const bothEmptySchoolId = `${P}both-empty`;
  await db.collection("schools").doc(bothEmptySchoolId).set({
    id: bothEmptySchoolId, name: "ZZ Iso Both Empty", status: "ACTIVE", plan: "PRO",
    institutionType: "BOTH", createdAt: now,
  });
  mark("schools", bothEmptySchoolId);

  // ---- COLLEGE tenant holding ONLY a registration (Phase 5-pre) -------------
  //      No department and no program ON PURPOSE: this tenant's whole college
  //      footprint is one courseRegistrations row, so its downgrade may only be
  //      refused by the new registrations count. Give it a department or a
  //      program and the refusal would come from the old (2g) check, making the
  //      5-pre case pass vacuously.
  const regOnlySchoolId = `${P}reg-only`;
  await db.collection("schools").doc(regOnlySchoolId).set({
    id: regOnlySchoolId, name: "ZZ Iso Registrations Only", status: "ACTIVE", plan: "PRO",
    institutionType: "COLLEGE", createdAt: now,
  });
  mark("schools", regOnlySchoolId);
  // The minimum it needs is nothing: the guard counts by schoolId alone and the
  // route never dereferences studentId/courseId/programId, so these refs stay
  // uncreated on purpose.
  const regOnlyId = `${P}reg-only-1`;
  await db.collection("courseRegistrations").doc(regOnlyId).set({
    id: regOnlyId, schoolId: regOnlySchoolId, branchId: null,
    studentId: `${P}reg-only-stu`, courseId: `${P}reg-only-course`,
    programId: `${P}reg-only-prog`, termNumber: 1, status: "PENDING",
    requestedById: null, decidedById: null, decidedAt: null, createdAt: now,
  });
  mark("courseRegistrations", regOnlyId);

  // ---- COLLEGE tenant with NO college data at all (the paired control) ------
  //      Same shape as the tenant above, minus its one registration: its
  //      downgrade must still be ALLOWED, which is what isolates the
  //      registration as the only thing gating the refusal.
  const regOnlyEmptySchoolId = `${P}reg-only-empty`;
  await db.collection("schools").doc(regOnlyEmptySchoolId).set({
    id: regOnlyEmptySchoolId, name: "ZZ Iso Registrations Only Empty", status: "ACTIVE", plan: "PRO",
    institutionType: "COLLEGE", createdAt: now,
  });
  mark("schools", regOnlyEmptySchoolId);

  // ---- STUDENT fixture user in the DEMO school (for parity harness) ----
  const demoSchool = process.env.DEMO_SCHOOL_ID;
  if (demoSchool) {
    const demoStudentSnap = await db.collection("students")
      .where("schoolId", "==", demoSchool).limit(1).get();
    if (!demoStudentSnap.empty) {
      const demoStudent = demoStudentSnap.docs[0].data();
      const demoStUserId = `${P}user-demo-student`;
      await db.collection("users").doc(demoStUserId).set({
        email: "zz-iso-demo-student@test.local",
        name: "ZZ Iso Demo Student",
        role: "STUDENT",
        schoolId: demoSchool,
        active: true,
        passwordHash: hash(track.creds.demoStudent),
      });
      mark("users", demoStUserId);
      await db.collection("students").doc(demoStudentSnap.docs[0].id)
        .update({ userId: demoStUserId });
      track.demoStudentLink = {
        col: "students",
        id: demoStudentSnap.docs[0].id,
        prevUserId: demoStudent.userId ?? null,
      };
    }
  }

  await saveTrack(track);
  console.log(JSON.stringify({
    ok: true,
    schoolId,
    admin: { email: "zz-iso-admin@test.local", password: track.creds.admin },
    teacher: { email: "zz-iso-teacher@test.local", password: track.creds.teacher },
    student: { email: "zz-iso-student@test.local", password: track.creds.student },
    demoStudent: { email: "zz-iso-demo-student@test.local", password: track.creds.demoStudent },
    classId, sectionId, subjectId, studentId, teacherId, examId, feeId, hwId, convId,
    colCourseA, colCourseB, colCourseNone, colMapA, colMapB, bothCourse, bothProg, bothMap,
    colStuA, colStuB, colRegA, colRegB, colResA, colResB, bothStu, bothReg, bothRes,
    regOnlySchoolId, regOnlyEmptySchoolId, regOnlyId,
  }, null, 2));
}

async function clean() {
  const track = await loadTrack();
  let deleted = 0;
  for (const { col, id } of [...(track.created || [])].reverse()) {
    try {
      await db.collection(col).doc(id).delete();
      deleted++;
    } catch (e) {
      console.error(`  ! failed ${col}/${id}: ${e.message}`);
    }
  }
  // Restore the demo student's original userId link
  if (track.demoStudentLink) {
    const { col, id, prevUserId } = track.demoStudentLink;
    const ref = db.collection(col).doc(id);
    if (prevUserId) await ref.update({ userId: prevUserId });
    else await ref.update({ userId: FieldValue.delete() });
    deleted++;
  }
  // Safety sweep: any zziso- docs left in owned collections. Scoped by the
  // fixture id prefix only — never by school.
  //
  // The fixture writes RAW Firestore docs directly and never calls the app's
  // audit()/notifyUsers(), so creating it produces NO auditLogs/notifications
  // rows. The only such rows an isolation run leaves are the LOGIN rows written
  // by the verifier's sign-ins; those belong to the verifier's activity and
  // cannot be attributed to (or safely deleted by) the fixture.
  const owned = ["users", "students", "classes", "sections", "subjects", "teachers",
    "attendance", "homeworks", "fees", "exams", "routines", "meetingSlots", "conversations", "schools",
    "branches", "departments", "programs", "courses", "programCourses", "courseRegistrations",
    "courseResults",
    // Phase 8 ca-2: the per-course attendance row. A row a verifier creates
    // THROUGH THE APP carries a derived `ca_…` id the prefix sweep above cannot
    // reach, so the schoolId backstop below sweeps this collection too.
    "courseAttendances",
    // Phase 7c: the college fee spine. The school's own `fees`/`feeSettings`/
    // `payments`/`ledger` rows are NEVER swept here (a college payment writes only
    // a ledger entry, and that row belongs to the verifier's activity, not the
    // fixture — exactly like the login audit rows above).
    "collegeFeeHeads", "collegeFeeStructures", "collegeFees", "collegeFeeConfigs", "collegeDiscounts"];
  for (const col of owned) {
    const snap = await db.collection(col).where("__name__", ">=", P).where("__name__", "<=", P + "\uf8ff").get();
    for (const d of snap.docs) {
      await d.ref.delete();
      deleted++;
    }
  }
  // Phase 7c backstop: a college row created THROUGH THE APP carries a
  // server-generated or derived id (`cf_…` charge, `r_…` head/award, `cfc_…`
  // config, and — Phase 8 ca-2 — a `ca_…` attendance row) that the `zziso-`
  // prefix sweep above cannot reach, so a verifier that builds a college spine
  // over HTTP would leave it behind. Every fixture tenant's own schoolId starts
  // with the same prefix, so sweep these college collections by schoolId too —
  // and ONLY where the schoolId is a fixture one, so a real tenant's rows can
  // never be touched.
  for (const col of ["collegeFeeHeads", "collegeFeeStructures", "collegeFees", "collegeFeeConfigs", "collegeDiscounts", "courseAttendances"]) {
    const snap = await db.collection(col).where("schoolId", ">=", P).where("schoolId", "<=", P + "\uf8ff").get();
    for (const d of snap.docs) {
      await d.ref.delete();
      deleted++;
    }
  }
  if (existsSync(TRACK)) unlinkSync(TRACK);
  console.log(`cleaned: ${deleted} doc(s) deleted`);
}

const mode = process.argv[2];
if (mode === "create") await create();
else if (mode === "clean") await clean();
else {
  console.error("usage: node scripts/isolation-fixture.mjs create|clean");
  process.exit(1);
}
