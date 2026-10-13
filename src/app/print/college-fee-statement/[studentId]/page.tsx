import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import { collegeGateDecision } from "@/lib/institution";
import { COLLEGE_FEES_READ_REFUSAL, canReadCollegeFees } from "@/lib/college-fees-access";
import { loadCharges, loadCollegeFeeConfig, loadStructure } from "@/lib/college-fees-server";
import { collegeTermLabel } from "@/lib/college-fees";
import { fmtDate } from "@/lib/utils";
import { PrintActions } from "@/components/PrintActions";
import {
  chargeTotals,
  collegeLedgerAmountText,
  formatMinor,
  formatMoney,
  isCollegeLedgerEntry,
  statementTermValue,
  statementTerms,
  structureEffectiveAt,
  structureRateText,
} from "@/lib/college-fees-view";

/**
 * College support (Phase 7d) — the college FEE STATEMENT print page
 * (docs/COLLEGE-DECISIONS.md §24.5, D-7-17).
 *
 * `src/app/print/college-fee-statement/[studentId]` — one student's charges, dues
 * and payments for a term (`?term=2`) or for the whole programme (the default).
 * A SERVER component that renders live rows exactly like the school's
 * `report-card` / `marksheet` and the college transcript: no PDF archival, no
 * frozen copy, nothing cached.
 *
 * **Honest about what billed it (D-7-17).** Each term's footer names the structure
 * rows that priced it — their amount, their unit/basis and the instant they took
 * effect — so a reprint after an admin re-prices a term cannot silently disagree
 * with the paper a family already holds; the page says which rate produced the
 * numbers on it, and prints the date it was printed.
 *
 * **Authorization, all below the middleware (which cannot see the tenant shape):**
 * a session is required; the student must belong to the session's tenant (a
 * foreign id is NOT FOUND, never a 403 oracle); the caller must reach the
 * student's branch; the caller must be one of the v1 READ roles — admin-level
 * plus the ACCOUNTANT and a read-only REGISTRAR (`canReadCollegeFees`, the SAME
 * rule the API applies, so a TEACHER, GUARDIAN or STUDENT renders nothing,
 * D-7-18); and the tenant must be college-capable (`collegeGateDecision`).
 *
 * The reads are the 7c API's own loaders (`loadCharges` / `loadStructure` /
 * `loadCollegeFeeConfig`), called in-process, so a statement can never disagree
 * with `GET /api/college-fees/dues`.
 */

export const metadata: Metadata = { title: "College Fee Statement" };

const NOT_FOUND = <div className="p-10 text-center text-sm text-slate-500">Statement not found.</div>;
const NO_COLLEGE = (
  <div className="p-10 text-center text-sm text-slate-500">
    This feature is available to college tenants only.
  </div>
);
const NO_ROLE = <div className="p-10 text-center text-sm text-slate-500">{COLLEGE_FEES_READ_REFUSAL}</div>;
const EMPTY = (
  <div className="p-10 text-center text-sm text-slate-500">
    No college charges have been raised for this student yet — generate the term&apos;s charges on the College Fees
    screen first.
  </div>
);

export default async function CollegeFeeStatementPage({
  params,
  searchParams,
}: {
  params: Promise<{ studentId: string }>;
  searchParams: Promise<{ term?: string }>;
}) {
  const { studentId } = await params;
  const { term: termParam } = await searchParams;

  const session = await getSession();
  if (!session) return NOT_FOUND;

  const student: any = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) return NOT_FOUND;
  if (session.role !== "SUPER_ADMIN" && student.schoolId !== session.schoolId) return NOT_FOUND;

  const school: any = await prisma.school.findUnique({ where: { id: student.schoolId } });
  if (collegeGateDecision(school?.institutionType) !== "ALLOW") return NO_COLLEGE;
  if (!canReadCollegeFees(session.role)) return NO_ROLE;
  if (!canAccessBranch(session, student.branchId)) return NOT_FOUND;

  const programme: any = student.programId
    ? await prisma.program.findUnique({ where: { id: student.programId } })
    : null;
  const termNumber = statementTermValue(termParam);
  const config = await loadCollegeFeeConfig(student.schoolId);

  const [allCharges, structure, ledger] = await Promise.all([
    loadCharges(student.schoolId, { studentId }),
    loadStructure(student.schoolId, student.programId ?? null),
    prisma.ledgerEntry.findMany({ where: { schoolId: student.schoolId, studentId } }),
  ]);

  // A branch-scoped reader sees only its own branch's rows, exactly like the API.
  const ownCharges = allCharges.filter((c) => !c.branchId || canAccessBranch(session, c.branchId));
  const charges = termNumber ? ownCharges.filter((c) => Number(c.termNumber) === termNumber) : ownCharges;
  if (!ownCharges.length) return EMPTY;
  if (!charges.length) {
    return (
      <div className="p-10 text-center text-sm text-slate-500">
        No college charges have been raised for this student in term {termNumber}.
      </div>
    );
  }

  const groups = statementTerms(charges as any[]);
  // The student's own college payments, newest first — the same rows the charge
  // columns are paid from, read from the shared ledger by their ONE tag (Q3).
  const payments = (ledger as any[])
    .filter((e) => isCollegeLedgerEntry(e) && e.kind === "PAYMENT")
    .sort((a, b) => String(b?.createdAt ?? "").localeCompare(String(a?.createdAt ?? "")));

  const printDate = fmtDate(new Date());
  const currency = config.currency;
  const overall = chargeTotals(charges as any[]);

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-4xl">
        <div className="no-print mb-4 flex items-center justify-between">
          <Link href="/dashboard/college-fees?tab=dues" className="btn btn-secondary btn-sm">
            ← College Fees
          </Link>
          <PrintActions
            targetId="college-fee-statement"
            fileName={`CollegeFeeStatement-${student.admissionNo || student.id}${termNumber ? `-Term${termNumber}` : ""}`}
          />
        </div>

        <div id="college-fee-statement" className="print-card overflow-hidden rounded-2xl bg-white shadow-2xl">
          {/* institution header — the tenant's own name and contact, as every print page carries */}
          <div className="border-b-4 border-indigo-600 bg-slate-900 px-8 py-6 text-center text-white">
            <div className="text-xl font-black tracking-tight">{school?.name || "College"}</div>
            {school?.tagline && <div className="text-xs text-slate-300">{school.tagline}</div>}
            <div className="mt-1 text-[11px] text-slate-400">
              {[school?.address, school?.phone].filter(Boolean).join(" · ")}
            </div>
            <div className="mx-auto mt-3 inline-block rounded-full bg-indigo-600 px-4 py-1 text-xs font-extrabold uppercase tracking-widest">
              College Fee Statement
            </div>
          </div>

          {/* who, what scope, and when it was printed */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 px-8 py-5 text-xs sm:grid-cols-4">
            {[
              ["Student", student.name],
              ["Admission No", student.admissionNo || "—"],
              ["Programme", programme?.name || "—"],
              ["Enrolment term", student.termNumber ?? "—"],
              ["Scope", termNumber ? `Term ${termNumber}` : "Whole programme"],
              ["Printed", printDate],
            ].map(([k, v]) => (
              <div key={String(k)} className="border-b border-slate-100 pb-1.5">
                <div className="font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                <div className="mt-0.5 font-bold text-slate-800">{String(v)}</div>
              </div>
            ))}
            <div className="col-span-2 sm:col-span-4">
              <div className="font-semibold uppercase tracking-wide text-slate-400">Totals on this statement</div>
              <div className="mt-0.5 font-bold text-slate-800">
                {formatMinor(overall.billedMinor, currency)} billed · {formatMinor(overall.discountMinor, currency)}{" "}
                waived · {formatMinor(overall.paidMinor, currency)} paid ·{" "}
                <span className={overall.dueMinor > 0 ? "text-rose-600" : "text-emerald-700"}>
                  {formatMinor(overall.dueMinor, currency)} due
                </span>
              </div>
            </div>
          </div>

          {/* one block per term, each with its own totals and its own rate footer */}
          {groups.map((group) => {
            const label = programme?.termSystem
              ? collegeTermLabel(group.termNumber, programme.termSystem)
              : `Term ${group.termNumber}`;
            // The structure rows that priced THIS term's charges, so the paper
            // names its own rates (D-7-17).
            const rates = structure
              .filter((r) => Number(r.termNumber) === group.termNumber)
              .filter((r) => group.rows.some((c: any) => String(c.headId) === String(r.headId)));
            return (
              <div key={group.termNumber} className="px-8 py-4">
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-sm font-black text-slate-800">{label}</span>
                  <span className="text-xs font-semibold text-slate-500">
                    {group.totals.count} charge(s) ·{" "}
                    <span className="font-black text-slate-700">{formatMinor(group.totals.dueMinor, currency)} due</span>
                  </span>
                </div>
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-indigo-50 text-[10px] uppercase tracking-wider text-indigo-700">
                      <th className="rounded-l-lg px-3 py-2 text-left font-bold">Head</th>
                      <th className="px-3 py-2 text-left font-bold">Charge</th>
                      <th className="px-3 py-2 text-center font-bold">Due date</th>
                      <th className="px-3 py-2 text-right font-bold">Amount</th>
                      <th className="px-3 py-2 text-right font-bold">Waived</th>
                      <th className="px-3 py-2 text-right font-bold">Paid</th>
                      <th className="rounded-r-lg px-3 py-2 text-right font-bold">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.rows.map((charge: any) => (
                      <tr key={charge.id} className="border-b border-slate-100">
                        <td className="px-3 py-2.5 font-semibold text-slate-700">{charge.headName || "—"}</td>
                        <td className="px-3 py-2.5 text-slate-600">
                          {charge.title || "—"}
                          {charge.status && (
                            <span className="ml-2 rounded-md bg-slate-100 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-slate-500">
                              {String(charge.status).toLowerCase()}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-center text-[11px] text-slate-500">
                          {charge.dueDate ? fmtDate(charge.dueDate) : "—"}
                        </td>
                        <td className="px-3 py-2.5 text-right font-semibold text-slate-700">
                          {formatMoney(charge.amount, currency)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-xs text-amber-700">
                          {formatMoney(charge.discount, currency)}
                        </td>
                        <td className="px-3 py-2.5 text-right text-xs text-emerald-700">
                          {formatMoney(charge.paidAmount, currency)}
                        </td>
                        <td className="px-3 py-2.5 text-right font-bold text-slate-800">
                          {formatMoney(charge.due, currency)}
                        </td>
                      </tr>
                    ))}
                    <tr className="bg-slate-50 font-black text-slate-900">
                      <td className="px-3 py-2.5" colSpan={3}>
                        Term total
                      </td>
                      <td className="px-3 py-2.5 text-right">{formatMinor(group.totals.billedMinor, currency)}</td>
                      <td className="px-3 py-2.5 text-right">{formatMinor(group.totals.discountMinor, currency)}</td>
                      <td className="px-3 py-2.5 text-right">{formatMinor(group.totals.paidMinor, currency)}</td>
                      <td className="px-3 py-2.5 text-right">{formatMinor(group.totals.dueMinor, currency)}</td>
                    </tr>
                  </tbody>
                </table>
                {rates.length > 0 && (
                  <p className="mt-2 text-[10px] text-slate-400">
                    Rates used:{" "}
                    {rates
                      .map((r) => {
                        const when = structureEffectiveAt(r);
                        return `${r.headName || r.headId} — ${structureRateText(r, currency)}${
                          when ? ` since ${fmtDate(when)}` : ""
                        }`;
                      })
                      .join(" · ")}
                  </p>
                )}
              </div>
            );
          })}

          {/* the payments the charges above are paid from — one line per receipt */}
          <div className="px-8 py-4">
            <div className="mb-2 text-sm font-black text-slate-800">Payments received</div>
            {payments.length ? (
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-emerald-50 text-[10px] uppercase tracking-wider text-emerald-700">
                    <th className="rounded-l-lg px-3 py-2 text-left font-bold">Receipt no</th>
                    <th className="px-3 py-2 text-left font-bold">Date</th>
                    <th className="px-3 py-2 text-left font-bold">Method</th>
                    <th className="px-3 py-2 text-left font-bold">Reference</th>
                    <th className="rounded-r-lg px-3 py-2 text-right font-bold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((entry: any) => (
                    <tr key={entry.id} className="border-b border-slate-100">
                      <td className="px-3 py-2.5 font-semibold text-slate-700">
                        {String((entry.meta || {}).receiptNo || "—")}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-slate-500">{fmtDate(entry.createdAt)}</td>
                      <td className="px-3 py-2.5 text-xs text-slate-600">{entry.method || "—"}</td>
                      <td className="px-3 py-2.5 text-[11px] text-slate-400">{entry.refNo || "—"}</td>
                      <td className="px-3 py-2.5 text-right font-bold text-emerald-700">
                        {collegeLedgerAmountText(entry) ?? formatMoney(entry.amount, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-xs text-slate-400">No college payment has been recorded for this student yet.</p>
            )}
          </div>

          <div className="border-t border-slate-100 px-8 py-3 text-center text-[10px] text-slate-400">
            Computer-generated statement · printed {printDate} · every figure is read from the live rows at print time,
            and each term names the rate that billed it.
          </div>
        </div>
      </div>
    </div>
  );
}
