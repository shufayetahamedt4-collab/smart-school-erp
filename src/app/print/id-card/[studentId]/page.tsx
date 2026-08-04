import QRCode from "qrcode";
import Link from "next/link";
import { prisma } from "@/lib/db";
import { qrUrl } from "@/lib/qr";
import { initials, classOf } from "@/lib/utils";
import { PrintActions } from "@/components/PrintActions";

export default async function IdCardPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: {
      school: { select: { id: true, name: true, logoUrl: true, tagline: true, address: true, phone: true, email: true } },
      classRoom: { select: { name: true } },
      section: { select: { name: true } },
    },
  });

  if (!student) {
    return <div className="p-10 text-center text-sm text-slate-500">Student not found.</div>;
  }

  const qr = await QRCode.toDataURL(qrUrl(student.qrToken), { width: 260, margin: 1, color: { dark: "#0f172a" } });

  const details = [
    ["Student ID", student.admissionNo],
    ["Class", `${student.classRoom?.name || "—"}${student.section ? `, Section ${student.section.name}` : ""}`],
    ["Roll", student.roll?.toString() || "—"],
    ["Blood Group", (student.bloodGroup || "—").replace("_", "+")],
    ["Guardian", student.guardianName || "—"],
    ["Phone", student.guardianPhone || "—"],
  ];

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-2xl">
        <div className="no-print mb-4 flex items-center justify-between">
          <Link href="/dashboard/students" className="btn btn-secondary btn-sm">← Students</Link>
          <PrintActions targetId="id-card" fileName={`ID-Card-${student.admissionNo}`} />
        </div>

        <div id="id-card" className="print-card mx-auto max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl">
          {/* header */}
          <div className="flex items-center justify-between bg-gradient-to-r from-indigo-600 to-violet-600 px-5 py-4 text-white">
            <div className="flex items-center gap-3">
              {student.school.logoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={student.school.logoUrl} alt="" className="h-10 w-10 rounded-lg bg-white object-contain p-0.5" />
              ) : (
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/20 text-base font-black">
                  {classOf(student.school.name)}
                </div>
              )}
              <div>
                <div className="text-sm font-extrabold leading-tight">{student.school.name}</div>
                {student.school.tagline && <div className="text-[10px] text-indigo-100">{student.school.tagline}</div>}
              </div>
            </div>
            <span className="rounded-full bg-white/20 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider">Student ID</span>
          </div>

          {/* body */}
          <div className="flex gap-5 px-6 py-5">
            <div className="shrink-0">
              {student.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={student.photoUrl} alt={student.name} className="h-28 w-24 rounded-xl object-cover ring-2 ring-slate-200" />
              ) : (
                <div className="flex h-28 w-24 items-center justify-center rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 text-2xl font-black text-slate-400">
                  {initials(student.name)}
                </div>
              )}
            </div>
            <div className="min-w-0 flex-1">
              <div className="text-lg font-black leading-tight text-slate-900">{student.name}</div>
              <dl className="mt-3 space-y-1.5">
                {details.map(([k, v]) => (
                  <div key={k} className="flex justify-between gap-3 text-xs">
                    <dt className="shrink-0 font-semibold text-slate-400">{k}</dt>
                    <dd className="truncate font-bold text-slate-700">{v}</dd>
                  </div>
                ))}
              </dl>
            </div>
          </div>

          {/* footer with QR */}
          <div className="flex items-center gap-4 border-t border-slate-100 bg-slate-50 px-6 py-4">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr} alt="QR" className="h-20 w-20 rounded-lg bg-white p-1 ring-1 ring-slate-200" />
            <div className="text-[10px] leading-relaxed text-slate-500">
              <div className="font-bold text-slate-700">Guardian QR Login</div>
              Scan this QR code with your phone and verify with the student PIN to access the guardian dashboard — attendance, homework, results, fees &amp; more.
              <div className="mt-1.5 truncate rounded bg-white px-2 py-1 font-mono text-[9px] text-indigo-600 ring-1 ring-slate-200">
                {qrUrl(student.qrToken)}
              </div>
            </div>
          </div>

          {/* signature */}
          <div className="flex justify-between px-8 pb-5 pt-1 text-[10px] font-semibold text-slate-400">
            <div className="text-center">
              <div className="mb-6 border-b border-slate-300 px-4" />
              Guardian signature
            </div>
            <div className="text-center">
              <div className="mb-6 border-b border-slate-300 px-4" />
              Principal signature
            </div>
          </div>
        </div>

        <p className="no-print mt-4 text-center text-xs text-slate-400">
          Tip: For ID-card sheets, print multiple students from the ID Cards module under School Admin.
        </p>
      </div>
    </div>
  );
}
