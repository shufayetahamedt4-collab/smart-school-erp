import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit, guardianChildId, resolveActingStudent } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { postToLedger } from "@/lib/ledger";
import { notifyUsers } from "@/lib/notify";

/**
 * PRD §8.1/§8.2 — Book issue / return tracking with fines.
 * Lost or overdue items create a LIBRARY_FINE fee on the student's account,
 * which flows through the central ledger and the guardian's View+Pay (§10).
 */

const FINE_FEE_TYPE = "OTHER"; // feeType enum — fine flagged via title + ledger meta

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "library", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;
  const studentId = sp.get("studentId") || undefined;
  const status = sp.get("status") || undefined; // ISSUED | RETURNED | LOST

  // Guardians may only see their own child's issues — the child they name when
  // it is theirs, otherwise the family's stable default child.
  let scopedStudentId = studentId;
  if (session.role === "GUARDIAN") {
    scopedStudentId = (await guardianChildId(session, studentId)) || undefined;
    if (!scopedStudentId) return NextResponse.json({ data: [] });
  } else if (session.role === "STUDENT") {
    scopedStudentId = (await resolveActingStudent(session))?.id;
    if (!scopedStudentId) return NextResponse.json({ data: [] });
  }

  const issues = await prisma.bookIssue.findMany({
    where: {
      schoolId,
      ...(scopedStudentId ? { studentId: scopedStudentId } : {}),
      ...(status ? { status: status as any } : {}),
    },
    include: {
      book: { select: { id: true, title: true, code: true, type: true } },
      student: { select: { id: true, name: true, admissionNo: true, classRoom: { select: { name: true } } } },
    },
    orderBy: { issuedAt: "desc" },
    take: 300,
  });
  return NextResponse.json({ data: issues });
}

/** Issue a book to a student (decrements available stock). */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "library", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const bookId = String(body?.bookId || "");
  const studentId = String(body?.studentId || "");
  if (!bookId || !studentId) return NextResponse.json({ error: "bookId and studentId are required." }, { status: 400 });

  const book = await prisma.bookCatalog.findUnique({ where: { id: bookId } });
  if (!book || book.schoolId !== schoolId) return NextResponse.json({ error: "Book not found" }, { status: 404 });

  // No stock relation on bookCatalog — read the side collection directly.
  const stock = await prisma.bookStock.findFirst({ where: { bookId } });
  const issued = await prisma.bookIssue.count({ where: { bookId, status: "ISSUED" } });
  const available = (Number(stock?.total) || 0) - issued;
  if (available <= 0) {
    return NextResponse.json({ error: "No copies available in stock." }, { status: 400 });
  }

  const dueDays = Number(body?.dueDays || 14);
  const issue = await prisma.bookIssue.create({
    data: {
      schoolId,
      bookId,
      studentId,
      issuedById: session.id,
      issuedAt: new Date(),
      dueDate: new Date(Date.now() + dueDays * 86400000),
      status: "ISSUED",
      fineAmount: 0,
    },
  });
  await audit("BOOK_ISSUE", "bookIssue", issue.id, { bookId, studentId });
  return NextResponse.json({ data: issue }, { status: 201 });
}

/** Return / mark lost. Lost items (and overdue returns, optionally) create a fine fee. */
export async function PATCH(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "library", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const id = String(body?.id || "");
  const action = body?.action === "LOST" ? "LOST" : "RETURN";
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const issue = await prisma.bookIssue.findUnique({ where: { id }, include: { book: { select: { title: true } } } });
  if (!issue || issue.schoolId !== schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (issue.status !== "ISSUED") return NextResponse.json({ error: "Already closed." }, { status: 400 });

  if (action === "LOST") {
    const fine = Number(body?.fineAmount || 0) || Number((issue as any).fineAmount) || 0;
    const amount = fine > 0 ? fine : 200; // default lost-book fine (৳200) — school can override per-issue
    // Create the fine as a fee on the student's account → guardian View+Pay (§10)
    const fee = await prisma.fee.create({
      data: {
        schoolId,
        studentId: issue.studentId,
        title: `Library fine — lost: ${issue.book.title}`.slice(0, 120),
        amount,
        paidAmount: 0,
        feeType: FINE_FEE_TYPE,
        status: "UNPAID",
        dueDate: new Date(),
        note: `bookIssue:${issue.id}`,
      },
    });
    await postToLedger({
      schoolId,
      kind: "FEE",
      amount,
      status: "CONFIRMED",
      studentId: issue.studentId,
      feeId: fee.id,
      actorId: session.id,
      description: `Library fine (lost book): ${issue.book.title}`,
      meta: { bookIssueId: issue.id, fine: "LOST" },
    });
    await prisma.bookIssue.update({ where: { id }, data: { status: "LOST", fineAmount: amount, fineFeeId: fee.id } });

    // Notify the guardian about the fine (§8.2)
    const student = await prisma.student.findUnique({ where: { id: issue.studentId }, select: { guardianUserId: true, name: true } });
    if (student?.guardianUserId) {
      await notifyUsers({
        schoolId,
        userIds: [student.guardianUserId],
        event: "FEE_DUE_REMINDER",
        title: "Library fine added",
        body: `${student.name}: lost book "${issue.book.title}" — fine ৳${amount} added to fees.`,
        link: "/parent/fees",
      });
    }
    await audit("BOOK_LOST", "bookIssue", id, { fine: amount });
    return NextResponse.json({ data: { ok: true, fine: amount, feeId: fee.id } });
  }

  // Plain return
  const overdue = issue.dueDate && new Date(issue.dueDate) < new Date();
  let lateFine = 0;
  if (overdue && body?.lateFinePerDay) {
    const days = Math.ceil((Date.now() - new Date(issue.dueDate as any).getTime()) / 86400000);
    lateFine = Math.min(days, 60) * Number(body.lateFinePerDay || 0);
  }
  if (lateFine > 0) {
    const fee = await prisma.fee.create({
      data: {
        schoolId,
        studentId: issue.studentId,
        title: `Library fine — late return: ${issue.book.title}`.slice(0, 120),
        amount: lateFine,
        paidAmount: 0,
        feeType: FINE_FEE_TYPE,
        status: "UNPAID",
        dueDate: new Date(),
        note: `bookIssue:${issue.id}`,
      },
    });
    await postToLedger({
      schoolId,
      kind: "FEE",
      amount: lateFine,
      status: "CONFIRMED",
      studentId: issue.studentId,
      feeId: fee.id,
      actorId: session.id,
      description: `Library fine (late return): ${issue.book.title}`,
      meta: { bookIssueId: issue.id, fine: "LATE" },
    });
    await prisma.bookIssue.update({ where: { id }, data: { fineAmount: lateFine, fineFeeId: fee.id } });
  }
  await prisma.bookIssue.update({ where: { id }, data: { status: "RETURNED", returnedAt: new Date() } });
  await audit("BOOK_RETURN", "bookIssue", id, { lateFine });
  return NextResponse.json({ data: { ok: true, lateFine } });
}
