"use client";

import { use, useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { api } from "@/lib/client";
import { PrintActions } from "@/components/PrintActions";
import { CertificateDocument } from "@/components/CertificateDocument";
import { LoadingScreen } from "@/components/ui";
import type { CertDesign, CertValues } from "@/lib/certificate";

/**
 * PRD §9.2 — printable Transfer / Character Certificate.
 * Renders through the shared CertificateDocument so the output is pixel
 * identical to the template editor's live preview: the school's default
 * custom template is used when one exists, otherwise the built-in design.
 */

interface CertResponse {
  type: "TC" | "CHARACTER";
  serial: string;
  generatedAt: string;
  useBuiltIn: boolean;
  templateName: string | null;
  template: {
    id: string; name: string; isDefault: boolean;
    bodyEn: string | null; bodyBn: string | null; design: CertDesign | null;
  } | null;
  values: CertValues;
  student: { name: string; admissionNo: string };
  school: { name: string; address?: string | null; phone?: string | null; email?: string | null; logoUrl?: string | null };
}

export default function CertificatePrintPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = use(params);
  const [type, setType] = useState<"TC" | "CHARACTER">("TC");
  const [lang, setLang] = useState<"en" | "bn">("en");
  const [data, setData] = useState<CertResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    setLoading(true);
    api<CertResponse>(`/api/certificates?studentId=${studentId}&type=${type}`)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [studentId, type]);

  if (loading) return <LoadingScreen label="Preparing certificate…" />;
  if (error) return <div className="p-10 text-center text-sm text-slate-500">{error}</div>;
  if (!data) return <div className="p-10 text-center text-sm text-slate-500">Certificate not found.</div>;

  const landscape = (data.template?.design?.orientation || "portrait") === "landscape";

  return (
    <div className="mx-auto max-w-4xl bg-white p-4 text-slate-800 print:max-w-none print:p-0">
      {/* @page size hint so the print dialog defaults to the template's orientation */}
      <style>{landscape ? "@page { size: A4 landscape; }" : "@page { size: A4 portrait; }"}</style>

      <div className="no-print mb-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Link href={`/dashboard/students/${studentId}`} className="btn btn-secondary btn-sm">
            <ArrowLeft size={14} /> Back to student
          </Link>
          <div className="flex items-center gap-2">
            <div className="flex overflow-hidden rounded-xl border border-slate-200">
              {(["TC", "CHARACTER"] as const).map((t) => (
                <button key={t} onClick={() => setType(t)}
                  className={`px-4 py-2 text-xs font-bold transition ${type === t ? "brand-bg text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}>
                  {t === "TC" ? "Transfer Certificate" : "Character Certificate"}
                </button>
              ))}
            </div>
            <div className="flex overflow-hidden rounded-xl border border-slate-200">
              {(["en", "bn"] as const).map((l) => (
                <button key={l} onClick={() => setLang(l)}
                  className={`px-3 py-2 text-xs font-bold transition ${lang === l ? "brand-bg text-white" : "bg-white text-slate-500 hover:bg-slate-50"}`}>
                  {l === "en" ? "English" : "বাংলা"}
                </button>
              ))}
            </div>
            <PrintActions targetId="certificate-print" fileName={`certificate-${data.values.admissionNo || data.student.name}-${data.type.toLowerCase()}`} />
          </div>
        </div>
        {data.templateName ? (
          <p className="text-xs text-slate-400">
            Using custom template <b className="text-slate-600">{data.templateName}</b>
            {data.template?.isDefault ? " (default)" : ""}
          </p>
        ) : (
          <p className="text-xs text-slate-400">Using the built-in certificate design — customize it under Settings → Certificate Templates.</p>
        )}
      </div>

      <div id="certificate-print" className="print:p-0">
        <CertificateDocument
          type={data.type}
          serial={data.serial}
          generatedAt={data.generatedAt}
          bodyEn={data.template?.bodyEn || null}
          bodyBn={data.template?.bodyBn || null}
          design={data.template?.design || null}
          values={data.values}
          school={data.school}
          lang={lang}
        />
      </div>
    </div>
  );
}
