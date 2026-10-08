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
  track.creds.bothAdmin = newPw();
  const bothAdminUserId = `${P}user-both-admin`;
  await db.collection("users").doc(bothAdminUserId).set({
    email: "zz-iso-both-admin@test.local", name: "ZZ Iso Both Admin",
    role: "SCHOOL_ADMIN", schoolId: bothSchoolId, active: true,
    passwordHash: hash(track.creds.bothAdmin),
  });
  mark("users", bothAdminUserId);

  // ---- BOTH tenant with NO college data (its downgrade must be ALLOWED) -----
  const bothEmptySchoolId = `${P}both-empty`;
  await db.collection("schools").doc(bothEmptySchoolId).set({
    id: bothEmptySchoolId, name: "ZZ Iso Both Empty", status: "ACTIVE", plan: "PRO",
    institutionType: "BOTH", createdAt: now,
  });
  mark("schools", bothEmptySchoolId);

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
    colStuA, colStuB, colRegA, colRegB, bothStu, bothReg,
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
    "branches", "departments", "programs", "courses", "programCourses", "courseRegistrations"];
  for (const col of owned) {
    const snap = await db.collection(col).where("__name__", ">=", P).where("__name__", "<=", P + "\uf8ff").get();
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
