import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import { collegeGateDecision } from "@/lib/institution";
import { COLLEGE_FEES_READ_REFUSAL, canReadCollegeFees } from "@/lib/college-fees-access";
import { loadCollegeFeeConfig, loadStructure } from "@/lib/college-fees-server";
import { collegeTermLabel } from "@/lib/college-fees";
import { fmtDate } from "@/lib/utils";
import { PrintActions } from "@/components/PrintActions";
import {
  chargeSettlementText,
  collegeLedgerAmountText,
  formatMoney,
  isCollegePaymentEntryFor,
  paymentReceiptNo,
  pickReceiptEntry,
  structureEffectiveAt,
  structureRateText,
} from "@/lib/college-fees-view";

/**
 * College support (Phase 7d) — the college FEE RECEIPT print page
 * (docs/COLLEGE-DECISIONS.md §24.5, D-7-17).
 *
 * `src/app/print/college-fee-receipt/[chargeId]` — the paper a family is handed
 * for **one** confirmed college payment, with `?receipt=CRCP-…` selecting which
 * one when a charge has been paid in instalments (without it, the charge's newest
 * confirmed payment is printed). A SERVER component that renders live rows, like
 * the school's `admission-receipt`: no PDF archival, no frozen copy.
 *
 * **A receipt is never a second payment's paper.** The payment is read from the
 * shared ledger by the ONE tag (`feeId: null` + `meta.collegeFeeId`, D-7-12), and
 * when the caller asks for a receipt number this charge does not hold, the page
 * prints nothing rather than a different payment under that number.
 *
 * **Honest about the whole charge (D-7-17).** The receipt carries the charge's own
 * billed amount, what this payment collected, what the charge still owes, the
 * head's label the admin chose, and the structure row that priced it with its
 * effective date — so one payment is never mistaken for a settled charge.
 *
 * **Authorization**, the same chain as the statement page: session; the charge's
 * tenant (a foreign id is NOT FOUND, never a 403 oracle); the caller's branch;
 * one of the v1 READ roles (`canReadCollegeFees`, D-7-18 — a TEACHER, GUARDIAN or
 * STUDENT renders nothing); and a college-capable tenant (`collegeGateDecision`).
 */

export const metadata: Metadata = { title: "College Fee Receipt" };

const NOT_FOUND = <div className="p-10 text-center text-sm text-slate-500">Receipt not found.</div>;
const NO_COLLEGE = (
  <div className="p-10 text-center text-sm text-slate-500">
    This feature is available to college tenants only.
  </div>
);
const NO_ROLE = <div className="p-10 text-center text-sm text-slate-500">{COLLEGE_FEES_READ_REFUSAL}</div>;

export default async function CollegeFeeReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ chargeId: string }>;
  searchParams: Promise<{ receipt?: string }>;
}) {
  const { chargeId } = await params;
  const { receipt: receiptParam } = await searchParams;

  const session = await getSession();
  if (!session) return NOT_FOUND;

  const charge: any = await prisma.collegeFee.findUnique({ where: { id: chargeId } });
  if (!charge) return NOT_FOUND;
  if (session.role !== "SUPER_ADMIN" && charge.schoolId !== session.schoolId) return NOT_FOUND;

  const school: any = await prisma.school.findUnique({ where: { id: charge.schoolId } });
  if (collegeGateDecision(school?.institutionType) !== "ALLOW") return NO_COLLEGE;
  if (!canReadCollegeFees(session.role)) return NO_ROLE;
  if (!canAccessBranch(session, charge.branchId)) return NOT_FOUND;

  const [student, programme, config, structure, ledger] = await Promise.all([
    charge.studentId ? prisma.student.findUnique({ where: { id: String(charge.studentId) } }) : Promise.resolve(null),
    charge.programId ? prisma.program.findUnique({ where: { id: String(charge.programId) } }) : Promise.resolve(null),
    loadCollegeFeeConfig(charge.schoolId),
    loadStructure(charge.schoolId, charge.programId ?? null, charge.termNumber ?? null),
    charge.studentId
      ? prisma.ledgerEntry.findMany({ where: { schoolId: charge.schoolId, studentId: String(charge.studentId) } })
      : Promise.resolve([]),
  ]);

  // Only THIS charge's college payments — a payment on a sibling charge is not
  // this receipt (and a school row can never match the tag).
  const payments = (ledger as any[])
    .filter((e) => isCollegePaymentEntryFor(e, chargeId))
    .sort((a, b) => String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? "")));
  const picked = pickReceiptEntry(payments, receiptParam);

  if (!picked) {
    const wanted = String(receiptParam ?? "").trim();
    return (
      <div className="p-10 text-center text-sm text-slate-500">
        {wanted
          ? `No confirmed college payment on this charge carries the receipt number ${wanted}.`
          : "No confirmed college payment has been recorded on this charge yet."}
      </div>
    );
  }

  const entry: any = picked.entry;
  const actor: any = entry.actorId ? await prisma.user.findUnique({ where: { id: String(entry.actorId) } }) : null;
  const rate = (structure as any[]).find((r) => String(r.headId) === String(charge.headId)) || null;
  const rateWhen = structureEffectiveAt(rate);
  const currency = config.currency;
  const printDate = fmtDate(new Date());
  const receiptNo = paymentReceiptNo(entry) || "—";
  const termLabel = programme?.termSystem
    ? collegeTermLabel(Number(charge.termNumber) || 1, programme.termSystem)
    : `Term ${Number(charge.termNumber) || 1}`;

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-2xl">
        <div className="no-print mb-4 flex items-center justify-between">
          <Link href="/dashboard/college-fees?tab=dues" className="btn btn-secondary btn-sm">
            ← College Fees
          </Link>
          <PrintActions
            targetId="college-fee-receipt"
            fileName={`CollegeFeeReceipt-${receiptNo.replace(/[^A-Za-z0-9-]/g, "")}`}
          />
        </div>

        <div id="college-fee-receipt" className="print-card overflow-hidden rounded-2xl bg-white shadow-2xl">
          <div className="border-b-4 border-indigo-600 bg-slate-900 px-8 py-6 text-center text-white">
            <div className="text-xl font-black tracking-tight">{school?.name || "College"}</div>
            {school?.tagline && <div className="text-xs text-slate-300">{school.tagline}</div>}
            <div className="mt-1 text-[11px] text-slate-400">
              {[school?.address, school?.phone].filter(Boolean).join(" · ")}
            </div>
            <div className="mx-auto mt-3 inline-block rounded-full bg-indigo-600 px-4 py-1 text-xs font-extrabold uppercase tracking-widest">
              College Fee Receipt
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-3 px-8 py-5 text-xs sm:grid-cols-3">
            {[
              ["Receipt no", receiptNo],
              ["Date", fmtDate(entry.createdAt)],
              ["Method", entry.method || "—"],
              ["Student", (student as any)?.name || "—"],
              ["Admission No", (student as any)?.admissionNo || "—"],
              ["Programme", (programme as any)?.name || "—"],
              ["Term", termLabel],
              ["Received by", actor?.name || "—"],
              ["Reference", entry.refNo || "—"],
            ].map(([k, v]) => (
              <div key={String(k)} className="border-b border-slate-100 pb-1.5">
                <div className="font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                <div className="mt-0.5 font-bold text-slate-800">{String(v)}</div>
              </div>
            ))}
          </div>

          <div className="px-8">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-indigo-50 text-[10px] uppercase tracking-wider text-indigo-700">
                  <th className="rounded-l-lg px-3 py-2 text-left font-bold">Particulars</th>
                  <th className="rounded-r-lg px-3 py-2 text-right font-bold">Amount</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-b border-slate-100">
                  <td className="px-3 py-2.5 font-semibold text-slate-700">
                    {charge.headName || "College charge"}
                    <span className="block text-[11px] font-normal text-slate-500">{charge.title || "—"}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right font-bold text-slate-800">
                    {formatMoney(charge.amount, currency)}
                  </td>
                </tr>
                {Number(charge.discount) > 0 && (
                  <tr className="border-b border-slate-100">
                    <td className="px-3 py-2.5 text-slate-600">Waived / discounted on this charge</td>
                    <td className="px-3 py-2.5 text-right font-bold text-rose-600">
                      − {formatMoney(charge.discount, currency)}
                    </td>
                  </tr>
                )}
                <tr className="border-b border-slate-100 bg-emerald-50">
                  <td className="px-3 py-2.5 font-black text-emerald-800">Received — this receipt</td>
                  <td className="px-3 py-2.5 text-right font-black text-emerald-800">
                    {collegeLedgerAmountText(entry) ?? formatMoney(entry.amount, currency)}
                  </td>
                </tr>
                <tr className="border-b border-slate-100">
                  <td className="px-3 py-2.5 text-slate-600">Paid on this charge to date</td>
                  <td className="px-3 py-2.5 text-right font-bold text-slate-700">
                    {formatMoney(charge.paidAmount, currency)}
                  </td>
                </tr>
                <tr>
                  <td className="px-3 py-2.5 font-semibold text-slate-700">Charge status at print time</td>
                  <td className="px-3 py-2.5 text-right font-bold text-slate-800">
                    {chargeSettlementText(charge as any, currency)}
                  </td>
                </tr>
              </tbody>
            </table>

            {rate && (
              <p className="mt-3 text-[10px] text-slate-400">
                Rate used: {rate.headName || charge.headName || rate.headId} — {structureRateText(rate, currency)}
                {rateWhen ? ` since ${fmtDate(rateWhen)}` : ""} · charge {charge.id}
              </p>
            )}

            <div className="mt-4 rounded-xl bg-slate-50 p-4 text-[11px] leading-relaxed text-slate-500">
              <p className="font-bold text-slate-600">What this paper covers</p>
              <p className="mt-1">
                ONE confirmed college payment against the charge named above. A charge paid in instalments has one
                receipt per payment{receiptNo !== "—" ? ` — this is ${receiptNo}` : ""}
                ; the figures shown are the charge&apos;s own, read at print time, and the amount received is the ledger
                entry this receipt was written from.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-end justify-between gap-6 px-8 py-8">
            <div className="flex gap-12 text-center text-[10px] font-semibold text-slate-400">
              <div>
                <div className="mb-8 border-b border-slate-300 px-6" />
                Payer
              </div>
              <div>
                <div className="mb-8 border-b border-slate-300 px-6" />
                Received by (accounts office)
              </div>
            </div>
          </div>

          <div className="border-t border-slate-100 px-8 py-3 text-center text-[10px] text-slate-400">
            Computer-generated receipt · printed {printDate} · {school?.name || ""} · receipt sequence{" "}
            {receiptNo.startsWith("CRCP-") ? "CRCP (college)" : "college"}
          </div>
        </div>
      </div>
    </div>
  );
}
