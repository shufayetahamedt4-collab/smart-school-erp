import { prisma, ON_ROLL_STUDENT } from "@/lib/db";
import type { SessionUser } from "@/lib/auth";
import { guardianChildId, guardianChildren } from "@/lib/auth";
import { scopeWhere } from "@/lib/permissions";

/**
 * The assistant's read tools.
 *
 * Every one of these runs through the SAME tenant/branch scoping the portal's own
 * API routes use (`scopeWhere`, `guardianChildren`) — the assistant can never see
 * more than the signed-in user could see by opening the page by hand. These are
 * NEW functions in a NEW file; no existing route or helper is modified.
 */

const STATUS_KEYS = ["PRESENT", "ABSENT", "LATE", "LEAVE"] as const;
type StatusKey = (typeof STATUS_KEYS)[number];

export interface AttendanceSummary {
  date: string;
  total: number;
  marked: number;
  counts: Record<StatusKey, number>;
  absentees: { name: string; className: string }[];
}

function dayBounds(dateISO?: string): { day: Date; next: Date; iso: string } {
  const day = dateISO ? new Date(`${dateISO}T00:00:00`) : new Date();
  day.setHours(0, 0, 0, 0);
  const next = new Date(day);
  next.setDate(next.getDate() + 1);
  const y = day.getFullYear();
  const m = String(day.getMonth() + 1).padStart(2, "0");
  const d = String(day.getDate()).padStart(2, "0");
  return { day, next, iso: `${y}-${m}-${d}` };
}

function emptyCounts(): Record<StatusKey, number> {
  return { PRESENT: 0, ABSENT: 0, LATE: 0, LEAVE: 0 };
}

async function classNames(session: SessionUser): Promise<Map<string, string>> {
  const classes = await prisma.classRoom.findMany({ where: scopeWhere(session) });
  return new Map(classes.map((c: any) => [c.id, String(c.name || "")]));
}

/** Teacher: today's attendance across the school (branch-scoped). */
export async function teacherAttendance(session: SessionUser, dateISO?: string): Promise<AttendanceSummary> {
  const scoped = scopeWhere(session);
  const { day, next, iso } = dayBounds(dateISO);
  const [students, rows, names] = await Promise.all([
    prisma.student.findMany({ where: { ...scoped, ...ON_ROLL_STUDENT } }),
    prisma.attendance.findMany({ where: { ...scoped, date: { gte: day, lt: next } } }),
    classNames(session),
  ]);
  const counts = emptyCounts();
  const rowByStudent = new Map(rows.map((r: any) => [r.studentId, r]));
  const absentees: { name: string; className: string }[] = [];
  for (const s of students as any[]) {
    const row: any = rowByStudent.get(s.id);
    const status = String(row?.status || "UNMARKED") as StatusKey | "UNMARKED";
    if (status !== "UNMARKED" && (STATUS_KEYS as readonly string[]).includes(status)) {
      counts[status as StatusKey] += 1;
    } else if (status === "ABSENT") {
      counts.ABSENT += 1;
    }
    if (status === "ABSENT") {
      absentees.push({ name: String(s.name || "Student"), className: names.get(s.classId) || "" });
    }
  }
  return {
    date: iso,
    total: students.length,
    marked: rows.length,
    counts,
    absentees,
  };
}

/** Teacher: the classes in their school (branch-scoped). */
export async function teacherClasses(session: SessionUser): Promise<{ name: string; students: number }[]> {
  const scoped = scopeWhere(session);
  const [classes, students] = await Promise.all([
    prisma.classRoom.findMany({ where: scoped }),
    prisma.student.findMany({ where: { ...scoped, ...ON_ROLL_STUDENT } }),
  ]);
  const counts = new Map<string, number>();
  for (const s of students as any[]) if (s.classId) counts.set(s.classId, (counts.get(s.classId) || 0) + 1);
  return (classes as any[])
    .map((c) => ({ name: String(c.name || "Class"), students: counts.get(c.id) || 0 }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

export interface HomeworkItem {
  title: string;
  subject: string;
  className: string;
  due: string | null;
}

function mapHomework(rows: any[], subjectById: Map<string, string>, classById: Map<string, string>): HomeworkItem[] {
  return rows.map((h) => ({
    title: String(h.title || h.description || "Homework"),
    subject: subjectById.get(h.subjectId) || "",
    className: classById.get(h.classId) || "",
    due: h.dueDate ? new Date(h.dueDate).toISOString() : null,
  }));
}

async function referenceMaps(session: SessionUser) {
  const [subjects, classes] = await Promise.all([
    prisma.subject.findMany({ where: { schoolId: session.schoolId! } }),
    prisma.classRoom.findMany({ where: { schoolId: session.schoolId! } }),
  ]);
  return {
    subjectById: new Map(subjects.map((s: any) => [s.id, String(s.name || "")])),
    classById: new Map(classes.map((c: any) => [c.id, String(c.name || "")])),
  };
}

/** Teacher: homework they have set (falls back to the school's most recent). */
export async function teacherHomework(session: SessionUser): Promise<HomeworkItem[]> {
  const teacher = await prisma.teacher.findFirst({ where: { userId: session.id, schoolId: session.schoolId! } });
  const where: Record<string, unknown> = { schoolId: session.schoolId! };
  if ((teacher as any)?.id) where.teacherId = (teacher as any).id;
  const [rows, maps] = await Promise.all([
    prisma.homework.findMany({ where }),
    referenceMaps(session),
  ]);
  return mapHomework((rows as any[]).slice(0, 8), maps.subjectById, maps.classById);
}

/** Guardian: homework for the linked child's class/section. */
export async function guardianHomework(session: SessionUser): Promise<{ childName: string; items: HomeworkItem[] }> {
  const children = await guardianChildren(session);
  const child = children[0];
  if (!child) return { childName: "", items: [] };
  const where: Record<string, unknown> = { schoolId: session.schoolId!, classId: child.classId || undefined };
  if (child.sectionId) where.sectionId = child.sectionId;
  const [rows, maps] = await Promise.all([prisma.homework.findMany({ where }), referenceMaps(session)]);
  return { childName: child.name, items: mapHomework((rows as any[]).slice(0, 8), maps.subjectById, maps.classById) };
}

export interface MarkItem {
  subject: string;
  obtained: string;
  grade: string;
  exam: string;
}

function marksOf(rows: any[], subjectById: Map<string, string>, examById: Map<string, string>): MarkItem[] {
  return rows.map((m) => {
    const obtained = m.obtained ?? m.marks ?? m.score ?? "";
    const full = m.fullMarks ?? m.total ?? "";
    return {
      subject: subjectById.get(m.subjectId) || "Subject",
      obtained: full !== "" ? `${obtained}/${full}` : String(obtained),
      grade: String(m.grade || m.gpa || ""),
      exam: examById.get(m.examId) || "",
    };
  });
}

/** Guardian: the linked child's most recent marks. */
export async function guardianMarks(session: SessionUser): Promise<{ childName: string; items: MarkItem[] }> {
  const childId = await guardianChildId(session);
  if (!childId) return { childName: "", items: [] };
  const children = await guardianChildren(session);
  const child = children.find((c) => c.id === childId);
  const [marks, subjects, exams] = await Promise.all([
    prisma.examMark.findMany({ where: { schoolId: session.schoolId!, studentId: childId } }),
    prisma.subject.findMany({ where: { schoolId: session.schoolId! } }),
    prisma.exam.findMany({ where: { schoolId: session.schoolId! } }),
  ]);
  const subjectById = new Map(subjects.map((s: any) => [s.id, String(s.name || "")]));
  const examById = new Map(exams.map((e: any) => [e.id, String(e.name || "")]));
  return { childName: child?.name || "", items: marksOf((marks as any[]).slice(0, 10), subjectById, examById) };
}

/** Guardian: outstanding fees for the linked child. */
export async function guardianFees(session: SessionUser): Promise<{ childName: string; due: { label: string; amount: string; status: string }[]; outstanding: number }> {
  const childId = await guardianChildId(session);
  if (!childId) return { childName: "", due: [], outstanding: 0 };
  const children = await guardianChildren(session);
  const child = children.find((c) => c.id === childId);
  const fees = await prisma.fee.findMany({ where: { schoolId: session.schoolId!, studentId: childId } });
  const due: { label: string; amount: string; status: string }[] = [];
  let outstanding = 0;
  for (const f of fees as any[]) {
    const status = String(f.status || "UNPAID");
    const amount = Number(f.amount ?? f.total ?? 0);
    if (status !== "PAID") {
      outstanding += amount;
      due.push({ label: String(f.title || f.type || f.month || "Fee"), amount: `${amount}`, status });
    }
  }
  return { childName: child?.name || "", due: due.slice(0, 8), outstanding };
}

/** Teacher: find a student by (partial) name and read their recent marks. */
export async function teacherMarks(session: SessionUser, name?: string): Promise<{ studentName: string; items: MarkItem[] } | null> {
  if (!name) return null;
  const student = await prisma.student.findFirst({
    where: { schoolId: session.schoolId!, ...ON_ROLL_STUDENT, name: { contains: name, mode: "insensitive" } },
  });
  if (!student) return null;
  const [marks, subjects, exams] = await Promise.all([
    prisma.examMark.findMany({ where: { schoolId: session.schoolId!, studentId: (student as any).id } }),
    prisma.subject.findMany({ where: { schoolId: session.schoolId! } }),
    prisma.exam.findMany({ where: { schoolId: session.schoolId! } }),
  ]);
  const subjectById = new Map(subjects.map((s: any) => [s.id, String(s.name || "")]));
  const examById = new Map(exams.map((e: any) => [e.id, String(e.name || "")]));
  return { studentName: String((student as any).name || name), items: marksOf((marks as any[]).slice(0, 8), subjectById, examById) };
}

/** Both roles: the latest notices for the school. */
export async function latestNotices(session: SessionUser): Promise<{ title: string; category: string; date: string }[]> {
  const notices = await prisma.notice.findMany({
    where: { schoolId: session.schoolId! },
    orderBy: { date: "desc" },
    take: 5,
  });
  return (notices as any[]).map((n) => ({
    title: String(n.title || "Notice"),
    category: String(n.category || "GENERAL"),
    date: n.date ? new Date(n.date).toISOString() : "",
  }));
}

/** Guardian: the linked child's attendance over the last ~30 school days. */
export async function guardianAttendance(session: SessionUser): Promise<{
  childName: string;
  total: number;
  counts: Record<StatusKey, number>;
  recent: { date: string; status: string }[];
}> {
  const childId = await guardianChildId(session);
  if (!childId) return { childName: "", total: 0, counts: emptyCounts(), recent: [] };
  const children = await guardianChildren(session);
  const child = children.find((c) => c.id === childId);
  const rows = await prisma.attendance.findMany({ where: { schoolId: session.schoolId!, studentId: childId } });
  const sorted = (rows as any[])
    .filter((r) => r?.date)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 30);
  const counts = emptyCounts();
  for (const r of sorted) {
    const s = String(r.status || "") as StatusKey;
    if ((STATUS_KEYS as readonly string[]).includes(s)) counts[s] += 1;
  }
  return {
    childName: child?.name || "your child",
    total: sorted.length,
    counts,
    recent: sorted.slice(0, 5).map((r) => ({ date: new Date(r.date).toISOString(), status: String(r.status || "") })),
  };
}

/** Teacher: resolve a homework draft's class (their first) for the action. */
export async function firstClassForTeacher(session: SessionUser): Promise<string | null> {
  const cls = await prisma.classRoom.findFirst({ where: scopeWhere(session) });
  return (cls as any)?.id || null;
}

/** Resolve a subject id by (partial) name for the school, else the first subject. */
export async function subjectIdByName(session: SessionUser, name?: string): Promise<string | null> {
  const subjects = await prisma.subject.findMany({ where: { schoolId: session.schoolId! } });
  const list = subjects as any[];
  if (name) {
    const hit = list.find((s) => String(s.name || "").toLowerCase().includes(name.toLowerCase()));
    if (hit) return hit.id;
  }
  return list[0]?.id || null;
}
