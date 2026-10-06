import QRCode from "qrcode";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { can, isBranchScoped } from "@/lib/permissions";
import { qrUrl } from "@/lib/qr";
import { PrintActions } from "@/components/PrintActions";

/**
 * Printable guardian-access slips for one import batch.
 *
 * One slip per student this batch created whose guardian account was newly
 * provisioned (QR/PIN credential). Staff-only and school-scoped: a missing or
 * foreign batch, a rolled-back import, or a non-admission role renders the same
 * safe "not found" markup. Reused guardians and rows with no usable contact are
 * never included. No password is ever shown.
 */

const NOT_FOUND = <div className="p-10 text-center text-sm text-slate-500">Import batch not found.</div>;

export default async function GuardianCredentialsPage({ params }: { params: Promise<{ batchId: string }> }) {
  const { batchId } = await params;
  const session = await getSession();
  if (!session) return NOT_FOUND;
  if (!can(session.role, "admission", "view")) return NOT_FOUND;

  const batch = await prisma.importBatch.findUnique({ where: { id: batchId } }).catch(() => null);
  if (!batch) return NOT_FOUND;
  if (session.role !== "SUPER_ADMIN" && batch.schoolId !== session.schoolId) return NOT_FOUND;
  // Branch scoping: a branch admin can only print its own branch's slips.
  if (isBranchScoped(session) && batch.branchId !== session.branchId) return NOT_FOUND;

  const schoolId = batch.schoolId;
  const rows =
    batch.status === "UNDONE"
      ? []
      : (await prisma.importBatchRow.findMany({ where: { batchId } }))
          .filter((r: any) => r.schoolId === schoolId && r.status === "OK" && r.studentId)
          .sort((a: any, b: any) => Number(a.rowNumber) - Number(b.rowNumber));

  const studentIds = new Set(rows.map((r: any) => String(r.studentId)));

  const [students, classes, sections] = await Promise.all([
    studentIds.size ? prisma.student.findMany({ where: { schoolId } }) : Promise.resolve([]),
    prisma.classRoom.findMany({ where: { schoolId }, select: { id: true, name: true } }),
    prisma.section.findMany({ where: { schoolId }, select: { id: true, name: true } }),
  ]);

  const classById = new Map((classes as any[]).map((c) => [String(c.id), c.name]));
  const sectionById = new Map((sections as any[]).map((s) => [String(s.id), s.name]));

  const slips = (students as any[])
    .filter((s) => studentIds.has(String(s.id)) && s.guardianOnboarding === "CREDENTIALS_READY" && s.qrToken && s.qrPin)
    .sort((a, b) => String(a.admissionNo || "").localeCompare(String(b.admissionNo || "")));

  const withQr = await Promise.all(
    slips.map(async (s) => ({
      ...s,
      qr: await QRCode.toDataURL(qrUrl(s.qrToken), { width: 220, margin: 1, color: { dark: "#0f172a" } }),
      className: s.classId ? classById.get(String(s.classId)) || null : null,
      sectionName: s.sectionId ? sectionById.get(String(s.sectionId)) || null : null,
    }))
  );

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-3xl">
        <div className="no-print mb-4 flex items-center justify-between">
          <Link href={`/dashboard/students/import/${batchId}`} className="btn btn-secondary btn-sm">← Import result</Link>
          {withQr.length > 0 && <PrintActions targetId="guardian-credentials" fileName={`Guardian-Access-${batchId}`} />}
        </div>

        <div className="no-print mb-4 rounded-xl border border-indigo-100 bg-indigo-50 p-4 text-xs text-indigo-800">
          <p className="font-bold uppercase tracking-wide">Guardian access slips — {withQr.length} new guardian account(s)</p>
          <p className="mt-1">Hand each slip to the family. The guardian scans the QR (or opens the link) and enters the PIN to sign in to the Guardian Portal. No password is shown. Reused guardian accounts are not included.</p>
        </div>

        {withQr.length === 0 ? (
          <div className="rounded-xl bg-white p-10 text-center text-sm text-slate-500">
            No new guardian credentials to hand over for this import.
          </div>
        ) : (
          <div id="guardian-credentials" className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {withQr.map((s) => (
              <div key={s.id} className="print-card overflow-hidden rounded-2xl bg-white shadow">
                <div className="flex items-center justify-between bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-3 text-white">
                  <div className="text-sm font-extrabold leading-tight">{batch.fileName || "Bulk import"}</div>
                  <span className="rounded-full bg-white/20 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider">Guardian access</span>
                </div>
                <div className="flex gap-4 p-4">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={s.qr} alt={`QR for ${s.name}`} className="h-28 w-28 shrink-0 rounded-lg ring-1 ring-slate-200" />
                  <div className="min-w-0 text-xs">
                    <div className="truncate text-sm font-black text-slate-900">{s.name || "—"}</div>
                    <div className="mt-0.5 text-slate-500">Adm. No {s.admissionNo || "—"}</div>
                    <div className="text-slate-500">
                      {s.className || "—"}{s.sectionName ? ` / ${s.sectionName}` : ""}
                    </div>
                    <div className="mt-1 truncate text-slate-600">Guardian: {s.guardianName || "—"}</div>
                    <div className="mt-2 rounded-lg bg-violet-50 px-2 py-1.5">
                      <div className="text-[10px] font-bold uppercase tracking-wide text-violet-600">QR PIN</div>
                      <div className="text-xl font-black tracking-widest text-violet-800">{s.qrPin}</div>
                    </div>
                  </div>
                </div>
                <div className="border-t border-slate-100 px-4 py-2 text-[10px] text-slate-500">
                  Scan the QR or open the link and enter the PIN to access the Guardian Portal.
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
