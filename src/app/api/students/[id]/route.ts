import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/db";
import { getSession, audit, guardianOwnsStudent } from "@/lib/auth";
import { writeGuard } from "@/lib/subscription";
import { invalidateStats } from "@/lib/stats-cache";

/**
 * PRD §7.2 — "Separate, limited-permission login from Guardian (school will
 * decide from which class students receive login access)." POST creates a
 * STUDENT login for a specific student; PATCH grants/revokes portal access.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const locked = await writeGuard(session.schoolId);
  if (locked) return locked;

  const student = await prisma.student.findUnique({ where: { id } });
  if (!student || student.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }
  if (student.userId) return NextResponse.json({ error: "This student already has a login." }, { status: 400 });

  const body = await req.json().catch(() => null);
  const email = String(body?.email || "").trim().toLowerCase();
  const password = String(body?.password || "");
  if (!email || !password) return NextResponse.json({ error: "Email and password are required." }, { status: 400 });
  if (password.length < 6) return NextResponse.json({ error: "Password must be at least 6 characters." }, { status: 400 });
  if (await prisma.user.findUnique({ where: { email } })) {
    return NextResponse.json({ error: "Email already in use." }, { status: 400 });
  }

  const user = await prisma.user.create({
    data: {
      email,
      name: student.name,
      role: "STUDENT",
      schoolId: session.schoolId!,
      active: true,
      passwordHash: bcrypt.hashSync(password, 10),
    },
  });
  await prisma.student.update({ where: { id }, data: { userId: user.id } });
  await audit("STUDENT_LOGIN_CREATE", "user", user.id, { studentId: id });
  return NextResponse.json({ data: { userId: user.id, email } }, { status: 201 });
}

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || !["SCHOOL_ADMIN", "TEACHER", "SUPER_ADMIN", "GUARDIAN"].includes(session.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await params;
  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      classRoom: { select: { id: true, name: true } },
      section: { select: { id: true, name: true } },
      guardianUser: { select: { id: true, name: true, email: true } },
      user: { select: { id: true, email: true, active: true } },
      attendance: { orderBy: { date: "desc" }, take: 30 },
      remarks: { orderBy: { date: "desc" }, take: 10, include: { teacher: { select: { user: { select: { name: true } } } } } },
      fees: { orderBy: { dueDate: "desc" }, include: { payments: { orderBy: { date: "desc" } } } },
      school: { select: { id: true, name: true } },
    },
  });
  if (!student) return NextResponse.json({ error: "Student not found" }, { status: 404 });
  // Tenant isolation: never let one school's session read another school's
  // student by guessing an id. SUPER_ADMIN is cross-school by design.
  if (session.role !== "SUPER_ADMIN" && student.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }
  // PRD §7.2 — a guardian may read ONLY their own linked child (this is what
  // the Attendance, Remarks and Exam Results pages load). Credential fields
  // (the child's QR token/PIN) are stripped from the response.
  if (session.role === "GUARDIAN") {
    // Own child or a sibling the family link put in the same household (§5.4) —
    // the same rule the printable marksheet/report card/id card pages use.
    const own = await guardianOwnsStudent(session, student);
    if (!own || student.schoolId !== session.schoolId) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    const { qrPin, qrToken, ...safe } = student as any;
    return NextResponse.json({ data: safe });
  }
  return NextResponse.json({ data: student });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const locked = await writeGuard(session.schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const student = await prisma.student.findUnique({ where: { id } });
  if (!student || student.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Student not found" }, { status: 404 });
  }

  const allowed = [
    "admissionNo", "name", "dob", "gender", "bloodGroup", "religion", "roll", "registrationNo",
    "classId", "sectionId", "guardianName", "guardianPhone", "guardianEmail", "guardianRelation",
    "emergencyContact", "address", "medicalInfo", "photoUrl", "active", "qrPin",
  ];
  const data: any = {};
  for (const key of allowed) {
    if (body[key] !== undefined) data[key] = key === "dob" || key === "admissionDate" ? (body[key] ? new Date(body[key]) : null) : body[key];
  }
  // PRD §7.2 — revoke student portal access (deactivate the login, keep data).
  if (body.portalAccess === false && student.userId) {
    await prisma.user.update({ where: { id: student.userId }, data: { active: false } });
  }
  if (body.portalAccess === true && student.userId) {
    await prisma.user.update({ where: { id: student.userId }, data: { active: true } });
  }

  const updated = await prisma.student.update({ where: { id }, data });
  await audit("STUDENT_UPDATE", "student", id);
  invalidateStats(session.schoolId, "students");
  return NextResponse.json({ data: updated });
}

export async function DELETE(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const session = await getSession();
  if (!session || session.role !== "SCHOOL_ADMIN") return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  const { id } = await params;
  const locked = await writeGuard(session.schoolId);
  if (locked) return locked;
  const student = await prisma.student.findUnique({ where: { id } });
  if (!student || student.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  // A pupil is referenced from all over the school. Deleting the identity doc
  // alone left fees, attendance, marks, remarks, leave requests, book issues
  // and payment intents pointing at a studentId that no longer existed — dues
  // kept showing, a stale fee could still be "paid", and the ledger kept
  // claiming money against a pupil nobody could see. So: pupil-owned rows go
  // with the pupil; rows that are money/audit/history (ledger, library issues,
  // complaints, chat threads, the admission trail) survive with the link cut.
  const ids = (m: string, where: Record<string, any>) =>
    (prisma as any)[m].findMany({ where, select: { id: true } });
  const [
    feeRows, attRows, remarkRows, subRows, markRows, quizRows, leaveRows,
    payRows, intentRows, instRows, notifRows, msgRows, bookRows, healthRows,
    smsRows, ledgerRows, issueRows, complaintRows, convRows, admissionRows,
  ] = await Promise.all([
    ids("fee", { studentId: id }),
    ids("attendance", { studentId: id }),
    ids("dailyRemark", { studentId: id }),
    ids("homeworkSubmission", { studentId: id }),
    ids("examMark", { studentId: id }),
    ids("quizAttempt", { studentId: id }),
    ids("leaveRequest", { studentId: id }),
    ids("payment", { studentId: id }),
    ids("paymentIntent", { studentId: id }),
    ids("installment", { studentId: id }),
    ids("notification", { studentId: id }),
    ids("message", { studentId: id }),
    ids("meetingBooking", { studentId: id }),
    ids("healthRecord", { studentId: id }),
    ids("smsLog", { studentId: id }),
    ids("ledgerEntry", { studentId: id }),
    ids("bookIssue", { studentId: id }),
    ids("complaint", { studentId: id }),
    ids("conversation", { studentId: id }),
    ids("admission", { convertedStudentId: id }),
  ]);

  const ops: any[] = [];
  const drop = (m: string, rows: { id: string }[]) => {
    for (const r of rows) ops.push((prisma as any)[m].delete({ where: { id: r.id } }));
  };
  const cut = (m: string, rows: { id: string }[], data: Record<string, any>) => {
    for (const r of rows) ops.push((prisma as any)[m].update({ where: { id: r.id }, data }));
  };

  // Pupil-owned rows go with the pupil...
  drop("fee", feeRows);
  drop("attendance", attRows);
  drop("dailyRemark", remarkRows);
  drop("homeworkSubmission", subRows);
  drop("examMark", markRows);
  drop("quizAttempt", quizRows);
  drop("leaveRequest", leaveRows);
  drop("payment", payRows);
  drop("paymentIntent", intentRows);
  drop("installment", instRows);
  drop("notification", notifRows);
  drop("message", msgRows);
  drop("meetingBooking", bookRows);
  drop("healthRecord", healthRows);
  drop("smsLog", smsRows);
  // ...history rows survive but no longer point at the pupil. The ledger keeps
  // its entries (money that genuinely moved), the library keeps its issues
  // (a copy may still be out), guardians keep their feedback and chat threads,
  // admissions keep their trail.
  cut("ledgerEntry", ledgerRows, { studentId: null, feeId: null });
  cut("bookIssue", issueRows, { studentId: null, fineFeeId: null });
  cut("complaint", complaintRows, { studentId: null });
  cut("conversation", convRows, { studentId: null });
  cut("admission", admissionRows, { convertedStudentId: null });
  // The pupil's own login, if one was created.
  if (student.userId) {
    drop("device", await prisma.device.findMany({ where: { userId: student.userId }, select: { id: true } }));
    drop("notification", await prisma.notification.findMany({ where: { userId: student.userId }, select: { id: true } }));
    ops.push(prisma.user.delete({ where: { id: student.userId } }));
  }
  ops.push(prisma.student.delete({ where: { id } }));

  // Firestore batches cap at 500 writes and each op above is one write, so
  // chunk — a pupil with years of attendance must still delete fully.
  for (let i = 0; i < ops.length; i += 400) {
    await prisma.$transaction(ops.slice(i, i + 400));
  }

  invalidateStats(session.schoolId, "all");
  const cascade = {
    fees: feeRows.length,
    payments: payRows.length,
    attendance: attRows.length,
    remarks: remarkRows.length,
    marks: markRows.length,
    submissions: subRows.length,
    quizAttempts: quizRows.length,
    leaveRequests: leaveRows.length,
    bookIssues: issueRows.length,
    ledgerEntries: ledgerRows.length,
    notifications: notifRows.length,
    messages: msgRows.length,
    loginRemoved: Boolean(student.userId),
  };
  await audit("STUDENT_DELETE", "student", id, { cascade });
  return NextResponse.json({ data: { ok: true, cascade } });
}
