/**
 * PRD §12.4 — CSV import/export utilities.
 *
 * Dependencies-free CSV parser/serializer so the import/export feature works
 * without native addons (xlsx is only used for the client-side Excel reports).
 *
 * Supported: quoted fields with escaped "" quotes, \r\n and \n line endings,
 * comma/semicolon/tab delimiters (sniffed from the header row).
 */

/** Parse CSV text into rows of string cells (header row NOT included). */
export function parseCsv(text: string): string[][] {
  const clean = text.replace(/^\uFEFF/, ""); // strip BOM from Excel exports
  const delim = sniffDelimiter(clean);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (inQuotes) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      pushField();
    } else if (ch === "\n") {
      pushRow();
    } else if (ch === "\r") {
      // \r\n — handled by the \n branch
      if (clean[i + 1] !== "\n") pushRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) pushRow();
  return rows;
}

/** Guess the delimiter from the first (header) line. */
function sniffDelimiter(text: string): string {
  const line = text.split("\n", 1)[0] || "";
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best && best[1] > 0 ? best[0] : ",";
}

/** Serialize rows (array of records) to CSV text with a header row. */
export function toCsv(headers: string[], records: Record<string, unknown>[]): string {
  const esc = (v: unknown): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.join(",")];
  for (const rec of records) {
    lines.push(headers.map((h) => esc(rec[h])).join(","));
  }
  return lines.join("\n");
}

/**
 * Convert parsed CSV rows into records keyed by normalized headers.
 * Header aliases are matched case/space-insensitively (e.g. "Admission No",
 * "admission_no", "ADM NO" all map to admissionNo when aliased).
 */
export function rowsToRecords(
  rows: string[][],
  aliases: Record<string, string> // alias(lowercased) → canonical key
): { records: Record<string, string>[]; headers: string[] } {
  if (!rows.length) return { records: [], headers: [] };
  const rawHeaders = rows[0];
  const headers = rawHeaders.map((h) => {
    const key = h.trim().toLowerCase().replace(/[\s_-]+/g, " ");
    return aliases[key] || aliases[key.replace(/\s/g, "")] || key.replace(/\s+/g, "");
  });
  const records: Record<string, string>[] = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (!cells.length || cells.every((c) => !c.trim())) continue; // skip blank rows
    const rec: Record<string, string> = {};
    headers.forEach((h, i) => {
      rec[h] = (cells[i] ?? "").trim();
    });
    records.push(rec);
  }
  return { records, headers };
}
