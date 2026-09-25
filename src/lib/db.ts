import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./firebase";
import { Timestamp, type WriteBatch } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// Public types (replaces @prisma/client imports)
// ---------------------------------------------------------------------------

export type Role =
  | "SUPER_ADMIN"
  | "SCHOOL_ADMIN"
  | "BRANCH_ADMIN"
  | "REGISTRAR"
  | "TEACHER"
  | "GUARDIAN"
  | "STUDENT"
  | "ACCOUNTANT"
  | "LIBRARIAN"
  | "FRONT_DESK";

// ---- PRD v1.2 shared enums (future-proof schema) --------------------------

export type StudentStatus = "ACTIVE" | "ALUMNI" | "TRANSFERRED";

/**
 * "Still on the roll", as a where-fragment for student queries.
 *
 * A student whose `status` was never written — every row the seed creates, and
 * anything created before the field existed — IS enrolled. Filtering on the bare
 * string "ACTIVE" therefore hides them: it kept seeded children out of the
 * guardian portal's sibling list and would have skipped them in promotion. Ask
 * for what is NOT finished instead, and a missing status counts as active.
 */
export const ON_ROLL_STUDENT = { status: { notIn: ["ALUMNI", "TRANSFERRED"] } } as const;
export type AdmissionStatus =
  | "ENQUIRY"
  | "APPLIED"
  | "DOCS_PENDING"
  | "TEST_SCHEDULED"
  | "SEAT_CONFIRMED"
  | "ENROLLED"
  | "REJECTED";
export type DiscountType = "PERCENT" | "FIXED";
export type DiscountStatus = "PROPOSED" | "APPROVED" | "REJECTED";
export type DiscountReason =
  | "SIBLING"
  | "MERIT"
  | "STAFF_CHILD"
  | "FINANCIAL_HARDSHIP"
  | "OTHER";
export type PaymentMethod = "CASH" | "BANK" | "BKASH" | "NAGAD" | "ROCKET" | "CARD";
export type LedgerStatus = "PENDING" | "CONFIRMED" | "FAILED";
export type LedgerKind = "FEE" | "PAYMENT" | "DISCOUNT" | "LATE_FEE" | "EXPENSE";
export type FeeLineType = "TUITION" | "ADMISSION" | "EXAM" | "TRANSPORT" | "HOSTEL" | "LIBRARY_FINE" | "LATE_FEE" | "OTHER";
export type LeaveStatus = "PENDING" | "APPROVED" | "REJECTED";
export type ResourceKind = "PDF" | "EBOOK" | "COMIC" | "VIDEO" | "SLIDES" | "WORKSHEET" | "LINK";
export type ChatChannel = "PUSH" | "SMS" | "WHATSAPP";
export type ComplaintStatus = "OPEN" | "IN_REVIEW" | "RESOLVED" | "DISMISSED";
export type SchoolStatus = "ACTIVE" | "SUSPENDED" | "TRIAL";
export type AttendanceStatus = "PRESENT" | "ABSENT" | "LATE" | "LEAVE";
export type RemarkRating = "EXCELLENT" | "GOOD" | "AVERAGE" | "NEEDS_IMPROVEMENT";
export type HomeworkStatus = "PENDING" | "SUBMITTED" | "OVERDUE";
export type NoticeCategory = "GENERAL" | "HOLIDAY" | "EXAM" | "MEETING" | "EVENT" | "PICNIC";
export type FeeStatus = "PAID" | "UNPAID" | "PARTIAL";
export type FeeType = "MONTHLY" | "ADMISSION" | "EXAM" | "OTHER";
export type Gender = "MALE" | "FEMALE" | "OTHER";
export type BloodGroup = "A_POS" | "A_NEG" | "B_POS" | "B_NEG" | "AB_POS" | "AB_NEG" | "O_POS" | "O_NEG";
export type Religion = "ISLAM" | "HINDU" | "CHRISTIAN" | "BUDDHIST" | "OTHERS";

// ---------------------------------------------------------------------------
// Collection names + deterministic document IDs
// ---------------------------------------------------------------------------

const COLS: Record<string, string> = {
  school: "schools",
  user: "users",
  teacher: "teachers",
  student: "students",
  classRoom: "classes",
  section: "sections",
  subject: "subjects",
  classAssignment: "assignments",
  routine: "routines",
  attendance: "attendance",
  dailyRemark: "remarks",
  homework: "homeworks",
  homeworkSubmission: "submissions",
  exam: "exams",
  examMark: "marks",
  notice: "notices",
  feeSetting: "feeSettings",
  fee: "fees",
  payment: "payments",
  message: "messages",
  auditLog: "auditLogs",
  setting: "settings",
  // ---- PRD v1.2 new collections (Phase 0 schema, used by later phases) ----
  admission: "admissions",
  admissionDocument: "admissionDocuments",
  discount: "discounts",
  academicSession: "academicSessions",
  branch: "branches",
  leaveRequest: "leaveRequests",
  meetingSlot: "meetingSlots",
  meetingBooking: "meetingBookings",
  complaint: "complaints",
  galleryItem: "gallery",
  healthRecord: "healthRecords",
  feeTemplate: "feeTemplates",
  feeTemplateItem: "feeTemplateItems",
  installment: "installments",
  ledgerEntry: "ledger",
  paymentIntent: "paymentIntents",
  expenseEntry: "expenseEntries",
  vendor: "vendors",
  payrollRecord: "payroll",
  notification: "notifications",
  device: "devices",
  conversation: "conversations",
  conversationMessage: "conversationMessages",
  smsLog: "smsLogs",
  bookCatalog: "bookCatalog",
  bookIssue: "bookIssues",
  bookStock: "bookStock",
  plan: "plans",
  subscription: "subscriptions",
  invoice: "invoices",
  resource: "resources",
  quiz: "quizzes",
  question: "questions",
  quizAttempt: "quizAttempts",
  virtualClass: "virtualClasses",
  timetableSlot: "timetableSlots",
  substitution: "substitutions",
  calendarEvent: "calendarEvents",
  twoFactor: "twoFactor",
};

const sha1 = (s: string) => createHash("sha1").update(s).digest("hex");
const rand = () => `r_${randomBytes(8).toString("hex")}`;

/** Local YYYY-MM-DD key for a Date (keeps upsert + query keys identical). */
function dateKey(d: Date | string): string {
  const dt = new Date(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** Deterministic doc id for models with a unique key (upsert-friendly). */
function idFor(model: string, where: Record<string, any>): string | undefined {
  if (typeof where.id === "string") return where.id;
  if (model === "user" && where.email) return `u_${sha1(String(where.email).toLowerCase())}`;
  if (model === "school" && where.slug) return `s_${sha1(String(where.slug))}`;
  if (model === "teacher" && where.userId) return `t_${String(where.userId)}`;
  if (model === "student" && where.qrToken) return `st_${String(where.qrToken)}`;
  if (model === "attendance") {
    const c = where.studentId_date ?? where;
    if (c.studentId && c.date) return `a_${c.studentId}_${dateKey(c.date)}`;
  }
  if (model === "examMark") {
    const c = where.examId_studentId_subjectId ?? where;
    if (c.examId && c.studentId && c.subjectId) return `m_${c.examId}_${c.studentId}_${c.subjectId}`;
  }
  if (model === "homeworkSubmission") {
    const c = where.homeworkId_studentId ?? where;
    if (c.homeworkId && c.studentId) return `sub_${c.homeworkId}_${c.studentId}`;
  }
  if (model === "feeSetting" && where.schoolId) return `fs_${String(where.schoolId)}`;
  if (model === "setting" && where.key) return `set_${String(where.key)}`;
  if (model === "twoFactor" && where.userId) return `2fa_${String(where.userId)}`;
  if (model === "device" && where.token) return `dev_${sha1(String(where.token))}`;
  if (model === "conversation" && where.partyKey) return `cv_${String(where.partyKey)}`;
  if (model === "installment" && where.feeId_seq) {
    const c = where.feeId_seq;
    if (c.feeId && c.seq !== undefined) return `in_${c.feeId}_${c.seq}`;
  }
  if (model === "quizAttempt" && where.quizId_studentId) {
    const c = where.quizId_studentId;
    if (c.quizId && c.studentId) return `qa_${c.quizId}_${c.studentId}`;
  }
  if (model === "meetingBooking" && where.slotId_guardianUserId) {
    const c = where.slotId_guardianUserId;
    if (c.slotId && c.guardianUserId) return `mb_${c.slotId}_${c.guardianUserId}`;
  }
  return undefined;
}

/** Deterministic id used when CREATING a record (must match idFor). */
function idForCreate(model: string, data: Record<string, any>): string | undefined {
  if (model === "user" && data.email) return `u_${sha1(String(data.email).toLowerCase())}`;
  if (model === "school" && data.slug) return `s_${sha1(String(data.slug))}`;
  if (model === "teacher" && data.userId) return `t_${String(data.userId)}`;
  if (model === "student" && data.qrToken) return `st_${String(data.qrToken)}`;
  if (model === "attendance" && data.studentId && data.date) return `a_${data.studentId}_${dateKey(data.date)}`;
  if (model === "examMark" && data.examId && data.studentId && data.subjectId) return `m_${data.examId}_${data.studentId}_${data.subjectId}`;
  if (model === "homeworkSubmission" && data.homeworkId && data.studentId) return `sub_${data.homeworkId}_${data.studentId}`;
  if (model === "feeSetting" && data.schoolId) return `fs_${String(data.schoolId)}`;
  if (model === "setting" && data.key) return `set_${String(data.key)}`;
  if (model === "twoFactor" && data.userId) return `2fa_${String(data.userId)}`;
  if (model === "device" && data.token) return `dev_${sha1(String(data.token))}`;
  if (model === "conversation" && data.partyKey) return `cv_${String(data.partyKey)}`;
  if (model === "installment" && data.feeId && data.seq !== undefined) return `in_${data.feeId}_${data.seq}`;
  if (model === "quizAttempt" && data.quizId && data.studentId) return `qa_${data.quizId}_${data.studentId}`;
  if (model === "meetingBooking" && data.slotId && data.guardianUserId) return `mb_${data.slotId}_${data.guardianUserId}`;
  return undefined;
}

// ---------------------------------------------------------------------------
// Relation registry (mirrors prisma/schema.prisma)
// kind: 'one' (parent holds FK) | 'many' (children hold FK) | 'oneInverse' (single child holds FK)
// ---------------------------------------------------------------------------

interface Rel {
  to: string;
  fk?: string; // parent's field holding the related id (kind 'one')
  via?: string; // child's field holding the parent id (kind 'many' / 'oneInverse')
  kind: "one" | "many" | "oneInverse";
}

const RELS: Record<string, Record<string, Rel>> = {
  school: {
    feeSetting: { to: "feeSetting", via: "schoolId", kind: "oneInverse" },
    users: { to: "user", via: "schoolId", kind: "many" },
    students: { to: "student", via: "schoolId", kind: "many" },
    teachers: { to: "teacher", via: "schoolId", kind: "many" },
    classes: { to: "classRoom", via: "schoolId", kind: "many" },
    sections: { to: "section", via: "schoolId", kind: "many" },
    subjects: { to: "subject", via: "schoolId", kind: "many" },
    routines: { to: "routine", via: "schoolId", kind: "many" },
    assignments: { to: "classAssignment", via: "schoolId", kind: "many" },
    homeworks: { to: "homework", via: "schoolId", kind: "many" },
    exams: { to: "exam", via: "schoolId", kind: "many" },
    notices: { to: "notice", via: "schoolId", kind: "many" },
    attendance: { to: "attendance", via: "schoolId", kind: "many" },
    remarks: { to: "dailyRemark", via: "schoolId", kind: "many" },
    messages: { to: "message", via: "schoolId", kind: "many" },
    fees: { to: "fee", via: "schoolId", kind: "many" },
    payments: { to: "payment", via: "schoolId", kind: "many" },
    auditLogs: { to: "auditLog", via: "schoolId", kind: "many" },
    // ---- PRD v1.2 additions ----
    admissions: { to: "admission", via: "schoolId", kind: "many" },
    branches: { to: "branch", via: "schoolId", kind: "many" },
    sessions: { to: "academicSession", via: "schoolId", kind: "many" },
    feeTemplates: { to: "feeTemplate", via: "schoolId", kind: "many" },
    ledger: { to: "ledgerEntry", via: "schoolId", kind: "many" },
    notifications: { to: "notification", via: "schoolId", kind: "many" },
    conversations: { to: "conversation", via: "schoolId", kind: "many" },
    resources: { to: "resource", via: "schoolId", kind: "many" },
    bookCatalogs: { to: "bookCatalog", via: "schoolId", kind: "many" },
    bookStocks: { to: "bookStock", via: "schoolId", kind: "many" },
    bookIssues: { to: "bookIssue", via: "schoolId", kind: "many" },
    complaints: { to: "complaint", via: "schoolId", kind: "many" },
    meetingSlots: { to: "meetingSlot", via: "schoolId", kind: "many" },
    leaveRequests: { to: "leaveRequest", via: "schoolId", kind: "many" },
    galleryItems: { to: "galleryItem", via: "schoolId", kind: "many" },
    smsLogs: { to: "smsLog", via: "schoolId", kind: "many" },
    devices: { to: "device", via: "schoolId", kind: "many" },
    quizzes: { to: "quiz", via: "schoolId", kind: "many" },
    virtualClasses: { to: "virtualClass", via: "schoolId", kind: "many" },
    timetableSlots: { to: "timetableSlot", via: "schoolId", kind: "many" },
    calendarEvents: { to: "calendarEvent", via: "schoolId", kind: "many" },
    expenseEntries: { to: "expenseEntry", via: "schoolId", kind: "many" },
    vendors: { to: "vendor", via: "schoolId", kind: "many" },
    subscription: { to: "subscription", via: "schoolId", kind: "oneInverse" },
    invoices: { to: "invoice", via: "schoolId", kind: "many" },
  },
  user: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    branch: { to: "branch", fk: "branchId", kind: "one" },
    teacherProfile: { to: "teacher", via: "userId", kind: "oneInverse" },
    studentOf: { to: "student", via: "guardianUserId", kind: "oneInverse" },
    messagesSent: { to: "message", via: "senderId", kind: "many" },
    messagesReceived: { to: "message", via: "receiverId", kind: "many" },
    auditLogs: { to: "auditLog", via: "userId", kind: "many" },
  },
  teacher: {
    user: { to: "user", fk: "userId", kind: "one" },
    school: { to: "school", fk: "schoolId", kind: "one" },
    assignments: { to: "classAssignment", via: "teacherId", kind: "many" },
    routines: { to: "routine", via: "teacherId", kind: "many" },
    attendance: { to: "attendance", via: "markedById", kind: "many" },
    remarks: { to: "dailyRemark", via: "teacherId", kind: "many" },
    homeworks: { to: "homework", via: "teacherId", kind: "many" },
  },
  student: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    section: { to: "section", fk: "sectionId", kind: "one" },
    guardianUser: { to: "user", fk: "guardianUserId", kind: "one" },
    attendance: { to: "attendance", via: "studentId", kind: "many" },
    remarks: { to: "dailyRemark", via: "studentId", kind: "many" },
    submissions: { to: "homeworkSubmission", via: "studentId", kind: "many" },
    marks: { to: "examMark", via: "studentId", kind: "many" },
    fees: { to: "fee", via: "studentId", kind: "many" },
    payments: { to: "payment", via: "studentId", kind: "many" },
    messages: { to: "message", via: "studentId", kind: "many" },
    // ---- PRD v1.2 additions ----
    admissions: { to: "admission", via: "convertedStudentId", kind: "many" },
    leaveRequests: { to: "leaveRequest", via: "studentId", kind: "many" },
    bookIssues: { to: "bookIssue", via: "studentId", kind: "many" },
    quizAttempts: { to: "quizAttempt", via: "studentId", kind: "many" },
    healthRecord: { to: "healthRecord", via: "studentId", kind: "oneInverse" },
    ledgerEntries: { to: "ledgerEntry", via: "studentId", kind: "many" },
    installments: { to: "installment", via: "studentId", kind: "many" },
    notifications: { to: "notification", via: "studentId", kind: "many" },
  },
  classRoom: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    sections: { to: "section", via: "classId", kind: "many" },
    students: { to: "student", via: "classId", kind: "many" },
    assignments: { to: "classAssignment", via: "classId", kind: "many" },
    routines: { to: "routine", via: "classId", kind: "many" },
    homeworks: { to: "homework", via: "classId", kind: "many" },
    exams: { to: "exam", via: "classId", kind: "many" },
  },
  section: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    students: { to: "student", via: "sectionId", kind: "many" },
    assignments: { to: "classAssignment", via: "sectionId", kind: "many" },
    routines: { to: "routine", via: "sectionId", kind: "many" },
    homeworks: { to: "homework", via: "sectionId", kind: "many" },
    exams: { to: "exam", via: "sectionId", kind: "many" },
  },
  subject: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    assignments: { to: "classAssignment", via: "subjectId", kind: "many" },
    routines: { to: "routine", via: "subjectId", kind: "many" },
    homeworks: { to: "homework", via: "subjectId", kind: "many" },
    marks: { to: "examMark", via: "subjectId", kind: "many" },
  },
  classAssignment: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    teacher: { to: "teacher", fk: "teacherId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    section: { to: "section", fk: "sectionId", kind: "one" },
    subject: { to: "subject", fk: "subjectId", kind: "one" },
  },
  routine: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    section: { to: "section", fk: "sectionId", kind: "one" },
    subject: { to: "subject", fk: "subjectId", kind: "one" },
    teacher: { to: "teacher", fk: "teacherId", kind: "one" },
  },
  attendance: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
    teacher: { to: "teacher", fk: "markedById", kind: "one" },
  },
  dailyRemark: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
    teacher: { to: "teacher", fk: "teacherId", kind: "one" },
  },
  homework: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    section: { to: "section", fk: "sectionId", kind: "one" },
    subject: { to: "subject", fk: "subjectId", kind: "one" },
    teacher: { to: "teacher", fk: "teacherId", kind: "one" },
    submissions: { to: "homeworkSubmission", via: "homeworkId", kind: "many" },
  },
  homeworkSubmission: {
    homework: { to: "homework", fk: "homeworkId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
  },
  exam: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    section: { to: "section", fk: "sectionId", kind: "one" },
    marks: { to: "examMark", via: "examId", kind: "many" },
  },
  examMark: {
    exam: { to: "exam", fk: "examId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
    subject: { to: "subject", fk: "subjectId", kind: "one" },
  },
  notice: { school: { to: "school", fk: "schoolId", kind: "one" } },
  feeSetting: { school: { to: "school", fk: "schoolId", kind: "one" } },
  fee: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
    payments: { to: "payment", via: "feeId", kind: "many" },
  },
  payment: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
    fee: { to: "fee", fk: "feeId", kind: "one" },
  },
  message: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    sender: { to: "user", fk: "senderId", kind: "one" },
    receiver: { to: "user", fk: "receiverId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
  },
  auditLog: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    user: { to: "user", fk: "userId", kind: "one" },
  },
  // ---- PRD v1.2 new model relations ----
  admission: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    section: { to: "section", fk: "sectionId", kind: "one" },
    academicSession: { to: "academicSession", fk: "sessionId", kind: "one" },
    branch: { to: "branch", fk: "branchId", kind: "one" },
    documents: { to: "admissionDocument", via: "admissionId", kind: "many" },
    discounts: { to: "discount", via: "admissionId", kind: "many" },
    convertedStudent: { to: "student", fk: "convertedStudentId", kind: "one" },
  },
  admissionDocument: {
    admission: { to: "admission", fk: "admissionId", kind: "one" },
  },
  discount: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    admission: { to: "admission", fk: "admissionId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
    proposedBy: { to: "user", fk: "proposedById", kind: "one" },
    approvedBy: { to: "user", fk: "approvedById", kind: "one" },
  },
  academicSession: { school: { to: "school", fk: "schoolId", kind: "one" } },
  branch: { school: { to: "school", fk: "schoolId", kind: "one" } },
  leaveRequest: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
    teacher: { to: "teacher", fk: "teacherId", kind: "one" },
    approver: { to: "user", fk: "approvedById", kind: "one" },
  },
  meetingSlot: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    teacher: { to: "teacher", fk: "teacherId", kind: "one" },
    bookings: { to: "meetingBooking", via: "slotId", kind: "many" },
  },
  meetingBooking: {
    slot: { to: "meetingSlot", fk: "slotId", kind: "one" },
    guardian: { to: "user", fk: "guardianUserId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
  },
  complaint: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    guardian: { to: "user", fk: "guardianUserId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
  },
  galleryItem: { school: { to: "school", fk: "schoolId", kind: "one" } },
  healthRecord: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
  },
  feeTemplate: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    items: { to: "feeTemplateItem", via: "templateId", kind: "many" },
  },
  feeTemplateItem: { template: { to: "feeTemplate", fk: "templateId", kind: "one" } },
  installment: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    fee: { to: "fee", fk: "feeId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
  },
  ledgerEntry: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
    fee: { to: "fee", fk: "feeId", kind: "one" },
    actor: { to: "user", fk: "actorId", kind: "one" },
  },
  paymentIntent: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
    fee: { to: "fee", fk: "feeId", kind: "one" },
  },
  expenseEntry: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    vendor: { to: "vendor", fk: "vendorId", kind: "one" },
  },
  vendor: { school: { to: "school", fk: "schoolId", kind: "one" } },
  payrollRecord: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    teacher: { to: "teacher", fk: "teacherId", kind: "one" },
  },
  notification: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    user: { to: "user", fk: "userId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
  },
  device: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    user: { to: "user", fk: "userId", kind: "one" },
  },
  conversation: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    teacherUser: { to: "user", fk: "teacherUserId", kind: "one" },
    guardianUser: { to: "user", fk: "guardianUserId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
    messages: { to: "conversationMessage", via: "conversationId", kind: "many" },
  },
  conversationMessage: {
    conversation: { to: "conversation", fk: "conversationId", kind: "one" },
    sender: { to: "user", fk: "senderId", kind: "one" },
  },
  smsLog: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
  },
  bookCatalog: { school: { to: "school", fk: "schoolId", kind: "one" } },
  bookStock: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    book: { to: "bookCatalog", fk: "bookId", kind: "one" },
  },
  bookIssue: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    book: { to: "bookCatalog", fk: "bookId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
  },
  plan: {},
  subscription: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    plan: { to: "plan", fk: "planId", kind: "one" },
  },
  invoice: {
    school: { to: "school", fk: "schoolId", kind: "one" },
  },
  resource: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    section: { to: "section", fk: "sectionId", kind: "one" },
    subject: { to: "subject", fk: "subjectId", kind: "one" },
    teacher: { to: "teacher", fk: "teacherId", kind: "one" },
  },
  quiz: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    subject: { to: "subject", fk: "subjectId", kind: "one" },
    questions: { to: "question", via: "quizId", kind: "many" },
    attempts: { to: "quizAttempt", via: "quizId", kind: "many" },
  },
  question: { quiz: { to: "quiz", fk: "quizId", kind: "one" } },
  quizAttempt: {
    quiz: { to: "quiz", fk: "quizId", kind: "one" },
    student: { to: "student", fk: "studentId", kind: "one" },
  },
  virtualClass: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    section: { to: "section", fk: "sectionId", kind: "one" },
    subject: { to: "subject", fk: "subjectId", kind: "one" },
    teacher: { to: "teacher", fk: "teacherId", kind: "one" },
  },
  timetableSlot: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    classRoom: { to: "classRoom", fk: "classId", kind: "one" },
    section: { to: "section", fk: "sectionId", kind: "one" },
    subject: { to: "subject", fk: "subjectId", kind: "one" },
    teacher: { to: "teacher", fk: "teacherId", kind: "one" },
  },
  substitution: {
    school: { to: "school", fk: "schoolId", kind: "one" },
    slot: { to: "timetableSlot", fk: "slotId", kind: "one" },
    originalTeacher: { to: "teacher", fk: "originalTeacherId", kind: "one" },
    substituteTeacher: { to: "teacher", fk: "substituteTeacherId", kind: "one" },
  },
  calendarEvent: { school: { to: "school", fk: "schoolId", kind: "one" } },
  twoFactor: { user: { to: "user", fk: "userId", kind: "one" } },
  setting: {},
};

// ---------------------------------------------------------------------------
// Prisma @default values that routes rely on (Firestore has no defaults)
// ---------------------------------------------------------------------------

const DEFAULTS: Record<string, Record<string, any>> = {
  user: { active: true },
  student: { active: true },
};

// ---------------------------------------------------------------------------
// Low-level Firestore helpers
// ---------------------------------------------------------------------------

function col(model: string) {
  return getDb().collection(COLS[model]);
}

/** Convert Firestore Timestamps back to Date (so JSON output matches Prisma). */
function conv(v: any): any {
  if (v instanceof Timestamp) return v.toDate();
  if (Array.isArray(v)) return v.map(conv);
  if (v && typeof v === "object") {
    const out: Record<string, any> = {};
    for (const k of Object.keys(v)) out[k] = conv(v[k]);
    return out;
  }
  return v;
}

/**
 * Plain objects are recursed into; everything else (Date, Firestore Timestamp,
 * GeoPoint, FieldValue, Buffer…) is handed to Firestore untouched.
 */
function isPlainObject(v: any): boolean {
  if (!v || typeof v !== "object") return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * Strip undefined values (Firestore rejects them).
 *
 * Arrays are cleaned too, and that is not cosmetic: `[].map()` keeps a key that
 * holds `undefined`, so an array of objects where one optional field is unset
 * (a grade band without a remark, a quiz question without an image) made the
 * whole write fail with "Cannot use undefined as a Firestore value". Undefined
 * array ENTRIES are dropped as a whole.
 */
function cleanValue(v: any): any {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) return v.map(cleanValue).filter((x) => x !== undefined);
  if (isPlainObject(v)) return clean(v);
  return v;
}

function clean(data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    const cleaned = cleanValue(v);
    if (cleaned !== undefined) out[k] = cleaned;
  }
  return out;
}

/** Resolve ids matching `where` (used by deleteMany / updateMany / counts). */
async function resolveIds(model: string, where: Record<string, any>): Promise<string[]> {
  const did = idFor(model, where);
  if (did) return [did];
  const docs = await filterAll(model, where);
  return docs.map((d) => d.id);
}

// ---------------------------------------------------------------------------
// Fetch + in-memory filtering
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Read cache — the single biggest win for "click and it is there".
// ---------------------------------------------------------------------------

/**
 * A Firestore round trip on this dataset costs ~550ms and one API read
 * routinely pulls 2-4 collections, so a click used to cost 1-2.2s even though
 * the payload is only a few KB. The same TTL + invalidate pattern already
 * makes /api/stats and every schoolReference()-backed route answer in ~2ms;
 * this applies it to the collection pull that every read route goes through.
 *
 * The cached value is the RAW pull for one pushdown filter, so callers with
 * different `where` clauses (but the same school) legitimately share a single
 * round trip and still filter in memory exactly as before. Rows are deep
 * cloned on the way out, so a caller that decorates or strips fields (e.g.
 * dropping a student's qrPin) can never poison what the next caller sees.
 */
/**
 * How long a Firestore round trip's result counts as fresh. 30s matches the
 * `/api/stats` cache, so the app has one freshness story: aggregate reads are
 * memoized for 30s and **any write through `prisma.*` clears the memo**.
 */
const PULL_TTL_MS = Number(process.env.DB_READ_CACHE_MS || 30_000);

/**
 * How long an EXPIRED entry may still be served while it refreshes behind the
 * caller (stale-while-revalidate).
 *
 * Measured on the owner's network, one Firestore round trip costs 0.5–1.2s and
 * the first one after a cold start ~3.6s, so blocking a click until an expired
 * entry is re-read is exactly the wait the cache exists to remove. Past the TTL
 * the reader now gets the previous answer immediately while the fresh one is
 * fetched for the *next* read. Writes still clear the memo, so this window can
 * only ever expose out-of-band changes (seed script, Firestore console, another
 * instance) — not your own submits. Set DB_READ_GRACE_MS=0 to go back to
 * block-until-fresh.
 */
const PULL_GRACE_MS = Number(process.env.DB_READ_GRACE_MS ?? 120_000);

const pullMemo = new Map<string, { at: number; value: any }>();
const pullInflight = new Map<string, Promise<any>>();

/**
 * Bumped by every write. A read that started before the write must never
 * publish its pre-write result afterwards — without this guard a slow pull
 * racing a submit could re-cache stale rows for another full TTL.
 */
let cacheGeneration = 0;

/** Drop every cached pull. Write paths call this so a submit is never stale. */
export function invalidateDbCache(): void {
  cacheGeneration++;
  pullMemo.clear();
  // In-flight reads are dropped too: a read that started BEFORE the write must
  // not be handed to anyone who asks AFTER it. Without this, a background
  // refresh running across a submit hands out the pre-write value to the very
  // next reader — e.g. a school changes its grading scale and the exam sheet
  // opened a second later still grades with the old bands.
  pullInflight.clear();
}

/** Evict entries that are past the stale window and nobody may serve any more. */
function prunePullMemo(): void {
  if (pullMemo.size <= 800) return;
  const cutoff = Date.now() - PULL_GRACE_MS;
  for (const [k, v] of pullMemo) if (v.at < cutoff) pullMemo.delete(k);
}

/**
 * Run ONE Firestore round trip per key, shared by every concurrent reader and
 * never republished across a write. Without the dedupe a page whose three
 * panels ask for the same collection fires three identical 0.5–1.2s queries
 * instead of one.
 */
function loadPull<T>(key: string, run: () => Promise<T>): Promise<T> {
  const existing = pullInflight.get(key);
  if (existing) return existing as Promise<T>;
  const generation = cacheGeneration;
  const started = Promise.resolve()
    .then(run)
    .then((value) => {
      if (generation === cacheGeneration) {
        pullMemo.set(key, { at: Date.now(), value });
        prunePullMemo();
      }
      return value as T;
    });
  pullInflight.set(key, started);
  void started
    .catch(() => null)
    .finally(() => {
      if (pullInflight.get(key) === started) pullInflight.delete(key);
    });
  return started;
}

/**
 * Memo for one Firestore round trip's result — a document list, a single
 * document, or a count. Anything that goes to Firestore outside a collection
 * scan (relation lookups by id, child queries per parent, count aggregations)
 * is a full-latency hit unless it lands here.
 *
 *   fresh                 → answer from the memo
 *   expired, within grace → answer from the memo, refresh in the background
 *   otherwise             → wait for a fresh read (deduped across readers)
 */
async function cachedValue<T>(key: string, run: () => Promise<T>): Promise<T> {
  const hit = pullMemo.get(key);
  if (hit) {
    const age = Date.now() - hit.at;
    if (age < PULL_TTL_MS) return structuredClone(hit.value);
    if (age < PULL_GRACE_MS) {
      // Stale-while-revalidate: a click never waits for the refresh.
      void loadPull(key, run).catch(() => null);
      return structuredClone(hit.value);
    }
  }
  return structuredClone(await loadPull(key, run));
}


async function fetchAll(model: string, where?: Record<string, any>): Promise<any[]> {
  let q: FirebaseFirestore.Query = col(model);
  let key = model;
  // Push one equality filter down (single-field, avoids composite indexes).
  if (where && typeof where.schoolId === "string") {
    q = q.where("schoolId", "==", where.schoolId);
    key += `|schoolId=${where.schoolId}`;
    // Bonus pushdown: schoolId equality + a date range works with the
    // (schoolId, date) composite index and bounds the transfer for
    // time-windowed reads (e.g. the 7-day stats trend). Falls back to the
    // equality-only query while the index builds or if it is missing.
    const dateCond = where.date;
    if (dateCond && typeof dateCond === "object" && !(dateCond instanceof Date)) {
      const gte = dateCond.gte instanceof Date ? dateCond.gte : null;
      const lt = dateCond.lt instanceof Date ? dateCond.lt : null;
      if (gte || lt) {
        let ranged: FirebaseFirestore.Query = q;
        if (gte) ranged = ranged.where("date", ">=", gte);
        if (lt) ranged = ranged.where("date", "<", lt);
        // Distinct key from the equality-only fallback below: a wider result
        // must never be served for the narrower range.
        const rangeKey = `${key}|date=${gte ? gte.getTime() : ""}:${lt ? lt.getTime() : ""}`;
        try {
          return await cachedValue(rangeKey, async () => {
            const snap = await ranged.get();
            return snap.docs.map((d) => ({ id: d.id, ...conv(d.data()) }));
          });
        } catch {
          // composite index not ready — fall through to equality-only pull;
          // the in-memory filter still enforces the range.
        }
      }
    }
  } else if (where) {
    const first = Object.entries(where).find(
      ([, v]) => v !== undefined && v !== null && typeof v !== "object"
    );
    if (first) {
      q = q.where(first[0], "==", first[1]);
      key += `|${first[0]}=${String(first[1])}`;
    }
  }
  return cachedValue(key, async () => {
    const snap = await q.get();
    return snap.docs.map((d) => ({ id: d.id, ...conv(d.data()) }));
  });
}

/**
 * Tiny process-wide TTL memo for school-scoped reference data (classes,
 * sections, subjects, teachers, students…). Routes that resolve names via
 * repeated pulls reuse one fetch for ~3s; write routes call
 * `invalidateReferenceCache(schoolId)` so pages never see stale names.
 */
const REF_TTL_MS = 3_000;
const refMemo = new Map<string, { at: number; rows: any[] }>();

export function invalidateReferenceCache(schoolId: string | null | undefined): void {
  if (!schoolId) return;
  for (const k of refMemo.keys()) if (k.endsWith(`:${schoolId}`)) refMemo.delete(k);
  // Any write must also drop the raw pull cache: a freshly submitted row has
  // to show up on the very next read, not after the TTL.
  invalidateDbCache();
}

export async function schoolReference(model: string, schoolId: string): Promise<any[]> {
  const key = `${model}:${schoolId}`;
  const hit = refMemo.get(key);
  if (hit && Date.now() - hit.at < REF_TTL_MS) return hit.rows;
  const modelOps: any = (prisma as any)[model];
  const rows: any[] = await modelOps.findMany({ where: { schoolId } });
  refMemo.set(key, { at: Date.now(), rows });
  return rows;
}

/**
 * userId → name map in ONE school-scoped pull. Replaces the per-uid
 * findUnique waves routes used to resolve teacher/guardian display names.
 * Memo key and pull are both per school: teacher/guardian users always
 * carry `schoolId`, so filtering by the session's school resolves exactly
 * the same docs as before while keeping other schools' users out of the
 * memo. (SUPER_ADMIN users carry no schoolId, but no call site resolves
 * their names.) Rare schoolId-less docs are covered by direct gets.
 */
export async function userNamesFor(
  userIds: string[],
  schoolId?: string | null
): Promise<Map<string, string>> {
  const want = new Set(userIds.filter(Boolean));
  const out = new Map<string, string>();
  if (!want.size) return out;
  const key = `users:${schoolId || "ALL"}`;
  let rowsP = refMemo.get(key);
  if (!rowsP || Date.now() - rowsP.at >= REF_TTL_MS) {
    rowsP = {
      at: Date.now(),
      rows: await prisma.user.findMany({
        where: schoolId ? { schoolId } : {},
        select: { id: true, name: true },
      }),
    };
    refMemo.set(key, rowsP);
  }
  for (const u of rowsP.rows) if (want.has(u.id)) out.set(u.id, u.name);
  // Fall back to direct gets for any wanted id the scoped pull missed.
  const missing = [...want].filter((id) => !out.has(id));
  await Promise.all(
    missing.map(async (id) => {
      const u = await prisma.user.findUnique({ where: { id }, select: { id: true, name: true } });
      if (u) out.set(u.id, u.name);
    })
  );
  return out;
}

/** Context with per-query caches so relation lookups are cheap. */
/**
 * One document by id, through the memo. `findUnique`/`findFirst` by id and
 * every relation lookup share this key space, so `writeGuard`'s school read
 * and a notice's `include: { school }` cost one round trip between them
 * instead of one each.
 */
async function getDoc(model: string, id: string): Promise<any> {
  return cachedValue(`doc:${model}:${id}`, async () => {
    const snap = await col(model).doc(id).get();
    return snap.exists ? { id: snap.id, ...conv(snap.data()) } : null;
  });
}

class Ctx {
  private docCache = new Map<string, Promise<any>>();
  private listCache = new Map<string, Promise<any[]>>();
  private allCache = new Map<string, Promise<any[]>>();

  doc(model: string, id: string | undefined | null): Promise<any> {
    if (!id) return Promise.resolve(null);
    const key = `${model}:${id}`;
    if (!this.docCache.has(key)) {
      // Relation lookups (every `include: { school: … }`, `student: …`) are
      // single-document gets; they cost a full round trip each unless they
      // share the process memo, which is why one `include` used to add ~530ms
      // to an otherwise instant route.
      this.docCache.set(key, getDoc(model, id));
    }
    return this.docCache.get(key)!;
  }

  list(model: string, via: string, parentId: string): Promise<any[]> {
    const key = `${model}:${via}:${parentId}`;
    if (!this.listCache.has(key)) {
      // Same reasoning for to-many relations: a query per parent document.
      this.listCache.set(
        key,
        cachedValue(`list:${model}:${via}=${parentId}`, async () => {
          const s = await col(model).where(via, "==", parentId).get();
          return s.docs.map((d) => ({ id: d.id, ...conv(d.data()) }));
        })
      );
    }
    return this.listCache.get(key)!;
  }
}

/** Async filter over a list using a Prisma-style where clause. */
async function filterList(list: any[], model: string, where: Record<string, any> | undefined, ctx: Ctx): Promise<any[]> {
  if (!where || Object.keys(where).length === 0) return list;
  // Match all docs in parallel — relation lookups inside match() dedupe
  // through the Ctx promise caches, so this collapses N+1 lookups into a
  // single wave of queries (order is preserved by Promise.all).
  const keep = await Promise.all(list.map((d) => match(d, model, where, ctx)));
  return list.filter((_, i) => keep[i]);
}

async function filterAll(model: string, where: Record<string, any>): Promise<any[]> {
  const ctx = new Ctx();
  const list = await fetchAll(model, where);
  return filterList(list, model, where, ctx);
}

async function match(doc: any, model: string, where: Record<string, any>, ctx: Ctx): Promise<boolean> {
  for (const [key, cond] of Object.entries(where)) {
    if (cond === undefined) continue;
    if (key === "OR") {
      let ok = false;
      for (const sub of cond as any[]) {
        if (await match(doc, model, sub, ctx)) {
          ok = true;
          break;
        }
      }
      if (!ok) return false;
      continue;
    }
    if (key === "AND") {
      for (const sub of cond as any[]) {
        if (!(await match(doc, model, sub, ctx))) return false;
      }
      continue;
    }
    if (key === "NOT") {
      if (await match(doc, model, cond, ctx)) return false;
      continue;
    }

    const rel = RELS[model]?.[key];
    if (rel) {
      const truthy =
        cond === true || cond === undefined || (cond && typeof cond === "object" && Object.keys(cond).length === 0);
      if (rel.kind === "one") {
        const related = await ctx.doc(rel.to, doc[rel.fk!]);
        if (!related) {
          if (!truthy) {
            const eqNull = cond && typeof cond === "object" && cond.equals === null;
            if (!eqNull) return false;
          }
          continue;
        }
        if (truthy) continue;
        if (!(await match(related, rel.to, cond, ctx))) return false;
      } else if (rel.kind === "oneInverse") {
        const related = (await ctx.list(rel.to, rel.via!, doc.id))[0];
        if (!related) {
          if (!truthy) return false;
          continue;
        }
        if (truthy) continue;
        if (!(await match(related, rel.to, cond, ctx))) return false;
      } else {
        // to-many
        const list = await ctx.list(rel.to, rel.via!, doc.id);
        const sub = cond && typeof cond === "object" && "some" in cond ? cond.some : cond;
        if (truthy) continue;
        let ok = false;
        for (const item of list) {
          if (await match(item, rel.to, sub, ctx)) {
            ok = true;
            break;
          }
        }
        if (!ok) return false;
      }
      continue;
    }

    if (!(await scalarMatch(doc[key], cond))) return false;
  }
  return true;
}

function eq(a: any, b: any): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (a instanceof Date || b instanceof Date) {
    const ta = a instanceof Date ? a.getTime() : Date.parse(a);
    const tb = b instanceof Date ? b.getTime() : Date.parse(b);
    return ta === tb;
  }
  return a === b;
}

async function scalarMatch(value: any, cond: any): Promise<boolean> {
  if (cond === null) return value === null || value === undefined;
  if (cond && typeof cond === "object" && !(cond instanceof Date) && !Array.isArray(cond)) {
    for (const [op, arg] of Object.entries(cond)) {
      if (op === "equals") {
        if (!eq(value, arg)) return false;
      } else if (op === "not") {
        if (eq(value, arg)) return false;
      } else if (op === "in") {
        if (!(arg as any[]).some((x) => eq(value, x))) return false;
      } else if (op === "notIn") {
        if ((arg as any[]).some((x) => eq(value, x))) return false;
      } else if (op === "contains") {
        const v = String(value ?? "").toLowerCase();
        if (!v.includes(String(arg).toLowerCase())) return false;
      } else if (op === "startsWith") {
        if (!String(value ?? "").toLowerCase().startsWith(String(arg).toLowerCase())) return false;
      } else if (op === "endsWith") {
        if (!String(value ?? "").toLowerCase().endsWith(String(arg).toLowerCase())) return false;
      } else if (op === "gt") {
        if (!(Number(value) > Number(arg))) return false;
      } else if (op === "gte") {
        if (!(Number(value) >= Number(arg))) return false;
      } else if (op === "lt") {
        if (!(Number(value) < Number(arg))) return false;
      } else if (op === "lte") {
        if (!(Number(value) <= Number(arg))) return false;
      }
      // mode: "insensitive" is handled above by lowercasing
    }
    return true;
  }
  return eq(value, cond);
}

// ---------------------------------------------------------------------------
// Sorting (in-memory; supports nested relation fields)
// ---------------------------------------------------------------------------

function pathValue(obj: any, path: string): any {
  let cur = obj;
  for (const part of path.split(".")) {
    if (cur == null) return undefined;
    cur = cur[part];
  }
  return cur;
}

function compare(a: any, b: any): number {
  if (a instanceof Date) a = a.getTime();
  if (b instanceof Date) b = b.getTime();
  if (a == null && b == null) return 0;
  if (a == null) return 1; // nulls last
  if (b == null) return -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

function sortBy(list: any[], orderBy: any): any[] {
  const specs: { field: string; dir: "asc" | "desc" }[] = Array.isArray(orderBy)
    ? orderBy.map((o) => {
        const [field, dir] = Object.entries(o)[0];
        return { field, dir: (dir || "asc") as "asc" | "desc" };
      })
    : Object.entries(orderBy).map(([field, dir]) => ({ field, dir: (dir || "asc") as "asc" | "desc" }));
  return [...list].sort((a, b) => {
    for (const { field, dir } of specs) {
      const c = compare(pathValue(a, field), pathValue(b, field));
      if (c !== 0) return dir === "desc" ? -c : c;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// Include / select resolver
// ---------------------------------------------------------------------------

async function applyInclude(doc: any, model: string, include: Record<string, any>, ctx: Ctx): Promise<void> {
  // Resolve all include keys in one parallel wave (each key writes a
  // distinct property; relation queries dedupe through the Ctx caches).
  await Promise.all(
    Object.entries(include).map(async ([key, spec]) => {
      if (key === "_count") {
        const countSpec = spec.select || {};
        const entries = Object.entries(countSpec).filter(([, flag]) => flag);
        const counts = await Promise.all(
          entries.map(([relKey]) => {
            const rel = RELS[model][relKey];
            if (!rel) return Promise.resolve({ relKey, n: 0, inverse: false });
            const many = rel.kind === "many" || rel.kind === "oneInverse";
            return many
              ? ctx.list(rel.to, rel.via!, doc.id).then((l) => ({ relKey, n: l.length, inverse: rel.kind === "oneInverse" }))
              : Promise.resolve({ relKey, n: 0, inverse: false });
          })
        );
        doc._count = {};
        for (const { relKey, n, inverse } of counts) doc._count[relKey] = inverse ? (n ? 1 : 0) : n;
        return;
      }
      const rel = RELS[model]?.[key];
      if (!rel) return;
      if (rel.kind === "one") {
        const related = await ctx.doc(rel.to, doc[rel.fk!]);
        doc[key] = related ? await shape(related, rel.to, spec, ctx) : null;
      } else if (rel.kind === "oneInverse") {
        const related = (await ctx.list(rel.to, rel.via!, doc.id))[0];
        doc[key] = related ? await shape(related, rel.to, spec, ctx) : null;
      } else {
        let list = await ctx.list(rel.to, rel.via!, doc.id);
        if (spec && spec.where) list = await filterList(list, rel.to, spec.where, ctx);
        if (spec && spec.orderBy) list = sortBy(list, spec.orderBy);
        if (spec && spec.take !== undefined) list = list.slice(0, spec.take);
        doc[key] = await Promise.all(list.map((d) => shape(d, rel.to, spec, ctx)));
      }
    })
  );
}

async function shape(doc: any, model: string, spec: any, ctx: Ctx): Promise<any> {
  if (!spec) return doc;
  if (spec === true) return doc;
  const out: any = { ...doc };
  if (spec.include) await applyInclude(out, model, spec.include, ctx);
  if (spec.select) {
    const picked: Record<string, any> = {};
    const select: Record<string, any> = spec.select;
    // Pick/select all keys in one parallel wave.
    await Promise.all(
      Object.entries(select).map(async ([k, v]) => {
        if (v === true) {
          picked[k] = out[k];
        } else if (v && typeof v === "object") {
          const rel = RELS[model]?.[k];
          if (rel?.kind === "one") {
            const related = await ctx.doc(rel.to, out[rel.fk!]);
            picked[k] = related ? await shape(related, rel.to, v, ctx) : null;
          } else if (rel?.kind === "oneInverse") {
            const related = (await ctx.list(rel.to, rel.via!, out.id))[0];
            picked[k] = related ? await shape(related, rel.to, v, ctx) : null;
          } else if (rel) {
            let list = await ctx.list(rel.to, rel.via!, out.id);
            if (v.where) list = await filterList(list, rel.to, v.where, ctx);
            if (v.orderBy) list = sortBy(list, v.orderBy);
            if (v.take !== undefined) list = list.slice(0, v.take);
            picked[k] = await Promise.all(list.map((d) => shape(d, rel.to, v, ctx)));
          }
        }
      })
    );
    return picked;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

async function findUnique(model: string, args: any): Promise<any> {
  const ctx = new Ctx();
  const did = idFor(model, args?.where || {});
  let doc: any = null;
  if (did) {
    doc = await getDoc(model, did);
  } else {
    const list = await fetchAll(model, args?.where);
    const matched = await filterList(list, model, args?.where, ctx);
    doc = matched[0] ?? null;
  }
  if (!doc) return null;
  if (args?.include) await applyInclude(doc, model, args.include, ctx);
  if (args?.select) return shape(doc, model, { select: args.select }, ctx);
  return doc;
}

async function findFirst(model: string, args: any): Promise<any> {
  const ctx = new Ctx();
  let doc: any = null;
  if (args?.where?.id) {
    doc = await getDoc(model, String(args.where.id));
  }
  if (!doc) {
    const list = await fetchAll(model, args?.where);
    const matched = await filterList(list, model, args?.where, ctx);
    doc = matched[0] ?? null;
  }
  if (!doc) return null;
  if (args?.include) await applyInclude(doc, model, args.include, ctx);
  if (args?.select) return shape(doc, model, { select: args.select }, ctx);
  return doc;
}

async function findMany(model: string, args: any): Promise<any[]> {
  const ctx = new Ctx();
  let list = await fetchAll(model, args?.where);
  list = await filterList(list, model, args?.where, ctx);
  if (args?.include) await Promise.all(list.map((d) => applyInclude(d, model, args.include, ctx)));
  if (args?.orderBy) list = sortBy(list, args.orderBy);
  if (args?.take !== undefined) list = list.slice(0, args.take);
  if (args?.select) list = await Promise.all(list.map((d) => shape(d, model, { select: args.select }, ctx)));
  return list;
}

async function count(model: string, args: any): Promise<number> {
  const where = args?.where || {};
  const keys = Object.keys(where).filter((k) => where[k] !== undefined && where[k] !== null);
  // Fast path: a lone string-equality filter pushes down to Firestore cleanly
  // (schoolId, examId, …), so use the native count aggregation instead of
  // pulling every document just to count it.
  if (keys.length === 1 && typeof where[keys[0]] === "string") {
    // Counts are the third uncached round trip: cache the NUMBER (a Firestore
    // snapshot is not structured-cloneable, the count is).
    return await cachedValue(`count:${model}:${keys[0]}=${where[keys[0]]}`, async () => {
      const snap = await col(model).where(keys[0], "==", where[keys[0]]).count().get();
      return Number((snap.data() as any).count ?? (snap.data() as any).totalCount ?? 0);
    });
  }
  const list = await filterAll(model, where);
  return list.length;
}

// ---------------------------------------------------------------------------
// Write operations (lazy Op so $transaction can batch them)
// ---------------------------------------------------------------------------

class Op<T = any> implements PromiseLike<T> {
  constructor(private fn: (batch?: WriteBatch) => Promise<T>) {}
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.fn().then(onfulfilled as any, onrejected as any);
  }
  catch(onRejected?: any): Promise<any> {
    return this.fn().catch(onRejected);
  }
  finally(onFinally?: any): Promise<any> {
    return this.fn().finally(onFinally);
  }
  _run(batch?: WriteBatch): Promise<T> {
    return this.fn(batch);
  }
}

async function create(model: string, data: Record<string, any>, batch?: WriteBatch): Promise<any> {
  const d: Record<string, any> = { ...(DEFAULTS[model] || {}), ...data };
  // Extract nested creates (e.g. school.feeSetting: { create: {...} })
  const nested: { rel: Rel; childData: Record<string, any> }[] = [];
  for (const [k, v] of Object.entries(d)) {
    const rel = RELS[model]?.[k];
    if (rel && v && typeof v === "object" && "create" in v) {
      nested.push({ rel, childData: v.create });
      delete d[k];
    }
  }
  // Honor an explicit id supplied by the caller (e.g. paymentIntents use
  // their own pi_… ids so intents can be looked up by id later).
  const explicitId = typeof d.id === "string" && d.id.trim() ? d.id : undefined;
  const id = idForCreate(model, d) || explicitId || rand();
  const ref = col(model).doc(id);
  const payload = clean(d);
  if (explicitId) delete payload.id; // never store id as a data field
  if (batch) {
    batch.set(ref, payload);
  } else {
    await ref.set(payload);
  }
  for (const { rel, childData } of nested) {
    const child: Record<string, any> = { ...childData };
    if (rel.via) child[rel.via] = id;
    else if (rel.fk) child[rel.fk] = id;
    await create(rel.to, child, batch);
  }
  return { ...d, id };
}

async function createMany(model: string, rows: Record<string, any>[], batch?: WriteBatch): Promise<any> {
  for (const row of rows) {
    await create(model, row, batch);
  }
  return undefined;
}

async function update(model: string, args: any, batch?: WriteBatch): Promise<any> {
  const id = String(args?.where?.id);
  const d: Record<string, any> = { ...(args?.data || {}) };
  // Extract nested updates (e.g. teacher.user: { update: {...} })
  const nested: { rel: Rel; updateData: Record<string, any> }[] = [];
  for (const [k, v] of Object.entries(d)) {
    const rel = RELS[model]?.[k];
    if (rel && v && typeof v === "object" && "update" in v) {
      nested.push({ rel, updateData: v.update });
      delete d[k];
    }
  }
  const ref = col(model).doc(id);
  if (batch) {
    batch.set(ref, clean(d), { merge: true });
  } else {
    await ref.set(clean(d), { merge: true });
  }
  for (const { rel, updateData } of nested) {
    const parent = await ref.get().then((s) => (s.exists ? s.data() : null));
    let targetId: string | null = null;
    if (rel.fk) {
      // to-one: parent holds the FK
      targetId = parent?.[rel.fk] ?? null;
    } else if (rel.via) {
      // oneInverse: child holds the FK — look it up
      const kids = await col(rel.to).where(rel.via, "==", id).limit(1).get();
      targetId = kids.empty ? null : kids.docs[0].id;
    }
    if (targetId) {
      const tref = col(rel.to).doc(String(targetId));
      if (batch) batch.set(tref, clean(updateData), { merge: true });
      else await tref.set(clean(updateData), { merge: true });
    }
  }
  const snap = await ref.get();
  return { id, ...conv(snap.exists ? snap.data() : {}) };
}

async function updateMany(model: string, args: any): Promise<number> {
  const ids = args?.where?.id?.in ? [...args.where.id.in] : await resolveIds(model, args?.where || {});
  for (const id of ids) {
    await col(model).doc(id).set(clean(args?.data || {}), { merge: true });
  }
  return ids.length;
}

async function upsert(model: string, args: any, batch?: WriteBatch): Promise<any> {
  const did = idFor(model, args?.where || {}) || rand();
  const ref = col(model).doc(did);
  const merged = { ...(args?.create || {}), ...(args?.update || {}) };
  if (batch) {
    batch.set(ref, clean(merged), { merge: true });
  } else {
    await ref.set(clean(merged), { merge: true });
  }
  return { id: did, ...merged };
}

async function del(model: string, args: any, batch?: WriteBatch): Promise<any> {
  const id = String(args?.where?.id);
  const ref = col(model).doc(id);
  if (batch) batch.delete(ref);
  else await ref.delete();
  return { ok: true };
}

async function deleteMany(model: string, where: Record<string, any>, batch?: WriteBatch): Promise<number> {
  const ids = await resolveIds(model, where);
  for (const id of ids) {
    const ref = col(model).doc(id);
    if (batch) batch.delete(ref);
    else await ref.delete();
  }
  return ids.length;
}

// ---------------------------------------------------------------------------
// Model facade (mirrors prisma.<model>.<method>)
// ---------------------------------------------------------------------------

/**
 * Wrap a write so the pull cache is dropped the moment it lands.
 *
 * Freshness must not depend on a route remembering to invalidate: about
 * thirty write routes never call an invalidator, and a 5s cached read after
 * one of them would show pre-write data. Doing it here makes every write
 * through `prisma.*` correct by construction, including future routes.
 * (The per-route `invalidateReferenceCache` / `invalidateStats` calls remain
 * for the other two layers — the reference memo and the stats payloads.)
 */
function writeOp(fn: (b?: WriteBatch) => Promise<any>): Op {
  return new Op(async (b) => {
    const out = await fn(b);
    invalidateDbCache();
    return out;
  });
}

function model(name: string) {
  return {
    findUnique: (args?: any) => findUnique(name, args),
    findFirst: (args?: any) => findFirst(name, args),
    findMany: (args?: any) => findMany(name, args),
    count: (args?: any) => count(name, args),
    create: (args: any) => writeOp((b) => create(name, args?.data || {}, b)),
    createMany: (args: any) => writeOp((b) => createMany(name, args?.data || [], b)),
    update: (args: any) => writeOp((b) => update(name, args, b)),
    updateMany: (args: any) => writeOp(() => updateMany(name, args)),
    upsert: (args: any) => writeOp((b) => upsert(name, args, b)),
    delete: (args: any) => writeOp((b) => del(name, args, b)),
    deleteMany: (args: any) => writeOp((b) => deleteMany(name, args?.where || {}, b)),
  };
}

type ModelApi = ReturnType<typeof model>;

type PrismaLike = {
  [K in keyof typeof prisma]: typeof prisma[K];
};

/** Array form → atomic writeBatch. Callback form → sequential direct ops. */
async function transaction<T>(
  arg: ((tx: any) => Promise<T>) | Op<any>[]
): Promise<T | undefined> {
  if (Array.isArray(arg)) {
    const batch = getDb().batch();
    for (const op of arg) await op._run(batch);
    await batch.commit();
    // The individual ops already cleared the memo; clear once more after the
    // commit so a reader that squeezed in between cannot leave stale rows
    // cached for the whole TTL.
    invalidateDbCache();
    return undefined;
  }
  if (typeof arg === "function") {
    return arg(prisma as any);
  }
  throw new Error("$transaction expects an array of ops or a callback");
}

export const prisma = {
  school: model("school"),
  user: model("user"),
  teacher: model("teacher"),
  student: model("student"),
  classRoom: model("classRoom"),
  section: model("section"),
  subject: model("subject"),
  classAssignment: model("classAssignment"),
  routine: model("routine"),
  attendance: model("attendance"),
  dailyRemark: model("dailyRemark"),
  homework: model("homework"),
  homeworkSubmission: model("homeworkSubmission"),
  exam: model("exam"),
  examMark: model("examMark"),
  notice: model("notice"),
  feeSetting: model("feeSetting"),
  fee: model("fee"),
  payment: model("payment"),
  message: model("message"),
  auditLog: model("auditLog"),
  setting: model("setting"),
  // ---- PRD v1.2 new models ----
  admission: model("admission"),
  admissionDocument: model("admissionDocument"),
  discount: model("discount"),
  academicSession: model("academicSession"),
  branch: model("branch"),
  leaveRequest: model("leaveRequest"),
  meetingSlot: model("meetingSlot"),
  meetingBooking: model("meetingBooking"),
  complaint: model("complaint"),
  galleryItem: model("galleryItem"),
  healthRecord: model("healthRecord"),
  feeTemplate: model("feeTemplate"),
  feeTemplateItem: model("feeTemplateItem"),
  installment: model("installment"),
  ledgerEntry: model("ledgerEntry"),
  paymentIntent: model("paymentIntent"),
  expenseEntry: model("expenseEntry"),
  vendor: model("vendor"),
  payrollRecord: model("payrollRecord"),
  notification: model("notification"),
  device: model("device"),
  conversation: model("conversation"),
  conversationMessage: model("conversationMessage"),
  smsLog: model("smsLog"),
  bookCatalog: model("bookCatalog"),
  bookIssue: model("bookIssue"),
  bookStock: model("bookStock"),
  plan: model("plan"),
  subscription: model("subscription"),
  invoice: model("invoice"),
  resource: model("resource"),
  quiz: model("quiz"),
  question: model("question"),
  quizAttempt: model("quizAttempt"),
  virtualClass: model("virtualClass"),
  timetableSlot: model("timetableSlot"),
  substitution: model("substitution"),
  calendarEvent: model("calendarEvent"),
  twoFactor: model("twoFactor"),
  $transaction: transaction,
};
