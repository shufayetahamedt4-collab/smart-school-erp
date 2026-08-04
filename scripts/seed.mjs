/**
 * Seeds Firestore with a demo Super Admin, a demo school and rich sample data
 * so every module can be explored immediately.
 *
 * Run:  node scripts/seed.mjs
 * Safe to re-run (idempotent — skips entities that already exist).
 *
 * Requires Firebase Admin credentials via env:
 *   FIREBASE_PROJECT_ID / FIREBASE_CLIENT_EMAIL / FIREBASE_PRIVATE_KEY
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import bcrypt from "bcryptjs";
import crypto from "node:crypto";
import { checkpoint } from "./progress.mjs";

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

if (!PROJECT_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error(
    "Missing Firebase Admin credentials. Set FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env"
  );
  process.exit(1);
}

if (!getApps().length) {
  initializeApp({
    projectId: PROJECT_ID,
    credential: cert({
      projectId: PROJECT_ID,
      clientEmail: CLIENT_EMAIL,
      privateKey: PRIVATE_KEY.replace(/\\n/g, "\n"),
    }),
  });
}
const db = getFirestore();

const PASSWORD = {
  admin: "Admin@123",
  school: "School@123",
  teacher: "Teacher@123",
  guardian: "Guardian@123",
};

const hash = (p) => bcrypt.hashSync(p, 10);

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const randomHex = (n = 16) => crypto.randomBytes(n).toString("hex");
const randomPin = () => String(1000 + Math.floor(Math.random() * 9000));

// --- deterministic Firestore doc ids (must match src/lib/db.ts) ---
const userDoc = (email) => `u_${sha1(String(email).toLowerCase())}`;
const schoolDoc = (slug) => `s_${sha1(String(slug))}`;
const teacherDoc = (userId) => `t_${userId}`;
const studentDoc = (qrToken) => `st_${qrToken}`;
const feeSettingDoc = (schoolId) => `fs_${schoolId}`;
const settingDoc = (key) => `set_${key}`;
const dateKey = (d) => {
  const dt = new Date(d);
  const pad = (n) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
};
const attendanceDoc = (studentId, date) => `a_${studentId}_${dateKey(date)}`;
const markDoc = (examId, studentId, subjectId) => `m_${examId}_${studentId}_${subjectId}`;

// date at local midnight, offset days from today
const day = (offset) => {
  const dt = new Date();
  dt.setHours(0, 0, 0, 0);
  dt.setDate(dt.getDate() + offset);
  return dt;
};

const gradeInfo = (obtained, full = 100) => {
  const pct = (obtained / full) * 100;
  if (pct >= 80) return { grade: "A+", gpa: 5.0 };
  if (pct >= 70) return { grade: "A", gpa: 4.0 };
  if (pct >= 60) return { grade: "A-", gpa: 3.5 };
  if (pct >= 50) return { grade: "B", gpa: 3.0 };
  if (pct >= 40) return { grade: "C", gpa: 2.0 };
  if (pct >= 33) return { grade: "D", gpa: 1.0 };
  return { grade: "F", gpa: 0.0 };
};

const setIfMissing = async (model, id, data) => {
  const ref = db.collection(model).doc(id);
  const snap = await ref.get();
  if (!snap.exists) {
    await ref.set(clean(data));
    return true;
  }
  return false;
};

/** Strip undefined values (Firestore rejects them). */
const clean = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      out[k] = clean(v);
    } else {
      out[k] = v;
    }
  }
  return out;
};

async function main() {
  // ------------------------------------------------------------------ settings
  await setIfMissing("settings", settingDoc("site_name"), { key: "site_name", value: "Amar E School" });

  // ------------------------------------------------------------- super admin
  const superAdminId = userDoc("admin@smartschool.com");
  await setIfMissing("users", superAdminId, {
    email: "admin@smartschool.com",
    name: "System Administrator",
    role: "SUPER_ADMIN",
    active: true,
    passwordHash: hash(PASSWORD.admin),
  });
  console.log("✓ Super Admin: admin@smartschool.com / Admin@123");
  checkpoint("seed", "settings + super admin done");

  // ------------------------------------------------------------- demo school
  const schoolId = schoolDoc("sunrise");
  const schoolRef = db.collection("schools").doc(schoolId);
  let createdSchool = false;
  if (!(await schoolRef.get()).exists) {
    await schoolRef.set({
      name: "Sunrise International School",
      slug: "sunrise",
      tagline: "Nurturing tomorrow's leaders",
      address: "House 12, Road 5, Dhanmondi, Dhaka 1205",
      phone: "+880 1712-345678",
      email: "info@sunrise.edu.bd",
      website: "www.sunrise.edu.bd",
      status: "ACTIVE",
      plan: "Pro",
      createdAt: new Date(),
    });
    createdSchool = true;
    console.log("✓ Created demo school: Sunrise International School");
  } else {
    console.log("✓ Demo school already exists");
  }

  await setIfMissing("feeSettings", feeSettingDoc(schoolId), {
    schoolId,
    monthlyFee: 1500,
    admissionFee: 5000,
  });

  checkpoint("seed", "school + feeSettings done");
  // ------------------------------------------------------------- school admin
  await setIfMissing("users", userDoc("principal@sunrise.edu"), {
    email: "principal@sunrise.edu",
    name: "Nusrat Jahan (Principal)",
    role: "SCHOOL_ADMIN",
    schoolId,
    active: true,
    passwordHash: hash(PASSWORD.school),
  });
  console.log("✓ School Admin: principal@sunrise.edu / School@123");
  checkpoint("seed", "school admin user done");

  // ------------------------------------------------------------- classes
  const classNames = ["Class 1", "Class 2", "Class 3", "Class 4", "Class 5"];
  const classRooms = {};
  for (let i = 0; i < classNames.length; i++) {
    const name = classNames[i];
    const list = await db.collection("classes").where("schoolId", "==", schoolId).where("name", "==", name).get();
    let cls;
    if (list.empty) {
      const ref = db.collection("classes").doc();
      cls = { id: ref.id, schoolId, name, order: i + 1 };
      await ref.set({ schoolId, name, order: i + 1 });
    } else {
      cls = { id: list.docs[0].id, ...list.docs[0].data() };
    }
    classRooms[name] = cls;
  }

  // ------------------------------------------------------------- sections
  const sections = {};
  for (const [cn, cls] of Object.entries(classRooms)) {
    for (const secName of ["A", "B"]) {
      const list = await db.collection("sections").where("classId", "==", cls.id).where("name", "==", secName).get();
      let sec;
      if (list.empty) {
        const ref = db.collection("sections").doc();
        sec = { id: ref.id, schoolId, classId: cls.id, name: secName };
        await ref.set({ schoolId, classId: cls.id, name: secName });
      } else {
        sec = { id: list.docs[0].id, ...list.docs[0].data() };
      }
      sections[`${cn}-${secName}`] = sec;
    }
  }

  // ------------------------------------------------------------- subjects
  const subjectNames = ["Bangla", "English", "Mathematics", "Science", "Social Studies", "ICT", "Religion"];
  const subjects = {};
  for (const sn of subjectNames) {
    const list = await db.collection("subjects").where("schoolId", "==", schoolId).where("name", "==", sn).get();
    let sub;
    if (list.empty) {
      const ref = db.collection("subjects").doc();
      sub = { id: ref.id, schoolId, name: sn, code: sn.slice(0, 3).toUpperCase() };
      await ref.set({ schoolId, name: sn, code: sn.slice(0, 3).toUpperCase() });
    } else {
      sub = { id: list.docs[0].id, ...list.docs[0].data() };
    }
    subjects[sn] = sub;
  }

  checkpoint("seed", "classes + sections + subjects done");
  // ------------------------------------------------------------- teachers
  const teacherData = [
    { email: "teacher@sunrise.edu", name: "Md. Rafiqul Islam", designation: "Senior Teacher", qualification: "M.A. (Bangla)", subject: "Bangla" },
    { email: "teacher2@sunrise.edu", name: "Farhana Akter", designation: "Assistant Teacher", qualification: "B.A. (Hons) English", subject: "English" },
    { email: "teacher3@sunrise.edu", name: "Hasan Mahmud", designation: "Assistant Teacher", qualification: "M.Sc. Mathematics", subject: "Mathematics" },
    { email: "teacher4@sunrise.edu", name: "Sharmin Sultana", designation: "Assistant Teacher", qualification: "B.Sc. Physics", subject: "Science" },
  ];
  const teachers = {};
  for (const td of teacherData) {
    const userId = userDoc(td.email);
    await setIfMissing("users", userId, {
      email: td.email,
      name: td.name,
      role: "TEACHER",
      schoolId,
      active: true,
      passwordHash: hash(PASSWORD.teacher),
    });
    const teacherId = teacherDoc(userId);
    await setIfMissing("teachers", teacherId, {
      userId,
      schoolId,
      designation: td.designation,
      qualification: td.qualification,
      joinDate: day(-400),
    });
    teachers[td.subject] = { id: teacherId, userId, schoolId };
  }
  console.log("✓ Teachers created (teacher@sunrise.edu / Teacher@123)");

  // ------------------------------------------------------------- assignments
  for (const [subjectName, teacher] of Object.entries(teachers)) {
    const sub = subjects[subjectName];
    if (!sub || !teacher) continue;
    for (const cn of ["Class 1", "Class 2", "Class 3"]) {
      const list = await db
        .collection("assignments")
        .where("teacherId", "==", teacher.id)
        .where("classId", "==", classRooms[cn].id)
        .where("subjectId", "==", sub.id)
        .get();
      if (list.empty) {
        await db.collection("assignments").add({
          schoolId,
          teacherId: teacher.id,
          classId: classRooms[cn].id,
          sectionId: sections[`${cn}-A`].id,
          subjectId: sub.id,
        });
      }
    }
  }

  checkpoint("seed", "teachers + assignments done");
  // ------------------------------------------------------------- students
  const studentData = [
    { name: "Ayan Rahman", cls: "Class 1", sec: "A", roll: 1, gender: "MALE", blood: "A_POS", religion: "ISLAM", guardian: "Kamrul Rahman", gPhone: "+8801811-000001", gRel: "Father", gEmail: "guardian1@demo.com", med: "None", addr: "Dhanmondi, Dhaka" },
    { name: "Mim Akter", cls: "Class 1", sec: "A", roll: 2, gender: "FEMALE", blood: "O_POS", religion: "ISLAM", guardian: "Rasheda Akter", gPhone: "+8801811-000002", gRel: "Mother", gEmail: "guardian2@demo.com", addr: "Mohammadpur, Dhaka" },
    { name: "Tahsin Ahmed", cls: "Class 1", sec: "B", roll: 1, gender: "MALE", blood: "B_POS", religion: "ISLAM", guardian: "Shafiq Ahmed", gPhone: "+8801811-000003", gRel: "Father", gEmail: "guardian3@demo.com", addr: "Mirpur, Dhaka" },
    { name: "Sadia Islam", cls: "Class 2", sec: "A", roll: 1, gender: "FEMALE", blood: "AB_POS", religion: "ISLAM", guardian: "Jahangir Islam", gPhone: "+8801811-000004", gRel: "Father", gEmail: "guardian4@demo.com", addr: "Banani, Dhaka" },
    { name: "Rafi Chowdhury", cls: "Class 2", sec: "A", roll: 2, gender: "MALE", blood: "O_NEG", religion: "HINDU", guardian: "Sumon Chowdhury", gPhone: "+8801811-000005", gRel: "Father", addr: "Uttara, Dhaka" },
    { name: "Nusrat Jannat", cls: "Class 2", sec: "B", roll: 1, gender: "FEMALE", blood: "A_NEG", religion: "ISLAM", guardian: "Alamgir Hossain", gPhone: "+8801811-000006", gRel: "Father", gEmail: "guardian5@demo.com", addr: "Motijheel, Dhaka" },
    { name: "Arif Hossain", cls: "Class 3", sec: "A", roll: 1, gender: "MALE", blood: "B_NEG", religion: "ISLAM", guardian: "Mizan Hossain", gPhone: "+8801811-000007", gRel: "Father", gEmail: "guardian6@demo.com", med: "Asthma — avoid dust", addr: "Gulshan, Dhaka" },
    { name: "Faria Tabassum", cls: "Class 3", sec: "A", roll: 2, gender: "FEMALE", blood: "A_POS", religion: "CHRISTIAN", guardian: "Pavel Gomes", gPhone: "+8801811-000008", gRel: "Father", gEmail: "guardian7@demo.com", addr: "Pallabi, Dhaka" },
    { name: "Mahir Khan", cls: "Class 3", sec: "B", roll: 1, gender: "MALE", blood: "O_POS", religion: "ISLAM", guardian: "Sajid Khan", gPhone: "+8801811-000009", gRel: "Father", addr: "Tejgaon, Dhaka" },
    { name: "Prity Das", cls: "Class 4", sec: "A", roll: 1, gender: "FEMALE", blood: "AB_NEG", religion: "HINDU", guardian: "Bimal Das", gPhone: "+8801811-000010", gRel: "Father", gEmail: "guardian8@demo.com", addr: "Shantinagar, Dhaka" },
    { name: "Zawad Hasan", cls: "Class 4", sec: "B", roll: 1, gender: "MALE", blood: "B_POS", religion: "ISLAM", guardian: "Rubel Hasan", gPhone: "+8801811-000011", gRel: "Father", addr: "Khilgaon, Dhaka" },
    { name: "Tanjila Karim", cls: "Class 5", sec: "A", roll: 1, gender: "FEMALE", blood: "O_POS", religion: "ISLAM", guardian: "Karim Uddin", gPhone: "+8801811-000012", gRel: "Father", gEmail: "guardian9@demo.com", med: "None", addr: "Rampura, Dhaka" },
    { name: "Shuvo Saha", cls: "Class 5", sec: "A", roll: 2, gender: "MALE", blood: "A_POS", religion: "HINDU", guardian: "Prodip Saha", gPhone: "+8801811-000013", gRel: "Father", addr: "Bashundhara, Dhaka" },
    { name: "Maliha Anjum", cls: "Class 5", sec: "B", roll: 1, gender: "FEMALE", blood: "B_POS", religion: "ISLAM", guardian: "Anjum Ara", gPhone: "+8801811-000014", gRel: "Mother", gEmail: "guardian10@demo.com", addr: "Badda, Dhaka" },
  ];

  const students = {};
  for (const sd of studentData) {
    const cls = classRooms[sd.cls];
    const sec = sections[`${sd.cls}-${sd.sec}`];
    const admissionNo = `SUN-2026-${sd.cls.split(" ")[1]}${sd.sec}-${String(sd.roll).padStart(3, "0")}`;
    const list = await db.collection("students").where("schoolId", "==", schoolId).where("admissionNo", "==", admissionNo).get();
    let student;
    if (list.empty) {
      const qrToken = randomHex(16);
      const id = studentDoc(qrToken);
      student = {
        id,
        schoolId,
        admissionNo,
        name: sd.name,
        gender: sd.gender,
        bloodGroup: sd.blood,
        religion: sd.religion,
        roll: sd.roll,
        registrationNo: `REG-${randomHex(4).toUpperCase()}`,
        classId: cls.id,
        sectionId: sec.id,
        guardianName: sd.guardian,
        guardianPhone: sd.gPhone,
        guardianEmail: sd.gEmail,
        guardianRelation: sd.gRel,
        emergencyContact: sd.gPhone,
        address: sd.addr,
        medicalInfo: sd.med || null,
        admissionDate: day(-300),
        qrToken,
        qrPin: randomPin(),
        active: true,
        createdAt: new Date(),
      };
      await db.collection("students").doc(id).set(clean({
        ...student,
        dob: null,
        photoUrl: null,
        guardianUserId: null,
      }));
    } else {
      student = { id: list.docs[0].id, ...list.docs[0].data() };
    }
    students[sd.name] = student;
  }

  // guardian user accounts (link a few students to login accounts)
  const guardianEmails = [
    "guardian1@demo.com", "guardian2@demo.com", "guardian3@demo.com", "guardian4@demo.com", "guardian5@demo.com",
    "guardian6@demo.com", "guardian7@demo.com", "guardian8@demo.com", "guardian9@demo.com", "guardian10@demo.com",
  ];
  for (const [name, st] of Object.entries(students)) {
    if (!st.guardianEmail || !guardianEmails.includes(st.guardianEmail)) continue;
    const userId = userDoc(st.guardianEmail);
    await setIfMissing("users", userId, {
      email: st.guardianEmail,
      name: st.guardianName,
      role: "GUARDIAN",
      schoolId,
      active: true,
      passwordHash: hash(PASSWORD.guardian),
    });
    if (!st.guardianUserId) {
      await db.collection("students").doc(st.id).update({ guardianUserId: userId });
      st.guardianUserId = userId;
    }
  }
  console.log("✓ Students & guardian accounts created (guardian1@demo.com / Guardian@123)");
  checkpoint("seed", "students + guardian accounts done", `${Object.keys(students).length} students`);

  // ------------------------------------------------------------- fees
  const feeNames = ["Monthly Fee", "Monthly Fee", "Admission Fee", "Exam Fee"];
  const feeTypes = ["MONTHLY", "MONTHLY", "ADMISSION", "EXAM"];
  const feeAmounts = [1500, 1500, 5000, 800];
  for (const [name, st] of Object.entries(students)) {
    const existing = await db.collection("fees").where("schoolId", "==", schoolId).where("studentId", "==", st.id).get();
    if (existing.size > 0) continue;
    for (let i = 0; i < feeNames.length; i++) {
      const isPaid = (st.roll % 2 === 0) || i === 2;
      await db.collection("fees").add({
        schoolId,
        studentId: st.id,
        feeType: feeTypes[i],
        title: feeNames[i],
        amount: feeAmounts[i],
        paidAmount: isPaid ? feeAmounts[i] : 0,
        status: isPaid ? "PAID" : "UNPAID",
        dueDate: day(15),
        note: i === 3 ? "1st term exam fee" : null,
      });
    }
  }

  checkpoint("seed", "fees done", "56 fee records");
  // ------------------------------------------------------------- attendance
  const attendanceDays = [-9, -8, -7, -6, -3, -2, -1, 0];
  for (const off of attendanceDays) {
    const date = day(off);
    for (const [name, st] of Object.entries(students)) {
      const id = attendanceDoc(st.id, date);
      const ref = db.collection("attendance").doc(id);
      if ((await ref.get()).exists) continue;
      const rand = Math.random();
      const status = rand < 0.82 ? "PRESENT" : rand < 0.88 ? "LATE" : rand < 0.95 ? "ABSENT" : "LEAVE";
      await ref.set({
        schoolId,
        studentId: st.id,
        classId: st.classId,
        sectionId: st.sectionId,
        date,
        status,
        remark: null,
        markedById: teachers["English"]?.id ?? null,
      });
    }
  }
  console.log("✓ Attendance seeded (8 days)");
  checkpoint("seed", "attendance done", "8 days");

  // ------------------------------------------------------------- remarks
  const ratingPool = ["EXCELLENT", "GOOD", "GOOD", "AVERAGE", "NEEDS_IMPROVEMENT"];
  for (const off of [-2, -1]) {
    const date = day(off);
    for (const [name, st] of Object.entries(students)) {
      const existing = await db.collection("remarks").where("studentId", "==", st.id).where("date", "==", date).get();
      if (!existing.empty) continue;
      const rating = ratingPool[Math.floor(Math.random() * ratingPool.length)];
      const notes = {
        EXCELLENT: "Very attentive in class and completed all tasks.",
        GOOD: "Good participation. Keep it up!",
        AVERAGE: "Needs to focus more during lessons.",
        NEEDS_IMPROVEMENT: "Please practice at home and submit homework on time.",
      };
      await db.collection("remarks").add({
        schoolId,
        studentId: st.id,
        teacherId: teachers["English"].id,
        date,
        rating,
        note: notes[rating],
      });
    }
  }

  // ------------------------------------------------------------- homework
  const hwCount = await db.collection("homeworks").where("schoolId", "==", schoolId).get();
  if (hwCount.empty) {
    const hwList = [
      { title: "Write 20 English sentences", subj: "English", cls: "Class 1", desc: "Write 20 simple English sentences using 'am', 'is', 'are'.", due: day(2) },
      { title: "Math Practice: Addition", subj: "Mathematics", cls: "Class 1", desc: "Solve page 12-15 from the math workbook.", due: day(3) },
      { title: "Bangla Paragraph", subj: "Bangla", cls: "Class 2", desc: "Write a paragraph about 'My School' in Bangla.", due: day(1) },
      { title: "Science: Plant Parts", subj: "Science", cls: "Class 3", desc: "Draw and label the parts of a flowering plant.", due: day(4) },
      { title: "ICT: Computer Basics", subj: "ICT", cls: "Class 4", desc: "Prepare a short presentation on computer parts.", due: day(5) },
    ];
    for (const hw of hwList) {
      const cls = classRooms[hw.cls];
      const sub = subjects[hw.subj];
      const tch = teachers[hw.subj];
      if (!cls || !sub || !tch) continue;
      await db.collection("homeworks").add({
        schoolId,
        classId: cls.id,
        sectionId: sections[`${hw.cls}-A`].id,
        subjectId: sub.id,
        teacherId: tch.id,
        title: hw.title,
        description: hw.desc,
        attachmentUrl: null,
        dueDate: hw.due,
        createdAt: new Date(),
      });
    }
  }

  checkpoint("seed", "remarks + homework done");
  // ------------------------------------------------------------- exam + marks
  const examName = "First Term Examination 2026";
  const c1 = classRooms["Class 1"];
  const examList = await db.collection("exams").where("schoolId", "==", schoolId).where("classId", "==", c1.id).where("name", "==", examName).get();
  let exam;
  if (examList.empty) {
    const ref = db.collection("exams").doc();
    exam = {
      id: ref.id,
      schoolId,
      name: examName,
      classId: c1.id,
      sectionId: sections["Class 1-A"].id,
      year: 2026,
      startDate: day(-20),
      endDate: day(-10),
      published: false,
      publishedAt: null,
    };
    await ref.set(exam);
  } else {
    exam = { id: examList.docs[0].id, ...examList.docs[0].data() };
  }
  const c1Students = Object.values(students).filter((s) => s.classId === c1.id);
  for (const st of c1Students) {
    for (const [subjName, subj] of Object.entries(subjects)) {
      const full = 100;
      const obtained = Math.max(35, Math.min(99, Math.round(60 + Math.random() * 35)));
      const gi = gradeInfo(obtained, full);
      const id = markDoc(exam.id, st.id, subj.id);
      const ref = db.collection("marks").doc(id);
      if ((await ref.get()).exists) continue;
      await ref.set({
        examId: exam.id,
        studentId: st.id,
        subjectId: subj.id,
        fullMarks: full,
        obtained,
        grade: gi.grade,
        gradePoint: gi.gpa,
      });
    }
  }
  if (!exam.published) {
    await db.collection("exams").doc(exam.id).update({ published: true, publishedAt: day(-5) });
  }
  console.log("✓ Exam + marks seeded (First Term Examination 2026)");
  checkpoint("seed", "exam + marks done");

  // ------------------------------------------------------------- notices
  const noticeCount = await db.collection("notices").where("schoolId", "==", schoolId).get();
  if (noticeCount.empty) {
    const notices = [
      { title: "School Closed — Victory Day", body: "The school will remain closed on 16 December on the occasion of Victory Day.", cat: "HOLIDAY", when: day(-30) },
      { title: "First Term Exam Routine Published", body: "The First Term Examination 2026 routine has been published. Download from the Exam section.", cat: "EXAM", when: day(-15) },
      { title: "Annual Sports Day", body: "Annual Sports Day will be held on 20 December at the school playground. Parents are cordially invited.", cat: "EVENT", when: day(10) },
      { title: "Parent-Teacher Meeting", body: "A parent-teacher meeting will be held on 5 January in the school auditorium at 10 AM.", cat: "MEETING", when: day(6) },
      { title: "Class Picnic — Class 3", body: "Class 3 picnic at Suhrawardy Udyan on 28 December. Consent form required.", cat: "PICNIC", when: day(14) },
    ];
    for (const n of notices) {
      await db.collection("notices").add({
        schoolId,
        title: n.title,
        body: n.body,
        category: n.cat,
        date: n.when,
        createdById: superAdminId,
      });
    }
  }

  // ------------------------------------------------------------- routine
  const routineCount = await db.collection("routines").where("schoolId", "==", schoolId).get();
  if (routineCount.empty) {
    const periodDefs = [
      { start: "08:30", end: "09:15" },
      { start: "09:15", end: "10:00" },
      { start: "10:15", end: "11:00" },
      { start: "11:00", end: "11:45" },
      { start: "11:45", end: "12:30" },
      { start: "13:30", end: "14:15" },
      { start: "14:15", end: "15:00" },
    ];
    const subjOrder = ["Bangla", "English", "Mathematics", "Science", "Social Studies", "ICT", "Religion"];
    for (let dayNum = 0; dayNum < 5; dayNum++) {
      for (let p = 0; p < periodDefs.length; p++) {
        const sn = subjOrder[(p + dayNum) % subjOrder.length];
        const sub = subjects[sn];
        const tch = teachers[sn];
        if (!sub || !tch) continue;
        await db.collection("routines").add({
          schoolId,
          classId: c1.id,
          sectionId: sections["Class 1-A"].id,
          day: dayNum,
          period: p + 1,
          startTime: periodDefs[p].start,
          endTime: periodDefs[p].end,
          subjectId: sub.id,
          teacherId: tch.id,
        });
      }
    }
  }

  checkpoint("seed", "notices + routine done");
  // ------------------------------------------------------------- messages
  const msgCount = await db.collection("messages").where("schoolId", "==", schoolId).get();
  if (msgCount.empty) {
    const firstGuardian = await db
      .collection("users")
      .where("role", "==", "GUARDIAN")
      .where("schoolId", "==", schoolId)
      .limit(1)
      .get();
    if (!firstGuardian.empty) {
      await db.collection("messages").add({
        schoolId,
        senderId: userDoc("teacher@sunrise.edu"),
        receiverId: firstGuardian.docs[0].id,
        studentId: null,
        body: "Dear guardian, your child is doing well in class. Please ensure they practice English daily at home.",
        createdAt: new Date(),
        readAt: null,
      });
    }
  }

  checkpoint("seed", "messages done");
  checkpoint("seed", "SEED COMPLETE — all phases logged");
  const studentsCount = (await db.collection("students").where("schoolId", "==", schoolId).get()).size;
  const teachersCount = (await db.collection("teachers").where("schoolId", "==", schoolId).get()).size;
  const feesCount = (await db.collection("fees").where("schoolId", "==", schoolId).get()).size;
  console.log("✓ Notices, routine, messages seeded");
  console.log("--------------------------------------------------------------");
  console.log("Demo data ready:");
  console.log(`  • ${studentsCount} students, ${teachersCount} teachers, ${feesCount} fee records`);
  console.log("  • Super Admin:  admin@smartschool.com  / Admin@123");
  console.log("  • School Admin: principal@sunrise.edu   / School@123");
  console.log("  • Teacher:      teacher@sunrise.edu     / Teacher@123");
  console.log("  • Guardian:     guardian1@demo.com      / Guardian@123");
  console.log("  • QR login: open /qr/<token> on any student page (PIN shown in student details)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
