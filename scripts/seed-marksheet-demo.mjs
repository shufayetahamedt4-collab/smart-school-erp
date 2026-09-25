/**
 * seed-marksheet-demo.mjs — a full year of exam marks, so the student
 * marksheet (/print/marksheet/<studentId>) shows a whole session instead of one
 * term.
 *
 * The demo school ships with a single exam ("First Term Examination 2026"), so a
 * year marksheet would print one lonely column. This adds the two terms around
 * it — a Monthly Test before, a Half Yearly after — with subject-wise marks for
 * every student in that class, and leaves the seeded First Term untouched.
 *
 * Marks are a fixed table, not random, so repeated runs are byte-identical and
 * the printed sheet can be described exactly. Students it has no table for get
 * deterministic marks derived from their name, so the script still fills a class
 * it has never seen.
 *
 * Idempotent: an exam that already exists is reused, and a mark that already
 * exists is left alone (pass --force to overwrite marks). Reversible: --remove
 * deletes the two exams this script owns, plus their marks.
 *
 * Usage:
 *   node scripts/seed-marksheet-demo.mjs            # add / top up
 *   node scripts/seed-marksheet-demo.mjs --remove   # take them back out
 *   node scripts/seed-marksheet-demo.mjs --force    # overwrite existing marks
 */
import { initializeApp, getApps, cert } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { loadEnv } from "./load-env.mjs";

loadEnv();

const PROJECT_ID = process.env.FIREBASE_PROJECT_ID;
const CLIENT_EMAIL = process.env.FIREBASE_CLIENT_EMAIL;
const PRIVATE_KEY = process.env.FIREBASE_PRIVATE_KEY;

if (!PROJECT_ID || !CLIENT_EMAIL || !PRIVATE_KEY) {
  console.error("❌ Missing Firebase Admin credentials in .env (FIREBASE_PROJECT_ID / CLIENT_EMAIL / PRIVATE_KEY).");
  process.exit(1);
}

if (!getApps().length) {
  initializeApp({
    projectId: PROJECT_ID,
    credential: cert({ projectId: PROJECT_ID, clientEmail: CLIENT_EMAIL, privateKey: unescapeKey(PRIVATE_KEY) }),
  });
}
const db = getFirestore();

/** Turn literal backslash-n (2 chars) into real newlines; leave real newlines alone. */
function unescapeKey(k) {
  const BS = String.fromCharCode(92); // backslash
  if (!k.includes(BS + "n")) return k;
  return k.split(BS + "n").join("\n");
}

const REMOVE = process.argv.includes("--remove");
const FORCE = process.argv.includes("--force");

/** The two terms this script owns, in the order they are sat. */
const EXAMS = [
  {
    name: "Monthly Test 2026",
    start: [2026, 4, 10], // May
    end: [2026, 4, 14],
    publishedAt: [2026, 4, 18],
    marks: {
      "Ayan Rahman": { Bangla: 68, English: 61, ICT: 74, Mathematics: 55, Religion: 72, Science: 66, "Social Studies": 63 },
      "Mim Akter": { Bangla: 88, English: 82, ICT: 91, Mathematics: 79, Religion: 90, Science: 85, "Social Studies": 87 },
    },
  },
  {
    name: "Half Yearly Examination 2026",
    start: [2026, 8, 8], // September
    end: [2026, 8, 18],
    publishedAt: [2026, 8, 22],
    marks: {
      // Mathematics 35 is a deliberate low pass (D on the 5.00 scale) so the
      // marksheet shows a weak subject without failing the year.
      "Ayan Rahman": { Bangla: 72, English: 65, ICT: 78, Mathematics: 35, Religion: 76, Science: 70, "Social Studies": 68 },
      "Mim Akter": { Bangla: 91, English: 86, ICT: 94, Mathematics: 84, Religion: 93, Science: 89, "Social Studies": 90 },
    },
  },
];

/** The scale the demo school ships with — only a fallback, see schoolScheme(). */
const DEFAULT_BANDS = [
  { grade: "A+", min: 80, gpa: 5 },
  { grade: "A", min: 70, gpa: 4 },
  { grade: "A-", min: 60, gpa: 3.5 },
  { grade: "B", min: 50, gpa: 3 },
  { grade: "C", min: 40, gpa: 2 },
  { grade: "D", min: 33, gpa: 1 },
  { grade: "F", min: 0, gpa: 0 },
];

const at = ([y, m, d]) => Timestamp.fromDate(new Date(y, m, d, 10, 0, 0));
const markId = (examId, studentId, subjectId) => `m_${examId}_${studentId}_${subjectId}`;

/** The school's own grading scale, from the settings doc the app reads. */
async function schoolScheme(schoolId) {
  const snap = await db.collection("settings").doc(`set_grading_scheme_${schoolId}`).get();
  const raw = snap.exists ? snap.data()?.value : null;
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      value = null;
    }
  }
  const bands = Array.isArray(value?.bands) ? value.bands : null;
  if (!bands?.length) return DEFAULT_BANDS;
  return bands
    .map((b) => ({ grade: String(b.grade), min: Number(b.minPercent), gpa: Number(b.gpa) }))
    .sort((a, b) => b.min - a.min);
}

const gradeFor = (bands, obtained, full) => {
  const percent = full > 0 ? (obtained / full) * 100 : 0;
  return bands.find((b) => percent >= b.min) || bands[bands.length - 1];
};

/** Marks for a student we have no table for: stable, plausible, name-derived. */
function derivedMarks(name, examName) {
  let seed = 0;
  for (const ch of `${name}|${examName}`) seed = (seed * 31 + ch.charCodeAt(0)) % 100000;
  const out = {};
  for (const subject of SUBJECT_NAMES) {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    out[subject] = 55 + Math.round((seed % 1000) / 1000 * 40); // 55–95
  }
  return out;
}

let SUBJECT_NAMES = [];

async function main() {
  // ---------------------------------------------------------------- the school
  const schools = await db.collection("schools").where("slug", "==", "sunrise").limit(1).get();
  const schoolDoc = schools.empty ? (await db.collection("schools").limit(1).get()).docs[0] : schools.docs[0];
  if (!schoolDoc) {
    console.error("❌ No school found — run `npm run seed` first.");
    process.exit(1);
  }
  const schoolId = schoolDoc.id;
  const schoolName = schoolDoc.data()?.name || schoolId;
  console.log(`School: ${schoolName} (${schoolId})`);

  // ------------------------------------------------------- the class + roster
  const classes = await db.collection("classes").where("schoolId", "==", schoolId).get();
  const classRoom =
    classes.docs.find((d) => d.data()?.name === "Class 1") || classes.docs.sort((a, b) => (a.data()?.name || "").localeCompare(b.data()?.name || ""))[0];
  if (!classRoom) {
    console.error("❌ No classes found for this school — run `npm run seed` first.");
    process.exit(1);
  }
  const classId = classRoom.id;

  // The existing exam names the section the seeded term was sat in; reuse it so
  // every term belongs to the same section as First Term.
  const seededExam = (await db.collection("exams").where("schoolId", "==", schoolId).where("classId", "==", classId).get()).docs[0];
  const sectionId = seededExam?.data()?.sectionId || null;

  // An exam covers ONE section (the app lists a sheet's students by class AND
  // section), so only that section's students may be marked on it — marking a
  // neighbouring section would inflate every classmate's position.
  const subjects = (await db.collection("subjects").where("schoolId", "==", schoolId).get()).docs.map((d) => ({
    id: d.id,
    name: d.data()?.name || d.id,
  }));
  SUBJECT_NAMES = subjects.map((s) => s.name);

  const roster = (await db.collection("students").where("schoolId", "==", schoolId).where("classId", "==", classId).get()).docs;
  const students = roster
    .filter((d) => !sectionId || d.data()?.sectionId === sectionId)
    .map((d) => ({ id: d.id, name: d.data()?.name || `Student ${d.id.slice(0, 4)}` }));

  console.log(
    `Class: ${classRoom.data()?.name}${sectionId ? ` · section ${sectionId}` : ""} · ` +
      `${students.length} of ${roster.length} student(s) in this exam's section · ${subjects.length} subject(s)`
  );
  if (!students.length || !subjects.length) {
    console.error("❌ No students or subjects to mark — run `npm run seed` first.");
    process.exit(1);
  }

  // ------------------------------------------------------------- --remove path
  if (REMOVE) {
    let examsGone = 0;
    let marksGone = 0;
    for (const def of EXAMS) {
      const found = await db.collection("exams").where("schoolId", "==", schoolId).where("classId", "==", classId).where("name", "==", def.name).get();
      for (const doc of found.docs) {
        const marks = await db.collection("marks").where("examId", "==", doc.id).get();
        for (const m of marks.docs) {
          await m.ref.delete();
          marksGone++;
        }
        await doc.ref.delete();
        examsGone++;
      }
    }
    console.log(`\n✓ Removed ${examsGone} demo exam(s) and ${marksGone} mark(s).`);
    console.log("  The seeded First Term Examination is untouched.");
    return;
  }

  // ------------------------------------------------------------------ the work
  const bands = await schoolScheme(schoolId);
  console.log(`Grading scale in use: ${bands.map((b) => `${b.grade}≥${b.min}`).join(" ")}`);

  let examsAdded = 0;
  let marksAdded = 0;
  let marksKept = 0;

  for (const def of EXAMS) {
    const found = await db.collection("exams").where("schoolId", "==", schoolId).where("classId", "==", classId).where("name", "==", def.name).get();
    let examId;
    if (found.empty) {
      const ref = db.collection("exams").doc();
      examId = ref.id;
      await ref.set({
        id: examId,
        schoolId,
        name: def.name,
        classId,
        sectionId,
        year: 2026,
        startDate: at(def.start),
        endDate: at(def.end),
        published: true,
        publishedAt: at(def.publishedAt),
      });
      examsAdded++;
      console.log(`  + exam ${def.name}`);
    } else {
      examId = found.docs[0].id;
      console.log(`  = exam ${def.name} (already there)`);
    }

    for (const student of students) {
      const table = def.marks[student.name] || derivedMarks(student.name, def.name);
      for (const subject of subjects) {
        const obtained = Number(table[subject.name]);
        if (!Number.isFinite(obtained)) continue;
        const full = 100;
        const ref = db.collection("marks").doc(markId(examId, student.id, subject.id));
        const existing = await ref.get();
        if (existing.exists && !FORCE) {
          marksKept++;
          continue;
        }
        const band = gradeFor(bands, obtained, full);
        // Only for display: the app recomputes the letter and grade point from
        // the live scale on every read, so an edited band re-grades these too.
        await ref.set({
          examId,
          studentId: student.id,
          subjectId: subject.id,
          fullMarks: full,
          obtained,
          grade: band.grade,
          gradePoint: band.gpa,
        });
        marksAdded++;
      }
    }
  }

  console.log(`\n✓ Added ${examsAdded} exam(s) and ${marksAdded} mark(s)${marksKept ? `, left ${marksKept} existing mark(s) alone` : ""}.`);
  console.log("  Open a student's marksheet: /print/marksheet/<studentId>");
  console.log("  Undo with: node scripts/seed-marksheet-demo.mjs --remove");
}

await main();
