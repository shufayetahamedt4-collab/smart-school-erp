import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { fmtDate, fmtMoney } from "@/lib/utils";
import { PrintActions } from "@/components/PrintActions";

const NOT_FOUND = <div className="p-10 text-center text-sm text-slate-500">Receipt not found.</div>;

/**
 * PRD §10.1 — the paper the desk hands over when admission money changes hands.
 *
 * Reads the admission, its fee, the payment against it, any discount and the kit
 * handed out at the time, so one page answers "what did we take and what did they
 * get". Only subscription invoices were printable before this; a walk-in that pays
 * ৳5,000 in cash needs a receipt of its own.
 */
export default async function AdmissionReceiptPage({ params }: { params: Promise<{ admissionId: string }> }) {
  const { admissionId } = await params;
  const session = await getSession();
  if (!session) return NOT_FOUND;

  const admission = await prisma.admission.findUnique({ where: { id: admissionId } });
  if (!admission) return NOT_FOUND;
  if (session.role !== "SUPER_ADMIN" && admission.schoolId !== session.schoolId) return NOT_FOUND;

  const studentId = (admission as any).convertedStudentId as string | null;

  // A guardian may fetch their own child's receipt; staff need the admission module.
  if (session.role === "GUARDIAN") {
    const child = studentId ? await prisma.student.findUnique({ where: { id: studentId } }) : null;
    if (!child || child.guardianUserId !== session.id) return NOT_FOUND;
  } else if (!can(session.role, "admission", "view") && !can(session.role, "admission", "entry") && !can(session.role, "admission", "full")) {
    return NOT_FOUND;
  }

  const [school, classRoom, fees, payments, issues, discounts] = await Promise.all([
    prisma.school.findUnique({ where: { id: admission.schoolId } }),
    (admission as any).classId ? prisma.classRoom.findUnique({ where: { id: (admission as any).classId } }) : Promise.resolve(null),
    studentId ? prisma.fee.findMany({ where: { studentId } }) : Promise.resolve([]),
    studentId ? prisma.payment.findMany({ where: { studentId } }) : Promise.resolve([]),
    studentId ? prisma.bookIssue.findMany({ where: { studentId }, include: { book: { select: { title: true, type: true } } } }) : Promise.resolve([]),
    prisma.discount.findMany({ where: { OR: [{ admissionId }, ...(studentId ? [{ studentId }] : [])] } }),
  ]);

  const admissionFee = fees.find((f: any) => f.feeType === "ADMISSION") || null;
  const paid = admissionFee ? payments.filter((p: any) => p.feeId === admissionFee.id) : [];
  const collected = paid.reduce((sum: number, p: any) => sum + Number(p.amount || 0), 0);
  const admissionFeeAmount = Number((admission as any).admissionFee || admissionFee?.amount || 0);
  const approved = discounts.filter((d: any) => d.status === "APPROVED");
  const discountTotal = approved.reduce((sum: number, d: any) => sum + Number(d.amount || 0), 0);
  const payable = Math.max(0, admissionFeeAmount - discountTotal);
  const due = Math.max(0, payable - collected);
  const receiptNo = paid[0]?.receiptNo || null;
  const uniformSize = (admission as any).uniformSize as string | null;

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-2xl">
        <div className="no-print mb-4 flex items-center justify-between">
          <Link href="/dashboard/admissions" className="btn btn-secondary btn-sm">← Admissions</Link>
          <PrintActions targetId="admission-receipt" fileName={`AdmissionReceipt-${(admission as any).admissionNo || admission.id}`} />
        </div>

        <div id="admission-receipt" className="print-card overflow-hidden rounded-2xl bg-white shadow-2xl">
          {/* school header */}
          <div className="border-b-4 border-indigo-600 bg-slate-900 px-8 py-6 text-center text-white">
            <div className="text-xl font-black tracking-tight">{school?.name || "School"}</div>
            {school?.tagline && <div className="text-xs text-slate-300">{school.tagline}</div>}
            <div className="mt-1 text-[11px] text-slate-400">
              {[school?.address, school?.phone].filter(Boolean).join(" · ")}
            </div>
            <div className="mx-auto mt-3 inline-block rounded-full bg-indigo-600 px-4 py-1 text-xs font-extrabold uppercase tracking-widest">
              Admission Receipt
            </div>
          </div>

          {/* who + what */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-3 px-8 py-5 text-xs sm:grid-cols-3">
            {[
              ["Receipt no", receiptNo || "— not collected —"],
              ["Date", fmtDate(paid[0]?.date || (admission as any).createdAt)],
              ["Admission no", (admission as any).admissionNo || "—"],
              ["Student", admission.fullName],
              ["Class", classRoom ? classRoom.name : "—"],
              ["Guardian", `${admission.guardianName || "—"}${admission.guardianPhone ? ` · ${admission.guardianPhone}` : ""}`],
            ].map(([k, v]) => (
              <div key={k} className="border-b border-slate-100 pb-1.5">
                <div className="font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                <div className="mt-0.5 font-bold text-slate-800">{v}</div>
              </div>
            ))}
          </div>

          {/* money */}
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
                  <td className="px-3 py-2.5 font-semibold text-slate-700">Admission fee</td>
                  <td className="px-3 py-2.5 text-right font-bold text-slate-800">{fmtMoney(admissionFeeAmount)}</td>
                </tr>
                {approved.map((d: any) => (
                  <tr key={d.id} className="border-b border-slate-100">
                    <td className="px-3 py-2.5 text-slate-600">
                      {String(d.reason).replace(/_/g, " ").toLowerCase()} discount
                      {d.type === "PERCENT" ? ` (${d.originalValue}%)` : ""}
                      {d.status !== "APPROVED" ? <span className="ml-1 text-amber-600">— proposed</span> : null}
                    </td>
                    <td className="px-3 py-2.5 text-right font-bold text-rose-600">− {fmtMoney(d.amount)}</td>
                  </tr>
                ))}
                <tr className="border-b border-slate-100 bg-slate-50 font-black text-slate-900">
                  <td className="px-3 py-2.5">Payable</td>
                  <td className="px-3 py-2.5 text-right">{fmtMoney(payable)}</td>
                </tr>
                <tr className="border-b border-slate-100">
                  <td className="px-3 py-2.5 font-semibold text-emerald-700">
                    Received {paid.length ? `· ${paid.map((p: any) => p.method).join(", ")}` : ""}
                  </td>
                  <td className="px-3 py-2.5 text-right font-bold text-emerald-700">{fmtMoney(collected)}</td>
                </tr>
                {due > 0 && (
                  <tr className="font-bold text-rose-600">
                    <td className="px-3 py-2.5">Still due</td>
                    <td className="px-3 py-2.5 text-right">{fmtMoney(due)}</td>
                  </tr>
                )}
              </tbody>
            </table>
            {discounts.some((d: any) => d.status !== "APPROVED") && (
              <p className="mt-2 text-[10px] text-amber-600">
                A proposed discount does not reduce what is collected today — it applies once an admin approves it.
              </p>
            )}
          </div>

          {/* kit + other fees */}
          <div className="mx-8 mt-5 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl bg-slate-50 p-4">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Handed over</div>
              {issues.length ? (
                <ul className="mt-1.5 space-y-0.5 text-xs text-slate-700">
                  {issues.map((i: any) => (
                    <li key={i.id} className="flex justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate">{i.book?.title || i.bookId}</span>
                      <span className="shrink-0 text-[10px] font-semibold uppercase text-slate-400">{i.book?.type || ""}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-1.5 text-xs text-slate-400">No books or kit issued.</p>
              )}
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
                {uniformSize && <span>Uniform: {uniformSize}</span>}
                <span>ID card: {(admission as any).idCardIssued ? "issued" : "not yet"}</span>
              </div>
              {Array.isArray((admission as any).pendingKit) && (admission as any).pendingKit.length > 0 && (
                <p className="mt-2 text-[10px] font-semibold text-amber-600">
                  To hand over later: {(admission as any).pendingKit.join(", ")}
                </p>
              )}
            </div>
            <div className="rounded-xl bg-slate-50 p-4">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Other fees raised</div>
              <ul className="mt-1.5 space-y-0.5 text-xs text-slate-700">
                {fees
                  .filter((f: any) => f.feeType !== "ADMISSION")
                  .map((f: any) => (
                    <li key={f.id} className="flex justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate">{f.title}</span>
                      <span className="shrink-0 font-semibold">{fmtMoney(f.amount)}</span>
                    </li>
                  ))}
                {!fees.some((f: any) => f.feeType !== "ADMISSION") && <li className="text-slate-400">None.</li>}
              </ul>
            </div>
          </div>

          {/* signatures */}
          <div className="flex flex-wrap items-end justify-between gap-6 px-8 py-8">
            <p className="max-w-xs text-[10px] text-slate-400">
              This receipt covers the amount shown above. Keep it — it is the proof of the admission payment and of the
              items handed over on the same day.
            </p>
            <div className="flex gap-12 text-center text-[10px] font-semibold text-slate-400">
              <div>
                <div className="mb-8 border-b border-slate-300 px-6" />
                Guardian
              </div>
              <div>
                <div className="mb-8 border-b border-slate-300 px-6" />
                Received by (front desk)
              </div>
            </div>
          </div>

          <div className="border-t border-slate-100 px-8 py-3 text-center text-[10px] text-slate-400">
            Computer-generated receipt · {fmtDate(new Date())} · {school?.name || ""}
          </div>
        </div>
      </div>
    </div>
  );
}
