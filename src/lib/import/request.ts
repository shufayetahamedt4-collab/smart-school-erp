import type { RawImportRow } from "@/lib/import/plan";

/**
 * Shared parsing of an import request body.
 *
 * The client sends the spreadsheet grid it read (`headers` + data rows). A data
 * row is `{ rowNumber, cells }` where `rowNumber` is the row's ABSOLUTE position
 * in the source sheet (row 1 is the header, so the first data row is 2). That
 * number is the row's stable identity across a chunked commit, so it is REQUIRED
 * and strictly validated:
 *
 *  - a row without an integer `rowNumber >= 2` is rejected (never silently
 *    re-numbered from its position in the chunk);
 *  - row numbers must be unique within one request (two rows claiming the same
 *    number are rejected rather than allowed to overwrite each other);
 *  - a row number beyond a sane bound is rejected (defends the document id).
 *
 * Everything downstream uses the supplied number verbatim, so a committed row
 * always keeps the number it had in the spreadsheet.
 */

/** Hard ceiling on one file/preview. The commit path is chunked well below this. */
export const MAX_IMPORT_ROWS = 6000;

/** Largest absolute row number accepted (a little above MAX_IMPORT_ROWS). */
export const MAX_ROW_NUMBER = 200_000;

export interface RowParseResult {
  rows?: RawImportRow[];
  error?: string;
}

export function readHeaders(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((h) => String(h ?? "").trim());
}

/**
 * Parse a request's data rows. Returns `{ error }` (to be surfaced as 400) when
 * any row is malformed; never invents a row number.
 */
export function readStrictRows(value: unknown): RowParseResult {
  if (!Array.isArray(value)) return { error: "`rows` must be an array of { rowNumber, cells }." };

  const rows: RawImportRow[] = [];
  const seen = new Set<number>();

  for (let i = 0; i < value.length; i++) {
    const entry = value[i];
    const where = `Row ${i + 1} of the upload`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return { error: `${where} is malformed — each row must be { rowNumber, cells } with the row's absolute spreadsheet number.` };
    }
    const record = entry as any;
    if (!Array.isArray(record.cells)) {
      return { error: `${where} is missing its \`cells\` array.` };
    }
    const rowNumber = record.rowNumber;
    if (typeof rowNumber !== "number" || !Number.isInteger(rowNumber)) {
      return { error: `${where} is missing a numeric \`rowNumber\` (the absolute spreadsheet row).` };
    }
    if (rowNumber < 2) {
      return { error: `${where} has an invalid \`rowNumber\` (${rowNumber}); data rows start at 2 (row 1 is the header).` };
    }
    if (rowNumber > MAX_ROW_NUMBER) {
      return { error: `${where} has an out-of-range \`rowNumber\` (${rowNumber}).` };
    }
    if (seen.has(rowNumber)) {
      return { error: `Row number ${rowNumber} appears more than once in this request — row numbers must be unique so records cannot overwrite each other.` };
    }
    seen.add(rowNumber);

    const cells = (record.cells as unknown[]).map((c) => String(c ?? ""));
    // A row with an empty body carries no data; keep validating its number, but
    // do not commit a phantom row.
    if (cells.every((c) => c.trim() === "" || c.trim() === "-")) continue;
    rows.push({ rowNumber, cells });
  }

  if (!rows.length) return { error: "No data rows were found in the request." };
  return { rows };
}
