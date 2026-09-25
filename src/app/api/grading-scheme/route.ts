import { NextRequest, NextResponse } from "next/server";
import { getSession, audit } from "@/lib/auth";
import { can } from "@/lib/permissions";
import { writeGuard } from "@/lib/subscription";
import { invalidateExamsCache } from "@/lib/exams-cache";
import { loadScheme, saveScheme } from "@/lib/grading-store";
import { DEFAULT_SCHEME, GRADING_PRESETS, validateScheme } from "@/lib/grading";

/**
 * The school's grading & GPA scheme (PRD §2.1 attendanceMarks).
 *
 *   GET    → the active scheme + the shipped default + the ready-made presets
 *   PUT    → replace the scheme (validated)
 *   DELETE → go back to the shipped default
 *
 * Readable by anyone who can see marks; writable by anyone who can enter them,
 * which the matrix defines as SCHOOL_ADMIN / BRANCH_ADMIN (full) and TEACHER
 * (entry). A guardian can read but never write.
 */

export async function GET() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "attendanceMarks", "view")) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  if (!session.schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const scheme = await loadScheme(session.schoolId);
  return NextResponse.json({ data: { scheme, default: DEFAULT_SCHEME, presets: GRADING_PRESETS } });
}

export async function PUT(req: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "attendanceMarks", "entry")) {
    return NextResponse.json({ error: "You do not have permission to change the grading system." }, { status: 403 });
  }
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  const body = await req.json().catch(() => null);
  const result = validateScheme(body?.scheme ?? body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });

  await saveScheme(schoolId, result.scheme);
  await audit("GRADING_SCHEME_UPDATE", "school", schoolId, {
    name: result.scheme.name,
    gpaScale: result.scheme.gpaScale,
    bands: result.scheme.bands.length,
  });
  // The exams list and every exam sheet render grades from this scheme.
  invalidateExamsCache(schoolId);
  return NextResponse.json({ data: { scheme: result.scheme } });
}

export async function DELETE() {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!can(session.role, "attendanceMarks", "entry")) {
    return NextResponse.json({ error: "You do not have permission to change the grading system." }, { status: 403 });
  }
  const schoolId = session.schoolId;
  if (!schoolId) return NextResponse.json({ error: "No school context" }, { status: 400 });

  const locked = await writeGuard(schoolId);
  if (locked) return locked;

  await saveScheme(schoolId, DEFAULT_SCHEME);
  await audit("GRADING_SCHEME_RESET", "school", schoolId, { name: DEFAULT_SCHEME.name });
  invalidateExamsCache(schoolId);
  return NextResponse.json({ data: { scheme: DEFAULT_SCHEME } });
}
