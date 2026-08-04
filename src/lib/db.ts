import { createHash, randomBytes } from "node:crypto";
import { getDb } from "./firebase";
import { Timestamp, type WriteBatch } from "firebase-admin/firestore";

// ---------------------------------------------------------------------------
// Public types (replaces @prisma/client imports)
// ---------------------------------------------------------------------------

export type Role = "SUPER_ADMIN" | "SCHOOL_ADMIN" | "TEACHER" | "GUARDIAN";
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
  },
  user: {
    school: { to: "school", fk: "schoolId", kind: "one" },
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

/** Strip undefined values (Firestore rejects them). */
function clean(data: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    if (v && typeof v === "object" && !(v instanceof Date) && !Array.isArray(v)) {
      out[k] = clean(v);
    } else {
      out[k] = v;
    }
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

async function fetchAll(model: string, where?: Record<string, any>): Promise<any[]> {
  let q: FirebaseFirestore.Query = col(model);
  // Push one equality filter down (single-field, avoids composite indexes).
  if (where && typeof where.schoolId === "string") {
    q = q.where("schoolId", "==", where.schoolId);
  } else if (where) {
    const first = Object.entries(where).find(
      ([, v]) => v !== undefined && v !== null && typeof v !== "object"
    );
    if (first) q = q.where(first[0], "==", first[1]);
  }
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...conv(d.data()) }));
}

/** Context with per-query caches so relation lookups are cheap. */
class Ctx {
  private docCache = new Map<string, Promise<any>>();
  private listCache = new Map<string, Promise<any[]>>();
  private allCache = new Map<string, Promise<any[]>>();

  doc(model: string, id: string | undefined | null): Promise<any> {
    if (!id) return Promise.resolve(null);
    const key = `${model}:${id}`;
    if (!this.docCache.has(key)) {
      this.docCache.set(
        key,
        col(model)
          .doc(id)
          .get()
          .then((s) => (s.exists ? { id: s.id, ...conv(s.data()) } : null))
      );
    }
    return this.docCache.get(key)!;
  }

  list(model: string, via: string, parentId: string): Promise<any[]> {
    const key = `${model}:${via}:${parentId}`;
    if (!this.listCache.has(key)) {
      this.listCache.set(
        key,
        col(model)
          .where(via, "==", parentId)
          .get()
          .then((s) => s.docs.map((d) => ({ id: d.id, ...conv(d.data()) })))
      );
    }
    return this.listCache.get(key)!;
  }
}

/** Async filter over a list using a Prisma-style where clause. */
async function filterList(list: any[], model: string, where: Record<string, any> | undefined, ctx: Ctx): Promise<any[]> {
  if (!where || Object.keys(where).length === 0) return list;
  const out: any[] = [];
  for (const d of list) {
    if (await match(d, model, where, ctx)) out.push(d);
  }
  return out;
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
  for (const [key, spec] of Object.entries(include)) {
    if (key === "_count") {
      doc._count = {};
      for (const [relKey, flag] of Object.entries(spec.select || {})) {
        if (!flag) continue;
        const rel = RELS[model][relKey];
        if (!rel) continue;
        const count = rel.kind === "many" || rel.kind === "oneInverse" ? await ctx.list(rel.to, rel.via!, doc.id) : [];
        doc._count[relKey] = rel.kind === "oneInverse" ? (count.length ? 1 : 0) : count.length;
      }
      continue;
    }
    const rel = RELS[model]?.[key];
    if (!rel) continue;
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
  }
}

async function shape(doc: any, model: string, spec: any, ctx: Ctx): Promise<any> {
  if (!spec) return doc;
  if (spec === true) return doc;
  const out: any = { ...doc };
  if (spec.include) await applyInclude(out, model, spec.include, ctx);
  if (spec.select) {
    const picked: Record<string, any> = {};
    const select: Record<string, any> = spec.select;
    for (const [k, v] of Object.entries(select)) {
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
    }
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
    const snap = await col(model).doc(did).get();
    if (snap.exists) doc = { id: snap.id, ...conv(snap.data()) };
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
    const snap = await col(model).doc(String(args.where.id)).get();
    if (snap.exists) doc = { id: snap.id, ...conv(snap.data()) };
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
  const list = await filterAll(model, args?.where || {});
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
  const id = idForCreate(model, d) || rand();
  const ref = col(model).doc(id);
  const payload = clean(d);
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
  return { id, ...d };
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

function model(name: string) {
  return {
    findUnique: (args?: any) => findUnique(name, args),
    findFirst: (args?: any) => findFirst(name, args),
    findMany: (args?: any) => findMany(name, args),
    count: (args?: any) => count(name, args),
    create: (args: any) => new Op((b) => create(name, args?.data || {}, b)),
    createMany: (args: any) => new Op((b) => createMany(name, args?.data || [], b)),
    update: (args: any) => new Op((b) => update(name, args, b)),
    updateMany: (args: any) => new Op(() => updateMany(name, args)),
    upsert: (args: any) => new Op((b) => upsert(name, args, b)),
    delete: (args: any) => new Op((b) => del(name, args, b)),
    deleteMany: (args: any) => new Op((b) => deleteMany(name, args?.where || {}, b)),
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
  $transaction: transaction,
};
