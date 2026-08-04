"use client";

import { useEffect, useState } from "react";
import { FileSpreadsheet, FileText, Users, GraduationCap, Wallet, ClipboardList } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Card, CardHeader, Badge, Select, PageHeader, LoadingScreen, statusTone, prettyStatus } from "@/components/ui";
import { fmtMoney, fmtDate } from "@/lib/utils";
import * as XLSX from "xlsx";

type ReportType = "students" | "attendance" | "exams" | "fees" | "teachers";

const REPORTS: { key: ReportType; label: string; icon: any }[] = [
  { key: "students", label: "Student List", icon: GraduationCap },
  { key: "attendance", label: "Attendance Report", icon: ClipboardList },
  { key: "exams", label: "Exam Report", icon: FileText },
  { key: "fees", label: "Fee Report", icon: Wallet },
  { key: "teachers", label: "Teacher Report", icon: Users },
];

export default function ReportsPage() {
  const [type, setType] = useState<ReportType>("students");
  const [data, setData] = useState<any[]>([]);
  const [classes, setClasses] = useState<any[]>([]);
  const [classId, setClassId] = useState("");
  const [examId, setExamId] = useState("");
  const [exams, setExams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const c = await api<any[]>("/api/classes");
      setClasses(c);
      if (type === "exams" && !exams.length) {
        const e = await api<any[]>("/api/exams");
        setExams(e);
      }
      if (type === "students") setData(await api<any[]>(`/api/students${qs({ classId: classId || undefined })}`));
      if (type === "teachers") setData(await api<any[]>("/api/teachers"));
      if (type === "fees") setData((await api<{ fees: any[] }>("/api/fees")).fees);
      if (type === "attendance") {
        const today = new Date();
        const date = today.toISOString().slice(0, 10);
        setData(await api<any[]>(`/api/attendance${qs({ classId: classId || undefined, date })}`));
      }
      if (type === "exams") {
        const target = exams.find((e) => e.id === examId) || exams[0];
        if (target) {
          setExamId(target.id);
          const detail = await api<any>(`/api/exams/${target.id}`);
          setData(detail.students.map((s: any) => ({ name: s.name, roll: s.roll, admissionNo: s.admissionNo, gpa: s.gpa, position: s.position, total: s.total })));
        }
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, [type]);

  const exportExcel = () => {
    const sheet = XLSX.utils.json_to_sheet(data.map((r) => {
      const flat: any = {};
      for (const [k, v] of Object.entries(r)) flat[k] = typeof v === "object" && v !== null ? JSON.stringify(v) : v;
      return flat;
    }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, type);
    XLSX.writeFile(wb, `smart-school-${type}-report.xlsx`);
  };

  const columns: Record<ReportType, { key: string; label: string; render?: (r: any) => any }[]> = {
    students: [
      { key: "admissionNo", label: "ID" },
      { key: "name", label: "Name" },
      { key: "roll", label: "Roll" },
      { key: "classRoom", label: "Class", render: (r) => r.classRoom?.name || "—" },
      { key: "section", label: "Section", render: (r) => r.section?.name || "—" },
      { key: "guardianName", label: "Guardian" },
      { key: "guardianPhone", label: "Phone" },
    ],
    attendance: [
      { key: "roll", label: "Roll" },
      { key: "name", label: "Name" },
      { key: "status", label: "Status", render: (r) => <Badge tone={statusTone(r.status)}>{prettyStatus(r.status)}</Badge> },
      { key: "remark", label: "Remark" },
    ],
    exams: [
      { key: "roll", label: "Roll" },
      { key: "name", label: "Name" },
      { key: "total", label: "Total" },
      { key: "gpa", label: "GPA", render: (r) => (Number(r.gpa) > 0 ? Number(r.gpa).toFixed(2) : "—") },
      { key: "position", label: "Position" },
    ],
    fees: [
      { key: "student", label: "Student", render: (r) => r.student?.name || "—" },
      { key: "title", label: "Fee" },
      { key: "feeType", label: "Type" },
      { key: "amount", label: "Amount", render: (r) => fmtMoney(r.amount) },
      { key: "paidAmount", label: "Paid", render: (r) => fmtMoney(r.paidAmount) },
      { key: "status", label: "Status", render: (r) => <Badge tone={statusTone(r.status)}>{prettyStatus(r.status)}</Badge> },
    ],
    teachers: [
      { key: "user", label: "Name", render: (r) => r.user?.name || "—" },
      { key: "user", label: "Email", render: (r) => r.user?.email || "—" },
      { key: "designation", label: "Designation" },
      { key: "qualification", label: "Qualification" },
      { key: "assignments", label: "Assignments", render: (r) => r.assignments?.length || 0 },
    ],
  };

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Generate and export school reports"
        actions={
          <button className="btn btn-primary" onClick={exportExcel} disabled={!data.length}>
            <FileSpreadsheet size={15} /> Export Excel
          </button>
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-2">
        {REPORTS.map((r) => (
          <button
            key={r.key}
            onClick={() => setType(r.key)}
            className={`btn btn-sm ${type === r.key ? "btn-primary" : "btn-secondary"}`}
          >
            <r.icon size={14} /> {r.label}
          </button>
        ))}
      </div>

      {(type === "students" || type === "attendance") && (
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="label !mb-0">Class:</label>
            <Select value={classId} onChange={(e) => { setClassId(e.target.value); load(); }} className="!w-56">
              <option value="">All classes</option>
              {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
            {type === "attendance" && <span className="text-xs text-slate-400">Showing today's attendance</span>}
          </div>
        </Card>
      )}

      {type === "exams" && (
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center gap-3">
            <label className="label !mb-0">Exam:</label>
            <Select value={examId} onChange={(e) => { setExamId(e.target.value); load(); }} className="!w-64">
              {exams.map((e) => <option key={e.id} value={e.id}>{e.name} — {e.classRoom.name}</option>)}
            </Select>
          </div>
        </Card>
      )}

      <Card>
        {loading ? (
          <LoadingScreen />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  {columns[type].map((c) => <th key={c.label} className="th">{c.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.map((r, i) => (
                  <tr key={i} className="tr-hover">
                    {columns[type].map((c) => (
                      <td key={c.key + i} className="td">{c.render ? c.render(r) : r[c.key] ?? "—"}</td>
                    ))}
                  </tr>
                ))}
                {!data.length && (
                  <tr><td colSpan={columns[type].length} className="td py-10 text-center text-slate-400">No data for this report yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
