"use client";

import { useMemo } from "react";
import {
  BUILTIN_CERT_BODIES,
  CERT_TITLES,
  DEFAULT_CERT_DESIGN,
  certDate,
  resolveCertParagraphs,
  type CertDesign,
  type CertValues,
} from "@/lib/certificate";

/**
 * Shared certificate document renderer — the SAME component powers the
 * live preview in the template editor and the printable page, so what the
 * admin sees while editing is exactly what prints / exports to PDF.
 *
 * Styling uses inline hex styles (not Tailwind tokens) because html2canvas
 * snapshots the node for PDF export and needs concrete computed values.
 */

export interface CertificateDocumentProps {
  type: "TC" | "CHARACTER";
  serial: string;
  generatedAt?: string;
  /** Body source — template bodies win; built-ins are the fallback */
  bodyEn?: string | null;
  bodyBn?: string | null;
  design?: CertDesign | null;
  values: CertValues;
  school: {
    name: string;
    address?: string | null;
    phone?: string | null;
    email?: string | null;
    logoUrl?: string | null;
  };
  /** Editor preview scale (print uses 1) */
  scale?: number;
  /** Landscape mode renders a wider frame (the print page constrains width) */
}

const FONT_STACKS: Record<string, string> = {
  serif: "Georgia, 'Times New Roman', 'Noto Serif Bengali', serif",
  sans: "'Segoe UI', system-ui, -apple-system, Arial, 'Noto Sans Bengali', sans-serif",
  bengali: "'Noto Sans Bengali', 'Hind Siliguri', 'SolaimanLipi', system-ui, sans-serif",
};

const BORDER_STYLES: Record<string, { outer: string; inner: string }> = {
  double: { outer: "6px double", inner: "1px solid" },
  simple: { outer: "2px solid", inner: "none" },
  none: { outer: "none", inner: "none" },
};

const WM_POSITIONS: Record<string, { top?: string; bottom?: string; left?: string; right?: string; transform?: string }> = {
  center: { top: "50%", left: "50%", transform: "translate(-50%, -50%)" },
  "top-left": { top: "8%", left: "6%" },
  "top-right": { top: "8%", right: "6%" },
  "bottom-left": { bottom: "12%", left: "6%" },
  "bottom-right": { bottom: "12%", right: "6%" },
};

export function CertificateDocument({
  type,
  serial,
  generatedAt,
  bodyEn,
  bodyBn,
  design,
  values,
  school,
  scale = 1,
  lang = "en",
}: CertificateDocumentProps & { lang?: "en" | "bn" }) {
  const d: {
    borderStyle: NonNullable<CertDesign["borderStyle"]>;
    primaryColor: string;
    fontFamily: NonNullable<CertDesign["fontFamily"]>;
    orientation: NonNullable<CertDesign["orientation"]>;
    watermark: NonNullable<CertDesign["watermark"]>;
  } = {
    borderStyle: design?.borderStyle ?? DEFAULT_CERT_DESIGN.borderStyle,
    primaryColor: design?.primaryColor || DEFAULT_CERT_DESIGN.primaryColor || "#1e293b",
    fontFamily: design?.fontFamily ?? DEFAULT_CERT_DESIGN.fontFamily,
    orientation: design?.orientation ?? DEFAULT_CERT_DESIGN.orientation,
    watermark: design?.watermark || { kind: "none", opacity: 0.08, position: "center" },
  };
  const primary = d.primaryColor;

  const body = lang === "bn" ? bodyBn || bodyEn || BUILTIN_CERT_BODIES[type].bn : bodyEn || BUILTIN_CERT_BODIES[type].en;
  const paragraphs = useMemo(() => resolveCertParagraphs(body, values), [body, values]);

  const logo = design?.logoUrl || school.logoUrl || null;
  const border = BORDER_STYLES[d.borderStyle] || BORDER_STYLES.double;
  const fontStack = FONT_STACKS[d.fontFamily] || FONT_STACKS.sans;
  const opacity = Math.min(1, Math.max(0, Number(d.watermark.opacity ?? 0.08)));
  const wmPos = WM_POSITIONS[d.watermark.position || "center"] || WM_POSITIONS.center;

  return (
    <>
      {/* Bangla-capable webfonts (React hoists <link> into <head>); loads once,
          shared by the editor preview and the printable page. */}
      <link
        rel="stylesheet"
        href="https://fonts.googleapis.com/css2?family=Noto+Sans+Bengali:wght@400;600;700&family=Noto+Serif+Bengali:wght@400;600;700&display=swap"
      />
    <div
      id="certificate-document"
      style={{
        position: "relative",
        background: "#ffffff",
        color: "#1f2937",
        fontFamily: fontStack,
        overflow: "hidden",
        transform: scale !== 1 ? `scale(${scale})` : undefined,
        transformOrigin: "top center",
        padding: "28px",
      }}
    >
      {/* ---- watermark ---- */}
      {d.watermark.kind === "text" && d.watermark.text ? (
        <div
          aria-hidden
          style={{
            position: "absolute",
            fontSize: d.watermark.position === "center" ? 64 : 40,
            fontWeight: 800,
            letterSpacing: 6,
            color: d.primaryColor,
            opacity: opacity * 0.9,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            zIndex: 0,
            ...wmPos,
          }}
        >
          {d.watermark.text}
        </div>
      ) : null}
      {d.watermark.kind === "image" && d.watermark.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          aria-hidden
          src={d.watermark.imageUrl}
          alt=""
          style={{
            position: "absolute",
            width: d.watermark.position === "center" ? 320 : 160,
            opacity,
            pointerEvents: "none",
            zIndex: 0,
            ...wmPos,
          }}
        />
      ) : null}

      {/* ---- bordered frame ---- */}
      <div
        style={{
          position: "relative",
          zIndex: 1,
          padding: "26px 30px",
          ...(border.outer !== "none" ? { border: border.outer, borderColor: primary } : {}),
          ...(border.inner !== "none"
            ? { outline: border.inner, outlineColor: primary, outlineOffset: "-7px" }
            : {}),
        }}
      >
        {/* ---- header ---- */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 14,
            borderBottom: `2px solid ${d.primaryColor}`,
            paddingBottom: 16,
          }}
        >
          {logo ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={logo} alt="" style={{ height: 60, width: 60, borderRadius: "50%", objectFit: "contain" }} />
          ) : (
            <div
              style={{
                height: 60,
                width: 60,
                borderRadius: "50%",
                background: primary,
                color: "#fff",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                fontSize: 26,
                fontWeight: 900,
                flexShrink: 0,
              }}
            >
              {(school.name || "S").slice(0, 1)}
            </div>
          )}
          <div style={{ flex: 1, textAlign: "center" }}>
            <div style={{ fontSize: 22, fontWeight: 900, letterSpacing: 0.5, color: "#111827" }}>{school.name}</div>
            {design?.headerText ? (
              <div style={{ fontSize: 11, color: primary, fontWeight: 600, marginTop: 2 }}>{design.headerText}</div>
            ) : null}
            <div style={{ fontSize: 11, color: "#6b7280" }}>{school.address || ""}</div>
            <div style={{ fontSize: 10, color: "#9ca3af" }}>
              {school.phone || ""}
              {school.email ? ` · ${school.email}` : ""}
            </div>
          </div>
        </div>

        {/* ---- title + serial ---- */}
        <div style={{ textAlign: "center", marginTop: 18 }}>
          <div
            style={{
              display: "inline-block",
              borderTop: `2px solid ${d.primaryColor}`,
              borderBottom: `2px solid ${d.primaryColor}`,
              padding: "5px 22px",
              fontSize: 17,
              fontWeight: 900,
              letterSpacing: 5,
              textTransform: "uppercase",
              color: "#111827",
            }}
          >
            {CERT_TITLES[type]}
          </div>
          <div style={{ marginTop: 8, fontFamily: "monospace", fontSize: 11, fontWeight: 700, color: "#6b7280" }}>
            Serial No: {serial}
          </div>
        </div>

        {/* ---- body ---- */}
        <div style={{ marginTop: 22, minHeight: 150 }}>
          {paragraphs.map((para, pi) => (
            <p key={pi} style={{ margin: "0 0 14px", fontSize: 14, lineHeight: 2, textAlign: "justify" }}>
              {para.map((seg, si) =>
                seg.bold ? (
                  <b key={si} style={{ color: "#111827" }}>
                    {seg.text}
                  </b>
                ) : (
                  <span key={si}>{seg.text}</span>
                )
              )}
            </p>
          ))}
        </div>

        {/* ---- signatures + seal ---- */}
        <div style={{ marginTop: 34, display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12 }}>
          <div style={{ textAlign: "center", flex: 1 }}>
            {design?.classTeacherSignatureUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={design.classTeacherSignatureUrl} alt="" style={{ height: 44, objectFit: "contain", display: "block", margin: "0 auto" }} />
            ) : (
              <div style={{ height: 40, width: 150, borderBottom: "1px solid #9ca3af" }} />
            )}
            <div style={{ marginTop: 4, fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#9ca3af" }}>
              {design?.signatoryLeftLabel || "Class Teacher"}
            </div>
          </div>

          <div style={{ width: 96, height: 96, flexShrink: 0 }}>
            {design?.sealImageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={design.sealImageUrl} alt="" style={{ width: 96, height: 96, objectFit: "contain" }} />
            ) : (
              <div
                style={{
                  width: 96,
                  height: 96,
                  borderRadius: "50%",
                  border: "2px dashed #cbd5e1",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 8,
                  fontWeight: 700,
                  letterSpacing: 1.5,
                  textTransform: "uppercase",
                  color: "#cbd5e1",
                  textAlign: "center",
                }}
              >
                School Seal
              </div>
            )}
          </div>

          <div style={{ textAlign: "center", flex: 1 }}>
            {design?.principalSignatureUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={design.principalSignatureUrl} alt="" style={{ height: 44, objectFit: "contain", display: "block", margin: "0 auto" }} />
            ) : (
              <div style={{ height: 40, width: 150, borderBottom: "1px solid #9ca3af" }} />
            )}
            <div style={{ marginTop: 4, fontSize: 9, letterSpacing: 2, textTransform: "uppercase", color: "#9ca3af" }}>
              {design?.signatoryRightLabel || "Principal"}
            </div>
          </div>
        </div>

        {/* ---- footer ---- */}
        <div style={{ marginTop: 22, borderTop: "1px solid #f1f5f9", paddingTop: 8, textAlign: "center", fontSize: 9, color: "#9ca3af" }}>
          {design?.footerText
            ? design.footerText
            : `Issued on ${certDate(generatedAt || new Date().toISOString())} · ${serial}`}
        </div>
      </div>
    </div>
    </>
  );
}
