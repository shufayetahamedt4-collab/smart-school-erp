"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plus, Search, GraduationCap, Eye, UserX } from "lucide-react";
import { api, qs } from "@/lib/client";
import { Card, Badge, Select, TextInput, EmptyState, LoadingScreen, PageHeader, statusTone, prettyStatus } from "@/components/ui";
import { initials, fmtMoney, fmtDate } from "@/lib/utils";

interface Student {
  id: string; name: string; admissionNo: string; roll: number | null; photoUrl: string | null;
  classRoom: { id: string; name: string } | null; section: { id: string; name: string } | null;
  active: boolean; guardianName: string | null;
  fees: { status: string; amount: string; paidAmount: string }[];
}

interface ClassRow { id: string; name: string; sections: { id: string; name: string }[] }

export default function StudentsPage() {
  const [students, setStudents] = useState<Student[]>([]);
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [classId, setClassId] = useState("");
  const [sectionId, setSectionId] = useState("");

  const load = (query: string) => api<Student[]>(`/api/students${query}`).then(setStudents).finally(() => setLoading(false));

  useEffect(() => {
    Promise.all([api<ClassRow[]>("/api/classes"), load("")]).then(([c]) => setClasses(c)).finally(() => setLoading(false));
  }, []);

  const applyFilters = () => {
    setLoading(true);
    load(qs({ q: q || undefined, classId: classId || undefined, sectionId: sectionId || undefined }));
  };

  const debt = (s: Student) => s.fees.reduce((a, f) => a + (Number(f.amount) - Number(f.paidAmount)), 0);
  const selectedClass = useMemo(() => classes.find((c) => c.id === classId), [classes, classId]);

  return (
    <div>
      <PageHeader
        title="Students"
        subtitle={`${students.length} students enrolled`}
        actions={<Link href="/dashboard/students/new" className="btn btn-primary"><Plus size={16} /> New Admission</Link>}
      />

      {/* filters */}
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
          <div className="relative sm:col-span-2">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <TextInput className="!pl-9" placeholder="Search by name, ID or guardian phone…" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && applyFilters()} />
          </div>
          <Select value={classId} onChange={(e) => { setClassId(e.target.value); setSectionId(""); }}>
            <option value="">All classes</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          <div className="flex gap-2">
            <Select value={sectionId} onChange={(e) => setSectionId(e.target.value)}>
              <option value="">All sections</option>
              {selectedClass?.sections.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
            </Select>
            <button className="btn btn-primary" onClick={applyFilters}>Filter</button>
          </div>
        </div>
      </Card>

      <Card>
        {loading ? (
          <LoadingScreen />
        ) : students.length === 0 ? (
          <EmptyState icon={GraduationCap} title="No students found" description="Try adjusting the filters or admit a new student." action={<Link href="/dashboard/students/new" className="btn btn-primary btn-sm"><Plus size={14} /> New Admission</Link>} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr>
                  <th className="th">Student</th>
                  <th className="th">Class</th>
                  <th className="th">Roll</th>
                  <th className="th">Guardian</th>
                  <th className="th">Fees due</th>
                  <th className="th">Status</th>
                  <th className="th text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {students.map((s) => (
                  <tr key={s.id} className="tr-hover">
                    <td className="td">
                      <Link href={`/dashboard/students/${s.id}`} className="flex items-center gap-3">
                        {s.photoUrl ? (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={s.photoUrl} alt="" className="h-9 w-9 rounded-lg object-cover" />
                        ) : (
                          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-xs font-bold text-indigo-600">{initials(s.name)}</div>
                        )}
                        <div>
                          <div className="font-bold text-slate-800 hover:text-indigo-600">{s.name}</div>
                          <div className="text-xs text-slate-400">{s.admissionNo}</div>
                        </div>
                      </Link>
                    </td>
                    <td className="td">
                      <div className="font-semibold text-slate-700">{s.classRoom?.name || "—"}</div>
                      <div className="text-xs text-slate-400">Section {s.section?.name || "—"}</div>
                    </td>
                    <td className="td font-semibold">{s.roll ?? "—"}</td>
                    <td className="td text-sm">{s.guardianName || "—"}</td>
                    <td className="td font-semibold">{debt(s) > 0 ? <span className="text-rose-600">{fmtMoney(debt(s))}</span> : <span className="text-emerald-600">Clear</span>}</td>
                    <td className="td">
                      <Badge tone={s.active ? "green" : "red"}>{s.active ? "Active" : "Inactive"}</Badge>
                    </td>
                    <td className="td">
                      <div className="flex justify-end gap-1">
                        <Link href={`/dashboard/students/${s.id}`} className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-indigo-600"><Eye size={15} /></Link>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
