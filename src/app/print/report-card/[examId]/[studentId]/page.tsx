import Link from "next/link";
import { prisma } from "@/lib/db";
import { gpaOf } from "@/lib/grades";
import { fmtDate, classOf } from "@/lib/utils";
import { PrintActions } from "@/components/PrintActions";

export default async function ReportCardPage({ params }: { params: Promise<{ examId: string; studentId: string }> }) {
  const { examId, studentId } = await params;

  const [exam, student] = await Promise.all([
    prisma.exam.findUnique({
      where: { id: examId },
      include: { classRoom: { select: { name: true } }, section: { select: { name: true } }, school: { select: { name: true, logoUrl: true, address: true, phone: true, email: true, tagline: true } } },
    }),
    prisma.student.findUnique({
      where: { id: studentId },
      include: { classRoom: { select: { name: true } }, section: { select: { name: true } } },
    }),
  ]);

  if (!exam || !student) {
    return <div className="p-10 text-center text-sm text-slate-500">Report card not found.</div>;
  }

  const marks = await prisma.examMark.findMany({
    where: { examId, studentId },
    include: { subject: { select: { name: true } } },
    orderBy: { subject: { name: "asc" } },
  });

  const attendanceRows = await prisma.attendance.findMany({ where: { studentId } });
  const present = attendanceRows.filter((a) => a.status === "PRESENT" || a.status === "LATE").length;
  const attendancePct = attendanceRows.length ? Math.round((present / attendanceRows.length) * 100) : 0;

  const marksOut = marks.map((m) => ({ name: m.subject.name, full: m.fullMarks, obtained: Number(m.obtained), grade: m.grade || "—", gpa: Number(m.gradePoint || 0) }));
  const totalObtained = marksOut.reduce((a, m) => a + m.obtained, 0);
  const totalFull = marksOut.reduce((a, m) => a + m.full, 0);
  const gpa = gpaOf(marksOut.map((m) => m.gpa));

  const allStudents = await prisma.examMark.findMany({
    where: { examId },
    select: { studentId: true, obtained: true },
  });
  const totals = allStudents.reduce<Record<string, number>>((acc, m) => {
    acc[m.studentId] = (acc[m.studentId] || 0) + Number(m.obtained);
    return acc;
  }, {});
  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const position = sorted.findIndex(([sid]) => sid === studentId) + 1;
  const totalStudents = sorted.length;

  return (
    <div className="min-h-screen bg-slate-100 p-6">
      <div className="mx-auto max-w-3xl">
        <div className="no-print mb-4 flex items-center justify-between">
          <Link href="/parent" className="btn btn-secondary btn-sm">← Dashboard</Link>
          <PrintActions targetId="report-card" fileName={`ReportCard-${student.admissionNo}-${exam.name}`} />
        </div>

        <div id="report-card" className="print-card overflow-hidden rounded-2xl bg-white shadow-2xl">
          {/* school header */}
          <div className="border-b-4 border-indigo-600 bg-slate-900 px-8 py-6 text-center text-white">
            <div className="text-xl font-black tracking-tight">{exam.school.name}</div>
            {exam.school.tagline && <div className="text-xs text-slate-300">{exam.school.tagline}</div>}
            <div className="mt-1 text-[11px] text-slate-400">{exam.school.address} · {exam.school.phone}</div>
            <div className="mx-auto mt-3 inline-block rounded-full bg-indigo-600 px-4 py-1 text-xs font-extrabold uppercase tracking-widest">
              {exam.name} Report Card
            </div>
          </div>

          {/* student info */}
          <div className="grid grid-cols-2 gap-x-8 gap-y-2 px-8 py-5 text-xs sm:grid-cols-4">
            {[
              ["Student", student.name],
              ["Student ID", student.admissionNo],
              ["Class", `${student.classRoom?.name || "—"} ${student.section ? `/ ${student.section.name}` : ""}`],
              ["Roll", student.roll?.toString() || "—"],
              ["Guardian", student.guardianName || "—"],
              ["Blood Group", (student.bloodGroup || "—").replace("_", "+")],
              ["Published", exam.publishedAt ? fmtDate(exam.publishedAt) : fmtDate(exam.endDate || exam.startDate)],
              ["Attendance", `${attendancePct}% (${present}/${attendanceRows.length})`],
            ].map(([k, v]) => (
              <div key={k} className="border-b border-slate-100 pb-1.5">
                <div className="font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                <div className="mt-0.5 font-bold text-slate-800">{v}</div>
              </div>
            ))}
          </div>

          {/* marks table */}
          <div className="px-8">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-indigo-50 text-xs uppercase tracking-wider text-indigo-700">
                  <th className="rounded-l-lg px-3 py-2 text-left font-bold">Subject</th>
                  <th className="px-3 py-2 text-center font-bold">Full Marks</th>
                  <th className="px-3 py-2 text-center font-bold">Obtained</th>
                  <th className="px-3 py-2 text-center font-bold">Grade</th>
                  <th className="rounded-r-lg px-3 py-2 text-center font-bold">GPA</th>
                </tr>
              </thead>
              <tbody>
                {marksOut.map((m) => (
                  <tr key={m.name} className="border-b border-slate-100">
                    <td className="px-3 py-2.5 font-semibold text-slate-700">{m.name}</td>
                    <td className="px-3 py-2.5 text-center text-slate-500">{m.full}</td>
                    <td className="px-3 py-2.5 text-center font-bold text-slate-800">{m.obtained}</td>
                    <td className="px-3 py-2.5 text-center">
                      <span className="rounded-md bg-indigo-50 px-2 py-0.5 font-bold text-indigo-700">{m.grade}</span>
                    </td>
                    <td className="px-3 py-2.5 text-center font-semibold text-slate-600">{m.gpa.toFixed(2)}</td>
                  </tr>
                ))}
                <tr className="font-black text-slate-900">
                  <td className="px-3 py-2.5">Total</td>
                  <td className="px-3 py-2.5 text-center">{totalFull}</td>
                  <td className="px-3 py-2.5 text-center">{totalObtained}</td>
                  <td className="px-3 py-2.5 text-center" />
                  <td className="px-3 py-2.5 text-center">{gpa.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* result summary */}
          <div className="mx-8 mt-5 flex flex-wrap gap-3">
            <div className="flex-1 rounded-xl bg-emerald-50 px-4 py-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-emerald-600">GPA</div>
              <div className="text-xl font-black text-emerald-700">{gpa.toFixed(2)}</div>
            </div>
            <div className="flex-1 rounded-xl bg-indigo-50 px-4 py-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-indigo-600">Position</div>
              <div className="text-xl font-black text-indigo-700">
                {position > 0 ? `${position}${position === 1 ? "st" : position === 2 ? "nd" : position === 3 ? "rd" : "th"}` : "—"}
                <span className="text-xs font-semibold text-indigo-400"> / {totalStudents}</span>
              </div>
            </div>
            <div className="flex-1 rounded-xl bg-amber-50 px-4 py-3 text-center">
              <div className="text-[10px] font-bold uppercase tracking-wide text-amber-600">Percentage</div>
              <div className="text-xl font-black text-amber-700">{totalFull ? Math.round((totalObtained / totalFull) * 100) : 0}%</div>
            </div>
          </div>

          {/* grade scale */}
          <div className="mx-8 mt-5 grid grid-cols-2 gap-x-6 gap-y-1 rounded-xl bg-slate-50 p-4 text-[10px] text-slate-500 sm:grid-cols-4">
            {[
              ["80–100", "A+ (5.00)"],
              ["70–79", "A (4.00)"],
              ["60–69", "A- (3.50)"],
              ["50–59", "B (3.00)"],
              ["40–49", "C (2.00)"],
              ["33–39", "D (1.00)"],
              ["0–32", "F (0.00)"],
            ].map(([r, g]) => (
              <div key={r} className="flex justify-between">
                <span>{r}</span>
                <span className="font-bold text-slate-600">{g}</span>
              </div>
            ))}
          </div>

          {/* remarks & signatures */}
          <div className="flex flex-wrap items-end justify-between gap-6 px-8 py-8">
            <div className="max-w-xs text-xs text-slate-500">
              <div className="font-bold uppercase tracking-wide text-slate-400">Class Teacher&apos;s Remarks</div>
              <p className="mt-2 italic">
                {gpa >= 4 ? "Excellent performance! Keep up the great work." : gpa >= 3 ? "Good progress. Keep practising to reach the top." : gpa >= 2 ? "Satisfactory. More effort needed in weaker subjects." : "Needs significant improvement. Please arrange extra practice at home."}
              </p>
            </div>
            <div className="flex gap-12 text-center text-[10px] font-semibold text-slate-400">
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
        </div>
      </div>
    </div>
  );
}
