"use client";

import { Printer, FileDown } from "lucide-react";

export function PrintActions({ targetId, fileName }: { targetId: string; fileName: string }) {
  const print = () => window.print();

  const downloadPdf = async () => {
    const { default: html2canvas } = await import("html2canvas");
    const { default: jspdf } = await import("jspdf");
    const el = document.getElementById(targetId);
    if (!el) return;
    const canvas = await html2canvas(el, { scale: 2, useCORS: true, backgroundColor: "#ffffff" });
    const pdf = new jspdf("p", "mm", "a4");
    const img = canvas.toDataURL("image/jpeg", 0.95);
    const pageW = 210;
    const pageH = 297;
    const imgW = pageW;
    const imgH = (canvas.height * pageW) / canvas.width;
    let heightLeft = imgH;
    let position = 0;
    pdf.addImage(img, "JPEG", 0, position, imgW, imgH);
    heightLeft -= pageH;
    while (heightLeft > 0) {
      position -= pageH;
      pdf.addPage();
      pdf.addImage(img, "JPEG", 0, position, imgW, imgH);
      heightLeft -= pageH;
    }
    pdf.save(`${fileName}.pdf`);
  };

  return (
    <div className="no-print flex items-center gap-2">
      <button onClick={downloadPdf} className="btn btn-secondary btn-sm">
        <FileDown size={14} /> PDF
      </button>
      <button onClick={print} className="btn btn-primary btn-sm">
        <Printer size={14} /> Print
      </button>
    </div>
  );
}
