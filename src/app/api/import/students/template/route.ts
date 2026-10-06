import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { TEMPLATE_HEADERS, TEMPLATE_SAMPLE_ROW } from "@/lib/import/fields";

/**
 * GET /api/import/students/template?format=csv|xlsx
 *
 * The blank bulk-import template: the canonical column headers plus one
 * illustrative row. Read-only and scoped to any role that may view admissions —
 * it contains no tenant data at all, so it is safe to hand out.
 */
export async function GET(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "admission", "view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const format = (req.nextUrl.searchParams.get("format") || "xlsx").toLowerCase() === "csv" ? "csv" : "xlsx";

  if (format === "csv") {
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = "\uFEFF" + [TEMPLATE_HEADERS, TEMPLATE_SAMPLE_ROW].map((r) => r.map(escape).join(",")).join("\r\n") + "\r\n";
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="student-import-template.csv"',
        "Cache-Control": "no-store",
      },
    });
  }

  const sheet = XLSX.utils.aoa_to_sheet([TEMPLATE_HEADERS, TEMPLATE_SAMPLE_ROW]);
  sheet["!cols"] = TEMPLATE_HEADERS.map((h) => ({ wch: Math.max(12, Math.min(28, h.length + 6)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, "Students");
  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;

  return new NextResponse(new Uint8Array(buf), {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="student-import-template.xlsx"',
      "Cache-Control": "no-store",
    },
  });
}
