"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Award, BarChart3, GraduationCap, Printer, SlidersHorizontal, Users } from "lucide-react";
import { api, qs } from "@/lib/client";
import { hasCollege, normalizeInstitutionType } from "@/lib/institution";
import { can } from "@/lib/permissions";
import { canReadCollegeResults } from "@/lib/college-results-access";
import type { GradingScheme } from "@/lib/grading";
import { useMe } from "@/components/Shell";
import {
  Badge,
  Card,
  CardHeader,
  EmptyState,
  ErrorNote,
  Field,
  LoadingScreen,
  PageHeader,
  Select,
  TextInput,
} from "@/components/ui";
import {
  GRADING_EDITOR_HREF,
  PAGE_ERRORS,
  formatGpa,
  gradeText,
  messageOf,
  noGpaNote,
  percentText,
  policyLine,
  recordBlocked,
  recordButtonLabel,
  recordDisabled,
  resultsCountText,
  scaleLine,
  showsGpaFigure,
  transcriptHref,
} from "@/lib/college-results-view";

/**
 * College support (Phase 6d) — the college results screen
 * (docs/COLLEGE-DECISIONS.md §23, D-6-6, Q4).
 *
 * The screen over the Phase 6c API: a student's result is ONE attempt at ONE
 * course in ONE term of their programme, graded at read time by the tenant's own
 * COLLEGE scheme (D-6-12). The page records an attempt and lists what the API
 * serves; it derives nothing itself.
 *
 * COLLEGE-ONLY, and it says so BEFORE it reads anything: the tenant shape comes
 * from the same source the Shell uses (`me.school.institutionType ??
 * me.institutionType`), and every read effect returns before issuing a request
 * when the tenant has no college — so a school admin who types the URL gets the
 * refusal and no call to `/api/students`, `/api/courses` or `/api/course-results`.
 * The API remains the real gate (`requireCollege()` + `can(role,
 * "attendanceMarks", …)` in every handler); these checks are UX, fail-closed.
 * The nav item is marked `requires: "COLLEGE"`, so this is only reachable in
 * COLLEGE mode by the three roles that carry it (Q4: ONE nav entry) — exactly the
 * roles v1 lets READ, so the sidebar and the API agree (6d-fix).
 *
 * **The active scheme is named, and one click away** (D-6-6/Q1): the banner at
 * the top prints the scheme's NAME and its SCALE at all times — an admin must
 * never have to guess which scale is grading — and links to the existing
 * mode-scoped grading editor (`/dashboard/grades`), where the presets live.
 * Selecting a preset there still drops an *editable copy*, never an applied one.
 *
 * **The point/CGPA columns follow `showGpa`** (D-6-16): under a no-GPA scheme the
 * GPA figure is ABSENT, never a printed `0.00` — `formatGpa` returns `null` and the
 * cell renders nothing. A retake is just another attempt: the page sends the same
 * POST and the SERVER derives the attempt number and enforces the tenant's
 * `maxRetakes`, so the rule cannot drift into the UI.
 */

/** One student, as `GET /api/students` serves it (only the fields used here). */
interface StudentLite {
  id: string;
  name: string;
  admissionNo?: string | null;
  programId?: string | null;
}

/** One course, as `GET /api/courses` serves it. */
interface CourseLite {
  id: string;
  code: string;
  title: string;
  creditHours?: number | null;
}

/** One result row, as `GET /api/course-results` serves it (graded on read). */
interface ResultRow {
  id: string;
  studentId: string;
  courseId: string;
  termNumber: number | null;
  attempt: number | null;
  obtained: number | null;
  fullMarks: number | null;
  percent: number | null;
  grade: string | null;
  points: number | null;
  passed: boolean | null;
  courseCode: string | null;
  courseTitle: string | null;
  studentName: string | null;
  studentAdmissionNo: string | null;
}

/** `GET /api/grading-scheme` — the mode-scoped (COLLEGE) scheme the screen names. */
interface SchemePayload {
  scheme: GradingScheme;
}

export default function CollegeResultsPage() {
  const { me, loading: meLoading, error: meError } = useMe();

  const institutionType = me?.school?.institutionType ?? me?.institutionType ?? null;
  const college = hasCollege(normalizeInstitutionType(institutionType));
  const role = me?.user?.role;
  // READING is narrower than the `attendanceMarks` module in v1 (6d-fix, §23.6):
  // only the admin-level roles and the REGISTRAR — the SAME rule the API applies,
  // through the same pure helper, so a TEACHER or GUARDIAN who types the URL sees
  // the refusal and issues NO request. Recording stays `attendanceMarks` full.
  const canView = can(role, "attendanceMarks", "view") && canReadCollegeResults(role);
  const canWrite = can(role, "attendanceMarks", "full");
  const ready = !meLoading && college && canView;

  const [scheme, setScheme] = useState<GradingScheme | null>(null);
  const [students, setStudents] = useState<StudentLite[]>([]);
  const [courses, setCourses] = useState<CourseLite[]>([]);
  const [rows, setRows] = useState<ResultRow[]>([]);

  const [studentId, setStudentId] = useState("");
  const [courseId, setCourseId] = useState("");
  const [obtained, setObtained] = useState("");
  const [fullMarks, setFullMarks] = useState("100");

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  // A filter so a registrar can read one student's transcript set at a time.
  const [filterStudent, setFilterStudent] = useState("");

  const loadResults = useCallback(async () => {
    try {
      setRows((await api<ResultRow[]>("/api/course-results")) || []);
    } catch (e: any) {
      setRows([]);
      setError(messageOf(e, PAGE_ERRORS.results));
    }
  }, []);

  // The active scale, once. NO read before the gate resolves.
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    api<SchemePayload>("/api/grading-scheme")
      .then((d) => {
        if (alive) setScheme(d.scheme);
      })
      .catch((e: any) => {
        if (alive) setError(messageOf(e, PAGE_ERRORS.scheme));
      });
    return () => {
      alive = false;
    };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setLoading(true);
    Promise.all([
      api<StudentLite[]>("/api/students"),
      api<CourseLite[]>("/api/courses"),
    ])
      .then(([ss, cs]) => {
        if (!alive) return;
        setStudents(ss || []);
        setCourses(cs || []);
        if (ss?.length) setStudentId(ss[0].id);
        if (cs?.length) setCourseId(cs[0].id);
      })
      .catch((e: any) => {
        if (alive) setError(messageOf(e, PAGE_ERRORS.students));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ready]);

  useEffect(() => {
    if (!ready) return;
    void loadResults();
  }, [ready, loadResults]);

  const record = async () => {
    const input = { studentId, courseId, obtained, fullMarks, busy };
    // The same rule as the button, so the form cannot be bypassed into a refusal.
    if (recordBlocked(input)) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // Only the marks and the two ids are sent. The SERVER derives the attempt
      // number from what is already stored and enforces `maxRetakes` (D-6-9), so
      // a retake is recorded by pressing the same button again.
      await api<ResultRow>("/api/course-results", {
        method: "POST",
        body: JSON.stringify({ studentId, courseId, obtained: Number(obtained), fullMarks: Number(fullMarks) }),
      });
      setMessage(
        `Recorded ${obtained}/${fullMarks} for ${students.find((s) => s.id === studentId)?.name || "the student"}.`
      );
      await loadResults();
    } catch (e: any) {
      setError(messageOf(e, PAGE_ERRORS.record));
    } finally {
      setBusy(false);
    }
  };

  const showGpa = showsGpaFigure(scheme);
  const scale = scaleLine(scheme);
  const courseLabel = useMemo(() => {
    const byId = new Map(courses.map((c) => [c.id, c]));
    return (row: ResultRow) => {
      const c = byId.get(row.courseId);
      const code = row.courseCode || c?.code || "";
      const title = row.courseTitle || c?.title || "";
      return [code, title].filter(Boolean).join(" · ") || "—";
    };
  }, [courses]);

  const filtered = useMemo(
    () => (filterStudent ? rows.filter((r) => r.studentId === filterStudent) : rows),
    [rows, filterStudent]
  );

  /* -------------------------------------------------------------- gating UI */

  if (meLoading) return <LoadingScreen />;

  if (!college && !me) {
    return (
      <div>
        <PageHeader title="College Results" subtitle="Record course results and print transcripts" />
        <Card>
          <div className="px-6 py-8">
            <ErrorNote message={meError || "Could not load your session."} />
          </div>
        </Card>
      </div>
    );
  }

  if (!college) {
    return (
      <div>
        <PageHeader icon={BarChart3} title="College Results" subtitle="Record course results and print transcripts" />
        <Card>
          <EmptyState
            icon={GraduationCap}
            title="Available to college institutions only"
            description="This institution runs the school curriculum. Course results are part of the college setup."
          />
        </Card>
      </div>
    );
  }

  if (!canView) {
    return (
      <div>
        <PageHeader icon={BarChart3} title="College Results" subtitle="Record course results and print transcripts" />
        <Card>
          <EmptyState
            icon={BarChart3}
            title="Not available for your role"
            description="Results are handled by the school administration and the registrar."
          />
        </Card>
      </div>
    );
  }

  if (loading) return <LoadingScreen />;

  /* ------------------------------------------------------------------- view */

  return (
    <div>
      <PageHeader
        icon={BarChart3}
        title="College Results"
        subtitle="Record each course attempt and print a derived transcript — graded by this tenant's own scale"
      />

      {message && (
        <div className="mb-4 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm font-semibold text-emerald-700">
          {message}
        </div>
      )}
      {error && (
        <div className="mb-4">
          <ErrorNote message={error} />
        </div>
      )}

      {/* The active scale, named (D-6-6) — never a guess. */}
      <Card className="mb-4">
        <CardHeader
          title="Grading scale in force"
          subtitle="Every attempt below is graded by this scale, at read time — editing a band re-grades the list with no re-entry"
          action={
            <Link href={GRADING_EDITOR_HREF} className="btn btn-secondary btn-sm">
              <SlidersHorizontal size={14} /> Scale &amp; presets
            </Link>
          }
        />
        <div className="grid grid-cols-1 gap-4 p-5 sm:grid-cols-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Scheme</p>
            <p className="mt-1 text-lg font-extrabold text-slate-800">{scheme?.name || "—"}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Scale</p>
            <p className="mt-1 text-lg font-extrabold text-slate-800">{scale || "—"}</p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Pass mark</p>
            <p className="mt-1 text-lg font-extrabold text-slate-800">
              {typeof scheme?.passPercent === "number" ? `${scheme.passPercent}%` : "—"}
            </p>
          </div>
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Retakes</p>
            <p className="mt-1 text-sm font-semibold text-slate-700">{policyLine(scheme?.retake)}</p>
          </div>
        </div>
        {!showGpa && (
          <div className="border-t border-slate-100 px-5 py-3 text-xs font-semibold text-amber-700">{noGpaNote()}</div>
        )}
      </Card>

      {/* Record an attempt (write roles only — the API refuses the rest). */}
      {canWrite && (
        <Card className="mb-4">
          <CardHeader
            title="Record a result"
            subtitle="Only an APPROVED registration can be graded. A second attempt on the same course is a retake — the server numbers it."
          />
          <div className="grid grid-cols-1 items-end gap-3 p-5 sm:grid-cols-5">
            <Field label="Student" className="sm:col-span-2">
              <Select value={studentId} onChange={(e) => setStudentId(e.target.value)}>
                {students.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                    {s.admissionNo ? ` (${s.admissionNo})` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Course">
              <Select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                {courses.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.code} — {c.title}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Obtained">
              <TextInput
                type="number"
                min={0}
                step="1"
                value={obtained}
                onChange={(e) => setObtained(e.target.value)}
                placeholder="e.g. 72"
              />
            </Field>
            <Field label="Full marks">
              <TextInput
                type="number"
                min={1}
                step="1"
                value={fullMarks}
                onChange={(e) => setFullMarks(e.target.value)}
              />
            </Field>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-slate-100 px-5 py-3">
            <p className="text-xs text-slate-400">
              The attempt number and the term come from the programme mapping — never typed here.
            </p>
            <button
              className="btn btn-primary"
              onClick={record}
              disabled={recordDisabled({ studentId, courseId, obtained, fullMarks, busy })}
            >
              <Award size={15} /> {recordButtonLabel(busy)}
            </button>
          </div>
        </Card>
      )}

      {/* The recorded results, graded on read. */}
      <Card>
        <CardHeader
          title="Results"
          subtitle={`${resultsCountText(filtered.length)} — each row is one attempt, graded by the scale above`}
          action={
            <Select value={filterStudent} onChange={(e) => setFilterStudent(e.target.value)}>
              <option value="">All students</option>
              {students.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </Select>
          }
        />

        {filtered.length === 0 ? (
          <EmptyState
            icon={Users}
            title="No results recorded yet"
            description={
              canWrite
                ? "Record the first attempt above — a result is a single attempt at a single course."
                : "Nothing has been recorded for this scope yet."
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Student</th>
                  <th className="th">Course</th>
                  <th className="th text-center">Term</th>
                  <th className="th text-center">Attempt</th>
                  <th className="th text-center">Marks</th>
                  <th className="th text-center">Percent</th>
                  <th className="th text-center">Grade</th>
                  {showGpa && <th className="th text-center">Point</th>}
                  <th className="th text-right">Transcript</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r) => (
                  <tr key={r.id} className="tr-hover">
                    <td className="td text-sm font-semibold text-slate-700">
                      {r.studentName || "—"}
                      {r.studentAdmissionNo && <span className="ml-1 text-xs text-slate-400">{r.studentAdmissionNo}</span>}
                    </td>
                    <td className="td text-xs text-slate-600">{courseLabel(r)}</td>
                    <td className="td text-center text-xs text-slate-500">{r.termNumber ?? "—"}</td>
                    <td className="td text-center text-xs text-slate-500">{r.attempt ?? "—"}</td>
                    <td className="td text-center text-xs font-semibold text-slate-700">
                      {r.obtained ?? "—"}
                      <span className="text-slate-400">/{r.fullMarks ?? "—"}</span>
                    </td>
                    <td className="td text-center text-xs text-slate-600">{percentText(r.percent)}</td>
                    <td className="td text-center text-xs">
                      <Badge tone={r.passed === false ? "rose" : "green"}>{gradeText(r.grade)}</Badge>
                    </td>
                    {showGpa && (
                      <td className="td text-center text-xs font-semibold text-slate-600">
                        {formatGpa(r.points, showGpa) ?? "—"}
                      </td>
                    )}
                    <td className="td text-right">
                      <Link href={transcriptHref(r.studentId)} className="btn btn-secondary btn-sm">
                        <Printer size={13} /> Print
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <p className="border-t border-slate-100 px-5 py-3 text-[11px] text-slate-400">
          Grades, points and the CGPA are derived from the active scale when the page is read — nothing is stored frozen.
          Print a student&apos;s transcript to see every attempt with the effective one marked.
        </p>
      </Card>
    </div>
  );
}
