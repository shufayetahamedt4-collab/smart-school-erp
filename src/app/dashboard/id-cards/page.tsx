"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { IdCard, Printer, ExternalLink } from "lucide-react";
import { api } from "@/lib/client";
import { Card, Select, PageHeader, LoadingScreen, EmptyState } from "@/components/ui";
import { initials, fmtDate } from "@/lib/utils";

interface ClassRow { id: string; name: string }
interface Student { id: string; name: string; admissionNo: string; roll: number | null; photoUrl: string | null; classRoom: { name: string } | null; section: { name: string } | null }

export default function IdCardsPage() {
  const [classes, setClasses] = useState<ClassRow[]>([]);
  const [students, setStudents] = useState<Student[]>([]);
  const [classId, setClassId] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api<ClassRow[]>("/api/classes").then(setClasses).finally(() => setLoading(false));
  }, []);

  const selectClass = async (cid: string) => {
    setClassId(cid);
    const rows = await api<Student[]>(`/api/students?classId=${cid}`);
    setStudents(rows);
  };

  if (loading) return <LoadingScreen />;

  return (
    <div>
      <PageHeader title="ID Cards" subtitle="Generate printable QR ID cards per class" />

      <Card className="mb-4 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="label !mb-0">Class:</label>
          <Select value={classId} onChange={(e) => selectClass(e.target.value)} className="!w-56">
            <option value="">Select class…</option>
            {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
          {students.length > 0 && (
            <button className="btn btn-primary btn-sm ml-auto" onClick={() => window.open(`/print/id-card/${students[0].id}`, "_blank")}>
              <Printer size={14} /> Open printable view
            </button>
          )}
        </div>
      </Card>

      {!classId ? (
        <Card><EmptyState icon={IdCard} title="Select a class" description="Choose a class to see all students and generate their ID cards." /></Card>
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {students.map((s) => (
            <Card key={s.id} className="overflow-hidden">
              <div className="bg-gradient-to-r from-indigo-600 to-violet-600 px-4 py-2.5 text-white">
                <div className="text-xs font-extrabold">{s.classRoom?.name || "—"}</div>
                <div className="text-[10px] text-indigo-200">Section {s.section?.name || "—"} · Roll {s.roll ?? "—"}</div>
              </div>
              <div className="flex items-center gap-3 p-4">
                {s.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={s.photoUrl} alt="" className="h-14 w-12 rounded-lg object-cover" />
                ) : (
                  <div className="flex h-14 w-12 items-center justify-center rounded-lg bg-slate-100 text-sm font-black text-slate-400">{initials(s.name)}</div>
                )}
                <div className="min-w-0">
                  <div className="truncate text-sm font-bold text-slate-800">{s.name}</div>
                  <div className="truncate text-[11px] text-slate-400">{s.admissionNo}</div>
                </div>
              </div>
              <div className="flex border-t border-slate-100 px-4 py-2.5">
                <Link href={`/print/id-card/${s.id}`} className="btn btn-secondary btn-sm w-full">
                  <ExternalLink size={13} /> Open card
                </Link>
              </div>
            </Card>
          ))}
          {!students.length && <Card className="sm:col-span-2 lg:col-span-3 xl:col-span-4"><EmptyState icon={IdCard} title="No students in this class" /></Card>}
        </div>
      )}
    </div>
  );
}
