import Link from "next/link";
import { prisma } from "@/lib/db";
import { getSession, guardianOwnsStudent } from "@/lib/auth";
import { bandForPercent, bandLabel, gpaOfScheme, gradeForScheme, resolveExamColumns } from "@/lib/grading";
import { loadScheme } from "@/lib/grading-store";
import { positions } from "@/lib/grades";
import { fmtDate } from "@/lib/utils";
import { PrintActions } from "@/components/PrintActions";

const NOT_FOUND = <div className="p-10 text-center text-sm text-slate-500">Marksheet not found.</div>;
const EMPTY = <div className="p-10 text-center text-sm text-slate-500">No marks have been recorded for this student yet.</div>;

/** One subject's line on one exam's sheet, already graded. */
interface SheetMark {
  subjectId: string;
  obtained: number;
  full: number;
  grade: string;
  gpa: number;
  pass: boolean;
}

interface ExamSheet {
  id: string;
  name: string;
  year: number;
  /** "13 Jul – 23 Jul 2026" — printed under the exam's name. */
  dates: string;
  published: boolean;
  /** subjectId → graded mark, for the classes/every-one-on-this-sheet lookup. */
  bySubject: Map<string, SheetMark>;
  /** Every subject this exam is marked out of, in catalogue order. */
  subjectIds: string[];
  total: number;
  fullTotal: number;
  percent: number;
  gpa: number;
  position: number;
  rankOf: number;
  failed: number;
}

/**
 * The student's marksheet — the subject-wise document a family keeps.
 *
 * Where the report card answers "how did my child do this term", this answers
 * "what marks did they get, subject by subject, all year": one column per exam
 * of the class, a row per subject, and the year total beside it. Every grade,
 * grade point and GPA here is recomputed from the school's own grading scheme
 * (see /dashboard/grades) at read time, so editing a band re-letters this sheet
 * too — the same rule the report card and the marks-sheet entry follow.
 */
export default async function MarksheetPage({ params }: { params: Promise<{ studentId: string }> }) {
  const { studentId } = await params;
  // Defence in depth: the URL names a student, so authorize the session here
  // (below the middleware) to stop cross-school and cross-family reads.
  const session = await getSession();
  if (!session) return NOT_FOUND;

  const student = await prisma.student.findUnique({
    where: { id: studentId },
    include: { classRoom: { select: { name: true } }, section: { select: { name: true } } },
  });
  if (!student) return NOT_FOUND;
  if (session.role !== "SUPER_ADMIN" && student.schoolId !== session.schoolId) return NOT_FOUND;
  // An unplaced student (alumni, or an admission still being filed) has no class
  // to rank within, so there is no marksheet to print yet.
  if (!student.classId) return EMPTY;

  // PRD §7.2 — a guardian may open only their own child's marksheet (or a sibling's,
  // which is the same household), and only the terms the school has published.
  const isGuardian = session.role === "GUARDIAN";
  if (isGuardian && !(await guardianOwnsStudent(session, student))) return NOT_FOUND;

  const school = await prisma.school.findUnique({ where: { id: student.schoolId } });
  const scheme = await loadScheme(student.schoolId);

  const examRows = await prisma.exam.findMany({
    where: {
      schoolId: student.schoolId,
      classId: student.classId,
      ...(student.sectionId ? { sectionId: student.sectionId } : {}),
      ...(isGuardian ? { published: true } : {}),
    },
    orderBy: { startDate: "asc" },
  });
  if (!examRows.length) return EMPTY;

  const subjects = await prisma.subject.findMany({ where: { schoolId: student.schoolId } });
  const subjectName = new Map(subjects.map((s: any) => [s.id as string, s.name as string]));
  const catalogue = subjects.map((s: any) => ({ id: s.id as string, name: s.name as string }));

  // Who is actually ranked: the class (and section) the exam was sat in, the same
  // roster the exam sheet lists. Ranking by "whoever has a mark" would let a
  // stray mark left by another section inflate every classmate's position.
  const roster = await prisma.student.findMany({
    where: {
      schoolId: student.schoolId,
      classId: student.classId,
      ...(student.sectionId ? { sectionId: student.sectionId } : {}),
    },
  });
  const rosterIds = new Set(roster.map((s: any) => s.id as string));

  // One read for the whole year's marks: it also carries the classmates, which
  // is what lets the sheet print a position without a second round per exam.
  const allMarks = await prisma.examMark.findMany({
    where: { examId: { in: examRows.map((e: any) => e.id) } },
  });
  const marksByExam = new Map<string, any[]>();
  for (const m of allMarks) {
    const list = marksByExam.get(m.examId);
    if (list) list.push(m);
    else marksByExam.set(m.examId, [m]);
  }

  const sheets: ExamSheet[] = [];
  for (const exam of examRows) {
    const marks = marksByExam.get(exam.id) || [];
    if (!marks.length) continue; // an exam nobody has been marked on yet prints nothing

    // This exam's sheet: its declared columns, or every subject out of 100.
    const columns = resolveExamColumns(exam.columns, catalogue);
    const columnIds = columns.map((c) => c.id);
    const onSheet = new Set(columnIds);

    const grade = (m: any): SheetMark => {
      const g = gradeForScheme(scheme, Number(m.obtained), Number(m.fullMarks));
      return {
        subjectId: m.subjectId,
        obtained: Number(m.obtained),
        full: Number(m.fullMarks),
        grade: g.grade,
        gpa: g.gpa,
        pass: g.pass,
      };
    };

    const mine = marks.filter((m: any) => m.studentId === studentId && onSheet.has(m.subjectId)).map(grade);
    const bySubject = new Map(mine.map((m) => [m.subjectId, m]));
    const total = mine.reduce((a, m) => a + m.obtained, 0);
    const fullTotal = mine.reduce((a, m) => a + m.full, 0);

    // Position among classmates, ranked on this exam's total. Only students who
    // actually sat the sheet are ranked, so an unmarked row never takes a place.
    const classTotals = new Map<string, number>();
    for (const m of marks) {
      if (!onSheet.has(m.subjectId) || !rosterIds.has(m.studentId)) continue;
      classTotals.set(m.studentId, (classTotals.get(m.studentId) || 0) + Number(m.obtained));
    }
    const totals = [...classTotals.values()];
    const ranked = positions(totals);

    const end = exam.endDate || exam.startDate;
    sheets.push({
      id: exam.id,
      name: exam.name,
      year: exam.year,
      dates: exam.startDate ? `${fmtDate(exam.startDate)}${end ? ` – ${fmtDate(end)}` : ""}` : "",
      published: !!exam.published,
      bySubject,
      subjectIds: columnIds,
      total,
      fullTotal,
      percent: fullTotal > 0 ? (total / fullTotal) * 100 : 0,
      gpa: gpaOfScheme(scheme, mine.map((m) => m.gpa)),
      // `positions` maps a total to its rank, so two equal totals share a place.
      position: classTotals.has(studentId) ? ranked.get(classTotals.get(studentId)!) || 0 : 0,
      rankOf: totals.length,
      failed: mine.filter((m) => !m.pass).length,
    });
  }
  if (!sheets.length) return EMPTY;
  const unpublished = sheets.filter((s) => !s.published).length;

  // Subject rows: every subject marked on any exam of the year, in the order the
  // school keeps its catalogue, so the same subject always sits on the same row.
  const rowIds = catalogue.map((s) => s.id).filter((id) => sheets.some((s) => s.bySubject.has(id)));

  // Year figures — the sum of every subject mark across every exam.
  const year = sheets[sheets.length - 1].year;
  const yearObtained = sheets.reduce((a, s) => a + s.total, 0);
  const yearFull = sheets.reduce((a, s) => a + s.fullTotal, 0);
  const yearPercent = yearFull > 0 ? (yearObtained / yearFull) * 100 : 0;
  const allPoints = sheets.flatMap((s) => [...s.bySubject.values()].map((m) => m.gpa));
  const yearGpa = gpaOfScheme(scheme, allPoints);
  const yearFailed = sheets.reduce((a, s) => a + s.failed, 0);

  // Year position: the same addition for every classmate who sat any exam.
  const yearTotals = new Map<string, number>();
  for (const s of sheets) {
    for (const mark of marksByExam.get(s.id) || []) {
      // Only marks that belong on this exam's sheet count, exactly as above — a
      // mark left behind by a subject the school dropped must not score.
      if (!s.subjectIds.includes(mark.subjectId) || !rosterIds.has(mark.studentId)) continue;
      yearTotals.set(mark.studentId, (yearTotals.get(mark.studentId) || 0) + Number(mark.obtained));
    }
  }
  const yearRanked = positions([...yearTotals.values()]);
  const yearPosition = yearTotals.has(studentId) ? yearRanked.get(yearTotals.get(studentId)!) || 0 : 0;
  const yearRankOf = yearTotals.size;

  const bandRemark = yearFailed
    ? bandForPercent(scheme, 0).remark
    : bandForPercent(scheme, yearPercent).remark;

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-4xl">
        <div className="no-print mb-4 flex items-center justify-between">
          <Link href={isGuardian ? "/parent" : `/dashboard/students/${student.id}`} className="btn btn-secondary btn-sm">
            ← {isGuardian ? "Dashboard" : "Student"}
          </Link>
          <PrintActions targetId="marksheet" fileName={`Marksheet-${student.admissionNo}-${year}`} />
        </div>

        <div id="marksheet" className="print-card overflow-hidden rounded-2xl bg-white shadow-2xl">
          {/* school header */}
          <div className="border-b-4 border-indigo-600 bg-slate-900 px-8 py-6 text-center text-white">
            <div className="text-xl font-black tracking-tight">{school?.name || "School"}</div>
            {school?.tagline && <div className="text-xs text-slate-300">{school.tagline}</div>}
            <div className="mt-1 text-[11px] text-slate-400">
              {[school?.address, school?.phone].filter(Boolean).join(" · ")}
            </div>
            <div className="mx-auto mt-3 inline-block rounded-full bg-indigo-600 px-4 py-1 text-xs font-extrabold uppercase tracking-widest">
              Academic Marksheet · {year}
            </div>
          </div>

          {/* student info */}
          <div className="flex items-start gap-6 px-8 py-5">
            <div className="flex h-20 w-20 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-slate-100 text-lg font-black text-slate-400 ring-2 ring-slate-100">
              {student.photoUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={student.photoUrl} alt="" className="h-full w-full object-cover" />
              ) : (
                student.name.split(" ").map((p: string) => p[0]).slice(0, 2).join("").toUpperCase()
              )}
            </div>
            <div className="grid flex-1 grid-cols-2 gap-x-8 gap-y-2 text-xs sm:grid-cols-3">
              {[
                ["Student", student.name],
                ["Student ID", student.admissionNo],
                ["Class", `${student.classRoom?.name || "—"}${student.section ? ` / Section ${student.section.name}` : ""}`],
                ["Roll", student.roll?.toString() || "—"],
                ["Guardian", student.guardianName || "—"],
                ["Exams taken", sheets.map((s) => s.name.replace(/ Examination.*/, "")).join(", ") || "—"],
              ].map(([k, v]) => (
                <div key={k} className="border-b border-slate-100 pb-1.5">
                  <div className="font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                  <div className="mt-0.5 font-bold text-slate-800">{v}</div>
                </div>
              ))}
            </div>
          </div>

          {/* the subject-wise grid: subjects down, exams across */}
          <div className="px-8">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="bg-indigo-50 text-[10px] uppercase tracking-wider text-indigo-700">
                  <th className="rounded-l-lg px-3 py-2 text-left font-bold">Subject</th>
                  {sheets.map((s) => (
                    <th key={s.id} className="border-l border-white/70 px-2 py-2 text-center font-bold">
                      <div>{s.name}</div>
                      <div className="mt-0.5 font-semibold normal-case tracking-normal text-indigo-400">
                        {s.dates}
                        {s.published ? "" : " · draft"}
                      </div>
                    </th>
                  ))}
                  <th className="rounded-r-lg border-l-2 border-white bg-indigo-100 px-2 py-2 text-center font-bold">
                    Year total
                  </th>
                </tr>
              </thead>
              <tbody>
                {rowIds.map((sid) => {
                  const cells = sheets.map((s) => s.bySubject.get(sid));
                  const obt = cells.reduce((a, c) => a + (c?.obtained || 0), 0);
                  const full = cells.reduce((a, c) => a + (c?.full || 0), 0);
                  const yearGrade = full > 0 ? gradeForScheme(scheme, obt, full) : null;
                  return (
                    <tr key={sid} className="border-b border-slate-100">
                      <td className="px-3 py-2 font-semibold text-slate-700">{subjectName.get(sid) || "—"}</td>
                      {sheets.map((s) => {
                        const m = s.bySubject.get(sid);
                        return (
                          <td key={s.id} className="border-l border-slate-100 px-2 py-2 text-center">
                            {m ? (
                              <div>
                                <div className="font-bold text-slate-800">
                                  {m.obtained}
                                  <span className="text-[10px] font-medium text-slate-400">/{m.full}</span>
                                </div>
                                <div
                                  className={`mt-0.5 inline-block rounded px-1.5 text-[10px] font-bold ${
                                    m.pass ? "bg-indigo-50 text-indigo-700" : "bg-rose-50 text-rose-600"
                                  }`}
                                >
                                  {m.grade}
                                </div>
                              </div>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                        );
                      })}
                      <td className="border-l-2 border-slate-100 bg-slate-50 px-2 py-2 text-center">
                        {yearGrade ? (
                          <div>
                            <div className="font-bold text-slate-800">
                              {obt}
                              <span className="text-[10px] font-medium text-slate-400">/{full}</span>
                            </div>
                            <div className="mt-0.5 text-[10px] font-bold text-slate-500">
                              {Math.round((obt / full) * 100)}% · {yearGrade.grade}
                            </div>
                          </div>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
                <tr className="border-t-2 border-slate-200 font-black text-slate-900">
                  <td className="px-3 py-2.5">Total</td>
                  {sheets.map((s) => (
                    <td key={s.id} className="border-l border-slate-100 px-2 py-2.5 text-center">
                      <div>
                        {s.total}
                        <span className="text-[10px] font-medium text-slate-400">/{s.fullTotal}</span>
                      </div>
                      <div className="mt-0.5 text-[10px] font-bold text-slate-500">
                        {Math.round(s.percent)}% · GPA {s.gpa.toFixed(2)}
                      </div>
                    </td>
                  ))}
                  <td className="border-l-2 border-slate-100 bg-slate-50 px-2 py-2.5 text-center">
                    <div>
                      {yearObtained}
                      <span className="text-[10px] font-medium text-slate-400">/{yearFull}</span>
                    </div>
                    <div className="mt-0.5 text-[10px] font-bold text-slate-500">{Math.round(yearPercent)}%</div>
                  </td>
                </tr>
              </tbody>
            </table>
            <p className="mt-2 text-[10px] text-slate-400">
              Each cell reads <span className="font-bold text-slate-500">marks obtained / full marks</span>, with the
              grade that percentage earns under {scheme.name}. A dash means the subject was not on that exam&apos;s sheet.
            </p>
          </div>

          {/* year summary */}
          <div className="mx-8 mt-5 flex flex-wrap gap-3">
            <div className="flex-1 rounded-xl bg-emerald-50 px-4 py-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-600">Cumulative GPA</div>
              <div className="text-xl font-black text-emerald-700">{yearGpa.toFixed(2)}</div>
              <div className="text-[10px] font-semibold text-emerald-600/70">out of {scheme.gpaScale.toFixed(2)}</div>
            </div>
            <div className="flex-1 rounded-xl bg-amber-50 px-4 py-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-amber-600">Year percentage</div>
              <div className="text-xl font-black text-amber-700">{Math.round(yearPercent)}%</div>
              <div className="text-[10px] font-semibold text-amber-600/70">
                {yearObtained} of {yearFull}
              </div>
            </div>
            <div className="flex-1 rounded-xl bg-indigo-50 px-4 py-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-indigo-600">Position</div>
              <div className="text-xl font-black text-indigo-700">
                {yearPosition > 0 ? ordinal(yearPosition) : "—"}
                <span className="text-xs font-semibold text-indigo-400"> / {yearRankOf}</span>
              </div>
              <div className="text-[10px] font-semibold text-indigo-600/70">on the year total</div>
            </div>
            <div
              className={`flex-1 rounded-xl px-4 py-3 text-center ${
                yearFailed ? "bg-rose-50" : "bg-emerald-50"
              }`}
            >
              <div className={`text-[10px] font-bold uppercase tracking-wide ${yearFailed ? "text-rose-600" : "text-emerald-600"}`}>
                Result
              </div>
              <div className={`text-xl font-black ${yearFailed ? "text-rose-700" : "text-emerald-700"}`}>
                {yearFailed ? `${yearFailed} failed` : "Passed"}
              </div>
              <div className={`text-[10px] font-semibold ${yearFailed ? "text-rose-600/70" : "text-emerald-600/70"}`}>
                pass mark {scheme.passPercent}%
              </div>
            </div>
          </div>

          {/* term-by-term summary */}
          <div className="mx-8 mt-5">
            <div className="mb-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">Term summary</div>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] uppercase tracking-wider text-slate-400">
                  <th className="px-2 py-1.5 text-left font-bold">Exam</th>
                  <th className="px-2 py-1.5 text-center font-bold">Total</th>
                  <th className="px-2 py-1.5 text-center font-bold">Percent</th>
                  <th className="px-2 py-1.5 text-center font-bold">GPA</th>
                  <th className="px-2 py-1.5 text-center font-bold">Position</th>
                  <th className="px-2 py-1.5 text-center font-bold">Result</th>
                </tr>
              </thead>
              <tbody>
                {sheets.map((s) => (
                  <tr key={s.id} className="border-t border-slate-100">
                    <td className="px-2 py-1.5 font-semibold text-slate-700">
                      {s.name}
                      {!s.published && <span className="ml-1 text-[10px] font-bold text-amber-600">(unpublished)</span>}
                    </td>
                    <td className="px-2 py-1.5 text-center text-slate-600">
                      {s.total}/{s.fullTotal}
                    </td>
                    <td className="px-2 py-1.5 text-center text-slate-600">{Math.round(s.percent)}%</td>
                    <td className="px-2 py-1.5 text-center font-bold text-slate-700">{s.gpa.toFixed(2)}</td>
                    <td className="px-2 py-1.5 text-center text-slate-600">
                      {s.position > 0 ? `${ordinal(s.position)} / ${s.rankOf}` : "—"}
                    </td>
                    <td className={`px-2 py-1.5 text-center font-bold ${s.failed ? "text-rose-600" : "text-emerald-600"}`}>
                      {s.failed ? `${s.failed} failed` : "Passed"}
                    </td>
                  </tr>
                ))}
                <tr className="border-t-2 border-slate-200 font-black text-slate-900">
                  <td className="px-2 py-1.5">Year</td>
                  <td className="px-2 py-1.5 text-center">
                    {yearObtained}/{yearFull}
                  </td>
                  <td className="px-2 py-1.5 text-center">{Math.round(yearPercent)}%</td>
                  <td className="px-2 py-1.5 text-center">{yearGpa.toFixed(2)}</td>
                  <td className="px-2 py-1.5 text-center">
                    {yearPosition > 0 ? `${ordinal(yearPosition)} / ${yearRankOf}` : "—"}
                  </td>
                  <td className={`px-2 py-1.5 text-center ${yearFailed ? "text-rose-700" : "text-emerald-700"}`}>
                    {yearFailed ? `${yearFailed} failed` : "Passed"}
                  </td>
                </tr>
              </tbody>
            </table>
            {unpublished > 0 && !isGuardian && (
              <p className="mt-2 text-[10px] font-semibold text-amber-600">
                {unpublished} of these {sheets.length} exams {unpublished === 1 ? "is" : "are"} unpublished — guardians
                and students see only published terms.
              </p>
            )}
          </div>

          {/* grading scale — the school's own bands */}
          <div className="mx-8 mt-5 rounded-xl bg-slate-50 p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2 text-[10px] font-bold uppercase tracking-wide text-slate-500">
              <span>Grading scale — {scheme.name}</span>
              <span>
                Pass mark {scheme.passPercent}% · GPA out of {scheme.gpaScale.toFixed(2)}
                {scheme.failCapsGpa ? " · a failure makes the GPA 0" : ""}
              </span>
            </div>
            <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-[10px] text-slate-500 sm:grid-cols-2">
              {scheme.bands.map((band) => (
                <div key={band.grade} className="flex items-baseline justify-between gap-2">
                  <span className="shrink-0">
                    <span className="font-bold text-slate-600">{band.grade}</span> {bandLabel(band)}
                  </span>
                  <span className="shrink-0 font-bold text-slate-600">{band.gpa.toFixed(2)}</span>
                  <span className="min-w-0 flex-1 truncate text-right text-slate-400">{band.remark || ""}</span>
                </div>
              ))}
            </div>
          </div>

          {/* remarks & signatures */}
          <div className="flex flex-wrap items-end justify-between gap-6 px-8 py-8">
            <div className="max-w-xs text-xs text-slate-500">
              <div className="font-bold uppercase tracking-wide text-slate-400">Class Teacher&apos;s Remarks</div>
              <p className="mt-2 italic">
                {bandRemark || (yearFailed ? "Needs significant improvement." : "A satisfactory year. Keep up the effort.")}
              </p>
            </div>
            <div className="flex gap-12 text-center text-[10px] font-semibold text-slate-400">
              <div>
                <div className="mb-8 border-b border-slate-300 px-6" />
                Class teacher
              </div>
              <div>
                <div className="mb-8 border-b border-slate-300 px-6" />
                Guardian signature
              </div>
              <div>
                <div className="mb-8 border-b border-slate-300 px-6" />
                Principal signature
              </div>
            </div>
          </div>

          <div className="border-t border-slate-100 px-8 py-3 text-center text-[10px] text-slate-400">
            Computer-generated marksheet · {fmtDate(new Date())} · The overall GPA is the average of the subject grade
            points, capped at {scheme.gpaScale.toFixed(2)}
            {scheme.failCapsGpa ? ", and a single failed subject makes it 0." : "."}
          </div>
        </div>
      </div>
    </div>
  );
}

function ordinal(n: number): string {
  const suffix = n === 1 ? "st" : n === 2 ? "nd" : n === 3 ? "rd" : "th";
  return `${n}${suffix}`;
}
