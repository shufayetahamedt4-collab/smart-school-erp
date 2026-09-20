/**
 * Custom certificate template engine (isomorphic — used by API routes,
 * the shared renderer and the template editor).
 *
 * Safety model: template bodies are PLAIN TEXT. No HTML is ever accepted
 * from the user — every dynamic value is HTML-escaped by the resolver and
 * the renderer outputs React nodes (never dangerouslySetInnerHTML), so a
 * template can never inject markup into the printable document.
 *
 * Syntax:
 *   {{placeholder}}          → substituted value ("" when missing)
 *   [[ ... {{ph}} ... ]]     → conditional clause: dropped entirely when
 *                              ANY placeholder inside it is empty/missing,
 *                              which is how missing data gracefully
 *                              disappears instead of rendering "—".
 *   **text**                 → bold (the only rich formatting offered)
 */

// ---------------------------------------------------------------------------
// Placeholders
// ---------------------------------------------------------------------------

export const CERT_PLACEHOLDERS = [
  "studentName",
  "fatherName",
  "motherName",
  "class",
  "section",
  "admissionNo",
  "admissionDate",
  "leaveDate",
  "serialNo",
  "schoolName",
  "dateOfBirth",
  "issueDate",
  "conduct",
  "academicYear",
  "rollNo",
] as const;

export type CertPlaceholder = (typeof CERT_PLACEHOLDERS)[number];
export type CertValues = Partial<Record<CertPlaceholder, string>>;

// ---------------------------------------------------------------------------
// Design settings (stored per template; validated before save)
// ---------------------------------------------------------------------------

export type CertBorderStyle = "double" | "simple" | "none";
export type CertFontFamily = "serif" | "sans" | "bengali";
export type CertWatermarkKind = "none" | "text" | "image";
export type CertWatermarkPosition = "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right";
export type CertOrientation = "portrait" | "landscape";

export interface CertWatermark {
  kind: CertWatermarkKind;
  text?: string | null;
  imageUrl?: string | null;
  /** 0 – 1 */
  opacity?: number;
  position?: CertWatermarkPosition;
}

export interface CertDesign {
  /** Overrides the school logo when set */
  logoUrl?: string | null;
  watermark?: CertWatermark | null;
  sealImageUrl?: string | null;
  principalSignatureUrl?: string | null;
  classTeacherSignatureUrl?: string | null;
  borderStyle?: CertBorderStyle;
  /** hex color, e.g. #8b0000 */
  primaryColor?: string | null;
  fontFamily?: CertFontFamily;
  /** Extra line under the school header (motto, EIIN, …) */
  headerText?: string | null;
  /** Replaces the default footer line when set */
  footerText?: string | null;
  signatoryLeftLabel?: string | null;
  signatoryRightLabel?: string | null;
  orientation?: CertOrientation;
}

export interface CertTemplateDoc {
  id: string;
  schoolId: string;
  type: "TC" | "CHARACTER";
  name: string;
  isDefault?: boolean;
  bodyEn?: string | null;
  bodyBn?: string | null;
  design?: CertDesign | null;
  createdAt?: unknown;
  updatedAt?: unknown;
}

// ---------------------------------------------------------------------------
// Built-in (fallback) content — used when a school has no custom template
// ---------------------------------------------------------------------------

export const DEFAULT_CERT_DESIGN: Required<
  Pick<CertDesign, "borderStyle" | "primaryColor" | "fontFamily" | "orientation">
> & { watermark: CertWatermark } = {
  borderStyle: "double",
  primaryColor: "#1e293b",
  fontFamily: "sans",
  orientation: "portrait",
  watermark: { kind: "none", opacity: 0.08, position: "center" },
};

export const CERT_TITLES: Record<"TC" | "CHARACTER", string> = {
  TC: "Transfer Certificate",
  CHARACTER: "Character Certificate",
};

/** Built-in bodies use conditionals so missing data never renders as "—". */
export const BUILTIN_CERT_BODIES: Record<"TC" | "CHARACTER", { en: string; bn: string }> = {
  TC: {
    en:
      "This is to certify that **{{studentName}}**[[, son/daughter of {{fatherName}},]] was a bona fide student of this institution[[, studying in {{class}}]][[ (Section {{section}})]], bearing admission number {{admissionNo}}. " +
      "[[The student was admitted on {{admissionDate}}]][[ and left the school on {{leaveDate}}]]. [[As per school records, the date of birth is {{dateOfBirth}}]]. " +
      "All dues have been cleared and the student has no outstanding liabilities. We wish {{studentName}} every success in future endeavors.",
    bn:
      "এই মর্মে প্রত্যয়ন করা হচ্ছে যে **{{studentName}}**[[, পিতা {{fatherName}},]] এই বিদ্যালয়ের একজন প্রকৃত শিক্ষার্থী ছিল[[, {{class}} শ্রেণিতে অধ্যয়নরত]][[ (শাখা {{section}})]], ভর্তি নম্বর {{admissionNo}}। " +
      "[[শিক্ষার্থীটি {{admissionDate}} তারিখে ভর্তি হন]][[ এবং {{leaveDate}} তারিখে বিদ্যালয় ত্যাগ করেন]]। [[বিদ্যালয়ের নিবন্ধন অনুযায়ী জন্ম তারিখ {{dateOfBirth}}]]। " +
      "সকল বকেয়া পরিশোধিত এবং তার কোনো দায়দেন্দ্র নেই। ভবিষ্যৎ জীবনে তার সর্বাঙ্গীণ সাফল্য কামনা করছি।",
  },
  CHARACTER: {
    en:
      "This is to certify that **{{studentName}}**[[, son/daughter of {{fatherName}},]], bearing admission number {{admissionNo}}[[, of {{class}}]][[ (Section {{section}})]], is a student of this school. " +
      "During the period of study the student's conduct was found to be **{{conduct}}** and the character is deemed excellent. [[As per school records, the date of birth is {{dateOfBirth}}]]. " +
      "We wish {{studentName}} every success in life.",
    bn:
      "এই মর্মে প্রত্যয়ন করা হচ্ছে যে **{{studentName}}**[[, পিতা {{fatherName}},]], ভর্তি নম্বর {{admissionNo}}[[, {{class}} শ্রেণি]][[ (শাখা {{section}})]], এই বিদ্যালয়ের একজন শিক্ষার্থী। " +
      "অধ্যয়নকালীন সময়ে তার আচরণ ছিল **{{conduct}}** এবং চরিত্র সম্পর্কে এই বিদ্যালয়ের কোনো অভিযোগ নেই। [[বিদ্যালয়ের নিবন্ধন অনুযায়ী জন্ম তারিখ {{dateOfBirth}}]]। " +
      "ভবিষ্যৎ জীবনে তার সর্বাঙ্গীণ সাফল্য কামনা করছি।",
  },
};

// ---------------------------------------------------------------------------
// Values builder (from the /api/certificates response shape)
// ---------------------------------------------------------------------------

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "2026-01-12T…" → "12 January 2026"; empty string when missing. */
export function certDate(v: unknown): string {
  if (!v) return "";
  const d = new Date(v as string);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

export function buildCertValues(data: {
  serial: string;
  generatedAt?: string;
  academicYear?: string | null;
  student: {
    name?: string | null; fatherName?: string | null; motherName?: string | null;
    className?: string | null; section?: string | null; admissionNo?: string | null;
    admissionDate?: unknown; leavingDate?: unknown; dob?: unknown; conduct?: string | null; rollNo?: string | null;
  };
  school?: { name?: string | null } | null;
}): CertValues {
  const st = data.student || ({} as typeof data.student);
  return {
    studentName: st.name || "",
    fatherName: st.fatherName || "",
    motherName: st.motherName || "",
    class: st.className || "",
    section: st.section || "",
    admissionNo: st.admissionNo || "",
    admissionDate: certDate(st.admissionDate),
    leaveDate: certDate(st.leavingDate),
    serialNo: data.serial || "",
    schoolName: data.school?.name || "",
    dateOfBirth: certDate(st.dob),
    issueDate: certDate(data.generatedAt || new Date().toISOString()),
    conduct: st.conduct || "",
    academicYear: data.academicYear || "",
    rollNo: st.rollNo || "",
  };
}

// ---------------------------------------------------------------------------
// Escaping + resolution
// ---------------------------------------------------------------------------

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

const PH_RE = /\{\{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*\}\}/g;
const COND_RE = /\[\[([\s\S]*?)\]\]/g;

/** Expand one flat body string with conditionals applied. */
function expand(body: string, values: CertValues): string {
  const get = (name: string): string => (values[name as CertPlaceholder] || "").toString();
  // Pass 1: resolve conditional clauses.
  const withoutConds = body.replace(COND_RE, (_m, inner: string) => {
    const refs = [...inner.matchAll(PH_RE)].map((m) => m[1]);
    // Drop the whole clause if any referenced value is empty (graceful fallback).
    if (refs.some((r) => !get(r))) return "";
    return inner.replace(PH_RE, (_m2, name: string) => get(name));
  });
  // Pass 2: remaining placeholders (unknown → empty string, never echoed).
  return withoutConds.replace(PH_RE, (_m, name: string) => get(name));
}

/** Collapse whitespace and orphaned punctuation left by dropped clauses. */
function tidy(s: string): string {
  return s
    .replace(/[ \t]+/g, " ")
    .replace(/ ([,.;:])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/\(\s*\)/g, "")
    .replace(/ {2,}/g, " ")
    .trim();
}

export interface CertSegment {
  text: string;
  bold: boolean;
}

/** Resolve a body into paragraphs of escaped, bold-aware segments. */
/** Resolve a body into paragraphs of bold-aware segments (React-safe: consumers render as text nodes, so no manual escaping). */
export function resolveCertParagraphs(body: string, values: CertValues): CertSegment[][] {
  const paragraphs = expand(body || "", values)
    .split(/\n\s*\n/)
    .map((p) => tidy(p))
    .filter(Boolean);
  return paragraphs.map((p) =>
    p
      .split(/\n/)
      .join(" ")
      .split(/\*\*(.+?)\*\*/g)
      .map((part, i): CertSegment => ({ text: part, bold: i % 2 === 1 }))
      .filter((s) => s.text.length > 0)
  );
}

/** Plain-text resolution (QA + API response convenience). */
export function resolveCertText(body: string, values: CertValues): string {
  return expand(body || "", values)
    .split(/\n\s*\n/)
    .map((p) => tidy(p.replace(/\*\*(.+?)\*\*/g, "$1")))
    .filter(Boolean)
    .join("\n\n");
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function validateCertBody(body: string | null | undefined, field: string): string[] {
  const errors: string[] = [];
  if (!body) return errors;
  if (/[<>]/.test(body)) {
    errors.push(`${field}: HTML is not allowed — body text is plain text with {{placeholders}} (use **bold** for emphasis).`);
  }
  const opens = (body.match(/\[\[/g) || []).length;
  const closes = (body.match(/\]\]/g) || []).length;
  if (opens !== closes) {
    errors.push(`${field}: unbalanced [[ ]] conditional clauses (${opens} " [[" vs ${closes} "]]").`);
  }
  if (/\[\[[^\]]*\[\[/.test(body)) {
    errors.push(`${field}: nested [[ ]] clauses are not supported.`);
  }
  for (const m of body.matchAll(PH_RE)) {
    if (!(CERT_PLACEHOLDERS as readonly string[]).includes(m[1])) {
      errors.push(`${field}: unknown placeholder {{${m[1]}}}. Allowed: ${CERT_PLACEHOLDERS.map((p) => `{{${p}}}`).join(", ")}`);
    }
  }
  return errors;
}

/** Image URLs must live under the school's own certificates/ folder. */
export function validateCertImageUrl(url: string | null | undefined, schoolId: string, field: string): string[] {
  if (!url) return [];
  const prefix = `certificates/${schoolId}/`;
  try {
    const u = new URL(url);
    if (u.pathname.startsWith(`/${prefix}`)) return [];
  } catch {
    // not an absolute URL — allow a bare storage path
    if (url.startsWith(prefix)) return [];
  }
  return [`${field}: image must be uploaded to your school's folder (${prefix}…) — external or cross-school URLs are not allowed.`];
}

export function validateCertDesign(design: CertDesign | null | undefined, schoolId: string): string[] {
  const errors: string[] = [];
  if (!design) return errors;
  if (design.primaryColor && !HEX_RE.test(design.primaryColor)) {
    errors.push(`design.primaryColor: must be a hex color like #8b0000.`);
  }
  const wm = design.watermark;
  if (wm) {
    if (!["none", "text", "image"].includes(wm.kind)) errors.push("design.watermark.kind: must be none, text or image.");
    if (wm.kind === "image") {
      errors.push(...validateCertImageUrl(wm.imageUrl, schoolId, "design.watermark.imageUrl"));
    }
    if (wm.opacity !== undefined && wm.opacity !== null && (Number(wm.opacity) < 0 || Number(wm.opacity) > 1)) {
      errors.push("design.watermark.opacity: must be between 0 and 1.");
    }
    if (wm.position && !["center", "top-left", "top-right", "bottom-left", "bottom-right"].includes(wm.position)) {
      errors.push("design.watermark.position: invalid position.");
    }
  }
  if (design.borderStyle && !["double", "simple", "none"].includes(design.borderStyle)) {
    errors.push("design.borderStyle: must be double, simple or none.");
  }
  if (design.fontFamily && !["serif", "sans", "bengali"].includes(design.fontFamily)) {
    errors.push("design.fontFamily: must be serif, sans or bengali.");
  }
  if (design.orientation && !["portrait", "landscape"].includes(design.orientation)) {
    errors.push("design.orientation: must be portrait or landscape.");
  }
  errors.push(...validateCertImageUrl(design.logoUrl, schoolId, "design.logoUrl"));
  errors.push(...validateCertImageUrl(design.sealImageUrl, schoolId, "design.sealImageUrl"));
  errors.push(...validateCertImageUrl(design.principalSignatureUrl, schoolId, "design.principalSignatureUrl"));
  errors.push(...validateCertImageUrl(design.classTeacherSignatureUrl, schoolId, "design.classTeacherSignatureUrl"));
  return errors;
}
