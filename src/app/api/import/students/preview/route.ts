import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { resolveBranchId } from "@/lib/branches";
import { getCurrentSessionId } from "@/lib/academic";
import { detectMapping, sanitizeMapping } from "@/lib/import/fields";
import { readHeaders, readStrictRows, MAX_IMPORT_ROWS } from "@/lib/import/request";
import { loadImportContext, validateRows } from "@/lib/import/plan";

/**
 * POST /api/import/students/preview
 *
 * Parse → resolve class/section/session → detect duplicates → return a per-row
 * plan. This endpoint performs ZERO writes: it never creates a student, a
 * guardian, a fee or a batch record, and it never calls `audit()`. Only the
 * explicit confirm (POST .../commit) writes anything.
 *
 * `schoolId` is always taken from the session; a branch admin's branch is forced
 * and the main admin may pass `branchId` (validated by resolveBranchId).
 */
export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["SCHOOL_ADMIN", "BRANCH_ADMIN"].includes(session.role) || !can(session.role, "admission", "full")) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const body = await req.json().catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid body" }, { status: 400 });

  const headers = readHeaders(body.headers);
  const parsed = readStrictRows(body.rows);
  if (parsed.error || !parsed.rows) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const rawRows = parsed.rows;
  if (rawRows.length > MAX_IMPORT_ROWS) {
    return NextResponse.json({ error: `Too many rows (${rawRows.length}). The maximum is ${MAX_IMPORT_ROWS}.` }, { status: 400 });
  }

  // Detection fills any column the client did not map; the client's choices win.
  const detected = detectMapping(headers);
  const mapping = { ...detected, ...sanitizeMapping(body.mapping, Math.max(headers.length, 1)) };

  const branchId = await resolveBranchId(session, body.branchId || null);
  const sessionId = await getCurrentSessionId(schoolId);
  const ctx = await loadImportContext(schoolId, branchId, sessionId);
  const { rows, summary } = validateRows(ctx, rawRows, mapping);

  return NextResponse.json({
    data: {
      fileName: String(body.fileName || ""),
      headers,
      detected,
      mapping,
      branchId,
      sessionId,
      summary,
      rows,
    },
  });
}
