import Link from "next/link";
import type { Metadata } from "next";
import { prisma } from "@/lib/db";
import { getSession } from "@/lib/auth";
import { canAccessBranch } from "@/lib/permissions";
import { collegeGateDecision } from "@/lib/institution";
import { canReadCollegeResults } from "@/lib/college-results-access";
import { loadCollegeScheme, buildStudentTranscript } from "@/lib/college-results-server";
import { fmtDate } from "@/lib/utils";
import { PrintActions } from "@/components/PrintActions";
import {
  attemptStatus,
  attemptSummary,
  formatGpa,
  gradeText,
  hasRetakes,
  percentText,
  policyLine,
  scaleLine,
  showsGpaFigure,
  weightingBasisText,
} from "@/lib/college-results-view";

/**
 * College support (Phase 6d) — the college TRANSCRIPT print page
 * (docs/COLLEGE-DECISIONS.md §23, D-6-12/D-6-14/D-6-16).
 *
 * `src/app/print/college-transcript/[studentId]` — a print route beside the
 * school's `report-card` and `marksheet`, reachable only for a college tenant.
 * It is a SERVER component that renders live data, exactly like those two: no
 * PDF archival, no frozen copy (23.6).
 *
 * **What keeps a DERIVED transcript honest (D-6-12):** because every grade here
 * is recomputed from the tenant's CURRENT scheme at read time, the page prints
 * the scheme's NAME, its SCALE and the PASS MARK, plus the PRINT DATE — so a
 * reader can always tell which policy produced the page, and a re-print after an
 * admin edits a band visibly names the scale now in force.
 *
 * **No GPA is ever printed as 0.00 to mean "not applicable" (D-6-16):** under a
 * `showGpa: false` scheme the point column, the per-term GPA block and the CGPA
 * block are ABSENT (not zeroed), so a printed 0.00 always means a real zero. The
 * figure itself goes through `formatGpa`, which returns `null` — never a number —
 * when there is nothing to show.
 *
 * **Authorization, all below the middleware (which cannot see the tenant shape):**
 * a session is required; the student must belong to the session's tenant (a
 * foreign id is NOT FOUND, never a 403 oracle); the caller must reach the
 * student's branch; the caller must be one of the v1 READ roles — the admin-level
 * roles and the REGISTRAR (`canReadCollegeResults`, the SAME rule the API uses;
 * a TEACHER, GUARDIAN or STUDENT renders nothing, §23.6); and the tenant must be
 * college-capable (`collegeGateDecision`, the pure half of `requireCollege`,
 * which is NextResponse-shaped and so unusable in a page).
 *
 * The 6c READ this page renders is `GET /api/course-results/students/[id]/transcript`;
 * the page calls `buildStudentTranscript` directly, in-process, so a print needs
 * no second round trip and cannot disagree with the API's arithmetic.
 */

export const metadata: Metadata = { title: "College Transcript" };

const NOT_FOUND = <div className="p-10 text-center text-sm text-slate-500">Transcript not found.</div>;
const NO_COLLEGE = (
  <div className="p-10 text-center text-sm text-slate-500">
    This feature is available to college tenants only.
  </div>
);
const NO_ROLE = <div className="p-10 text-center text-sm text-slate-500">Not available for your role.</div>;
const EMPTY = (
  <div className="p-10 text-center text-sm text-slate-500">
    No results have been recorded for this student yet — record an attempt on the college results screen first.
  </div>
);

export default async function CollegeTranscriptPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  // Defence in depth: the URL names a student, so authorize the session here
  // (below the middleware) to stop cross-tenant and cross-branch reads.
  const session = await getSession();
  if (!session) return NOT_FOUND;

  const student: any = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) return NOT_FOUND;
  if (session.role !== "SUPER_ADMIN" && student.schoolId !== session.schoolId) return NOT_FOUND;
  // The tenant gate (D-6-13): a SCHOOL tenant can never render a college page.
  const school: any = await prisma.school.findUnique({ where: { id: student.schoolId } });
  if (collegeGateDecision(school?.institutionType) !== "ALLOW") return NO_COLLEGE;
  // v1 READ access (6d-fix, §23.6): the SAME allow-list the API applies, through
  // the same pure rule — a TEACHER, GUARDIAN or STUDENT renders no transcript at
  // all (never another family's child).
  if (!canReadCollegeResults(session.role)) return NO_ROLE;
  if (!canAccessBranch(session, student.branchId)) return NOT_FOUND;

  // The tenant's OWN COLLEGE scheme, through the ONE resolver (D-6-18) — the
  // full scheme (bands included) so the printed scale line is exact.
  const scheme = await loadCollegeScheme(student.schoolId, student.programId);
  const showGpa = showsGpaFigure(scheme);

  const transcript = await buildStudentTranscript({ schoolId: student.schoolId, studentId });
  // `buildStudentTranscript` returns null only for a student that is not this
  // tenant's, which the checks above already excluded — so this is defensive.
  if (!transcript) return NOT_FOUND;

  const printDate = fmtDate(new Date(transcript.generatedAt));
  const { student: s, terms, totals } = transcript;
  const hasAnyResult = terms.some((t) => t.courses.length > 0);
  if (!hasAnyResult) return EMPTY;

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-4xl">
        <div className="no-print mb-4 flex items-center justify-between">
          <Link href="/dashboard/college-results" className="btn btn-secondary btn-sm">
            ← College Results
          </Link>
          <PrintActions
            targetId="college-transcript"
            fileName={`CollegeTranscript-${s.admissionNo || s.id}-${printDate}`}
          />
        </div>

        <div id="college-transcript" className="print-card overflow-hidden rounded-2xl bg-white shadow-2xl">
          {/* institution header — name, the scale in force, and the print date */}
          <div className="border-b-4 border-indigo-600 bg-slate-900 px-8 py-6 text-center text-white">
            <div className="text-xl font-black tracking-tight">{school?.name || "College"}</div>
            {school?.tagline && <div className="text-xs text-slate-300">{school.tagline}</div>}
            <div className="mt-1 text-[11px] text-slate-400">
              {[school?.address, school?.phone].filter(Boolean).join(" · ")}
            </div>
            <div className="mx-auto mt-3 inline-block rounded-full bg-indigo-600 px-4 py-1 text-xs font-extrabold uppercase tracking-widest">
              College Transcript
            </div>
          </div>

          {/* student + programme + the scale lines the ruling requires (D-6-14) */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 px-8 py-5 text-xs sm:grid-cols-4">
            {[
              ["Student", s.name],
              ["Admission No", s.admissionNo || "—"],
              ["Programme", s.programName || "—"],
              ["Degree level", s.degreeLevel || "—"],
              ["Scale", scheme.name],
              ["", scaleLine(scheme)],
              ["Pass mark", `${scheme.passPercent}%`],
              ["Printed", printDate],
            ].map(([k, v], i) => (
              <div key={`${k}-${i}`} className="border-b border-slate-100 pb-1.5">
                <div className="font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                <div className="mt-0.5 font-bold text-slate-800">{v}</div>
              </div>
            ))}
          </div>

          {/* per-term body — a course the student has a RESULT for, nothing fabricated (D-6-15) */}
          {terms.map((term) => (
            <div key={term.termNumber} className="px-8 py-4">
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-black text-slate-800">{term.label}</span>
                {showGpa && (
                  <span className="text-xs font-semibold text-slate-500">
                    Term GPA: <span className="font-black text-slate-700">{formatGpa(term.gpa, showGpa) ?? "—"}</span>
                  </span>
                )}
              </div>
              <table className="w-full border-collapse text-sm">
                <thead>
                  <tr className="bg-indigo-50 text-[10px] uppercase tracking-wider text-indigo-700">
                    <th className="rounded-l-lg px-3 py-2 text-left font-bold">Code</th>
                    <th className="px-3 py-2 text-left font-bold">Course</th>
                    <th className="px-3 py-2 text-center font-bold">Credit</th>
                    <th className="px-3 py-2 text-center font-bold">Attempts</th>
                    <th className="px-3 py-2 text-center font-bold">Marks</th>
                    <th className="px-3 py-2 text-center font-bold">Percent</th>
                    <th className="px-3 py-2 text-center font-bold">Grade</th>
                    {showGpa && <th className="rounded-r-lg px-3 py-2 text-center font-bold">Point</th>}
                  </tr>
                </thead>
                <tbody>
                  {term.courses.map((course) => (
                    <tr key={course.courseId} className="border-b border-slate-100 align-top">
                      <td className="px-3 py-2.5 font-semibold text-slate-700">{course.courseCode || "—"}</td>
                      <td className="px-3 py-2.5 text-slate-600">
                        {course.available ? course.courseTitle || "—" : `${course.courseTitle || "Unavailable course"}`}
                        {/* A retaken course lists EVERY attempt with the effective one
                            marked and the rest visibly superseded (Q3/D-6-8). */}
                        {hasRetakes(course.attempts) ? (
                          <ul className="mt-1 space-y-0.5">
                            {course.attempts.map((a) => (
                              <li
                                key={a.attempt}
                                className={`text-[10px] font-semibold ${
                                  a.effective ? "text-emerald-700" : "text-slate-400"
                                }`}
                              >
                                {attemptSummary(a)}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          course.attempts.length === 1 && (
                            <div className="mt-1 text-[10px] font-semibold text-slate-400">
                              {attemptStatus(course.attempts[0])}
                            </div>
                          )
                        )}
                        {course.overLimit && (
                          <div className="mt-1 text-[10px] font-bold text-amber-600">
                            Attempts on file exceed the tenant&apos;s retake limit
                          </div>
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-center text-slate-500">
                        {course.creditHours ?? "—"}
                      </td>
                      <td className="px-3 py-2.5 text-center text-xs text-slate-500">{course.attempts.length}</td>
                      <td className="px-3 py-2.5 text-center text-xs text-slate-500">
                        {course.attempts.length ? `${attemptMarks(course.attempts)}` : "—"}
                      </td>
                      <td className="px-3 py-2.5 text-center font-semibold text-slate-700">{percentText(course.percent)}</td>
                      <td className="px-3 py-2.5 text-center">
                        <span
                          className={`rounded-md px-2 py-0.5 font-bold ${
                            course.passed === false ? "bg-rose-50 text-rose-600" : "bg-indigo-50 text-indigo-700"
                          }`}
                        >
                          {gradeText(course.grade)}
                        </span>
                      </td>
                      {showGpa && (
                        <td className="px-3 py-2.5 text-center font-semibold text-slate-600">
                          {formatGpa(course.points, showGpa) ?? "—"}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}

          {/* footer — CGPA (only when shown), pass/fail tallies, and the scheme footer */}
          <div className="mx-8 mt-2 flex flex-wrap gap-3">
            {showGpa && (
              <div className="flex-1 rounded-xl bg-emerald-50 px-4 py-3 text-center">
                <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-600">Cumulative GPA</div>
                <div className="text-xl font-black text-emerald-700">{formatGpa(transcript.cgpa, showGpa) ?? "—"}</div>
                <div className="text-[10px] font-semibold text-emerald-600/70">out of {scheme.gpaScale.toFixed(2)}</div>
              </div>
            )}
            <div className="flex-1 rounded-xl bg-slate-50 px-4 py-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-slate-500">Courses</div>
              <div className="text-xl font-black text-slate-700">{totals.courses}</div>
              <div className="text-[10px] font-semibold text-slate-400">{totals.attempts} attempt(s)</div>
            </div>
            <div
              className={`flex-1 rounded-xl px-4 py-3 text-center ${totals.failed ? "bg-rose-50" : "bg-emerald-50"}`}
            >
              <div
                className={`text-[10px] font-bold uppercase tracking-wide ${
                  totals.failed ? "text-rose-600" : "text-emerald-600"
                }`}
              >
                Result
              </div>
              <div className={`text-xl font-black ${totals.failed ? "text-rose-700" : "text-emerald-700"}`}>
                {totals.failed ? `${totals.failed} failed` : "All passed"}
              </div>
              <div
                className={`text-[10px] font-semibold ${totals.failed ? "text-rose-600/70" : "text-emerald-600/70"}`}
              >
                pass mark {scheme.passPercent}%
              </div>
            </div>
          </div>

          {/* the scheme footer — name, scale and pass mark, per D-6-14 */}
          <div className="mx-8 mt-4 rounded-xl bg-slate-50 p-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              <span>Grading scale — {scheme.name}</span>
              <span>
                {scaleLine(scheme)} · Pass mark {scheme.passPercent}%
              </span>
            </div>
            {weightingBasisText(transcript.weightingBasis) && (
              <p className="mt-1 text-[10px] text-slate-400">
                Cumulative GPA: {weightingBasisText(transcript.weightingBasis)} · {policyLine(transcript.retake)}
              </p>
            )}
          </div>

          <div className="border-t border-slate-100 px-8 py-3 text-center text-[10px] text-slate-400">
            Computer-generated transcript · printed {printDate} · every grade is recomputed from the scale in force at
            print time — editing a band re-grades this page with no re-entry.
          </div>
        </div>
      </div>
    </div>
  );
}

/** `70/100, 64/100` — every stored attempt's marks, in attempt order. */
function attemptMarks(attempts: { obtained: number; fullMarks: number }[]): string {
  return attempts.map((a) => `${a.obtained}/${a.fullMarks}`).join(", ");
}
