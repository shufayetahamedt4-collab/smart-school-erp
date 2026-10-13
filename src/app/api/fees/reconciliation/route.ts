import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { can, isBranchScoped } from "@/lib/permissions";
import { prisma } from "@/lib/db";
import { money } from "@/lib/utils";

/**
 * GET /api/fees/reconciliation — the school fee reconciliation report.
 *
 * READ-ONLY, admin-only, school-scoped. It answers one question about the
 * tenant's own money: does every fee header agree with the ROWS that were
 * written for it? A fee records money in three places —
 *
 *   fee.paidAmount                          the header (what the screens show)
 *   payment rows        (payment.feeId)     what `confirmPayment` appended
 *   ledgerEntry rows    (kind=PAYMENT, status=CONFIRMED, feeId)
 *
 * and the three can disagree in the two ways a crash and a keyless clamp can
 * produce (see docs/PILOT-FIX-2.md §6):
 *
 *   (i)   fee_above_sums              paidAmount is more than its payment rows
 *                                     sum to — money the header claims and no
 *                                     row justifies (a lost append: the fee
 *                                     moved, the rows did not)
 *   (ii)  payment_ledger_mismatch     the payment rows and the CONFIRMED ledger
 *                                     rows disagree — an append that landed in
 *                                     one place and not the other
 *   (iii) sums_above_fee              a sum is more than the fee was billed for —
 *                                     an over-collection a KEYLESS clamp swallowed
 *                                     (the keyed path refuses instead of clamping,
 *                                     so only `paidAmount` was capped)
 *
 * A fee is reported once per class that applies; `clean` counts the rest.
 * Nothing is ever written: no counter, no stamp, no audit row, no cache warm.
 *
 * READ COST (per call — reported in `readCost` so a caller can see it):
 *   - 1 native count of the school's fees (`fee.count` → Firestore count
 *     aggregation, no documents) for `total`;
 *   - F fee documents: the school's fee HEADERS are read once per call. The data
 *     layer has no keyset pagination, so enumerating the page's ids costs that
 *     collection read (it is memoized by `db.ts` for the pull TTL, which is why
 *     a walk is cheaper than F × pages);
 *   - the payment rows and the CONFIRMED PAYMENT ledger rows for the returned
 *     page ONLY, batched ≤30 fee ids per query (Firestore's `in` limit): P_page
 *     and L_page documents. The ledger is never read whole, and no collection
 *     outside `fee` / `payment` / `ledgerEntry` is touched — in particular no
 *     college collection is named or read (see scripts/verify-college-routes.mjs).
 *
 * PAGING: `limit` (default 200, max 500) bounds the page; `cursor` is the last
 * fee id of the previous page (a keyset over ids, so a walk is stable and
 * duplicate-free). Repeat with `nextCursor` until `hasMore` is false to cover
 * every issue in the school exactly once.
 *
 * WHY THIS PATH: `/api/fees/reconciliation` is a STATIC sibling of the existing
 * static fee routes (`fees/settings`, `fees/generate`, `fees/reminders`) under
 * the `[id]` segment. A static segment wins over `[id]`, so the only thing that
 * could ever be shadowed is a fee whose id is the literal string
 * "reconciliation" — no id generator in this app produces one (ids are auto-ids
 * or `fee_…`). The alternative, a NEW top-level `/api/<something>` directory,
 * would have to be classified in scripts/verify-college-routes.mjs' frozen
 * non-college inventory to keep that guard green; staying inside `fees/` avoids
 * touching that verifier at all.
 */

/** Who may read this report. A branch-confined session is refused below. */
const RECON_ROLES = new Set(["SUPER_ADMIN", "SCHOOL_ADMIN", "ACCOUNTANT"]);

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;
/** Firestore's `in` limit: the page's rows are read in batches of this size. */
const IN_CHUNK = 30;

export type DriftClass = "fee_above_sums" | "payment_ledger_mismatch" | "sums_above_fee";

/** Money as an INTEGER (the report never emits a float or a NaN). */
const int = (v: unknown): number => Math.round(money(v));

interface DriftRow {
  class: DriftClass;
  feeId: string;
  studentId: string | null;
  title: string | null;
  status: string | null;
  feeAmount: number;
  paidAmount: number;
  paymentSum: number;
  ledgerSum: number;
  paymentCount: number;
  ledgerCount: number;
  /** (i) how much the header claims beyond its payment rows. */
  delta: number;
  /** (ii) payment rows minus CONFIRMED ledger rows. */
  rowDelta: number;
  /** (iii) the largest sum minus the amount billed. */
  overFee: number;
  /** The keyed stamp this fee carries (P2), or null when it was never keyed. */
  stamp: {
    receiptNo: string;
    amount: number;
    method: string | null;
    paidAmount: number;
    feeStatus: string | null;
    at: string | null;
  } | null;
  /** Receipt numbers on this fee's CONFIRMED PAYMENT ledger rows (≤5, unique). */
  receipts: string[];
  /** Ids of up to 5 of those ledger rows, for a drill-down. */
  ledgerIds: string[];
}

export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Read-only, but this is the tenant's whole fee book: the two admin roles and
  // the accountant (who holds `feePayment` full) read it. A branch-confined
  // session is refused on purpose — the report is school-wide, across every
  // branch, and a BRANCH_ADMIN must not see another branch's money. REGISTRAR
  // (fee read but no fee management), TEACHER, STUDENT and GUARDIAN are refused.
  if (
    !RECON_ROLES.has(session.role) ||
    isBranchScoped(session) ||
    !can(session.role, "feePayment", "view")
  ) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const sp = req.nextUrl.searchParams;
  let schoolId = session.schoolId || "";
  // A super admin has no tenant of its own, so it must name one explicitly.
  if (session.role === "SUPER_ADMIN") {
    schoolId = (sp.get("schoolId") || "").trim();
    if (!schoolId) {
      return NextResponse.json({ error: "schoolId is required for a super admin." }, { status: 400 });
    }
  }
  if (!schoolId) {
    return NextResponse.json({ error: "No school is attached to this account." }, { status: 400 });
  }

  const rawLimit = Number(sp.get("limit"));
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), MAX_LIMIT) : DEFAULT_LIMIT;
  const cursor = (sp.get("cursor") || "").trim() || null;

  const feeWhere: Record<string, any> = { schoolId };
  const [total, feeRows] = await Promise.all([
    prisma.fee.count({ where: feeWhere }),
    prisma.fee.findMany({ where: feeWhere }),
  ]);

  // One page of the school's fees, ordered by document id, starting after the
  // cursor. `total` is the school-wide fee count, `scanned` the page's size.
  const ordered: any[] = [...feeRows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const after: any[] = cursor ? ordered.filter((f) => f.id > cursor) : ordered;
  const page = after.slice(0, limit);
  const hasMore = after.length > page.length;
  const nextCursor = hasMore && page.length ? String(page[page.length - 1].id) : null;

  const pageIds = page.map((f) => String(f.id));
  const paySum = new Map<string, number>();
  const payCount = new Map<string, number>();
  const ledSum = new Map<string, number>();
  const ledCount = new Map<string, number>();
  const ledIds = new Map<string, string[]>();
  const ledReceipts = new Map<string, string[]>();
  let paymentDocuments = 0;
  let ledgerDocuments = 0;
  // The native count + the fee headers, then one payment and one ledger query per batch.
  let queries = 2;

  // Chunked reads: only the returned page's rows, batched by Firestore's `in`
  // limit. `feeId` is stored on both rows, so this is ONE indexed query per
  // batch; the schoolId filter is re-applied in memory (defence in depth — a
  // feeId belongs to exactly one tenant, so it can never widen the result).
  for (let i = 0; i < pageIds.length; i += IN_CHUNK) {
    const chunk = pageIds.slice(i, i + IN_CHUNK);
    const rows: any[] = await prisma.payment.findMany({ where: { feeId: { in: chunk } } });
    queries += 1;
    for (const p of rows) {
      if (p.schoolId !== schoolId) continue;
      paymentDocuments += 1;
      paySum.set(p.feeId, (paySum.get(p.feeId) || 0) + int(p.amount));
      payCount.set(p.feeId, (payCount.get(p.feeId) || 0) + 1);
    }
    const led: any[] = await prisma.ledgerEntry.findMany({
      where: { feeId: { in: chunk }, kind: "PAYMENT", status: "CONFIRMED" },
    });
    queries += 1;
    for (const l of led) {
      if (l.schoolId !== schoolId) continue;
      ledgerDocuments += 1;
      ledSum.set(l.feeId, (ledSum.get(l.feeId) || 0) + int(l.amount));
      ledCount.set(l.feeId, (ledCount.get(l.feeId) || 0) + 1);
      const ids = ledIds.get(l.feeId) || [];
      if (ids.length < 5) ids.push(String(l.id));
      ledIds.set(l.feeId, ids);
      const receipt = l.meta && typeof l.meta === "object" ? String((l.meta as any).receiptNo ?? "") : "";
      if (receipt) {
        const seen = ledReceipts.get(l.feeId) || [];
        if (!seen.includes(receipt) && seen.length < 5) seen.push(receipt);
        ledReceipts.set(l.feeId, seen);
      }
    }
  }

  const issues: DriftRow[] = [];
  const counts: Record<DriftClass, number> = {
    fee_above_sums: 0,
    payment_ledger_mismatch: 0,
    sums_above_fee: 0,
  };
  let clean = 0;

  for (const f of page) {
    const id = String(f.id);
    const feeAmount = int(f.amount);
    const paidAmount = int(f.paidAmount);
    const paymentSum = paySum.get(id) || 0;
    const ledgerSum = ledSum.get(id) || 0;
    const classes: DriftClass[] = [];
    // (iii) first: an over-collection shows up as a sum above what was billed.
    if (paymentSum > feeAmount || ledgerSum > feeAmount) classes.push("sums_above_fee");
    // (i) the header claims MORE than its payment rows wrote — the lost append.
    // (A header that merely disagrees with the ledger is (ii), not (i): its own
    // payment rows still justify the money.)
    if (paidAmount > paymentSum) classes.push("fee_above_sums");
    // (ii) the two row families disagree with each other.
    if (paymentSum !== ledgerSum) classes.push("payment_ledger_mismatch");

    if (!classes.length) {
      clean += 1;
      continue;
    }

    // The keyed stamp P2 leaves on a keyed payment: the receipt the family holds.
    // The raw idempotency key is a CLIENT token and never leaves the API — only
    // what the fee recorded about the payment that used it.
    const stampRaw = f.idempotency && typeof f.idempotency === "object" ? (f.idempotency as any) : null;
    const stamp = stampRaw
      ? {
          receiptNo: String(stampRaw.receiptNo ?? ""),
          amount: int(stampRaw.amount),
          method: stampRaw.method ? String(stampRaw.method) : null,
          paidAmount: int(stampRaw.paidAmount),
          feeStatus: stampRaw.feeStatus ? String(stampRaw.feeStatus) : null,
          at: stampRaw.at ? String(stampRaw.at) : null,
        }
      : null;

    for (const cls of classes) {
      counts[cls] += 1;
      issues.push({
        class: cls,
        feeId: id,
        studentId: f.studentId ? String(f.studentId) : null,
        title: f.title != null ? String(f.title) : null,
        status: f.status != null ? String(f.status) : null,
        feeAmount,
        paidAmount,
        paymentSum,
        ledgerSum,
        paymentCount: payCount.get(id) || 0,
        ledgerCount: ledCount.get(id) || 0,
        delta: paidAmount - paymentSum,
        rowDelta: paymentSum - ledgerSum,
        overFee: Math.max(paymentSum, ledgerSum) - feeAmount,
        stamp,
        receipts: ledReceipts.get(id) || [],
        ledgerIds: ledIds.get(id) || [],
      });
    }
  }

  return NextResponse.json({
    data: {
      schoolId,
      role: session.role,
      total,
      page: { limit, cursor, scanned: page.length, hasMore, nextCursor },
      clean,
      counts,
      issues,
      readCost: {
        feeDocuments: feeRows.length,
        paymentDocuments,
        ledgerDocuments,
        queries,
        note:
          "logical documents read for THIS call: the school's fee count (native, 0 docs), " +
          "the school's fee headers (F), then the payment and CONFIRMED PAYMENT ledger " +
          "rows of the returned page only (batched <=30 fee ids). The ledger is never read whole.",
      },
    },
  });
}
