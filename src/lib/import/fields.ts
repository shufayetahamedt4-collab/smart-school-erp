/**
 * Bulk student import — field catalogue, header aliases and column detection.
 *
 * Pure data + pure functions: no DB, no Node-only APIs, so this module is safe
 * to import from both the server routes (validation) and the browser page (the
 * mapping UI + the downloadable template). The server NEVER trusts a client
 * mapping blindly — it re-detects / re-validates every name it resolves — but
 * sharing the catalogue here keeps the two halves in step.
 *
 * `required` marks the fields a row cannot be imported without; `identifier`
 * marks a field that can stand in as the row's stable key (at least one of
 * admissionNo / roll / registrationNo is required). Everything else is
 * optional.
 */

export type ImportFieldKey =
  | "name"
  | "admissionNo"
  | "roll"
  | "registrationNo"
  | "class"
  | "section"
  | "nameBn"
  | "dob"
  | "gender"
  | "bloodGroup"
  | "birthCertificateNo"
  | "address"
  | "previousSchoolName"
  | "previousSchoolClass"
  | "guardianName"
  | "guardianPhone"
  | "guardianEmail"
  | "guardianRelation"
  | "photoUrl";

export interface ImportField {
  key: ImportFieldKey;
  /** Canonical header text used in the downloadable template. */
  label: string;
  /** Required for every row. */
  required?: boolean;
  /** Can serve as the row's reliable identifier. */
  identifier?: boolean;
  /** Alternative header spellings accepted by auto-detection. */
  aliases: string[];
  hint?: string;
}

export const IMPORT_FIELDS: ImportField[] = [
  { key: "name", label: "Name", required: true, aliases: ["student name", "studentname", "fullname", "full name", "student", "pupil name", "name of student"] },
  { key: "admissionNo", label: "Admission No", identifier: true, aliases: ["admissionno", "admission no", "admission number", "admissionnumber", "adm no", "admno", "admission id", "admissionid", "student id", "studentid"] },
  { key: "roll", label: "Roll", identifier: true, aliases: ["roll no", "rollno", "roll number", "rollnumber", "roll"] },
  { key: "registrationNo", label: "Registration No", identifier: true, aliases: ["registrationno", "registration no", "registration number", "reg no", "regno", "registration"] },
  { key: "class", label: "Class", required: true, aliases: ["classname", "class name", "grade", "grade name", "class no", "classno", "classnum", "class level"] },
  { key: "section", label: "Section", aliases: ["sec", "section name", "class section"] },
  { key: "nameBn", label: "Name (Bangla)", aliases: ["namebangla", "bangla name", "bengaliname", "bengali name", "name bn", "bn name", "namebn"] },
  { key: "dob", label: "Date of Birth", aliases: ["dateofbirth", "date of birth", "birthdate", "birth date", "birthday", "dob"] },
  { key: "gender", label: "Gender", aliases: ["sex"] },
  { key: "bloodGroup", label: "Blood Group", aliases: ["bloodgroup", "blood", "blood grp"] },
  { key: "birthCertificateNo", label: "Birth Certificate No", aliases: ["birthcertificateno", "birth certificate no", "birth certificate number", "birthcertificate", "birth certificate", "bc no", "bcno"] },
  { key: "address", label: "Address", aliases: ["full address", "present address", "address line", "home address", "location"] },
  { key: "previousSchoolName", label: "Previous School", aliases: ["previousschoolname", "previous school name", "previous school", "last school", "last school name", "old school"] },
  { key: "previousSchoolClass", label: "Previous School Class", aliases: ["previousschoolclass", "previous school class", "previous class", "last class", "previous grade"] },
  { key: "guardianName", label: "Guardian Name", aliases: ["guardianname", "guardian name", "parent name", "father name", "mother name", "father's name", "mother's name", "guardian"] },
  { key: "guardianPhone", label: "Guardian Phone", aliases: ["guardianphone", "guardian phone", "guardian mobile", "guardian contact", "parent phone", "parent mobile", "father phone", "mother phone", "mobile", "phone", "phone number", "contact", "contact no", "contact number", "mobile no"] },
  { key: "guardianEmail", label: "Guardian Email", aliases: ["guardianemail", "guardian email", "parent email", "guardian e-mail", "email", "email address", "e-mail"] },
  { key: "guardianRelation", label: "Guardian Relation", aliases: ["guardianrelation", "guardian relation", "relation", "relationship", "relation with student"] },
  { key: "photoUrl", label: "Photo URL", aliases: ["photourl", "photo url", "photo", "image", "image url", "picture", "picture url"] },
];

export const FIELD_BY_KEY: Record<string, ImportField> = Object.fromEntries(IMPORT_FIELDS.map((f) => [f.key, f]));

export const REQUIRED_FIELD_KEYS: ImportFieldKey[] = IMPORT_FIELDS.filter((f) => f.required).map((f) => f.key);
export const IDENTIFIER_FIELD_KEYS: ImportFieldKey[] = IMPORT_FIELDS.filter((f) => f.identifier).map((f) => f.key);

export const TEMPLATE_HEADERS: string[] = IMPORT_FIELDS.map((f) => f.label);

/** One illustrative row so the downloaded template is self-explanatory. */
export const TEMPLATE_SAMPLE_ROW: string[] = [
  "Ayan Rahman",
  "STU-1001",
  "1",
  "",
  "Class 1",
  "A",
  "আয়ান রহমান",
  "2018-05-14",
  "Male",
  "B+",
  "BC-2018-1001",
  "12 Green Road, Dhaka",
  "Little Angels School",
  "Nursery",
  "Kamrul Rahman",
  "01711000000",
  "kamrul@example.com",
  "Father",
  "",
];

/** Fold a raw header/cell into a comparable key: lowercase, alphanumerics only. */
export function normalizeHeader(value: string): string {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** field key → every normalized header spelling that maps to it. */
export function headerLookup(): Record<string, ImportFieldKey> {
  const map: Record<string, ImportFieldKey> = {};
  for (const field of IMPORT_FIELDS) {
    map[normalizeHeader(field.label)] = field.key;
    map[normalizeHeader(field.key)] = field.key;
    for (const alias of field.aliases) map[normalizeHeader(alias)] = field.key;
  }
  return map;
}

const LOOKUP = headerLookup();

/**
 * Best-effort detection of which column feeds which field.
 *
 * Returns `field key → column index`. A field is detected only when its header
 * is recognised; a column may only feed one field (first match wins). Unmapped
 * columns are simply ignored. The UI lets the user override every choice.
 */
export function detectMapping(headers: string[]): Record<string, number> {
  const mapping: Record<string, number> = {};
  const used = new Set<number>();
  headers.forEach((header, index) => {
    const key = LOOKUP[normalizeHeader(header)];
    if (!key || mapping[key] !== undefined || used.has(index)) return;
    mapping[key] = index;
    used.add(index);
  });
  return mapping;
}

/** Normalize a client-supplied mapping to `field key → column index`, dropping junk. */
export function sanitizeMapping(raw: unknown, columnCount: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [key, value] of Object.entries(raw as Record<string, any>)) {
    if (!FIELD_BY_KEY[key]) continue;
    const index = Number(value);
    if (Number.isInteger(index) && index >= 0 && index < columnCount) out[key] = index;
  }
  return out;
}
