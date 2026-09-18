import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { notifyUsers } from "@/lib/notify";

/**
 * PRD §8 — Book/Asset and Inventory Management.
 * Catalog: textbooks, library books, uniforms, assets. Stock per item with
 * low-stock alerts (§8.1) notified to Librarian/School Admin.
 */

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "library", "view")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const sp = req.nextUrl.searchParams;
  const type = sp.get("type"); // TEXTBOOK | LIBRARY | UNIFORM | ASSET

  const books = await prisma.bookCatalog.findMany({
    where: { schoolId, ...(type ? { type: type as any } : {}) },
    orderBy: { createdAt: "desc" },
  });
  // bookCatalog has no registered stock/issues relations in db.ts — fetch
  // both side-collections for the school and join in memory.
  const [stocks, activeIssues] = await Promise.all([
    prisma.bookStock.findMany({ where: { schoolId } }),
    prisma.bookIssue.findMany({ where: { schoolId, status: "ISSUED" }, select: { bookId: true } }),
  ]);
  const stockBy = new Map(stocks.map((s: any) => [s.bookId, s]));
  const issuedBy = new Map<string, number>();
  for (const i of activeIssues) issuedBy.set((i as any).bookId, (issuedBy.get((i as any).bookId) || 0) + 1);

  return NextResponse.json({
    data: books.map((b: any) => {
      const stock = stockBy.get(b.id) || null;
      const issued = issuedBy.get(b.id) || 0;
      return {
        id: b.id,
        title: b.title,
        code: b.code || null,
        type: b.type,
        classId: b.classId || null,
        className: b.className || null,
        price: b.price || 0,
        stock: stock ? { total: Number(stock.total) || 0, lowStockThreshold: Number(stock.lowStockThreshold) || 0 } : null,
        issued,
        available: (Number(stock?.total) || 0) - issued,
      };
    }),
  });
}

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "library", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId!;
  const locked = await writeGuard(schoolId);
  if (locked) return locked;
  const body = await req.json().catch(() => null);
  const title = String(body?.title || "").trim();
  if (!title) return NextResponse.json({ error: "Title is required." }, { status: 400 });

  const type = ["TEXTBOOK", "LIBRARY", "UNIFORM", "ASSET"].includes(body?.type) ? body.type : "LIBRARY";
  const book = await prisma.bookCatalog.create({
    data: {
      schoolId,
      title,
      code: body?.code ? String(body.code) : null,
      type,
      classId: body?.classId || null,
      className: body?.className || null,
      price: Number(body?.price || 0),
    },
  });
  await prisma.bookStock.create({
    data: {
      schoolId,
      bookId: book.id,
      total: Number(body?.stock || 0),
      lowStockThreshold: Number(body?.lowStockThreshold || 3),
    },
  });

  if (Number(body?.stock || 0) > 0 && Number(body?.stock) <= Number(body?.lowStockThreshold || 3)) {
    await lowStockAlert(schoolId, title);
  }
  await audit("BOOK_CREATE", "bookCatalog", book.id, { title });
  return NextResponse.json({ data: book }, { status: 201 });
}

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
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });

  const book = await prisma.bookCatalog.findUnique({ where: { id } });
  if (!book || book.schoolId !== schoolId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const data: any = {};
  if (body.title !== undefined) data.title = String(body.title);
  if (body.code !== undefined) data.code = body.code ? String(body.code) : null;
  if (body.type !== undefined) data.type = body.type;
  if (body.classId !== undefined) data.classId = body.classId || null;
  if (body.className !== undefined) data.className = body.className || null;
  if (body.price !== undefined) data.price = Number(body.price);

  await prisma.bookCatalog.update({ where: { id }, data });
  if (body.stock !== undefined || body.lowStockThreshold !== undefined) {
    const existing = await prisma.bookStock.findFirst({ where: { bookId: id } });
    if (existing) {
      const stockData: any = {};
      if (body.stock !== undefined) stockData.total = Number(body.stock);
      if (body.lowStockThreshold !== undefined) stockData.lowStockThreshold = Number(body.lowStockThreshold);
      await prisma.bookStock.update({ where: { id: existing.id }, data: stockData });
    } else {
      await prisma.bookStock.create({
        data: { schoolId, bookId: id, total: Number(body.stock || 0), lowStockThreshold: Number(body.lowStockThreshold || 3) },
      });
    }
    const fresh = await prisma.bookStock.findFirst({ where: { bookId: id } });
    if (fresh && Number(fresh.total) > 0 && Number(fresh.total) <= Number(fresh.lowStockThreshold || 0)) {
      await lowStockAlert(schoolId, book.title);
    }
  }
  await audit("BOOK_UPDATE", "bookCatalog", id, data);
  return NextResponse.json({ data: { ok: true } });
}

export async function DELETE(req: NextRequest) {
  const session = await getSession();
  if (!session || !can(session.role, "library", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const book = await prisma.bookCatalog.findUnique({ where: { id } });
  if (!book || book.schoolId !== session.schoolId) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const active = await prisma.bookIssue.findMany({ where: { bookId: id, status: "ISSUED" }, take: 1 });
  if (active.length) {
    return NextResponse.json({ error: "Cannot delete — copies are still issued." }, { status: 400 });
  }
  await prisma.bookStock.deleteMany({ where: { bookId: id } });
  await prisma.bookCatalog.delete({ where: { id } });
  await audit("BOOK_DELETE", "bookCatalog", id);
  return NextResponse.json({ data: { ok: true } });
}

async function lowStockAlert(schoolId: string, title: string) {
  const staff = await prisma.user.findMany({
    where: { schoolId, role: { in: ["SCHOOL_ADMIN", "LIBRARIAN"] } },
    select: { id: true },
  });
  if (!staff.length) return;
  await notifyUsers({
    schoolId,
    userIds: staff.map((s) => s.id),
    event: "NOTICE_PUBLISHED",
    title: "Low stock alert",
    body: `"${title}" is at or below its low-stock threshold.`,
    link: "/dashboard/library",
  });
}
