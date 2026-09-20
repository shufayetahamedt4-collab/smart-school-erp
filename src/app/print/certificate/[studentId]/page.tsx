"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Stamp } from "lucide-react";
import { api } from "@/lib/client";
import { PrintActions } from "@/components/PrintActions";
import { LoadingScreen } from "@/components/ui";
import { fmtDate } from "@/lib/utils";

/**
 * PRD §9.2 — printable Transfer Certificate (TC) / Character Certificate.
 * Data comes from GET /api/certificates?studentId=&type=; layout is A4
 * print-ready with serial number, seal space and signature lines.
 * Toggle the ?type= TC|CHARACTER via the switcher below (re-fetches).
 */

interface CertData {
  type: "TC" | "CHARACTER";
  serial: string;
  generatedAt: string;
  student: {
    name: string; nameBn: string | null; admissionNo: string; dob: string | null;
    guardianName: string | null; className: string | null; section: string | null;
    admissionDate: string | null; leavingDate: string | null; conduct: string | null;
    previousSchoolName: string | null;
  };
  school: { name: string; address?: string | null; phone?: string | null; email?: string | null; logoUrl?: string | null };
}

export default function CertificatePrintPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = use(params);
  const [type, setType] = useState<"TC" | "CHARACTER">("TC");
  const [data, setData] = useState<CertData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    api<CertData>(`/api/certificates?studentId=${studentId}&type=${type}`)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [studentId, type]);

  if (loading) return <LoadingScreen label="Preparing certificate…" />;
  if (error) return <div className="p-10 text-center text-sm text-slate-500">{error}</div>;
  if (!data) return <div className="p-10 text-center text-sm text-slate-500">Certificate not found.</div>;

  const { student: st, school } = data;
  const isTC = data.type === "TC";
  const isBengali = /[\u0980-\u09FF]/.test(st.name || "");

  return (
    <div className="mx-auto max-w-3xl bg-white p-6 text-slate-800 print:p-0">
      <div className="print:hidden">
        <div className="mb-4 flex items-center justify-between">
          <Link href={`/dashboard/students/${studentId}`} className="btn btn-secondary btn-sm"><ArrowLeft size={14} /> Back to student</Link>
          <div className="flex overflow-hidden rounded-xl border border-slate-200">
            {(["TC", "CHARACTER"] as const).map((t) => (
              <button key={t} onClick={() => setType(t)}
                className={`px-4 py-2 text-xs font-bold transition ${type === t ? "brand-bg text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}>
                {t === "TC" ? "Transfer Certificate" : "Character Certificate"}
              </button>
            ))}
          </div>
        </div>
        <PrintActions targetId="certificate-print" fileName={`certificate-${st.admissionNo}-${data.type.toLowerCase()}`} />
      </div>

      <div id="certificate-print" className="relative border-8 border-double border-slate-800 p-10">
        {/* watermark seal space */}
        <div className="pointer-events-none absolute right-8 top-8 flex h-28 w-28 items-center justify-center rounded-full border-4 border-dashed border-slate-200 print:hidden">
          <Stamp size={40} className="text-slate-200" />
        </div>

        {/* header */}
        <div className="flex items-center gap-4 border-b-2 border-slate-800 pb-5 text-center sm:text-left">
          {school.logoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={school.logoUrl} alt="" className="h-16 w-16 rounded-full object-contain" />
          ) : (
            <div className="flex h-16 w-16 items-center justify-center rounded-full bg-slate-800 text-2xl font-black text-white">
              {school.name.slice(0, 1)}
            </div>
          )}
          <div className="flex-1 text-center">
            <h1 className="text-2xl font-black tracking-tight">{school.name}</h1>
            <div className="text-xs text-slate-500">{school.address || ""}</div>
            <div className="text-[11px] text-slate-400">{school.phone || ""}{school.email ? ` · ${school.email}` : ""}</div>
          </div>
        </div>

        <div className="mt-6 text-center">
          <h2 className="inline-block border-y-2 border-slate-800 px-6 py-1.5 text-xl font-black uppercase tracking-[0.25em]">
            {isTC ? "Transfer Certificate" : "Character Certificate"}
          </h2>
          <div className="mt-2 font-mono text-xs font-bold text-slate-500">Serial No: {data.serial}</div>
        </div>

        {/* body */}
        <div className="mt-8 space-y-5 text-[15px] leading-8">
          {isTC ? (
            <p>
              This is to certify that <b>{st.name}</b>
              {st.nameBn ? <span className="text-slate-600"> ({st.nameBn})</span> : null}
              , son/daughter of <b>{st.guardianName || "—"}</b>, was a bona fide student of this school
              {st.className ? <> in <b>{st.className}</b>{st.section ? ` (Section ${st.section})` : ""}</> : null}.
              {st.previousSchoolName ? <> The student was admitted from <b>{st.previousSchoolName}</b>.</> : null}
              The student studied in this institution from <b>{fmtDate(st.admissionDate)}</b> to <b>{fmtDate(st.leavingDate) || "the date of issue"}</b>
              {st.dob ? <> and was born on <b>{fmtDate(st.dob)}</b>{isBengali ? "" : " as per school records"}</> : null}.
              All dues have been cleared and the student has no outstanding liabilities. We wish the student every success in future endeavors.
            </p>
          ) : (
            <p>
              This is to certify that <b>{st.name}</b>
              {st.nameBn ? <span className="text-slate-600"> ({st.nameBn})</span> : null}
              , son/daughter of <b>{st.guardianName || "—"}</b>, bearing admission number <b>{st.admissionNo}</b>,
              {st.className ? <> of <b>{st.className}</b>{st.section ? ` (Section ${st.section})` : ""},</> : null}
              is a student of this school. During the period of study the student's conduct was found to be
              <b> {st.conduct || "Good"}</b> and character is deemed excellent.
              {st.dob ? <> As per school records, the student was born on <b>{fmtDate(st.dob)}</b>.</> : null}
              We wish the student every success in life.
            </p>
          )}
        </div>

        {/* signatures */}
        <div className="mt-16 flex items-end justify-between">
          <div className="text-center">
            <div className="h-12 w-40 border-b border-slate-400" />
            <div className="mt-1 text-[10px] uppercase tracking-widest text-slate-400">Class teacher</div>
          </div>
          <div className="flex h-24 w-24 items-center justify-center rounded-full border-2 border-dashed text-center text-[9px] font-bold uppercase tracking-widest text-slate-300">
            School seal
          </div>
          <div className="text-center">
            <div className="h-12 w-40 border-b border-slate-400" />
            <div className="mt-1 text-[10px] uppercase tracking-widest text-slate-400">Principal</div>
          </div>
        </div>

        <div className="mt-8 border-t border-slate-100 pt-3 text-center text-[10px] text-slate-400">
          Issued on {fmtDate(data.generatedAt, true)} · Generated by Amar E School (PRD §9.2) · {data.serial}
        </div>
      </div>
    </div>
  );
}
